import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { MessageLog } from '../messageLog.js';
import { actingDashboard } from '../middleware.js';
import type { Service } from '../registry.js';
import type { MessageReply, MessageThread } from '../types.js';

function participants(t: MessageThread): Set<string> {
  return new Set([t.from, ...t.targets]);
}

/**
 * "messenger" device type: server-managed dashboard-to-dashboard threads.
 * State lives in an append-only JSONL log replayed at startup. Push events
 * carry `targets` (all participants) so the device router delivers them only
 * to the dashboards concerned.
 */
export const messengerService: Service = {
  type: 'messenger',
  transport: 'push',
  dataType: 'messaging',
  sourceMode: 'none',
  targetFeature: 'messages',
  createRoutes(ctx) {
    const r = Router();
    const log = new MessageLog(ctx.dataDir, ctx.device.id);
    const threads = new Map<string, MessageThread>();

    for (const e of log.entries()) {
      if (e.op === 'create') {
        threads.set(e.thread.id, { ...e.thread, hiddenBy: e.thread.hiddenBy ?? [] });
      } else if (e.op === 'reply') {
        const t = threads.get(e.threadId);
        if (t) {
          t.replies.push(e.reply);
          t.seenBy = [e.reply.from];
          t.hiddenBy = [];
        }
      } else if (e.op === 'seen') {
        const t = threads.get(e.threadId);
        if (t && !t.seenBy.includes(e.dashboard)) t.seenBy.push(e.dashboard);
      } else {
        const t = threads.get(e.threadId);
        if (t) {
          if (!t.hiddenBy.includes(e.dashboard)) t.hiddenBy.push(e.dashboard);
          if (!t.seenBy.includes(e.dashboard)) t.seenBy.push(e.dashboard);
        }
      }
    }

    const acting = (req: Request, res: Response) =>
      actingDashboard(req, res, ctx.dashboards, ctx.prod);

    const threadFor = (threadId: unknown, dash: string): MessageThread | undefined => {
      const t = typeof threadId === 'string' ? threads.get(threadId) : undefined;
      return t && participants(t).has(dash) ? t : undefined;
    };

    r.get('/state', (req, res) => {
      const dash = acting(req, res);
      const mine = [...threads.values()]
        .filter((t) => participants(t).has(dash))
        .map((t) => ({
          ...t,
          unread: !t.seenBy.includes(dash),
          hidden: t.hiddenBy.includes(dash),
        }));
      res.json({ threads: mine, unread: mine.filter((t) => t.unread).length });
    });

    r.post('/send', (req, res) => {
      const { body, targets } = req.body ?? {};
      const from = acting(req, res);
      const valid =
        typeof body === 'string' &&
        body.trim().length > 0 &&
        Array.isArray(targets) &&
        targets.length > 0 &&
        targets.every((t) => typeof t === 'string' && ctx.targets.includes(t));
      if (!valid) {
        res.status(400).json({ error: 'send requires a body and non-empty targets of configured dashboards' });
        return;
      }
      const thread: MessageThread = {
        id: randomUUID(),
        from,
        targets: [...new Set([...targets, from])],
        ts: Date.now(),
        body: body.trim(),
        replies: [],
        seenBy: [from],
        hiddenBy: [],
      };
      threads.set(thread.id, thread);
      log.append({ op: 'create', thread });
      ctx.push(thread);
      res.json(thread);
    });

    r.post('/reply', (req, res) => {
      const { threadId, body } = req.body ?? {};
      const dash = acting(req, res);
      const thread = threadFor(threadId, dash);
      if (!thread) {
        res.status(404).json({ error: 'unknown thread' });
        return;
      }
      if (typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'reply requires a body' });
        return;
      }
      const reply: MessageReply = { id: randomUUID(), from: dash, ts: Date.now(), body: body.trim() };
      thread.replies.push(reply);
      thread.seenBy = [dash];
      thread.hiddenBy = [];
      log.append({ op: 'reply', threadId: thread.id, reply });
      ctx.push(thread);
      res.json(thread);
    });

    r.post('/seen', (req, res) => {
      const { threadId } = req.body ?? {};
      const dash = acting(req, res);
      const thread = threadFor(threadId, dash);
      if (!thread) {
        res.status(404).json({ error: 'unknown thread' });
        return;
      }
      if (!thread.seenBy.includes(dash)) {
        thread.seenBy.push(dash);
        log.append({ op: 'seen', threadId: thread.id, dashboard: dash, ts: Date.now() });
        ctx.push(thread);
      }
      res.json(thread);
    });

    r.post('/hide', (req, res) => {
      const { threadId } = req.body ?? {};
      const dash = acting(req, res);
      const thread = threadFor(threadId, dash);
      if (!thread) {
        res.status(404).json({ error: 'unknown thread' });
        return;
      }
      if (!thread.hiddenBy.includes(dash) || !thread.seenBy.includes(dash)) {
        if (!thread.hiddenBy.includes(dash)) thread.hiddenBy.push(dash);
        if (!thread.seenBy.includes(dash)) thread.seenBy.push(dash);
        log.append({ op: 'hide', threadId: thread.id, dashboard: dash, ts: Date.now() });
        ctx.push(thread);
      }
      res.json(thread);
    });

    return r;
  },
};
