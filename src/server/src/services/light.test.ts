import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express, { type Express } from 'express';
import { lightService } from './light.js';
import type { ServiceContext } from '../registry.js';
import type { DeviceConfig } from '../types.js';

const device: DeviceConfig = {
  id: 'lamp',
  service: 'light',
  description: 'test lamp',
  access: { read: ['*'], write: ['*'] },
};

async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0);
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

function mount(source?: string, pushed: unknown[] = []): Express {
  const d = source ? { ...device, source, sourceType: 'esphome' } : device;
  const ctx: ServiceContext = {
    device: d,
    push: (data) => pushed.push(data),
    notify: () => {},
    dashboards: ['master'],
    targets: ['master'],
    dataDir: '/tmp',
    prod: false,
  };
  const app = express();
  app.use(express.json());
  app.use(`/api/light/${d.id}`, lightService.createRoutes(ctx));
  return app;
}

/** Stub ESPHome light entity: GET state, POST actions record their query. */
function stubEsphome(calls: { action: string; query: unknown }[]): Express {
  const up = express();
  up.get('/light/lamp', (_req, res) =>
    res.json({
      id: 'light-lamp',
      state: 'ON',
      brightness: 128,
      color: { r: 255, g: 210, b: 138 },
    }),
  );
  for (const action of ['turn_on', 'turn_off']) {
    up.post(`/light/lamp/${action}`, (req, res) => {
      calls.push({ action, query: req.query });
      res.json({});
    });
  }
  return up;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('sourced /state maps the ESPHome light payload', async () => {
  const up = await listen(stubEsphome([]));
  const { base, close } = await listen(mount(`${up.base}/light/lamp`));
  const s = await (await fetch(`${base}/api/light/lamp/state`)).json();
  assert.equal(s.on, true);
  assert.equal(s.brightness, 50);
  assert.equal(s.color, '#ffd28a');
  up.close();
  close();
});

test('sourced /set posts turn_off / turn_on with mapped params', async () => {
  const calls: { action: string; query: unknown }[] = [];
  const up = await listen(stubEsphome(calls));
  const pushed: unknown[] = [];
  const { base, close } = await listen(mount(`${up.base}/light/lamp`, pushed));

  const off = await post(`${base}/api/light/lamp`, { on: false });
  assert.equal(off.status, 200);
  const on = await post(`${base}/api/light/lamp`, {
    on: true,
    brightness: 50,
    color: '#ff0000',
  });
  assert.equal(on.status, 200);

  assert.equal(calls[0].action, 'turn_off');
  assert.equal(calls[1].action, 'turn_on');
  const q = calls[1].query as Record<string, string>;
  assert.equal(q.brightness, '128');
  assert.equal(q.r, '1');
  assert.equal(q.g, '0');
  assert.equal(q.b, '0');
  assert.equal(pushed.length, 2);
  up.close();
  close();
});

test('unreachable source yields 502 on state and set', async () => {
  const { base, close } = await listen(mount('http://127.0.0.1:1/light/x'));
  const s = await fetch(`${base}/api/light/lamp/state`);
  assert.equal(s.status, 502);
  const w = await post(`${base}/api/light/lamp`, { on: true });
  assert.equal(w.status, 502);
  close();
});

test('unsourced device keeps virtual state', async () => {
  const { base, close } = await listen(mount());
  const w = await post(`${base}/api/light/lamp`, { on: true, brightness: 40 });
  assert.equal(w.status, 200);
  const s = await (await fetch(`${base}/api/light/lamp/state`)).json();
  assert.equal(s.on, true);
  assert.equal(s.brightness, 40);
  close();
});
