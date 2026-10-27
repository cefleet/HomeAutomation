export type Transport = 'poll' | 'push';
export type Operation = 'read' | 'write';
/** Whether a service's device configs must (`required`), may
 *  (`optional`), or must not (`none`) declare a `source`. */
export type SourceMode = 'none' | 'optional' | 'required';

export interface DeviceConfig {
  id: string;
  service: string;
  /** Address/endpoint the service reaches for data or control (e.g. a
   *  LAN IP); interpreted with `sourceType` by the service. */
  source?: string;
  /** Kind of source (e.g. `esphome`); requires `source` when present. */
  sourceType?: string;
  /** Zone group this device belongs to (zoned climate services); a
   *  group's devices share a master that rules allowed modes. */
  zoneGroup?: string;
  /** Role within `zoneGroup`; defaults to `member` when absent. */
  zoneRole?: 'master' | 'member';
  /** Highest accepted setpoint in °C (heater devices); overrides any
   *  source-reported max. */
  maxTempC?: number;
  /** Soloist API key (spotify devices without `source` — the service
   *  spawns and supervises the daemon itself). */
  apiKey?: string;
  /** ISO date the Soloist API key was issued (spotify devices) — keys
   *  live ~180 days; the service warns ahead of expiry. */
  apiKeyIssued?: string;
  /** Spotify Connect device name a managed Soloist daemon advertises
   *  (spotify devices); defaults to the device id. */
  deviceName?: string;
  /** Path/name of the daemon binary a managed service spawns (spotify
   *  devices); defaults to `soloist` on PATH. */
  daemonBin?: string;
  /** Spotify for Developers app credentials (spotify devices) enabling
   *  the `/search` endpoint — catalog metadata only; playback still goes
   *  through the daemon. Both or neither. */
  clientId?: string;
  clientSecret?: string;
  description: string;
  access: { read: string[]; write: string[] };
}

export interface DeviceRef {
  type: string;
  id: string;
}

export interface DashboardView {
  component: string;
  /** Bound device — absent for non-device views such as `hr` breaks. */
  device?: DeviceRef;
  props?: Record<string, unknown>;
  params?: Record<string, string | number>;
  /** Optional pin: the data contract the component needs; loader validates
   *  it against the bound device's service dataType. */
  dataType?: string;
  onTap?: { overlay?: string };
}

export interface DashboardOverlay {
  id: string;
  title?: string;
  views: DashboardView[];
}

export interface DashboardTheme {
  colorScheme?: 'light' | 'dark';
  colors?: Partial<
    Record<'background' | 'surface' | 'text' | 'muted' | 'accent' | 'border', string>
  >;
  background?: { image: string; size?: string; position?: string };
}

/** Automatic dashboard features that a dashboard may opt out of via its
 *  `disabled` list. */
export type DashboardFeature = 'messages' | 'intercom' | 'notifications';

export interface DashboardConfig {
  id: string;
  title: string;
  admin?: boolean;
  /** Automatic features disabled on this dashboard (e.g. "messages"). */
  disabled?: DashboardFeature[];
  layout: { type: 'grid'; columns?: number };
  views: DashboardView[];
  overlays?: DashboardOverlay[];
  theme?: DashboardTheme;
}

export interface ClientMappingEntry {
  ip?: string;
  mac?: string;
  dashboard: string;
  role: string;
}

export interface ClientIdentity {
  ip: string;
  mac?: string;
  dashboard: string;
  role: string;
}

export interface NotificationAction {
  label: string;
  overlay?: string;
  endpoint?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
}

export interface NotificationTypeDef {
  type: string;
  interactive?: boolean;
  canOpenOverlay?: boolean;
}

export interface NotificationInput {
  type: string;
  targets?: string[];
  device?: DeviceRef;
  title?: string;
  body?: string;
  actions?: NotificationAction[];
  ttlMs?: number;
}

export interface Notification extends NotificationInput {
  id: string;
  ts: number;
  interactive: boolean;
}

export interface MessageReply {
  id: string;
  from: string;
  ts: number;
  body: string;
}

export interface MessageThread {
  id: string;
  from: string;
  /** Dashboards this thread is delivered to (includes `from`). */
  targets: string[];
  ts: number;
  body: string;
  replies: MessageReply[];
  /** Dashboards that have seen the thread's latest activity. */
  seenBy: string[];
  /** Dashboards that have hidden the thread; cleared on a new reply. */
  hiddenBy: string[];
}

export interface IntercomSession {
  id: string;
  from: string;
  /** Dashboards this broadcast is delivered to. */
  targets: string[];
  /** Audio MIME type the sender produces; echoed to stream listeners. */
  contentType: string;
  ts: number;
}

export type IntercomEvent =
  | ({ op: 'start' } & IntercomSession)
  | { op: 'stop'; sessionId: string; targets: string[] };
