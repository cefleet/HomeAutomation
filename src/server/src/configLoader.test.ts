import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Router } from 'express';
import { loadDashboards, loadDevices } from './configLoader.js';
import { ServiceRegistry } from './registry.js';
import type { Service } from './registry.js';
import type { DeviceConfig, SourceMode } from './types.js';

function registryWith(sourceMode?: SourceMode): ServiceRegistry {
  const registry = new ServiceRegistry();
  const svc: Service = {
    type: 'test-svc',
    transport: 'poll',
    dataType: 'test',
    sourceMode,
    createRoutes: () => Router(),
  };
  registry.register(svc);
  return registry;
}

function writeDevice(dir: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(dir, 'dev.json'),
    JSON.stringify({
      id: 'dev',
      service: 'test-svc',
      description: 'test device',
      access: { read: ['*'], write: ['*'] },
      ...extra,
    }),
  );
}

function load(sourceMode: SourceMode | undefined, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
  writeDevice(dir, extra);
  return () => loadDevices(dir, registryWith(sourceMode));
}

test('required sourceMode rejects a config without source', () => {
  assert.throws(load('required'), /requires a "source"/);
});

test('required sourceMode accepts a config with source', () => {
  assert.deepEqual(load('required', { source: 'http://192.168.1.42', sourceType: 'esphome' })().length, 1);
});

test('none sourceMode rejects a config with source', () => {
  assert.throws(load('none', { source: 'http://192.168.1.42' }), /does not accept a "source"/);
});

test('optional sourceMode accepts a config either way', () => {
  assert.equal(load('optional', { source: 'x' })().length, 1);
  assert.equal(load('optional')().length, 1);
});

test('undeclared sourceMode defaults to optional', () => {
  assert.equal(load(undefined, { source: 'x' })().length, 1);
});

test('sourceType without source is rejected', () => {
  assert.throws(load('optional', { sourceType: 'esphome' }), /"sourceType" requires "source"/);
});

test('zoneRole without zoneGroup is rejected', () => {
  assert.throws(
    load('none', { zoneRole: 'master' }),
    /"zoneRole" requires "zoneGroup"/,
  );
});

test('invalid zoneRole value is rejected', () => {
  assert.throws(
    load('none', { zoneGroup: 'g', zoneRole: 'boss' }),
    /"zoneRole" must be "master" or "member"/,
  );
});

test('service validateDevices hook errors fail the load', () => {
  const registry = new ServiceRegistry();
  const svc: Service = {
    type: 'test-svc',
    transport: 'poll',
    dataType: 'test',
    createRoutes: () => Router(),
    validateDevices: (devices) =>
      devices.some((d) => d.zoneGroup === 'bad') ? ['group "bad" is not allowed'] : [],
  };
  registry.register(svc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
  writeDevice(dir, { zoneGroup: 'bad' });
  assert.throws(() => loadDevices(dir, registry), /group "bad" is not allowed/);
});

test('config loads without identifier', () => {
  assert.equal(load('none')().length, 1);
});

// --- dashboard theme validation -----------------------------------------

const DEVICES: DeviceConfig[] = [
  {
    id: 'dev',
    service: 'test-svc',
    description: 'test',
    access: { read: ['*'], write: ['*'] },
  },
];
const DATA_TYPES = new Map([['test-svc', 'test']]);
const MASTER = { id: 'master', title: 'M', layout: { type: 'grid' }, views: [] };

function loadDash(dash: Record<string, unknown>, assets: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  if (assets.length) {
    fs.mkdirSync(path.join(dir, 'assets'));
    for (const a of assets) fs.writeFileSync(path.join(dir, 'assets', a), 'x');
  }
  fs.writeFileSync(path.join(dir, 'master.json'), JSON.stringify(MASTER));
  fs.writeFileSync(path.join(dir, 'dash.json'), JSON.stringify(dash));
  return () => loadDashboards(dir, DEVICES, DATA_TYPES);
}

const DASH = { id: 'd', title: 'D', layout: { type: 'grid' }, views: [] };

test('valid theme is accepted', () => {
  const theme = {
    colorScheme: 'light',
    colors: { background: '#d7e4f0', surface: '#fff' },
    background: { image: 'bg.jpg', position: 'center' },
  };
  assert.equal(loadDash({ ...DASH, theme }, ['bg.jpg'])().length, 2);
});

test('theme with unknown color key is rejected', () => {
  assert.throws(
    loadDash({ ...DASH, theme: { colors: { purply: '#fff' } } }),
    /unknown key "purply"/,
  );
});

test('theme with bad colorScheme is rejected', () => {
  assert.throws(
    loadDash({ ...DASH, theme: { colorScheme: 'auto' } }),
    /"colorScheme" must be "light" or "dark"/,
  );
});

test('theme referencing a missing asset is rejected', () => {
  assert.throws(
    loadDash({ ...DASH, theme: { background: { image: 'nope.jpg' } } }),
    /not found.*nope\.jpg/,
  );
});

test('theme with unsafe image filename is rejected', () => {
  assert.throws(
    loadDash({ ...DASH, theme: { background: { image: '../secret.png' } } }),
    /plain filename/,
  );
});

test('hr views need no device binding', () => {
  assert.equal(loadDash({ ...DASH, views: [{ component: 'hr' }] })().length, 2);
});

test('non-hr views without a device are rejected', () => {
  assert.throws(
    loadDash({ ...DASH, views: [{ component: 'light-card' }] }),
    /missing "device"/,
  );
});

test('disabled accepts known feature names', () => {
  assert.equal(
    loadDash({ ...DASH, disabled: ['messages', 'intercom'] })().length,
    2,
  );
});

test('non-array disabled flag is rejected', () => {
  assert.throws(
    loadDash({ ...DASH, disabled: 'messages' }),
    /"disabled" must be an array/,
  );
});

test('unknown disabled feature is rejected', () => {
  assert.throws(
    loadDash({ ...DASH, disabled: ['espionage'] }),
    /unknown disabled feature/,
  );
});
