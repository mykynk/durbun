/**
 * idevicesyslog (`--no-colors`) parsing for physical iOS devices.
 *
 *   "Nov  2 11:43:01 Yusuf-iPhoneu SpringBoard(FrontBoard)[57] <Notice>: message"
 *   "Nov  2 11:43:01.123456 Yusuf iPhone’u Runner(Flutter)[1234] <Notice>: flutter: hello"
 *   "Nov  2 11:43:01 iPhone kernel[0] <Notice>: …"
 *   continuation lines (no header) belong to the previous record; "[connected:UDID]" /
 *   "[disconnected:UDID]" are idevicesyslog status lines. The device name may contain spaces, so the
 *   known name (and its hostname form) is stripped first. Year is assumed current (Dec→Jan aware).
 */
import type { LogLevel } from '@durbun/protocol';
import type { DeviceLogInput } from '../../types';
import { FLUTTER_TAG, flutterEngineLevel, stripFlutterPrefix } from '../shared/flutter';
import { stripAnsi } from '../shared/text';

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const HEADER_RE = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? (.*)$/;
const BODY_RE = /^(.*?)\[(\d+)\] <([A-Za-z]+)>:(?: (.*))?$/;
const STATUS_RE = /^\[(connected|disconnected)(?::([^\]]*))?\]$/;
const DAY_MS = 86_400_000;

const LEVELS: Record<string, LogLevel> = {
  Emergency: 'fatal',
  Alert: 'fatal',
  Critical: 'fatal',
  Fault: 'error',
  Error: 'error',
  Warning: 'warn',
  Notice: 'info',
  Info: 'info',
  Default: 'info',
  Debug: 'debug',
};

/** Name variants that may prefix the process in syslog lines (user name, hostname forms). */
export function deviceNameVariants(name: string | undefined): string[] {
  if (!name) return [];
  const out = new Set<string>();
  out.add(name);
  const hyphen = name.trim().replace(/\s+/g, '-');
  out.add(hyphen);
  out.add(hyphen.replace(/[^A-Za-z0-9-]/g, ''));
  const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
  out.add(ascii.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9-]/g, ''));
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

export type SyslogParse =
  | { type: 'entry'; entry: DeviceLogInput }
  | { type: 'status'; connected: boolean; udid?: string }
  | { type: 'continuation'; text: string };

function syslogTime(mon: string, day: string, hh: string, mm: string, ss: string, frac: string | undefined, nowMs: number): number {
  const month = MONTHS[mon] ?? 0;
  const y = new Date(nowMs).getFullYear();
  const at = (year: number) =>
    new Date(year, month, Number(day), Number(hh), Number(mm), Number(ss)).getTime() +
    (frac ? Number(frac) / 10 ** (frac.length - 3) : 0);
  let ms = at(y);
  if (ms > nowMs + 2 * DAY_MS) ms = at(y - 1);
  return ms;
}

/** Parse one (ANSI-free) idevicesyslog line. */
export function parseSyslogLine(line: string, names: readonly string[], nowMs = Date.now()): SyslogParse {
  const st = STATUS_RE.exec(line);
  if (st) return { type: 'status', connected: st[1] === 'connected', ...(st[2] ? { udid: st[2] } : {}) };
  const h = HEADER_RE.exec(line);
  if (!h) return { type: 'continuation', text: line };
  const b = BODY_RE.exec(h[7]!);
  if (!b) return { type: 'continuation', text: line };
  let who = b[1]!.trimEnd();
  let stripped = false;
  for (const n of names) {
    if (who.startsWith(n + ' ')) {
      who = who.slice(n.length + 1);
      stripped = true;
      break;
    }
  }
  if (!stripped) {
    const sp = who.indexOf(' ');
    if (sp !== -1) who = who.slice(sp + 1);
  }
  let process = who;
  let image: string | undefined;
  const open = who.indexOf('(');
  if (open > 0 && who.endsWith(')')) {
    process = who.slice(0, open);
    image = who.slice(open + 1, -1);
  }
  const level = LEVELS[b[3]!] ?? 'info';
  const entry: DeviceLogInput = {
    ts: syslogTime(h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6], nowMs),
    origin: 'idevicesyslog',
    level,
    tag: image || process,
    message: b[4] ?? '',
    pid: Number(b[2]),
    process,
  };
  normalizeIosFlutter(entry);
  return { type: 'entry', entry };
}

/**
 * Flutter on iOS logs Dart prints as "flutter: …" (one record per line) and engine messages as
 * "[ERROR:flutter/…] …". Re-tag them 'flutter' (prints are info-level, whatever os_log type says).
 */
export function normalizeIosFlutter(entry: DeviceLogInput): void {
  const stripped = stripFlutterPrefix(entry.message);
  if (stripped !== null) {
    entry.message = stripped;
    entry.tag = FLUTTER_TAG;
    entry.level = flutterEngineLevel(stripped) ?? 'info';
    return;
  }
  if (entry.message.startsWith('[') && flutterEngineLevel(entry.message)) entry.tag = FLUTTER_TAG;
  if (entry.message.includes('*** Terminating app due to uncaught exception')) {
    entry.kind = 'crash';
    entry.level = 'fatal';
  }
}

/**
 * Stateful line consumer: strips ANSI, merges continuation lines into the previous record (held ≤
 * `holdMs`), reports status lines.
 */
export class SyslogLineParser {
  private names: string[] = [];
  private pending?: DeviceLogInput;
  private extra: string[] | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly emit: (entry: DeviceLogInput) => void,
    private readonly onStatus?: (connected: boolean, udid?: string) => void,
    private readonly holdMs = 80,
  ) {}

  setDeviceName(name: string | undefined): void {
    this.names = deviceNameVariants(name);
  }

  pushLine(raw: string): void {
    const line = stripAnsi(raw);
    const r = parseSyslogLine(line, this.names);
    if (r.type === 'status') {
      this.flush();
      this.onStatus?.(r.connected, r.udid);
      return;
    }
    if (r.type === 'continuation') {
      if (this.pending) {
        (this.extra ??= []).push(r.text);
        return;
      }
      if (!r.text.trim()) return;
      this.emit({ ts: Date.now(), origin: 'idevicesyslog', level: 'info', tag: 'syslog', message: r.text });
      return;
    }
    this.flush();
    this.pending = r.entry;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.holdMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    if (this.extra) {
      p.message = p.message + '\n' + this.extra.join('\n');
      this.extra = null;
    }
    this.emit(p);
  }
}
