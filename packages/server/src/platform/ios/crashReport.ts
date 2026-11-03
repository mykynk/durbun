/**
 * Apple crash reports (.ips) → one LogEntry each (SPEC §10.3).
 *
 * iOS 15+ / macOS 12+ (bug_type 309) write a two-part file: line 1 is a JSON header
 *   {"app_name":"Runner","timestamp":"2026-11-02 11:43:01.00 +0300","app_version":"2.3.0",
 *    "build_version":"57","bundleID":"com.mykynk.pati","bug_type":"309",…}
 * and the rest of the file is ONE JSON object (exception, termination, asi, exceptionReason,
 * lastExceptionBacktrace, threads[].frames {imageIndex, imageOffset, symbol?}, usedImages[]).
 * iOS ≤ 14 (bug_type 109) keeps the same header followed by the classic plain-text report.
 *
 * The app's own frames are NOT symbolicated (release binaries are stripped; symbols live in the
 * build's dSYM) — `data.symbolicated` says so and the UI explains it.
 *
 * Only bug types 309 / 109 are crashes. Jetsam (298, memory pressure kills), resource reports
 * (ExcResource, 145/202), stackshots (288), panics (210) and simulated "user fault" corpses
 * (`is_simulated: 1`, ExcUserFault_*) are ignored: they do not name a crashed third-party app reliably.
 */
import type { DeviceLogInput } from '../../types';
import { posixBasename } from '../shared/text';
import { parseUnifiedTimestamp } from './simlog';

export const CRASH_BUG_TYPES: ReadonlySet<string> = new Set(['309', '109']);
export const CRASH_TAG = 'crash-report';

export interface IpsFrame {
  image: string;
  imageOffset?: number;
  /** Absolute address (image base + offset) when the image base is known. */
  address?: number;
  symbol?: string;
  symbolLocation?: number;
  sourceFile?: string;
  sourceLine?: number;
  /** Frame inside the app bundle (main binary, its frameworks such as Flutter / App). */
  appImage: boolean;
  /** Legacy text reports: the original frame line. */
  raw?: string;
}

export interface IpsReport {
  bugType: string;
  /** Header `is_simulated` (non-fatal corpse, e.g. ExcUserFault_*). */
  simulated: boolean;
  appName?: string;
  bundleId?: string;
  version?: string;
  build?: string;
  /** Crash time, epoch ms (device clock). */
  ts?: number;
  incident?: string;
  osVersion?: string;
  /** Mach-O platform from the header (2 iOS, 7 iOS simulator, 1 macOS…). */
  platform?: number;
  pid?: number;
  procName?: string;
  procPath?: string;
  /** e.g. "com.apple.CoreSimulator.SimDevice.<UDID>" for simulator processes. */
  coalition?: string;
  exceptionType?: string;
  signal?: string;
  codes?: string;
  subtype?: string;
  /** e.g. "SIGNAL 11 Segmentation fault: 11" / "FRONTBOARD 0x8badf00d <reasons>". */
  termination?: string;
  objcException?: { name?: string; message?: string };
  /** Application Specific Information lines (e.g. "abort() called", Swift "Fatal error: …"). */
  asi: string[];
  crashedThread?: number;
  crashedQueue?: string;
  frames: IpsFrame[];
  exceptionFrames: IpsFrame[];
  /** Absolute paths seen in the report (procPath, usedImages) — used to match simulators. */
  paths: string[];
  symbolicated: boolean;
  legacy: boolean;
  /** No body, or a JSON body that does not parse (file still being written / truncated). */
  incomplete: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Third-party bundle ids only (SPEC §10.2): everything outside com.apple.*. */
export function isThirdPartyBundle(id: string | undefined): id is string {
  return !!id && !/^com\.apple(\.|$)/i.test(id);
}

export function isCrashReport(r: IpsReport): boolean {
  return CRASH_BUG_TYPES.has(r.bugType) && !r.simulated;
}

/**
 * Non-crash report families that share the .ips extension (cheap pre-filter on file names). Matched
 * case-sensitively and only as a whole name part ("JetsamEvent-…", "stacks+…", "ExcUserFault_…"), so an
 * app whose executable merely starts with one of these words ("WiFiMan", "PanicButton", "Stacks") keeps
 * its crash reports. A family missed here is still dropped later by its header's bug_type.
 */
const NON_CRASH_PREFIX =
  /^(?:SFA-|(?:JetsamEvent|Analytics|stacks|ExcResource|ExcUserFault|panic|ResetCounter|LowBatteryLog|SiriSearchFeedback|xp_amp|log-aggregated|WiFi|sysdiagnose|OTAUpdate|proactive_event_tracker|ProxiedDevice|Bug_Type|DiskWrites|CPUUsage|cpu_resource|wakeups_resource|memory_resource|disk_writes_resource|Sandbox|shutdown|SystemMemoryReset|signpost)(?=[-_+.]))/;

/** "Runner-2026-11-02-114301.ips" (also ".000.ips" duplicates) is a candidate crash report. */
export function isCrashFileName(name: string): boolean {
  const base = posixBasename(name);
  return base.toLowerCase().endsWith('.ips') && !NON_CRASH_PREFIX.test(base);
}

/** Process name part of a crash file name ("Runner-2026-11-02-114301.ips" → "Runner"). */
export function crashFileProcess(name: string): string | undefined {
  const m = /^(.+?)-\d{4}-\d{2}-\d{2}-\d{6}/.exec(posixBasename(name));
  return m ? m[1] : undefined;
}

/** Local time encoded in a crash file name, epoch ms. */
export function crashFileDate(name: string): number | undefined {
  const m = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(posixBasename(name));
  if (!m) return undefined;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** Parse the header line only (cheap pre-filter before reading a whole file). */
export function parseIpsHeader(firstLine: string): Obj | undefined {
  const line = firstLine.trim();
  if (!line.startsWith('{')) return undefined;
  try {
    const v = JSON.parse(line) as unknown;
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a whole .ips file. Returns null when it is not an .ips report at all. */
export function parseIps(text: string): IpsReport | null {
  const nl = text.indexOf('\n');
  const header = parseIpsHeader(nl === -1 ? text : text.slice(0, nl));
  if (!header) return null;
  const rest = nl === -1 ? '' : text.slice(nl + 1);
  const report: IpsReport = {
    bugType: String(header.bug_type ?? ''),
    simulated: header.is_simulated === 1 || header.is_simulated === true || header.is_simulated === '1',
    asi: [],
    frames: [],
    exceptionFrames: [],
    paths: [],
    symbolicated: false,
    legacy: false,
    incomplete: false,
  };
  const set = <K extends keyof IpsReport>(k: K, v: IpsReport[K] | undefined) => {
    if (v !== undefined) report[k] = v;
  };
  set('appName', str(header.app_name) ?? str(header.name));
  set('bundleId', str(header.bundleID));
  set('version', str(header.app_version));
  set('build', str(header.build_version));
  set('incident', str(header.incident_id));
  set('osVersion', str(header.os_version));
  set('platform', num(header.platform));
  const headerTs = str(header.timestamp);
  if (headerTs) set('ts', parseUnifiedTimestamp(headerTs));

  let body: unknown;
  const trimmed = rest.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      body = JSON.parse(trimmed) as unknown;
    } catch {
      body = undefined;
    }
  }
  if (isObj(body)) parseJsonBody(report, body);
  else if (trimmed && !trimmed.startsWith('{')) parseLegacyBody(report, rest);
  else report.incomplete = true;
  report.symbolicated = isSymbolicated(report);
  return report;
}

/* ───────────── JSON body (bug_type 309) ───────────── */

interface Image {
  name: string;
  path?: string;
  base?: number;
  app: boolean;
}

function isAppPath(p: string | undefined): boolean {
  if (!p) return false;
  return /\.app\//.test(p) && !/^\/(System|usr)\//.test(p) && !p.includes('/RuntimeRoot/');
}

function parseJsonBody(r: IpsReport, b: Obj): void {
  if (r.pid === undefined) {
    const pid = num(b.pid);
    if (pid !== undefined && pid > 0) r.pid = pid;
  }
  const procName = str(b.procName);
  const procPath = str(b.procPath);
  if (procName) r.procName = procName;
  if (procPath) {
    r.procPath = procPath;
    r.paths.push(procPath);
  }
  const coalition = str(b.coalitionName);
  if (coalition) r.coalition = coalition;
  const capture = str(b.captureTime);
  const captureTs = capture ? parseUnifiedTimestamp(capture) : undefined;
  if (captureTs !== undefined) r.ts = captureTs;
  if (isObj(b.bundleInfo)) {
    const bi = b.bundleInfo;
    r.bundleId ??= str(bi.CFBundleIdentifier);
    r.version ??= str(bi.CFBundleShortVersionString);
    r.build ??= str(bi.CFBundleVersion);
  }

  if (isObj(b.exception)) {
    const e = b.exception;
    r.exceptionType = str(e.type);
    r.signal = str(e.signal);
    r.codes = str(e.codes);
    r.subtype = str(e.subtype) ?? str(e.message);
  }
  if (isObj(b.termination)) r.termination = terminationText(b.termination);
  if (isObj(b.exceptionReason)) {
    const x = b.exceptionReason;
    const name = str(x.name) ?? str(x.class);
    const message = str(x.composed_message) ?? str(x.format_string) ?? str(x.subtype);
    if (name || message) r.objcException = { ...(name ? { name } : {}), ...(message ? { message } : {}) };
  }
  if (isObj(b.asi)) {
    for (const v of Object.values(b.asi)) {
      if (Array.isArray(v)) {
        for (const s of v) if (typeof s === 'string' && s.trim()) r.asi.push(s.trim());
      } else if (typeof v === 'string' && v.trim()) {
        r.asi.push(v.trim());
      }
    }
  }
  if (!r.objcException) r.objcException = objcFromAsi(r.asi);

  const images: Image[] = [];
  if (Array.isArray(b.usedImages)) {
    for (const raw of b.usedImages) {
      if (!isObj(raw)) {
        images.push({ name: '???', app: false });
        continue;
      }
      const path = str(raw.path);
      const name = str(raw.name) ?? (path ? posixBasename(path) : '???');
      if (path) r.paths.push(path);
      images.push({ name, ...(path ? { path } : {}), ...(num(raw.base) !== undefined ? { base: num(raw.base) } : {}), app: isAppPath(path) || (!!procName && name === procName && !!path && !/^\/(System|usr)\//.test(path)) });
    }
  }
  const toFrames = (list: unknown): IpsFrame[] => {
    if (!Array.isArray(list)) return [];
    const out: IpsFrame[] = [];
    for (const f of list) {
      if (!isObj(f)) continue;
      const idx = num(f.imageIndex);
      const img = idx !== undefined ? images[idx] : undefined;
      const offset = num(f.imageOffset);
      const frame: IpsFrame = { image: img?.name ?? '???', appImage: !!img?.app };
      if (offset !== undefined) frame.imageOffset = offset;
      if (offset !== undefined && img?.base !== undefined) frame.address = img.base + offset;
      const symbol = str(f.symbol);
      if (symbol) frame.symbol = symbol;
      const loc = num(f.symbolLocation);
      if (loc !== undefined) frame.symbolLocation = loc;
      const file = str(f.sourceFile);
      if (file) frame.sourceFile = file;
      const line = num(f.sourceLine);
      if (line !== undefined) frame.sourceLine = line;
      out.push(frame);
    }
    return out;
  };

  r.exceptionFrames = toFrames(b.lastExceptionBacktrace);
  if (Array.isArray(b.threads)) {
    const threads = b.threads.filter(isObj);
    let idx = threads.findIndex((t) => t.triggered === true);
    const faulting = num(b.faultingThread);
    if (idx === -1 && faulting !== undefined && faulting >= 0 && faulting < threads.length) idx = faulting;
    if (idx !== -1) {
      const t = threads[idx]!;
      r.crashedThread = idx;
      const queue = str(t.queue) ?? str(t.name);
      if (queue) r.crashedQueue = queue;
      r.frames = toFrames(t.frames);
    }
  }
}

function terminationText(t: Obj): string | undefined {
  const ns = str(t.namespace);
  const code = num(t.code);
  const indicator = str(t.indicator);
  const reasons = Array.isArray(t.reasons) ? t.reasons.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  const details = Array.isArray(t.details) ? t.details.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  const parts: string[] = [];
  if (ns) parts.push(ns);
  if (code !== undefined) parts.push(ns === 'SIGNAL' ? String(code) : `0x${code.toString(16)}`);
  if (indicator) parts.push(indicator);
  const head = parts.join(' ');
  const tail = [...reasons, ...details].map((s) => s.trim()).join(' · ');
  const text = [head, tail].filter(Boolean).join(' · ');
  return text || undefined;
}

const UNCAUGHT_RE = /Terminating app due to uncaught exception '([^']+)', reason: '([\s\S]*?)'\s*$/m;

function objcFromAsi(lines: string[]): IpsReport['objcException'] {
  for (const l of lines) {
    const m = UNCAUGHT_RE.exec(l);
    if (m) return { name: m[1]!, message: m[2]! };
  }
  return undefined;
}

/* ───────────── legacy text body (bug_type 109, iOS ≤ 14) ───────────── */

const LEGACY_FRAME = /^(\d+)\s+(\S+)\s+(0x[0-9a-fA-F]+)\s+(.*)$/;
const LEGACY_UNSYM = /^0x[0-9a-fA-F]+ \+ \d+$/;
const LEGACY_IMAGE = /^\s*0x[0-9a-fA-F]+\s+-\s+0x[0-9a-fA-F]+\s+\+?(\S+)\s+\S+\s+<[0-9a-fA-F-]+>\s+(\/.*)$/;

function parseLegacyBody(r: IpsReport, text: string): void {
  r.legacy = true;
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const field = (name: string): string | undefined => {
    const prefix = `${name}:`;
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() || undefined : undefined;
  };
  const type = field('Exception Type');
  if (type) {
    const m = /^(\S+)(?:\s+\((\w+)\))?/.exec(type);
    r.exceptionType = m?.[1] ?? type;
    if (m?.[2]) r.signal = m[2];
  }
  r.subtype = field('Exception Subtype') ?? field('Exception Message');
  r.codes = field('Exception Codes');
  r.termination = field('Termination Reason');
  const proc = field('Process');
  if (proc) {
    const m = /^(.*?)\s*\[(\d+)\]$/.exec(proc);
    r.procName = m ? m[1]! : proc;
    if (m) r.pid = Number(m[2]);
  }
  const path = field('Path');
  if (path) {
    r.procPath = path;
    r.paths.push(path);
  }
  r.bundleId ??= field('Identifier');
  const date = field('Date/Time');
  const dateTs = date ? parseUnifiedTimestamp(date) : undefined;
  if (dateTs !== undefined) r.ts = dateTs;
  const triggered = field('Triggered by Thread');
  if (triggered !== undefined && /^\d+$/.test(triggered)) r.crashedThread = Number(triggered);

  const block = (startIdx: number): string[] => {
    const out: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i += 1) {
      const l = lines[i]!;
      if (!l.trim()) break;
      out.push(l);
    }
    return out;
  };
  const asiIdx = lines.findIndex((l) => l.startsWith('Application Specific Information:'));
  if (asiIdx !== -1) r.asi.push(...block(asiIdx).map((l) => l.trim()).filter(Boolean));
  r.objcException = objcFromAsi(r.asi);

  const appImages = new Set<string>();
  const binIdx = lines.findIndex((l) => l.startsWith('Binary Images:'));
  if (binIdx !== -1) {
    for (const l of lines.slice(binIdx + 1)) {
      const m = LEGACY_IMAGE.exec(l);
      if (!m) continue;
      r.paths.push(m[2]!);
      if (isAppPath(m[2])) appImages.add(m[1]!);
    }
  }
  if (r.procName) appImages.add(r.procName);
  const toFrames = (raw: string[]): IpsFrame[] =>
    raw.flatMap((l) => {
      const m = LEGACY_FRAME.exec(l.trim());
      if (!m) return [];
      const tail = m[4]!.trim();
      const f: IpsFrame = { image: m[2]!, address: Number.parseInt(m[3]!, 16), appImage: appImages.has(m[2]!), raw: l.trim() };
      if (!LEGACY_UNSYM.test(tail)) {
        const s = /^(.*?) \+ (\d+)(?: \((.+?):(\d+)\))?$/.exec(tail);
        f.symbol = s ? s[1]! : tail;
        if (s) f.symbolLocation = Number(s[2]);
      } else {
        const off = /\+ (\d+)$/.exec(tail);
        if (off) f.imageOffset = Number(off[1]);
      }
      return [f];
    });
  const lebIdx = lines.findIndex((l) => l.startsWith('Last Exception Backtrace:'));
  if (lebIdx !== -1) r.exceptionFrames = toFrames(block(lebIdx));
  const crashedRe = r.crashedThread !== undefined ? new RegExp(`^Thread ${r.crashedThread}( name:.*)? Crashed:`) : /^Thread \d+ Crashed:/;
  const crashIdx = lines.findIndex((l) => crashedRe.test(l) || /^Thread \d+ Crashed:/.test(l));
  if (crashIdx !== -1) {
    const m = /^Thread (\d+)/.exec(lines[crashIdx]!);
    if (m) r.crashedThread = Number(m[1]);
    const nameLine = lines[crashIdx - 1];
    const q = nameLine ? /^Thread \d+ name:\s*(.*)$/.exec(nameLine) : null;
    if (q?.[1]) r.crashedQueue = q[1].replace(/^Dispatch queue:\s*/, '');
    r.frames = toFrames(block(crashIdx));
  }
}

/* ───────────── presentation ───────────── */

function isSymbolicated(r: IpsReport): boolean {
  const all = [...r.exceptionFrames, ...r.frames];
  if (all.length === 0) return false;
  const app = all.filter((f) => f.appImage);
  return (app.length ? app : all).every((f) => !!f.symbol);
}

const hex = (n: number, width = 16) => `0x${n.toString(16).padStart(width, '0')}`;

/**
 * Apple-style frame line ("3   UIKitCore   0x00000001a2b3c4d5 -[UIApplication sendAction:] + 96"),
 * unsymbolicated frames end with "<image> + 0x<offset>" (what atos / Xcode need together with the dSYM).
 */
export function formatFrame(index: number, f: IpsFrame): string {
  if (f.raw) return f.raw;
  const tail = f.symbol
    ? `${f.symbol}${f.symbolLocation !== undefined ? ` + ${f.symbolLocation}` : ''}${
        f.sourceFile ? ` (${f.sourceFile}${f.sourceLine !== undefined ? `:${f.sourceLine}` : ''})` : ''
      }`
    : `${f.image} + 0x${(f.imageOffset ?? 0).toString(16)}`;
  const idx = String(index).padEnd(4);
  const image = f.image.padEnd(Math.max(24, f.image.length + 1));
  return f.address !== undefined ? `${idx}${image}${hex(f.address)} ${tail}` : `${idx}${image}${tail}`;
}

function headline(r: IpsReport): string {
  if (r.objcException) {
    const { name, message } = r.objcException;
    return [name ?? 'NSException', message].filter(Boolean).join(': ');
  }
  const swift = r.asi.find((l) => /Fatal error|Precondition failed|Assertion failed|Fatal access conflict/i.test(l));
  if (swift) return swift;
  const exc = r.exceptionType ? `${r.exceptionType}${r.signal ? ` (${r.signal})` : ''}` : (r.signal ?? 'crash');
  const parts = [exc];
  if (r.subtype) parts.push(r.subtype);
  else if (r.exceptionType === 'EXC_CRASH' && /SIGKILL/.test(r.signal ?? '') && r.termination) parts.push(r.termination);
  if (r.asi.some((l) => /abort\(\) called/.test(l)) && firstNonSystemFrame(r)?.image === 'Flutter') {
    parts.push('abort() in the Flutter engine');
  }
  return parts.join(' · ');
}

function firstNonSystemFrame(r: IpsReport): IpsFrame | undefined {
  return r.frames.find((f) => !/^(libsystem_|libc\+\+|libobjc|libdyld|dyld)/.test(f.image));
}

/** Everything known about why it died, on one line. */
export function crashSummary(r: IpsReport): string {
  const parts: string[] = [];
  if (r.objcException) parts.push(headline(r));
  if (r.exceptionType) parts.push(`${r.exceptionType}${r.signal ? ` (${r.signal})` : ''}`);
  else if (r.signal) parts.push(r.signal);
  if (r.subtype) parts.push(r.subtype);
  if (r.codes && !r.subtype && !/^0x0+(\s*,\s*0x0+)*$/.test(r.codes)) parts.push(`codes ${r.codes}`);
  if (r.termination) parts.push(`Termination: ${r.termination}`);
  for (const l of r.asi) if (!parts.some((p) => p.includes(l))) parts.push(l);
  return parts.join(' · ') || 'Crash';
}

/** Readable stack: last exception backtrace (ObjC / Swift errors) + crashed thread frames. */
export function crashStack(r: IpsReport): string | undefined {
  const out: string[] = [];
  if (r.exceptionFrames.length) {
    out.push('Last Exception Backtrace:');
    r.exceptionFrames.forEach((f, i) => out.push(formatFrame(i, f)));
  }
  if (r.frames.length) {
    if (out.length) out.push('');
    out.push(`Thread ${r.crashedThread ?? 0} Crashed${r.crashedQueue ? ` (${r.crashedQueue})` : ''}:`);
    r.frames.forEach((f, i) => out.push(formatFrame(i, f)));
  }
  return out.length ? out.join('\n') : undefined;
}

export interface CrashEntryOptions {
  /** When Dürbün started watching this device (reports older than this are from a previous launch). */
  watchStart: number;
  now?: number;
  /** Local copy of the report (diagnostics / "open in Xcode"). */
  file?: string;
  /** URL path the UI downloads the copy from (`/api/files/crash/<udid>/<name>`, SPEC §10.3). */
  reportUrl?: string;
  /** Id of the live crash entry this report duplicates (the UI hides marked copies). */
  duplicateOf?: number;
  /** App display name when the device knows a better one than the report (the host app's, for an extension). */
  appName?: string;
  /**
   * Installed app the report belongs to when it is an app extension's (com.x.app for com.x.app.Widget): the
   * row is the host app's (`data.bundleId`), and `data.extensionBundleId` names the extension.
   */
  hostBundleId?: string;
}

/** The LogEntry (before the hub assigns id/deviceId/source) for one crash report. */
export function crashReportEntry(r: IpsReport, opts: CrashEntryOptions): DeviceLogInput {
  const now = opts.now ?? Date.now();
  const ts = r.ts ?? now;
  const extension = opts.hostBundleId && r.bundleId && opts.hostBundleId !== r.bundleId ? r.bundleId : undefined;
  const name = opts.appName ?? (extension ? opts.hostBundleId : (r.appName ?? r.procName ?? r.bundleId)) ?? 'App';
  // "Pati 2.3.0 (57) · PatiWidget crashed: …" for an extension (its version is the one in the report).
  const part = extension ? ` · ${r.procName ?? r.appName ?? extension}` : '';
  const ver = r.version ? ` ${r.version}${r.build ? ` (${r.build})` : ''}` : '';
  const previousLaunch = ts < opts.watchStart;
  const stack = crashStack(r);
  const entry: DeviceLogInput = {
    ts,
    level: 'fatal',
    kind: 'crash',
    origin: 'crash-report',
    tag: CRASH_TAG,
    message: `${name}${ver}${part} crashed: ${headline(r)}`,
    error: {
      type: r.objcException?.name ?? r.exceptionType ?? 'crash',
      message: crashSummary(r),
      ...(stack ? { stack } : {}),
    },
    data: {
      origin: 'crash-report',
      bundleId: extension ? opts.hostBundleId : r.bundleId,
      ...(extension ? { extensionBundleId: extension } : {}),
      reportTs: ts,
      previousLaunch,
      symbolicated: r.symbolicated,
      ...(r.appName ? { appName: r.appName } : {}),
      ...(r.version ? { version: r.version } : {}),
      ...(r.build ? { build: r.build } : {}),
      ...(r.exceptionType ? { exceptionType: r.exceptionType } : {}),
      ...(r.signal ? { signal: r.signal } : {}),
      ...(r.termination ? { termination: r.termination } : {}),
      ...(r.incident ? { incident: r.incident } : {}),
      ...(r.osVersion ? { osVersion: r.osVersion } : {}),
      bugType: r.bugType,
      ...(r.pid !== undefined ? { pid: r.pid } : {}),
      ...(opts.file ? { file: opts.file } : {}),
      ...(opts.reportUrl ? { reportUrl: opts.reportUrl } : {}),
      ...(opts.duplicateOf !== undefined ? { duplicateOf: opts.duplicateOf } : {}),
    },
  };
  if (r.procName) entry.process = r.procName;
  // A previous launch's pid may belong to another process by now, and the hub attaches rows to the live SDK
  // session of their pid: keep it in data only (as Android's dropbox rows do).
  if (r.pid !== undefined && !previousLaunch) entry.pid = r.pid;
  return entry;
}

/** Simulator UDID a (macOS-side) report belongs to: coalition "…SimDevice.<UDID>" or a CoreSimulator path. */
export function simulatorUdidOf(r: IpsReport): string | undefined {
  const c = r.coalition ? /CoreSimulator\.SimDevice\.([0-9A-Fa-f-]{36})/.exec(r.coalition) : null;
  if (c) return c[1]!.toUpperCase();
  for (const p of r.paths) {
    const m = /\/CoreSimulator\/Devices\/([0-9A-Fa-f-]{36})\//.exec(p);
    if (m) return m[1]!.toUpperCase();
  }
  return undefined;
}
