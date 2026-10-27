import fs from 'node:fs';
import path from 'node:path';
import type { ServiceRegistry } from './registry.js';
import type {
  ClientMappingEntry,
  DashboardConfig,
  DashboardView,
  DeviceConfig,
} from './types.js';

export class ConfigError extends Error {}

function jsonFiles(dir: string): { file: string; data: unknown }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      file: path.join(dir, f),
      data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
    }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateDevice(raw: unknown, file: string): DeviceConfig {
  if (!isRecord(raw)) throw new ConfigError(`${file}: config is not an object`);
  const d = raw as Record<string, unknown>;
  for (const field of ['id', 'service', 'description']) {
    if (typeof d[field] !== 'string' || !d[field])
      throw new ConfigError(`${file}: missing required field "${field}"`);
  }
  for (const field of ['source', 'sourceType', 'zoneGroup', 'apiKey', 'apiKeyIssued', 'deviceName', 'daemonBin', 'clientId', 'clientSecret']) {
    if (d[field] !== undefined && (typeof d[field] !== 'string' || !d[field]))
      throw new ConfigError(`${file}: "${field}" must be a non-empty string`);
  }
  if (d.sourceType !== undefined && d.source === undefined)
    throw new ConfigError(`${file}: "sourceType" requires "source"`);
  if (d.maxTempC !== undefined && (typeof d.maxTempC !== 'number' || !Number.isFinite(d.maxTempC)))
    throw new ConfigError(`${file}: "maxTempC" must be a number`);
  if (d.zoneRole !== undefined) {
    if (d.zoneRole !== 'master' && d.zoneRole !== 'member')
      throw new ConfigError(`${file}: "zoneRole" must be "master" or "member"`);
    if (d.zoneGroup === undefined)
      throw new ConfigError(`${file}: "zoneRole" requires "zoneGroup"`);
  }
  const access = d.access;
  if (
    !isRecord(access) ||
    !Array.isArray(access.read) ||
    !Array.isArray(access.write)
  )
    throw new ConfigError(`${file}: "access" must declare "read" and "write" role arrays`);
  return d as unknown as DeviceConfig;
}

/** Per-device registration checks shared by file loading and runtime adds. */
export function checkDeviceRegistration(
  device: DeviceConfig,
  registry: ServiceRegistry,
  existingIds: Set<string>,
  label: string,
): string[] {
  const service = registry.get(device.service);
  if (!service)
    return [`${label}: unregistered service type "${device.service}"`];
  const errors: string[] = [];
  const sourceMode = service.sourceMode ?? 'optional';
  if (sourceMode === 'required' && device.source === undefined)
    errors.push(`${label}: service "${device.service}" requires a "source"`);
  if (sourceMode === 'none' && device.source !== undefined)
    errors.push(`${label}: service "${device.service}" does not accept a "source"`);
  if (existingIds.has(device.id))
    errors.push(`${label}: duplicate device id "${device.id}"`);
  return errors;
}

/** Run every service's `validateDevices` hook against `devices`, returning
 *  the collected errors. */
export function runValidateHooks(
  devices: DeviceConfig[],
  registry: ServiceRegistry,
): string[] {
  const errors: string[] = [];
  for (const type of registry.types()) {
    const hook = registry.get(type)?.validateDevices;
    if (!hook) continue;
    try {
      errors.push(...hook(devices));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return errors;
}

export function loadDevices(dir: string, registry: ServiceRegistry): DeviceConfig[] {
  const errors: string[] = [];
  const devices: DeviceConfig[] = [];
  const seen = new Set<string>();
  for (const { file, data } of jsonFiles(dir)) {
    try {
      const device = validateDevice(data, file);
      const errs = checkDeviceRegistration(device, registry, seen, file);
      if (errs.length) {
        errors.push(...errs);
        continue;
      }
      seen.add(device.id);
      devices.push(device);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  errors.push(...runValidateHooks(devices, registry));
  if (errors.length) throw new ConfigError(errors.join('\n'));
  return devices;
}

function validateView(raw: unknown, file: string, ctx: string): DashboardView {
  if (!isRecord(raw)) throw new ConfigError(`${file}: ${ctx} view is not an object`);
  if (typeof raw.component !== 'string' || !raw.component)
    throw new ConfigError(`${file}: ${ctx} view missing "component"`);
  const device = raw.device;
  if (
    raw.component !== 'hr' &&
    (!isRecord(device) || typeof device.type !== 'string' || typeof device.id !== 'string')
  )
    throw new ConfigError(`${file}: ${ctx} view missing "device" {type,id}`);
  if (raw.params !== undefined) {
    if (!isRecord(raw.params))
      throw new ConfigError(`${file}: ${ctx} "params" must be an object of string/number values`);
    for (const v of Object.values(raw.params))
      if (typeof v !== 'string' && typeof v !== 'number')
        throw new ConfigError(`${file}: ${ctx} "params" values must be strings or numbers`);
  }
  if (raw.dataType !== undefined && typeof raw.dataType !== 'string')
    throw new ConfigError(`${file}: ${ctx} "dataType" must be a string`);
  return raw as unknown as DashboardView;
}

const DASHBOARD_FEATURES = new Set(['messages', 'intercom', 'notifications']);

const THEME_COLOR_KEYS = new Set([
  'background',
  'surface',
  'text',
  'muted',
  'accent',
  'border',
]);

function validateTheme(raw: unknown, file: string, assetsDir: string): void {
  if (!isRecord(raw)) throw new ConfigError(`${file}: "theme" must be an object`);
  if (raw.colorScheme !== undefined && raw.colorScheme !== 'light' && raw.colorScheme !== 'dark')
    throw new ConfigError(`${file}: theme "colorScheme" must be "light" or "dark"`);
  if (raw.colors !== undefined) {
    if (!isRecord(raw.colors))
      throw new ConfigError(`${file}: theme "colors" must be an object`);
    for (const [k, v] of Object.entries(raw.colors)) {
      if (!THEME_COLOR_KEYS.has(k))
        throw new ConfigError(`${file}: theme "colors" has unknown key "${k}"`);
      if (typeof v !== 'string' || !v)
        throw new ConfigError(`${file}: theme "colors.${k}" must be a non-empty string`);
    }
  }
  if (raw.background !== undefined) {
    if (!isRecord(raw.background))
      throw new ConfigError(`${file}: theme "background" must be an object`);
    const { image, size, position } = raw.background;
    if (typeof image !== 'string' || !image)
      throw new ConfigError(`${file}: theme "background.image" must be a non-empty string`);
    if (image.includes('/') || image.includes('\\') || image === '..' || image === '.')
      throw new ConfigError(
        `${file}: theme "background.image" must be a plain filename, got "${image}"`,
      );
    if (!fs.existsSync(path.join(assetsDir, image)))
      throw new ConfigError(`${file}: theme "background.image" not found in ${assetsDir}: ${image}`);
    for (const [k, v] of Object.entries({ size, position }))
      if (v !== undefined && typeof v !== 'string')
        throw new ConfigError(`${file}: theme "background.${k}" must be a string`);
  }
}

function validateDashboard(
  raw: unknown,
  file: string,
  deviceIndex: Map<string, DeviceConfig>,
  dataTypes: Map<string, string>,
  assetsDir: string,
): DashboardConfig {
  if (!isRecord(raw)) throw new ConfigError(`${file}: config is not an object`);
  for (const field of ['id', 'title']) {
    if (typeof raw[field] !== 'string' || !raw[field])
      throw new ConfigError(`${file}: missing required field "${field}"`);
  }
  const layout = raw.layout;
  if (!isRecord(layout) || layout.type !== 'grid')
    throw new ConfigError(`${file}: "layout" must be {type:"grid"} (columns optional)`);
  if (raw.admin !== undefined && typeof raw.admin !== 'boolean')
    throw new ConfigError(`${file}: "admin" must be a boolean`);
  if (raw.disabled !== undefined) {
    if (!Array.isArray(raw.disabled))
      throw new ConfigError(`${file}: "disabled" must be an array of feature names`);
    for (const f of raw.disabled)
      if (!DASHBOARD_FEATURES.has(f as string))
        throw new ConfigError(`${file}: unknown disabled feature "${String(f)}"`);
  }
  if (!Array.isArray(raw.views))
    throw new ConfigError(`${file}: "views" must be an array`);

  const overlays = Array.isArray(raw.overlays) ? raw.overlays : [];
  const overlayIds = new Set<string>();
  for (const [i, o] of overlays.entries()) {
    if (!isRecord(o) || typeof o.id !== 'string' || !Array.isArray(o.views))
      throw new ConfigError(`${file}: overlays[${i}] must declare "id" and "views"`);
    overlayIds.add(o.id);
    o.views.forEach((v, j) => validateView(v, file, `overlay "${o.id}" view ${j}`));
  }

  const views = raw.views.map((v, i) => validateView(v, file, `view ${i}`));
  const all = [
    ...views.map((v, i) => ({ view: v, ctx: `view ${i}` })),
    ...overlays.flatMap((o: { id: string; views: unknown[] }) =>
      o.views.map((v, j) => ({
        view: validateView(v, file, `overlay "${o.id}" view ${j}`),
        ctx: `overlay "${o.id}" view ${j}`,
      })),
    ),
  ];
  for (const { view, ctx } of all) {
    if (!view.device) continue;
    const dev = deviceIndex.get(`${view.device.type}/${view.device.id}`);
    if (!dev) throw new ConfigError(`${file}: ${ctx} references unknown device ${view.device.type}/${view.device.id}`);
    const serviceDataType = dataTypes.get(view.device.type);
    if (view.dataType && serviceDataType && view.dataType !== serviceDataType)
      throw new ConfigError(
        `${file}: ${ctx} declares dataType "${view.dataType}" but device ${view.device.type}/${view.device.id} provides "${serviceDataType}"`,
      );
  }
  for (const { view, ctx } of views.map((v, i) => ({ view: v, ctx: `view ${i}` }))) {
    const target = view.onTap?.overlay;
    if (target && !overlayIds.has(target))
      throw new ConfigError(`${file}: ${ctx} onTap references unknown overlay "${target}"`);
  }
  if (raw.theme !== undefined) validateTheme(raw.theme, file, assetsDir);
  return raw as unknown as DashboardConfig;
}

export function loadDashboards(
  dir: string,
  devices: DeviceConfig[],
  dataTypes: Map<string, string>,
): DashboardConfig[] {
  const deviceIndex = new Map(devices.map((d) => [`${d.service}/${d.id}`, d]));
  const assetsDir = path.join(dir, 'assets');
  const errors: string[] = [];
  const dashboards: DashboardConfig[] = [];
  const seen = new Set<string>();
  for (const { file, data } of jsonFiles(dir)) {
    try {
      const dash = validateDashboard(data, file, deviceIndex, dataTypes, assetsDir);
      if (seen.has(dash.id))
        throw new ConfigError(`${file}: duplicate dashboard id "${dash.id}"`);
      seen.add(dash.id);
      dashboards.push(dash);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length) throw new ConfigError(errors.join('\n'));
  if (!seen.has('master'))
    throw new ConfigError(`${dir}: a "master" dashboard config is required`);
  return dashboards;
}

export function loadClients(file: string): ClientMappingEntry[] {
  if (!fs.existsSync(file)) return [];
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new ConfigError(`${file}: must be an array`);
  for (const [i, e] of data.entries()) {
    if (!isRecord(e) || typeof e.dashboard !== 'string' || typeof e.role !== 'string')
      throw new ConfigError(`${file}: entry ${i} requires "dashboard" and "role"`);
    if (typeof e.ip !== 'string' && typeof e.mac !== 'string')
      throw new ConfigError(`${file}: entry ${i} requires "ip" and/or "mac"`);
  }
  return data as ClientMappingEntry[];
}
