import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowDownNarrowWide, ArrowUpWideNarrow, CircleAlert, Drama } from 'lucide-react';
import type { NetworkEntry } from '@durbun/protocol';
import { networkStore } from '../../../data';
import { MethodBadge, StatusBadge, Tooltip, formatBytes, formatClock, formatDuration, formatNumber, useElementSize } from '../../../components';
import { t, type Lang } from '../../../i18n';
import { columnWidth, fitColumns, gridTemplate, minTableWidth, type ColumnDef, type ColumnId, type ColumnPrefs, type SortKey, type SortState } from '../model/columns';
import { shortTypeLabel } from '../model/filters';
import { displayUrl, splitPathQuery } from '../model/http';
import { barLayout, rangeOf, timingBreakdown, type TimeRange } from '../model/waterfall';
import { shortErrorKey } from '../model/errors';

export interface RevealRequest {
  id: string;
  seq: number;
  /** Center the row (focus from another tab) instead of the minimal scroll. */
  center?: boolean;
}

export interface NetworkTableProps {
  rowIds: readonly string[];
  /** Store version (rows read live entries). */
  version: number;
  columns: readonly ColumnDef[];
  prefs: ColumnPrefs;
  onResizeColumn: (id: ColumnId, width: number | undefined) => void;
  onHeaderContextMenu: (e: MouseEvent) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
  selectedId: string | null;
  marks: readonly string[];
  /** Row picked as the first side of a comparison. */
  compareBaseId: string | null;
  onRowClick: (id: string, e: MouseEvent) => void;
  onRowContextMenu: (id: string, e: MouseEvent) => void;
  slowMs: number;
  /** Where new rows appear ('bottom' for oldest-first, 'top' for newest-first) or null (sorted by a value). */
  followEdge: 'bottom' | 'top' | null;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** New matching rows since following stopped (pill). */
  newCount: number;
  reveal: RevealRequest | null;
  rowHeight: number;
  lang: Lang;
  /** The tab is visible (timers stop while hidden). */
  active: boolean;
  empty?: ReactNode;
  'aria-label': string;
}

function SortIcon({ dir }: { dir: 'asc' | 'desc' }) {
  return dir === 'asc' ? <ArrowUpWideNarrow size={12} aria-hidden /> : <ArrowDownNarrowWide size={12} aria-hidden />;
}

/** Clock for pending waterfall bars: ticks only while needed and visible. */
function useTicker(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** Virtualized request table: sticky header (synced horizontally), resizable/sortable columns, follow + scroll anchoring. */
export const NetworkTable = memo(function NetworkTable(props: NetworkTableProps) {
  const { rowIds, prefs, sort, rowHeight, follow, followEdge, onFollowChange, reveal, selectedId } = props;
  const tableRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(tableRef);
  // Narrow table (detail open): drop low-priority columns instead of scrolling sideways.
  const columns = useMemo(() => fitColumns(props.columns, prefs, Math.max(0, width - 12)), [props.columns, prefs, width]);
  const template = useMemo(() => gridTemplate(columns, prefs), [columns, prefs]);
  const minWidth = useMemo(() => minTableWidth(columns, prefs), [columns, prefs]);
  const colIds = useMemo(() => columns.map((c) => c.id).join(','), [columns]);

  const virtualizer = useVirtualizer({
    count: rowIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (i) => rowIds[i] ?? i,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // ── follow + anchoring ──
  const expectedTop = useRef<number | null>(null);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const setTop = (el: HTMLDivElement, top: number) => {
    el.scrollTop = top;
    expectedTop.current = el.scrollTop;
  };

  const recordAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el || rowIds.length === 0) {
      anchor.current = null;
      return;
    }
    const first = Math.min(rowIds.length - 1, Math.max(0, Math.floor(el.scrollTop / rowHeight)));
    const last = Math.min(rowIds.length - 1, Math.floor((el.scrollTop + el.clientHeight - 1) / rowHeight));
    let idx = first;
    if (selectedId) {
      for (let i = first; i <= last; i++) {
        if (rowIds[i] === selectedId) {
          idx = i;
          break;
        }
      }
    }
    anchor.current = { id: rowIds[idx]!, offset: idx * rowHeight - el.scrollTop };
  }, [rowIds, rowHeight, selectedId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (headerRef.current) headerRef.current.scrollLeft = el.scrollLeft;
    const programmatic = expectedTop.current !== null && Math.abs(el.scrollTop - expectedTop.current) < 2;
    expectedTop.current = null;
    if (!programmatic && followEdge) {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const atTop = el.scrollTop <= 2;
      const atEdge = followEdge === 'bottom' ? atBottom : atTop;
      if (atEdge !== follow) onFollowChange(atEdge);
    }
    recordAnchor();
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (follow && followEdge) {
      setTop(el, followEdge === 'bottom' ? el.scrollHeight : 0);
      return;
    }
    const a = anchor.current;
    if (!a) return;
    const idx = rowIds.indexOf(a.id);
    if (idx < 0) return;
    const want = idx * rowHeight - a.offset;
    if (Math.abs(el.scrollTop - want) >= 1) setTop(el, want);
    // Re-anchor only when rows change; scrolling records the anchor itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIds, follow, followEdge]);

  // Reveal a row (keyboard navigation, focus from another tab).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !reveal) return;
    const idx = rowIds.indexOf(reveal.id);
    if (idx < 0) return;
    const top = idx * rowHeight;
    const view = el.clientHeight;
    if (reveal.center) setTop(el, Math.max(0, top - view / 2 + rowHeight / 2));
    else if (top < el.scrollTop) setTop(el, top);
    else if (top + rowHeight > el.scrollTop + view) setTop(el, top + rowHeight - view);
    recordAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  // ── waterfall range over the rows in view ──
  const items = virtualizer.getVirtualItems();
  const visible = items.map((it) => networkStore.get(rowIds[it.index] ?? ''));
  const anyPending = visible.some((e) => e?.state === 'pending');
  const now = useTicker(1000, props.active && anyPending);
  const range = useMemo(() => rangeOf(visible, now), [visible.map((e) => (e ? `${e.id}:${e.endTs ?? ''}` : '')).join('|'), now]); // eslint-disable-line react-hooks/exhaustive-deps

  const style = { '--net-cols': template, '--net-min-w': `${minWidth}px`, '--net-row-h': `${rowHeight}px` } as CSSProperties;

  return (
    <div ref={tableRef} className="net-table" style={style} role="grid" aria-label={props['aria-label']} aria-rowcount={rowIds.length + 1} aria-multiselectable={false}>
      <div ref={headerRef} className="net-thead" role="rowgroup" onContextMenu={props.onHeaderContextMenu}>
        <div className="net-thead__row" role="row" aria-rowindex={1}>
          {columns.map((c, i) => (
            <HeaderCell key={c.id} col={c} sort={sort} onSort={props.onSort} width={columnWidth(prefs, c)} last={i === columns.length - 1} onResize={props.onResizeColumn} range={c.id === 'waterfall' ? range : null} />
          ))}
        </div>
      </div>
      <div ref={scrollRef} className="net-tbody" onScroll={onScroll} role="rowgroup" tabIndex={-1}>
        {rowIds.length === 0 ? (
          props.empty
        ) : (
          <div className="net-tbody__inner" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((it) => {
              const id = rowIds[it.index]!;
              const e = networkStore.get(id);
              if (!e) return <div key={it.key} className="net-row net-row--gone" style={{ transform: `translateY(${it.start}px)` }} />;
              return (
                <Row
                  key={it.key}
                  entry={e}
                  index={it.index}
                  top={it.start}
                  selected={id === selectedId}
                  marked={props.marks.includes(id) || id === props.compareBaseId}
                  colIds={colIds}
                  range={range}
                  now={now}
                  slowMs={props.slowMs}
                  lang={props.lang}
                  onClick={props.onRowClick}
                  onContextMenu={props.onRowContextMenu}
                />
              );
            })}
          </div>
        )}
      </div>
      {followEdge && !follow && props.newCount > 0 ? (
        <button type="button" className={clsx('net-newpill', followEdge === 'top' && 'net-newpill--top')} onClick={() => onFollowChange(true)}>
          <ArrowDown size={13} aria-hidden className={clsx(followEdge === 'top' && 'net-flip')} />
          {t('network.table.newRows', { count: props.newCount })}
        </button>
      ) : null}
    </div>
  );
});

/* ───────────── Header ───────────── */

function HeaderCell({
  col,
  sort,
  onSort,
  width,
  last,
  onResize,
  range,
}: {
  col: ColumnDef;
  sort: SortState;
  onSort: (key: SortKey) => void;
  width: number;
  last: boolean;
  onResize: (id: ColumnId, width: number | undefined) => void;
  range: TimeRange | null;
}) {
  const sorted = sort.key === col.id;
  const [drag, setDrag] = useState<{ x: number; w: number } | null>(null);
  const label = t(`network.columns.${col.id}`);
  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone (synthetic events, fast release) */
    }
    setDrag({ x: e.clientX, w: width });
    document.body.classList.add('is-resizing-h');
  };
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (!drag) return;
    onResize(col.id, Math.max(col.min, Math.min(1200, Math.round(drag.w + e.clientX - drag.x))));
  };
  const end = () => {
    setDrag(null);
    document.body.classList.remove('is-resizing-h');
  };
  const ariaSort = sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <div className={clsx('net-th', col.align === 'end' && 'net-th--end', sorted && 'is-sorted')} role="columnheader" aria-sort={col.sortable ? ariaSort : undefined}>
      {col.sortable ? (
        <button type="button" className="net-th__btn" onClick={() => onSort(col.id as SortKey)} title={t('network.table.sortBy', { column: label })}>
          <span className="truncate">{label}</span>
          {sorted ? <SortIcon dir={sort.dir} /> : null}
        </button>
      ) : (
        <span className="net-th__label">
          <span className="truncate">{label}</span>
          {range ? <span className="net-th__range tnum">{formatDuration(range.end - range.start)}</span> : null}
        </span>
      )}
      {!last ? (
        <span
          className="net-th__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('network.table.resizeColumn', { column: label })}
          title={t('network.table.resizeHint')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
          onDoubleClick={() => onResize(col.id, undefined)}
        />
      ) : null}
    </div>
  );
}

/* ───────────── Row ───────────── */

interface RowProps {
  entry: NetworkEntry;
  index: number;
  top: number;
  selected: boolean;
  marked: boolean;
  colIds: string;
  range: TimeRange | null;
  now: number;
  slowMs: number;
  lang: Lang;
  onClick: (id: string, e: MouseEvent) => void;
  onContextMenu: (id: string, e: MouseEvent) => void;
}

function rowTone(e: NetworkEntry): string | undefined {
  if (e.state === 'failed') return 'net-row--fail';
  if (typeof e.status === 'number' && e.status >= 500) return 'net-row--5xx';
  if (typeof e.status === 'number' && e.status >= 400) return 'net-row--4xx';
  return undefined;
}

const Row = memo(
  function Row({ entry: e, index, top, selected, marked, colIds, range, now, slowMs, onClick, onContextMenu }: RowProps) {
    const cols = colIds.split(',') as ColumnId[];
    return (
      <div
        className={clsx('net-row', rowTone(e), selected && 'is-selected', marked && 'is-marked', e.state === 'pending' && 'is-pending')}
        style={{ transform: `translateY(${top}px)` }}
        role="row"
        aria-rowindex={index + 2}
        aria-selected={selected}
        data-id={e.id}
        onClick={(ev) => onClick(e.id, ev)}
        onContextMenu={(ev) => onContextMenu(e.id, ev)}
      >
        {cols.map((c) => (
          <div key={c} className={clsx('net-td', `net-td--${c}`)} role="gridcell">
            {renderCell(c, e, range, now, slowMs)}
          </div>
        ))}
      </div>
    );
  },
  (a, b) =>
    a.entry === b.entry &&
    a.top === b.top &&
    a.selected === b.selected &&
    a.marked === b.marked &&
    a.colIds === b.colIds &&
    a.slowMs === b.slowMs &&
    a.lang === b.lang &&
    a.index === b.index &&
    a.onClick === b.onClick &&
    a.onContextMenu === b.onContextMenu &&
    (!a.colIds.includes('waterfall') || (a.range?.start === b.range?.start && a.range?.end === b.range?.end && (a.entry.state !== 'pending' || a.now === b.now))),
);

function StatusCell({ e }: { e: NetworkEntry }) {
  if (e.state === 'cancelled') {
    return (
      <span className="status net-st-cancel" title={e.error || t('network.status.cancelled')}>
        {t('network.status.cancelledShort')}
      </span>
    );
  }
  if (e.state === 'failed' && typeof e.status === 'number') {
    return (
      <span className="net-st-broken" title={t('network.status.failedAfterHeaders', { error: e.error ?? '' })}>
        <StatusBadge status={e.status} state="complete" statusText={e.statusText} />
        <CircleAlert size={11} className="net-st-broken__icon" aria-hidden />
      </span>
    );
  }
  return <StatusBadge status={e.status} state={e.state} error={e.error} statusText={e.statusText} />;
}

function PathCell({ e }: { e: NetworkEntry }) {
  if (!e.url) {
    // The response arrived without its request (e.g. the request was cleared meanwhile).
    return <span className="net-dim net-noreq">{t('network.table.responseOnly')}</span>;
  }
  const { pathname, query } = splitPathQuery(displayUrl(e.path || e.url));
  const errKey = e.state === 'failed' ? shortErrorKey(e.error) : null;
  return (
    <>
      <span className="net-path truncate" title={e.url}>
        <span className="net-path__name">{pathname}</span>
        {query ? <span className="net-path__query">{query}</span> : null}
      </span>
      {e.graphql ? (
        <span className={clsx('net-gql', `net-gql--${e.graphql.operationType ?? 'query'}`)} title={t('network.table.graphqlOp')}>
          {e.graphql.operationType ?? 'query'}
          {e.graphql.operationName ? ` ${e.graphql.operationName}` : ''}
        </span>
      ) : null}
      {e.mocked ? (
        <span className="net-mockbadge" title={t('network.table.mockedHint')}>
          <Drama size={11} aria-hidden />
          {t('network.table.mocked')}
        </span>
      ) : null}
      {errKey ? (
        <span className="net-errchip" title={e.error}>
          {t(`network.errors.${errKey}`)}
        </span>
      ) : null}
    </>
  );
}

function SizeCell({ e }: { e: NetworkEntry }) {
  const res = e.responseBodySize;
  const req = e.requestBodySize;
  const title = [req !== undefined ? t('network.table.requestSize', { size: formatBytes(req) }) : null, res !== undefined ? t('network.table.responseSize', { size: formatBytes(res) }) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="tnum" title={title || undefined}>
      {res !== undefined ? formatBytes(res) : e.state === 'pending' ? '' : '—'}
    </span>
  );
}

function DurationCell({ e, slowMs }: { e: NetworkEntry; slowMs: number }) {
  if (e.duration === undefined) return <span className="net-dim">{e.state === 'pending' ? '…' : '—'}</span>;
  const cls = e.duration >= slowMs * 3 ? 'net-dur--veryslow' : e.duration >= slowMs ? 'net-dur--slow' : undefined;
  return <span className={clsx('tnum', cls)}>{formatDuration(e.duration)}</span>;
}

function WaterfallCell({ e, range, now }: { e: NetworkEntry; range: TimeRange | null; now: number }) {
  if (!range) return null;
  const bar = barLayout(e, range, now);
  const breakdown = timingBreakdown(e);
  const total = breakdown.total ?? 0;
  const tone = e.state === 'failed' ? 'fail' : e.state === 'cancelled' ? 'cancel' : e.state === 'pending' ? 'pending' : 'ok';
  return (
    <span className="net-wf" aria-hidden>
      <span className={clsx('net-wf__bar', `net-wf__bar--${tone}`, bar.open && 'is-open')} style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}>
        {breakdown.known && total > 0 && tone === 'ok'
          ? breakdown.spans.map((s) => <span key={s.phase} className={clsx('net-wf__seg', `net-phase--${s.phase}`)} style={{ width: `${(s.ms / total) * 100}%` }} />)
          : null}
      </span>
    </span>
  );
}

function renderCell(c: ColumnId, e: NetworkEntry, range: TimeRange | null, now: number, slowMs: number): ReactNode {
  switch (c) {
    case 'status':
      return <StatusCell e={e} />;
    case 'method':
      return <MethodBadge method={e.method} />;
    case 'host':
      return (
        <span className="net-host truncate" title={e.host}>
          {e.host}
        </span>
      );
    case 'path':
      return <PathCell e={e} />;
    case 'type':
      return <span className="net-dim truncate">{shortTypeLabel(e)}</span>;
    case 'size':
      return <SizeCell e={e} />;
    case 'duration':
      return <DurationCell e={e} slowMs={slowMs} />;
    case 'start':
      return <span className="net-dim tnum">{formatClock(e.startTs)}</span>;
    case 'waterfall':
      return <WaterfallCell e={e} range={range} now={now} />;
    case 'source':
      return <span className="net-dim truncate">{e.source}</span>;
  }
}

/** Status-bar style counter used by the toolbar ("124 / 1.204"). */
export function RowCounter({ shown, total }: { shown: number; total: number }) {
  return (
    <Tooltip content={t('network.toolbar.counterHint', { shown: formatNumber(shown), total: formatNumber(total) })}>
      <span className="net-counter tnum" aria-live="off">
        {shown === total ? formatNumber(total) : `${formatNumber(shown)} / ${formatNumber(total)}`}
      </span>
    </Tooltip>
  );
}
