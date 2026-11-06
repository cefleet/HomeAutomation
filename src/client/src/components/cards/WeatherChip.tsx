import type { CardProps } from './types';
import type { WeatherState } from './WeatherCard';
import { toDisplay, unitProp } from './weatherFormat';
import { weatherIcon } from './weatherIcons';

export function WeatherChip({ data, props }: CardProps) {
  const units = unitProp(props);
  const s = (data ?? {}) as Partial<WeatherState>;
  return (
    <span className="chip-body">
      <img className="chip-icon" src={weatherIcon(s.conditions)} alt={s.conditions ?? 'weather'} />
      {toDisplay(s.tempC, units) ?? '—'}°{units}
    </span>
  );
}
