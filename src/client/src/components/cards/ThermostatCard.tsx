import { useEffect, useRef, useState } from 'react';
import { apiSend } from '../../api';
import { showError } from '../../errors';
import type { CardProps } from './types';
import { toDisplay, unitProp, type Units } from './weatherFormat';

type ThermostatMode = 'off' | 'heat' | 'cool' | 'fan' | 'auto';
const MODES: ThermostatMode[] = ['off', 'heat', 'cool', 'fan', 'auto'];

interface ThermostatState {
  id: string;
  currentTempC: number;
  setpointC: number;
  mode: ThermostatMode;
  updatedAt: string;
}

/** Setpoint slider runs in display units. */
const sliderRange = (units: Units) =>
  units === 'F' ? { min: 50, max: 90 } : { min: 10, max: 32 };
const toCelsius = (v: number, units: Units) =>
  units === 'F' ? Math.round((((v - 32) * 5) / 9) * 10) / 10 : v;

export function ThermostatCard({ device, data, props }: CardProps) {
  const units = unitProp(props);
  const s = (data ?? {}) as Partial<ThermostatState>;
  const shown = toDisplay(s.setpointC, units);
  const current = toDisplay(s.currentTempC, units);
  const [slider, setSlider] = useState<number | null>(null);
  const [pendingMode, setPendingMode] = useState<ThermostatMode | null>(null);
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
    if (s.mode && s.mode === pendingMode) setPendingMode(null);
  }, [s.mode]);

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

  const chooseMode = (mode: ThermostatMode) => {
    setPendingMode(mode);
    void set({ mode }).then((ok) => {
      if (!ok) setPendingMode(null);
    });
  };

  const { min, max } = sliderRange(units);
  const mode = pendingMode ?? s.mode;

  return (
    <div className="card-body">
      <h3>{device.id}</h3>
      <p>
        {current === undefined ? 'loading…' : `${current}°${units}`}{' '}
        <span className="muted">
          → {slider ?? shown ?? '—'}°{units} · {mode ?? '—'}
        </span>
      </p>
      <p>
        {MODES.map((m) => (
          <button
            key={m}
            className={`word-toggle${mode === m ? ' on' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              chooseMode(m);
            }}
          >
            {m.toUpperCase()}
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
