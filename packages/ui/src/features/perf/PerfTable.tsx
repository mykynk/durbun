import { memo, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatClock, formatNumber } from '../../components';
import { useT } from '../../i18n';
import type { PerSecondRow } from './model';

const ROW_H = 26;

const COLUMNS: { key: keyof PerSecondRow; label: string; digits: number }[] = [
  { key: 'cpu', label: 'perf.table.cols.cpu', digits: 1 },
  { key: 'memoryMB', label: 'perf.table.cols.memory', digits: 1 },
  { key: 'heapMB', label: 'perf.table.cols.heap', digits: 1 },
  { key: 'fps', label: 'perf.table.cols.fps', digits: 0 },
  { key: 'jankyFrames', label: 'perf.table.cols.jank', digits: 0 },
  { key: 'logs', label: 'perf.table.cols.logs', digits: 0 },
  { key: 'errorLogs', label: 'perf.table.cols.errorLogs', digits: 0 },
  { key: 'requests', label: 'perf.table.cols.requests', digits: 0 },
  { key: 'failedRequests', label: 'perf.table.cols.failed', digits: 0 },
];

/**
 * The charts' accessible twin: one row per second of the window (newest first), virtualized.
 * Same numbers as the CSV export.
 */
const ALWAYS: ReadonlySet<keyof PerSecondRow> = new Set(['logs', 'errorLogs']);
const REQUEST_COLS: ReadonlySet<keyof PerSecondRow> = new Set(['requests', 'failedRequests']);

export const PerfTable = memo(function PerfTable({ rows, showRequests = true }: { rows: readonly PerSecondRow[]; showRequests?: boolean }) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Metric columns the target never reported in this window are left out.
  const columns = useMemo(
    () =>
      COLUMNS.filter((c) =>
        REQUEST_COLS.has(c.key) ? showRequests : ALWAYS.has(c.key) || rows.some((r) => typeof r[c.key] === 'number'),
      ),
    [rows, showRequests],
  );
  const grid = { gridTemplateColumns: `88px repeat(${columns.length}, minmax(68px, 1fr))` };
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const header = (
    <div className="pf-table__row pf-table__row--head" role="row" style={grid}>
      <span className="pf-table__cell pf-table__cell--time" role="columnheader">
        {t('perf.table.time')}
      </span>
      {columns.map((c) => (
        <span key={c.key} className="pf-table__cell" role="columnheader">
          {t(c.label)}
        </span>
      ))}
    </div>
  );
  return (
    <div className="pf-table" role="table" aria-label={t('perf.table.label')} aria-rowcount={rows.length + 1}>
      <div className="pf-table__caption">{t('perf.table.caption')}</div>
      <div ref={scrollRef} className="pf-table__scroll">
        <div role="rowgroup" className="pf-table__head">
          {header}
        </div>
        {rows.length === 0 ? (
          <div className="pf-table__empty">{t('perf.table.empty')}</div>
        ) : (
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const r = rows[vi.index]!;
              return (
                <div
                  key={r.sec}
                  role="row"
                  aria-rowindex={vi.index + 2}
                  className="pf-table__row"
                  style={{ ...grid, position: 'absolute', top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="pf-table__cell pf-table__cell--time mono" role="cell">
                    {formatClock(r.sec * 1000, { ms: false })}
                  </span>
                  {columns.map((c) => {
                    const v = r[c.key];
                    const zeroish = typeof v !== 'number' || v === 0;
                    return (
                      <span key={c.key} className={zeroish ? 'pf-table__cell mono tnum is-zero' : 'pf-table__cell mono tnum'} role="cell">
                        {typeof v === 'number' ? formatNumber(v, { maxFractionDigits: c.digits }) : ''}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
