/**
 * Android crash / ANR / tombstone records from `dumpsys dropbox` (SPEC §10.3) — works for any build,
 * release and store builds included, and covers crashes that happened while no cable was plugged in.
 *
 * Output shapes (DropBoxManagerService.dump, Android 5 … 15):
 *   listing  `dumpsys dropbox <tag>`:  "2026-11-02 11:43:03 data_app_crash (text, 1874 bytes)" + a
 *            4-space-indented 70-char preview line per text entry.
 *   print    `dumpsys dropbox --print <tag> [yyyy-MM-dd] [HH:mm:ss]`: per record
 *            "========================================" / the header line above / the record text /
 *            one blank line. Extra args are ANDed ("date contains arg || arg == tag").
 *   record   "Process: com.foo\nPID: 4321\nUID: …\nFlags: 0x38c8be46\nPackage: com.foo v42 (2.3.1)\n
 *            Foreground: Yes\n…Subject: …(ANR)\nBuild: …\n\n<body>" (data_app_*), or BootReceiver headers
 *            "Build:/Hardware:/Revision:/Bootloader:/Radio:/Kernel:" + tombstone text (SYSTEM_TOMBSTONE).
 *
 * Cost: one listing call for the four tags every 30 s; `--print` (filtered to the exact second of each new
 * record) only when the listing shows something new.
 */
import type { ErrorInfo, LogEntry } from '@durbun/protocol';
import type { DeviceLogInput, HubSink, Logger } from '../../types';
import { sleep } from '../shared/timing';
import type { Adb } from './adb';
import { basePackage, type CrashAppMeta } from './deviceApps';
import { deviceLocalToEpoch, type DeviceClock } from './deviceClock';
import { READER_CODES, type ReaderReport } from './readers';

export const DROPBOX_TAGS = ['data_app_crash', 'data_app_anr', 'data_app_native_crash', 'SYSTEM_TOMBSTONE'] as const;
export type DropboxTag = (typeof DROPBOX_TAGS)[number];
const TAG_SET = new Set<string>(DROPBOX_TAGS);
const NATIVE_TAGS = new Set<string>(['data_app_native_crash', 'SYSTEM_TOMBSTONE']);

export const DROPBOX_SEP = '___DURBUN_DROPBOX___';
const RECORD_SEP = '========================================';

export const DROPBOX_TIMING = {
  /** First read after the device comes online (lets the logcat tail arrive first for de-duplication). */
  initialDelayMs: 4000,
  intervalMs: 30_000,
  /** Wait before matching a fresh record against live logcat crashes (grouping holds them ~0.4–2 s). */
  settleMs: 1500,
  /** On connect: records of the last 24 h. */
  lookbackMs: 24 * 3600_000,
  /** When the dropbox service refuses us (OEM restriction). */
  unavailableIntervalMs: 5 * 60_000,
  /** More distinct seconds than this in one tag → print the whole tag once instead. */
  maxPrintsPerCall: 20,
};

/** Same pid within this window = same crash (pids are not reused that fast). */
export const DEDUPE_PID_WINDOW_MS = 30_000;
/** Same package within ±5 s (+1 s: dropbox prints whole seconds). */
export const DEDUPE_PACKAGE_WINDOW_MS = 6_000;

const HEADER_RE =
  /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (\S+) \((?:(compressed )?(text|data), (\d+) bytes|contents lost|no file)\)\s*$/;
/** Every real dump starts with "Drop box contents: N entries"; an empty search ends with "(No entries found.)". */
const DUMP_RE = /^Drop box contents: \d+|^\(No entries found\.\)/m;
const REFUSED_RE = /Permission Denial|SecurityException|Can't find service: dropbox|not allowed/i;

/** The line saying why dumpsys refused us (OEM restriction / missing permission), when it did. */
function refusalOf(out: string): string | undefined {
  if (!REFUSED_RE.test(out)) return undefined;
  return out.split('\n').find((l) => REFUSED_RE.test(l))?.trim() ?? 'refused';
}

function firstLine(out: string): string {
  return (out.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

/* ───────────────────────────── parsers ───────────────────────────── */

export interface DropboxHeader {
  tag: string;
  /** Device-local "yyyy-MM-dd HH:mm:ss". */
  date: string;
  /** Occurrence of this tag + second in the listing (several records can share a second). */
  index: number;
  /** Readable text entry (not binary / lost). */
  text: boolean;
  bytes?: number;
}

export function dropboxKey(h: Pick<DropboxHeader, 'tag' | 'date' | 'index'>): string {
  return `${h.tag}|${h.date}|${h.index}`;
}

/** Header lines of one or more `dumpsys dropbox <tag>` listings. */
export function parseDropboxListing(text: string): DropboxHeader[] {
  const out: DropboxHeader[] = [];
  const counts = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const m = HEADER_RE.exec(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (!m) continue;
    const date = m[1]!;
    const tag = m[2]!;
    const k = `${tag}|${date}`;
    const index = counts.get(k) ?? 0;
    counts.set(k, index + 1);
    const h: DropboxHeader = { tag, date, index, text: m[4] === 'text' };
    if (m[5]) h.bytes = Number(m[5]);
    out.push(h);
  }
  return out;
}

export interface DropboxRecord extends DropboxHeader {
  /** "Key: value" lines before the first blank line (first value wins). */
  headers: Record<string, string>;
  /** Every "Package:" header ("com.foo v42 (2.3.1)"). */
  packages: string[];
  body: string;
}

const HEADER_FIELD_RE = /^([A-Z][A-Za-z0-9-]*): ?(.*)$/;

function buildRecord(h: DropboxHeader, lines: string[]): DropboxRecord {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end -= 1;
  const headers: Record<string, string> = {};
  const packages: string[] = [];
  let i = 0;
  for (; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      break;
    }
    const m = HEADER_FIELD_RE.exec(line);
    if (!m) break;
    if (m[1] === 'Package') packages.push(m[2]!.trim());
    else if (!(m[1]! in headers)) headers[m[1]!] = m[2]!.trim();
  }
  return { ...h, headers, packages, body: lines.slice(i, end).join('\n') };
}

/** Records of one or more `dumpsys dropbox --print …` outputs (chunks may be separated by DROPBOX_SEP). */
export function parseDropboxPrint(text: string): DropboxRecord[] {
  const out: DropboxRecord[] = [];
  const counts = new Map<string, number>();
  let cur: { h: DropboxHeader; lines: string[] } | undefined;
  let expectHeader = false;
  const close = () => {
    if (cur) out.push(buildRecord(cur.h, cur.lines));
    cur = undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === RECORD_SEP) {
      close();
      expectHeader = true;
      continue;
    }
    if (line.trim() === DROPBOX_SEP) {
      close();
      expectHeader = false;
      continue;
    }
    if (expectHeader) {
      expectHeader = false;
      const m = HEADER_RE.exec(line);
      if (m) {
        const date = m[1]!;
        const tag = m[2]!;
        const k = `${tag}|${date}`;
        const index = counts.get(k) ?? 0;
        counts.set(k, index + 1);
        if (m[4] === 'text') {
          const h: DropboxHeader = { tag, date, index, text: true };
          if (m[5]) h.bytes = Number(m[5]);
          cur = { h, lines: [] };
        }
      }
      continue;
    }
    if (cur) {
      if (cur.lines.length < 20_000) cur.lines.push(line);
    }
  }
  close();
  return out;
}

/* ───────────────────────────── record → LogEntry ───────────────────────────── */

const MAX_MESSAGE = 64 * 1024;
const TOMBSTONE_PID_RE = /^pid: (\d+), tid: (\d+), name: (.*?)\s+>>> (.+?) <<<\s*$/m;
const CMDLINE_RE = /^Cmdline: (\S.*)$/m;
const SIGNAL_RE = /^signal (\d+) \(([A-Z0-9]+)\)[^\n]*$/m;
const ABORT_RE = /^Abort message: '(.*?)'?\s*$/m;
const CAUSE_RE = /^Cause: (.+)$/m;
const PACKAGE_HEADER_RE = /^(\S+)(?: v(\d+))?(?: \((.*)\))?\s*$/;

export interface DropboxCrash {
  tag: string;
  key: string;
  ts: number;
  kind: 'crash' | 'anr';
  pkg?: string;
  process?: string;
  pid?: number;
  meta: CrashAppMeta;
  entry: DeviceLogInput & { data: Record<string, unknown> };
}

function cap(text: string, max = MAX_MESSAGE): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function intOf(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseJavaThrowable(body: string): ErrorInfo {
  const first = body.split('\n').find((l) => l.trim())?.trim() ?? '';
  const colon = first.indexOf(': ');
  const head = colon === -1 ? first : first.slice(0, colon);
  const err: ErrorInfo = {};
  if (/^[\w$.]+$/.test(head) && head.includes('.')) {
    err.type = head;
    if (colon !== -1) err.message = first.slice(colon + 2);
  } else if (first) err.message = first;
  if (body.trim()) err.stack = cap(body.trim());
  return err;
}

function mainThreadStack(body: string): string | undefined {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^"main" /.test(l));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() !== '' && end - start < 400) end += 1;
  return lines.slice(start, end).join('\n');
}

interface NativeInfo {
  pid?: number;
  process?: string;
  thread?: string;
  signal?: string;
  signalLine?: string;
  abortMessage?: string;
  cause?: string;
  frames: string[];
}

function parseTombstone(body: string): NativeInfo {
  const info: NativeInfo = { frames: [] };
  const pm = TOMBSTONE_PID_RE.exec(body);
  if (pm) {
    info.pid = Number(pm[1]);
    info.thread = pm[3]!.trim();
    info.process = pm[4]!.trim();
  }
  if (!info.process) {
    const cm = CMDLINE_RE.exec(body);
    if (cm) info.process = cm[1]!.trim().split(/\s+/)[0];
  }
  const sm = SIGNAL_RE.exec(body);
  if (sm) {
    info.signal = sm[2];
    info.signalLine = sm[0].trim();
  }
  const am = ABORT_RE.exec(body);
  if (am) info.abortMessage = am[1];
  const cm = CAUSE_RE.exec(body);
  if (cm) info.cause = cm[1]!.trim();
  const lines = body.split('\n');
  const bt = lines.findIndex((l) => /^\s*backtrace:\s*$/.test(l));
  if (bt !== -1) {
    for (let i = bt + 1; i < lines.length && info.frames.length < 128; i++) {
      const l = lines[i]!;
      if (/^\s+#\d+\s/.test(l)) info.frames.push(l.trim());
      // debuggerd prints "  NOTE: … unreadable libraries …" lines between "backtrace:" and the frames.
      else if (info.frames.length === 0 && (l.trim() === '' || /^\s*NOTE:/.test(l))) continue;
      else break;
    }
  }
  return info;
}

/**
 * One dropbox record → LogEntry input (kind crash/anr, origin 'dropbox'); undefined for tags we do not
 * handle. `watchStart` marks records older than the device connection as `previousLaunch`.
 */
export function dropboxToCrash(rec: DropboxRecord, clock: DeviceClock, watchStart: number): DropboxCrash | undefined {
  if (!TAG_SET.has(rec.tag)) return undefined;
  const ts = deviceLocalToEpoch(rec.date, clock);
  if (ts === undefined) return undefined;
  const h = rec.headers;
  const pkgHeader = rec.packages[0] ? PACKAGE_HEADER_RE.exec(rec.packages[0]) : null;
  let process = h['Process']?.trim() || undefined;
  let pid = intOf(h['PID']);
  const kind: 'crash' | 'anr' = rec.tag === 'data_app_anr' ? 'anr' : 'crash';
  const data: Record<string, unknown> = { origin: 'dropbox', dropboxTag: rec.tag };
  let error: ErrorInfo;
  let message: string;

  if (rec.tag === 'data_app_crash') {
    error = parseJavaThrowable(rec.body);
    message = cap(rec.body.trim() || error.message || 'App crashed');
  } else if (rec.tag === 'data_app_anr') {
    const subject = h['Subject']?.trim();
    const firstLine = rec.body.split('\n').find((l) => l.trim())?.trim();
    message = subject || firstLine || 'Application Not Responding';
    error = { type: 'ANR', message };
    const stack = mainThreadStack(rec.body) ?? (rec.body.trim() ? rec.body.split('\n').slice(0, 80).join('\n') : undefined);
    if (stack) error.stack = cap(stack);
  } else {
    const nat = parseTombstone(rec.body);
    process = process ?? nat.process;
    pid = pid ?? nat.pid;
    if (nat.signal) data.signal = nat.signal;
    if (nat.abortMessage !== undefined) data.abortMessage = nat.abortMessage;
    if (nat.thread) data.thread = nat.thread;
    const parts = [
      nat.signalLine ?? 'Native crash',
      nat.abortMessage !== undefined ? `Abort message: '${nat.abortMessage}'` : undefined,
      nat.cause ? `Cause: ${nat.cause}` : undefined,
      nat.frames.length ? `backtrace:\n  ${nat.frames.join('\n  ')}` : undefined,
    ].filter((x): x is string => !!x);
    message = cap(parts.join('\n'));
    error = { type: nat.signal ?? 'native crash' };
    const em = nat.abortMessage || nat.cause || nat.signalLine;
    if (em) error.message = em;
    if (nat.frames.length) error.stack = nat.frames.join('\n');
  }

  const pkg = (pkgHeader ? pkgHeader[1] : undefined) ?? basePackage(process);
  const previousLaunch = ts + 1000 <= watchStart;
  if (pkg) data.package = pkg;
  if (process) data.process = process;
  if (pid !== undefined) data.pid = pid;
  data.reportTs = ts;
  data.previousLaunch = previousLaunch;
  const meta: CrashAppMeta = { reportTs: ts };
  if (pkgHeader && pkgHeader[1] === pkg) {
    if (pkgHeader[3]) meta.version = data.version = pkgHeader[3];
    if (pkgHeader[2]) meta.build = data.build = pkgHeader[2];
  }
  const flags = h['Flags'] ? Number.parseInt(h['Flags'], 16) : NaN;
  if (Number.isFinite(flags)) meta.debuggable = data.debuggable = (flags & 0x2) !== 0; // ApplicationInfo.FLAG_DEBUGGABLE
  if (h['Foreground']) data.foreground = /^yes$/i.test(h['Foreground']);

  const entry: DropboxCrash['entry'] = {
    ts,
    level: kind === 'anr' ? 'error' : 'fatal',
    tag: rec.tag,
    message,
    kind,
    origin: 'dropbox',
    error,
    data,
  };
  if (process) entry.process = process;
  // Old records: the pid may belong to another process by now — keep it in data only.
  if (pid !== undefined && !previousLaunch) entry.pid = pid;
  const out: DropboxCrash = { tag: rec.tag, key: dropboxKey(rec), ts, kind, meta, entry };
  if (pkg) out.pkg = pkg;
  if (process) out.process = process;
  if (pid !== undefined) out.pid = pid;
  return out;
}

/* ───────────────────────────── de-duplication ───────────────────────────── */

interface IndexedCrash {
  id: number;
  kind: 'crash' | 'anr';
  pid?: number;
  pkg?: string;
  ts: number;
  origin: 'logcat' | 'dropbox';
  fatal: boolean;
  dropboxTag?: string;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Recent crash / ANR entries of one device (fed from the hub's onLogs tap). */
export class CrashIndex {
  private items: IndexedCrash[] = [];

  constructor(private readonly deviceId: string) {}

  get size(): number {
    return this.items.length;
  }

  add(e: LogEntry): void {
    if ((e.kind !== 'crash' && e.kind !== 'anr') || e.deviceId !== this.deviceId) return;
    const data = rec(e.data);
    let origin: IndexedCrash['origin'];
    if (e.origin === 'dropbox') origin = 'dropbox';
    else if (e.origin === 'logcat' || (e.origin === undefined && e.source === 'device')) origin = 'logcat';
    else return;
    if (origin === 'dropbox' && data.duplicateOf !== undefined) return;
    const it: IndexedCrash = { id: e.id, kind: e.kind, ts: e.ts, origin, fatal: e.level === 'fatal' };
    const pid = origin === 'dropbox' ? numOf(data.pid) : (e.pid ?? numOf(data.crashedPid));
    if (pid !== undefined) it.pid = pid;
    const pkg = strOf(data.package) ?? basePackage(e.process) ?? basePackage(strOf(data.crashedProcess));
    if (pkg) it.pkg = pkg;
    if (origin === 'dropbox') it.dropboxTag = strOf(data.dropboxTag);
    this.items.push(it);
    if (this.items.length > 600) this.items.splice(0, 200);
  }

  /** The entry a dropbox record duplicates (live logcat preferred), or undefined. */
  findDuplicate(c: Pick<DropboxCrash, 'kind' | 'pid' | 'pkg' | 'ts' | 'tag'>): { id: number; origin: 'logcat' | 'dropbox' } | undefined {
    let best: IndexedCrash | undefined;
    let bestScore = Infinity;
    for (const it of this.items) {
      if (it.kind !== c.kind) continue;
      const dt = Math.abs(it.ts - c.ts);
      let match: boolean;
      if (it.origin === 'logcat') {
        match =
          (c.pid !== undefined && it.pid === c.pid && dt <= DEDUPE_PID_WINDOW_MS) ||
          (c.pkg !== undefined && it.pkg === c.pkg && dt <= DEDUPE_PACKAGE_WINDOW_MS);
      } else {
        // One native crash is filed twice: data_app_native_crash (ActivityManager) + SYSTEM_TOMBSTONE.
        match =
          it.dropboxTag !== c.tag &&
          NATIVE_TAGS.has(it.dropboxTag ?? '') &&
          NATIVE_TAGS.has(c.tag) &&
          c.pid !== undefined &&
          it.pid === c.pid &&
          dt <= DEDUPE_PID_WINDOW_MS;
      }
      if (!match) continue;
      const score = dt + (it.origin === 'logcat' ? 0 : 1e9) + (it.fatal || c.kind === 'anr' ? 0 : 1e8);
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    return best ? { id: best.id, origin: best.origin } : undefined;
  }
}

/* ───────────────────────────── watcher ───────────────────────────── */

/** Per-device memory of records already turned into log entries (survives unplug / replug). */
export interface DropboxCursor {
  seen: Map<string, number>;
}

export function createDropboxCursor(): DropboxCursor {
  return { seen: new Map() };
}

export interface DropboxApps {
  ready(): Promise<boolean>;
  isThirdParty(pkg: string): boolean | undefined;
  isSystem(pkg: string): boolean;
  noteCrash(pkg: string, meta: CrashAppMeta): void;
}

export interface DropboxWatcherDeps {
  adb: () => Adb | null;
  serial: string;
  deviceId: string;
  hub: Pick<HubSink, 'pushDeviceLogs'>;
  logger: Logger;
  cursor: DropboxCursor;
  clock: DeviceClock;
  /** Epoch ms when Dürbün started watching this device (→ previousLaunch). */
  watchStart: () => number;
  apps: DropboxApps;
  crashes: CrashIndex;
  /** Outcome of each poll (→ DeviceInfo.readers.crashReports); repeats are expected, the receiver dedupes. */
  onReader?: (report: ReaderReport) => void;
}

export class DropboxWatcher {
  private timer?: NodeJS.Timeout;
  private active = false;
  private gen = 0;
  private polling?: Promise<void>;
  private everRead = false;
  private failures = 0;
  /** Live logcat crashes a dropbox record was already counted for (a native crash is filed twice). */
  private readonly countedLive = new Set<number>();
  /** Why the dropbox cannot be read on this device (permission / OEM), when it cannot. */
  unavailable?: string;
  /** Successful listings (diagnostics / tests). */
  polls = 0;

  constructor(private readonly deps: DropboxWatcherDeps) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    const gen = ++this.gen;
    this.schedule(DROPBOX_TIMING.initialDelayMs, gen);
  }

  stop(): void {
    this.active = false;
    this.gen += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One poll right now (tests / manual refresh). */
  pollNow(): Promise<void> {
    return this.runPoll(this.gen);
  }

  private schedule(ms: number, gen: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runPoll(gen).finally(() => {
        if (gen === this.gen && this.active) {
          this.schedule(this.unavailable ? DROPBOX_TIMING.unavailableIntervalMs : DROPBOX_TIMING.intervalMs, gen);
        }
      });
    }, ms);
    this.timer.unref?.();
  }

  private runPoll(gen: number): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll(gen)
      .catch((e: Error) => this.deps.logger.debug(`${this.deps.serial}: dropbox poll failed: ${e.message}`))
      .finally(() => {
        this.polling = undefined;
      });
    return this.polling;
  }

  private readerOk(): void {
    this.everRead = true;
    this.failures = 0;
    this.deps.onReader?.({ status: 'ok' });
  }

  private readerRefused(detail: string): void {
    this.unavailable = detail;
    this.deps.logger.debug(`${this.deps.serial}: dropbox unavailable: ${detail}`);
    this.deps.onReader?.({ status: 'unavailable', code: READER_CODES.dropboxRefused, detail });
  }

  /** Reported at once until the dropbox was read once; after that only two in a row (one adb hiccup is no news). */
  private readerFailed(detail: string): void {
    this.failures += 1;
    this.deps.logger.debug(`${this.deps.serial}: ${detail}`);
    if (!this.everRead || this.failures >= 2) {
      this.deps.onReader?.({ status: 'unavailable', code: READER_CODES.crashReportsFailed, detail });
    }
  }

  private async poll(gen: number): Promise<void> {
    const { deps } = this;
    const adb = deps.adb();
    if (!adb) return;
    const ready = await deps.apps.ready();
    if (gen !== this.gen) return;
    if (!ready) {
      this.readerFailed('The installed apps could not be listed (pm list packages), so crash records cannot be matched to apps');
      return;
    }
    const listCmd = DROPBOX_TAGS.map((t) => `dumpsys dropbox ${t}`).join(`; echo ${DROPBOX_SEP}; `);
    const list = await adb.shell(deps.serial, listCmd, { timeoutMs: 15_000 });
    if (gen !== this.gen) return;
    const out = list.stdout;
    if (!out.trim()) {
      const why = list.error ?? list.stderr.trim();
      this.readerFailed(`dumpsys dropbox gave no output${why ? `: ${why}` : ''}`);
      return;
    }
    const headers = parseDropboxListing(out);
    if (!headers.length) {
      const refusal = refusalOf(out);
      if (refusal) {
        this.readerRefused(refusal);
        return;
      }
      if (!DUMP_RE.test(out)) {
        this.readerFailed(`dumpsys dropbox printed something unexpected: ${firstLine(out)}`);
        return;
      }
    }
    this.unavailable = undefined;
    this.polls += 1;
    const now = Date.now();
    const wanted = new Map<string, DropboxHeader[]>();
    for (const h of headers) {
      if (!h.text || !TAG_SET.has(h.tag)) continue;
      const key = dropboxKey(h);
      if (deps.cursor.seen.has(key)) continue;
      const ts = deviceLocalToEpoch(h.date, deps.clock);
      if (ts === undefined || ts < now - DROPBOX_TIMING.lookbackMs) continue;
      let list2 = wanted.get(h.tag);
      if (!list2) wanted.set(h.tag, (list2 = []));
      list2.push(h);
    }
    this.prune(now);
    if (!wanted.size) {
      this.readerOk();
      return;
    }

    const crashes: DropboxCrash[] = [];
    let printRefused: string | undefined;
    let printFailed: string | undefined;
    for (const [tag, hs] of wanted) {
      const dates = [...new Set(hs.map((h) => h.date))];
      const cmd =
        dates.length > DROPBOX_TIMING.maxPrintsPerCall
          ? `dumpsys dropbox --print ${tag}`
          : dates.map((d) => `dumpsys dropbox --print ${tag} ${d}`).join(`; echo ${DROPBOX_SEP}; `);
      const r = await adb.shell(deps.serial, cmd, { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
      if (gen !== this.gen) return;
      if (!r.stdout.trim()) {
        const why = r.error ?? r.stderr.trim();
        printFailed = `dumpsys dropbox --print ${tag} gave no output${why ? `: ${why}` : ''}`;
        continue; // retry next poll
      }
      const records = parseDropboxPrint(r.stdout);
      if (!records.length) {
        // Listing allowed, printing refused (OEM): keep the records for when reading works again.
        const refusal = refusalOf(r.stdout);
        if (refusal) {
          printRefused = refusal;
          continue;
        }
      }
      const keys = new Set(hs.map(dropboxKey));
      for (const record of records) {
        if (record.tag !== tag || !keys.has(dropboxKey(record))) continue;
        const c = dropboxToCrash(record, deps.clock, deps.watchStart());
        if (c) crashes.push(c);
      }
      // Mark everything we asked for as handled (a record deleted meanwhile must not be retried forever).
      for (const h of hs) deps.cursor.seen.set(dropboxKey(h), deviceLocalToEpoch(h.date, deps.clock) ?? now);
    }
    if (printRefused) this.readerRefused(printRefused);
    else if (printFailed) this.readerFailed(printFailed);
    else this.readerOk();
    if (!crashes.length) return;
    crashes.sort((a, b) => a.ts - b.ts);
    if (crashes.some((c) => c.ts > now - 120_000)) {
      await sleep(DROPBOX_TIMING.settleMs);
      if (gen !== this.gen) return;
    }
    for (const c of crashes) {
      if (!this.accept(c)) continue;
      const dup = deps.crashes.findDuplicate(c);
      if (dup) c.entry.data.duplicateOf = dup.id;
      deps.hub.pushDeviceLogs(deps.deviceId, [c.entry]);
      // One crash, one report: data_app_native_crash + SYSTEM_TOMBSTONE of a crash seen live both link to
      // the logcat entry (dropbox copies with duplicateOf are not indexed), so count the first only.
      const counted = dup !== undefined && (dup.origin === 'dropbox' || this.countedLive.has(dup.id));
      if (dup?.origin === 'logcat') {
        this.countedLive.add(dup.id);
        if (this.countedLive.size > 500) this.countedLive.delete(this.countedLive.values().next().value!);
      }
      if (c.pkg && !counted) deps.apps.noteCrash(c.pkg, c.meta);
    }
  }

  /** Third-party packages only (data_app_* are non-system apps by definition; tombstones need the list). */
  private accept(c: DropboxCrash): boolean {
    if (!c.pkg) return false;
    if (this.deps.apps.isThirdParty(c.pkg)) return true;
    if (c.tag === 'SYSTEM_TOMBSTONE') return false;
    return !this.deps.apps.isSystem(c.pkg);
  }

  private prune(now: number): void {
    const cutoff = now - DROPBOX_TIMING.lookbackMs - 2 * 3600_000;
    for (const [k, ts] of this.deps.cursor.seen) if (ts < cutoff) this.deps.cursor.seen.delete(k);
  }
}
