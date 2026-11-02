/**
 * Content analysis shared by `is:json` / `is:stacktrace` and the Logs view (JSON previews, folded stack
 * traces). Both functions run per entry while filtering 200 000 rows, so they bail out early and never
 * allocate on the common path.
 */
import type { LogEntry } from '@durbun/protocol';

/** At most this many characters are scanned per message (a JSON payload larger than this is not detected). */
export const JSON_SCAN_LIMIT = 1_000_000;
/** At most this many balanced candidates are handed to JSON.parse per message. */
const MAX_PARSE_ATTEMPTS = 6;

/** ASCII characters that may appear outside strings in JSON text. */
const JSON_OUTSIDE = new Uint8Array(128);
for (const ch of ' \t\n\r0123456789+-.eE,:{}[]truefalsn') JSON_OUTSIDE[ch.charCodeAt(0)] = 1;

let lastScanned = 0;

/**
 * End (exclusive) of the balanced object/array starting at `start`, or -1. Strings and escapes are
 * respected; a character that cannot appear in JSON outside a string ends the scan early.
 */
function matchBalanced(s: string, start: number, limit: number): number {
  const stack: number[] = [];
  let i = start;
  for (; i < limit; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 /* " */) {
      for (i++; i < limit; i++) {
        const d = s.charCodeAt(i);
        if (d === 92 /* \ */) {
          i++;
          continue;
        }
        if (d === 34) break;
        if (d < 32) {
          lastScanned = i - start;
          return -1; // raw control character (newline) inside a string: not JSON
        }
      }
      if (i >= limit) break;
      continue;
    }
    if (c === 123 /* { */) stack.push(125);
    else if (c === 91 /* [ */) stack.push(93);
    else if (c === 125 || c === 93) {
      if (stack.pop() !== c) {
        lastScanned = i - start;
        return -1;
      }
      if (stack.length === 0) {
        lastScanned = i + 1 - start;
        return i + 1;
      }
    } else if (c >= 128 || JSON_OUTSIDE[c] === 0) {
      lastScanned = i - start;
      return -1;
    }
  }
  lastScanned = i - start;
  return -1;
}

/** The first non-blank character after the opener can start JSON content (`{"…`, `[1…`, `[{…`). */
function plausibleStart(s: string, i: number): boolean {
  const open = s.charCodeAt(i);
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13) j++;
    else break;
  }
  if (j >= n) return false;
  const c = s.charCodeAt(j);
  if (open === 123) return c === 34;
  return c === 34 || c === 123 || c === 91 || c === 45 || (c >= 48 && c <= 57) || c === 116 || c === 102 || c === 110;
}

/** A payload worth showing: an object with keys, or an array with ≥ 2 items or a nested container. */
function isPayload(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.length >= 2 || (v.length === 1 && v[0] !== null && typeof v[0] === 'object');
  for (const _ in v as Record<string, unknown>) return true;
  return false;
}

/**
 * Location of the first JSON object/array payload inside a message (balanced braces/brackets that
 * JSON.parse accepts, at least `{}`/`[]` with content), or null. Used for `is:json` and by the Logs view to
 * render a JSON preview. Fast path: messages without `{` / `[` return immediately; candidates whose first
 * character cannot start JSON (`{id: 1}`, `[main]`) are skipped without scanning; truncated payloads → null.
 */
export function findJsonPayload(message: string): { start: number; end: number; value: unknown } | null {
  if (typeof message !== 'string' || message.length < 2) return null;
  let nextObj = message.indexOf('{');
  let nextArr = message.indexOf('[');
  if (nextObj < 0 && nextArr < 0) return null;
  const n = message.length;
  let attempts = 0;
  let budget = JSON_SCAN_LIMIT;
  while (attempts < MAX_PARSE_ATTEMPTS && budget > 0 && (nextObj >= 0 || nextArr >= 0)) {
    let start: number;
    if (nextArr < 0 || (nextObj >= 0 && nextObj < nextArr)) {
      start = nextObj;
      nextObj = message.indexOf('{', start + 1);
    } else {
      start = nextArr;
      nextArr = message.indexOf('[', start + 1);
    }
    if (!plausibleStart(message, start)) continue;
    const end = matchBalanced(message, start, Math.min(n, start + budget));
    budget -= Math.max(1, lastScanned);
    if (end < 0) continue;
    attempts++;
    let value: unknown;
    try {
      value = JSON.parse(message.slice(start, end));
    } catch {
      continue;
    }
    if (isPayload(value)) return { start, end, value };
  }
  return null;
}

/* ───────────────────────────── stack traces ───────────────────────────── */

const FRAME_PATTERNS = [
  // Android native backtrace (tombstone): `#00 pc 000000000004f0f4  /apex/…/libc.so (abort+164)`
  String.raw`#\d+[ \t]+pc[ \t]+[0-9a-fA-F]+[ \t]+\S`,
  // Dart VM: `#0      PaymentService.charge (package:pati/core/payment/payment_service.dart:88:7)`
  String.raw`#\d+[ \t]+\S.*\((?:package|dart|file|org-dartlang-[\w-]+|https?):[^)]*\)[ \t]*$`,
  // Dart terse (package:stack_trace): `package:pati/core/api.dart 74:28   PatiApiClient._send`
  String.raw`(?:package|dart):\S+[ \t]+\d+(?::\d+)?[ \t]+\S`,
  // Java/Kotlin `at a.b.C.m(C.kt:12)` / `(Native Method)`; JS (V8, Hermes) `at fn (file.js:1:2)`, `at file.js:1:2`
  String.raw`at[ \t]+\S.*?(?::\d+\)?|\((?:Native Method|Unknown Source|native|<anonymous>)\))[ \t]*$`,
  // JS (JavaScriptCore, Firefox): `render@http://localhost:8081/index.bundle:1234:56`
  String.raw`[^\s@]*@\S*:\d+:\d+[ \t]*$`,
  // Apple (Swift/ObjC): `3   UIKitCore    0x00000001850c4e2c -[UIApplication sendEvent:] + 268`
  String.raw`\d+[ \t]+\S.*?[ \t]0x[0-9a-fA-F]{6,}[ \t]+\S`,
];
/** Anchored at a line start (sticky); `$` = end of line (multiline). */
const FRAME_RE = new RegExp(`[ \\t]*(?:${FRAME_PATTERNS.join('|')})`, 'my');
/** ObjC `*** First throw call stack:` followed by `(0x180b21234 0x18015b3d8 …)` on one line. */
const ADDRESS_LIST_RE = /[ \t]*\((?:0x[0-9a-fA-F]+[ \t]*){3,}\)/y;
const MAX_LINES = 400;

/** Whether one line of text looks like a stack frame (any supported platform). */
export function isStackFrameLine(line: string): boolean {
  FRAME_RE.lastIndex = 0;
  return FRAME_RE.test(line);
}

/**
 * Whether an entry carries a stack trace: `error.stack` non-empty, or ≥ 2 message lines that look like
 * frames (Dart `#0 …`, Java/Kotlin `at a.b(File.kt:1)`, JS `at fn (file:1:2)` / `fn@file:1:2`, Apple
 * `3 UIKitCore 0x…`, Android native `#00 pc …`), or an ObjC address list `(0x… 0x… 0x…)`.
 */
export function looksLikeStackTrace(entry: Pick<LogEntry, 'message' | 'error'>): boolean {
  const stack = entry.error?.stack;
  if (typeof stack === 'string' && stack.trim() !== '') return true;
  const m = entry.message;
  if (typeof m !== 'string') return false;
  let nl = m.indexOf('\n');
  if (nl < 0) return false; // one line cannot hold two frames
  let start = 0;
  let frames = 0;
  for (let line = 0; line < MAX_LINES; line++) {
    FRAME_RE.lastIndex = start;
    if (FRAME_RE.test(m)) {
      if (++frames >= 2) return true;
    } else {
      ADDRESS_LIST_RE.lastIndex = start;
      if (ADDRESS_LIST_RE.test(m)) return true;
    }
    if (nl < 0) break;
    start = nl + 1;
    nl = m.indexOf('\n', start);
  }
  return false;
}
