import type { CardProps } from './types';
import type { WeatherState } from './WeatherCard';
import { toDisplay, unitProp } from './weatherFormat';

export function WeatherChip({ data, props }: CardProps) {
  const units = unitProp(props);
  const s = (data ?? {}) as Partial<WeatherState>;
  return <span className="chip-body">{toDisplay(s.tempC, units) ?? '—'}°{units}</span>;
}
