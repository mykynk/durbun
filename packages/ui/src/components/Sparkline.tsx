import { memo, useId } from 'react';

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  /** CSS color (use a token, e.g. "var(--accent)"). */
  color?: string;
  /** Soft area fill under the line. */
  fill?: boolean;
  strokeWidth?: number;
  /** Fixed domain (defaults to 0..max of values). */
  min?: number;
  max?: number;
  className?: string;
  'aria-label'?: string;
}

/** Tiny SVG line chart (no axes). */
export const Sparkline = memo(function Sparkline({
  values,
  width = 80,
  height = 20,
  color = 'var(--accent)',
  fill = true,
  strokeWidth = 1.5,
  min,
  max,
  className,
  ...aria
}: SparklineProps) {
  const gradId = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const n = values.length;
  if (n === 0) return <svg width={width} height={height} className={className} aria-hidden />;
  const lo = min ?? Math.min(0, ...values);
  const hi = max ?? Math.max(...values, lo + 1);
  const range = hi - lo || 1;
  const pad = strokeWidth;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * (width - pad * 2) + pad);
  const y = (v: number) => height - pad - ((Math.min(hi, Math.max(lo, v)) - lo) / range) * (height - pad * 2);
  let d = '';
  values.forEach((v, i) => {
    d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const area = `${d}L${x(n - 1).toFixed(1)},${height}L${x(0).toFixed(1)},${height}Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role={aria['aria-label'] ? 'img' : undefined}
      aria-label={aria['aria-label']}
      aria-hidden={aria['aria-label'] ? undefined : true}
    >
      {fill ? (
        <>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradId})`} stroke="none" />
        </>
      ) : null}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
});
