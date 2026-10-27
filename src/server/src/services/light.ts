import { Router } from 'express';
import type { Service } from '../registry.js';

interface LightState {
  id: string;
  on: boolean;
  color: string;
  brightness: number;
  updatedAt: string;
}

const TIMEOUT_MS = 5000;

const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/** Map an ESPHome light state payload to the contract. */
function fromEsphome(id: string, body: Record<string, unknown>): LightState {
  const c = (body.color ?? {}) as { r?: number; g?: number; b?: number };
  return {
    id,
    on: body.state === 'ON',
    color:
      typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number'
        ? `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`
        : '#ffffff',
    brightness: Math.round(((typeof body.brightness === 'number' ? body.brightness : 0) / 255) * 100),
    updatedAt: new Date().toISOString(),
  };
}

/** Contract hex color → ESPHome turn_on r/g/b (0–1 floats). */
function hexToEsphome(color: string): Record<string, string> {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return {};
  return {
    r: String(parseInt(m[1], 16) / 255),
    g: String(parseInt(m[2], 16) / 255),
    b: String(parseInt(m[3], 16) / 255),
  };
}

/**
 * "light" device type with push transport: state changes are pushed to
 * subscribers whenever a write happens. Multiple devices (configs) can share
 * this service; createRoutes is called once per device so each keeps its own
 * state. Devices with an ESPHome `source` proxy that entity's REST API
 * (`GET {source}` state, `POST {source}/turn_on|turn_off` control); devices
 * without one keep server-managed virtual state.
 */
export const lightService: Service = {
  type: 'light',
  transport: 'push',
  dataType: 'light',
  sourceMode: 'optional',
  createRoutes(ctx) {
    const r = Router();
    const source = ctx.device.source;
    const state: LightState = {
      id: ctx.device.id,
      on: false,
      color: '#ffd28a',
      brightness: 80,
      updatedAt: new Date().toISOString(),
    };

    const fetchSource = async (): Promise<LightState> => {
      const upstream = await fetch(source!, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!upstream.ok) throw new Error(`source responded ${upstream.status}`);
      return fromEsphome(ctx.device.id, (await upstream.json()) as Record<string, unknown>);
    };

    r.get('/state', async (_req, res) => {
      if (!source) {
        res.json(state);
        return;
      }
      try {
        res.json(await fetchSource());
      } catch {
        res.status(502).json({ error: 'failed to reach device source' });
      }
    });

    r.post('/set', async (req, res) => {
      const { on, color, brightness } = req.body ?? {};
      const bad =
        (on !== undefined && typeof on !== 'boolean') ||
        (color !== undefined && typeof color !== 'string') ||
        (brightness !== undefined && typeof brightness !== 'number');
      if (bad) {
        ctx.notify({
          type: 'issue',
          device: { type: ctx.device.service, id: ctx.device.id },
          title: `${ctx.device.id}: invalid set request`,
          body: 'on must be boolean, color string, brightness number',
        });
        res.status(400).json({ error: 'invalid fields for /set' });
        return;
      }

      if (source) {
        try {
          const params = new URLSearchParams();
          if (typeof brightness === 'number')
            params.set('brightness', String(Math.round((Math.min(100, Math.max(0, brightness)) / 100) * 255)));
          if (typeof color === 'string')
            for (const [k, v] of Object.entries(hexToEsphome(color))) params.set(k, v);
          const action = on === false ? 'turn_off' : 'turn_on';
          const qs = params.toString();
          const upstream = await fetch(`${source}/${action}${qs ? `?${qs}` : ''}`, {
            method: 'POST',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!upstream.ok) throw new Error(`source responded ${upstream.status}`);
          const next = await fetchSource();
          ctx.push(next);
          res.json(next);
        } catch {
          res.status(502).json({ error: 'failed to reach device source' });
        }
        return;
      }

      if (typeof on === 'boolean') state.on = on;
      if (typeof color === 'string') state.color = color;
      if (typeof brightness === 'number') state.brightness = Math.min(100, Math.max(0, brightness));
      state.updatedAt = new Date().toISOString();
      ctx.push(state);
      res.json(state);
    });

    return r;
  },
};
