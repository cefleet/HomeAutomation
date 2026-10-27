import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostRaw, apiSend, apiUrl } from '../api';
import type {
  AppNotification,
  DashboardInfo,
  DeviceInfo,
  DeviceRef,
  IntercomEvent,
  IntercomSession,
  MessageThread,
  ServiceMeta,
} from '../types';

/** Service metadata (type -> transport) fetched once. */
export function useServiceMeta(): Record<string, ServiceMeta['transport']> | null {
  const [meta, setMeta] = useState<Record<string, ServiceMeta['transport']> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet<ServiceMeta[]>('/api/services')
        .then((list) => {
          if (alive) setMeta(Object.fromEntries(list.map((s) => [s.type, s.transport])));
        })
        .catch(() => {
          if (alive) setTimeout(load, 5000);
        });
    load();
    return () => {
      alive = false;
    };
  }, []);
  return meta;
}

function queryString(params?: Record<string, string | number>): string {
  if (!params || !Object.keys(params).length) return '';
  return '?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString();
}

type StreamEvent =
  | { type: 'device'; device: DeviceRef; data: unknown }
  | { type: 'notification'; data: AppNotification };

const dashboardStreams = new Map<
  string,
  { es: EventSource; handlers: Set<(e: StreamEvent) => void>; opens: Set<() => void> }
>();

/** Shared per-dashboard event stream: one SSE connection carrying every
 *  device push + notification (keeps a page under the browser's
 *  per-origin connection limit). Refcounted — closes with the last
 *  subscriber; `onOpen` fires on (re)connect. */
function subscribeStream(
  dashboard: string,
  handler: (e: StreamEvent) => void,
  onOpen?: () => void,
): () => void {
  let s = dashboardStreams.get(dashboard);
  if (!s) {
    const es = new EventSource(
      apiUrl(`/api/stream?dashboard=${encodeURIComponent(dashboard)}`),
    );
    s = { es, handlers: new Set(), opens: new Set() };
    es.addEventListener('update', (ev) => {
      const parsed = JSON.parse(ev.data) as StreamEvent;
      s!.handlers.forEach((h) => h(parsed));
    });
    es.addEventListener('open', () => s!.opens.forEach((cb) => cb()));
    dashboardStreams.set(dashboard, s);
  }
  s.handlers.add(handler);
  if (onOpen) s.opens.add(onOpen);
  return () => {
    s.handlers.delete(handler);
    if (onOpen) s.opens.delete(onOpen);
    if (!s.handlers.size) {
      s.es.close();
      dashboardStreams.delete(dashboard);
    }
  };
}

/** Fetch device state, polling or stream-subscribing per the service
 *  transport. View `params` are appended as query parameters. */
export function useDeviceData(
  device: DeviceRef,
  transport: 'poll' | 'push' | undefined,
  params?: Record<string, string | number>,
  pollMs = 5000,
  dashboard?: string,
): unknown {
  const [data, setData] = useState<unknown>(null);
  const qs = queryString(params);
  useEffect(() => {
    if (!transport) return;
    const statePath = `/api/${device.type}/${device.id}/state${qs}`;
    if (transport === 'push') {
      // (Re)fetch state whenever the stream (re)connects so a missed or
      // failed initial fetch heals itself.
      const load = () => apiGet(statePath).then(setData).catch(() => {});
      load();
      if (!dashboard) return;
      return subscribeStream(
        dashboard,
        (e) => {
          if (e.type === 'device' && e.device.type === device.type && e.device.id === device.id)
            setData(e.data);
        },
        load,
      );
    }
    let alive = true;
    const load = () => apiGet(statePath).then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [device.type, device.id, transport, qs, pollMs, dashboard]);
  return data;
}

/** Live notification feed for the viewed dashboard. */
export function useNotifications(dashboard: string | undefined): {
  items: AppNotification[];
  dismiss: (id: string) => void;
} {
  const [items, setItems] = useState<AppNotification[]>([]);
  useEffect(() => {
    if (!dashboard) return;
    return subscribeStream(dashboard, (e) => {
      if (e.type !== 'notification') return;
      const n = e.data;
      setItems((prev) => [...prev, n]);
      if (n.ttlMs) {
        setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== n.id)), n.ttlMs);
      }
    });
  }, [dashboard]);
  const dismiss = (id: string) => setItems((prev) => prev.filter((n) => n.id !== id));
  return { items, dismiss };
}

/** Configured dashboards (for message target selection). */
export function useDashboards(): DashboardInfo[] | null {
  const [list, setList] = useState<DashboardInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<DashboardInfo[]>('/api/dashboards')
      .then((d) => alive && setList(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

/** The device providing a data contract, discovered via /api/devices. */
function useContractDevice(dataType: string): DeviceRef | null {
  const [device, setDevice] = useState<DeviceRef | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<DeviceInfo[]>('/api/devices')
      .then((list) => {
        const d = list.find((x) => x.dataType === dataType);
        if (alive && d) setDevice({ type: d.type, id: d.id });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dataType]);
  return device;
}

/** The device providing the `messaging` contract. */
export const useMessagingDevice = () => useContractDevice('messaging');

/** The device providing the `intercom` contract. */
export const useIntercomDevice = () => useContractDevice('intercom');

function threadUnread(t: MessageThread, dashboard: string): boolean {
  return (
    (t.from === dashboard || t.targets.includes(dashboard)) &&
    !t.seenBy.includes(dashboard)
  );
}

/** Live messaging state for a viewed dashboard: threads (fetched + kept
 *  current over the device's push stream), the unread count, "incoming"
 *  elements for every unread thread, and send/reply/seen actions against
 *  the messaging device. All calls carry `?dashboard=` so the server treats
 *  the viewed dashboard as the acting identity. */
export function useMessaging(
  device: DeviceRef | null,
  dashboard: string | undefined,
): {
  threads: MessageThread[];
  unread: number;
  incoming: MessageThread[];
  send: (body: string, targets: string[]) => Promise<void>;
  reply: (threadId: string, body: string) => Promise<void>;
  markSeen: (threadId: string) => Promise<void>;
  hide: (threadId: string) => Promise<void>;
} {
  const [threads, setThreads] = useState<MessageThread[]>([]);
  const qs = dashboard ? `?dashboard=${encodeURIComponent(dashboard)}` : '';
  const base = device ? `/api/${device.type}/${device.id}` : '';

  const upsert = (t: MessageThread) =>
    setThreads((prev) => {
      const i = prev.findIndex((x) => x.id === t.id);
      if (i === -1) return [...prev, t];
      const next = [...prev];
      next[i] = t;
      return next;
    });

  useEffect(() => {
    if (!device || !dashboard) return;
    let alive = true;
    apiGet<{ threads: MessageThread[] }>(`${base}/state${qs}`)
      .then((s) => {
        if (alive) setThreads(s.threads);
      })
      .catch(() => {});
    const unsub = subscribeStream(dashboard, (e) => {
      if (alive && e.type === 'device' && e.device.type === device.type && e.device.id === device.id)
        upsert(e.data as MessageThread);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [device?.type, device?.id, dashboard]);

  const send = async (body: string, targets: string[]) => {
    if (device) upsert(await apiSend<MessageThread>(`${base}/send${qs}`, 'POST', { body, targets }));
  };
  const reply = async (threadId: string, body: string) => {
    if (device) upsert(await apiSend<MessageThread>(`${base}/reply${qs}`, 'POST', { threadId, body }));
  };
  const markSeen = async (threadId: string) => {
    if (device) upsert(await apiSend<MessageThread>(`${base}/seen${qs}`, 'POST', { threadId }));
  };
  const hide = async (threadId: string) => {
    if (device) upsert(await apiSend<MessageThread>(`${base}/hide${qs}`, 'POST', { threadId }));
  };

  const visible = dashboard ? threads.filter((t) => !t.hiddenBy.includes(dashboard)) : [];
  const unreadThreads = visible.filter((t) => threadUnread(t, dashboard!));
  return {
    threads: visible,
    unread: unreadThreads.length,
    incoming: unreadThreads,
    send,
    reply,
    markSeen,
    hide,
  };
}

const INTERCOM_CHUNK_MS = 500;

function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

interface Tx {
  stream: MediaStream;
  recorder: MediaRecorder;
  chain: Promise<void>;
  dead: boolean;
}

/** Live intercom state for a viewed dashboard: the incoming broadcast
 *  session (from /state + the device's push stream), audio arming, and
 *  start/stop broadcasting via MediaRecorder chunk uploads. All calls carry
 *  `?dashboard=` so the server treats the viewed dashboard as the acting
 *  identity. */
export function useIntercom(
  device: DeviceRef | null,
  dashboard: string | undefined,
): {
  session: IntercomSession | null;
  broadcasting: boolean;
  armed: boolean;
  arm: () => void;
  start: (targets: string[]) => Promise<void>;
  stop: () => Promise<void>;
} {
  const [session, setSession] = useState<IntercomSession | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);
  const [armed, setArmed] = useState(false);
  const tx = useRef<Tx | null>(null);
  const qs = dashboard ? `?dashboard=${encodeURIComponent(dashboard)}` : '';
  const base = device ? `/api/${device.type}/${device.id}` : '';

  useEffect(() => {
    if (!device || !dashboard) return;
    let alive = true;
    apiGet<{ session: IntercomSession | null }>(`${base}/state${qs}`)
      .then((s) => {
        if (alive) setSession(s.session);
      })
      .catch(() => {});
    const unsub = subscribeStream(dashboard, (e) => {
      if (!alive || e.type !== 'device' || e.device.type !== device.type || e.device.id !== device.id)
        return;
      const ev = e.data as IntercomEvent;
      setSession(ev.op === 'start' ? ev : null);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [device?.type, device?.id, dashboard]);

  const stop = async () => {
    const t = tx.current;
    if (!t || !device) return;
    tx.current = null;
    setBroadcasting(false);
    // Flush the recorder's final chunk before ending the session so the
    // message isn't truncated on the wire.
    const flushed =
      t.recorder.state === 'recording'
        ? new Promise<void>((resolve) => {
            t.recorder.onstop = () => resolve();
          })
        : Promise.resolve();
    try {
      t.recorder.stop();
    } catch {
      /* recorder may already be stopped */
    }
    t.stream.getTracks().forEach((tr) => tr.stop());
    await flushed;
    t.dead = true;
    await t.chain.catch(() => {});
    await apiSend(`${base}/stop${qs}`, 'POST').catch(() => {});
  };

  const start = async (targets: string[]) => {
    if (!device || tx.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('microphone unavailable — intercom requires HTTPS');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickAudioMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    try {
      await apiSend(`${base}/start${qs}`, 'POST', {
        targets,
        contentType: recorder.mimeType || 'audio/webm',
      });
    } catch (e) {
      stream.getTracks().forEach((tr) => tr.stop());
      throw e;
    }
    const t: Tx = { stream, recorder, chain: Promise.resolve(), dead: false };
    tx.current = t;
    recorder.ondataavailable = (e) => {
      if (!e.data.size || t.dead) return;
      t.chain = t.chain
        .then(() => apiPostRaw(`${base}/audio${qs}`, e.data))
        .catch(() => {
          if (tx.current === t) void stop();
        });
    };
    recorder.onerror = () => void stop();
    recorder.start(INTERCOM_CHUNK_MS);
    setBroadcasting(true);
  };

  const arm = () => setArmed(true);

  return { session, broadcasting, armed, arm, start, stop };
}
