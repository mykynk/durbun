import type { LogEntry } from '@durbun/protocol';
import { findJsonPayload, looksLikeStackTrace } from '../query';
import { isFrameLine } from './frames';
import { isPreviousLaunch } from './types';

/**
 * Per-entry message analysis for "no walls of text" (SPEC §1.1-3): the one-line headline, how many lines
 * are folded away, embedded JSON payloads, stack traces, dumps and crash headlines (§9.4 formats).
 * Computed lazily for rendered rows only and cached per entry object.
 */

export interface JsonPayload {
  value: unknown;
  /** Text before / after the payload inside the message ('' when the payload is `entry.data`). */
  before: string;
  after: string;
  /** From `entry.data` (structured SDK payload) rather than the message text. */
  fromData: boolean;
}

export interface CrashSummary {
  kind: 'crash' | 'anr' | 'flutter-error';
  /** Most telling line, e.g. "java.lang.IllegalStateException: Fragment … not attached". */
  title: string;
  /** Secondary info: ANR reason, Flutter library, thread. */
  detail?: string;
  previousLaunch: boolean;
}

export interface EntryAnalysis {
  /** First line to show (crash/flutter-error headline for those kinds). */
  headline: string;
  /** Lines in the message. */
  lines: number;
  /** Lines hidden behind "+N lines" (message lines after the first one). */
  extra: number;
  /** Stack trace text (error.stack or the frame lines of the message), when present. */
  stack: string | null;
  /** Number of frame lines in `stack`. */
  frames: number;
  json: JsonPayload | null;
  /** Dump-like output (widget/render tree, thread dump, view hierarchy…) — folds to its first line. */
  dump: boolean;
  crash: CrashSummary | null;
}

const cache = new WeakMap<LogEntry, EntryAnalysis>();
/** Cap for text work on huge messages (the detail panel shows everything). */
const MAX_SCAN = 200_000;

export function analyzeEntry(e: LogEntry): EntryAnalysis {
  let a = cache.get(e);
  if (!a) {
    a = compute(e);
    cache.set(e, a);
  }
  return a;
}

function countLines(text: string): number {
  let n = 1;
  let i = text.indexOf('\n');
  while (i >= 0 && i < text.length - 1) {
    n++;
    i = text.indexOf('\n', i + 1);
  }
  return n;
}

function firstLine(text: string): string {
  const i = text.indexOf('\n');
  return (i < 0 ? text : text.slice(0, i)).replace(/\r$/, '');
}

const DUMP_HEAD = /^(Widget tree|Render tree|Layer tree|Semantics tree|Focus tree|Thread dump|View hierarchy|UserDefaults|Remote config)\b/i;

export function isDumpText(message: string, tag?: string): boolean {
  const head = firstLine(message);
  if (DUMP_HEAD.test(head)) return true;
  if ((tag === 'ui' || tag === 'userdefaults') && message.includes('\n')) return true;
  return /^\S.*\(\d+ (lines|satır)\)\s*$/.test(head) && message.includes('\n');
}

function messageStack(message: string): { text: string; frames: number } | null {
  const lines = message.split('\n');
  let frames = 0;
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFrameLine(lines[i]!)) {
      frames++;
      if (first < 0) first = i;
    }
  }
  if (frames < 2 || first < 0) return null;
  return { text: lines.slice(first).join('\n'), frames };
}

function countFrames(stack: string): number {
  let n = 0;
  for (const l of stack.split('\n')) if (isFrameLine(l)) n++;
  return n;
}

function isContainerValue(v: unknown): boolean {
  return v !== null && typeof v === 'object';
}

function compute(e: LogEntry): EntryAnalysis {
  const message = e.message.length > MAX_SCAN ? e.message.slice(0, MAX_SCAN) : e.message;
  const lines = countLines(message);
  const crash = e.kind === 'crash' || e.kind === 'anr' || e.kind === 'flutter-error' ? crashSummary(e) : null;
  const dump = !crash && lines > 1 && isDumpText(message, e.tag);

  let stack: string | null = null;
  let frames = 0;
  if (!dump) {
    if (e.error?.stack) {
      stack = e.error.stack;
      frames = countFrames(stack);
    } else if (lines > 2 && looksLikeStackTrace(e)) {
      const s = messageStack(message);
      if (s) {
        stack = s.text;
        frames = s.frames;
      }
    }
  }

  let json: JsonPayload | null = null;
  if (isContainerValue(e.data) && e.kind !== 'event' && e.source !== 'system') {
    json = { value: e.data, before: '', after: '', fromData: true };
  } else if (!dump && !crash && (message.includes('{') || message.includes('['))) {
    const p = findJsonPayload(message);
    if (p && isContainerValue(p.value)) json = { value: p.value, before: message.slice(0, p.start), after: message.slice(p.end), fromData: false };
  }

  let headline = crash ? crash.title : firstLine(message);
  let extra = Math.max(0, lines - 1);
  if (json && !json.fromData && !json.before.includes('\n')) {
    // Payload starts on the first line: show "prefix {preview}" instead of the raw JSON text; only the
    // lines after the payload fold away.
    headline = json.before.trimEnd();
    extra = newlines(json.after.trimEnd());
  }
  return { headline, lines, extra, stack, frames, json, dump, crash };
}

function newlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/* ───────────── crash headlines (SPEC §9.4) ───────────── */

const PREV_PREFIXES = ['Crash in previous launch: ', 'Previous launch crashed — ', 'Previous launch crashed - '];

function stripPreviousPrefix(s: string): string {
  for (const p of PREV_PREFIXES) if (s.startsWith(p)) return s.slice(p.length);
  return s;
}

const EXCEPTION_LINE = /^\s*([A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(Exception|Error|Throwable|Failure)[\w$]*)(:.*)?$/;

export function crashSummary(e: LogEntry): CrashSummary {
  const kind = (e.kind === 'anr' || e.kind === 'flutter-error' ? e.kind : 'crash') as CrashSummary['kind'];
  const msg = e.message;
  const first = firstLine(msg);
  const previousLaunch = isPreviousLaunch(e) || PREV_PREFIXES.some((p) => first.startsWith(p));

  if (kind === 'flutter-error') return flutterSummary(e, previousLaunch);

  if (kind === 'anr') {
    const m = /ANR in (\S+)/.exec(first);
    const reason = /^Reason:\s*(.+)$/m.exec(msg)?.[1];
    return { kind, title: m ? `ANR in ${m[1]}` : first, detail: reason ? shorten(reason, 160) : undefined, previousLaunch };
  }

  const body = stripPreviousPrefix(first);
  // iOS crash report (.ips): "<App> <version> (<build>) crashed: <why>" — the row names the app and the build
  // itself, so the headline is the reason only.
  if (originOf(e) === 'crash-report') {
    const i = body.indexOf(' crashed: ');
    if (i > 0 && body.length > i + 10) return { kind, title: body.slice(i + 10).trim(), previousLaunch };
  }
  // Device AndroidRuntime group: "FATAL EXCEPTION: main\nProcess: …, PID: …\njava.lang.X: msg\n\tat …"
  const fatalDevice = /^FATAL EXCEPTION:\s*(.+)$/.exec(body);
  if (fatalDevice) {
    const lines = msg.split('\n');
    const exc = lines.slice(1, 6).find((l) => !/^\s*(Process|PID):/.test(l) && EXCEPTION_LINE.test(l));
    return { kind, title: (exc ?? lines[2] ?? body).trim(), detail: `thread ${fatalDevice[1]!.trim()}`, previousLaunch };
  }
  // Android SDK: FATAL EXCEPTION in thread "main": java.lang.X: msg
  const fatalSdk = /^FATAL EXCEPTION in thread "([^"]*)":\s*(.+)$/.exec(body);
  if (fatalSdk) return { kind, title: fatalSdk[2]!.trim(), detail: `thread ${fatalSdk[1]}`, previousLaunch };
  // iOS: *** Terminating app due to uncaught exception 'X', reason: 'Y'
  const term = /Terminating app due to uncaught exception '([^']+)', reason: '(.*)'/.exec(msg);
  if (term) return { kind, title: `${term[1]}: ${term[2]}`, previousLaunch };
  // Flutter engine: [ERROR:flutter/runtime/…] Unhandled Exception: X
  const engine = /\]\s*(Unhandled Exception:.*)$/.exec(body);
  if (engine) return { kind, title: engine[1]!.trim(), previousLaunch };
  // Native tombstone / signals
  if (/^\*\*\* \*\*\* \*\*\*/.test(body) || /Fatal signal/.test(msg)) {
    const sig = /(Fatal signal .*)$/m.exec(msg)?.[1];
    const abort = (e.data as { abortMessage?: unknown } | undefined)?.abortMessage;
    return { kind, title: (sig ?? body).trim(), detail: typeof abort === 'string' ? shorten(abort, 160) : undefined, previousLaunch };
  }
  if (!body.trim() && e.error?.message) return { kind, title: `${e.error.type ? `${e.error.type}: ` : ''}${e.error.message}`, previousLaunch };
  return { kind, title: body.trim() || (e.error?.message ?? ''), previousLaunch };
}

function originOf(e: LogEntry): string | undefined {
  if (e.origin) return e.origin;
  const d = e.data as { origin?: unknown } | null | undefined;
  return d && typeof d === 'object' && typeof d.origin === 'string' ? d.origin : undefined;
}

function flutterSummary(e: LogEntry, previousLaunch: boolean): CrashSummary {
  const msg = e.message;
  const first = firstLine(msg);
  const lib = /EXCEPTION CAUGHT BY ([A-Z ]+?)\s*╞/.exec(first)?.[1];
  const detail = lib ? lib.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;
  if (e.error?.message) return { kind: 'flutter-error', title: e.error.message.trim(), detail, previousLaunch };
  const another = /^Another exception was thrown:\s*(.+)$/.exec(first);
  if (another) return { kind: 'flutter-error', title: another[1]!.trim(), previousLaunch };
  if (lib) {
    // "The following assertion was thrown during layout:" → the next non-empty line is the summary.
    const lines = msg.split('\n');
    const i = lines.findIndex((l) => /^The following .* (was thrown|caught)/.test(l));
    const next = i >= 0 ? lines.slice(i + 1).find((l) => l.trim()) : undefined;
    if (next) return { kind: 'flutter-error', title: next.trim(), detail, previousLaunch };
  }
  return { kind: 'flutter-error', title: first.trim(), detail, previousLaunch };
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ───────────── JSON preview ───────────── */

const IDENT = /^[A-Za-z_$][\w$]*$/;

function primPreview(v: unknown, maxStr = 24): string {
  if (typeof v === 'string') return JSON.stringify(v.length > maxStr ? `${v.slice(0, maxStr)}…` : v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

/**
 * Compact one-line preview of a JSON value: `{ userId: 42, items: [3], name: "Ali", … }`,
 * `[ {…}, {…}, … 20 ]`.
 */
export function jsonPreview(value: unknown, max = 72): string {
  if (!isContainerValue(value)) return primPreview(value);
  const parts: string[] = [];
  let len = 4;
  let more = false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = primPreview(value[i]);
      if (len + p.length + 2 > max && parts.length > 0) {
        more = true;
        break;
      }
      parts.push(p);
      len += p.length + 2;
    }
    if (parts.length === 0) return '[]';
    return `[ ${parts.join(', ')}${more ? `, … ${value.length}` : ''} ]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) {
    const p = `${IDENT.test(k) ? k : JSON.stringify(k)}: ${primPreview(v)}`;
    if (len + p.length + 2 > max && parts.length > 0) {
      more = true;
      break;
    }
    parts.push(p);
    len += p.length + 2;
  }
  if (parts.length === 0) return '{}';
  return `{ ${parts.join(', ')}${more ? ', …' : ''} }`;
}
