import { useEffect, useRef, useState } from 'react';
import { apiSend } from '../../api';
import { showError } from '../../errors';
import type { CardProps } from './types';
import { toDisplay, unitProp, type Units } from './weatherFormat';

interface HeaterState {
  id: string;
  on: boolean;
  setpointC: number;
  currentTempC: number;
  maxSetpointC: number;
  updatedAt: string;
}

/** Setpoint slider runs in display units, bounded by the device's max. */
const sliderRange = (units: Units, maxSetpointC: number | undefined) => ({
  min: units === 'F' ? 50 : 10,
  max: toDisplay(maxSetpointC ?? 32, units) ?? (units === 'F' ? 90 : 32),
});
const toCelsius = (v: number, units: Units) =>
  units === 'F' ? Math.round((((v - 32) * 5) / 9) * 10) / 10 : v;

export function HeaterCard({ device, data, props }: CardProps) {
  const units = unitProp(props);
  const s = (data ?? {}) as Partial<HeaterState>;
  const shown = toDisplay(s.setpointC, units);
  const current = toDisplay(s.currentTempC, units);
  const [slider, setSlider] = useState<number | null>(null);
  const [pendingOn, setPendingOn] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Value we POSTed and are waiting to see echoed back by the next poll.
  const pending = useRef<number | null>(null);
  const latest = useRef<number | undefined>(undefined);

  useEffect(() => {
    latest.current = shown;
    if (shown === undefined) return;
    if (pending.current === null) setSlider(shown);
    else if (shown === pending.current) pending.current = null;
  }, [shown]);

  useEffect(() => {
    if (s.on !== undefined && s.on === pendingOn) setPendingOn(null);
  }, [s.on]);

  /** POST /set; resolves false (and surfaces the error) on failure. On
   *  success the card keeps its pending value until the next poll echoes
   *  the written state. */
  const set = async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      await apiSend(`/api/${device.type}/${device.id}/set`, 'POST', body);
      return true;
    } catch (e) {
      showError(`${device.id}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  };

  const onSlide = (value: number) => {
    setSlider(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      pending.current = value;
      if (await set({ setpointC: toCelsius(value, units) })) return;
      pending.current = null;
      setSlider(latest.current ?? null);
    }, 250);
  };

  const choosePower = (on: boolean) => {
    setPendingOn(on);
    void set({ on }).then((ok) => {
      if (!ok) setPendingOn(null);
    });
  };

  const { min, max } = sliderRange(units, s.maxSetpointC);
  const on = pendingOn ?? s.on;

  return (
    <div className="card-body">
      <h3>{device.id}</h3>
      <p>
        {current === undefined ? 'loading…' : `${current}°${units}`}{' '}
        <span className="muted">
          → {slider ?? shown ?? '—'}°{units} · {on === undefined ? '—' : on ? 'on' : 'off'}
        </span>
      </p>
      <p>
        {([false, true] as const).map((v) => (
          <button
            key={String(v)}
            className={`word-toggle${on === v ? ' on' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              choosePower(v);
            }}
          >
            {v ? 'ON' : 'OFF'}
          </button>
        ))}
      </p>
      {shown !== undefined ? (
        <input
          type="range"
          min={min}
          max={max}
          value={slider ?? shown}
          onChange={(e) => onSlide(Number(e.target.value))}
          onClick={(e) => e.stopPropagation()}
        />
      ) : null}
    </div>
  );
}
