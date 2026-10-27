import { EventEmitter } from 'node:events';
import type { Router } from 'express';
import type {
  DashboardFeature,
  DeviceConfig,
  NotificationInput,
  SourceMode,
  Transport,
} from './types.js';

export interface ServiceContext {
  device: DeviceConfig;
  /** Deliver a device state update to /events subscribers (push services). */
  push: (data: unknown) => void;
  /** Emit a notification to dashboard(s). */
  notify: (n: NotificationInput) => void;
  /** Ids of configured dashboards (for services that target dashboards). */
  dashboards: string[];
  /** Dashboards this service may target — defaults to `dashboards`; services
   *  declaring `targetFeature` only see dashboards that have that feature
   *  enabled. */
  targets: string[];
  /** Directory for service-managed runtime state (e.g. message logs). */
  dataDir: string;
  /** Production mode: dashboard overrides are restricted to the resolved
   *  dashboard or admin callers. */
  prod: boolean;
}

export interface ServiceExtras {
  dashboards: string[];
  /** Dashboards accepting each disable-able feature, for target lists. */
  featureTargets?: Partial<Record<DashboardFeature, string[]>>;
  dataDir: string;
  prod: boolean;
}

export interface Service {
  type: string;
  transport: Transport;
  /** Data contract this service's device data conforms to (e.g. "weather",
   *  "light"). Clients bind to the contract, not the service type. */
  dataType: string;
  /** Whether device configs for this service must declare a `source`.
   *  Defaults to `optional` when undeclared. */
  sourceMode?: SourceMode;
  /** Optional hook run after per-file validation for rules needing the
   *  full device set (e.g. group consistency). Returned strings become
   *  config errors. */
  validateDevices?: (devices: DeviceConfig[]) => string[];
  /** Dashboard feature governing this service's target list (e.g. messenger
   *  → "messages"). Dashboards disabling it are excluded from `ctx.targets`. */
  targetFeature?: DashboardFeature;
  /** When true, the device router instantiates this service's routes at
   *  startup for every configured device rather than lazily on first
   *  request — for services that own a long-lived resource (e.g. a
   *  supervised daemon process or socket) that must run regardless of
   *  incoming traffic. */
  eager?: boolean;
  createRoutes: (ctx: ServiceContext) => Router;
}

export class ServiceRegistry {
  private services = new Map<string, Service>();
  private deviceEvents = new Map<string, EventEmitter>();

  register(service: Service): void {
    if (this.services.has(service.type))
      throw new Error(`service type "${service.type}" already registered`);
    this.services.set(service.type, service);
  }

  get(type: string): Service | undefined {
    return this.services.get(type);
  }

  types(): Set<string> {
    return new Set(this.services.keys());
  }

  metadata(): { type: string; transport: Transport; dataType: string }[] {
    return [...this.services.values()].map((s) => ({
      type: s.type,
      transport: s.transport,
      dataType: s.dataType,
    }));
  }

  dataTypes(): Map<string, string> {
    return new Map([...this.services.values()].map((s) => [s.type, s.dataType]));
  }

  emitterFor(type: string, id: string): EventEmitter {
    const key = `${type}/${id}`;
    let em = this.deviceEvents.get(key);
    if (!em) {
      em = new EventEmitter();
      em.setMaxListeners(0);
      this.deviceEvents.set(key, em);
    }
    return em;
  }

  contextFor(
    device: DeviceConfig,
    notify: (n: NotificationInput) => void,
    extras: ServiceExtras,
  ): ServiceContext {
    const feature = this.services.get(device.service)?.targetFeature;
    return {
      device,
      push: (data) => this.emitterFor(device.service, device.id).emit('update', data),
      notify,
      dashboards: extras.dashboards,
      targets: feature
        ? (extras.featureTargets?.[feature] ?? extras.dashboards)
        : extras.dashboards,
      dataDir: extras.dataDir,
      prod: extras.prod,
    };
  }
}
