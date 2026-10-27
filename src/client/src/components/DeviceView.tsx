import type { CSSProperties } from 'react';
import { useDeviceData, useServiceMeta } from '../hooks/useApi';
import type { DashboardView } from '../types';
import { componentRegistry, fallbackComponent } from './cards';

function viewStyle(props?: Record<string, unknown>): CSSProperties {
  const style: CSSProperties = {};
  if (typeof props?.color === 'string') style.borderColor = props.color;
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
  const data = useDeviceData(view.device!, meta?.[view.device!.type], view.params, pollMs, dashboard);
  const entry = componentRegistry[view.component] ?? fallbackComponent;
  const Cmp = entry.component;
  const overlayId = view.onTap?.overlay;
  const clickable = !inOverlay && !!overlayId && !!onOpenOverlay;
  return (
    <div
      className={entry.kind === 'chip' ? 'chip' : 'card'}
      style={viewStyle(view.props)}
      onClick={clickable ? () => onOpenOverlay!(overlayId!) : undefined}
      role={clickable ? 'button' : undefined}
    >
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
