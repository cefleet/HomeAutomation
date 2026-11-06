import { useRef, type ReactNode, type PointerEvent } from 'react';

const CX = 100;
const CY = 100;
const R = 78;
const START = 135; // degrees, bottom-left (SVG y-down)
const SWEEP = 270; // degrees clockwise through the top

const polar = (t: number, r = R): [number, number] => {
  const a = ((START + SWEEP * t) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};

const arcPath = (t0: number, t1: number): string => {
  const [x0, y0] = polar(t0);
  const [x1, y1] = polar(t1);
  const large = (t1 - t0) * SWEEP > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

/** Angle (deg, atan2 convention, y-down) → arc fraction t∈[0,1].
 *  The gap spans 45°–135° at the bottom; pointers there clamp to the
 *  nearest end. */
const angleToT = (deg: number): number => {
  let a = deg;
  if (a < 0) a += 360;
  if (a > 45 && a <= 90) return 1;
  if (a > 90 && a < START) return 0;
  if (a <= 45) a += 360;
  return Math.min(1, Math.max(0, (a - START) / SWEEP));
};

/** Curved slider: a ~270° arc with a draggable handle; children render
 *  centered inside the arc (e.g., a large temperature readout). */
export function ArcSlider({
  min,
  max,
  value,
  step = 1,
  disabled = false,
  onInput,
  children,
}: {
  min: number;
  max: number;
  value: number | undefined;
  step?: number;
  disabled?: boolean;
  onInput?: (v: number) => void;
  children?: ReactNode;
}) {
  const dragging = useRef(false);

  const valueFromEvent = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = ((e.clientX - rect.left) / rect.width) * 200 - CX;
    const dy = ((e.clientY - rect.top) / rect.height) * 200 - CY;
    const t = angleToT((Math.atan2(dy, dx) * 180) / Math.PI);
    const raw = min + t * (max - min);
    const snapped = Math.min(max, Math.max(min, Math.round(raw / step) * step));
    onInput?.(snapped);
  };

  const t = value === undefined ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const [hx, hy] = polar(t);

  return (
    <div className="arc-slider">
      <svg
        viewBox="0 0 200 200"
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={(e) => {
          if (disabled) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          valueFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) valueFromEvent(e);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <path className="arc-track" d={arcPath(0, 1)} />
        {value !== undefined && t > 0 ? (
          <path className="arc-progress" d={arcPath(0, t)} />
        ) : null}
        {value !== undefined ? <circle className="arc-handle" cx={hx} cy={hy} r={9} /> : null}
      </svg>
      <div className="arc-center">{children}</div>
    </div>
  );
}
