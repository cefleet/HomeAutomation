import { useEffect, useState } from 'react';
import { apiUrl } from '../../api';
import { showError } from '../../errors';
import { useIntercom, useIntercomDevice } from '../../hooks/useApi';
import type { IntercomSession } from '../../types';
import { IntercomOverlay } from './IntercomOverlay';

/** Built-in intercom chrome rendered on every dashboard: an enable-audio
 *  affordance until armed, a talk control opening the target picker, live
 *  playback of incoming broadcasts (automatic when armed, tap-to-listen
 *  otherwise). Playback keeps the stream's last session until the audio
 *  element drains its buffer, so a stop press doesn't truncate the message.
 *  Acts as the viewed `dashboard`. Renders nothing when no
 *  `intercom`-contract device is configured. */
export function Intercom({ dashboard }: { dashboard: string }) {
  const device = useIntercomDevice();
  const { session, broadcasting, armed, arm, start, stop } = useIntercom(device, dashboard);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<IntercomSession | null>(null);

  useEffect(() => {
    if (session) setPlaying(session);
  }, [session]);

  if (!device) return null;

  const act = (p: Promise<void>) => p.catch((e) => showError(String(e)));
  const incoming = session && !broadcasting ? session : null;
  const playback = playing && !broadcasting ? playing : null;
  const audioSrc = apiUrl(
    `/api/${device.type}/${device.id}/audio?dashboard=${encodeURIComponent(dashboard)}`,
  );

  return (
    <>
      {!armed ? (
        <button className="intercom-arm" onClick={arm}>
          Enable audio
        </button>
      ) : null}
      <button
        className={`intercom-talk${broadcasting ? ' on' : ''}`}
        onClick={() => setOpen(true)}
      >
        {broadcasting ? '● Live' : 'Intercom'}
      </button>
      {open ? (
        <IntercomOverlay
          broadcasting={broadcasting}
          onStart={(t) => act(start(t))}
          onStop={() => act(stop())}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {incoming && !armed ? (
        <div className="intercom-live">
          <div className="notification">
            <div className="notification-head">
              <strong>Broadcast from {incoming.from}</strong>
            </div>
            <div className="notification-actions">
              <button onClick={arm}>Listen</button>
            </div>
          </div>
        </div>
      ) : null}
      {playback && armed ? (
        <div className="intercom-live">
          <audio
            key={playback.id}
            src={audioSrc}
            autoPlay
            onEnded={() => setPlaying(null)}
            onError={() => setPlaying(null)}
          />
          <span className="intercom-live-label">Live from {playback.from}</span>
        </div>
      ) : null}
    </>
  );
}
