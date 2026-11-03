import type { LogEntry, LogLevel } from '@durbun/protocol';
import type { LogRow } from './types';

/** Export of the visible (filtered) rows as plain text or JSON. Pure: callers pass localized helpers. */

const LETTER: Record<LogLevel, string> = { verbose: 'V', debug: 'D', info: 'I', warn: 'W', error: 'E', fatal: 'F' };

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2026-11-02 14:05:12.345" in local time. */
export function exportTimestamp(ts: number): string {
  if (!Number.isFinite(ts)) return '----------- --:--:--.---';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export interface TxtOptions {
  /** Display text for system lines (localized) and network rows. */
  text(e: LogEntry): string;
  /** Header lines (without the leading "# "). */
  header?: readonly string[];
}

/**
 * One entry in logcat-like form:
 *   2026-11-02 14:05:12.345 E/flutter (com.example.app 4821): message
 *       continuation line
 * System lines become "--- 14:05:12.345 text ---"-style separators; folded rows end with "  ×N".
 */
export function formatTxtEntry(e: LogEntry, opts: TxtOptions, repeat = 1): string {
  const time = exportTimestamp(e.ts);
  const suffix = repeat > 1 ? `  ×${repeat}` : '';
  if (e.source === 'system' && (e.kind === 'lifecycle' || e.kind === 'marker')) {
    return `${time} ---- ${opts.text(e)} ----${suffix}`;
  }
  const proc = e.process || e.pid !== undefined ? ` (${[e.process, e.pid].filter((x) => x !== undefined && x !== '').join(' ')})` : '';
  const text = e.kind === 'network' || e.source === 'system' ? opts.text(e) : e.message;
  const lines = text.split('\n');
  const head = `${time} ${LETTER[e.level] ?? 'I'}/${e.tag || '-'}${proc}: ${lines[0] ?? ''}${suffix}`;
  const rest = lines.slice(1).map((l) => `    ${l}`);
  if (e.error?.stack && !text.includes(e.error.stack.split('\n')[0] ?? '\u0000')) {
    for (const l of e.error.stack.split('\n')) rest.push(`    ${l}`);
  }
  return rest.length ? `${head}\n${rest.join('\n')}` : head;
}

/** One exported entry: a row's entry with its fold counter. */
interface ExportItem {
  e: LogEntry;
  n: number;
  last?: LogEntry;
}

/**
 * Rows as exported entries. A merged connection row (`LogRow.flap`) gives back each of its separators (they are
 * different events, not repeats), in arrival order among the other rows.
 */
function exportItems(rows: readonly LogRow[]): ExportItem[] {
  const out: ExportItem[] = [];
  let merged = false;
  for (const r of rows) {
    if (r.flap) {
      merged = true;
      for (const ev of r.flap.events) out.push({ e: ev, n: 1 });
    } else out.push({ e: r.e, n: r.n, last: r.last });
  }
  // A merged row sits at its newest event; its older events go back between the rows that came after them.
  if (merged) out.sort((a, b) => a.e.id - b.e.id);
  return out;
}

/** Entries an export of these rows writes (a merged connection row counts each of its events). */
export function exportCount(rows: readonly LogRow[]): number {
  let n = 0;
  for (const r of rows) n += r.flap ? r.flap.events.length : 1;
  return n;
}

/** A row as text lines ("copy as line"): a merged connection row gives one line per event. */
export function formatTxtRow(row: LogRow, opts: TxtOptions): string {
  return row.flap ? row.flap.events.map((ev) => formatTxtEntry(ev, opts)).join('\n') : formatTxtEntry(row.e, opts, row.n);
}

export function exportTxt(rows: readonly LogRow[], opts: TxtOptions): string {
  const out: string[] = [];
  for (const h of opts.header ?? []) out.push(`# ${h}`);
  if (out.length) out.push('');
  for (const it of exportItems(rows)) out.push(formatTxtEntry(it.e, opts, it.n));
  return `${out.join('\n')}\n`;
}

export interface JsonExportRow extends LogEntry {
  /** Identical consecutive occurrences folded into this row (> 1 only). */
  repeat?: number;
  /** Timestamp of the last folded occurrence. */
  lastTs?: number;
}

export function exportJsonRows(rows: readonly LogRow[]): JsonExportRow[] {
  return exportItems(rows).map((it) => (it.n > 1 ? { ...it.e, repeat: it.n, lastTs: it.last?.ts } : it.e));
}

export function exportJson(rows: readonly LogRow[], meta: Record<string, unknown> = {}): string {
  const logs = exportJsonRows(rows);
  return JSON.stringify({ format: 'durbun-logs', version: 1, ...meta, count: logs.length, logs }, null, 2);
}

/** File name like "durbun-logs-20261102-140512.txt". */
export function exportFileName(ext: 'txt' | 'json', now = Date.now()): string {
  const d = new Date(now);
  return `durbun-logs-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}
