import type { DashboardOverlay } from '../../types';
import { ViewSlot } from '../DeviceView';

/** Single-level modal. Views inside render without tap interactions. */
export function Overlay({
  overlay,
  onClose,
  dashboard,
}: {
  overlay: DashboardOverlay;
  onClose: () => void;
  dashboard?: string;
}) {
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-header">
          <h2>{overlay.title ?? overlay.id}</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="overlay-views">
          {overlay.views.map((v, i) => (
            <ViewSlot key={i} view={v} inOverlay dashboard={dashboard} />
          ))}
        </div>
      </div>
    </div>
  );
}
