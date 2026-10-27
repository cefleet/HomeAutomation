import { Router } from 'express';
import type { Service } from '../registry.js';

const MIN_SETPOINT_C = 10;
const DEFAULT_MAX_SETPOINT_C = 32;
const TIMEOUT_MS = 5000;

interface HeaterState {
  id: string;
  on: boolean;
  setpointC: number;
  currentTempC: number;
  maxSetpointC: number;
  updatedAt: string;
}

/**
 * "heater" device type with poll transport: clients refetch /state on an
 * interval. Heat-only — power plus a setpoint, no cool/fan modes. Devices
 * with an ESPHome `source` proxy that climate entity's REST API restricted
 * to OFF/HEAT (`GET {source}` state, `POST {source}/set` control); devices
 * without one are server-managed — the current temperature drifts toward
 * the setpoint while the heater is on. The setpoint ceiling `maxSetpointC`
 * resolves from the device's `maxTempC` config, then the source's
 * `max_temperature`, then a 32 °C default.
 */
export const heaterService: Service = {
  type: 'heater',
  transport: 'poll',
  dataType: 'heater',
  sourceMode: 'optional',
  createRoutes(ctx) {
    const r = Router();
    const source = ctx.device.source;
    const state: HeaterState = {
      id: ctx.device.id,
      on: false,
      setpointC: 22,
      currentTempC: 18.5,
      maxSetpointC: ctx.device.maxTempC ?? DEFAULT_MAX_SETPOINT_C,
      updatedAt: new Date().toISOString(),
    };
    /** Last `max_temperature` seen upstream; only used when the device
     *  config doesn't pin `maxTempC`. */
    let upstreamMaxC: number | undefined;

    const maxC = () =>
      ctx.device.maxTempC ?? upstreamMaxC ?? DEFAULT_MAX_SETPOINT_C;
    const clampSetpoint = (c: number) =>
      Math.min(maxC(), Math.max(MIN_SETPOINT_C, c));

    const fetchSource = async (): Promise<HeaterState> => {
      const upstream = await fetch(source!, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!upstream.ok) throw new Error(`source responded ${upstream.status}`);
      const b = (await upstream.json()) as {
        mode?: string;
        current_temperature?: number;
        target_temperature?: number;
        max_temperature?: number;
      };
      if (typeof b.max_temperature === 'number') upstreamMaxC = b.max_temperature;
      return {
        id: ctx.device.id,
        on: (b.mode ?? 'OFF') !== 'OFF',
        setpointC: typeof b.target_temperature === 'number' ? b.target_temperature : 0,
        currentTempC: b.current_temperature ?? 0,
        maxSetpointC: ctx.device.maxTempC ?? upstreamMaxC ?? DEFAULT_MAX_SETPOINT_C,
        updatedAt: new Date().toISOString(),
      };
    };

    const drift = () => {
      const heating = state.on && state.currentTempC < state.setpointC;
      const toward = heating ? 1 : 0;
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
      const { on, setpointC } = req.body ?? {};
      const bad =
        (on !== undefined && typeof on !== 'boolean') ||
        (setpointC !== undefined && typeof setpointC !== 'number');
      if (bad) {
        ctx.notify({
          type: 'issue',
          device: { type: ctx.device.service, id: ctx.device.id },
          title: `${ctx.device.id}: invalid set request`,
          body: 'on must be a boolean, setpointC a number',
        });
        res.status(400).json({ error: 'invalid fields for /set' });
        return;
      }

      if (source) {
        try {
          const params = new URLSearchParams();
          if (typeof setpointC === 'number')
            params.set('target_temperature', String(clampSetpoint(setpointC)));
          if (typeof on === 'boolean') params.set('mode', on ? 'HEAT' : 'OFF');
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
      if (typeof on === 'boolean') state.on = on;
      state.updatedAt = new Date().toISOString();
      res.json(state);
    });

    return r;
  },
};
