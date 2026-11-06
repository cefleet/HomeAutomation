import { useEffect, useRef, useState } from 'react';
import { apiSend } from '../../api';
import { showError } from '../../errors';
import { ArcSlider } from './ArcSlider';
import type { CardProps } from './types';
import { toDisplay, unitProp, type Units } from './weatherFormat';

type ZonedMode = 'off' | 'heat' | 'cool' | 'fan' | 'auto';
const MODES: ZonedMode[] = ['off', 'heat', 'cool', 'fan', 'auto'];

interface ZonedThermostatState {
  id: string;
  currentTempC: number;
  setpointC: number;
  mode: ZonedMode;
  updatedAt: string;
  zoneGroup?: string;
  zoneRole?: 'master' | 'member';
  allowedModes?: ZonedMode[];
}

/** Setpoint arc runs in display units. */
const arcRange = (units: Units) =>
  units === 'F' ? { min: 60, max: 86 } : { min: 16, max: 30 };
const toCelsius = (v: number, units: Units) =>
  units === 'F' ? Math.round((((v - 32) * 5) / 9) * 10) / 10 : v;

export function ZonedThermostatCard({ device, data, props }: CardProps) {
  const units = unitProp(props);
  const s = (data ?? {}) as Partial<ZonedThermostatState>;
  const shown = toDisplay(s.setpointC, units);
  const current = toDisplay(s.currentTempC, units);
  const allowed = s.allowedModes ?? MODES;
  const [slider, setSlider] = useState<number | null>(null);
  const [pendingMode, setPendingMode] = useState<ZonedMode | null>(null);
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

  const chooseMode = (mode: ZonedMode) => {
    setPendingMode(mode);
    void set({ mode }).then((ok) => {
      if (!ok) setPendingMode(null);
    });
  };

  const { min, max } = arcRange(units);
  const mode = pendingMode ?? s.mode;

  return (
    <div className="card-body thermo">
      <h3>
        {device.id}
        {s.zoneRole ? <span className="muted"> · {s.zoneRole}</span> : null}
      </h3>
      <ArcSlider
        min={min}
        max={max}
        value={slider ?? shown}
        disabled={shown === undefined}
        onInput={onSlide}
      >
        <div className="arc-mode">{mode ?? '—'}</div>
        <div className="arc-temp">
          {current === undefined ? '—' : `${current}°`}
        </div>
        <div className="arc-set">
          {current === undefined ? 'loading…' : `set ${slider ?? shown ?? '—'}°${units}`}
        </div>
      </ArcSlider>
      <p className="mode-buttons">
        {MODES.map((m) => (
          <button
            key={m}
            className={`word-toggle${mode === m ? ' on' : ''}`}
            disabled={!allowed.includes(m)}
            onClick={(e) => {
              e.stopPropagation();
              chooseMode(m);
            }}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </p>
    </div>
  );
}
