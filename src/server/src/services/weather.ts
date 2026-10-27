import { Router } from 'express';
import type { Service } from '../registry.js';

/**
 * "weather" device type with poll transport: clients refetch /state on an
 * interval. The backing data is server-managed (no physical device) — a
 * virtual device that drifts a little on each read, simulating a feed.
 */
export const weatherService: Service = {
  type: 'weather',
  transport: 'poll',
  dataType: 'weather',
  sourceMode: 'none',
  createRoutes(ctx) {
    const r = Router();
    const conditions = ['sunny', 'cloudy', 'rain', 'windy'];
    let tempC = 18.4;
    let humidity = 55;

    r.get('/state', (_req, res) => {
      tempC = Math.round((tempC + (Math.random() - 0.5) * 0.8) * 10) / 10;
      humidity = Math.min(90, Math.max(30, Math.round(humidity + (Math.random() - 0.5) * 3)));
      res.json({
        id: ctx.device.id,
        tempC,
        humidity,
        conditions: conditions[Math.floor(Math.random() * conditions.length)],
        updatedAt: new Date().toISOString(),
      });
    });

    return r;
  },
};
