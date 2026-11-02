import type { NetworkEntry } from '@durbun/protocol';
import { shortTypeLabel } from './filters';

/** Table columns, persisted column preferences and sorting. */

export type ColumnId = 'status' | 'method' | 'host' | 'path' | 'type' | 'size' | 'duration' | 'start' | 'waterfall' | 'source';

export interface ColumnDef {
  id: ColumnId;
  /** Default width (px). The path column is flexible (minimum = its width). */
  width: number;
  min: number;
  flex?: boolean;
  align?: 'end';
  sortable: boolean;
  hideable: boolean;
  defaultVisible: boolean;
}

export const COLUMNS: readonly ColumnDef[] = [
  { id: 'status', width: 66, min: 48, sortable: true, hideable: true, defaultVisible: true },
  { id: 'method', width: 70, min: 48, sortable: true, hideable: true, defaultVisible: true },
  { id: 'host', width: 168, min: 70, sortable: true, hideable: true, defaultVisible: true },
  { id: 'path', width: 220, min: 140, flex: true, sortable: true, hideable: false, defaultVisible: true },
  { id: 'type', width: 76, min: 48, sortable: true, hideable: true, defaultVisible: true },
  { id: 'size', width: 80, min: 56, align: 'end', sortable: true, hideable: true, defaultVisible: true },
  { id: 'duration', width: 80, min: 56, align: 'end', sortable: true, hideable: true, defaultVisible: true },
  { id: 'start', width: 104, min: 76, sortable: true, hideable: true, defaultVisible: true },
  { id: 'waterfall', width: 170, min: 80, sortable: false, hideable: true, defaultVisible: true },
  { id: 'source', width: 88, min: 56, sortable: true, hideable: true, defaultVisible: false },
];

export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((c) => c.id);

export interface ColumnPrefs {
  hidden: ColumnId[];
  widths: Partial<Record<ColumnId, number>>;
}

export const DEFAULT_COLUMN_PREFS: ColumnPrefs = {
  hidden: COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.id),
  widths: {},
};

export function sanitizeColumnPrefs(raw: unknown): ColumnPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const hidden = Array.isArray(r.hidden)
    ? [...new Set(r.hidden.filter((x): x is ColumnId => typeof x === 'string' && COLUMN_IDS.includes(x as ColumnId) && x !== 'path'))]
    : DEFAULT_COLUMN_PREFS.hidden;
  const widths: Partial<Record<ColumnId, number>> = {};
  if (r.widths && typeof r.widths === 'object') {
    for (const def of COLUMNS) {
      const w = Number((r.widths as Record<string, unknown>)[def.id]);
      if (Number.isFinite(w) && w >= def.min && w <= 1200) widths[def.id] = Math.round(w);
    }
  }
  return { hidden, widths };
}

export function visibleColumns(prefs: ColumnPrefs): ColumnDef[] {
  return COLUMNS.filter((c) => !prefs.hidden.includes(c.id));
}

export function columnWidth(prefs: ColumnPrefs, def: ColumnDef): number {
  return prefs.widths[def.id] ?? def.width;
}

/** CSS grid-template-columns for header and rows (the path column takes the remaining space). */
export function gridTemplate(cols: readonly ColumnDef[], prefs: ColumnPrefs): string {
  return cols.map((c) => (c.flex ? `minmax(${columnWidth(prefs, c)}px, 1fr)` : `${columnWidth(prefs, c)}px`)).join(' ');
}

/** Minimum total width of the table (horizontal scroll below it). */
export function minTableWidth(cols: readonly ColumnDef[], prefs: ColumnPrefs): number {
  return cols.reduce((sum, c) => sum + columnWidth(prefs, c), 0);
}

/** Columns given up first when the table is narrow (detail panel open, small window). */
const DROP_ORDER: readonly ColumnId[] = ['waterfall', 'source', 'start', 'type', 'host', 'size'];

/**
 * The visible columns that fit `width` px: low-priority columns are dropped (not hidden in the prefs)
 * so status, method, path and duration stay readable. Width 0 (not measured yet) keeps everything.
 */
export function fitColumns(cols: readonly ColumnDef[], prefs: ColumnPrefs, width: number): ColumnDef[] {
  let out = cols.slice();
  if (width <= 0) return out;
  for (const id of DROP_ORDER) {
    if (minTableWidth(out, prefs) <= width) break;
    out = out.filter((c) => c.id !== id);
  }
  return out;
}

/* ───────────── Sorting ───────────── */

export type SortKey = 'seq' | Exclude<ColumnId, 'waterfall'>;

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortState = { key: 'seq', dir: 'asc' };

const SORT_KEYS: readonly SortKey[] = ['seq', 'status', 'method', 'host', 'path', 'type', 'size', 'duration', 'start', 'source'];

export function sanitizeSort(raw: unknown): SortState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const key = SORT_KEYS.includes(r.key as SortKey) ? (r.key as SortKey) : 'seq';
  return { key, dir: r.dir === 'desc' ? 'desc' : 'asc' };
}

/** Header click: ascending → descending → back to arrival order. Time columns start descending (newest first). */
export function nextSort(cur: SortState, key: SortKey): SortState {
  const firstDir: SortState['dir'] = key === 'size' || key === 'duration' ? 'desc' : 'asc';
  if (cur.key !== key) return { key, dir: firstDir };
  if (cur.dir === firstDir) return { key, dir: firstDir === 'asc' ? 'desc' : 'asc' };
  return DEFAULT_SORT;
}

/** Chronological (arrival or start time): new rows join at one end, so "follow" is meaningful. */
export function isChronological(sort: SortState): boolean {
  return sort.key === 'seq' || sort.key === 'start';
}

function statusRank(e: NetworkEntry): number {
  if (e.state === 'pending') return 10_001;
  if (typeof e.status === 'number') return e.status + (e.state === 'failed' ? 0.5 : 0);
  return e.state === 'cancelled' ? 10_000 : 9_999;
}

const str = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Ascending comparator for a sort key ('seq' keeps arrival order and is handled by the caller). */
export function comparatorFor(key: SortKey): ((a: NetworkEntry, b: NetworkEntry) => number) | null {
  switch (key) {
    case 'seq':
      return null;
    case 'status':
      return (a, b) => statusRank(a) - statusRank(b);
    case 'method':
      return (a, b) => str(a.method, b.method);
    case 'host':
      return (a, b) => str(a.host, b.host);
    case 'path':
      return (a, b) => str(a.path, b.path);
    case 'type':
      return (a, b) => str(shortTypeLabel(a), shortTypeLabel(b));
    case 'size':
      return (a, b) => (a.responseBodySize ?? -1) - (b.responseBodySize ?? -1);
    case 'duration':
      return (a, b) => (a.duration ?? (a.state === 'pending' ? Number.MAX_SAFE_INTEGER : -1)) - (b.duration ?? (b.state === 'pending' ? Number.MAX_SAFE_INTEGER : -1));
    case 'start':
      return (a, b) => a.startTs - b.startTs;
    case 'source':
      return (a, b) => str(a.source, b.source);
  }
}

/** Sorted copy of `entries` (already in arrival order; the sort is stable so ties keep it). */
export function sortEntries(entries: readonly NetworkEntry[], sort: SortState): NetworkEntry[] {
  const cmp = comparatorFor(sort.key);
  if (!cmp) return sort.dir === 'asc' ? entries.slice() : entries.slice().reverse();
  const out = entries.slice().sort(cmp);
  if (sort.dir === 'desc') out.reverse();
  return out;
}
