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

/** Automatic dashboard features a dashboard may opt out of via `disabled`. */
export type DashboardFeature = 'messages' | 'intercom' | 'notifications';

export interface DashboardConfig {
  id: string;
  title: string;
  admin?: boolean;
  disabled?: DashboardFeature[];
  layout: { type: 'grid'; columns?: number };
  views: DashboardView[];
  overlays?: DashboardOverlay[];
  theme?: DashboardTheme;
}

export interface ServiceMeta {
  type: string;
  transport: 'poll' | 'push';
  dataType: string;
}

export interface NotificationAction {
  label: string;
  overlay?: string;
  endpoint?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
}

export interface AppNotification {
  id: string;
  ts: number;
  type: string;
  interactive: boolean;
  targets?: string[];
  device?: DeviceRef;
  title?: string;
  body?: string;
  actions?: NotificationAction[];
  ttlMs?: number;
}

export interface DeviceInfo {
  type: string;
  id: string;
  dataType: string;
  source?: string;
}

export interface DashboardInfo {
  id: string;
  title: string;
  admin: boolean;
  disabled?: DashboardFeature[];
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
  targets: string[];
  contentType: string;
  ts: number;
}

export type IntercomEvent =
  | ({ op: 'start' } & IntercomSession)
  | { op: 'stop'; sessionId: string; targets: string[] };

export interface MediaPlayerState {
  id: string;
  /** Liveness of the player's daemon link, not playback. */
  connected: boolean;
  /** Daemon has an authenticated Spotify Connect session. */
  loggedIn: boolean;
  /** This daemon is the active Spotify Connect device. */
  isActive: boolean;
  deviceName: string;
  playing: boolean;
  track: string;
  artist: string;
  album: string;
  /** Playlist/show the current track is playing from, when known. */
  contextName: string;
  albumArtUrl: string;
  volume: number;
  /** Position anchor in ms — interpolate with `speed`. */
  progressMs: number;
  /** Position advancement rate (0 paused, ~1 playing). */
  speed: number;
  durationMs: number;
  shuffle?: boolean;
  repeat?: 'off' | 'context' | 'track';
  updatedAt: string;
}
