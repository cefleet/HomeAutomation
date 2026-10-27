import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Router } from 'express';
import type { Service } from '../registry.js';

const RECONNECT_MS = 5000;
const FIRST_CONNECT_MS = 1000;
const VALID_REPEAT = new Set(['off', 'context', 'track']);
/** Warn / refresh this many days before a hard expiry. */
const UPDATE_SOON_DAYS = 14;
/** Soloist API keys live ~180 days from issuance. */
const KEY_TTL_DAYS = 180;
const SOLOIST_ARCH =
  ({ x64: 'x86_64', arm64: 'aarch64', arm: 'armv7' } as Record<string, string>)[
    process.arch
  ] ?? process.arch;
const SOLOIST_URL = `https://soloist-builds.spotifycdn.com/soloist_release_${SOLOIST_ARCH}.tar.gz`;
const EXPIRY_RE = /expires in (\d+) days/i;

const runCmd = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (c) =>
      c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`)),
    );
  });

/** Download the Soloist release tarball and install the binary at
 *  `dest` (extract via system `tar`; atomic-ish final rename). */
const downloadBinary = async (dest: string, fetchImpl: typeof fetch) => {
  const res = await fetchImpl(SOLOIST_URL);
  if (!res.ok) throw new Error(`soloist download failed (${res.status})`);
  const tgz = `${dest}.tar.gz`;
  const dir = `${dest}.extract`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  try {
    await runCmd('tar', ['-xzf', tgz, '-C', dir]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.chmodSync(path.join(dir, 'soloist'), 0o755);
    fs.renameSync(path.join(dir, 'soloist'), dest);
  } finally {
    fs.rmSync(tgz, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

export interface MediaPlayerState {
  id: string;
  /** Liveness of the daemon socket, not playback. */
  connected: boolean;
  /** Daemon has an authenticated Spotify Connect session. */
  loggedIn: boolean;
  /** This daemon is the active Spotify Connect device. */
  isActive: boolean;
  deviceName: string;
  playing: boolean;
  track: string;
  artist: string;
  album: string;
  /** Playlist/show the current track is playing from, when known. */
  contextName: string;
  albumArtUrl: string;
  volume: number;
  /** Position anchor in ms — clients interpolate locally using `speed`. */
  progressMs: number;
  /** Position advancement rate (0 paused, ~1 playing). */
  speed: number;
  durationMs: number;
  shuffle?: boolean;
  repeat?: 'off' | 'context' | 'track';
  updatedAt: string;
}

/** Handlers the service wires onto a daemon socket. */
export interface SoloistHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
}

/** Minimal socket surface the service needs — lifecycle events arrive via
 *  the handlers passed to the connector. */
export interface SoloistSocket {
  send(data: string): void;
  close(): void;
}

/** Connects a daemon socket; injectable so tests stub the daemon. */
export type SoloistConnector = (
  url: string,
  handlers: SoloistHandlers,
) => SoloistSocket;

const defaultConnector: SoloistConnector = (url, h) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => h.onOpen());
  ws.addEventListener('message', (ev) =>
    h.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data)),
  );
  ws.addEventListener('close', () => h.onClose());
  // 'error' is always followed by 'close'; reconnect is handled there.
  ws.addEventListener('error', () => {});
  return ws;
};

/** Why a managed daemon stopped — distinguishes "binary not found"
 *  from a crash so notifications can say which. */
export interface DaemonExit {
  code: number | null;
  signal: string | null;
  /** Spawn-level failure (e.g. ENOENT — binary missing). */
  error?: Error;
}

/** Minimal supervised-process surface; injectable so tests stub it. */
export interface SoloistDaemon {
  kill(): void;
  onExit(cb: (info: DaemonExit) => void): void;
}

/** Spawns the daemon binary; injectable so tests never fork a process. */
export type SoloistSpawner = (
  bin: string,
  args: string[],
  log: (line: string) => void,
) => SoloistDaemon;

const defaultSpawner: SoloistSpawner = (bin, args, log) => {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream?.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8');
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) line.trim() && log(line);
    });
  }
  const handlers: ((info: DaemonExit) => void)[] = [];
  const done = (info: DaemonExit) => handlers.forEach((h) => h(info));
  child.on('error', (error) => done({ code: null, signal: null, error }));
  child.on('exit', (code, signal) => done({ code, signal }));
  return {
    kill: () => child.kill('SIGTERM'),
    onExit: (cb) => handlers.push(cb),
  };
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/** Soloist entity envelope — playback items, contexts, queue entries. */
type SoloistEntity = Record<string, unknown>;

const deco = (e: SoloistEntity | undefined) => rec(e?.decorations);
const entityName = (e: SoloistEntity | undefined) =>
  str(rec(deco(e)?.identity)?.name);

/** Best cover art URL: prefer 'default' size, then 'large', then first. */
const coverUrl = (e: SoloistEntity | undefined): string | undefined => {
  const list = rec(deco(e)?.visual_identity)?.cover;
  if (!Array.isArray(list)) return undefined;
  const sized = ['default', 'large', 'small', 'xlarge']
    .map((s) => list.find((c) => rec(c)?.size === s))
    .find(Boolean);
  return str(rec(sized ?? list[0])?.url);
};

/** Our REST command vocabulary → Soloist command frame(s). A mapper
 *  returns null for an invalid value (→ 400). Repeat maps to the
 *  daemon's two coordinated repeat commands. */
const COMMAND_MAP: Record<
  string,
  (value: unknown) => Record<string, unknown>[] | null
> = {
  play: () => [{ command: 'play' }],
  pause: () => [{ command: 'pause' }],
  next: () => [{ command: 'skip_next' }],
  previous: () => [{ command: 'skip_prev' }],
  activate: () => [{ command: 'activate' }],
  volume: (v) =>
    typeof v === 'number' && v >= 0 && v <= 100
      ? [{ command: 'set_volume', volume: Math.round(v) }]
      : null,
  seek: (v) =>
    typeof v === 'number' && v >= 0
      ? [{ command: 'seek', position_ms: Math.round(v) }]
      : null,
  shuffle: (v) =>
    typeof v === 'boolean' ? [{ command: 'set_shuffle', enabled: v }] : null,
  repeat: (v) =>
    v === 'off'
      ? [
          { command: 'set_repeat_track', enabled: false },
          { command: 'set_repeat_context', enabled: false },
        ]
      : v === 'context'
        ? [
            { command: 'set_repeat_track', enabled: false },
            { command: 'set_repeat_context', enabled: true },
          ]
        : v === 'track'
          ? [
              { command: 'set_repeat_context', enabled: false },
              { command: 'set_repeat_track', enabled: true },
            ]
          : null,
  'play-uri': (v) =>
    typeof v === 'string' && v.length > 0 ? [{ command: 'play', uri: v }] : null,
  'queue-add': (v) =>
    typeof v === 'string' && v.length > 0
      ? [{ command: 'add_to_queue', uri: v }]
      : null,
};

/** Grab an ephemeral loopback port for a managed daemon's WS endpoint. */
const pickPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

/**
 * "spotify" device type backed by Spotify Soloist. Two modes, chosen by
 * the device config (`sourceMode: "optional"`):
 *
 * - Managed (no `source`): the service spawns and supervises a Soloist
 *   daemon itself — `soloist --device-name <deviceName> --api-key
 *   <apiKey> --ws 127.0.0.1:<port>` — restarting it on exit. Requires
 *   `apiKey`; `deviceName` defaults to the device id; `daemonBin`
 *   overrides the binary (default `soloist` on PATH).
 * - External (`source: "ws://host:port"`, `sourceType: "soloist"`):
 *   connect to a daemon the user runs elsewhere.
 *
 * Either way the service holds one persistent socket per device, maps
 * Soloist events (`auth_state`, `playback_state`, `track_changed`,
 * `playback_changed`, `volume_changed`, `options_changed`,
 * `position_sync`, `device_changed`, `context_changed`) into the
 * `media-player` contract, pushes updates to subscribers, and translates
 * `POST /command` calls into Soloist `{type: "command"}` frames. Daemon
 * `error` frames surface as issue notifications. One device = one daemon
 * = one playback session; separate simultaneous players are separate
 * device configs. `GET /state` always returns last-known state with
 * liveness flags rather than 502ing; commands while disconnected return
 * 502.
 */
export function createSpotifyService(
  connector: SoloistConnector = defaultConnector,
  spawner: SoloistSpawner = defaultSpawner,
  fetchImpl: typeof fetch = fetch,
): Service {
  return {
    type: 'spotify',
    transport: 'push',
    dataType: 'media-player',
    sourceMode: 'optional',
    // The router owns the daemon (managed mode) and its socket — build it
    // at startup, not on first request, so the player exists even while
    // nobody is looking at a dashboard.
    eager: true,
    validateDevices(devices) {
      const errors: string[] = [];
      for (const d of devices) {
        if (d.service !== 'spotify') continue;
        if (d.source === undefined && !d.apiKey)
          errors.push(
            `device "${d.id}": spotify requires "apiKey" when no "source" is configured`,
          );
        if (d.source !== undefined && d.sourceType !== 'soloist')
          errors.push(
            `device "${d.id}": spotify "source" must be a Soloist ws:// endpoint (sourceType "soloist")`,
          );
        if ((d.clientId === undefined) !== (d.clientSecret === undefined))
          errors.push(
            `device "${d.id}": "clientId" and "clientSecret" must be set together`,
          );
      }
      return errors;
    },
    createRoutes(ctx) {
      const r = Router();
      const managed = ctx.device.source === undefined;
      let wsUrl = ctx.device.source ?? null;
      let socket: SoloistSocket | null = null;
      let daemon: SoloistDaemon | null = null;
      let connected = false;
      /** Set once the link has been up — slows reconnect retries after
       *  the first successful connection. */
      let everConnected = false;
      let stopping = false;
      let daemonFailures = 0;
      /** Resolver for the in-flight `get_queue` request, if any. */
      let pendingQueue: ((msg: Record<string, unknown> | null) => void) | null =
        null;
      /** Cached catalog-search token (client-credentials grant). */
      let apiToken: { token: string; expiresAt: number } | null = null;
      const state: MediaPlayerState = {
        id: ctx.device.id,
        connected: false,
        loggedIn: false,
        isActive: false,
        deviceName: ctx.device.deviceName ?? ctx.device.id,
        playing: false,
        track: '',
        artist: '',
        album: '',
        contextName: '',
        albumArtUrl: '',
        volume: 0,
        progressMs: 0,
        speed: 0,
        durationMs: 0,
        updatedAt: new Date().toISOString(),
      };

      const issue = (title: string, body: string) =>
        ctx.notify({
          type: 'issue',
          device: { type: ctx.device.service, id: ctx.device.id },
          title: `${ctx.device.id}: ${title}`,
          body,
        });

      const current = (): MediaPlayerState => ({ ...state, connected });
      const touch = () => {
        state.updatedAt = new Date().toISOString();
        ctx.push(current());
      };

      const applyStatus = (status: unknown) => {
        if (typeof status !== 'string') return;
        state.playing = status === 'playing';
        state.speed = state.playing ? 1 : 0;
      };

      const applyItem = (item: unknown) => {
        const e = rec(item);
        if (!e) return;
        state.track = entityName(e) ?? state.track;
        const creators = deco(e)?.creators;
        if (Array.isArray(creators)) {
          const names = creators
            .map((c) => entityName(rec(rec(c)?.entity)))
            .filter((n): n is string => !!n);
          if (names.length) state.artist = names.join(', ');
        }
        const album = entityName(rec(rec(deco(e)?.parent)?.entity));
        if (album) state.album = album;
        state.albumArtUrl = coverUrl(e) ?? state.albumArtUrl;
        state.durationMs = num(rec(deco(e)?.playback)?.duration_ms) ?? state.durationMs;
      };

      const applyContext = (context: unknown) => {
        const name = entityName(rec(context));
        if (name !== undefined) state.contextName = name;
      };

      const applyPosition = (position: unknown) => {
        const p = rec(position);
        if (!p) return;
        state.progressMs = num(p.position_ms) ?? state.progressMs;
        state.speed = num(p.speed) ?? state.speed;
      };

      const applyOptions = (options: unknown) => {
        const o = rec(options);
        if (!o) return;
        if (typeof o.shuffle === 'boolean') state.shuffle = o.shuffle;
        if (typeof o.repeat === 'string' && VALID_REPEAT.has(o.repeat))
          state.repeat = o.repeat as MediaPlayerState['repeat'];
      };

      /** Queue entry → flat picker shape. */
      const mapEntry = (e: unknown) => {
        const entry = rec(e);
        const item = rec(entry?.item) ?? {};
        const creators = deco(item)?.creators;
        const artist = Array.isArray(creators)
          ? creators
              .map((c) => entityName(rec(rec(c)?.entity)))
              .filter((n): n is string => !!n)
              .join(', ')
          : '';
        return {
          uri: str(item.uri) ?? '',
          name: entityName(item) ?? '',
          artist,
          artUrl: coverUrl(item) ?? '',
          source: str(entry?.source) ?? '',
        };
      };

      const applySnapshot = (msg: Record<string, unknown>) => {
        applyStatus(msg.status);
        applyItem(msg.item);
        applyContext(msg.context);
        applyPosition(msg.position);
        applyOptions(msg.options);
        const volume = num(msg.volume);
        if (volume !== undefined) state.volume = Math.min(100, Math.max(0, volume));
        if (typeof msg.is_active === 'boolean') state.isActive = msg.is_active;
      };

      const handleEvent = (msg: Record<string, unknown>) => {
        switch (msg.type) {
          case 'auth_state':
            if (typeof msg.logged_in === 'boolean') state.loggedIn = msg.logged_in;
            if (typeof msg.is_active === 'boolean') state.isActive = msg.is_active;
            state.deviceName = str(msg.device_name) ?? state.deviceName;
            break;
          case 'playback_state':
            applySnapshot(msg);
            break;
          case 'track_changed':
            state.progressMs = 0;
            applyItem(msg.item);
            break;
          case 'playback_changed':
            applyStatus(msg.status);
            break;
          case 'volume_changed': {
            const v = num(msg.volume);
            if (v !== undefined) state.volume = Math.min(100, Math.max(0, v));
            break;
          }
          case 'options_changed':
            applyOptions(msg.options);
            break;
          case 'position_sync':
            applyPosition(msg.position);
            break;
          case 'device_changed':
            if (typeof msg.is_active === 'boolean') state.isActive = msg.is_active;
            state.deviceName = str(msg.device_name) ?? state.deviceName;
            break;
          case 'context_changed':
            applyContext(msg.context);
            break;
          case 'queue_changed':
            if (pendingQueue) {
              const resolve = pendingQueue;
              pendingQueue = null;
              resolve(msg);
            }
            return;
          case 'error':
            if (pendingQueue) {
              const reject = pendingQueue;
              pendingQueue = null;
              reject(null);
            }
            issue('player error', str(msg.message) ?? 'daemon rejected a command');
            return;
          default:
            // command_result, unknown events — no contract delta
            return;
        }
        touch();
      };

      const connect = () => {
        if (stopping || !wsUrl) return;
        try {
          socket = connector(wsUrl, {
            onOpen() {
              connected = true;
              everConnected = true;
              ctx.push(current());
            },
            onMessage(data) {
              try {
                const msg = JSON.parse(data) as Record<string, unknown>;
                if (typeof msg.type === 'string') {
                  connected = true;
                  everConnected = true;
                  handleEvent(msg);
                }
              } catch {
                /* malformed frame — ignore */
              }
            },
            onClose() {
              socket = null;
              if (connected) {
                connected = false;
                ctx.push(current());
              }
              retryConnect();
            },
          });
        } catch {
          retryConnect();
        }
      };
      // Retry fast until the link has been up at least once — a managed
      // daemon takes a moment to open its WS port after spawn.
      const retryConnect = () =>
        setTimeout(connect, everConnected ? RECONNECT_MS : FIRST_CONNECT_MS).unref();

      /** Binary we own when `daemonBin` isn't configured — the service
       *  keeps it under the data dir so it can download/refresh it. */
      const managedBin = path.join(ctx.dataDir, 'soloist', 'soloist');
      const selfManaged = managed && !ctx.device.daemonBin;
      let updating = false;

      /** Daemon reports "client expires in N days" — Soloist binaries
       *  expire ~90 days after release. Warn early; when the binary is
       *  ours, refresh it and respawn. */
      const checkExpiryLine = (line: string) => {
        const m = EXPIRY_RE.exec(line);
        if (!m) return;
        const days = Number(m[1]);
        if (days > UPDATE_SOON_DAYS) return;
        issue(
          'soloist update needed',
          `daemon binary expires in ${days} day(s)${selfManaged ? ' — updating' : ''}`,
        );
        if (!selfManaged || updating) return;
        updating = true;
        void downloadBinary(managedBin, fetchImpl)
          .then(() => {
            issue('soloist updated', 'new binary installed; restarting daemon');
            daemon?.kill();
          })
          .catch((err) => {
            updating = false;
            issue(
              'soloist update failed',
              err instanceof Error ? err.message : String(err),
            );
          });
      };

      const spawnDaemon = async () => {
        const bin = ctx.device.daemonBin ?? managedBin;
        const name = ctx.device.deviceName ?? ctx.device.id;
        try {
          if (selfManaged && !fs.existsSync(managedBin)) {
            issue('soloist missing', 'downloading latest release');
            await downloadBinary(managedBin, fetchImpl);
          }
          const port = await pickPort();
          if (stopping) return;
          wsUrl = `ws://127.0.0.1:${port}`;
          daemon = spawner(
            bin,
            [
              '--device-name',
              name,
              '--api-key',
              ctx.device.apiKey!,
              '--ws',
              `127.0.0.1:${port}`,
            ],
            (line) => {
              console.log(`[soloist:${ctx.device.id}] ${line}`);
              checkExpiryLine(line);
            },
          );
          daemon.onExit((info) => {
            daemon = null;
            if (stopping) return;
            if (updating) {
              // killed for a binary refresh — respawn quietly
              updating = false;
              void spawnDaemon();
              return;
            }
            daemonFailures += 1;
            const why = info.error
              ? `cannot run "${bin}": ${info.error.message}`
              : `soloist exited (code ${info.code ?? '?'}${info.signal ? `, ${info.signal}` : ''})`;
            issue(
              'daemon exited',
              `${why}${daemonFailures > 1 ? ` — restart ${daemonFailures}` : ''}; retrying`,
            );
            // Back off on repeated failures (e.g. binary not installed).
            const delay = Math.min(60000, RECONNECT_MS * daemonFailures);
            setTimeout(() => void spawnDaemon(), delay).unref();
          });
          connect();
        } catch (err) {
          issue(
            'daemon failed to start',
            err instanceof Error ? err.message : String(err),
          );
          setTimeout(() => void spawnDaemon(), RECONNECT_MS).unref();
        }
      };

      // Soloist API keys live ~180 days — warn ahead of expiry.
      if (managed && ctx.device.apiKeyIssued) {
        const issued = Date.parse(ctx.device.apiKeyIssued);
        if (Number.isFinite(issued)) {
          const ageDays = Math.floor((Date.now() - issued) / 86400000);
          if (ageDays >= KEY_TTL_DAYS - UPDATE_SOON_DAYS)
            issue(
              'api key expires soon',
              `Soloist apiKey is ~${ageDays} days old (lifetime ~${KEY_TTL_DAYS}) — regenerate at developer.spotify.com`,
            );
        }
      }

      if (managed) {
        void spawnDaemon();
        // Don't let the supervised daemon outlive us (tsx watch restarts,
        // deploys, Ctrl-C).
        const kill = () => {
          stopping = true;
          daemon?.kill();
        };
        process.once('exit', kill);
        for (const sig of ['SIGTERM', 'SIGINT'] as const)
          process.once(sig, () => {
            kill();
            process.kill(process.pid, sig);
          });
      } else {
        connect();
      }

      r.get('/state', (_req, res) => res.json(current()));

      /** GET /queue — ask the daemon for its play queue and await the
       *  queue_changed frame it returns. */
      r.get('/queue', (_req, res) => {
        if (!socket || !connected) {
          res.status(502).json({ error: 'player daemon unreachable' });
          return;
        }
        const timer = setTimeout(() => {
          pendingQueue = null;
          res.status(502).json({ error: 'queue request timed out' });
        }, 4000);
        pendingQueue = (msg) => {
          clearTimeout(timer);
          if (!msg) {
            res.status(502).json({ error: 'queue request rejected by daemon' });
            return;
          }
          const list = (v: unknown) => (Array.isArray(v) ? v : []);
          res.json({
            previous: list(msg.previous).map(mapEntry),
            upcoming: list(msg.upcoming).map(mapEntry),
          });
        };
        try {
          socket.send(JSON.stringify({ type: 'command', command: 'get_queue' }));
        } catch {
          clearTimeout(timer);
          pendingQueue = null;
          res.status(502).json({ error: 'player daemon unreachable' });
        }
      });

      /** GET /search — Spotify catalog search via the client-credentials
       *  grant (metadata only; playback stays on the daemon). */
      r.get('/search', async (req, res) => {
        const q = str(req.query.q);
        if (!q) {
          res.status(400).json({ error: 'missing "q"' });
          return;
        }
        const { clientId, clientSecret } = ctx.device;
        if (!clientId || !clientSecret) {
          res
            .status(400)
            .json({ error: 'search not configured (needs clientId/clientSecret)' });
          return;
        }
        try {
          if (!apiToken || Date.now() >= apiToken.expiresAt) {
            const tr = await fetchImpl(
              'https://accounts.spotify.com/api/token',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                  authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                },
                body: 'grant_type=client_credentials',
              },
            );
            if (!tr.ok) {
              res
                .status(502)
                .json({ error: `token request failed (${tr.status})` });
              return;
            }
            const tj = (await tr.json()) as Record<string, unknown>;
            apiToken = {
              token: str(tj.access_token) ?? '',
              expiresAt: Date.now() + ((num(tj.expires_in) ?? 3600) - 30) * 1000,
            };
          }
          const sr = await fetchImpl(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track,album,playlist&limit=8`,
            { headers: { authorization: `Bearer ${apiToken.token}` } },
          );
          if (!sr.ok) {
            res.status(502).json({ error: `search failed (${sr.status})` });
            return;
          }
          const sj = (await sr.json()) as Record<string, unknown>;
          const items = (kind: string) => {
            const list = rec(sj[kind])?.items;
            return Array.isArray(list) ? list : [];
          };
          const artists = (o: unknown) =>
            (Array.isArray(rec(o)?.artists) ? (rec(o)!.artists as unknown[]) : [])
              .map((a) => str(rec(a)?.name))
              .filter(Boolean)
              .join(', ');
          const img = (o: unknown, nested?: string) => {
            const images = rec(nested ? rec(o)?.[nested] : o)?.images;
            return Array.isArray(images) ? (str(rec(images[0])?.url) ?? '') : '';
          };
          const results = [
            ...items('tracks').map((t) => ({
              uri: str(rec(t)?.uri) ?? '',
              type: 'track',
              name: str(rec(t)?.name) ?? '',
              sub: artists(t),
              artUrl: img(t, 'album'),
            })),
            ...items('albums').map((a) => ({
              uri: str(rec(a)?.uri) ?? '',
              type: 'album',
              name: str(rec(a)?.name) ?? '',
              sub: artists(a),
              artUrl: img(a),
            })),
            ...items('playlists').map((p) => ({
              uri: str(rec(p)?.uri) ?? '',
              type: 'playlist',
              name: str(rec(p)?.name) ?? '',
              sub: `playlist by ${str(rec(rec(p)?.owner)?.display_name) ?? 'spotify'}`,
              artUrl: img(p),
            })),
          ].filter((x) => x.uri);
          res.json({ results });
        } catch (err) {
          res
            .status(502)
            .json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      r.post('/command', (req, res) => {
        const { command, value } = req.body ?? {};
        const frames =
          typeof command === 'string' ? COMMAND_MAP[command]?.(value) : undefined;
        if (!frames) {
          issue('invalid command', 'unknown command, or missing/mistyped value');
          res.status(400).json({ error: 'invalid command' });
          return;
        }
        if (!socket || !connected) {
          res.status(502).json({ error: 'player daemon unreachable' });
          return;
        }
        try {
          for (const f of frames)
            socket.send(JSON.stringify({ type: 'command', ...f }));
        } catch {
          res.status(502).json({ error: 'player daemon unreachable' });
          return;
        }
        res.json(current());
      });

      return r;
    },
  };
}

export const spotifyService = createSpotifyService();
