/**
 * iOS simulator unified log: `xcrun simctl spawn <udid> log stream --style ndjson --level <lvl>
 * [--predicate …]`. The first line ("Filtering the log data using …") is not JSON; every other line
 * is one event object.
 */
import type { LogLevel, ServerSettings } from '@durbun/protocol';
import type { DeviceLogInput } from '../../types';
import { posixBasename } from '../shared/text';
import { normalizeIosFlutter } from './syslog';

/** User-installed apps only (Xcode / flutter run installs land in the app bundle containers). */
export const SIM_APPS_PREDICATE = 'processImagePath CONTAINS "/Containers/Bundle/Application/"';

const LEVELS: Record<string, LogLevel> = {
  Default: 'info',
  Info: 'info',
  Debug: 'debug',
  Error: 'error',
  // Fault is a serious os_log record, not a crash: 'fatal' is reserved for real crashes (SPEC §9.4).
  Fault: 'error',
};

/** `log stream` arguments after `xcrun simctl spawn <udid>`. */
export function simLogStreamArgs(settings: Pick<ServerSettings, 'iosSimLogLevel' | 'iosSimLogScope'>): string[] {
  const level = settings.iosSimLogLevel === 'debug' || settings.iosSimLogLevel === 'default' ? settings.iosSimLogLevel : 'info';
  const args = ['log', 'stream', '--style', 'ndjson', '--level', level];
  if (settings.iosSimLogScope !== 'all') args.push('--predicate', SIM_APPS_PREDICATE);
  return args;
}

/** "2026-11-02 11:43:01.123456+0300" → epoch ms (fractional). */
export function parseUnifiedTimestamp(ts: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(ts.trim());
  if (!m) return undefined;
  const frac = m[7] ? Number(m[7]) / 10 ** (m[7].length - 3) : 0;
  const base = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])] as const;
  const zone = m[8];
  if (!zone) return new Date(...base).getTime() + frac;
  if (zone === 'Z') return Date.UTC(...base) + frac;
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  return Date.UTC(...base) - offMin * 60_000 + frac;
}

interface SimEvent {
  eventType?: string;
  eventMessage?: string;
  messageType?: string;
  timestamp?: string;
  processID?: number;
  threadID?: number;
  processImagePath?: string;
  senderImagePath?: string;
  subsystem?: string;
  category?: string;
}

/** Parse one ndjson line; null for the header line, non-log events and garbage. */
export function parseSimLogLine(line: string, nowMs = Date.now()): DeviceLogInput | null {
  if (line.length < 2 || line.charCodeAt(0) !== 123 /* { */) return null;
  let ev: SimEvent;
  try {
    ev = JSON.parse(line) as SimEvent;
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  const type = ev.eventType ?? 'logEvent';
  if (type !== 'logEvent' && type !== 'lossEvent') return null;
  const process = ev.processImagePath ? posixBasename(ev.processImagePath) : undefined;
  const sender = ev.senderImagePath ? posixBasename(ev.senderImagePath) : undefined;
  const subsystem = ev.subsystem || undefined;
  const category = ev.category || undefined;
  const entry: DeviceLogInput = {
    ts: (ev.timestamp && parseUnifiedTimestamp(ev.timestamp)) || nowMs,
    level: type === 'lossEvent' ? 'warn' : (LEVELS[ev.messageType ?? 'Default'] ?? 'info'),
    tag: subsystem ?? sender ?? process ?? 'log',
    message: ev.eventMessage ?? '',
  };
  if (typeof ev.processID === 'number' && ev.processID > 0) entry.pid = ev.processID;
  if (typeof ev.threadID === 'number') entry.tid = ev.threadID;
  if (process) entry.process = process;
  if (subsystem) entry.subsystem = subsystem;
  if (category) entry.category = category;
  if (type === 'lossEvent') entry.tag = 'log';
  normalizeIosFlutter(entry);
  return entry;
}
