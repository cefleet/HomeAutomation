import type { CardProps } from './types';
import { toDisplay, unitProp } from './weatherFormat';

export interface WeatherState {
  tempC?: number;
  humidity?: number;
  conditions?: string;
  wind?: string;
  precipPct?: number;
  updatedAt?: string;
  forecast?: { name?: string; temp?: number; unit?: string; short?: string }[];
}

export function WeatherCard({ device, data, props }: CardProps) {
  const units = unitProp(props);
  const s = (data ?? {}) as Partial<WeatherState>;
  return (
    <div className="card-body">
      <h3>{device.id}</h3>
      <p>{toDisplay(s.tempC, units) ?? '—'}°{units} · {s.conditions ?? '—'}</p>
      <p className="muted">
        {[s.wind ? `wind ${s.wind}` : null, s.humidity != null ? `humidity ${s.humidity}%` : null,
          s.precipPct != null ? `precip ${s.precipPct}%` : null]
          .filter(Boolean).join(' · ') || '—'}
      </p>
      {s.forecast?.length ? (
        <ul className="forecast">
          {s.forecast.slice(1, 4).map((p, i) => {
            const tempC = p.temp == null ? undefined
              : p.unit === 'C' ? p.temp : ((p.temp - 32) * 5) / 9;
            return <li key={i}>{p.name}: {toDisplay(tempC, units) ?? '—'}°{units} — {p.short}</li>;
          })}
        </ul>
      ) : null}
    </div>
  );
}
