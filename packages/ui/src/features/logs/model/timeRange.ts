import type { LogEntry } from '@durbun/protocol';
import { formatTxtRow, type TxtOptions } from './export';
import type { LogRow } from './types';

/**
 * A time window the Logs list is narrowed to: "the 30 seconds around this line" (context menu, detail panel,
 * palette) or a span dragged on the histogram with Shift. Absolute times (epoch ms, the lines' own `ts`), so the
 * window does not slide while new lines arrive; it lives in the view only and is never saved.
 */
export interface LogTimeRange {
  from: number;
  to: number;
  /** The line the window was opened around (its `ts` is the centre): the ± steps re-centre on it. */
  anchor?: { id: number; ts: number };
  /** Half width of a window around a line (ms). */
  half?: number;
}

/** "± 10 s / 30 s / 1 min / 5 min" around a line. */
export const AROUND_STEPS: readonly number[] = [10_000, 30_000, 60_000, 300_000];
export const DEFAULT_AROUND = 30_000;
/** A dragged window narrower than this is a click, not a range. */
export const MIN_RANGE_MS = 1_000;

export function rangeAround(e: Pick<LogEntry, 'id' | 'ts'>, half: number = DEFAULT_AROUND): LogTimeRange {
  return { from: e.ts - half, to: e.ts + half, anchor: { id: e.id, ts: e.ts }, half };
}

/** Two moments in any order as a range (at least MIN_RANGE_MS wide, centred when narrower). */
export function rangeBetween(a: number, b: number): LogTimeRange {
  let from = Math.min(a, b);
  let to = Math.max(a, b);
  if (to - from < MIN_RANGE_MS) {
    const mid = (from + to) / 2;
    from = mid - MIN_RANGE_MS / 2;
    to = mid + MIN_RANGE_MS / 2;
  }
  return { from: Math.floor(from), to: Math.ceil(to) };
}

export function inRange(range: Pick<LogTimeRange, 'from' | 'to'> | null | undefined, ts: number): boolean {
  return !range || (ts >= range.from && ts <= range.to);
}

/** Rows as copied text: one logcat-like line per entry (a folded row ends with ×N), oldest first. */
export function rowsAsText(rows: readonly LogRow[], opts: TxtOptions): string {
  return rows.map((r) => formatTxtRow(r, opts)).join('\n');
}
