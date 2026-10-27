import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '../api';
import type { DashboardView, DeviceInfo, ServiceMeta } from '../types';
import { dataTypeComponent } from './cards';
import { DeviceView, ViewSlot } from './DeviceView';

/** Admin dashboard content: one auto-generated card per real (sourced)
 *  device, grouped by service type, plus a form for adding new devices. */
export function AdminDashboard({
  columns,
  dashboard,
  views,
  onOpenOverlay,
}: {
  columns?: number;
  dashboard?: string;
  views?: DashboardView[];
  onOpenOverlay?: (id: string) => void;
}) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [services, setServices] = useState<ServiceMeta[]>([]);
  const refresh = useCallback(
    () =>
      apiGet<DeviceInfo[]>('/api/devices')
        .then(setDevices)
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    refresh();
    apiGet<ServiceMeta[]>('/api/services').then(setServices).catch(() => {});
  }, [refresh]);

  const groups = new Map<string, DeviceInfo[]>();
  for (const d of (devices ?? []).filter((d) => d.source !== undefined)) {
    const g = groups.get(d.type) ?? [];
    g.push(d);
    groups.set(d.type, g);
  }

  return (
    <>
      {[...groups.entries()].map(([type, list], i) => (
        <section key={type}>
          {i > 0 ? <hr className="hr" /> : null}
          <h3 className="muted">{type}</h3>
          <div
            className="dashboard-grid"
            style={{ gridTemplateColumns: `repeat(${columns ?? 3}, minmax(0, 1fr))` }}
          >
            {list.map((d) => {
              const view: DashboardView = {
                component: dataTypeComponent[d.dataType] ?? 'json-card',
                device: { type: d.type, id: d.id },
              };
              return (
                <DeviceView key={d.id} view={view} dashboard={dashboard} />
              );
            })}
          </div>
        </section>
      ))}
      {views?.length ? (
        <div
          className="dashboard-grid"
          style={{ gridTemplateColumns: `repeat(${columns ?? 3}, minmax(0, 1fr))` }}
        >
          {views.map((v, i) => (
            <ViewSlot key={i} view={v} onOpenOverlay={onOpenOverlay} dashboard={dashboard} />
          ))}
        </div>
      ) : null}
      <AddDeviceForm services={services} onAdded={refresh} />
    </>
  );
}

function AddDeviceForm({
  services,
  onAdded,
}: {
  services: ServiceMeta[];
  onAdded: () => void;
}) {
  const [id, setId] = useState('');
  const [service, setService] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const config: Record<string, unknown> = {
      id: id.trim(),
      service,
      description: description.trim(),
      access: { read: ['*'], write: ['*'] },
    };
    if (source.trim()) config.source = source.trim();
    if (sourceType.trim()) config.sourceType = sourceType.trim();
    try {
      await apiSend('/api/devices', 'POST', config);
      setId('');
      setDescription('');
      setSource('');
      setSourceType('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>Add device</h3>
      <input
        placeholder="device id"
        required
        value={id}
        onChange={(e) => setId(e.target.value)}
      />
      <select required value={service} onChange={(e) => setService(e.target.value)}>
        <option value="" disabled>
          service type
        </option>
        {services.map((s) => (
          <option key={s.type} value={s.type}>
            {s.type}
          </option>
        ))}
      </select>
      <input
        placeholder="description"
        required
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        placeholder="source (optional)"
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />
      <input
        placeholder="sourceType (optional)"
        value={sourceType}
        onChange={(e) => setSourceType(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        Add device
      </button>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
