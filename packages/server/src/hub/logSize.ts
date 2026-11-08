/**
 * Size limits for stored log rows. An SDK frame may be 16 MB and an import 500 MB, so a single row could
 * otherwise hold a whole frame and 200 000 such rows would never fit in memory. Every row is capped when the
 * hub stores it, as the Flutter VM path already does (MAX_TEXT_CHARS in flutterVm/session.ts): text keeps its
 * first MAX_LOG_TEXT_CHARS characters and ends with "…"; a structured `data` payload that is larger than
 * MAX_LOG_DATA_CHARS as JSON becomes `{ truncated: true, size, preview }` (the field names of a truncated
 * body: `size` is the full JSON size in bytes, `preview` its beginning, ending with "…").
 * logEntryBytes() estimates what a row costs (JSON characters, plus a fixed overhead per row) for the log
 * ring's byte budget and for sizing WebSocket chunks.
 */
import type { ErrorInfo, LogEntry } from '@durbun/protocol';

/** Same limit as the Flutter VM path. */
export const MAX_LOG_TEXT_CHARS = 256 * 1024;
/** `data` larger than this as JSON (estimated) is replaced by a preview. */
export const MAX_LOG_DATA_CHARS = 256 * 1024;
/** Characters of JSON kept in the preview of truncated `data`. */
export const LOG_DATA_PREVIEW_CHARS = 64 * 1024;
/** Fixed cost of a row besides its text (object, id, ts, level, …). */
const ROW_OVERHEAD = 160;

/** Cut text to `max` characters (never inside a surrogate pair) and mark the cut with "…". */
export function capLogText(text: string, max = MAX_LOG_TEXT_CHARS): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // high surrogate: keep the pair whole
  return `${text.slice(0, end)}…`;
}

/**
 * Approximate JSON length of a value, walking it without serializing. Stops once the count passes `limit`
 * (then returns a number > limit), so it is cheap for huge values and ends on cyclic ones.
 */
export function jsonSize(value: unknown, limit = Number.MAX_SAFE_INTEGER): number {
  let size = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') size += v.length + 2;
    else if (typeof v === 'number' || typeof v === 'bigint') size += 8;
    else if (typeof v === 'boolean' || v === null || v === undefined) size += 5;
    else if (Array.isArray(v)) {
      size += 2 + v.length;
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (typeof v === 'object') {
      size += 2;
      for (const key of Object.keys(v as object)) {
        size += key.length + 4;
        stack.push((v as Record<string, unknown>)[key]);
        if (size > limit) return size;
      }
    }
    if (size > limit) return size;
  }
  return size;
}

/** `data` as stored: unchanged when small, else text cut like messages and objects replaced by a preview. */
export function capLogData(data: unknown): unknown {
  if (typeof data === 'string') return capLogText(data, MAX_LOG_DATA_CHARS);
  if (data === null || typeof data !== 'object') return data;
  if (jsonSize(data, MAX_LOG_DATA_CHARS) <= MAX_LOG_DATA_CHARS) return data;
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    json = undefined; // cyclic, BigInt, or larger than a string can be
  }
  if (json === undefined) return { truncated: true, preview: '[unserializable data]' };
  return { truncated: true, size: Buffer.byteLength(json), preview: capLogText(json, LOG_DATA_PREVIEW_CHARS) };
}

function capError(error: ErrorInfo): ErrorInfo {
  const out: ErrorInfo = { ...error };
  if (typeof out.type === 'string') out.type = capLogText(out.type, 1024);
  if (typeof out.message === 'string') out.message = capLogText(out.message);
  if (typeof out.stack === 'string') out.stack = capLogText(out.stack);
  return out;
}

const tooLong = (s: unknown, max = MAX_LOG_TEXT_CHARS) => typeof s === 'string' && s.length > max;

/** Apply the limits to a row the hub is about to store (in place; returns it). */
export function capLogEntry(entry: LogEntry): LogEntry {
  if (tooLong(entry.message)) entry.message = capLogText(entry.message);
  if (tooLong(entry.tag, 1024)) entry.tag = capLogText(entry.tag, 1024);
  if (entry.data !== undefined) entry.data = capLogData(entry.data);
  const error = entry.error;
  if (error && (tooLong(error.message) || tooLong(error.stack) || tooLong(error.type, 1024))) entry.error = capError(error);
  return entry;
}

const len = (s: unknown) => (typeof s === 'string' ? s.length : 0);

/** Estimated size of a stored row (characters of JSON plus a fixed overhead). */
export function logEntryBytes(e: LogEntry): number {
  let n = ROW_OVERHEAD + len(e.message) + len(e.tag) + len(e.deviceId) + len(e.appId) + len(e.process) + len(e.subsystem) + len(e.category);
  n += len(e.netId) + len(e.code);
  // Bounded walks: stored rows are capped already, but callers may estimate rows that are not (and cyclic ones).
  if (e.data !== undefined) n += jsonSize(e.data, 4 * MAX_LOG_DATA_CHARS);
  if (e.error) n += 32 + len(e.error.type) + len(e.error.message) + len(e.error.stack);
  if (e.params) n += jsonSize(e.params, MAX_LOG_DATA_CHARS);
  return n;
}
