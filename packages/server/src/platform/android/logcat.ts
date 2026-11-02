/**
 * logcat parsing for `adb logcat -v threadtime -v epoch -v printable`.
 *
 * Line shapes handled (AOSP liblog/logprint.cpp, FORMAT_THREADTIME = "%s %5d %5d %c %-8s: "):
 *   epoch:    "      1730541781.123  1234  1250 I ActivityManager: Start proc …"
 *   classic:  "11-02 11:43:01.123  1234  1250 D flutter : hello"
 *   year:     "2026-11-02 11:43:01.123456  1234  1250 W Foo     : …"   (+ optional zone "+0300",
 *             optional uid column "u0_a190" when -v uid is used)
 *   brief:    "I/ActivityManager( 1234): …"  (fallback)
 *   noise:    "--------- beginning of main" / "--------- switch to crash" → ignored
 *
 * A multi-line log record is printed as several lines with an identical header; LogcatMerger joins
 * them back (holding the pending record ≤ 60 ms).
 */
import type { LogLevel } from '@durbun/protocol';
import type { DeviceLogInput } from '../../types';
import { FlutterErrorGrouper } from '../shared/flutter';

export interface LogcatLine {
  /** Epoch ms (fractional for µs/ns precision). */
  ts: number;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
  /** Raw header text (timestamp … "tag: ") used to merge identical headers. */
  header: string;
}

const LEVELS: Record<string, LogLevel> = {
  V: 'verbose',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'fatal',
  A: 'fatal',
  S: 'verbose',
};

// Anchored, no nested quantifiers → linear time on any input.
const THREADTIME_RE =
  /^\s*(?:(\d{1,12})\.(\d{1,9})|(?:(\d{4})-)?(\d\d)-(\d\d)\s+(\d\d):(\d\d):(\d\d)\.(\d{1,9})(?:\s?([+-]\d{4}))?)\s+(?:(\S+)\s+)??(\d+)\s+(\d+)\s+([VDIWEFAS])\s/;
const BRIEF_RE = /^([VDIWEFAS])\/([^(]*)\(\s*(\d+)\): ?(.*)$/;
const DAY_MS = 86_400_000;

/** Reverse `-v printable` escaping of backslashes ("\\" → "\"); other escapes stay visible. */
export function unescapePrintable(s: string): string {
  if (s.indexOf('\\\\') === -1) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const j = s.indexOf('\\', i);
    if (j === -1 || j === s.length - 1) {
      out += s.slice(i);
      return out;
    }
    if (s.charCodeAt(j + 1) === 92) {
      out += s.slice(i, j + 1);
      i = j + 2;
    } else {
      out += s.slice(i, j + 2);
      i = j + 2;
    }
  }
}

let classicCacheKey = '';
let classicCacheMs = 0;

function fractionMs(frac: string): number {
  if (frac.length === 3) return Number(frac);
  return Number(frac) / 10 ** (frac.length - 3);
}

function classicTime(
  year: string | undefined,
  month: string,
  day: string,
  hh: string,
  mm: string,
  ss: string,
  zone: string | undefined,
  nowMs: number,
): number {
  const key = `${year ?? ''}|${month}|${day}|${hh}|${mm}|${ss}|${zone ?? ''}`;
  if (key === classicCacheKey) return classicCacheMs;
  const mo = Number(month) - 1;
  const d = Number(day);
  const h = Number(hh);
  const mi = Number(mm);
  const s = Number(ss);
  const compute = (y: number): number => {
    if (zone) {
      const sign = zone[0] === '-' ? -1 : 1;
      const offMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
      return Date.UTC(y, mo, d, h, mi, s) - offMin * 60_000;
    }
    return new Date(y, mo, d, h, mi, s).getTime();
  };
  let ms: number;
  if (year) ms = compute(Number(year));
  else {
    const y = new Date(nowMs).getFullYear();
    ms = compute(y);
    // "12-31 23:59:59" read on Jan 1st belongs to the previous year.
    if (ms > nowMs + 2 * DAY_MS) ms = compute(y - 1);
  }
  classicCacheKey = key;
  classicCacheMs = ms;
  return ms;
}

/** Parse one logcat output line; null for separators/garbage. */
export function parseLogcatLine(line: string, nowMs = Date.now()): LogcatLine | null {
  const m = THREADTIME_RE.exec(line);
  if (!m) return parseBrief(line, nowMs);
  let ts: number;
  if (m[1] !== undefined) {
    ts = Number(m[1]) * 1000 + fractionMs(m[2]!);
  } else {
    ts = classicTime(m[3], m[4]!, m[5]!, m[6]!, m[7]!, m[8]!, m[10], nowMs) + fractionMs(m[9]!);
  }
  const level = LEVELS[m[14]!]!;
  const restStart = m[0].length;
  const sep = line.indexOf(': ', restStart);
  let tag: string;
  let message: string;
  let headerEnd: number;
  if (sep === -1) {
    if (line.endsWith(':')) {
      tag = line.slice(restStart, -1);
      message = '';
    } else {
      tag = line.slice(restStart);
      message = '';
    }
    headerEnd = line.length;
  } else {
    tag = line.slice(restStart, sep);
    message = line.slice(sep + 2);
    headerEnd = sep + 2;
  }
  return {
    ts,
    pid: Number(m[12]),
    tid: Number(m[13]),
    level,
    tag: tag.trimEnd(),
    message: unescapePrintable(message),
    header: line.slice(0, headerEnd),
  };
}

function parseBrief(line: string, nowMs: number): LogcatLine | null {
  if (line.length < 5 || line.charCodeAt(1) !== 47 /* / */) return null;
  const m = BRIEF_RE.exec(line);
  if (!m) return null;
  return {
    ts: nowMs,
    pid: Number(m[3]),
    tid: Number(m[3]),
    level: LEVELS[m[1]!]!,
    tag: m[2]!.trimEnd(),
    message: unescapePrintable(m[4]!),
    header: line.slice(0, line.length - m[4]!.length),
  };
}

/** True for "--------- beginning of main" style separators. */
export function isLogcatSeparator(line: string): boolean {
  return line.startsWith('--------- ');
}

/* ───────────────────────────── merging ───────────────────────────── */

/**
 * Joins consecutive lines that share an identical header (one multi-line log record). The pending
 * record is held at most `holdMs`.
 */
export class LogcatMerger {
  private pending?: LogcatLine;
  private extra: string[] | null = null;
  private pendingSince = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly emit: (line: LogcatLine) => void,
    private readonly holdMs = 60,
  ) {}

  push(line: LogcatLine): void {
    const p = this.pending;
    if (p && p.header === line.header) {
      (this.extra ??= []).push(line.message);
      return;
    }
    if (p) this.flush();
    this.pending = line;
    this.pendingSince = Date.now();
    this.arm();
  }

  flush(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    if (this.extra) {
      p.message = p.message + '\n' + this.extra.join('\n');
      this.extra = null;
    }
    this.emit(p);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(this.onTimer, this.holdMs);
    this.timer.unref?.();
  }

  private readonly onTimer = (): void => {
    this.timer = undefined;
    if (!this.pending) return;
    const age = Date.now() - this.pendingSince;
    if (age >= this.holdMs - 1) this.flush();
    else {
      this.timer = setTimeout(this.onTimer, this.holdMs - age);
      this.timer.unref?.();
    }
  };
}

/* ───────────────────────── restart boundary de-dup ───────────────────────── */

/**
 * After a restart with `-T <last epoch>` logcat repeats the lines at that timestamp; drop the ones
 * already delivered (and anything older) until the stream moves past the boundary.
 */
export class BoundaryDeduper {
  private lastTs = -Infinity;
  private atLast = new Set<string>();
  private resuming = false;

  get lastTimestamp(): number | undefined {
    return Number.isFinite(this.lastTs) ? this.lastTs : undefined;
  }

  /** Call right before restarting logcat with `-T lastTimestamp`. */
  beginResume(): void {
    if (Number.isFinite(this.lastTs)) this.resuming = true;
  }

  accept(line: LogcatLine, raw: string): boolean {
    if (this.resuming) {
      if (line.ts < this.lastTs) return false;
      if (line.ts === this.lastTs) {
        if (this.atLast.has(raw)) return false;
      } else this.resuming = false;
    }
    if (line.ts > this.lastTs) {
      this.lastTs = line.ts;
      this.atLast.clear();
      this.atLast.add(raw);
    } else if (line.ts === this.lastTs && this.atLast.size < 4000) {
      this.atLast.add(raw);
    }
    return true;
  }
}

/** `-T` argument for resuming after `ts` (epoch seconds with ms). */
export function logcatSinceArg(ts: number): string {
  const ms = Math.floor(ts);
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
}

/* ───────────────────────────── classification ───────────────────────────── */

export interface ProcessEvent {
  pid: number;
  name: string;
  event: 'started' | 'died';
  ts: number;
}

const START_PROC_RE = /^Start proc (\d+):([^\s/]+)\//;
const START_PROC_OLD_RE = /^Start proc ([^\s:]+(?::[^\s]+)?) for [^:]*: pid=(\d+)/;
const DIED_RE = /^Process (\S+) \(pid (\d+)\) has died/;
const KILLING_RE = /^Killing (\d+):([^\s/]+)\//;
const ZYGOTE_EXIT_RE = /^Process (\d+) exited (?:due to signal|cleanly)/;
const ANR_RE = /^ANR in (\S+)/;
const ANR_PID_RE = /(?:^|\n)PID: (\d+)/;
const TOMBSTONE_START = '*** *** ***';
const TOMBSTONE_PID_RE = /pid: (\d+), tid: (\d+), name: (.*?)\s+>>> (.+?) <<</;
const TOMBSTONE_SIGNAL_RE = /signal (\d+) \((\w+)\)/;
const TOMBSTONE_ABORT_RE = /Abort message: '([^\n]*)'/;
const JAVA_CRASH_PROCESS_RE = /Process: ([^\s,]+), PID: (\d+)/;

/** Process start/death announced by ActivityManager / Zygote, or null. */
export function detectProcessEvent(
  tag: string,
  message: string,
  ts: number,
  nameOf: (pid: number) => string | undefined,
): ProcessEvent | null {
  if (tag === 'ActivityManager' || tag === 'ProcessList' || tag === 'ActivityManagerService') {
    const c0 = message.charCodeAt(0);
    if (c0 === 83 /* S */) {
      let m = START_PROC_RE.exec(message);
      if (m) return { pid: Number(m[1]), name: m[2]!, event: 'started', ts };
      m = START_PROC_OLD_RE.exec(message);
      if (m) return { pid: Number(m[2]), name: m[1]!, event: 'started', ts };
    } else if (c0 === 80 /* P */) {
      const m = DIED_RE.exec(message);
      if (m) return { pid: Number(m[2]), name: m[1]!, event: 'died', ts };
    } else if (c0 === 75 /* K */) {
      const m = KILLING_RE.exec(message);
      if (m) return { pid: Number(m[1]), name: m[2]!, event: 'died', ts };
    }
    return null;
  }
  if (tag === 'Zygote' && message.charCodeAt(0) === 80) {
    const m = ZYGOTE_EXIT_RE.exec(message);
    if (m) {
      const pid = Number(m[1]);
      const name = nameOf(pid);
      if (name) return { pid, name, event: 'died', ts };
    }
  }
  return null;
}

interface Group {
  first: DeviceLogInput;
  lines: string[];
  lastTs: number;
  lastAt: number;
  timer?: NodeJS.Timeout;
}

/**
 * Groups Java crashes (AndroidRuntime "FATAL EXCEPTION") and native tombstones (tag DEBUG, from the
 * "*** *** ***" banner, per reporting pid, lines ≤ 2 s apart) into single 'crash' entries, and marks
 * ActivityManager "ANR in" records as 'anr'. Other entries pass through untouched.
 */
export class AndroidCrashGrouper {
  private java?: Group;
  private readonly tombstones = new Map<number, Group>();

  constructor(
    private readonly emit: (entry: DeviceLogInput) => void,
    private readonly javaIdleMs = 400,
    private readonly tombstoneWindowMs = 2000,
  ) {}

  push(e: DeviceLogInput): void {
    const tag = e.tag;
    if (this.java) {
      const j = this.java;
      if (e.pid === j.first.pid) {
        if (tag === 'AndroidRuntime' && !e.message.startsWith('FATAL EXCEPTION')) {
          j.lines.push(e.message);
          j.lastAt = Date.now();
          return;
        }
        this.closeJava();
      }
    }
    if (tag === 'AndroidRuntime' && e.message.startsWith('FATAL EXCEPTION')) {
      this.closeJava();
      const g: Group = { first: e, lines: [e.message], lastTs: e.ts, lastAt: Date.now() };
      this.java = g;
      this.armJava(g);
      return;
    }
    if (tag === 'DEBUG' || tag === 'crash_dump64' || tag === 'crash_dump32') {
      const key = e.pid ?? -1;
      const open = this.tombstones.get(key);
      if (e.message.includes(TOMBSTONE_START)) {
        if (open) this.closeTombstone(key);
        const g: Group = { first: e, lines: [e.message], lastTs: e.ts, lastAt: Date.now() };
        this.tombstones.set(key, g);
        this.armTombstone(key, g);
        return;
      }
      if (open && e.ts - open.lastTs <= this.tombstoneWindowMs) {
        open.lines.push(e.message);
        open.lastTs = e.ts;
        open.lastAt = Date.now();
        return;
      }
      if (open) this.closeTombstone(key);
    }
    if (tag === 'ActivityManager' && e.message.charCodeAt(0) === 65 /* A */) {
      const m = ANR_RE.exec(e.message);
      if (m) {
        e.kind = 'anr';
        if (e.level !== 'fatal') e.level = 'error';
        const pidM = ANR_PID_RE.exec(e.message);
        e.data = { reporterPid: e.pid, package: m[1] };
        if (pidM) {
          e.pid = Number(pidM[1]);
          e.process = m[1];
          e.tid = undefined;
        }
      }
    }
    this.emit(e);
  }

  /** Emit everything that is still being grouped. */
  flushAll(): void {
    this.closeJava();
    for (const key of [...this.tombstones.keys()]) this.closeTombstone(key);
  }

  private armJava(g: Group): void {
    const check = () => {
      g.timer = undefined;
      if (this.java !== g) return;
      const idle = Date.now() - g.lastAt;
      if (idle >= this.javaIdleMs - 1) this.closeJava();
      else {
        g.timer = setTimeout(check, this.javaIdleMs - idle);
        g.timer.unref?.();
      }
    };
    g.timer = setTimeout(check, this.javaIdleMs);
    g.timer.unref?.();
  }

  private armTombstone(key: number, g: Group): void {
    const check = () => {
      g.timer = undefined;
      if (this.tombstones.get(key) !== g) return;
      const idle = Date.now() - g.lastAt;
      if (idle >= this.tombstoneWindowMs - 1) this.closeTombstone(key);
      else {
        g.timer = setTimeout(check, this.tombstoneWindowMs - idle);
        g.timer.unref?.();
      }
    };
    g.timer = setTimeout(check, this.tombstoneWindowMs);
    g.timer.unref?.();
  }

  private closeJava(): void {
    const g = this.java;
    if (!g) return;
    this.java = undefined;
    if (g.timer) clearTimeout(g.timer);
    const message = g.lines.join('\n');
    const entry: DeviceLogInput = { ...g.first, message, kind: 'crash', level: 'fatal' };
    const pm = JAVA_CRASH_PROCESS_RE.exec(message);
    if (pm) {
      entry.process = entry.process ?? pm[1];
      entry.data = { crashedProcess: pm[1], crashedPid: Number(pm[2]) };
    }
    this.emit(entry);
  }

  private closeTombstone(key: number): void {
    const g = this.tombstones.get(key);
    if (!g) return;
    this.tombstones.delete(key);
    if (g.timer) clearTimeout(g.timer);
    const message = g.lines.join('\n');
    const entry: DeviceLogInput = { ...g.first, message, kind: 'crash', level: 'fatal' };
    const data: Record<string, unknown> = { reporterPid: g.first.pid };
    const pm = TOMBSTONE_PID_RE.exec(message);
    if (pm) {
      // Attribute the crash to the crashed process so app-scoped views show it.
      entry.pid = Number(pm[1]);
      entry.tid = Number(pm[2]);
      entry.process = pm[4]!.trim();
      data.thread = pm[3]!.trim();
    }
    const sm = TOMBSTONE_SIGNAL_RE.exec(message);
    if (sm) data.signal = sm[2];
    const am = TOMBSTONE_ABORT_RE.exec(message);
    if (am) data.abortMessage = am[1];
    entry.data = data;
    this.emit(entry);
  }
}

/* ───────────────────────────── full pipeline ───────────────────────────── */

export interface AndroidPipelineHooks {
  /** Final entries in arrival order (→ batcher → hub). */
  emit(entry: DeviceLogInput): void;
  /** Process start/death seen in the log. */
  onProcessEvent?(ev: ProcessEvent): void;
  /** pid → process name (for filling `process`). */
  processName?(pid: number): string | undefined;
}

/**
 * raw line → parse → restart de-dup → merge identical headers → process events → crash/ANR grouping →
 * Flutter error boxes → emit.
 */
export class AndroidLogPipeline {
  private readonly dedupe = new BoundaryDeduper();
  private readonly merger: LogcatMerger;
  private readonly crashes: AndroidCrashGrouper;
  private readonly flutter: FlutterErrorGrouper;
  /** Lines that were not logcat records (diagnostics). */
  unparsed = 0;

  constructor(private readonly hooks: AndroidPipelineHooks) {
    this.flutter = new FlutterErrorGrouper((e) => hooks.emit(e));
    this.crashes = new AndroidCrashGrouper((e) => this.flutter.push(e));
    this.merger = new LogcatMerger((line) => this.onRecord(line));
  }

  /** Epoch ms of the newest record seen (for `-T` resume). */
  get lastTimestamp(): number | undefined {
    return this.dedupe.lastTimestamp;
  }

  /** Prepare for a logcat restart that resumes at `lastTimestamp`. */
  beginResume(): void {
    this.merger.flush();
    this.dedupe.beginResume();
  }

  pushLine(raw: string): void {
    if (raw.length === 0) return;
    const rec = parseLogcatLine(raw);
    if (!rec) {
      if (isLogcatSeparator(raw)) return;
      this.unparsed += 1;
      const text = raw.trim();
      if (!text) return;
      this.hooks.emit({ ts: Date.now(), level: 'warn', tag: 'logcat', message: text });
      return;
    }
    if (!this.dedupe.accept(rec, raw)) return;
    this.merger.push(rec);
  }

  /** Flush everything held for merging/grouping (stop, restart). */
  flush(): void {
    this.merger.flush();
    this.crashes.flushAll();
    this.flutter.flushAll();
  }

  dispose(): void {
    this.merger.dispose();
    this.crashes.flushAll();
    this.flutter.flushAll();
  }

  private onRecord(rec: LogcatLine): void {
    const entry: DeviceLogInput = {
      ts: rec.ts,
      level: rec.level,
      tag: rec.tag,
      message: rec.message,
      pid: rec.pid,
      tid: rec.tid,
    };
    const name = this.hooks.processName?.(rec.pid);
    if (name) entry.process = name;
    const ev = detectProcessEvent(rec.tag, rec.message, rec.ts, (pid) => this.hooks.processName?.(pid));
    if (ev) this.hooks.onProcessEvent?.(ev);
    this.crashes.push(entry);
  }
}
