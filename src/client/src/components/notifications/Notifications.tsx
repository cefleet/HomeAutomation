import { useEffect, useState } from 'react';
import { apiSend } from '../../api';
import { onError, showError, type LocalError } from '../../errors';
import { useNotifications } from '../../hooks/useApi';
import type { DashboardOverlay } from '../../types';

export function Notifications({
  overlays,
  onOpenOverlay,
  dashboard,
}: {
  overlays: Map<string, DashboardOverlay>;
  onOpenOverlay: (id: string) => void;
  dashboard?: string;
}) {
  const { items, dismiss } = useNotifications(dashboard);
  const [errors, setErrors] = useState<LocalError[]>([]);
  useEffect(() => onError((e) => setErrors((prev) => [...prev, e])), []);
  if (!items.length && !errors.length) return null;
  return (
    <div className="notifications">
      {errors.map((e) => (
        <div key={`err-${e.id}`} className="notification error-toast">
          <div className="notification-head">
            <strong>Change failed</strong>
            <button onClick={() => setErrors((prev) => prev.filter((x) => x.id !== e.id))} aria-label="dismiss">×</button>
          </div>
          <p>{e.message}</p>
        </div>
      ))}
      {items.map((n) => (
        <div key={n.id} className="notification">
          <div className="notification-head">
            <strong>{n.title ?? n.type}</strong>
            <button onClick={() => dismiss(n.id)} aria-label="dismiss">×</button>
          </div>
          {n.body ? <p>{n.body}</p> : null}
          {n.device ? <p className="muted">{n.device.type}/{n.device.id}</p> : null}
          {n.interactive && n.actions?.length ? (
            <div className="notification-actions">
              {n.actions.map((a, i) => (
                <button
                  key={i}
                  onClick={() => {
                    if (a.overlay && overlays.has(a.overlay)) onOpenOverlay(a.overlay);
                    if (a.endpoint)
                      apiSend(a.endpoint, a.method ?? 'POST').catch((e) => showError(String(e)));
                    dismiss(n.id);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
