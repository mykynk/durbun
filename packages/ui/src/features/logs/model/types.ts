import type { LogEntry, LogLevel, LogSource } from '@durbun/protocol';

/**
 * One rendered row of the log list. Rows are immutable: any change (fold counter, twin mark) replaces
 * the object, so memoized row components re-render exactly when their own data changed.
 */
export interface LogRow {
  /** Row key = id of the first entry (stable across updates, ordered like the store). */
  readonly id: number;
  /** First (displayed) entry. */
  readonly e: LogEntry;
  /** Identical consecutive occurrences folded into this row (×N). */
  readonly n: number;
  /** Latest folded occurrence (when n > 1). */
  readonly last?: LogEntry;
  /** App line that was also printed to the device log (app-vs-device dedupe). */
  readonly twin?: boolean;
}

export type SourceToggles = Record<LogSource, boolean>;

/** Everything that decides which store entries become rows. A new object = rebuild. */
export interface RowFilter {
  scope(e: LogEntry): boolean;
  /** Min level of the toolbar control (levelRank); lifecycle separators and markers bypass it. */
  minRank: number;
  /** Lowest level a top-level `level:` query term requires (pre-filter for every line). */
  queryMinRank: number;
  sources: SourceToggles;
  hideNoise: boolean;
  /** Compiled noise rules (true = noisy device line). */
  noise(e: LogEntry): boolean;
  showNetwork: boolean;
  query: { test(e: LogEntry): boolean; matchesAll: boolean };
  /** Hide device copies of app lines (the app row gets the "also in device log" mark). */
  dedupe: boolean;
  /** Fold identical consecutive lines into one row with a ×N counter. */
  fold: boolean;
}

/** Minimal view of the log store the row model reads (tests pass a fake). */
export interface StoreView {
  readonly entries: readonly LogEntry[];
  readonly generation: number;
  readonly lastId: number;
  lowerBound(id: number): number;
}

export interface SourceCounts {
  /** Lines per source matching scope + level + query (+ noise when hidden) — the source toggle badges. */
  device: number;
  app: number;
  system: number;
  /** Lines the noise rules match among otherwise visible lines (hidden when hideNoise). */
  noise: number;
  /** Visible marker rows (markers are global: a scope with only markers has no logs of its own). */
  markers: number;
}

export const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { verbose: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

export function rankOf(level: LogLevel): number {
  return LEVEL_RANK[level] ?? 2;
}

/** Severity tier used by the histogram and row tints. */
export const SEV_OTHER = 0;
export const SEV_WARN = 1;
export const SEV_ERROR = 2;
export type Severity = 0 | 1 | 2;

export function severityOf(level: LogLevel): Severity {
  return level === 'error' || level === 'fatal' ? SEV_ERROR : level === 'warn' ? SEV_WARN : SEV_OTHER;
}

/** Crash-like entries (loud red blocks, crash banner). */
export function isCrashKind(kind: LogEntry['kind']): boolean {
  return kind === 'crash' || kind === 'anr' || kind === 'flutter-error';
}

/** Lifecycle separators and markers — structure in time, never folded, not affected by the level control. */
export function isStructural(e: Pick<LogEntry, 'kind' | 'source'>): boolean {
  return e.kind === 'marker' || (e.source === 'system' && e.kind === 'lifecycle');
}

/** A crash reported on the next launch (iOS signal crashes, undelivered Android crashes). */
export function isPreviousLaunch(e: Pick<LogEntry, 'data' | 'kind'>): boolean {
  const d = e.data as { previousLaunch?: unknown } | null | undefined;
  return !!d && typeof d === 'object' && d.previousLaunch === true;
}
