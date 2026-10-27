import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express, { type Express } from 'express';
import { intercomService } from './intercom.js';
import type { ServiceContext } from '../registry.js';
import type { DeviceConfig, IntercomEvent, IntercomSession } from '../types.js';

const device: DeviceConfig = {
  id: 'intercom',
  service: 'intercom',
  description: 'test intercom',
  access: { read: ['*'], write: ['*'] },
};

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'intercom-test-'));
}

/** Mounts the intercom service with a header-driven dashboard identity
 *  (`x-dashboard`) so tests can act as different dashboards. */
function mount(pushed: unknown[] = []): Express {
  const ctx: ServiceContext = {
    device,
    push: (d) => pushed.push(d),
    notify: () => {},
    dashboards: ['master', 'kitchen', 'living-room'],
    targets: ['master', 'kitchen', 'living-room'],
    dataDir: tmpdir(),
    prod: false,
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
  app.use('/api/intercom/intercom', intercomService.createRoutes(ctx));
  return app;
}

async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/intercom/intercom`;
  return { base, close: () => server.close() };
}

const as = (dash: string) => ({ 'content-type': 'application/json', 'x-dashboard': dash });
const state = (base: string, dash: string) =>
  fetch(`${base}/state`, { headers: as(dash) }).then((r) => r.json());
const start = (base: string, dash: string, targets: string[], contentType = 'audio/webm;codecs=opus') =>
  fetch(`${base}/start`, { method: 'POST', headers: as(dash), body: JSON.stringify({ targets, contentType }) });
const stop = (base: string, dash: string) =>
  fetch(`${base}/stop`, { method: 'POST', headers: as(dash) });
const chunk = (base: string, dash: string, data: string) =>
  fetch(`${base}/audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-dashboard': dash },
    body: data,
  });

/** Reads one chunk from a stream reader, or null on timeout. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 2000,
): Promise<Uint8Array | null> {
  const result = await Promise.race([
    reader.read().then((r) => r.value ?? null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
  return result;
}

test('start creates a session pushed to targets; state visible only to targets', async () => {
  const pushed: unknown[] = [];
  const { base, close } = await listen(mount(pushed));
  try {
    const res = await start(base, 'master', ['kitchen']);
    assert.equal(res.status, 200);
    const session = (await res.json()) as IntercomSession;
    assert.equal(session.from, 'master');
    assert.deepEqual(session.targets, ['kitchen']);
    assert.equal(session.contentType, 'audio/webm;codecs=opus');
    assert.match(session.id, /^[0-9a-f-]{36}$/);

    const event = pushed[0] as IntercomEvent;
    assert.equal(event.op, 'start');
    assert.deepEqual((event as IntercomSession).targets, ['kitchen']);

    assert.ok((await state(base, 'kitchen')).session);
    assert.equal((await state(base, 'living-room')).session, null);
    assert.equal((await state(base, 'master')).session, null); // sender not a target
  } finally {
    close();
  }
});

test('concurrent start rejected; only the initiator stops', async () => {
  const pushed: unknown[] = [];
  const { base, close } = await listen(mount(pushed));
  try {
    await start(base, 'master', ['kitchen']);
    assert.equal((await start(base, 'living-room', ['kitchen'])).status, 409);
    assert.equal((await stop(base, 'kitchen')).status, 403);
    assert.equal((await stop(base, 'living-room')).status, 403);

    const res = await stop(base, 'master');
    assert.equal(res.status, 200);
    const stopped = pushed.at(-1) as IntercomEvent;
    assert.equal(stopped.op, 'stop');

    assert.equal((await stop(base, 'master')).status, 409); // nothing active
    assert.equal((await state(base, 'kitchen')).session, null);
  } finally {
    close();
  }
});

test('start rejects invalid targets and missing contentType', async () => {
  const { base, close } = await listen(mount());
  try {
    assert.equal((await start(base, 'master', [])).status, 400);
    assert.equal((await start(base, 'master', ['no-such-dash'])).status, 400);
    assert.equal((await start(base, 'master', ['kitchen'], '')).status, 400);
    assert.equal(
      (
        await fetch(`${base}/start`, {
          method: 'POST',
          headers: as('master'),
          body: JSON.stringify({ targets: ['kitchen'] }),
        })
      ).status,
      400,
    );
  } finally {
    close();
  }
});

test('audio chunks relay to listeners in order; late joiner gets init', async () => {
  const { base, close } = await listen(mount());
  try {
    assert.equal((await chunk(base, 'master', 'x')).status, 409); // no session
    assert.equal((await fetch(`${base}/audio`, { headers: as('kitchen') })).status, 404);

    await start(base, 'master', ['kitchen']);

    const res = await fetch(`${base}/audio`, { headers: as('kitchen') });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/webm;codecs=opus');
    const reader = res.body!.getReader();

    assert.equal((await chunk(base, 'kitchen', 'intruder')).status, 403); // non-initiator
    assert.equal((await chunk(base, 'master', 'INIT')).status, 204);
    assert.equal((await chunk(base, 'master', 'ONE')).status, 204);

    const first = await readChunk(reader);
    assert.equal(Buffer.from(first!).toString(), 'INIT');
    const second = await readChunk(reader);
    assert.equal(Buffer.from(second!).toString(), 'ONE');

    // A late joiner receives the cached init segment before live chunks.
    const late = await fetch(`${base}/audio`, { headers: as('kitchen') });
    const lateReader = late.body!.getReader();
    assert.equal(Buffer.from((await readChunk(lateReader))!).toString(), 'INIT');
    await chunk(base, 'master', 'TWO');
    assert.equal(Buffer.from((await readChunk(lateReader))!).toString(), 'TWO');

    // Non-target cannot listen.
    assert.equal((await fetch(`${base}/audio`, { headers: as('living-room') })).status, 403);

    reader.cancel();
    lateReader.cancel();
  } finally {
    close();
  }
});

test('cap ends a session at max duration even while audio flows', async () => {
  process.env.INTERCOM_WATCHDOG_MS = '1000';
  process.env.INTERCOM_MAX_MS = '300';
  const pushed: unknown[] = [];
  const { base, close } = await listen(mount(pushed));
  try {
    await start(base, 'master', ['kitchen']);
    // Audio keeps flowing, so the silence watchdog never fires; only the
    // duration cap can end this session.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await chunk(base, 'master', `c${i}`);
    }
    const last = pushed.at(-1) as IntercomEvent;
    assert.equal(last.op, 'stop');
    assert.equal((await state(base, 'kitchen')).session, null);
  } finally {
    delete process.env.INTERCOM_WATCHDOG_MS;
    delete process.env.INTERCOM_MAX_MS;
    close();
  }
});

test('watchdog ends a silent session and pushes stop', async () => {
  process.env.INTERCOM_WATCHDOG_MS = '150';
  const pushed: unknown[] = [];
  const { base, close } = await listen(mount(pushed));
  try {
    await start(base, 'master', ['kitchen']);
    await chunk(base, 'master', 'INIT');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const last = pushed.at(-1) as IntercomEvent;
    assert.equal(last.op, 'stop');
    assert.equal((await state(base, 'kitchen')).session, null);
    assert.equal((await chunk(base, 'master', 'x')).status, 409);
  } finally {
    delete process.env.INTERCOM_WATCHDOG_MS;
    close();
  }
});
