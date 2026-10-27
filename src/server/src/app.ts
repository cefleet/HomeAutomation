import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import {
  checkDeviceRegistration,
  loadClients,
  loadDashboards,
  loadDevices,
  runValidateHooks,
  validateDevice,
} from './configLoader.js';
import { deviceRouter, targetsAllow } from './devices.js';
import { actingDashboard, clientResolution } from './middleware.js';
import { NotificationCenter } from './notifications.js';
import { ServiceRegistry } from './registry.js';
import { intercomService } from './services/intercom.js';
import { lightService } from './services/light.js';
import { messengerService } from './services/messenger.js';
import { thermostatService } from './services/thermostat.js';
import { weatherService } from './services/weather.js';
import { weatherGovService } from './services/weatherGov.js';
import { zonedService } from './services/zoned.js';
import { sseHeartbeat, sseInit } from './sse.js';
import type { DashboardFeature, DeviceConfig } from './types.js';

// TEMPORARY dev-only credentials — replace with real authentication.
const DEV_USERS: Record<string, { password: string; role: string; dashboard: string }> = {
  admin: { password: 'admin', role: 'admin', dashboard: 'admin' },
  user: { password: 'user', role: 'user', dashboard: 'master' },
};

const FILENAME_SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export interface AppOptions {
  configDir: string;
  clientDist?: string;
  /** Dev origin allowed via CORS; unset = no CORS (same-origin serving). */
  devOrigin?: string;
  /** Production mode: restrict dashboards to the client's mapped one
   *  (admin role excepted). */
  prod?: boolean;
  /** Dir for service-managed runtime state (e.g. message logs). */
  dataDir?: string;
}

export function createApp({ configDir, clientDist, devOrigin, prod = false, dataDir }: AppOptions): {
  app: Express;
  registry: ServiceRegistry;
  notifications: NotificationCenter;
} {
  const registry = new ServiceRegistry();
  registry.register(lightService);
  registry.register(intercomService);
  registry.register(messengerService);
  registry.register(thermostatService);
  registry.register(weatherService);
  registry.register(weatherGovService);
  registry.register(zonedService);

  const notifications = new NotificationCenter();
  notifications.registerType({ type: 'issue', interactive: false });
  notifications.registerType({ type: 'announcement', interactive: false });

  const devices = loadDevices(path.join(configDir, 'devices'), registry);
  const dashboards = loadDashboards(
    path.join(configDir, 'dashboards'),
    devices,
    registry.dataTypes(),
  );
  const clients = loadClients(path.join(configDir, 'clients.json'));
  // The admin dashboard always exists — an authored config may flag `admin`
  // and supply views; otherwise a default is synthesized.
  if (!dashboards.some((d) => d.admin))
    dashboards.push({
      id: 'admin',
      title: 'Admin',
      admin: true,
      layout: { type: 'grid' },
      views: [],
    });
  const dashboardIndex = new Map(dashboards.map((d) => [d.id, d]));
  // Dashboards accepting each disable-able feature, for target lists.
  const enabledFor = (f: DashboardFeature) =>
    dashboards.filter((d) => !(d.disabled ?? []).includes(f)).map((d) => d.id);
  const extras = {
    dashboards: dashboards.map((d) => d.id),
    featureTargets: {
      messages: enabledFor('messages'),
      intercom: enabledFor('intercom'),
      notifications: enabledFor('notifications'),
    },
    dataDir: dataDir ?? path.resolve(configDir, '..', 'data'),
    prod,
  };

  const app = express();
  app.disable('x-powered-by');
  if (devOrigin) app.use(cors({ origin: devOrigin }));
  app.use(express.json());
  app.use(clientResolution(clients));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // TEMPORARY dev login — validates the hardcoded users above.
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const u = typeof username === 'string' ? DEV_USERS[username] : undefined;
    if (!u || u.password !== password) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    res.json({ role: u.role, dashboard: u.dashboard });
  });

  app.get('/api/me', (_req, res) => {
    const { dashboard, role } = res.locals.client;
    res.json({ dashboard, role, admin: dashboardIndex.get(dashboard)?.admin ?? false });
  });

  app.get('/api/services', (_req, res) => res.json(registry.metadata()));

  const deviceSummary = (d: DeviceConfig) => ({
    type: d.service,
    id: d.id,
    dataType: registry.get(d.service)?.dataType ?? '',
    ...(d.source !== undefined ? { source: d.source } : {}),
  });

  app.get('/api/devices', (_req, res) => res.json(devices.map(deviceSummary)));

  /** Admin-only: validate a device config, persist it to config/devices, and
   *  register it live (no restart). */
  app.post('/api/devices', (req, res) => {
    if (!res.locals.roles.includes('admin')) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    let device: DeviceConfig;
    try {
      device = validateDevice(req.body, 'request body');
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!FILENAME_SAFE_ID.test(device.id)) {
      res.status(400).json({
        error: 'device id must be filename-safe (letters, digits, "-", "_")',
      });
      return;
    }
    const errors = checkDeviceRegistration(
      device,
      registry,
      new Set(devices.map((d) => d.id)),
      `device "${device.id}"`,
    );
    if (!errors.length) {
      errors.push(...runValidateHooks([...devices, device], registry));
      if (errors.length)
        // Restore hook-owned state (e.g. zone groups) from the unchanged set.
        runValidateHooks(devices, registry);
    }
    if (errors.length) {
      res.status(400).json({ error: errors.join('\n') });
      return;
    }
    const devicesDir = path.join(configDir, 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(devicesDir, `${device.id}.json`),
      JSON.stringify(device, null, 2) + '\n',
    );
    devices.push(device);
    res.status(201).json(deviceSummary(device));
  });

  app.get('/api/dashboards', (_req, res) =>
    res.json(
      dashboards.map(({ id, title, admin, disabled }) => ({
        id,
        title,
        admin: admin ?? false,
        disabled: disabled ?? [],
      })),
    ),
  );

  app.use(
    '/api/dashboards/assets',
    express.static(path.join(configDir, 'dashboards', 'assets'), {
      index: false,
      dotfiles: 'deny',
    }),
  );

  app.get('/api/dashboards/:id', (req, res) => {
    const dash = dashboardIndex.get(req.params.id);
    if (!dash) {
      res.status(404).json({ error: `unknown dashboard "${req.params.id}"` });
      return;
    }
    // prod: non-admin clients may only view their mapped dashboard.
    if (
      prod &&
      req.params.id !== res.locals.client.dashboard &&
      !res.locals.roles.includes('admin')
    ) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    res.json(dash);
  });

  app.get('/api/notifications/stream', (req, res) => {
    const send = sseInit(res);
    const hb = sseHeartbeat(res);
    const unsubscribe = notifications.subscribe(res.locals.client.dashboard, (n) =>
      send('notification', n),
    );
    req.on('close', () => {
      clearInterval(hb);
      unsubscribe();
    });
  });

  // Multiplexed event stream: one SSE connection per dashboard carrying all
  // device pushes + notifications — keeps pages under the browser's
  // per-origin connection limit.
  app.get('/api/stream', (req, res) => {
    const dashboard = actingDashboard(
      req,
      res,
      dashboards.map((d) => d.id),
      prod,
    );
    const send = sseInit(res);
    const hb = sseHeartbeat(res);
    const roles = res.locals.roles;
    const unsubscribers: (() => void)[] = [
      notifications.subscribe(dashboard, (n) =>
        send('update', { type: 'notification', data: n }),
      ),
    ];
    for (const d of devices) {
      const service = registry.get(d.service);
      if (service?.transport !== 'push') continue;
      const allowed = d.access?.read ?? [];
      if (!allowed.includes('*') && !roles.some((r) => allowed.includes(r))) continue;
      const emitter = registry.emitterFor(service.type, d.id);
      const listener = (data: unknown) => {
        if (targetsAllow(data, dashboard))
          send('update', {
            type: 'device',
            device: { type: service.type, id: d.id },
            data,
          });
      };
      emitter.on('update', listener);
      unsubscribers.push(() => emitter.off('update', listener));
    }
    req.on('close', () => {
      clearInterval(hb);
      unsubscribers.forEach((u) => u());
    });
  });

  app.use('/api', deviceRouter(devices, registry, notifications, extras));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  if (clientDist && fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return { app, registry, notifications };
}
