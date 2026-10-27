import fs from 'node:fs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type {
  ClientIdentity,
  ClientMappingEntry,
  DeviceConfig,
  Operation,
} from './types.js';

declare module 'express-serve-static-core' {
  interface Locals {
    client: ClientIdentity;
    roles: string[];
    device: DeviceConfig;
  }
}

function normalizeIp(ip: string | undefined): string {
  return (ip ?? '').replace(/^::ffff:/, '');
}

/** Best-effort IP -> MAC via the kernel ARP table (same-subnet only). */
function arpTable(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const table = fs.readFileSync('/proc/net/arp', 'utf8');
    for (const line of table.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 4 && cols[3] !== '00:00:00:00:00:00')
        map.set(cols[0], cols[3].toLowerCase());
    }
  } catch {
    /* non-linux or unreadable ARP table: MAC resolution unavailable */
  }
  return map;
}

export function clientResolution(
  entries: ClientMappingEntry[],
  defaultDashboard = 'master',
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = normalizeIp(req.ip);
    const mac = arpTable().get(ip);
    const entry = entries.find(
      (e) =>
        (e.ip && normalizeIp(e.ip) === ip) ||
        (e.mac && mac && e.mac.toLowerCase() === mac),
    );
    const rolesHeader = req.get('x-automation-roles');
    const role = entry?.role ?? 'user';
    res.locals.client = {
      ip,
      mac,
      dashboard: entry?.dashboard ?? defaultDashboard,
      role,
    };
    res.locals.roles = rolesHeader
      ? rolesHeader.split(',').map((r) => r.trim()).filter(Boolean)
      : [role];
    next();
  };
}

/** The dashboard a request acts as: a `?dashboard=<id>` override when
 *  permitted — always in non-prod; in prod only when it equals the resolved
 *  dashboard or the caller has the `admin` role — else the client's resolved
 *  dashboard. */
export function actingDashboard(
  req: Request,
  res: Response,
  configured: string[],
  prod: boolean,
): string {
  const q = req.query.dashboard;
  if (
    typeof q === 'string' &&
    configured.includes(q) &&
    (!prod || q === res.locals.client.dashboard || res.locals.roles.includes('admin'))
  ) {
    return q;
  }
  return res.locals.client.dashboard;
}

export function accessControl(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const device = res.locals.device;
    const op: Operation =
      req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
    const allowed = device.access?.[op] ?? [];
    const roles = res.locals.roles ?? [];
    if (allowed.includes('*') || roles.some((r) => allowed.includes(r))) {
      next();
      return;
    }
    res.status(403).json({ error: 'forbidden', required: op });
  };
}
