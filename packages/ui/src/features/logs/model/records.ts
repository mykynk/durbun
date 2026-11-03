import type { LogEntry } from '@durbun/protocol';
import { formatClock, formatDateTime } from '../../../lib/format';
import { entryOrigin, isDeviceCrashRecord, isUnsymbolicated } from '../../../sources/text';

/**
 * Facts the device's own crash / ANR records carry (Android dropbox, iOS .ips — SPEC §10.3) that the rows and
 * the detail panel show, plus timestamp precision of the device log sources.
 */

type Data = Record<string, unknown> | null | undefined;

const data = (e: Pick<LogEntry, 'data'>): Data => (e.data && typeof e.data === 'object' ? (e.data as Data) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/**
 * "3.1.0 (310)" — the build the record was written for (dropbox `Package:` header, .ips app_version / build_version).
 * Undefined for live log lines and records without a version.
 */
export function crashedBuildOf(e: Pick<LogEntry, 'data' | 'origin'>): string | undefined {
  if (!isDeviceCrashRecord(e)) return undefined;
  const d = data(e);
  const version = str(d?.version);
  const build = str(d?.build);
  if (version && build && version !== build) return `${version} (${build})`;
  return version ?? (build ? `(${build})` : undefined);
}

/** `data.foreground` of a dropbox record (true / false), undefined when the record did not say. */
export function crashForeground(e: Pick<LogEntry, 'data' | 'origin'>): boolean | undefined {
  if (!isDeviceCrashRecord(e)) return undefined;
  const f = data(e)?.foreground;
  return typeof f === 'boolean' ? f : undefined;
}

const NATIVE_DROPBOX_TAGS: ReadonlySet<string> = new Set(['data_app_native_crash', 'SYSTEM_TOMBSTONE']);

/** Android native crash (tombstone) record: its frames are pc + library offsets, like an .ips. */
export function isNativeTombstone(e: Pick<LogEntry, 'data' | 'origin'>): boolean {
  if (entryOrigin(e) !== 'dropbox') return false;
  const tag = data(e)?.dropboxTag;
  return typeof tag === 'string' && NATIVE_DROPBOX_TAGS.has(tag);
}

/** A device record whose stack needs the build's symbols: .ips (unless the server says otherwise) and Android tombstones. */
export function recordUnsymbolicated(e: Pick<LogEntry, 'data' | 'origin'>): boolean {
  if (!isDeviceCrashRecord(e)) return false;
  const d = data(e);
  if (d?.symbolicated === true || d?.unsymbolicated === false) return false;
  return isUnsymbolicated(e) || isNativeTombstone(e);
}

/**
 * Device log sources that only have whole seconds: idevicesyslog prints none, dropbox keeps seconds. Their
 * timestamps are shown without a made-up ".000" (a real fraction, when a source sends one, is kept).
 */
const SECOND_ORIGINS: ReadonlySet<string> = new Set(['idevicesyslog', 'dropbox']);

export function isWholeSecond(e: Pick<LogEntry, 'ts' | 'origin' | 'data'>): boolean {
  if (e.ts % 1000 !== 0) return false;
  const o = entryOrigin(e);
  return o !== undefined && SECOND_ORIGINS.has(o);
}

/** Row clock: "22:18:47.123", or "22:18:47" for a source with whole seconds only. */
export function entryClock(e: Pick<LogEntry, 'ts' | 'origin' | 'data'>): string {
  return isWholeSecond(e) ? formatClock(e.ts, { ms: false }) : formatClock(e.ts);
}

/**
 * When a crash of an earlier launch happened, for its chip: the clock on the same day, with the date otherwise
 * (dropbox keeps a day of records, .ips any age — "19:52:20" alone would read as today).
 */
export function crashWhen(e: Pick<LogEntry, 'ts' | 'origin' | 'data'>, now = Date.now()): string {
  const a = new Date(e.ts);
  const b = new Date(now);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? entryClock(e) : formatDateTime(e.ts);
}
