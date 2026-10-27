import { useEffect, useRef, useState } from 'react';
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
  const [slider, setSlider] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const release = useRef<ReturnType<typeof setTimeout>>();
  // Value we POSTed and are waiting to see echoed back by the push stream.
  const pending = useRef<number | null>(null);
  const latest = useRef<number | undefined>(undefined);

  useEffect(() => {
    latest.current = s.brightness;
    if (s.brightness === undefined) return;
    if (pending.current === null) setSlider(s.brightness);
    else if (s.brightness === pending.current) pending.current = null;
  }, [s.brightness]);

  const set = (body: Record<string, unknown>) =>
    apiSend(`/api/${device.type}/${device.id}/set`, 'POST', body).catch((e) =>
      showError(`${device.id}: ${e instanceof Error ? e.message : e}`),
    );

  const onSlide = (value: number) => {
    setSlider(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = value;
      set({ brightness: value });
      // Safety: if no matching push arrives (e.g. failed write), resync.
      clearTimeout(release.current);
      release.current = setTimeout(() => {
        pending.current = null;
        setSlider(latest.current ?? null);
      }, 1500);
    }, 250);
  };

  return (
    <div className="card-body">
      <h3>{device.id}</h3>
      <p>
        {s.on === undefined ? (
          'loading…'
        ) : (
          <button
            className={`word-toggle${s.on ? ' on' : ''}`}
            onClick={(e) => { e.stopPropagation(); set({ on: !s.on }); }}
          >
            {s.on ? 'ON' : 'OFF'}
          </button>
        )}
        {s.color ? <span className="swatch" style={{ background: s.color }} /> : null}
      </p>
      <p className="muted">
        brightness {slider ?? s.brightness ?? '—'}% ·{' '}
        {s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '—'}
      </p>
      {s.brightness !== undefined ? (
        <input
          type="range"
          min={0}
          max={100}
          value={slider ?? s.brightness}
          onChange={(e) => onSlide(Number(e.target.value))}
          onClick={(e) => e.stopPropagation()}
        />
      ) : null}
    </div>
  );
}
