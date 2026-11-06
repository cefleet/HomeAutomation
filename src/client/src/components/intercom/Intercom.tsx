import { useEffect, useState } from 'react';
import { apiUrl } from '../../api';
import mic from '../../assets/mic.png';
import speaker from '../../assets/speaker.png';
import { showError } from '../../errors';
import { useIntercom, useIntercomDevice } from '../../hooks/useApi';
import type { IntercomSession } from '../../types';
import { IntercomOverlay } from './IntercomOverlay';

/** Built-in intercom chrome rendered on every dashboard: a talk control
 *  opening the target picker, and autoplaying live playback of incoming
 *  broadcasts. Playback keeps the stream's last session until the audio
 *  element drains its buffer, so a stop press doesn't truncate the message.
 *  Acts as the viewed `dashboard`. Renders nothing when no
 *  `intercom`-contract device is configured. */
export function Intercom({ dashboard }: { dashboard: string }) {
  const device = useIntercomDevice();
  const { session, broadcasting, start, stop } = useIntercom(device, dashboard);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<IntercomSession | null>(null);

  useEffect(() => {
    if (session) setPlaying(session);
  }, [session]);

  if (!device) return null;

  const act = (p: Promise<void>) => p.catch((e) => showError(String(e)));
  const playback = playing && !broadcasting ? playing : null;
  const audioSrc = apiUrl(
    `/api/${device.type}/${device.id}/audio?dashboard=${encodeURIComponent(dashboard)}`,
  );

  return (
    <>
      <button
        className={`intercom-talk${broadcasting ? ' on' : ''}`}
        onClick={() => setOpen(true)}
      >
        <img className="badge-icon" src={mic} alt="" />
        {broadcasting ? 'Live' : 'Intercom'}
      </button>
      {open ? (
        <IntercomOverlay
          broadcasting={broadcasting}
          onStart={(t) => act(start(t))}
          onStop={() => act(stop())}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {playback ? (
        <div className="intercom-live">
          <audio
            key={playback.id}
            src={audioSrc}
            autoPlay
            onEnded={() => setPlaying(null)}
            onError={() => setPlaying(null)}
          />
          <span className="intercom-live-label">
            <img className="badge-icon" src={speaker} alt="" />
            Live from {playback.from}
          </span>
        </div>
      ) : null}
    </>
  );
}
