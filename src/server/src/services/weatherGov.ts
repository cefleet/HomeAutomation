import { Router } from 'express';
import type { Service } from '../registry.js';

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;
const GRID_RE = /^[A-Z]{2,4},\d+,\d+$/;

interface NwsPeriod {
  name?: string;
  startTime?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  shortForecast?: string;
  probabilityOfPrecipitation?: { value?: number | null };
}

/**
 * "weather-gov" service: real US National Weather Service data, poll
 * transport, `weather` dataType — clients can't tell it apart from the
 * virtual "weather" service. The gridpoint is supplied per-request via the
 * dashboard view's `params` (e.g. ?grid=TOP,31,83), keeping this service
 * usable for any location.
 */
export const weatherGovService: Service = {
  type: 'weather-gov',
  transport: 'poll',
  dataType: 'weather',
  sourceMode: 'none',
  createRoutes(ctx) {
    const r = Router();
    const cache = new Map<string, { ts: number; data: unknown }>();

    r.get('/state', async (req, res) => {
      const grid = typeof req.query.grid === 'string' ? req.query.grid : undefined;
      if (!grid || !GRID_RE.test(grid)) {
        res.status(400).json({
          error: 'missing or malformed "grid" param (expected OFFICE,x,y, e.g. ?grid=TOP,31,83)',
        });
        return;
      }
      const hit = cache.get(grid);
      if (hit && Date.now() - hit.ts < TTL_MS) {
        res.json(hit.data);
        return;
      }
      const [office, x, y] = grid.split(',');
      try {
        const upstream = await fetch(
          `https://api.weather.gov/gridpoints/${office}/${x},${y}/forecast`,
          {
            headers: { 'User-Agent': 'FleetwoodHomeAutomation (personal project)' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        if (!upstream.ok) {
          res.status(502).json({ error: `weather.gov responded ${upstream.status}` });
          return;
        }
        const body = (await upstream.json()) as {
          properties?: { periods?: NwsPeriod[] };
        };
        const periods = body.properties?.periods ?? [];
        const p0 = periods[0] ?? {};
        const tempC =
          typeof p0.temperature === 'number'
            ? Math.round(
                (p0.temperatureUnit === 'C' ? p0.temperature : ((p0.temperature - 32) * 5) / 9) * 10,
              ) / 10
            : undefined;
        const data = {
          id: ctx.device.id,
          source: 'nws',
          grid,
          tempC,
          conditions: p0.shortForecast,
          wind: p0.windSpeed,
          precipPct: p0.probabilityOfPrecipitation?.value ?? undefined,
          updatedAt: new Date().toISOString(),
          forecast: periods.slice(0, 6).map((p) => ({
            name: p.name,
            temp: p.temperature,
            unit: p.temperatureUnit,
            short: p.shortForecast,
          })),
        };
        cache.set(grid, { ts: Date.now(), data });
        res.json(data);
      } catch {
        res.status(502).json({ error: 'failed to reach weather.gov' });
      }
    });

    return r;
  },
};
