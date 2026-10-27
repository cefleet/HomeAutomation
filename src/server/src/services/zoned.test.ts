import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express, { type Express } from 'express';
import { zonedService } from './zoned.js';
import type { ServiceContext } from '../registry.js';
import type { DeviceConfig, NotificationInput } from '../types.js';

const dev = (
  id: string,
  zoneGroup: string,
  zoneRole?: 'master' | 'member',
  source?: string,
): DeviceConfig => ({
  id,
  service: 'zoned',
  zoneGroup,
  ...(zoneRole ? { zoneRole } : {}),
  ...(source ? { source, sourceType: 'esphome' } : {}),
  description: `test ${id}`,
  access: { read: ['*'], write: ['*'] },
});

function mount(notices: NotificationInput[], devices: DeviceConfig[]): Express {
  const app = express();
  app.use(express.json());
  for (const d of devices) {
    const ctx: ServiceContext = {
      device: d,
      push: () => {},
      notify: (n) => notices.push(n),
      dashboards: ['master'],
      targets: ['master'],
      dataDir: '/tmp',
      prod: false,
    };
    app.use(`/api/zoned/${d.id}`, zonedService.createRoutes(ctx));
  }
  return app;
}

async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0);
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/zoned`,
    close: () => server.close(),
  };
}

const get = (base: string, id: string) => fetch(`${base}/${id}/state`);
const post = (base: string, id: string, body: unknown) =>
  fetch(`${base}/${id}/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const MODES = ['off', 'heat', 'cool', 'fan', 'auto'];

test('GET /state returns the zoned contract with zone fields', async () => {
  const master = dev('office-ac', 'g-contract', 'master');
  const member = dev('alles-ac', 'g-contract');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount([], [master, member]));
  const s = await (await get(base, 'alles-ac')).json();
  assert.equal(s.id, 'alles-ac');
  assert.equal(typeof s.currentTempC, 'number');
  assert.ok(MODES.includes(s.mode));
  assert.equal(s.zoneGroup, 'g-contract');
  assert.equal(s.zoneRole, 'member');
  assert.deepEqual(s.allowedModes, MODES);
  close();
});

test('member allowedModes excludes the opposite of the master mode', async () => {
  const master = dev('office-ac', 'g-allowed', 'master');
  const member = dev('alles-ac', 'g-allowed');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount([], [master, member]));
  await post(base, 'office-ac', { mode: 'cool' });
  const s = await (await get(base, 'alles-ac')).json();
  assert.deepEqual(s.allowedModes, ['off', 'cool', 'fan', 'auto']);
  await post(base, 'office-ac', { mode: 'off' });
  const s2 = await (await get(base, 'alles-ac')).json();
  assert.deepEqual(s2.allowedModes, MODES);
  close();
});

test('POST /set clamps setpoint into 16–30 °C', async () => {
  const master = dev('office-ac', 'g-clamp', 'master');
  zonedService.validateDevices([master]);
  const { base, close } = await listen(mount([], [master]));
  const hi = await (await post(base, 'office-ac', { setpointC: 99 })).json();
  assert.equal(hi.setpointC, 30);
  const lo = await (await post(base, 'office-ac', { setpointC: -5 })).json();
  assert.equal(lo.setpointC, 16);
  close();
});

test('member mode opposite the master is rejected with 409 + notification', async () => {
  const notices: NotificationInput[] = [];
  const master = dev('office-ac', 'g-conflict', 'master');
  const member = dev('alles-ac', 'g-conflict');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount(notices, [master, member]));
  await post(base, 'office-ac', { mode: 'cool' });
  const res = await post(base, 'alles-ac', { mode: 'heat' });
  assert.equal(res.status, 409);
  assert.equal(notices.at(-1)?.type, 'issue');
  const s = await (await get(base, 'alles-ac')).json();
  assert.notEqual(s.mode, 'heat');
  close();
});

test('member may use cool/auto/fan/off while master cools', async () => {
  const master = dev('office-ac', 'g-ok', 'master');
  const member = dev('alles-ac', 'g-ok');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount([], [master, member]));
  await post(base, 'office-ac', { mode: 'cool' });
  for (const mode of ['cool', 'auto', 'fan', 'off'])
    assert.equal((await post(base, 'alles-ac', { mode })).status, 200, mode);
  close();
});

test('master writes are unconstrained by member modes', async () => {
  const master = dev('office-ac', 'g-free', 'master');
  const member = dev('alles-ac', 'g-free');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount([], [master, member]));
  await post(base, 'alles-ac', { mode: 'cool' });
  const res = await post(base, 'office-ac', { mode: 'heat' });
  assert.equal(res.status, 200);
  close();
});

test('master flip forces a conflicted virtual member to fan + notifies', async () => {
  const notices: NotificationInput[] = [];
  const master = dev('office-ac', 'g-flip', 'master');
  const member = dev('alles-ac', 'g-flip');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount(notices, [master, member]));
  await post(base, 'alles-ac', { mode: 'cool' });
  await post(base, 'office-ac', { mode: 'heat' });
  const s = await (await get(base, 'alles-ac')).json();
  assert.equal(s.mode, 'fan');
  assert.ok(notices.some((n) => n.type === 'issue' && n.body?.includes('alles-ac')));
  close();
});

test('invalid /set fields are rejected with 400', async () => {
  const notices: NotificationInput[] = [];
  const master = dev('office-ac', 'g-bad', 'master');
  zonedService.validateDevices([master]);
  const { base, close } = await listen(mount(notices, [master]));
  assert.equal((await post(base, 'office-ac', { mode: 'turbo' })).status, 400);
  assert.equal((await post(base, 'office-ac', { setpointC: 'warm' })).status, 400);
  assert.equal(notices.length, 2);
  close();
});

/** Stub ESPHome climate entity recording /set query params. */
function stubClimate(mode: string, calls: Record<string, unknown>[]): Express {
  const state = { id: 'climate-stub', mode, current_temperature: 24.5, target_temperature: 23 };
  const up = express();
  up.get('/climate/zone', (_req, res) => res.json(state));
  up.post('/climate/zone/set', (req, res) => {
    calls.push(req.query);
    if (typeof req.query.mode === 'string') state.mode = req.query.mode;
    res.json(state);
  });
  return up;
}

test('master flip forces a sourced member via its upstream source', async () => {
  const calls: Record<string, unknown>[] = [];
  const upstream = stubClimate('COOL', calls).listen(0);
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  const member = dev('alles-ac', 'g-src', undefined, `http://127.0.0.1:${port}/climate/zone`);
  const master = dev('office-ac', 'g-src', 'master');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount([], [master, member]));
  // learn the member's current mode (cool)
  const before = await (await get(base, 'alles-ac')).json();
  assert.equal(before.mode, 'cool');
  await post(base, 'office-ac', { mode: 'heat' });
  assert.ok(calls.some((c) => c.mode === 'FAN_ONLY'));
  const after = await (await get(base, 'alles-ac')).json();
  assert.equal(after.mode, 'fan');
  upstream.close();
  close();
});

test('sourced member conflict is rejected before touching upstream', async () => {
  const calls: Record<string, unknown>[] = [];
  const upstream = stubClimate('OFF', calls).listen(0);
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  const member = dev('alles-ac', 'g-src2', undefined, `http://127.0.0.1:${port}/climate/zone`);
  const master = dev('office-ac', 'g-src2', 'master');
  zonedService.validateDevices([master, member]);
  const { base, close } = await listen(mount([], [master, member]));
  await post(base, 'office-ac', { mode: 'cool' });
  const res = await post(base, 'alles-ac', { mode: 'heat' });
  assert.equal(res.status, 409);
  assert.equal(calls.length, 0);
  upstream.close();
  close();
});

test('validateDevices enforces group rules', () => {
  assert.deepEqual(
    zonedService.validateDevices([dev('a', 'gv', 'master'), dev('b', 'gv')]),
    [],
  );
  assert.ok(
    zonedService.validateDevices([dev('a', 'gv2'), dev('b', 'gv2')]).some((e) =>
      e.includes('no device declares'),
    ),
  );
  assert.ok(
    zonedService
      .validateDevices([dev('a', 'gv3', 'master'), dev('b', 'gv3', 'master')])
      .some((e) => e.includes('multiple masters')),
  );
  assert.ok(
    zonedService
      .validateDevices([{ ...dev('a', '', 'master'), zoneGroup: undefined }])
      .some((e) => e.includes('requires "zoneGroup"')),
  );
});
