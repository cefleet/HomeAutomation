import { Router } from 'express';
import type { Service } from '../registry.js';
import type { DeviceConfig } from '../types.js';

type ZonedMode = 'off' | 'heat' | 'cool' | 'fan' | 'auto';

const MODES: ZonedMode[] = ['off', 'heat', 'cool', 'fan', 'auto'];
const MIN_SETPOINT_C = 16;
const MAX_SETPOINT_C = 30;
const TIMEOUT_MS = 5000;

const ES_TO_MODE: Record<string, ZonedMode> = {
  OFF: 'off',
  HEAT: 'heat',
  COOL: 'cool',
  FAN_ONLY: 'fan',
  AUTO: 'auto',
  HEAT_COOL: 'auto',
};
const MODE_TO_ES: Record<ZonedMode, string> = {
  off: 'OFF',
  heat: 'HEAT',
  cool: 'COOL',
  fan: 'FAN_ONLY',
  auto: 'AUTO',
};

interface ZonedState {
  id: string;
  currentTempC: number;
  setpointC: number;
  mode: ZonedMode;
  updatedAt: string;
}

interface ZoneDevice {
  id: string;
  role: 'master' | 'member';
  source?: string;
  /** Last mode this service observed (read or written). */
  lastMode?: ZonedMode;
  /** Mutable state ref for unsourced devices, attached at mount so a
   *  master write can force the member's mode. */
  virtual?: ZonedState;
}

interface ZoneGroup {
  masterId?: string;
  devices: Map<string, ZoneDevice>;
}

/** Zone groups keyed by group id — populated by `validateDevices` at load
 *  and self-registered per device at mount (covers direct mounts). */
const zoneGroups = new Map<string, ZoneGroup>();

function registerDevice(d: DeviceConfig): ZoneDevice {
  const groupId = d.zoneGroup ?? '';
  let g = zoneGroups.get(groupId);
  if (!g) {
    g = { devices: new Map() };
    zoneGroups.set(groupId, g);
  }
  let dev = g.devices.get(d.id);
  if (!dev) {
    dev = { id: d.id, role: d.zoneRole ?? 'member', source: d.source };
    g.devices.set(d.id, dev);
  }
  if (dev.role === 'master') g.masterId = d.id;
  return dev;
}

const clampSetpoint = (c: number) => Math.min(MAX_SETPOINT_C, Math.max(MIN_SETPOINT_C, c));

const fetchSource = async (id: string, source: string): Promise<ZonedState> => {
  const upstream = await fetch(source, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!upstream.ok) throw new Error(`source responded ${upstream.status}`);
  const b = (await upstream.json()) as {
    mode?: string;
    current_temperature?: number;
    target_temperature?: number;
  };
  return {
    id,
    currentTempC: b.current_temperature ?? 0,
    setpointC: typeof b.target_temperature === 'number' ? b.target_temperature : 0,
    mode: ES_TO_MODE[b.mode ?? ''] ?? 'auto',
    updatedAt: new Date().toISOString(),
  };
};

const postUpstream = async (source: string, params: URLSearchParams) => {
  const upstream = await fetch(`${source}/set?${params}`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error(`source responded ${upstream.status}`);
};

const opposite = (m: ZonedMode) => (m === 'heat' ? 'cool' : m === 'cool' ? 'heat' : undefined);

/**
 * "zoned" climate service (MRCool-style multi-zone heads sharing one
 * outdoor unit) with poll transport. Same REST surface as `thermostat`
 * plus zone metadata in state. Devices declare `zoneGroup`; exactly one
 * device per group is `zoneRole: "master"`. Members may always use
 * `auto`/`off`/`fan` but never the mode opposite the master's current
 * `heat`/`cool`; a master write landing in `heat`/`cool` forces
 * opposite-mode members to `fan`.
 */
export const zonedService = {
  type: 'zoned',
  transport: 'poll',
  dataType: 'zoned-thermostat',
  sourceMode: 'optional',

  validateDevices(devices) {
    zoneGroups.clear();
    const errors: string[] = [];
    const groups = new Map<string, string[]>();
    for (const d of devices.filter((d) => d.service === 'zoned')) {
      if (!d.zoneGroup) {
        errors.push(`device "${d.id}": service "zoned" requires "zoneGroup"`);
        continue;
      }
      registerDevice(d);
      const masters = groups.get(d.zoneGroup) ?? [];
      if (d.zoneRole === 'master') masters.push(d.id);
      groups.set(d.zoneGroup, masters);
    }
    for (const [name, masters] of groups) {
      if (masters.length === 0)
        errors.push(`zone group "${name}": no device declares zoneRole "master"`);
      if (masters.length > 1)
        errors.push(`zone group "${name}": multiple masters (${masters.join(', ')})`);
    }
    return errors;
  },

  createRoutes(ctx) {
    const r = Router();
    const source = ctx.device.source;
    const self = registerDevice(ctx.device);
    const group = zoneGroups.get(ctx.device.zoneGroup ?? '');
    const state: ZonedState = {
      id: ctx.device.id,
      currentTempC: 21.5,
      setpointC: 22,
      mode: 'off',
      updatedAt: new Date().toISOString(),
    };
    if (!source) self.virtual = state;

    const masterMode = (): ZonedMode | undefined =>
      group?.masterId ? group.devices.get(group.masterId)?.lastMode : undefined;

    const allowedModes = (): ZonedMode[] => {
      const banned = self.role === 'master' ? undefined : opposite(masterMode()!);
      return banned ? MODES.filter((m) => m !== banned) : MODES;
    };

    const contract = (s: ZonedState) => ({
      ...s,
      zoneGroup: ctx.device.zoneGroup,
      zoneRole: self.role,
      allowedModes: allowedModes(),
    });

    /** After a master write lands in heat/cool, force members in the
     *  opposite mode to fan. Never throws — failures only notify. */
    const propagate = async (mode: ZonedMode) => {
      const banned = opposite(mode);
      if (!banned || !group) return;
      const forced: string[] = [];
      const failed: string[] = [];
      for (const m of group.devices.values()) {
        if (m.id === self.id || m.lastMode !== banned) continue;
        try {
          if (m.virtual) {
            m.virtual.mode = 'fan';
            m.virtual.updatedAt = new Date().toISOString();
          }
          if (m.source)
            await postUpstream(m.source, new URLSearchParams({ mode: MODE_TO_ES.fan }));
          m.lastMode = 'fan';
          forced.push(m.id);
        } catch {
          failed.push(m.id);
        }
      }
      if (forced.length || failed.length)
        ctx.notify({
          type: 'issue',
          device: { type: ctx.device.service, id: ctx.device.id },
          title: `${ctx.device.id} → ${mode}: conflicted zone members`,
          body: [
            forced.length ? `forced to fan: ${forced.join(', ')}` : '',
            failed.length ? `failed to force: ${failed.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        });
    };

    const drift = () => {
      const conditioning =
        state.mode === 'auto' ||
        (state.mode === 'heat' && state.currentTempC < state.setpointC) ||
        (state.mode === 'cool' && state.currentTempC > state.setpointC);
      const toward = conditioning ? Math.sign(state.setpointC - state.currentTempC) : 0;
      state.currentTempC =
        Math.round((state.currentTempC + toward * 0.2 + (Math.random() - 0.5) * 0.1) * 10) / 10;
      state.updatedAt = new Date().toISOString();
    };

    r.get('/state', async (_req, res) => {
      if (source) {
        try {
          const s = await fetchSource(ctx.device.id, source);
          self.lastMode = s.mode;
          res.json(contract(s));
        } catch {
          res.status(502).json({ error: 'failed to reach device source' });
        }
        return;
      }
      drift();
      self.lastMode = state.mode;
      res.json(contract(state));
    });

    r.post('/set', async (req, res) => {
      const { setpointC, mode } = req.body ?? {};
      const bad =
        (setpointC !== undefined && typeof setpointC !== 'number') ||
        (mode !== undefined && !MODES.includes(mode));
      if (bad) {
        ctx.notify({
          type: 'issue',
          device: { type: ctx.device.service, id: ctx.device.id },
          title: `${ctx.device.id}: invalid set request`,
          body: 'setpointC must be a number, mode one of ' + MODES.join(', '),
        });
        res.status(400).json({ error: 'invalid fields for /set' });
        return;
      }

      const mm = masterMode();
      if (mode && self.role !== 'master' && opposite(mm as ZonedMode) === mode) {
        ctx.notify({
          type: 'issue',
          device: { type: ctx.device.service, id: ctx.device.id },
          title: `${ctx.device.id}: mode "${mode}" conflicts with zone master`,
          body: `master is "${mm}" — members may not run "${mode}"`,
        });
        res.status(409).json({
          error: `mode "${mode}" conflicts with zone master mode "${mm}"`,
        });
        return;
      }

      if (source) {
        try {
          const params = new URLSearchParams();
          if (typeof setpointC === 'number')
            params.set('target_temperature', String(clampSetpoint(setpointC)));
          if (mode) params.set('mode', MODE_TO_ES[mode as ZonedMode]);
          await postUpstream(source, params);
          const s = await fetchSource(ctx.device.id, source);
          self.lastMode = s.mode;
          if (self.role === 'master') await propagate(s.mode);
          res.json(contract(s));
        } catch {
          res.status(502).json({ error: 'failed to reach device source' });
        }
        return;
      }

      if (typeof setpointC === 'number') state.setpointC = clampSetpoint(setpointC);
      if (mode) state.mode = mode;
      state.updatedAt = new Date().toISOString();
      self.lastMode = state.mode;
      if (self.role === 'master') await propagate(state.mode);
      res.json(contract(state));
    });

    return r;
  },
} satisfies Service;
