import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { actingDashboard } from '../middleware.js';
import type { Service } from '../registry.js';
import type { IntercomEvent, IntercomSession } from '../types.js';

interface ActiveBroadcast {
  session: IntercomSession;
  /** First chunk received (container init segment); prepended per listener
   *  so late joiners get a playable stream. */
  init: Buffer | null;
  listeners: Set<Response>;
  /** Silence watchdog; re-armed on each chunk. */
  timer?: NodeJS.Timeout;
  /** Max-duration cap; armed once at start, never reset. */
  cap?: NodeJS.Timeout;
}

/**
 * "intercom" device type: live one-way audio broadcast (PA-style). The
 * initiator POSTs MediaRecorder chunks to /audio; targeted dashboards play
 * GET /audio as a live stream. Start/stop events ride the device push
 * channel with `targets` so only addressed dashboards are notified. At most
 * one session is active per device; a watchdog ends silent sessions.
 */
export const intercomService: Service = {
  type: 'intercom',
  transport: 'push',
  dataType: 'intercom',
  sourceMode: 'none',
  targetFeature: 'intercom',
  createRoutes(ctx) {
    const r = Router();
    const watchdogMs = Number(process.env.INTERCOM_WATCHDOG_MS ?? 10_000);
    const maxMs = Number(process.env.INTERCOM_MAX_MS ?? 60_000);
    let active: ActiveBroadcast | null = null;

    const acting = (req: Request, res: Response) =>
      actingDashboard(req, res, ctx.dashboards, ctx.prod);

    const end = (b: ActiveBroadcast) => {
      if (active !== b) return;
      active = null;
      if (b.timer) clearTimeout(b.timer);
      if (b.cap) clearTimeout(b.cap);
      for (const l of b.listeners) l.end();
      const stop: IntercomEvent = {
        op: 'stop',
        sessionId: b.session.id,
        targets: b.session.targets,
      };
      ctx.push(stop);
    };

    const arm = (b: ActiveBroadcast) => {
      if (b.timer) clearTimeout(b.timer);
      b.timer = setTimeout(() => end(b), watchdogMs);
    };

    r.get('/state', (req, res) => {
      const dash = acting(req, res);
      res.json({
        session:
          active && active.session.targets.includes(dash) ? active.session : null,
      });
    });

    r.post('/start', (req, res) => {
      const { targets, contentType } = req.body ?? {};
      const from = acting(req, res);
      const valid =
        Array.isArray(targets) &&
        targets.length > 0 &&
        targets.every(
          (t) => typeof t === 'string' && ctx.targets.includes(t),
        ) &&
        typeof contentType === 'string' &&
        contentType.trim().length > 0;
      if (!valid) {
        res
          .status(400)
          .json({
            error:
              'start requires non-empty targets of configured dashboards and a contentType',
          });
        return;
      }
      if (active) {
        res.status(409).json({ error: 'a broadcast is already active' });
        return;
      }
      const session: IntercomSession = {
        id: randomUUID(),
        from,
        targets: [...new Set(targets)],
        contentType,
        ts: Date.now(),
      };
      const b: ActiveBroadcast = { session, init: null, listeners: new Set() };
      active = b;
      arm(b);
      b.cap = setTimeout(() => end(b), maxMs);
      const start: IntercomEvent = { op: 'start', ...session };
      ctx.push(start);
      res.json(session);
    });

    r.post('/stop', (req, res) => {
      const dash = acting(req, res);
      if (!active) {
        res.status(409).json({ error: 'no active broadcast' });
        return;
      }
      if (active.session.from !== dash) {
        res.status(403).json({ error: 'only the initiator may stop a broadcast' });
        return;
      }
      const session = active.session;
      end(active);
      res.json(session);
    });

    r.post('/audio', async (req, res) => {
      const dash = acting(req, res);
      if (!active) {
        req.resume();
        res.status(409).json({ error: 'no active broadcast' });
        return;
      }
      const b = active;
      if (b.session.from !== dash) {
        req.resume();
        res.status(403).json({ error: 'only the initiator may send audio' });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const data = Buffer.concat(chunks);
      if (!data.length) {
        res.status(400).json({ error: 'empty audio chunk' });
        return;
      }
      if (!b.init) b.init = data;
      for (const l of b.listeners) l.write(data);
      arm(b);
      res.sendStatus(204);
    });

    r.get('/audio', (req, res) => {
      const dash = acting(req, res);
      if (!active) {
        res.status(404).json({ error: 'no active broadcast' });
        return;
      }
      const b = active;
      if (!b.session.targets.includes(dash)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': b.session.contentType,
        'Cache-Control': 'no-cache',
      });
      res.flushHeaders();
      if (b.init) res.write(b.init);
      b.listeners.add(res);
      res.on('close', () => b.listeners.delete(res));
    });

    return r;
  },
};
