import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express, { type Express } from 'express';
import { targetsAllow } from '../devices.js';
import { messengerService } from './messenger.js';
import type { ServiceContext } from '../registry.js';
import type { DeviceConfig, MessageThread } from '../types.js';

const device: DeviceConfig = {
  id: 'messenger',
  service: 'messenger',
  description: 'test messenger',
  access: { read: ['*'], write: ['*'] },
};

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-test-'));
}

/** Mounts the messenger service with a header-driven dashboard identity
 *  (`x-dashboard`) so tests can act as different dashboards. */
function mount(dataDir: string, pushed: unknown[] = [], prod = false): Express {
  const ctx: ServiceContext = {
    device,
    push: (d) => pushed.push(d),
    notify: () => {},
    dashboards: ['master', 'kitchen', 'living-room'],
    targets: ['master', 'kitchen', 'living-room'],
    dataDir,
    prod,
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get('x-role') ?? 'admin';
    res.locals.client = {
      ip: 'test',
      dashboard: String(req.get('x-dashboard') ?? 'master'),
      role,
    };
    res.locals.roles = [role];
    res.locals.device = device;
    next();
  });
  app.use('/api/messenger/messenger', messengerService.createRoutes(ctx));
  return app;
}

async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/messenger/messenger`;
  return { base, close: () => server.close() };
}

const as = (dash: string) => ({ 'content-type': 'application/json', 'x-dashboard': dash });
const state = (base: string, dash: string) =>
  fetch(`${base}/state`, { headers: as(dash) }).then((r) => r.json());
const send = (base: string, dash: string, body: string, targets: string[]) =>
  fetch(`${base}/send`, { method: 'POST', headers: as(dash), body: JSON.stringify({ body, targets }) });
const reply = (base: string, dash: string, threadId: string, body: string) =>
  fetch(`${base}/reply`, { method: 'POST', headers: as(dash), body: JSON.stringify({ threadId, body }) });
const seen = (base: string, dash: string, threadId: string) =>
  fetch(`${base}/seen`, { method: 'POST', headers: as(dash), body: JSON.stringify({ threadId }) });
const hide = (base: string, dash: string, threadId: string) =>
  fetch(`${base}/hide`, { method: 'POST', headers: as(dash), body: JSON.stringify({ threadId }) });

test('send creates a thread visible only to participants, sender is seen', async () => {
  const dir = tmpdir();
  const { base, close } = await listen(mount(dir));
  try {
    const res = await send(base, 'master', 'dinner at 6', ['kitchen']);
    assert.equal(res.status, 200);
    const thread = (await res.json()) as MessageThread;
    assert.equal(thread.from, 'master');
    assert.ok(thread.targets.includes('kitchen'));
    assert.ok(thread.targets.includes('master'));
    assert.deepEqual(thread.seenBy, ['master']);
    assert.match(thread.id, /^[0-9a-f-]{36}$/);

    const kitchen = await state(base, 'kitchen');
    assert.equal(kitchen.threads.length, 1);
    assert.equal(kitchen.unread, 1);

    const master = await state(base, 'master');
    assert.equal(master.threads.length, 1);
    assert.equal(master.unread, 0);

    const outsider = await state(base, 'living-room');
    assert.equal(outsider.threads.length, 0);
    assert.equal(outsider.unread, 0);
  } finally {
    close();
  }
});

test('reply appends, resets seen to the replier, and pushes to participants', async () => {
  const dir = tmpdir();
  const pushed: unknown[] = [];
  const { base, close } = await listen(mount(dir, pushed));
  try {
    const thread = (await (await send(base, 'master', 'hi', ['kitchen'])).json()) as MessageThread;
    assert.equal(pushed.length, 1);

    const res = await reply(base, 'kitchen', thread.id, 'on my way');
    assert.equal(res.status, 200);
    const updated = (await res.json()) as MessageThread;
    assert.equal(updated.replies.length, 1);
    assert.equal(updated.replies[0].from, 'kitchen');
    assert.match(updated.replies[0].id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(updated.seenBy, ['kitchen']);

    const pushedThread = pushed[1] as MessageThread;
    assert.deepEqual(new Set(pushedThread.targets), new Set(['master', 'kitchen']));

    assert.equal((await state(base, 'master')).unread, 1);
    assert.equal((await state(base, 'kitchen')).unread, 0);
  } finally {
    close();
  }
});

test('seen clears unread for that dashboard only', async () => {
  const dir = tmpdir();
  const { base, close } = await listen(mount(dir));
  try {
    const thread = (await (await send(base, 'master', 'hi', ['kitchen', 'living-room'])).json()) as MessageThread;
    const res = await seen(base, 'kitchen', thread.id);
    assert.equal(res.status, 200);
    assert.equal((await state(base, 'kitchen')).unread, 0);
    assert.equal((await state(base, 'living-room')).unread, 1);
  } finally {
    close();
  }
});

test('non-participants get 404 on reply and seen', async () => {
  const dir = tmpdir();
  const { base, close } = await listen(mount(dir));
  try {
    const thread = (await (await send(base, 'master', 'hi', ['kitchen'])).json()) as MessageThread;
    assert.equal((await reply(base, 'living-room', thread.id, 'hello?')).status, 404);
    assert.equal((await seen(base, 'living-room', thread.id)).status, 404);
    assert.equal((await reply(base, 'kitchen', 'nonexistent-thread', 'x')).status, 404);
  } finally {
    close();
  }
});

test('send rejects empty or unconfigured targets', async () => {
  const dir = tmpdir();
  const { base, close } = await listen(mount(dir));
  try {
    assert.equal((await send(base, 'master', 'hi', [])).status, 400);
    assert.equal((await send(base, 'master', 'hi', ['no-such-dash'])).status, 400);
    assert.equal(
      (
        await fetch(`${base}/send`, {
          method: 'POST',
          headers: as('master'),
          body: JSON.stringify({ targets: ['kitchen'] }),
        })
      ).status,
      400,
    );
    assert.equal((await state(base, 'kitchen')).threads.length, 0);
  } finally {
    close();
  }
});

test('state survives restart via the JSONL log', async () => {
  const dir = tmpdir();
  const first = await listen(mount(dir));
  const thread = (await (await send(first.base, 'master', 'persist me', ['kitchen'])).json()) as MessageThread;
  await reply(first.base, 'kitchen', thread.id, 'got it');
  await seen(first.base, 'master', thread.id);
  first.close();

  const second = await listen(mount(dir));
  try {
    const master = await state(second.base, 'master');
    assert.equal(master.threads.length, 1);
    assert.equal(master.threads[0].replies.length, 1);
    assert.equal(master.unread, 0);
    const kitchen = await state(second.base, 'kitchen');
    // master marked seen after kitchen's reply; kitchen last replied and a
    // later 'seen' by master does not affect kitchen, who was reset by its
    // own reply — kitchen stays seen.
    assert.equal(kitchen.unread, 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.jsonl')));
  } finally {
    second.close();
  }
});

test('hide is per-dashboard, marks seen, and a reply un-hides it', async () => {
  const dir = tmpdir();
  const { base, close } = await listen(mount(dir));
  try {
    const thread = (await (await send(base, 'master', 'hi', ['kitchen', 'living-room'])).json()) as MessageThread;

    const res = await hide(base, 'kitchen', thread.id);
    assert.equal(res.status, 200);
    const hidden = (await res.json()) as MessageThread;
    assert.ok(hidden.hiddenBy.includes('kitchen'));
    assert.ok(hidden.seenBy.includes('kitchen')); // hiding implies seen

    const kitchen = await state(base, 'kitchen');
    assert.equal(kitchen.threads[0].hidden, true);
    assert.equal(kitchen.unread, 0);
    // Other participants unaffected.
    const livingRoom = await state(base, 'living-room');
    assert.equal(livingRoom.threads[0].hidden, false);
    assert.equal(livingRoom.unread, 1);
    // Non-participant cannot hide.
    assert.equal((await hide(base, 'living-room', 'nonexistent')).status, 404);

    // A reply clears the hidden set and revives unread for the hider.
    await reply(base, 'living-room', thread.id, 'anyone there?');
    const after = await state(base, 'kitchen');
    assert.equal(after.threads[0].hidden, false);
    assert.equal(after.unread, 1);
  } finally {
    close();
  }
});

test('?dashboard= override acts as the viewed dashboard (non-prod)', async () => {
  const dir = tmpdir();
  const { base, close } = await listen(mount(dir));
  const masterClient = { 'content-type': 'application/json', 'x-dashboard': 'master' };
  try {
    // A master client sends to kitchen, then views the kitchen dashboard.
    const thread = (await (await send(base, 'master', 'hi kitchen', ['kitchen'])).json()) as MessageThread;
    const kitchenView = await fetch(`${base}/state?dashboard=kitchen`, { headers: masterClient }).then((r) => r.json());
    assert.equal(kitchenView.threads.length, 1);
    assert.equal(kitchenView.unread, 1);
    // Marking seen while viewing kitchen records kitchen, not master.
    const seenRes = await fetch(`${base}/seen?dashboard=kitchen`, {
      method: 'POST',
      headers: masterClient,
      body: JSON.stringify({ threadId: thread.id }),
    });
    assert.equal(seenRes.status, 200);
    const updated = (await state(base, 'master')) as { threads: MessageThread[] };
    assert.ok(updated.threads[0].seenBy.includes('kitchen'));
    // Sending while viewing kitchen sends `from` kitchen.
    const fromKitchen = (await (
      await fetch(`${base}/send?dashboard=kitchen`, {
        method: 'POST',
        headers: masterClient,
        body: JSON.stringify({ body: 'reply-thread', targets: ['master'] }),
      })
    ).json()) as MessageThread;
    assert.equal(fromKitchen.from, 'kitchen');
  } finally {
    close();
  }
});

test('prod ignores ?dashboard= for non-admin callers', async () => {
  const dir = tmpdir();
  const { base, close } = await listen(mount(dir, [], true));
  try {
    await send(base, 'master', 'hi', ['kitchen']);
    // Non-admin master client asking as kitchen falls back to master.
    const res = await fetch(`${base}/state?dashboard=kitchen`, {
      headers: { 'x-dashboard': 'master', 'x-role': 'user' },
    });
    const body = await res.json();
    assert.equal(body.unread, 0); // master already saw its own thread
    // Admin can act as another dashboard.
    const adminView = await fetch(`${base}/state?dashboard=kitchen`, {
      headers: { 'x-dashboard': 'master', 'x-role': 'admin' },
    });
    assert.equal((await adminView.json()).unread, 1);
  } finally {
    close();
  }
});

test('targetsAllow filters push payloads by resolved dashboard', () => {
  assert.equal(targetsAllow({ targets: ['kitchen'] }, 'kitchen'), true);
  assert.equal(targetsAllow({ targets: ['kitchen'] }, 'master'), false);
  assert.equal(targetsAllow({ body: 'x' }, 'master'), true);
  assert.equal(targetsAllow('plain', 'master'), true);
  assert.equal(targetsAllow({ targets: 'kitchen' }, 'master'), true);
});
