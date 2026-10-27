import { useState } from 'react';
import { useDashboards } from '../../hooks/useApi';

/** Intercom overlay: pick target dashboards and toggle a live broadcast
 *  (press to start, press again to stop). */
export function IntercomOverlay({
  broadcasting,
  onStart,
  onStop,
  onClose,
}: {
  broadcasting: boolean;
  onStart: (targets: string[]) => Promise<void>;
  onStop: () => Promise<void>;
  onClose: () => void;
}) {
  // Fetched on open so disabled/added dashboards are always current.
  const dashboards = useDashboards() ?? [];
  const [targets, setTargets] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-header">
          <h2>Intercom</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted">Broadcast live audio to selected dashboards.</p>
        <div className="msg-targets">
          {dashboards
            .filter((d) => !d.disabled?.includes('intercom'))
            .map((d) => (
              <label key={d.id}>
                <input
                  type="checkbox"
                  checked={targets.has(d.id)}
                  disabled={broadcasting}
                  onChange={() => toggle(d.id)}
                />
                {d.title}
              </label>
            ))}
        </div>
        <div className="notification-actions">
          {broadcasting ? (
            <button className="intercom-stop" onClick={() => onStop()}>
              ■ Stop broadcast
            </button>
          ) : (
            <button onClick={() => onStart([...targets])} disabled={!targets.size}>
              ● Start talking
            </button>
          )}
        </div>
        {broadcasting ? (
          <p className="intercom-live-note">
            Broadcasting — press Stop when done. Broadcasts end automatically after 1 minute.
          </p>
        ) : null}
      </div>
    </div>
  );
}
