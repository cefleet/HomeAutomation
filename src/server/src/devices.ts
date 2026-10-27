import { Router } from 'express';
import type { NotificationCenter } from './notifications.js';
import type { ServiceExtras, ServiceRegistry } from './registry.js';
import { accessControl, actingDashboard } from './middleware.js';
import { sseHeartbeat, sseInit } from './sse.js';
import type { DeviceConfig } from './types.js';

/** Whether a pushed payload may be delivered to a subscriber resolved to
 *  `dashboard`: payloads carrying a `targets` list go only to those
 *  dashboards; anything else broadcasts. */
export function targetsAllow(payload: unknown, dashboard: string): boolean {
  if (typeof payload !== 'object' || payload === null) return true;
  const targets = (payload as { targets?: unknown }).targets;
  return !Array.isArray(targets) || targets.includes(dashboard);
}

/**
 * Dynamic device router mounted at /api.
 * Resolves /api/{serviceType}/{deviceId}/... to the registered service's
 * per-device router, with 404s for unknown types/devices and access control.
 */
export function deviceRouter(
  devices: DeviceConfig[],
  registry: ServiceRegistry,
  notifications: NotificationCenter,
  extras: ServiceExtras,
): Router {
  // Resolved live so devices registered at runtime route without restart.
  const routers = new Map<string, Router>();
  const r = Router();

  r.use('/:serviceType/:deviceId', (req, res, next) => {
    const service = registry.get(req.params.serviceType);
    if (!service) {
      res.status(404).json({ error: `unknown service type "${req.params.serviceType}"` });
      return;
    }
    const device = devices.find(
      (d) => d.service === service.type && d.id === req.params.deviceId,
    );
    if (!device) {
      res.status(404).json({ error: `unknown device "${req.params.deviceId}" for service "${service.type}"` });
      return;
    }
    res.locals.device = device;

    if (req.path === '/events' && req.method === 'GET') {
      if (service.transport !== 'push') {
        res.status(404).json({ error: 'service does not support push transport' });
        return;
      }
      accessControl()(req, res, () => {
        const send = sseInit(res);
        const hb = sseHeartbeat(res);
        const dashboard = actingDashboard(req, res, extras.dashboards, extras.prod);
        const listener = (data: unknown) => {
          if (targetsAllow(data, dashboard)) send('update', data);
        };
        registry.emitterFor(service.type, device.id).on('update', listener);
        req.on('close', () => {
          clearInterval(hb);
          registry.emitterFor(service.type, device.id).off('update', listener);
        });
      });
      return;
    }

    accessControl()(req, res, () => {
      let deviceR = routers.get(device.id);
      if (!deviceR) {
        deviceR = service.createRoutes(
          registry.contextFor(device, (n) => notifications.emit(n), extras),
        );
        routers.set(device.id, deviceR);
      }
      deviceR(req, res, next);
    });
  });

  return r;
}
