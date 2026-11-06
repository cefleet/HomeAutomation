import type { CardProps } from './types';
import { toDisplay, unitProp } from './weatherFormat';
import { weatherAssets, weatherIcon } from './weatherIcons';

export interface WeatherState {
  tempC?: number;
  humidity?: number;
  conditions?: string;
  wind?: string;
  precipPct?: number;
  updatedAt?: string;
  forecast?: { name?: string; temp?: number; unit?: string; short?: string }[];
}

export function WeatherCard({ data, props }: CardProps) {
  const units = unitProp(props);
  const s = (data ?? {}) as Partial<WeatherState>;
  return (
    <div className="card-body weather">
      <div className="weather-hero">
        <img className="weather-icon-lg" src={weatherIcon(s.conditions)} alt={s.conditions ?? 'weather'} />
        <div>
          <div className="weather-temp">{toDisplay(s.tempC, units) ?? '—'}°{units}</div>
          <div className="muted">{s.conditions ?? '—'}</div>
        </div>
      </div>
      <div className="weather-details">
        {s.wind ? (
          <span>
            <img src={weatherAssets.wind} alt="wind" />
            {s.wind}
          </span>
        ) : null}
        {s.humidity != null ? (
          <span>
            <img src={weatherAssets.humidity} alt="humidity" />
            {s.humidity}%
          </span>
        ) : null}
        {s.precipPct != null ? (
          <span>
            <img src={weatherAssets.precip} alt="precipitation" />
            {s.precipPct}%
          </span>
        ) : null}
      </div>
      {s.forecast?.length ? (
        <ul className="weather-forecast">
          {s.forecast.slice(1, 7).map((p, i) => {
            const tempC = p.temp == null ? undefined
              : p.unit === 'C' ? p.temp : ((p.temp - 32) * 5) / 9;
            return (
              <li key={i}>
                <img src={weatherIcon(p.short)} alt={p.short ?? ''} />
                <span className="fname">{p.name}</span>
                <span className="ftemp">{toDisplay(tempC, units) ?? '—'}°{units}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
