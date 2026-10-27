import { useEffect, useRef, useState } from 'react';
import { apiSend } from '../../api';
import { showError } from '../../errors';
import type { MediaPlayerState } from '../../types';
import type { CardProps } from './types';

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const REPEAT_CYCLE = { off: 'context', context: 'track', track: 'off' } as const;
const REPEAT_LABEL = { off: 'REPEAT', context: 'REPEAT ·', track: 'REPEAT 1' } as const;

export function MediaPlayerCard({ device, data }: CardProps) {
  const s = (data ?? {}) as Partial<MediaPlayerState>;
  const connected = s.connected === true;
  const loggedIn = s.loggedIn === true;
  const playing = s.playing === true;
  const usable = connected && loggedIn;
  const [vol, setVol] = useState<number | null>(null);
  const [, tick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Volume we POSTed and are waiting to see echoed back by the next push.
  const pending = useRef<number | null>(null);
  // Position anchor for local interpolation between daemon pushes.
  const anchor = useRef({ ms: 0, at: 0, speed: 0 });

  useEffect(() => {
    anchor.current = {
      ms: s.progressMs ?? 0,
      at: Date.now(),
      speed: s.speed ?? 0,
    };
  }, [s.progressMs, s.speed, s.updatedAt]);

  useEffect(() => {
    if (s.volume === undefined) return;
    if (pending.current === null) setVol(s.volume);
    else if (s.volume === pending.current) pending.current = null;
  }, [s.volume]);

  // Re-render once a second while playing so the progress bar advances.
  useEffect(() => {
    if (!(usable && playing)) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [usable, playing]);

  /** POST /command; resolves false (and surfaces the error) on failure. */
  const send = async (
    command: string,
    value?: number | string | boolean,
  ): Promise<boolean> => {
    try {
      await apiSend(
        `/api/${device.type}/${device.id}/command`,
        'POST',
        value === undefined ? { command } : { command, value },
      );
      return true;
    } catch (e) {
      showError(`${device.id}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  };

  const onVolume = (v: number) => {
    setVol(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      pending.current = v;
      if (await send('volume', v)) return;
      pending.current = null;
      setVol(s.volume ?? null);
    }, 250);
  };

  const shownMs = Math.min(
    s.durationMs ?? 0,
    anchor.current.ms + (Date.now() - anchor.current.at) * anchor.current.speed,
  );
  const pct =
    s.durationMs && s.durationMs > 0 ? Math.min(100, (100 * shownMs) / s.durationMs) : 0;

  const transport = (label: string, command: string) => (
    <button
      className="media-btn"
      disabled={!usable}
      onClick={(e) => {
        e.stopPropagation();
        void send(command);
      }}
    >
      {label}
    </button>
  );

  const repeat = s.repeat ?? 'off';
  const toggle = (label: string, on: boolean, command: string, value: number | string | boolean) => (
    <button
      className={`word-toggle${on ? ' on' : ''}`}
      disabled={!usable}
      onClick={(e) => {
        e.stopPropagation();
        void send(command, value);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="card-body">
      <h3>{s.deviceName || device.id}</h3>
      <div className="media-now">
        {s.albumArtUrl ? (
          <img className="media-art" src={s.albumArtUrl} alt="" />
        ) : (
          <div className="media-art media-art-empty" />
        )}
        <div className="media-meta">
          <div>{s.track || '—'}</div>
          <div className="muted">
            {[s.artist, s.album].filter(Boolean).join(' · ')}
          </div>
          {s.contextName ? <div className="muted">{s.contextName}</div> : null}
        </div>
      </div>
      <div className="media-progress">
        <div className="media-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted">
        {fmt(shownMs)} / {fmt(s.durationMs ?? 0)}
      </p>
      <p className="media-controls">
        {transport('⏮', 'previous')}
        {transport(playing ? '⏸' : '▶', playing ? 'pause' : 'play')}
        {transport('⏭', 'next')}
        {toggle('SHUFFLE', s.shuffle === true, 'shuffle', !(s.shuffle === true))}
        {toggle(REPEAT_LABEL[repeat], repeat !== 'off', 'repeat', REPEAT_CYCLE[repeat])}
      </p>
      {s.volume !== undefined ? (
        <input
          type="range"
          min={0}
          max={100}
          value={vol ?? s.volume}
          disabled={!usable}
          onChange={(e) => onVolume(Number(e.target.value))}
          onClick={(e) => e.stopPropagation()}
        />
      ) : null}
      {!connected ? <p className="muted">player offline</p> : null}
      {connected && !loggedIn ? (
        <p className="muted">not paired — select {s.deviceName || 'it'} in the Spotify app</p>
      ) : null}
      {connected && loggedIn && s.isActive === false ? (
        <p>
          <button
            className="media-btn"
            onClick={(e) => {
              e.stopPropagation();
              void send('activate');
            }}
          >
            make active
          </button>
          <span className="muted"> not the active Spotify device</span>
        </p>
      ) : null}
    </div>
  );
}
