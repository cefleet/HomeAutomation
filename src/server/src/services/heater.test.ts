import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express, { type Express } from 'express';
import { heaterService } from './heater.js';
import type { ServiceContext } from '../registry.js';
import type { DeviceConfig, NotificationInput } from '../types.js';

const device: DeviceConfig = {
  id: 'heater',
  service: 'heater',
  description: 'test heater',
  access: { read: ['*'], write: ['*'] },
};

function mount(notices: NotificationInput[] = [], extra: Partial<DeviceConfig> = {}): Express {
  const ctx: ServiceContext = {
    device: { ...device, ...extra },
    push: () => {},
    notify: (n) => notices.push(n),
    dashboards: ['master'],
    targets: ['master'],
    dataDir: '/tmp',
    prod: false,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/heater/heater', heaterService.createRoutes(ctx));
  return app;
}

async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/heater/heater`;
  return { base, close: () => server.close() };
}

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /state returns the heater contract', async () => {
  const { base, close } = await listen(mount());
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.id, 'heater');
  assert.equal(typeof s.on, 'boolean');
  assert.equal(typeof s.currentTempC, 'number');
  assert.equal(typeof s.setpointC, 'number');
  assert.equal(s.maxSetpointC, 32);
  assert.equal(typeof s.updatedAt, 'string');
  close();
});

test('POST /set updates power and setpoint and echoes state', async () => {
  const { base, close } = await listen(mount());
  const res = await post(base, { on: true, setpointC: 25 });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.on, true);
  assert.equal(s.setpointC, 25);
  const next = await (await fetch(`${base}/state`)).json();
  assert.equal(next.on, true);
  assert.equal(next.setpointC, 25);
  close();
});

test('POST /set clamps setpoint to 10 °C–maxSetpointC', async () => {
  const { base, close } = await listen(mount([], { maxTempC: 40 }));
  const state = await (await fetch(`${base}/state`)).json();
  assert.equal(state.maxSetpointC, 40);
  const hi = await (await post(base, { setpointC: 99 })).json();
  assert.equal(hi.setpointC, 40);
  const lo = await (await post(base, { setpointC: -5 })).json();
  assert.equal(lo.setpointC, 10);
  close();
});

test('invalid /set fields are rejected with 400 and a notification', async () => {
  const notices: NotificationInput[] = [];
  const { base, close } = await listen(mount(notices));
  const bad = await post(base, { on: 'yes' });
  assert.equal(bad.status, 400);
  const badType = await post(base, { setpointC: 'warm' });
  assert.equal(badType.status, 400);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].type, 'issue');
  close();
});

/** Stub ESPHome climate entity: GET state, POST /set records its query. */
function stubClimate(calls: Record<string, unknown>[], body: Record<string, unknown> = {}): Express {
  const up = express();
  up.get('/climate/heater', (_req, res) =>
    res.json({
      id: 'climate-heater',
      mode: 'HEAT',
      current_temperature: 18.5,
      target_temperature: 22,
      ...body,
    }),
  );
  up.post('/climate/heater/set', (req, res) => {
    calls.push(req.query);
    res.json({});
  });
  return up;
}

async function mountSourced(
  up: Express,
): Promise<{ base: string; close: () => void }> {
  const upstream = up.listen(0);
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  const { base, close } = await listen(
    mount([], { source: `http://127.0.0.1:${port}/climate/heater`, sourceType: 'esphome' }),
  );
  return { base, close: () => (upstream.close(), close()) };
}

test('sourced /state maps the ESPHome climate payload', async () => {
  const { base, close } = await mountSourced(stubClimate([], { max_temperature: 35 }));
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.on, true);
  assert.equal(s.currentTempC, 18.5);
  assert.equal(s.setpointC, 22);
  assert.equal(s.maxSetpointC, 35);
  close();
});

test('sourced /state maps OFF to on:false', async () => {
  const { base, close } = await mountSourced(stubClimate([], { mode: 'OFF' }));
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.on, false);
  close();
});

test('sourced /set posts mode and target_temperature upstream', async () => {
  const calls: Record<string, unknown>[] = [];
  const { base, close } = await mountSourced(stubClimate(calls));
  const res = await post(base, { on: true, setpointC: 24 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'HEAT');
  assert.equal(calls[0].target_temperature, '24');
  close();
});

test('sourced /set clamps setpoint at configured maxTempC', async () => {
  const calls: Record<string, unknown>[] = [];
  const upstream = stubClimate(calls).listen(0);
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  const { base, close } = await listen(
    mount([], {
      source: `http://127.0.0.1:${port}/climate/heater`,
      sourceType: 'esphome',
      maxTempC: 30,
    }),
  );
  const res = await post(base, { setpointC: 99 });
  assert.equal(res.status, 200);
  assert.equal(calls[0].target_temperature, '30');
  upstream.close();
  close();
});

test('unreachable source yields 502', async () => {
  const { base, close } = await listen(
    mount([], { source: 'http://127.0.0.1:1/climate/x', sourceType: 'esphome' }),
  );
  assert.equal((await fetch(`${base}/state`)).status, 502);
  assert.equal((await post(base, { on: true })).status, 502);
  close();
});
