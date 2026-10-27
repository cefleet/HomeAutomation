import { useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '../../api';
import { showError } from '../../errors';
import type { MediaPlayerState } from '../../types';
import type { CardProps } from './types';

interface PickerItem {
  uri: string;
  name: string;
  artist?: string;
  sub?: string;
  type?: string;
  artUrl: string;
  source?: string;
}

/**
 * Song picker for `media-player` devices — used inside an overlay (tap the
 * player card). Searches the Spotify catalog via `GET /search` (needs
 * clientId/clientSecret on the device config) and lists the daemon's play
 * queue via `GET /queue`. Tap a row to play (`play-uri`); "+" adds a track
 * to the queue (`queue-add`). Playback state itself lives in
 * MediaPlayerCard — this is just the picker surface.
 */
export function MediaPicker({ device, data }: CardProps) {
  const s = (data ?? {}) as Partial<MediaPlayerState>;
  const usable = s.connected === true && s.loggedIn === true;
  const base = `/api/${device.type}/${device.id}`;
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickerItem[]>([]);
  const [queue, setQueue] = useState<PickerItem[]>([]);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const loadQueue = () =>
    apiGet<{ upcoming: PickerItem[] }>(`${base}/queue`)
      .then((r) => setQueue(r.upcoming ?? []))
      .catch(() => {});

  useEffect(() => {
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.updatedAt]);

  useEffect(() => {
    clearTimeout(debounce.current);
    if (!q.trim()) {
      setResults([]);
      setSearchErr(null);
      return;
    }
    debounce.current = setTimeout(() => {
      apiGet<{ results: PickerItem[] }>(
        `${base}/search?q=${encodeURIComponent(q.trim())}`,
      )
        .then((r) => {
          setResults(r.results ?? []);
          setSearchErr(null);
        })
        .catch((e) => {
          setResults([]);
          setSearchErr(e instanceof Error ? e.message : 'search unavailable');
        });
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [q, base]);

  const send = async (command: string, value?: unknown) => {
    try {
      await apiSend(
        `${base}/command`,
        'POST',
        value === undefined ? { command } : { command, value },
      );
    } catch (e) {
      showError(`${device.id}: ${e instanceof Error ? e.message : e}`);
    }
  };

  const play = (item: PickerItem) => void send('play-uri', item.uri);
  const enqueue = (item: PickerItem) =>
    void send('queue-add', item.uri).then(loadQueue);

  const row = (item: PickerItem, canQueue: boolean) => (
    <div
      key={item.uri + (item.type ?? '')}
      className="picker-row"
      onClick={() => usable && play(item)}
    >
      {item.artUrl ? (
        <img className="picker-art" src={item.artUrl} alt="" />
      ) : (
        <div className="picker-art picker-art-empty" />
      )}
      <div className="picker-meta">
        <div>{item.name || item.uri}</div>
        <div className="muted">
          {[item.type, item.artist || item.sub].filter(Boolean).join(' · ')}
        </div>
      </div>
      {canQueue ? (
        <button
          className="media-btn"
          title="add to queue"
          disabled={!usable}
          onClick={(e) => {
            e.stopPropagation();
            enqueue(item);
          }}
        >
          +
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="card-body" onClick={(e) => e.stopPropagation()}>
      <h3>Pick music</h3>
      <input
        type="search"
        placeholder="Search Spotify…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {searchErr ? <p className="muted">{searchErr}</p> : null}
      {results.length ? (
        <div className="picker-list">{results.map((r) => row(r, r.type === 'track'))}</div>
      ) : null}
      {queue.length ? (
        <>
          <h4 className="muted">Up next</h4>
          <div className="picker-list">{queue.map((r) => row(r, false))}</div>
        </>
      ) : null}
      {!usable ? <p className="muted">player unavailable</p> : null}
    </div>
  );
}
