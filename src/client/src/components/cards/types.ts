import type { DeviceRef } from '../../types';

export interface CardProps {
  device: DeviceRef;
  data: unknown;
  props?: Record<string, unknown>;
}

export type RegistryEntry = {
  component: (p: CardProps) => JSX.Element;
  kind: 'card' | 'chip';
};
