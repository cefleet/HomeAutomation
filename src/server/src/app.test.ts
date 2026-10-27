import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Express } from 'express';
import { createApp } from './app.js';

/** Build an app against a temp config dir with one light device and the
 *  required master dashboard (plus any extra dashboards given). Returns
 *  base URL + close. */
async function listen(
  extraDashboards: Record<string, unknown>[] = [],
  extraDevices: Record<string, unknown>[] = [],
): Promise<{
  base: string;
  close: () => void;
  configDir: string;
}> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-test-'));
  fs.mkdirSync(path.join(configDir, 'devices'));
  fs.mkdirSync(path.join(configDir, 'dashboards'));
  fs.writeFileSync(
    path.join(configDir, 'devices', 'lamp.json'),
    JSON.stringify({
      id: 'lamp',
      service: 'light',
      description: 'test lamp',
      access: { read: ['*'], write: ['*'] },
    }),
  );
  fs.writeFileSync(
    path.join(configDir, 'dashboards', 'master.json'),
    JSON.stringify({ id: 'master', title: 'M', layout: { type: 'grid' }, views: [] }),
  );
  for (const d of extraDashboards)
    fs.writeFileSync(
      path.join(configDir, 'dashboards', `${d.id}.json`),
      JSON.stringify(d),
    );
  for (const d of extraDevices)
    fs.writeFileSync(
      path.join(configDir, 'devices', `${d.id}.json`),
      JSON.stringify(d),
    );
  const { app } = createApp({ configDir });
  const server = (app as Express).listen(0);
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
    configDir,
  };
}

const post = (base: string, p: string, body: unknown, roles?: string) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(roles ? { 'x-automation-roles': roles } : {}),
    },
    body: JSON.stringify(body),
  });

test('POST /api/login returns role and dashboard for dev users', async () => {
  const { base, close } = await listen();
  const admin = await (await post(base, '/api/login', { username: 'admin', password: 'admin' })).json();
  assert.deepEqual(admin, { role: 'admin', dashboard: 'admin' });
  const user = await (await post(base, '/api/login', { username: 'user', password: 'user' })).json();
  assert.deepEqual(user, { role: 'user', dashboard: 'master' });
  close();
});

test('POST /api/login rejects bad credentials with 401', async () => {
  const { base, close } = await listen();
  assert.equal(
    (await post(base, '/api/login', { username: 'admin', password: 'wrong' })).status,
    401,
  );
  assert.equal(
    (await post(base, '/api/login', { username: 'nope', password: 'nope' })).status,
    401,
  );
  close();
});

test('POST /api/devices requires the admin role', async () => {
  const { base, close, configDir } = await listen();
  const device = {
    id: 'new-lamp',
    service: 'light',
    description: 'new lamp',
    access: { read: ['*'], write: ['*'] },
  };
  assert.equal((await post(base, '/api/devices', device)).status, 403);
  assert.equal((await post(base, '/api/devices', device, 'user')).status, 403);
  assert.ok(!fs.existsSync(path.join(configDir, 'devices', 'new-lamp.json')));
  close();
});

test('POST /api/devices rejects invalid configs with 400', async () => {
  const { base, close } = await listen();
  const missing = await post(base, '/api/devices', { id: 'x' }, 'admin');
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /missing required field/);
  const unregistered = await post(
    base,
    '/api/devices',
    { id: 'x', service: 'nope', description: 'x', access: { read: ['*'], write: ['*'] } },
    'admin',
  );
  assert.equal(unregistered.status, 400);
  assert.match((await unregistered.json()).error, /unregistered service type/);
  const unsafe = await post(
    base,
    '/api/devices',
    { id: '../evil', service: 'light', description: 'x', access: { read: ['*'], write: ['*'] } },
    'admin',
  );
  assert.equal(unsafe.status, 400);
  assert.match((await unsafe.json()).error, /filename-safe/);
  close();
});

test('POST /api/devices rejects a duplicate id', async () => {
  const { base, close } = await listen();
  const res = await post(
    base,
    '/api/devices',
    { id: 'lamp', service: 'light', description: 'dup', access: { read: ['*'], write: ['*'] } },
    'admin',
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /duplicate device id/);
  close();
});

test('admin dashboard is served even without an admin.json config', async () => {
  const { base, close } = await listen();
  const res = await fetch(`${base}/api/dashboards/admin`);
  assert.equal(res.status, 200);
  const dash = await res.json();
  assert.equal(dash.admin, true);
  close();
});

test('dashboard disabled features list and carry through the API', async () => {
  const { base, close } = await listen([
    {
      id: 'quiet',
      title: 'Q',
      disabled: ['messages'],
      layout: { type: 'grid' },
      views: [],
    },
  ]);
  const list = await (await fetch(`${base}/api/dashboards`)).json();
  assert.ok(list.some((d: { id: string }) => d.id === 'quiet'));
  const dash = await (await fetch(`${base}/api/dashboards/quiet`)).json();
  assert.deepEqual(dash.disabled, ['messages']);
  close();
});

test('dashboards disabling messages are rejected as send targets', async () => {
  const { base, close } = await listen(
    [
      {
        id: 'quiet',
        title: 'Q',
        disabled: ['messages'],
        layout: { type: 'grid' },
        views: [],
      },
    ],
    [
      {
        id: 'messenger',
        service: 'messenger',
        description: 'm',
        access: { read: ['*'], write: ['*'] },
      },
    ],
  );
  assert.equal(
    (
      await post(
        base,
        '/api/messenger/messenger/send?dashboard=master',
        { body: 'hi', targets: ['quiet'] },
        'admin',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await post(
        base,
        '/api/messenger/messenger/send?dashboard=master',
        { body: 'hi', targets: ['master'] },
        'admin',
      )
    ).status,
    200,
  );
  close();
});

test('POST /api/devices persists and registers the device live', async () => {
  const { base, close, configDir } = await listen();
  const res = await post(
    base,
    '/api/devices',
    {
      id: 'new-lamp',
      service: 'light',
      description: 'new lamp',
      access: { read: ['*'], write: ['*'] },
    },
    'admin',
  );
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { type: 'light', id: 'new-lamp', dataType: 'light' });
  assert.ok(fs.existsSync(path.join(configDir, 'devices', 'new-lamp.json')));
  const list = await (await fetch(`${base}/api/devices`)).json();
  assert.ok(list.some((d: { id: string }) => d.id === 'new-lamp'));
  assert.equal((await fetch(`${base}/api/light/new-lamp/state`)).status, 200);
  close();
});
