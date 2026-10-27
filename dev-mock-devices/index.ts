import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.EMULATOR_PORT ?? 4000);
const DIR = path.dirname(fileURLToPath(import.meta.url));
/** Mock definitions live in `mocks/` beside this file; other files in the
 *  directory (package.json, tsconfig.json, …) are tooling, not mocks. */
const MOCK_DIR = path.join(DIR, 'mocks');

interface MockDevice {
  /** `{domain}/{entity}` path key, e.g. `light/living_room`. */
  key: string;
  /** ESPHome-shaped state payload returned by GET. */
  state: Record<string, unknown>;
  /** Apply a POSTed action + query params to state; false = unsupported. */
  onAction(action: string, query: Record<string, unknown>): boolean;
  /** Per-read autonomous behavior (drift); lights leave it unset. */
  tick?(): void;
}

/** Move `cur` toward `tgt` by at most `step`, landing exactly when close. */
const approach = (cur: number, tgt: number, step: number) =>
  Math.abs(tgt - cur) <= step ? tgt : cur + Math.sign(tgt - cur) * step;

function mockLight(entity: string, color: { r: number; g: number; b: number }): MockDevice {
  const state = {
    id: `light-${entity}`,
    state: 'OFF' as 'ON' | 'OFF',
    brightness: 255,
    color: { ...color },
  };
  return {
    key: `light/${entity}`,
    state,
    onAction(action, q) {
      if (action === 'toggle') {
        state.state = state.state === 'ON' ? 'OFF' : 'ON';
      } else if (action === 'turn_on') {
        state.state = 'ON';
        if (q.brightness !== undefined) state.brightness = Math.round(Number(q.brightness));
        for (const c of ['r', 'g', 'b'] as const)
          if (q[c] !== undefined) state.color[c] = Math.round(Number(q[c]) * 255);
      } else if (action === 'turn_off') {
        state.state = 'OFF';
      } else {
        return false;
      }
      return true;
    },
  };
}

function mockClimate(entity: string, ambientC: number): MockDevice {
  const state = {
    id: `climate-${entity}`,
    mode: 'OFF',
    current_temperature: 21.5,
    target_temperature: 22,
  };
  return {
    key: `climate/${entity}`,
    state,
    onAction(action, q) {
      if (action !== 'set') return false;
      if (typeof q.mode === 'string') state.mode = q.mode.toUpperCase();
      if (q.target_temperature !== undefined)
        state.target_temperature = Number(q.target_temperature);
      return true;
    },
    tick() {
      const cur = state.current_temperature;
      const tgt = state.target_temperature;
      let next: number;
      if (state.mode === 'HEAT' && cur < tgt) next = approach(cur, tgt, 0.2);
      else if (state.mode === 'COOL' && cur > tgt) next = approach(cur, tgt, 0.2);
      else if (state.mode === 'AUTO' || state.mode === 'HEAT_COOL')
        next = approach(cur, tgt, 0.2);
      else next = approach(cur, ambientC, 0.05); // OFF / FAN_ONLY → idle drift
      state.current_temperature =
        Math.round((next + (Math.random() - 0.5) * 0.05) * 10) / 10;
    },
  };
}

// --- Mock definitions: one JSON file per mock device --------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function buildMock(raw: unknown, file: string): MockDevice {
  if (!isRecord(raw)) throw new Error(`${file}: mock config is not an object`);
  for (const field of ['domain', 'entity']) {
    if (typeof raw[field] !== 'string' || !raw[field])
      throw new Error(`${file}: missing required field "${field}"`);
  }
  if (raw.kind === 'light') {
    const c = raw.color;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!isRecord(c) || !num(c.r) || !num(c.g) || !num(c.b))
      throw new Error(`${file}: light mock requires "color" {r,g,b} numbers`);
    return mockLight(raw.entity as string, c as { r: number; g: number; b: number });
  }
  if (raw.kind === 'climate') {
    if (typeof raw.ambient !== 'number' || !Number.isFinite(raw.ambient))
      throw new Error(`${file}: climate mock requires numeric "ambient"`);
    return mockClimate(raw.entity as string, raw.ambient);
  }
  throw new Error(`${file}: unknown kind "${raw.kind}" (expected "light" or "climate")`);
}

/** Build the mock registry from every `*.json` in `mocks/`. */
function loadMocks(): { devices: Map<string, MockDevice>; errors: string[] } {
  const devices = new Map<string, MockDevice>();
  const errors: string[] = [];
  if (!fs.existsSync(MOCK_DIR)) return { devices, errors };
  for (const f of fs.readdirSync(MOCK_DIR).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(MOCK_DIR, f), 'utf8'));
      const mock = buildMock(raw, f);
      if (devices.has(mock.key))
        throw new Error(`${f}: duplicate mock "${mock.key}"`);
      devices.set(mock.key, mock);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { devices, errors };
}

let { devices, errors } = loadMocks();
if (errors.length) {
  console.error('[mock-devices] config errors:\n' + errors.join('\n'));
  process.exit(1);
}

// Editing a mock JSON rebuilds the registry (state resets, as on restart).
let reloadTimer: NodeJS.Timeout | undefined;
const watcher = fs.existsSync(MOCK_DIR)
  ? fs.watch(MOCK_DIR, onMockChange)
  : null;
function onMockChange(_event: string, filename: string | null) {
  if (!filename?.endsWith('.json')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const next = loadMocks();
    if (next.errors.length) {
      console.error('[mock-devices] reload failed, keeping current mocks:\n' + next.errors.join('\n'));
      return;
    }
    devices = next.devices;
    console.log('[mock-devices] reloaded mock configs');
    for (const key of devices.keys()) console.log(`[mock-devices]   ${key}`);
  }, 100);
}
watcher?.on('error', (e) =>
  console.error('[mock-devices] watch error (reloads disabled):', e.message),
);

// --- Orphan guard ---------------------------------------------------------
// `npm run dev` doesn't reliably propagate shutdown into this process —
// killing concurrently/npm can leave the emulator running and holding the
// port. Snapshot the ancestor chain (pid:ppid pairs) at startup; when any
// ancestor exits or gets reparented the chain changes and we exit.
const parentOf = (pid: number): number | undefined => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
  } catch {
    return undefined;
  }
};
const ancestorSnapshot = (): string => {
  const parts: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const pp = parentOf(pid);
    parts.push(`${pid}:${pp}`);
    if (pp === undefined) break;
    pid = pp;
  }
  return parts.join(',');
};
const launchChain = ancestorSnapshot();
setInterval(() => {
  if (ancestorSnapshot() !== launchChain) {
    console.error('[mock-devices] launcher gone — exiting');
    process.exit(0);
  }
}, 3000).unref();

// --- ESPHome-flavored REST surface --------------------------------------

const send = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!m) {
    send(res, 404, { error: 'not found' });
    return;
  }
  const [, domain, entity, action] = m;
  const d = devices.get(`${domain}/${entity}`);

  if (req.method === 'GET' && !action) {
    if (!d) {
      send(res, 404, { error: `unknown entity ${domain}/${entity}` });
      return;
    }
    d.tick?.();
    send(res, 200, d.state);
    return;
  }

  if (req.method === 'POST' && action) {
    const query = Object.fromEntries(url.searchParams);
    if (!d || !d.onAction(action, query)) {
      send(res, 404, {
        error: `unknown entity/action ${domain}/${entity}/${action}`,
      });
      return;
    }
    send(res, 200, d.state);
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.on('clientError', (_err, socket) => socket.destroy());
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(
    `[mock-devices] server error: ${e.code === 'EADDRINUSE' ? `port ${PORT} already in use` : e.message}`,
  );
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`[mock-devices] listening on http://localhost:${PORT}`);
  for (const key of devices.keys()) console.log(`[mock-devices]   ${key}`);
});
