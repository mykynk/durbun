import type { NetworkEntry } from '@durbun/protocol';
import { shortTypeLabel } from './filters';
import { isLiveStream, streamAge } from './streams';

/** Table columns, persisted column preferences and sorting. */

export type ColumnId = 'status' | 'method' | 'host' | 'path' | 'type' | 'size' | 'duration' | 'start' | 'waterfall' | 'source' | 'app' | 'device';

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
  /**
   * Shown by itself when the list mixes several of what it names (devices, apps), unless the user turned it on or
   * off in the column menu.
   */
  auto?: boolean;
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
  { id: 'app', width: 120, min: 64, sortable: true, hideable: true, defaultVisible: false, auto: true },
  { id: 'device', width: 116, min: 64, sortable: true, hideable: true, defaultVisible: false, auto: true },
];

export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((c) => c.id);

export interface ColumnPrefs {
  hidden: ColumnId[];
  widths: Partial<Record<ColumnId, number>>;
  /** Automatic columns the user turned on (shown even when the list has one device / app). */
  shown?: ColumnId[];
}

export const DEFAULT_COLUMN_PREFS: ColumnPrefs = {
  hidden: COLUMNS.filter((c) => !c.defaultVisible && !c.auto).map((c) => c.id),
  widths: {},
  shown: [],
};

const isAuto = (id: ColumnId) => COLUMNS.some((c) => c.id === id && c.auto);

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
  const shown = Array.isArray(r.shown) ? [...new Set(r.shown.filter((x): x is ColumnId => typeof x === 'string' && isAuto(x as ColumnId)))].filter((x) => !hidden.includes(x)) : [];
  return { hidden, widths, shown };
}

/** Whether an automatic column is on (several devices / apps in the list). Ordinary columns ignore it. */
export type AutoColumns = (id: ColumnId) => boolean;

/** 'on' / 'off' when the user chose, 'auto' when an automatic column follows the list. */
export function columnMode(prefs: ColumnPrefs, id: ColumnId): 'on' | 'off' | 'auto' {
  if (prefs.hidden.includes(id)) return 'off';
  if (!isAuto(id) || prefs.shown?.includes(id)) return 'on';
  return 'auto';
}

export function visibleColumns(prefs: ColumnPrefs, autoOn: AutoColumns = () => false): ColumnDef[] {
  return COLUMNS.filter((c) => {
    const mode = columnMode(prefs, c.id);
    return mode === 'on' || (mode === 'auto' && autoOn(c.id));
  });
}

/** Column menu click: an ordinary column toggles; an automatic one becomes explicitly on / off (from what shows now). */
export function toggleColumn(prefs: ColumnPrefs, id: ColumnId, visibleNow: boolean): ColumnPrefs {
  const hidden = prefs.hidden.filter((x) => x !== id);
  const shown = (prefs.shown ?? []).filter((x) => x !== id);
  if (visibleNow) return { ...prefs, hidden: [...hidden, id], shown };
  return { ...prefs, hidden, shown: isAuto(id) ? [...shown, id] : shown };
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
const DROP_ORDER: readonly ColumnId[] = ['waterfall', 'source', 'start', 'type', 'app', 'host', 'device', 'size'];

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

export type SortKey = 'seq' | Exclude<ColumnId, 'waterfall' | 'app' | 'device'> | 'app' | 'device';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortState = { key: 'seq', dir: 'asc' };

const SORT_KEYS: readonly SortKey[] = ['seq', 'status', 'method', 'host', 'path', 'type', 'size', 'duration', 'start', 'source', 'app', 'device'];

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

/** Size for sorting: a stream entry by the payload bytes of its messages (as its cell shows). */
function sizeRank(e: NetworkEntry): number {
  if (e.stream) return e.stream.bytesIn + e.stream.bytesOut;
  return e.responseBodySize ?? -1;
}

/** Duration for sorting: a stream entry by how long it was open (still open = longest, like pending requests). */
function durationRank(e: NetworkEntry): number {
  if (e.stream) return isLiveStream(e) ? Number.MAX_SAFE_INTEGER : (streamAge(e, 0) ?? -1);
  return e.duration ?? (e.state === 'pending' ? Number.MAX_SAFE_INTEGER : -1);
}

/** Display names for the app and device columns (sorting by what the user reads, not by ids). */
export interface ColumnNames {
  app: (e: NetworkEntry) => string;
  device: (e: NetworkEntry) => string;
}

const ID_NAMES: ColumnNames = { app: (e) => e.appId ?? '', device: (e) => e.deviceId };

/** Ascending comparator for a sort key ('seq' keeps arrival order and is handled by the caller). */
export function comparatorFor(key: SortKey, names: ColumnNames = ID_NAMES): ((a: NetworkEntry, b: NetworkEntry) => number) | null {
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
      return (a, b) => sizeRank(a) - sizeRank(b);
    case 'duration':
      return (a, b) => durationRank(a) - durationRank(b);
    case 'start':
      return (a, b) => a.startTs - b.startTs;
    case 'source':
      return (a, b) => str(a.source, b.source);
    case 'app':
      return (a, b) => str(names.app(a).toLowerCase(), names.app(b).toLowerCase());
    case 'device':
      return (a, b) => str(names.device(a).toLowerCase(), names.device(b).toLowerCase());
  }
}

/** Sorted copy of `entries` (already in arrival order; the sort is stable so ties keep it). */
export function sortEntries(entries: readonly NetworkEntry[], sort: SortState, names?: ColumnNames): NetworkEntry[] {
  const cmp = comparatorFor(sort.key, names);
  if (!cmp) return sort.dir === 'asc' ? entries.slice() : entries.slice().reverse();
  const out = entries.slice().sort(cmp);
  if (sort.dir === 'desc') out.reverse();
  return out;
}
