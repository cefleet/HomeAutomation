import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express, { type Express } from 'express';
import { thermostatService } from './thermostat.js';
import type { ServiceContext } from '../registry.js';
import type { DeviceConfig, NotificationInput } from '../types.js';

const device: DeviceConfig = {
  id: 'thermostat',
  service: 'thermostat',
  description: 'test thermostat',
  access: { read: ['*'], write: ['*'] },
};

function mount(notices: NotificationInput[] = [], source?: string): Express {
  const d = source ? { ...device, source, sourceType: 'esphome' } : device;
  const ctx: ServiceContext = {
    device: d,
    push: () => {},
    notify: (n) => notices.push(n),
    dashboards: ['master'],
    targets: ['master'],
    dataDir: '/tmp',
    prod: false,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/thermostat/thermostat', thermostatService.createRoutes(ctx));
  return app;
}

async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/thermostat/thermostat`;
  return { base, close: () => server.close() };
}

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /state returns the thermostat contract', async () => {
  const { base, close } = await listen(mount());
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.id, 'thermostat');
  assert.equal(typeof s.currentTempC, 'number');
  assert.equal(typeof s.setpointC, 'number');
  assert.ok(['off', 'heat', 'cool', 'fan', 'auto'].includes(s.mode));
  assert.equal(typeof s.updatedAt, 'string');
  close();
});

test('POST /set updates setpoint and mode and echoes state', async () => {
  const { base, close } = await listen(mount());
  const res = await post(base, { setpointC: 25, mode: 'heat' });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.setpointC, 25);
  assert.equal(s.mode, 'heat');
  const next = await (await fetch(`${base}/state`)).json();
  assert.equal(next.setpointC, 25);
  assert.equal(next.mode, 'heat');
  close();
});

test('POST /set clamps setpoint into 10–32 °C', async () => {
  const { base, close } = await listen(mount());
  const hi = await (await post(base, { setpointC: 99 })).json();
  assert.equal(hi.setpointC, 32);
  const lo = await (await post(base, { setpointC: -5 })).json();
  assert.equal(lo.setpointC, 10);
  close();
});

test('invalid /set fields are rejected with 400 and a notification', async () => {
  const notices: NotificationInput[] = [];
  const { base, close } = await listen(mount(notices));
  const bad = await post(base, { mode: 'turbo' });
  assert.equal(bad.status, 400);
  const badType = await post(base, { setpointC: 'warm' });
  assert.equal(badType.status, 400);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].type, 'issue');
  const s = await (await fetch(`${base}/state`)).json();
  assert.notEqual(s.mode, 'turbo');
  close();
});

/** Stub ESPHome climate entity: GET state, POST /set records its query. */
function stubClimate(calls: Record<string, unknown>[]): Express {
  const up = express();
  up.get('/climate/hvac', (_req, res) =>
    res.json({
      id: 'climate-hvac',
      mode: 'COOL',
      current_temperature: 24.5,
      target_temperature: 23,
    }),
  );
  up.post('/climate/hvac/set', (req, res) => {
    calls.push(req.query);
    res.json({});
  });
  return up;
}

test('sourced /state maps the ESPHome climate payload', async () => {
  const upServer = stubClimate([]);
  const upstream = upServer.listen(0);
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  const { base, close } = await listen(mount([], `http://127.0.0.1:${port}/climate/hvac`));
  const s = await (await fetch(`${base}/state`)).json();
  assert.equal(s.mode, 'cool');
  assert.equal(s.currentTempC, 24.5);
  assert.equal(s.setpointC, 23);
  upstream.close();
  close();
});

test('sourced /set posts mode and target_temperature upstream', async () => {
  const calls: Record<string, unknown>[] = [];
  const upstream = stubClimate(calls).listen(0);
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  const { base, close } = await listen(mount([], `http://127.0.0.1:${port}/climate/hvac`));
  const res = await post(base, { setpointC: 22, mode: 'heat' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'HEAT');
  assert.equal(calls[0].target_temperature, '22');
  upstream.close();
  close();
});

test('unreachable source yields 502', async () => {
  const { base, close } = await listen(mount([], 'http://127.0.0.1:1/climate/x'));
  assert.equal((await fetch(`${base}/state`)).status, 502);
  assert.equal((await post(base, { mode: 'heat' })).status, 502);
  close();
});
