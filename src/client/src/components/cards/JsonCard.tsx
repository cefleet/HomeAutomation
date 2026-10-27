import type { CardProps } from './types';

/** Fallback for unregistered component names: dump the raw device data. */
export function JsonCard({ device, data }: CardProps) {
  return (
    <div className="card-body">
      <h3>{device.id}</h3>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
