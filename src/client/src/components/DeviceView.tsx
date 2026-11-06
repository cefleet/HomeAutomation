import type { CSSProperties } from 'react';
import { useDeviceData, useServiceMeta } from '../hooks/useApi';
import offline from '../assets/offline.png';
import type { DashboardView } from '../types';
import { componentRegistry, fallbackComponent } from './cards';

function viewStyle(props: Record<string, unknown> | undefined, boxed: boolean): CSSProperties {
  const style: CSSProperties & Record<string, string | number> = {};
  if (typeof props?.color === 'string') {
    // `color` is the card's accent tint; it colors the border when boxed.
    style['--card-accent'] = props.color;
    if (boxed) style.borderColor = props.color;
  }
  if (props?.shape === 'round') style.borderRadius = 18;
  if (props?.shape === 'square') style.borderRadius = 4;
  return style;
}

/** Renders one dashboard view: resolves the component, fetches device data
 *  per the service's declared transport, applies appearance overrides. */
export function DeviceView({
  view,
  inOverlay = false,
  onOpenOverlay,
  dashboard,
}: {
  view: DashboardView;
  inOverlay?: boolean;
  onOpenOverlay?: (id: string) => void;
  dashboard?: string;
}) {
  const meta = useServiceMeta();
  const pollMs = typeof view.props?.pollMs === 'number' ? view.props.pollMs : undefined;
  // `hr` break views are filtered out by callers — device is always bound.
  const { data, unreachable } = useDeviceData(
    view.device!,
    meta?.[view.device!.type],
    view.params,
    pollMs,
    dashboard,
  );
  const entry = componentRegistry[view.component] ?? fallbackComponent;
  const Cmp = entry.component;
  const overlayId = view.onTap?.overlay;
  const clickable = !inOverlay && !!overlayId && !!onOpenOverlay;
  const boxed = entry.kind === 'card' && (view.props?.boxed === true || entry.boxed === true);
  return (
    <div
      className={`${entry.kind === 'chip' ? 'chip' : 'card'}${boxed ? ' card-boxed' : ''}${
        unreachable ? ' device-unreachable' : ''
      }`}
      style={viewStyle(view.props, boxed)}
      onClick={clickable ? () => onOpenOverlay!(overlayId!) : undefined}
      role={clickable ? 'button' : undefined}
    >
      {unreachable ? (
        <span className="unreachable-badge">
          <img className="unreachable-icon" src={offline} alt="" />
          unreachable
        </span>
      ) : null}
      <Cmp device={view.device!} data={data} props={view.props} />
    </div>
  );
}

export interface ViewSlotProps {
  view: DashboardView;
  inOverlay?: boolean;
  onOpenOverlay?: (id: string) => void;
  dashboard?: string;
}

/** One dashboard view slot: an `hr` break renders a full-width divider;
 *  anything else renders the bound DeviceView. */
export function ViewSlot(props: ViewSlotProps) {
  if (props.view.component === 'hr') return <hr className="hr" />;
  return <DeviceView {...props} />;
}
