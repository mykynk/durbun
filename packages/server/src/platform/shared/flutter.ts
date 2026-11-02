/**
 * Flutter-specific log handling shared by every platform:
 *  - error boxes printed by FlutterError.dumpErrorToConsole
 *      ══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═══════…
 *      …
 *      ════════════════════════════════════════…
 *    arrive one line per log record; they are grouped into ONE entry (kind 'flutter-error').
 *  - "Another exception was thrown: …" one-liners (subsequent errors) → kind 'flutter-error'.
 *  - engine lines "[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: …"
 *    → kind 'crash' (uncaught Dart error), level from the bracket.
 */
import type { LogLevel } from '@durbun/protocol';
import type { DeviceLogInput } from '../../types';

export const FLUTTER_TAG = 'flutter';
export const FLUTTER_BOX_START = '══╡ EXCEPTION CAUGHT BY';
const BOX_END_RE = /^═{20,}$/;
const ENGINE_LINE_RE = /^\[(VERBOSE-\d+|INFO|IMPORTANT|WARNING|ERROR|FATAL):flutter\//;
const ANOTHER_EXCEPTION = 'Another exception was thrown:';

const ENGINE_LEVELS: Record<string, LogLevel> = {
  INFO: 'info',
  IMPORTANT: 'info',
  WARNING: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
};

/** True for the closing rule of an error box (a line made only of '═'). */
export function isFlutterBoxEnd(line: string): boolean {
  return BOX_END_RE.test(line.trim());
}

/**
 * iOS prints Dart `print` output as "flutter: <text>" (one record per line). Returns the text without
 * the prefix, or null when the message does not start with it.
 */
export function stripFlutterPrefix(message: string): string | null {
  if (message.startsWith('flutter: ')) return message.slice(9);
  if (message === 'flutter:') return '';
  return null;
}

/** Engine log line level (e.g. "[ERROR:flutter/…]"), or undefined. */
export function flutterEngineLevel(message: string): LogLevel | undefined {
  const m = ENGINE_LINE_RE.exec(message);
  if (!m) return undefined;
  const key = m[1]!;
  return key.startsWith('VERBOSE') ? 'verbose' : ENGINE_LEVELS[key];
}

/**
 * Mark single Flutter lines that are errors. Mutates and returns the entry.
 * Applies to entries already tagged 'flutter' (or engine lines from any tag).
 */
export function classifyFlutterLine(entry: DeviceLogInput): DeviceLogInput {
  const msg = entry.message;
  if (msg.startsWith(ANOTHER_EXCEPTION)) {
    entry.kind = 'flutter-error';
    entry.level = 'error';
    return entry;
  }
  if (msg.charCodeAt(0) === 91 /* [ */) {
    const lvl = flutterEngineLevel(msg);
    if (lvl) {
      entry.level = lvl;
      if (msg.includes('Unhandled Exception:') || msg.includes('Dart Error:')) {
        entry.kind = 'crash';
        if (entry.level !== 'fatal') entry.level = 'error';
      }
    }
  }
  return entry;
}

interface OpenBox {
  first: DeviceLogInput;
  lines: string[];
  lastAt: number;
  timer?: NodeJS.Timeout;
}

export interface FlutterGrouperOptions {
  /** Close a box when no line arrived for this long (debugPrint throttles at 12 KB/s). */
  idleFlushMs?: number;
  /** Close a box after this many lines. */
  maxLines?: number;
}

/**
 * Groups Flutter error boxes per process (pid). Non-Flutter entries pass straight through, so other
 * processes' lines are never delayed; the box is emitted when its closing rule arrives.
 */
export class FlutterErrorGrouper {
  private readonly open = new Map<number, OpenBox>();
  private readonly idleFlushMs: number;
  private readonly maxLines: number;

  constructor(
    private readonly emit: (entry: DeviceLogInput) => void,
    opts: FlutterGrouperOptions = {},
  ) {
    this.idleFlushMs = opts.idleFlushMs ?? 2500;
    this.maxLines = opts.maxLines ?? 3000;
  }

  get openBoxes(): number {
    return this.open.size;
  }

  push(entry: DeviceLogInput): void {
    if (entry.tag !== FLUTTER_TAG) {
      this.emit(entry);
      return;
    }
    const key = entry.pid ?? -1;
    const box = this.open.get(key);
    const msg = entry.message;
    const startIdx = msg.indexOf(FLUTTER_BOX_START);
    if (box) {
      if (startIdx !== -1) {
        // A new box started before the previous one closed.
        this.close(key);
        this.startBox(key, entry, msg);
        return;
      }
      box.lines.push(msg);
      box.lastAt = Date.now();
      if (endsBox(msg, false) || box.lines.length >= this.maxLines) this.close(key);
      else this.arm(key, box);
      return;
    }
    if (startIdx !== -1) {
      this.startBox(key, entry, msg);
      return;
    }
    this.emit(classifyFlutterLine(entry));
  }

  /** Emit every open box as is (stop / restart). */
  flushAll(): void {
    for (const key of [...this.open.keys()]) this.close(key);
  }

  private startBox(key: number, entry: DeviceLogInput, msg: string): void {
    const box: OpenBox = { first: entry, lines: [msg], lastAt: Date.now() };
    this.open.set(key, box);
    if (endsBox(msg, true)) this.close(key);
    else this.arm(key, box);
  }

  private arm(key: number, box: OpenBox): void {
    if (box.timer) return;
    const check = () => {
      box.timer = undefined;
      if (this.open.get(key) !== box) return;
      const idle = Date.now() - box.lastAt;
      if (idle >= this.idleFlushMs - 1) this.close(key);
      else {
        box.timer = setTimeout(check, this.idleFlushMs - idle);
        box.timer.unref?.();
      }
    };
    box.timer = setTimeout(check, this.idleFlushMs);
    box.timer.unref?.();
  }

  private close(key: number): void {
    const box = this.open.get(key);
    if (!box) return;
    this.open.delete(key);
    if (box.timer) clearTimeout(box.timer);
    const entry: DeviceLogInput = {
      ...box.first,
      message: box.lines.join('\n'),
      level: 'error',
      kind: 'flutter-error',
    };
    this.emit(entry);
  }
}

/** Does this (possibly multi-line) message contain the box's closing rule? */
function endsBox(message: string, isStart: boolean): boolean {
  if (message.indexOf('\n') === -1) return !isStart && isFlutterBoxEnd(message);
  const lines = message.split('\n');
  let i = 0;
  if (isStart) {
    while (i < lines.length && !lines[i]!.includes(FLUTTER_BOX_START)) i += 1;
    i += 1;
  }
  for (; i < lines.length; i += 1) if (isFlutterBoxEnd(lines[i]!)) return true;
  return false;
}
