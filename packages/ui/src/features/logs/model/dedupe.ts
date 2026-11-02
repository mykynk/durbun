import type { LogEntry } from '@durbun/protocol';

/**
 * App-vs-device duplicate detection (SPEC §7.3): the same text logged by the app SDK (source 'app') and
 * printed to the device log (source 'device', optionally with a "flutter: " prefix) on the same device
 * within ±2 s. Pairs are 1:1 — every occurrence pairs with at most one twin.
 *
 * Hot path (runs for every app/device line, 200 000 per rebuild): candidates are bucketed by a 31-bit
 * hash of (device, length, head, tail) of the normalized text — no string building — and the full text
 * is compared only on a hash hit.
 */

export interface DupCandidate {
  id: number;
  ts: number;
  deviceId: string;
  /** Message (shared string, kept for the full-text compare on a hash hit). */
  message: string;
  source: 'app' | 'device';
  /** Crash signature (see `crashSignature`): crash twins are compared by it instead of the text. */
  sig?: string;
  /** Row the entry is shown in (its own row or the folded row), -1 when not visible. */
  rowId: number;
  paired: boolean;
  /** Bucket chain (newest first). */
  hash: number;
  prev: DupCandidate | undefined;
}

const FLUTTER_PREFIX = 'flutter: ';

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

/** Comparable text = without a leading "flutter: " and trailing whitespace: [normStart, normEnd). */
function normStart(message: string): number {
  return message.startsWith(FLUTTER_PREFIX) ? FLUTTER_PREFIX.length : 0;
}
function normEnd(message: string, start: number): number {
  let end = message.length;
  while (end > start && isSpace(message.charCodeAt(end - 1))) end--;
  return end;
}

/** Text used to compare an app line with its device copy. */
export function dedupeText(message: string): string {
  const s = normStart(message);
  const e = normEnd(message, s);
  return s === 0 && e === message.length ? message : message.slice(s, e);
}

/** Same comparable text, compared in place (no allocation). */
export function sameDedupeText(a: string, b: string): boolean {
  const as = normStart(a);
  const ae = normEnd(a, as);
  const bs = normStart(b);
  const be = normEnd(b, bs);
  if (ae - as !== be - bs) return false;
  for (let i = 0; i < ae - as; i++) if (a.charCodeAt(as + i) !== b.charCodeAt(bs + i)) return false;
  return true;
}

const HEAD = 24;
const TAIL = 8;

/**
 * 31-bit FNV-1a over the length, the first 24 and the last 8 characters of the comparable text. The
 * device and the full text are compared on a hit, so collisions only cost a compare.
 */
export function dedupeHash(e: Pick<LogEntry, 'message'>): number {
  const m = e.message;
  const s = normStart(m);
  const end = normEnd(m, s);
  let h = Math.imul(0x811c9dc5 ^ (end - s), 0x01000193);
  const headEnd = Math.min(end, s + HEAD);
  for (let i = s; i < headEnd; i++) h = Math.imul(h ^ m.charCodeAt(i), 0x01000193);
  for (let i = Math.max(headEnd, end - TAIL); i < end; i++) h = Math.imul(h ^ m.charCodeAt(i), 0x01000193);
  return h >>> 1;
}

/**
 * Crash / ANR records the device kept itself (Android dropbox, iOS .ips) that the server matched to a live
 * crash line it already delivered (same pid or package within ±5 s, SPEC §10.3): `data.duplicateOf` = the
 * live entry's id. Hidden like the other duplicates (shown again when de-duplication is off).
 */
export function isMarkedDuplicate(e: Pick<LogEntry, 'data'>): boolean {
  const d = e.data as { duplicateOf?: unknown } | null | undefined;
  if (!d || typeof d !== 'object') return false;
  const v = d.duplicateOf;
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length > 0);
}

/** Entries that can have an app/device twin. */
export function isDedupeCandidate(e: Pick<LogEntry, 'source' | 'kind' | 'message'>): boolean {
  if (e.source !== 'app' && e.source !== 'device') return false;
  const k = e.kind;
  if (k === 'network' || k === 'event' || k === 'marker' || k === 'lifecycle') return false;
  return e.message.length > 0;
}

/* ───────────── crash twins ───────────── */

const ENGINE_PREFIX = '[ERROR:flutter/';
const UNHANDLED = /Unhandled exception:\s*(.+?)\s*$/i;
const TERMINATING = /Terminating app due to uncaught exception '([^']+)'/;
const EXCEPTION_CLASS = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Exception|Error|Throwable|Failure)[\w$]*)(?::|$)/;
const PREV_LAUNCH = /^(Crash in previous launch|Previous launch crashed)/;
const QUALIFIED_CLASS = /\b([a-z][\w$]*(?:\.[\w$]+)+(?:Exception|Error|Throwable))\b/;

/**
 * Identity of a crash that the app SDK reports and the device log prints in its own words, e.g. Flutter
 * `Unhandled exception: X` (SDK) vs `[ERROR:flutter/runtime/…] Unhandled Exception: X\n#0 …` (engine),
 * Android SDK `java.lang.IllegalStateException: …` vs the AndroidRuntime `FATAL EXCEPTION: main` group,
 * iOS NSException vs `*** Terminating app due to uncaught exception 'X'`. Returns null for anything that
 * is not crash-like (cheap: only `kind: 'crash'` and Flutter engine error lines are looked at) and for
 * reports of a previous launch (their device copy, if any, is from another launch).
 */
export function crashSignature(e: Pick<LogEntry, 'source' | 'kind' | 'message' | 'error' | 'data'>): string | null {
  if (e.source !== 'app' && e.source !== 'device') return null;
  const m = e.message;
  if (e.kind !== 'crash' && !(e.source === 'device' && m.charCodeAt(0) === 91 && m.startsWith(ENGINE_PREFIX))) return null;
  const d = e.data as { previousLaunch?: unknown } | null | undefined;
  if ((d && typeof d === 'object' && d.previousLaunch === true) || PREV_LAUNCH.test(m)) return null;
  const nl = m.indexOf('\n');
  const first = nl < 0 ? m : m.slice(0, nl);
  const u = UNHANDLED.exec(first);
  if (u) return `u:${u[1]}`;
  const term = TERMINATING.exec(m);
  if (term) return `c:${term[1]}`;
  const type = e.error?.type;
  if (type && /(Exception|Error|Throwable|Failure)/.test(type) && !type.startsWith('_')) return `c:${type}`;
  const lines = m.split('\n', 8);
  for (const l of lines) {
    const x = EXCEPTION_CLASS.exec(l);
    if (x) return `c:${x[1]}`;
  }
  // `FATAL EXCEPTION in thread "main": java.lang.X: …` — a qualified class name anywhere on the first line.
  const q = QUALIFIED_CLASS.exec(first);
  return q ? `c:${q[1]}` : null;
}

/** 31-bit FNV-1a of a crash signature (separate seed from `dedupeHash`). */
export function signatureHash(sig: string): number {
  let h = 0x9dc5811c;
  for (let i = 0; i < sig.length; i++) h = Math.imul(h ^ sig.charCodeAt(i), 0x01000193);
  return h >>> 1;
}

/**
 * Whether two entries are the app and device copies of the same line or crash (same device, opposite
 * sources, within `windowMs`). Used where the row model's index is not available (crash banner).
 */
export function isTwinPair(a: LogEntry, b: LogEntry, windowMs = 2000): boolean {
  if (a.deviceId !== b.deviceId || Math.abs(a.ts - b.ts) > windowMs) return false;
  if (!((a.source === 'app' && b.source === 'device') || (a.source === 'device' && b.source === 'app'))) return false;
  const sa = crashSignature(a);
  const sb = crashSignature(b);
  if (sa !== null || sb !== null) return sa === sb;
  return sameDedupeText(a.message, b.message);
}

const SLOTS = 8192;
const MASK = SLOTS - 1;
/** Candidates kept per bucket (newest first) — twins arrive close together, older ones age out. */
const CHAIN = 6;

/**
 * Fixed-size hash table of recent candidates: no per-entry Map/array allocations and implicit eviction
 * (each bucket keeps its newest few candidates), so it stays cheap at 200 000 lines per rebuild.
 */
export class DupIndex {
  private slots: (DupCandidate | undefined)[] = new Array(SLOTS);

  constructor(readonly windowMs = 2000) {}

  /**
   * Unpaired opposite-source candidate on the same device within the time window with the same text — or,
   * for crashes (`sig` given), the same crash signature.
   */
  match(e: LogEntry, hash: number, sig?: string): DupCandidate | undefined {
    let c = this.slots[hash & MASK];
    for (let steps = 0; c && steps < CHAIN; steps++, c = c.prev) {
      if (c.hash !== hash || c.paired || c.source === e.source || Math.abs(c.ts - e.ts) > this.windowMs) continue;
      if (c.deviceId !== e.deviceId) continue;
      if (sig !== undefined ? c.sig === sig : c.sig === undefined && sameDedupeText(c.message, e.message)) return c;
    }
    return undefined;
  }

  add(cand: DupCandidate): void {
    const i = cand.hash & MASK;
    cand.prev = this.slots[i];
    this.slots[i] = cand;
    let c: DupCandidate | undefined = cand;
    for (let k = 1; k < CHAIN && c; k++) c = c.prev;
    if (c) c.prev = undefined;
  }

  clear(): void {
    this.slots = new Array(SLOTS);
  }
}
