import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type CSSProperties, type MouseEvent, type Ref } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LogEntry } from '@durbun/protocol';
import { networkStore, useNetworkVersion, type TimeFormat } from '../../../data';
import { formatOffset } from '../../../components';
import { t } from '../../../i18n';
import type { RowModel } from '../model/rowModel';
import type { LogRow } from '../model/types';
import { entryClock } from '../model/records';
import { LogRowView, type RowDisplay } from './LogRow';

export interface LogListHandle {
  scrollToIndex(index: number, align?: 'start' | 'center' | 'end' | 'auto'): void;
  scrollToEnd(): void;
  focus(): void;
  /**
   * Keep this row's top where it is on screen while its height changes (expanding a stack/JSON/lines):
   * the content grows downwards instead of the list re-gluing to the bottom and pushing the row away.
   */
  pinRow(rowId: number): void;
  /** Visible row index range (without overscan). */
  visibleRange(): { first: number; last: number } | null;
}

export interface LogListProps {
  ref?: Ref<LogListHandle>;
  model: RowModel;
  /** Model version (re-render trigger). */
  version: number;
  /** Changes whenever rows were inserted/removed (new key function → virtualizer re-reads keys). */
  structure: number;
  d: RowDisplay;
  selectedId: number | null;
  expanded: ReadonlyMap<number, number>;
  flashId: number | null;
  following: boolean;
  /** Explicit pause: rows frozen, never auto-scroll. */
  frozen: boolean;
  /** Height of a collapsed single-line row (px) — also the size estimate. */
  rowHeight: number;
  /** Changing it drops cached row heights (font size, density, wrap). */
  measureKey: string;
  active: boolean;
  showNetwork: boolean;
  onFollowChange(following: boolean): void;
  onRowClick(row: LogRow, index: number, ev: MouseEvent): void;
  onRowAction(action: string, row: LogRow, value: string | undefined, ev: MouseEvent): void;
  onRowContextMenu(row: LogRow, index: number, ev: MouseEvent): void;
  onRangeChange(first: number, last: number): void;
}

function rowTime(e: LogEntry, prev: LogRow | undefined, base: number | undefined, fmt: TimeFormat): string {
  if (fmt === 'relative') return formatOffset(e.ts - (base ?? e.ts));
  if (fmt === 'delta') return prev ? formatOffset(e.ts - (prev.last ?? prev.e).ts) : formatOffset(0);
  return entryClock(e);
}

/** How long after a wheel/touch/key/drag gesture a scroll event counts as the user's. */
const INTENT_MS = 350;
const END_SLACK = 6;

/**
 * Virtualized log list (@tanstack/react-virtual, dynamic heights). Keys are row ids (= first entry id),
 * heights are cached per key, rows are memoized. Follow mode keeps the view at the bottom while new rows
 * arrive; any user scroll away from the bottom stops following (the parent shows the "↓ N new" pill), and
 * scrolling back to the bottom resumes it. While not following, the virtualizer anchors the top visible
 * row so trimming the ring's head never moves what you are reading.
 */
export const LogList = memo(function LogList(props: LogListProps) {
  const { model, d, selectedId, expanded, flashId, following, frozen, rowHeight, active } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(following);
  followingRef.current = following && !frozen;
  const netVersion = useNetworkVersion({ enabled: active && props.showNetwork });
  void netVersion;

  const getItemKey = useMemo(
    () => (i: number) => model.rows[model.start + i]?.id ?? -1 - i,
    // A new function whenever the row structure changed so the virtualizer re-reads every key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, props.structure],
  );
  const estimateSize = useCallback(() => rowHeight, [rowHeight]);

  const virtualizer = useVirtualizer({
    count: model.count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 14,
    anchorTo: 'end',
    followOnAppend: following && !frozen ? 'auto' : false,
    scrollEndThreshold: END_SLACK,
  });

  // Font size / density / wrap changed: every cached height is stale.
  const firstMeasure = useRef(true);
  useEffect(() => {
    if (firstMeasure.current) {
      firstMeasure.current = false;
      return;
    }
    virtualizer.measure();
  }, [props.measureKey, virtualizer]);

  // Safety net for follow mode: stay glued to the bottom after appends/resizes the virtualizer did not cover.
  useLayoutEffect(() => {
    if (!followingRef.current || !active || model.count === 0) return;
    if (!virtualizer.isAtEnd(END_SLACK)) virtualizer.scrollToEnd();
  });

  /* ───── user scroll intent → follow on/off ───── */
  const intent = useRef({ at: 0, dragging: false });
  /** Row kept in place while it expands/collapses (see `pinRow`). */
  const pin = useRef({ id: -1, top: 0, until: 0, raf: 0 });
  useEffect(() => () => cancelAnimationFrame(pin.current.raf), []);
  /** Row under the last primary pointer press: the click target may differ if the list moved meanwhile. */
  const pressedRow = useRef<number | null>(null);
  const onFollowChange = props.onFollowChange;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mark = () => {
      intent.current.at = performance.now();
      pin.current.id = -1; // the user scrolls: stop holding an expanded row in place
    };
    const onWheel = (e: WheelEvent) => {
      mark();
      if (e.deltaY < 0 && followingRef.current) {
        followingRef.current = false;
        onFollowChange(false);
      }
    };
    // ↑/↓/j/k move the selection (a shortcut that already stops following) — only real scrolling keys count.
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) mark();
    };
    const onDown = (e: PointerEvent) => {
      if (e.target === el) {
        // Pointer down on the scroll container itself = the scrollbar.
        intent.current.dragging = true;
        pressedRow.current = null;
        mark();
        return;
      }
      if (e.button !== 0) return;
      const rowEl = (e.target as HTMLElement).closest?.<HTMLElement>('[data-row]');
      pressedRow.current = rowEl ? Number(rowEl.dataset.row) : null;
      if (rowEl && followingRef.current) {
        // Clicking / selecting text in a row: hold the list still so the row does not slide away.
        // (Not a scroll intent: programmatic scrolls right after must not turn following back on.)
        followingRef.current = false;
        onFollowChange(false);
      }
    };
    const onUp = () => {
      intent.current.dragging = false;
    };
    const onScroll = () => {
      const i = intent.current;
      if (!i.dragging && performance.now() - i.at > INTENT_MS) return;
      const atEnd = el.scrollHeight - el.clientHeight - el.scrollTop <= END_SLACK + 2;
      if (atEnd && !followingRef.current) {
        followingRef.current = true;
        onFollowChange(true);
      } else if (!atEnd && followingRef.current) {
        followingRef.current = false;
        onFollowChange(false);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('scroll', onScroll);
    };
  }, [onFollowChange]);

  useImperativeHandle(
    props.ref,
    () => ({
      scrollToIndex(index, align = 'auto') {
        if (index < 0 || index >= model.count) return;
        virtualizer.scrollToIndex(index, { align });
      },
      scrollToEnd() {
        virtualizer.scrollToEnd();
      },
      focus() {
        scrollRef.current?.focus({ preventScroll: true });
      },
      pinRow(rowId) {
        const el = scrollRef.current;
        const rowEl = el?.querySelector<HTMLElement>(`#lg-row-${rowId}`);
        if (!el || !rowEl) return;
        const offsetOf = (r: HTMLElement) => r.getBoundingClientRect().top - el.getBoundingClientRect().top;
        cancelAnimationFrame(pin.current.raf);
        pin.current = { id: rowId, top: offsetOf(rowEl), until: performance.now() + 450, raf: 0 };
        const tick = () => {
          const p = pin.current;
          if (p.id !== rowId) return;
          const r = el.querySelector<HTMLElement>(`#lg-row-${rowId}`);
          if (r) {
            const d = offsetOf(r) - p.top;
            if (Math.abs(d) >= 1) el.scrollTop += d;
          }
          if (performance.now() < p.until) p.raf = requestAnimationFrame(tick);
          else p.id = -1;
        };
        pin.current.raf = requestAnimationFrame(tick);
      },
      visibleRange() {
        const r = virtualizer.range;
        return r ? { first: r.startIndex, last: r.endIndex } : null;
      },
    }),
    [virtualizer, model],
  );

  const items = virtualizer.getVirtualItems();
  const range = virtualizer.range;
  const onRangeChange = props.onRangeChange;
  const rStart = range?.startIndex ?? -1;
  const rEnd = range?.endIndex ?? -1;
  useEffect(() => {
    if (rStart >= 0) onRangeChange(rStart, rEnd);
  }, [rStart, rEnd, props.version, onRangeChange]);

  /* ───── event delegation (one handler for every row) ───── */
  const rowFromEvent = (ev: MouseEvent): { row: LogRow; index: number } | null => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!el) return null;
    const id = Number(el.dataset.row);
    const index = model.indexOfRow(id);
    const row = index >= 0 ? model.row(index) : undefined;
    return row ? { row, index } : null;
  };

  const onClick = (ev: MouseEvent) => {
    const hit = rowFromEvent(ev);
    const pressed = pressedRow.current;
    pressedRow.current = null;
    if (!hit && pressed !== null && ev.button === 0) {
      // The row moved between press and release (live list): use the pressed row.
      const index = model.indexOfRow(pressed);
      const row = index >= 0 ? model.row(index) : undefined;
      if (row) {
        props.onRowClick(row, index, ev);
        return;
      }
    }
    if (!hit) return;
    const target = ev.target as HTMLElement;
    // Clicks inside expanded content (JSON tree, …) belong to that content.
    if (target.closest('.lg-expand')) return;
    // Selecting text must not select the row / open the detail panel.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0 && (ev.currentTarget as HTMLElement).contains(sel.anchorNode)) return;
    const actEl = target.closest<HTMLElement>('[data-act]');
    if (actEl) {
      ev.stopPropagation();
      props.onRowAction(actEl.dataset.act!, hit.row, actEl.dataset.v, ev);
      return;
    }
    props.onRowClick(hit.row, hit.index, ev);
  };

  const onContextMenu = (ev: MouseEvent) => {
    const hit = rowFromEvent(ev);
    if (!hit) return;
    if ((ev.target as HTMLElement).closest('.lg-expand')) return;
    props.onRowContextMenu(hit.row, hit.index, ev);
  };

  const base = model.count > 0 ? model.row(0)!.e.ts : undefined;
  const style = { '--lg-row-h': `${rowHeight}px` } as CSSProperties;
  const total = model.count;
  const activeDescendant = selectedId !== null ? `lg-row-${selectedId}` : undefined;

  return (
    <div
      ref={scrollRef}
      className={`lg-scroll${d.wrap ? ' is-wrap' : ''}`}
      style={style}
      role="listbox"
      aria-label={t('logs.list.label')}
      aria-activedescendant={activeDescendant && model.indexOfRow(selectedId!) >= 0 ? activeDescendant : undefined}
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="lg-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((vi) => {
          const row = model.rows[model.start + vi.index];
          if (!row) return null;
          const prev = vi.index > 0 ? model.rows[model.start + vi.index - 1] : undefined;
          const net = row.e.kind === 'network' && row.e.netId ? networkStore.get(row.e.netId) : undefined;
          return (
            <div
              key={row.id}
              id={`lg-row-${row.id}`}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="lg-pos"
              style={{ transform: `translateY(${vi.start}px)` }}
              role="option"
              aria-selected={row.id === selectedId}
              aria-posinset={vi.index + 1}
              aria-setsize={total}
            >
              <LogRowView
                row={row}
                time={rowTime(row.e, prev, base, d.timeFormat)}
                net={net}
                selected={row.id === selectedId}
                expanded={expanded.get(row.flap?.key ?? row.id) ?? 0}
                flash={row.id === flashId}
                d={d}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
