import { useEffect, useState } from 'react';
import { apiSend } from '../../api';
import { showError } from '../../errors';
import type { CardProps } from './types';

interface LightState {
  id: string;
  on: boolean;
  color: string;
  brightness: number;
  updatedAt: string;
}

export function LightCard({ device, data }: CardProps) {
  const s = (data ?? {}) as Partial<LightState>;
  const [pendingOn, setPendingOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (s.on !== undefined && s.on === pendingOn) setPendingOn(null);
  }, [s.on]);

  const on = pendingOn ?? s.on;

  const toggle = () => {
    if (on === undefined) return;
    const next = !on;
    setPendingOn(next);
    apiSend(`/api/${device.type}/${device.id}/set`, 'POST', { on: next }).catch((e) => {
      setPendingOn(null);
      showError(`${device.id}: ${e instanceof Error ? e.message : e}`);
    });
  };

  return (
    <div className="card-body light-switch">
      <h3>{device.id}</h3>
      <button
        className={`light-toggle${on ? ' on' : ''}`}
        aria-label={`${device.id} light switch`}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <span className="light-toggle-lever" />
      </button>
    </div>
  );
}
