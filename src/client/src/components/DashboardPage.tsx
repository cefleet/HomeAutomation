import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import type { DashboardConfig } from '../types';
import { AdminDashboard } from './AdminDashboard';
import { ViewSlot } from './DeviceView';
import { Intercom } from './intercom/Intercom';
import { Messages } from './messages/Messages';
import { Notifications } from './notifications/Notifications';
import { Overlay } from './overlays/Overlay';

export function DashboardPage({ id }: { id?: string }) {
  const [resolvedId, setResolvedId] = useState<string | undefined>(id);
  const [dash, setDash] = useState<DashboardConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overlayId, setOverlayId] = useState<string | null>(null);

  useEffect(() => {
    if (resolvedId) return;
    apiGet<{ dashboard: string }>('/api/me')
      .then((me) => setResolvedId(me.dashboard))
      .catch((e) => setError(String(e)));
  }, [resolvedId]);

  useEffect(() => {
    if (!resolvedId) return;
    apiGet<DashboardConfig>(`/api/dashboards/${resolvedId}`)
      .then(setDash)
      .catch((e) => setError(String(e)));
  }, [resolvedId]);

  if (error) return <p className="error">{error}</p>;
  if (!dash) return <p>Loading…</p>;

  const overlays = new Map((dash.overlays ?? []).map((o) => [o.id, o]));
  const activeOverlay = overlayId ? overlays.get(overlayId) : undefined;
  const disabled = new Set(dash.disabled);

  const THEME_VARS: Record<string, string> = {
    background: '--bg',
    surface: '--surface',
    text: '--text',
    muted: '--muted',
    accent: '--accent',
    border: '--border',
  };
  const themeStyle: React.CSSProperties & Record<string, string | undefined> = {};
  const theme = dash.theme;
  if (theme?.colorScheme) themeStyle.colorScheme = theme.colorScheme;
  for (const [k, v] of Object.entries(theme?.colors ?? {}))
    if (THEME_VARS[k]) themeStyle[THEME_VARS[k]] = v;

  return (
    <main style={themeStyle}>
      {theme ? (
        <div
          className="dashboard-backdrop"
          style={{
            backgroundImage: theme.background
              ? `url(/api/dashboards/assets/${encodeURIComponent(theme.background.image)})`
              : undefined,
            backgroundSize: theme.background?.size,
            backgroundPosition: theme.background?.position,
          }}
        />
      ) : null}
      <header>
        {dash.admin ? <span className="badge">admin</span> : null}
        {!dash.admin && !disabled.has('messages') && resolvedId ? (
          <Messages dashboard={resolvedId} />
        ) : null}
        {!dash.admin && !disabled.has('intercom') && resolvedId ? (
          <Intercom dashboard={resolvedId} />
        ) : null}
      </header>
      {dash.admin ? (
        <AdminDashboard
          columns={dash.layout.columns}
          dashboard={resolvedId}
          views={dash.views}
          onOpenOverlay={setOverlayId}
        />
      ) : (
        <div
          className="dashboard-grid"
          style={{ gridTemplateColumns: `repeat(${dash.layout.columns ?? 3}, minmax(0, 1fr))` }}
        >
          {dash.views.map((v, i) => (
            <ViewSlot key={i} view={v} onOpenOverlay={setOverlayId} dashboard={resolvedId} />
          ))}
        </div>
      )}
      {activeOverlay ? (
        <Overlay overlay={activeOverlay} onClose={() => setOverlayId(null)} dashboard={resolvedId} />
      ) : null}
      <footer className="dashboard-footer">{dash.title}</footer>
      {!disabled.has('notifications') ? (
        <Notifications overlays={overlays} onOpenOverlay={setOverlayId} dashboard={resolvedId} />
      ) : null}
    </main>
  );
}
