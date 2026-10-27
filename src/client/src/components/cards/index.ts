import { HeaterCard } from './HeaterCard';
import { JsonCard } from './JsonCard';
import { LightCard } from './LightCard';
import { MediaPicker } from './MediaPicker';
import { MediaPlayerCard } from './MediaPlayerCard';
import { ThermostatCard } from './ThermostatCard';
import { WeatherCard } from './WeatherCard';
import { WeatherChip } from './WeatherChip';
import { ZonedThermostatCard } from './ZonedThermostatCard';
import type { RegistryEntry } from './types';

export const componentRegistry: Record<string, RegistryEntry> = {
  'heater-card': { component: HeaterCard, kind: 'card' },
  'light-card': { component: LightCard, kind: 'card' },
  'media-picker': { component: MediaPicker, kind: 'card' },
  'media-player-card': { component: MediaPlayerCard, kind: 'card' },
  'thermostat-card': { component: ThermostatCard, kind: 'card' },
  'zoned-thermostat-card': { component: ZonedThermostatCard, kind: 'card' },
  'weather-card': { component: WeatherCard, kind: 'card' },
  'weather-chip': { component: WeatherChip, kind: 'chip' },
};

export const fallbackComponent: RegistryEntry = { component: JsonCard, kind: 'card' };

/** Default card for a data contract — used by the admin dashboard's
 *  auto-generated device grid. Contracts without an entry render via the
 *  fallback component. */
export const dataTypeComponent: Record<string, string> = {
  heater: 'heater-card',
  light: 'light-card',
  'media-player': 'media-player-card',
  thermostat: 'thermostat-card',
  'zoned-thermostat': 'zoned-thermostat-card',
  weather: 'weather-card',
};

export type { CardProps, RegistryEntry } from './types';
