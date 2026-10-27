import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import express, { type Express } from 'express';
import {
  createSpotifyService,
  type SoloistDaemon,
  type SoloistHandlers,
  type SoloistSocket,
} from './spotify.js';
import type { ServiceContext } from '../registry.js';
import type { DeviceConfig, NotificationInput } from '../types.js';

const device: DeviceConfig = {
  id: 'spotify',
  service: 'spotify',
  source: 'ws://127.0.0.1:8080',
  sourceType: 'soloist',
  description: 'test player',
  access: { read: ['*'], write: ['*'] },
};

class FakeSocket implements SoloistSocket {
  sent: string[] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
}

class FakeDaemon implements SoloistDaemon {
  killed = false;
  exitCb?: (info: import('./spotify.js').DaemonExit) => void;
  kill() {
    this.killed = true;
    // a real kill produces an exit event
    this.exitCb?.({ code: null, signal: 'SIGTERM' });
  }
  onExit(cb: (info: import('./spotify.js').DaemonExit) => void) {
    this.exitCb = cb;
  }
  exit() {
    this.exitCb?.({ code: 1, signal: null });
  }
}

interface Harness {
  sockets: { url: string; handlers: SoloistHandlers; sock: FakeSocket }[];
  daemons: { bin: string; args: string[]; log: (line: string) => void; d: FakeDaemon }[];
}

interface MountOpts {
  notices?: NotificationInput[];
  pushes?: unknown[];
  managed?: boolean;
  /** Managed device without daemonBin → self-managed binary under dataDir. */
  selfManaged?: boolean;
  fetchImpl?: typeof fetch;
  dataDir?: string;
  device?: Partial<DeviceConfig>;
}

function mount(opts: MountOpts = {}): {
  app: Express;
  harness: Harness;
} {
  const { notices = [], pushes = [], managed = false } = opts;
  const harness: Harness = { sockets: [], daemons: [] };
  const service = createSpotifyService(
    (url, handlers) => {
      const sock = new FakeSocket();
      harness.sockets.push({ url, handlers, sock });
      return sock;
    },
    (bin, args, log) => {
      const d = new FakeDaemon();
      harness.daemons.push({ bin, args, log, d });
      return d;
    },
    opts.fetchImpl,
  );
  const ctx: ServiceContext = {
    device: {
      ...(managed
        ? {
            ...device,
            source: undefined,
            sourceType: undefined,
            apiKey: 'KEY',
            deviceName: 'Test speaker',
            clientId: 'cid',
            clientSecret: 'csecret',
            daemonBin: 'soloist',
          }
        : device),
      ...opts.device,
    },
    push: (d) => pushes.push(d),
    notify: (n) => notices.push(n),
    dashboards: ['master'],
    targets: ['master'],
    dataDir: opts.dataDir ?? '/tmp',
    prod: false,
  };
  if (opts.selfManaged) delete ctx.device.daemonBin;
  const app = express();
  app.use(express.json());
  app.use('/api/spotify/spotify', service.createRoutes(ctx));
  return { app, harness };
}

/** Flush pending async work (spawn → port allocation → connect).
 *  setImmediate stays real even under mock.timers. */
const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** Poll until `cond` holds (or fail) — for real async work like tar
 *  extraction that immediate-flushes can't cover. */
const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 25));
  assert.ok(cond(), 'condition not met in time');
};

async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spotify/spotify`;
  return { base, close: () => server.close() };
}

async function command(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Soloist entity envelope for a track. */
const trackEntity = (name: string, over: Record<string, unknown> = {}) => ({
  uri: `spotify:track:${name}`,
  entity_type: 'track',
  decorations: {
    identity: { name },
    visual_identity: {
      cover: [
        { url: 'https://img/small', size: 'small' },
        { url: 'https://img/default', size: 'default' },
      ],
    },
    parent: {
      entity: { entity_type: 'album', decorations: { identity: { name: 'Album' } } },
    },
    creators: [
      { entity: { entity_type: 'artist', decorations: { identity: { name: 'Artist' } } } },
    ],
    playback: { duration_ms: 200000 },
    ...over,
  },
});

test('GET /state returns the contract, disconnected before any update', async () => {
  const { base, close } = await listen(mount({}).app);
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.id, 'spotify');
  assert.equal(s.connected, false);
  assert.equal(s.loggedIn, false);
  assert.equal(s.playing, false);
  assert.equal(s.track, '');
  assert.equal(s.speed, 0);
  assert.equal(typeof s.updatedAt, 'string');
  close();
});

test('socket open marks the device connected and pushes', async () => {
  const pushes: unknown[] = [];
  const { app, harness } = mount({ pushes });
  const { base, close } = await listen(app);
  harness.sockets[0].handlers.onOpen();
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.connected, true);
  assert.equal((pushes[0] as { connected: boolean }).connected, true);
  close();
});

test('playback_state snapshot maps the entity envelope', async () => {
  const pushes: { track?: string }[] = [];
  const { app, harness } = mount({ pushes });
  const { base, close } = await listen(app);
  const h = harness.sockets[0].handlers;
  h.onOpen();
  h.onMessage(
    JSON.stringify({
      type: 'auth_state',
      logged_in: true,
      is_active: true,
      device_name: 'Kitchen speaker',
    }),
  );
  h.onMessage(
    JSON.stringify({
      type: 'playback_state',
      status: 'playing',
      item: trackEntity('Song'),
      context: { entity_type: 'playlist', decorations: { identity: { name: 'Mix' } } },
      position: { position_ms: 45000, timestamp_ms: 1, speed: 1.0 },
      volume: 65,
      is_active: true,
      options: { shuffle: true, repeat: 'context' },
    }),
  );
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.connected, true);
  assert.equal(s.loggedIn, true);
  assert.equal(s.isActive, true);
  assert.equal(s.deviceName, 'Kitchen speaker');
  assert.equal(s.playing, true);
  assert.equal(s.track, 'Song');
  assert.equal(s.artist, 'Artist');
  assert.equal(s.album, 'Album');
  assert.equal(s.albumArtUrl, 'https://img/default');
  assert.equal(s.contextName, 'Mix');
  assert.equal(s.volume, 65);
  assert.equal(s.progressMs, 45000);
  assert.equal(s.speed, 1);
  assert.equal(s.durationMs, 200000);
  assert.equal(s.shuffle, true);
  assert.equal(s.repeat, 'context');
  assert.equal(pushes.at(-1)?.track, 'Song');
  close();
});

test('granular events update the contract', async () => {
  const { app, harness } = mount({});
  const { base, close } = await listen(app);
  const h = harness.sockets[0].handlers;
  h.onOpen();
  h.onMessage(JSON.stringify({ type: 'playback_changed', status: 'paused' }));
  h.onMessage(JSON.stringify({ type: 'track_changed', item: trackEntity('Next One') }));
  h.onMessage(JSON.stringify({ type: 'volume_changed', volume: 30 }));
  h.onMessage(
    JSON.stringify({ type: 'position_sync', position: { position_ms: 8000, speed: 0 } }),
  );
  h.onMessage(JSON.stringify({ type: 'device_changed', is_active: false }));
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.playing, false);
  assert.equal(s.track, 'Next One');
  assert.equal(s.volume, 30);
  assert.equal(s.progressMs, 8000);
  assert.equal(s.isActive, false);
  close();
});

test('malformed frames and unknown events are ignored', async () => {
  const { app, harness } = mount({});
  const { base, close } = await listen(app);
  const h = harness.sockets[0].handlers;
  h.onOpen();
  h.onMessage('not json');
  h.onMessage(JSON.stringify({ type: 'command_result', command: 'play' }));
  h.onMessage(JSON.stringify({ noType: true }));
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.connected, true);
  assert.equal(s.track, '');
  close();
});

test('POST /command forwards Soloist command frames', async () => {
  const { app, harness } = mount({});
  const { base, close } = await listen(app);
  harness.sockets[0].handlers.onOpen();
  for (const body of [
    { command: 'play' },
    { command: 'next' },
    { command: 'previous' },
    { command: 'volume', value: 35 },
    { command: 'seek', value: 30000 },
    { command: 'shuffle', value: true },
    { command: 'play-uri', value: 'spotify:playlist:xyz' },
    { command: 'queue-add', value: 'spotify:track:abc' },
    { command: 'activate' },
  ]) {
    assert.equal((await command(base, body)).status, 200, JSON.stringify(body));
  }
  assert.equal((await command(base, { command: 'repeat', value: 'context' })).status, 200);
  const sent = harness.sockets[0].sock.sent.map((f) => JSON.parse(f));
  assert.deepEqual(sent, [
    { type: 'command', command: 'play' },
    { type: 'command', command: 'skip_next' },
    { type: 'command', command: 'skip_prev' },
    { type: 'command', command: 'set_volume', volume: 35 },
    { type: 'command', command: 'seek', position_ms: 30000 },
    { type: 'command', command: 'set_shuffle', enabled: true },
    { type: 'command', command: 'play', uri: 'spotify:playlist:xyz' },
    { type: 'command', command: 'add_to_queue', uri: 'spotify:track:abc' },
    { type: 'command', command: 'activate' },
    { type: 'command', command: 'set_repeat_track', enabled: false },
    { type: 'command', command: 'set_repeat_context', enabled: true },
  ]);
  close();
});

test('invalid commands are rejected with 400 and a notification', async () => {
  const notices: NotificationInput[] = [];
  const { app, harness } = mount({ notices });
  const { base, close } = await listen(app);
  harness.sockets[0].handlers.onOpen();
  for (const body of [
    { command: 'bogus' },
    { command: 'volume' },
    { command: 'volume', value: 150 },
    { command: 'seek', value: 'later' },
    { command: 'repeat', value: 'sometimes' },
    { command: 'play-uri', value: '' },
    {},
  ]) {
    assert.equal((await command(base, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(notices.length, 7);
  assert.equal(notices[0].type, 'issue');
  assert.equal(harness.sockets[0].sock.sent.length, 0);
  close();
});

test('daemon error frames surface as issue notifications', async () => {
  const notices: NotificationInput[] = [];
  const { app, harness } = mount({ notices });
  const { close } = await listen(app);
  harness.sockets[0].handlers.onOpen();
  harness.sockets[0].handlers.onMessage(
    JSON.stringify({ type: 'error', message: 'command requires authentication' }),
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, 'issue');
  assert.equal(notices[0].body, 'command requires authentication');
  close();
});

test('commands while disconnected return 502', async () => {
  const { base, close } = await listen(mount({}).app);
  const res = await command(base, { command: 'play' });
  assert.equal(res.status, 502);
  close();
});

test('socket close marks disconnected, pushes, and reconnects', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pushes: { connected?: boolean }[] = [];
    const { app, harness } = mount({ pushes });
    const { base, close } = await listen(app);
    const h = harness.sockets[0].handlers;
    h.onOpen();
    h.onMessage(JSON.stringify({ type: 'track_changed', item: trackEntity('Song') }));
    h.onClose();
    const s = await (await fetch(`${base}/state`)).json();
    assert.equal(s.connected, false);
    assert.equal(s.track, 'Song');
    assert.equal(pushes.at(-1)?.connected, false);
    assert.equal(harness.sockets.length, 1);
    mock.timers.tick(5000);
    assert.equal(harness.sockets.length, 2);
    close();
  } finally {
    mock.timers.reset();
  }
});

test('managed mode spawns the daemon and connects to its port', async () => {
  const { app, harness } = mount({ managed: true });
  const { base, close } = await listen(app);
  await tick();
  assert.equal(harness.daemons.length, 1);
  const d = harness.daemons[0];
  assert.equal(d.bin, 'soloist');
  const wsArg = d.args[d.args.indexOf('--ws') + 1];
  assert.match(wsArg, /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(d.args.slice(0, 4), ['--device-name', 'Test speaker', '--api-key', 'KEY']);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.sockets[0].url, `ws://${wsArg}`);
  harness.sockets[0].handlers.onOpen();
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.connected, true);
  assert.equal(s.deviceName, 'Test speaker');
  close();
});

test('managed mode respawns the daemon on exit and notifies', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const notices: NotificationInput[] = [];
    const { app, harness } = mount({ notices, managed: true });
    const { close } = await listen(app);
    await tick();
    harness.daemons[0].d.exit();
    assert.equal(notices.length, 1);
    assert.match(String(notices[0].title), /daemon exited/);
    assert.equal(harness.daemons.length, 1);
    mock.timers.tick(5000);
    await tick();
    assert.equal(harness.daemons.length, 2);
    close();
  } finally {
    mock.timers.reset();
  }
});

test('managed daemon is killed when the process exits', async () => {
  const before = new Set(process.listeners('exit'));
  const { app, harness } = mount({ managed: true });
  const { close } = await listen(app);
  await tick();
  // Invoke only the exit listener this router registered.
  const added = process.listeners('exit').filter((l) => !before.has(l));
  assert.ok(added.length > 0);
  for (const l of added) (l as () => void)();
  assert.equal(harness.daemons[0].d.killed, true);
  close();
});

test('GET /queue correlates get_queue with queue_changed', async () => {
  const { app, harness } = mount({});
  const { base, close } = await listen(app);
  const h = harness.sockets[0].handlers;
  h.onOpen();
  const p = fetch(`${base}/queue`);
  await tick();
  assert.equal(
    harness.sockets[0].sock.sent.at(-1),
    JSON.stringify({ type: 'command', command: 'get_queue' }),
  );
  h.onMessage(
    JSON.stringify({
      type: 'queue_changed',
      previous: [],
      upcoming: [
        { uid: 'u1', source: 'queue', item: trackEntity('Next Up') },
        { uid: 'u2', source: 'context', item: trackEntity('Then This') },
      ],
    }),
  );
  const body = await (await p).json();
  assert.equal(body.upcoming.length, 2);
  assert.equal(body.upcoming[0].name, 'Next Up');
  assert.equal(body.upcoming[0].artist, 'Artist');
  assert.equal(body.upcoming[0].source, 'queue');
  assert.equal(body.upcoming[0].uri, 'spotify:track:Next Up');
  close();
});

test('GET /queue while disconnected returns 502', async () => {
  const { base, close } = await listen(mount({}).app);
  assert.equal((await fetch(`${base}/queue`)).status, 502);
  close();
});

test('GET /search maps catalog results via client-credentials token', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (async (url: unknown) => {
    calls.push(String(url));
    if (String(url).includes('/api/token'))
      return new Response(
        JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        tracks: {
          items: [
            {
              uri: 'spotify:track:karma',
              name: 'Karma Police',
              artists: [{ name: 'Radiohead' }],
              album: { images: [{ url: 'https://img/okc' }] },
            },
          ],
        },
        albums: { items: [] },
        playlists: { items: [] },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const { app } = mount({ managed: true, fetchImpl: fakeFetch });
  const { base, close } = await listen(app);
  const r = await fetch(`${base}/search?q=radiohead`);
  assert.equal(r.status, 200);
  const { results } = await r.json();
  assert.equal(results[0].uri, 'spotify:track:karma');
  assert.equal(results[0].name, 'Karma Police');
  assert.equal(results[0].sub, 'Radiohead');
  assert.equal(results[0].artUrl, 'https://img/okc');
  assert.ok(calls[0].includes('accounts.spotify.com'));
  assert.ok(calls[1].includes('api.spotify.com/v1/search?q=radiohead'));
  // cached token — second search shouldn't re-authenticate
  await fetch(`${base}/search?q=creep`);
  assert.equal(calls.filter((u) => u.includes('/api/token')).length, 1);
  close();
});

test('GET /search without credentials returns 400', async () => {
  const { base, close } = await listen(mount({}).app);
  const r = await fetch(`${base}/search?q=x`);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /clientId\/clientSecret/);
  close();
});

/** A real .tar.gz containing a stub `soloist` file, served by fake fetch. */
function fakeRelease() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-soloist-pkg-'));
  fs.writeFileSync(path.join(src, 'soloist'), '#!/bin/sh\necho fake\n');
  const tgz = path.join(src, 'rel.tar.gz');
  spawnSync('tar', ['-czf', tgz, '-C', src, 'soloist']);
  const fetched: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    fetched.push(String(url));
    return new Response(fs.readFileSync(tgz));
  }) as typeof fetch;
  return { fetchImpl, fetched };
}

test('self-managed binary is downloaded and spawned when missing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-soloist-data-'));
  const { fetchImpl, fetched } = fakeRelease();
  const { app, harness } = mount({
    managed: true,
    selfManaged: true,
    fetchImpl,
    dataDir,
  });
  const { close } = await listen(app);
  await waitFor(() => harness.daemons.length === 1);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /soloist_release_\w+\.tar\.gz$/);
  const bin = path.join(dataDir, 'soloist', 'soloist');
  assert.ok(fs.existsSync(bin));
  assert.equal(harness.daemons[0].bin, bin);
  close();
});

test('expiring self-managed binary warns, re-downloads, and respawns', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-soloist-data-'));
  const bin = path.join(dataDir, 'soloist', 'soloist');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n'); // already installed → no bootstrap fetch
  const { fetchImpl, fetched } = fakeRelease();
  const notices: NotificationInput[] = [];
  const { app, harness } = mount({
    notices,
    managed: true,
    selfManaged: true,
    fetchImpl,
    dataDir,
  });
  const { close } = await listen(app);
  await waitFor(() => harness.daemons.length === 1);
  harness.daemons[0].log('2026-10-27: client expires in 10 days');
  await waitFor(() => harness.daemons.length === 2);
  assert.ok(
    notices.some((n) => /update needed/.test(String(n.title))),
    'expected an update-needed notification',
  );
  assert.ok(
    notices.some((n) => /soloist updated/.test(String(n.title))),
    'expected an updated notification',
  );
  assert.equal(fetched.length, 1);
  assert.equal(harness.daemons[0].d.killed, true);
  close();
});

test('daemonBin mode warns on expiry but never downloads', async () => {
  const { fetchImpl, fetched } = fakeRelease();
  const notices: NotificationInput[] = [];
  const { app, harness } = mount({ notices, managed: true, fetchImpl });
  const { close } = await listen(app);
  await tick();
  harness.daemons[0].log('2026-10-27: client expires in 5 days');
  assert.match(
    String(notices.find((n) => /update needed/.test(String(n.title)))?.body),
    /expires in 5 day/,
  );
  assert.equal(fetched.length, 0);
  assert.equal(harness.daemons.length, 1);
  close();
});

test('stale apiKeyIssued warns about key expiry at startup', async () => {
  const notices: NotificationInput[] = [];
  mount({
    notices,
    managed: true,
    device: { apiKeyIssued: '2025-01-01' },
  });
  assert.equal(notices.length, 1);
  assert.match(String(notices[0].title), /api key expires soon/);
  assert.match(String(notices[0].body), /developer\.spotify\.com/);
});
