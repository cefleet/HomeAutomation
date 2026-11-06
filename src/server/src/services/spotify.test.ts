import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express, { type Express } from 'express';
import { createSpotifyService, spotifyService } from './spotify.js';
import { deviceRouter } from '../devices.js';
import { clientResolution } from '../middleware.js';
import { NotificationCenter } from '../notifications.js';
import { ServiceRegistry, type ServiceContext } from '../registry.js';
import type { DeviceConfig } from '../types.js';

const device: DeviceConfig = {
  id: 'spotify',
  service: 'spotify',
  description: 'test player',
  deviceName: 'Kitchen account',
  clientId: 'spotify-client-id',
  clientSecret: 'spotify-client-secret',
  refreshToken: 'refresh-token-secret',
  access: { read: ['*'], write: ['*'] },
};

function spotifyFetch() {
  const calls: { url: URL; method: string; body?: string }[] = [];
  let activeDeviceId: string | null = null;
  let refreshStatus = 200;
  let rotatedRefreshToken: string | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : init?.body?.toString();
    calls.push({ url, method, body });
    if (url.hostname === 'accounts.spotify.com' && url.pathname === '/api/token') {
      const grant = new URLSearchParams(body).get('grant_type');
      if (grant === 'refresh_token' && refreshStatus !== 200)
        return new Response(null, { status: refreshStatus });
      return new Response(JSON.stringify({
        access_token: grant === 'refresh_token' ? 'refreshed-access-token' : 'access-token',
        refresh_token: grant === 'refresh_token' ? rotatedRefreshToken : 'refresh-token-secret',
        expires_in: 3600,
      }), { status: 200 });
    }
    if (url.pathname === '/v1/me/player' && method === 'PUT') {
      const data = JSON.parse(body ?? '{}') as { device_ids?: string[] };
      activeDeviceId = data.device_ids?.[0] ?? null;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/v1/me/player') {
      if (!activeDeviceId) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({
        device: { id: activeDeviceId, volume_percent: 55 },
        is_playing: true,
        progress_ms: 12000,
        shuffle_state: true,
        repeat_state: 'context',
        context: { type: 'playlist' },
        item: {
          name: 'Test Track',
          duration_ms: 180000,
          artists: [{ name: 'Test Artist' }],
          album: { name: 'Test Album', images: [{ url: 'https://image.test/album.jpg' }] },
        },
      }), { status: 200 });
    }
    if (url.pathname === '/v1/me/player/queue')
      return new Response(JSON.stringify({ queue: [{ uri: 'spotify:track:queued', name: 'Queued', artists: [{ name: 'Artist' }], album: { images: [] } }] }), { status: 200 });
    if (url.pathname === '/v1/search')
      return new Response(JSON.stringify({
        tracks: { items: [{ uri: 'spotify:track:search', name: 'Found', artists: [{ name: 'Artist' }], album: { images: [{ url: 'https://image.test/search.jpg' }] } }] },
        albums: { items: [] },
        playlists: { items: [] },
      }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  return {
    fetchImpl,
    calls,
    get activeDeviceId() { return activeDeviceId; },
    set refreshStatus(status: number) { refreshStatus = status; },
    set rotatedRefreshToken(value: string | undefined) { rotatedRefreshToken = value; },
  };
}

interface MountOptions {
  fetchImpl?: typeof fetch;
  roles?: string[];
  pushes?: unknown[];
  device?: Partial<DeviceConfig>;
}

function mount(options: MountOptions = {}): {
  app: Express;
  base: string;
  configDir: string;
  deviceFile: string;
  cleanup: () => void;
} {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-config-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-data-'));
  const configured = { ...device, ...options.device };
  fs.mkdirSync(path.join(configDir, 'devices'), { recursive: true });
  const deviceFile = path.join(configDir, 'devices', `${configured.id}.json`);
  fs.writeFileSync(deviceFile, JSON.stringify(configured), { mode: 0o600 });
  const ctx: ServiceContext = {
    device: configured,
    push: (data) => options.pushes?.push(data),
    notify: () => {},
    dashboards: ['master', 'admin'],
    targets: ['master', 'admin'],
    dataDir,
    configDir,
    prod: false,
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.roles = options.roles ?? ['admin', 'user'];
    next();
  });
  app.use('/api/spotify/spotify', createSpotifyService(options.fetchImpl).createRoutes(ctx));
  const server = app.listen(0);
  const cleanup = () => {
    server.close();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return {
    app,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spotify/spotify`,
    configDir,
    deviceFile,
    cleanup,
  };
}

async function post(base: string, pathName: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('spotify config requires OAuth app credentials and rejects Soloist fields', () => {
  const errors = spotifyService.validateDevices?.([
    { ...device, clientId: undefined, clientSecret: undefined },
    { ...device, apiKey: 'old-key' } as DeviceConfig,
  ]) ?? [];
  assert.ok(errors.some((error) => /requires "clientId" and "clientSecret"/.test(error)));
  assert.ok(errors.some((error) => /apiKey.*no longer supported/.test(error)));
});

test('config-declared refresh token authorizes the account and returns short-lived access tokens', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.loggedIn, true);
    assert.equal(state.connected, false);
    assert.equal(JSON.stringify(state).includes('refresh-token-secret'), false);

    const tokenResponse = await fetch(`${base}/token`);
    assert.equal(tokenResponse.headers.get('cache-control'), 'no-store');
    const token = await tokenResponse.json();
    assert.deepEqual(Object.keys(token).sort(), ['accessToken', 'expiresIn']);
    assert.equal(token.accessToken, 'refreshed-access-token');
    assert.equal(JSON.stringify(token).includes('refresh-token-secret'), false);
    assert.equal(JSON.stringify(token).includes('spotify-client-secret'), false);
    assert.ok(fake.calls.some((call) =>
      call.url.pathname === '/api/token' &&
      new URLSearchParams(call.body).get('grant_type') === 'refresh_token',
    ));
  } finally {
    cleanup();
  }
});

test('a device without refreshToken is reported unauthorized', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl, device: { refreshToken: undefined } });
  try {
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.loggedIn, false);
    const response = await fetch(`${base}/token`);
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /spotify-auth/);
  } finally {
    cleanup();
  }
});

test('rotated refresh tokens are persisted to the device config file', async () => {
  const fake = spotifyFetch();
  fake.rotatedRefreshToken = 'rotated-refresh-token';
  const { base, deviceFile, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    const token = await (await fetch(`${base}/token`)).json();
    assert.equal(token.accessToken, 'refreshed-access-token');
    const written = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
    assert.equal(written.refreshToken, 'rotated-refresh-token');
    assert.equal(fs.statSync(deviceFile).mode & 0o777, 0o600);
    // Other config fields are preserved by the update.
    assert.equal(written.clientId, 'spotify-client-id');
    assert.equal(written.deviceName, 'Kitchen account');
  } finally {
    cleanup();
  }
});

test('revoked refresh tokens mark the account unauthorized until re-authorized via config', async () => {
  const fake = spotifyFetch();
  fake.refreshStatus = 400;
  const first = mount({ fetchImpl: fake.fetchImpl });
  try {
    assert.equal((await fetch(`${first.base}/token`)).status, 401);
    assert.equal((await (await fetch(`${first.base}/state`)).json()).loggedIn, false);
  } finally {
    first.cleanup();
  }
  // Re-running spotify-auth writes a new refreshToken into the config file.
  fake.refreshStatus = 200;
  const second = mount({ fetchImpl: fake.fetchImpl, device: { refreshToken: 'new-refresh-token' } });
  try {
    const token = await (await fetch(`${second.base}/token`)).json();
    assert.equal(token.accessToken, 'refreshed-access-token');
    assert.ok(fake.calls.some((call) =>
      call.url.pathname === '/api/token' &&
      new URLSearchParams(call.body).get('refresh_token') === 'new-refresh-token',
    ));
  } finally {
    second.cleanup();
  }
});

test('access tokens remain ACL-protected', async () => {
  const fake = spotifyFetch();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-acl-config-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-acl-data-'));
  const registry = new ServiceRegistry();
  registry.register(createSpotifyService(fake.fetchImpl));
  const configured = { ...device, access: { read: [], write: ['admin'] } };
  const app = express();
  app.use(express.json());
  app.use(clientResolution([]));
  app.use('/api', deviceRouter([configured], registry, new NotificationCenter(), {
    dashboards: ['master'],
    dataDir,
    configDir,
    prod: false,
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spotify/spotify`;
  try {
    assert.equal((await fetch(`${base}/token`)).status, 403);
  } finally {
    server.close();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('multiple browser players share one account and Make Active transfers to the chosen player', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    const first = await (await post(base, '/players', { deviceId: 'sdk-device-1', name: 'Tablet 1' })).json();
    const second = await (await post(base, '/players', { deviceId: 'sdk-device-2', name: 'Tablet 2' })).json();
    const initial = await (await fetch(`${base}/state`)).json();
    assert.equal(initial.connected, true);
    assert.equal(initial.players.length, 2);

    const active = await post(base, `/players/${second.id}/activate`);
    assert.equal(active.status, 200);
    const snapshot = await active.json();
    assert.equal(fake.activeDeviceId, 'sdk-device-2');
    assert.equal(snapshot.isActive, true);
    assert.equal(snapshot.activePlayerId, second.id);
    assert.equal(snapshot.players.find((player: { id: string }) => player.id === first.id).isActive, false);
    assert.equal(snapshot.players.find((player: { id: string }) => player.id === second.id).isActive, true);

    const next = await post(base, '/command', { command: 'next' });
    assert.equal(next.status, 200);
    assert.ok(fake.calls.some((call) => call.url.pathname === '/v1/me/player/next' && call.url.searchParams.get('device_id') === 'sdk-device-2'));
  } finally {
    cleanup();
  }
});

test('browser SDK state is mapped and pushed only for the active player', async () => {
  const pushes: unknown[] = [];
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl, pushes });
  try {
    const { id } = await (await post(base, '/players', { deviceId: 'sdk-device', name: 'Tablet' })).json();
    await post(base, `/players/${id}/activate`);
    const response = await post(base, `/players/${id}/state`, {
      paused: false,
      position: 42000,
      duration: 200000,
      repeatMode: 2,
      shuffle: true,
      volume: 0.7,
      track: {
        name: 'SDK Track',
        artists: [{ name: 'SDK Artist' }],
        album: { name: 'SDK Album', images: [{ url: 'https://image.test/sdk.jpg' }] },
      },
      context: { metadata: { name: 'SDK Playlist' } },
    });
    assert.equal(response.status, 204);
    const pushed = pushes.at(-1) as Record<string, unknown>;
    assert.equal(pushed.track, 'SDK Track');
    assert.equal(pushed.artist, 'SDK Artist');
    assert.equal(pushed.repeat, 'track');
    assert.equal(pushed.volume, 70);
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.track, 'Test Track');
    assert.equal(state.isActive, true);
  } finally {
    cleanup();
  }
});

test('commands require an active browser and validate values', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    assert.equal((await post(base, '/command', { command: 'unknown' })).status, 400);
    assert.equal((await post(base, '/command', { command: 'play' })).status, 409);
    const { id } = await (await post(base, '/players', { deviceId: 'sdk-device', name: 'Tablet' })).json();
    await post(base, `/players/${id}/activate`);
    assert.equal((await post(base, '/command', { command: 'volume', value: 101 })).status, 400);
    assert.equal((await post(base, '/command', { command: 'repeat', value: 'sometimes' })).status, 400);
    assert.equal((await post(base, '/command', { command: 'play-uri', value: 'spotify:track:abc' })).status, 200);
    assert.ok(fake.calls.some((call) => call.url.pathname === '/v1/me/player/play' && call.method === 'PUT'));
  } finally {
    cleanup();
  }
});

test('a playback command from a registered browser transfers playback to it automatically', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    const first = await (await post(base, '/players', { deviceId: 'sdk-device-1', name: 'Tablet 1' })).json();
    const second = await (await post(base, '/players', { deviceId: 'sdk-device-2', name: 'Tablet 2' })).json();
    await post(base, `/players/${first.id}/activate`);
    assert.equal(fake.activeDeviceId, 'sdk-device-1');

    const response = await post(base, '/command', { command: 'play', playerId: second.id });
    assert.equal(response.status, 200);
    assert.equal(fake.activeDeviceId, 'sdk-device-2');
    const snapshot = await response.json();
    assert.equal(snapshot.activePlayerId, second.id);
    const transferCalls = fake.calls.filter(
      (call) => call.url.pathname === '/v1/me/player' && call.method === 'PUT',
    );
    assert.equal(transferCalls.length, 2);
    assert.equal(JSON.parse(transferCalls[1].body ?? '{}').play, true);

    // Commands without playerId keep targeting the active player.
    assert.equal((await post(base, '/command', { command: 'next' })).status, 200);
    assert.equal(fake.activeDeviceId, 'sdk-device-2');
  } finally {
    cleanup();
  }
});

test('a command activates the sole registered player when none is active', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    await post(base, '/players', { deviceId: 'sdk-device', name: 'Tablet' });
    // No activation: a command with no usable playerId falls back to the
    // only registered player (also covers a stale id after re-registration).
    const response = await post(base, '/command', { command: 'play', playerId: 'stale-id' });
    assert.equal(response.status, 200);
    assert.equal(fake.activeDeviceId, 'sdk-device');
    assert.ok(fake.calls.some(
      (call) => call.url.pathname === '/v1/me/player' && call.method === 'PUT',
    ));
  } finally {
    cleanup();
  }
});

test('queue and search use supported Spotify APIs', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    const queue = await (await fetch(`${base}/queue`)).json();
    assert.equal(queue.upcoming[0].uri, 'spotify:track:queued');
    const search = await (await fetch(`${base}/search?q=radiohead`)).json();
    assert.equal(search.results[0].uri, 'spotify:track:search');
    assert.ok(fake.calls.some((call) => call.url.pathname === '/v1/me/player/queue'));
    assert.ok(fake.calls.some((call) => call.url.pathname === '/v1/search'));
  } finally {
    cleanup();
  }
});

test('browser heartbeat and disconnect update the shared player list', async () => {
  const fake = spotifyFetch();
  const { base, cleanup } = mount({ fetchImpl: fake.fetchImpl });
  try {
    const { id } = await (await post(base, '/players', { deviceId: 'sdk-device', name: 'Tablet' })).json();
    assert.equal((await post(base, `/players/${id}/heartbeat`)).status, 204);
    assert.equal((await fetch(`${base}/state`).then((response) => response.json())).players.length, 1);
    assert.equal((await fetch(`${base}/players/${id}`, { method: 'DELETE' })).status, 204);
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.players.length, 0);
    assert.equal(state.connected, false);
  } finally {
    cleanup();
  }
});
