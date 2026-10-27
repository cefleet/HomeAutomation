import { Router } from 'express';
import type { Service } from '../registry.js';

type ThermostatMode = 'off' | 'heat' | 'cool' | 'fan' | 'auto';

const MODES: ThermostatMode[] = ['off', 'heat', 'cool', 'fan', 'auto'];
const MIN_SETPOINT_C = 10;
const MAX_SETPOINT_C = 32;
const TIMEOUT_MS = 5000;

const ES_TO_MODE: Record<string, ThermostatMode> = {
  OFF: 'off',
  HEAT: 'heat',
  COOL: 'cool',
  FAN_ONLY: 'fan',
  AUTO: 'auto',
  HEAT_COOL: 'auto',
};
const MODE_TO_ES: Record<ThermostatMode, string> = {
  off: 'OFF',
  heat: 'HEAT',
  cool: 'COOL',
  fan: 'FAN_ONLY',
  auto: 'AUTO',
};

interface ThermostatState {
  id: string;
  currentTempC: number;
  setpointC: number;
  mode: ThermostatMode;
  updatedAt: string;
}

const clampSetpoint = (c: number) => Math.min(MAX_SETPOINT_C, Math.max(MIN_SETPOINT_C, c));

/**
 * "thermostat" device type with poll transport: clients refetch /state on
 * an interval. Devices with an ESPHome `source` proxy that climate entity's
 * REST API (`GET {source}` state, `POST {source}/set` control); devices
 * without one are server-managed — the current temperature drifts toward
 * the setpoint while a conditioning mode is active so setpoint changes
 * visibly affect the room temperature.
 */
export const thermostatService: Service = {
  type: 'thermostat',
  transport: 'poll',
  dataType: 'thermostat',
  sourceMode: 'optional',
  createRoutes(ctx) {
    const r = Router();
    const source = ctx.device.source;
    const state: ThermostatState = {
      id: ctx.device.id,
      currentTempC: 21.5,
      setpointC: 22,
      mode: 'off',
      updatedAt: new Date().toISOString(),
    };

    const fetchSource = async (): Promise<ThermostatState> => {
      const upstream = await fetch(source!, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!upstream.ok) throw new Error(`source responded ${upstream.status}`);
      const b = (await upstream.json()) as {
        mode?: string;
        current_temperature?: number;
        target_temperature?: number;
      };
      return {
        id: ctx.device.id,
        currentTempC: b.current_temperature ?? 0,
        setpointC: typeof b.target_temperature === 'number' ? b.target_temperature : 0,
        mode: ES_TO_MODE[b.mode ?? ''] ?? 'auto',
        updatedAt: new Date().toISOString(),
      };
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
          res.json(await fetchSource());
        } catch {
          res.status(502).json({ error: 'failed to reach device source' });
        }
        return;
      }
      drift();
      res.json(state);
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

      if (source) {
        try {
          const params = new URLSearchParams();
          if (typeof setpointC === 'number')
            params.set('target_temperature', String(clampSetpoint(setpointC)));
          if (mode) params.set('mode', MODE_TO_ES[mode as ThermostatMode]);
          const upstream = await fetch(`${source}/set?${params}`, {
            method: 'POST',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!upstream.ok) throw new Error(`source responded ${upstream.status}`);
          res.json(await fetchSource());
        } catch {
          res.status(502).json({ error: 'failed to reach device source' });
        }
        return;
      }

      if (typeof setpointC === 'number') state.setpointC = clampSetpoint(setpointC);
      if (mode) state.mode = mode;
      state.updatedAt = new Date().toISOString();
      res.json(state);
    });

    return r;
  },
};
