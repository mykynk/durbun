/**
 * "Report a bug" (SPEC §12): what goes into the report around one moment, and the report text itself. Pure: the
 * dialog passes the stores' contents in, so the counts it shows and the file it saves come from the same code.
 */
import { BUG_REPORT_MAX_LOG_LINES, BUG_REPORT_MAX_REQUESTS, BUG_REPORT_MAX_WINDOW_MS, maskUrl, type DeviceInfo, type LogEntry, type NetworkEntry } from '@durbun/protocol';
import type { CompiledScope, HubState, Scope } from '../../data';
import { isNetworkError } from '../../data/networkStore';
import { deviceAppForEntry, sessionForEntry } from '../logs/model/appOf';
import { exportTimestamp, formatTxtEntry } from '../logs/model/export';
import { LogMasker } from '../logs/model/maskLog';
import { fenced, shareDuration } from '../network/model/shareReport';

/** Where the report starts: a log line, a request, or "now" (the top bar, the palette). */
export type BugAnchor = { kind: 'log'; logId: number } | { kind: 'request'; netId: string } | { kind: 'now' };

/** Seconds before the moment the user can pick; the default is 30 s. */
export const BEFORE_CHOICES = [10, 30, 60, 120, 300, 600] as const;
/** Seconds after the moment ("now" starts with 0: nothing has happened after it yet). */
export const AFTER_CHOICES = [0, 5, 30, 60] as const;
export const DEFAULT_BEFORE_S = 30;
export const DEFAULT_AFTER_S = 30;

/** Log lines the Markdown quotes (the zip has every line of the window in logs.txt). */
export const MARKDOWN_LOG_LINES = 100;
/** Failed requests the Markdown lists one by one. */
export const MARKDOWN_REQUESTS = 30;

export interface BugWindow {
  fromTs: number;
  toTs: number;
  /** The chosen window was longer than BUG_REPORT_MAX_WINDOW_MS and lost its oldest part. */
  cut: boolean;
}

/** [moment - before, moment + after], at most BUG_REPORT_MAX_WINDOW_MS long; the end stays (the moment is there). */
export function bugWindow(moment: number, beforeS: number, afterS: number): BugWindow {
  const toTs = moment + Math.max(0, afterS) * 1000;
  const wanted = moment - Math.max(0, beforeS) * 1000;
  const fromTs = Math.max(wanted, toTs - BUG_REPORT_MAX_WINDOW_MS);
  return { fromTs, toTs, cut: fromTs > wanted };
}

type HubLike = Pick<HubState, 'apps' | 'devices' | 'deviceApps'>;

/**
 * The scope a report covers, from where it started: a line's or request's app (every run of it on that device),
 * the app the device names for an SDK-less line, else the line's device. "Now" takes what the user is looking at.
 */
export function bugScope(anchor: { entry?: LogEntry; request?: NetworkEntry }, current: Scope, hub: HubLike): Scope {
  const { entry, request } = anchor;
  if (entry) {
    const session = sessionForEntry(entry, hub.apps);
    if (session && hub.apps[session.id]) return { kind: 'app', appId: session.id };
    const da = deviceAppForEntry(entry, hub.deviceApps);
    if (da) return { kind: 'deviceApp', deviceId: da.deviceId, bundleId: da.id };
    if (entry.deviceId && entry.deviceId !== 'desktop' && hub.devices[entry.deviceId]) return { kind: 'device', deviceId: entry.deviceId };
    return current;
  }
  if (request) {
    if (request.appId && hub.apps[request.appId]) return { kind: 'app', appId: request.appId };
    if (request.deviceId !== 'desktop' && hub.devices[request.deviceId]) return { kind: 'device', deviceId: request.deviceId };
  }
  return current;
}

/** Devices a report can be about (the desktop's replays aside). */
export function reportableDevices(hub: Pick<HubState, 'devices'>): DeviceInfo[] {
  return Object.values(hub.devices).filter((d) => d.id !== 'desktop');
}

/** The device of a scope, when it has exactly one. */
export function scopeDevice(compiled: Pick<CompiledScope, 'scope' | 'deviceId' | 'app'>): string | undefined {
  if (compiled.scope.kind === 'device' || compiled.scope.kind === 'deviceApp') return compiled.scope.deviceId;
  return compiled.deviceId ?? compiled.app?.deviceId;
}

export interface WindowLogs {
  /** The newest BUG_REPORT_MAX_LOG_LINES lines of the window, oldest first. */
  lines: LogEntry[];
  /** Lines in the window (before the cap). */
  total: number;
}

/**
 * The scope's log lines in the window, oldest first: what the user sees in Logs for that scope, without the request
 * rows (the requests have their own part) and, when "hide noise" is on, without the noise. Crash records the
 * memory limit moved aside (`kept`) count too.
 */
export function collectLogs(
  source: { entries: readonly LogEntry[]; kept?: readonly LogEntry[] },
  compiled: Pick<CompiledScope, 'logs'>,
  win: Pick<BugWindow, 'fromTs' | 'toTs'>,
  noisy: (e: LogEntry) => boolean = () => false,
): WindowLogs {
  const out: LogEntry[] = [];
  const take = (e: LogEntry) => {
    if (e.ts < win.fromTs || e.ts > win.toTs || e.kind === 'network' || e.kind === 'marker') return;
    if (!compiled.logs(e) || noisy(e)) return;
    out.push(e);
  };
  for (const e of source.kept ?? []) take(e);
  for (const e of source.entries) take(e);
  if ((source.kept?.length ?? 0) > 0) out.sort((a, b) => a.id - b.id);
  return { lines: out.length > BUG_REPORT_MAX_LOG_LINES ? out.slice(-BUG_REPORT_MAX_LOG_LINES) : out, total: out.length };
}

export interface WindowRequests {
  /** Failed requests (a failure or a 4xx / 5xx) that started in the window, oldest first. */
  failed: NetworkEntry[];
  /** Every request that started in the window. */
  all: NetworkEntry[];
}

/** The scope's requests that started in the window (the newest BUG_REPORT_MAX_REQUESTS of each list). */
export function collectRequests(list: readonly NetworkEntry[], compiled: Pick<CompiledScope, 'network'>, win: Pick<BugWindow, 'fromTs' | 'toTs'>): WindowRequests {
  const all: NetworkEntry[] = [];
  for (const n of list) {
    if (n.startTs < win.fromTs || n.startTs > win.toTs || !compiled.network(n)) continue;
    all.push(n);
  }
  all.sort((a, b) => a.startTs - b.startTs);
  const failed = all.filter(isNetworkError);
  return { failed: failed.slice(-BUG_REPORT_MAX_REQUESTS), all: all.slice(-BUG_REPORT_MAX_REQUESTS) };
}

/** The iOS crash report the window's newest device crash record points to (its server copy), if any. */
export function windowCrashReport<T>(lines: readonly LogEntry[], reportOf: (e: LogEntry) => T | undefined): T | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = reportOf(lines[i]!);
    if (found) return found;
  }
  return undefined;
}

/** The lines as `logs.txt` holds them (logcat-like, one per line, continuation lines indented); `mask` hides secret values. */
export function logsText(lines: readonly LogEntry[], text: (e: LogEntry) => string, mask: boolean, header: readonly string[] = []): string {
  // Masked the way a shared line is: secret-looking values in the message, its stack and the display text.
  const masker = mask ? new LogMasker() : undefined;
  const show = masker ? (e: LogEntry) => masker.text(text(e)) : text;
  const out = header.map((h) => `# ${h}`);
  if (out.length) out.push('');
  for (const e of lines) out.push(formatTxtEntry(masker ? { ...e, message: masker.text(e.message), error: masker.error(e.error) } : e, { text: show }));
  return `${out.join('\n')}\n`;
}

/** "14:03:10.120 POST https://api.example.com/pay → 500 · 120 ms" */
export function requestLine(n: NetworkEntry, mask: boolean, failedLabel: string): string {
  const url = mask ? maskUrl(n.url) : n.url;
  const outcome =
    typeof n.status === 'number' ? `${n.status}${n.statusText ? ` ${n.statusText}` : ''}` : n.state === 'failed' ? (n.error ? `${failedLabel}: ${n.error}` : failedLabel) : n.state;
  const parts = [`${exportTimestamp(n.startTs).slice(11)} ${n.method} ${url} → ${outcome}`];
  if (typeof n.duration === 'number') parts.push(shareDuration(n.duration));
  return parts.join(' · ');
}

/** The localized words of the report (built in the UI language, like the share reports). */
export interface BugReportLabels {
  title: string;
  titleFor: (what: string) => string;
  note: string;
  environment: string;
  moment: string;
  window: (from: string, to: string) => string;
  windowCut: string;
  device: string;
  app: string;
  sdk: string;
  sdkNone: string;
  durbun: string;
  scopeAll: string;
  theMoment: string;
  failedRequests: (count: number) => string;
  moreRequests: (count: number) => string;
  noFailedRequests: string;
  logLines: (count: number) => string;
  lastLines: (shown: number, total: number) => string;
  linesCut: (count: number) => string;
  noLogLines: string;
  allLinesInZip: string;
  attachments: string;
  attLogs: (count: number) => string;
  attHar: (count: number) => string;
  attScreenshot: string;
  attCrash: string;
  attRecording: string;
  masked: string;
  raw: string;
  failed: string;
}

export interface BugReportInput {
  note: string;
  moment: number;
  window: BugWindow;
  device?: string;
  app?: string;
  sdk?: string;
  /** Dürbün's version (the server's). */
  durbun?: string;
  /** The report covers every device (no device or app named). */
  allDevices?: boolean;
  /** The moment's own report (the log line's or the request's share report), already masked when `mask`. */
  momentText?: string;
  /** Failed requests (undefined: the part is left out). */
  requests?: readonly NetworkEntry[];
  /** HAR requests when "every request" is on (counted in the attachments). */
  harCount?: number;
  /** Log lines (undefined: the part is left out). */
  logs?: { lines: readonly LogEntry[]; total: number; text: (e: LogEntry) => string };
  /** Which files the zip holds (the zip's report.md only). */
  attachments?: { screenshot?: string; crash?: string; recording?: boolean };
  mask: boolean;
}

function clock(ts: number): string {
  return exportTimestamp(ts);
}

/**
 * The report (light Markdown, like the share reports): title, the user's note, the environment, the moment, the
 * failed requests, the last lines; for the zip also what the attachments are. One text for copy, Slack and the zip.
 */
export function buildBugReport(input: BugReportInput, labels: BugReportLabels, opts: { forZip?: boolean } = {}): string {
  const out: string[] = [];
  const what = [input.app?.split(' · ')[0], input.device?.split(' · ')[0]].filter(Boolean).join(' · ');
  out.push(`# ${what ? labels.titleFor(what) : labels.title}`, '');

  const note = input.note.trim();
  if (note) out.push(`${labels.note}:`, '', ...note.split('\n').map((l) => (l ? `> ${l}` : '>')), '');

  out.push(`## ${labels.environment}`, '');
  out.push(`- ${labels.moment}: ${clock(input.moment)}`);
  out.push(`- ${labels.window(clock(input.window.fromTs).slice(11), clock(input.window.toTs).slice(11))}${input.window.cut ? ` (${labels.windowCut})` : ''}`);
  if (input.allDevices) out.push(`- ${labels.device}: ${labels.scopeAll}`);
  else if (input.device) out.push(`- ${labels.device}: ${input.device}`);
  if (input.app) out.push(`- ${labels.app}: ${input.app}`);
  if (input.app || input.sdk) out.push(`- ${labels.sdk}: ${input.sdk ?? labels.sdkNone}`);
  if (input.durbun) out.push(`- ${labels.durbun}: ${input.durbun}`);
  out.push('');

  if (input.momentText) {
    out.push(`## ${labels.theMoment}`, '', input.momentText.trimEnd(), '');
  }

  if (input.requests) {
    const shown = input.requests.slice(-MARKDOWN_REQUESTS);
    out.push(`## ${labels.failedRequests(input.requests.length)}`, '');
    if (input.requests.length === 0) out.push(labels.noFailedRequests);
    else {
      if (input.requests.length > shown.length) out.push(labels.moreRequests(input.requests.length - shown.length));
      for (const n of shown) out.push(`- ${requestLine(n, input.mask, labels.failed)}`);
    }
    out.push('');
  }

  if (input.logs) {
    const { lines, total, text } = input.logs;
    out.push(`## ${labels.logLines(total)}`, '');
    if (total === 0) out.push(labels.noLogLines, '');
    else {
      const shown = lines.slice(-MARKDOWN_LOG_LINES);
      if (shown.length < total) out.push(labels.lastLines(shown.length, total));
      if (lines.length < total) out.push(labels.linesCut(total - lines.length));
      if (opts.forZip && shown.length < lines.length) out.push(labels.allLinesInZip);
      if (shown.length < total || opts.forZip) out.push('');
      fenced(out, '', logsText(shown, text, input.mask).trimEnd());
    }
  }

  if (opts.forZip) {
    const att: string[] = [];
    if (input.logs && input.logs.lines.length) att.push(`- logs.txt: ${labels.attLogs(input.logs.lines.length)}`);
    const har = input.harCount ?? input.requests?.length ?? 0;
    if (har > 0) att.push(`- requests.har: ${labels.attHar(har)}`);
    if (input.attachments?.screenshot) att.push(`- ${input.attachments.screenshot}: ${labels.attScreenshot}`);
    if (input.attachments?.crash) att.push(`- crash/${input.attachments.crash}: ${labels.attCrash}`);
    if (input.attachments?.recording) att.push(`- recording.durbun.json: ${labels.attRecording}`);
    if (att.length) out.push(`## ${labels.attachments}`, '', ...att, '');
  }

  out.push(`_${input.mask ? labels.masked : labels.raw}_`);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** "durbun-bug-shop-20261115-140312": the zip's name (letters, digits, "-" only). */
export function bugFileName(what: string | undefined, ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const slug = (what ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return ['durbun-bug', slug, stamp].filter(Boolean).join('-');
}
