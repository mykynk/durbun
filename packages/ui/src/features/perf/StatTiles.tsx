import { memo, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Info } from 'lucide-react';
import { Tooltip } from '../../components';

/** Tiny trend line: de-emphasized stroke with the series color only on the current (last) point. */
export const TrendLine = memo(function TrendLine({ values, color, min = 0 }: { values: readonly number[]; color: string; min?: number }) {
  const n = values.length;
  if (n < 2) return <div className="pf-trend" aria-hidden />;
  let hi = min + 1e-9;
  for (const v of values) if (v > hi) hi = v;
  const range = hi - min || 1;
  const y = (v: number) => 22 - ((Math.max(min, v) - min) / range) * 20;
  let d = '';
  values.forEach((v, i) => {
    d += `${i === 0 ? 'M' : 'L'}${((i / (n - 1)) * 100).toFixed(2)},${y(v).toFixed(2)}`;
  });
  const lastY = y(values[n - 1]!);
  return (
    <div className="pf-trend" aria-hidden>
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="pf-trend__svg">
        <path d={d} className="pf-trend__line" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="pf-trend__dot" style={{ top: `${(lastY / 24) * 100}%`, background: color }} />
    </div>
  );
});

export interface StatTileProps {
  label: string;
  /** Series color (line key next to the label + trend dot). */
  color: string;
  /** Main value, already formatted ("23", "212"). */
  value?: string;
  /** Unit after (or before, `unitFirst`) the value. */
  unit?: string;
  unitFirst?: boolean;
  /** Replaces the value (e.g. "boşta" / "veri yok"). */
  placeholder?: string;
  sub?: ReactNode;
  hint?: string;
  trend?: readonly number[];
  tone?: 'default' | 'danger';
  /** Dim the value (last sample is old). */
  stale?: boolean;
  /** Small tag after the label (e.g. "süreçten"). */
  tag?: string;
  action?: ReactNode;
}

export const StatTile = memo(function StatTile({ label, color, value, unit, unitFirst, placeholder, sub, hint, trend, tone = 'default', stale, tag, action }: StatTileProps) {
  return (
    <div className={clsx('pf-tile', tone === 'danger' && 'pf-tile--danger', stale && 'pf-tile--stale')} role="group" aria-label={label}>
      <div className="pf-tile__head">
        <span className="pf-tile__key" style={{ background: color }} aria-hidden />
        <span className="pf-tile__label">{label}</span>
        {tag ? <span className="pf-tile__tag">{tag}</span> : null}
        {hint ? (
          <Tooltip content={hint} side="bottom">
            <span className="pf-tile__hint" tabIndex={0} role="note" aria-label={hint}>
              <Info size={12} aria-hidden />
            </span>
          </Tooltip>
        ) : null}
      </div>
      <div className="pf-tile__value">
        {value !== undefined ? (
          unitFirst ? (
            <>
              {unit ? <span className="pf-tile__unit pf-tile__unit--before">{unit}</span> : null}
              <span>{value}</span>
            </>
          ) : (
            <>
              <span>{value}</span>
              {unit ? <span className="pf-tile__unit">{unit}</span> : null}
            </>
          )
        ) : (
          <span className="pf-tile__placeholder">{placeholder ?? '—'}</span>
        )}
      </div>
      <div className="pf-tile__sub">{sub ?? ' '}</div>
      {action ? <div className="pf-tile__action">{action}</div> : <TrendLine values={trend ?? []} color={color} />}
    </div>
  );
});
