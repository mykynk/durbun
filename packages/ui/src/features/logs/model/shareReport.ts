import type { ErrorInfo, LogLevel } from '@durbun/protocol';
import { MAX_SHARED_BODY_CHARS, fenced, shareTime } from '../../network/model/shareReport';

/**
 * The share report of one log line: what a teammate needs in Slack, Jira or an e-mail without Dürbün.
 * Same light Markdown as the request report (`network/model/shareReport.ts`); the Flutter in-app panel
 * builds the same text (`share_report.dart`, `buildLogReport`). The Share dialog masks secret-looking values
 * first (`maskLog.ts`, on by default); the preview is exactly what goes out.
 */

export interface LogShareInput {
  level: LogLevel;
  tag?: string;
  /** "Crash", "ANR", "Flutter error" (already localized); nothing for plain lines. */
  kind?: string;
  /** Epoch ms. */
  ts: number;
  /** Minutes east of UTC for the local time (default: this machine's offset at `ts`). */
  utcOffsetMinutes?: number;
  app?: string;
  device?: string;
  /** "com.example.shop 4211" */
  process?: string;
  message: string;
  /** Structured data the app logged with the line (shown as JSON). */
  data?: unknown;
  error?: ErrorInfo;
}

export interface LogShareLabels {
  time: string;
  app: string;
  device: string;
  process: string;
  message: string;
  data: string;
  error: string;
  stack: string;
  more: (chars: number) => string;
}

function capped(out: string[], text: string, labels: LogShareLabels, language = ''): void {
  let shown = text;
  let rest = 0;
  if (shown.length > MAX_SHARED_BODY_CHARS) {
    let cut = MAX_SHARED_BODY_CHARS;
    const code = shown.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    rest = shown.length - cut;
    shown = shown.slice(0, cut);
  }
  fenced(out, language, shown);
  if (rest > 0) out.push(labels.more(rest), '');
}

/** Several lines (a selection, a time range): a short head and the lines as plain text. */
export interface LinesShareInput {
  /** "12 log lines" (already localized). */
  title: string;
  /** Oldest and newest line time (epoch ms). */
  from: number;
  to: number;
  utcOffsetMinutes?: number;
  /** "All devices", "Shop · Pixel 8". */
  scope?: string;
  /** Set when every line comes from one app / one device. */
  app?: string;
  device?: string;
  /** The lines, one logcat-like line each (continuation lines indented). */
  text: string;
  /** "Secret values were masked" when anything was masked. */
  maskedNote?: string;
}

export interface LinesShareLabels {
  range: string;
  scope: string;
  app: string;
  device: string;
  more: (chars: number) => string;
}

/** Lines are cut here: a chat message or a ticket stays readable (the .txt export has everything). */
export const MAX_SHARED_LINES_CHARS = 60_000;

export function buildLinesReport(input: LinesShareInput, labels: LinesShareLabels): string {
  const out: string[] = [input.title, ''];
  const from = shareTime(input.from, input.utcOffsetMinutes);
  const to = shareTime(input.to, input.utcOffsetMinutes);
  out.push(`- ${labels.range}: ${input.from === input.to ? from : `${from.split(' (')[0]} – ${to.split(' · ')[0]}`}`);
  if (input.scope) out.push(`- ${labels.scope}: ${input.scope}`);
  if (input.app) out.push(`- ${labels.app}: ${input.app}`);
  if (input.device) out.push(`- ${labels.device}: ${input.device}`);
  out.push('');
  let text = input.text.replace(/\s+$/, '');
  let rest = 0;
  if (text.length > MAX_SHARED_LINES_CHARS) {
    // Cut at a line end so the last line is whole.
    const nl = text.lastIndexOf('\n', MAX_SHARED_LINES_CHARS);
    const cut = nl > MAX_SHARED_LINES_CHARS / 2 ? nl : MAX_SHARED_LINES_CHARS;
    rest = text.length - cut;
    text = text.slice(0, cut);
  }
  fenced(out, '', text);
  if (rest > 0) out.push(labels.more(rest), '');
  if (input.maskedNote) out.push(`_${input.maskedNote}_`);
  return out.join('\n').trimEnd();
}

export function buildLogReport(input: LogShareInput, labels: LogShareLabels): string {
  const head = [input.level.toUpperCase(), input.kind, input.tag].filter(Boolean).join(' · ');
  const out: string[] = [head, ''];
  out.push(`- ${labels.time}: ${shareTime(input.ts, input.utcOffsetMinutes)}`);
  if (input.app) out.push(`- ${labels.app}: ${input.app}`);
  if (input.device) out.push(`- ${labels.device}: ${input.device}`);
  if (input.process) out.push(`- ${labels.process}: ${input.process}`);
  out.push('');

  const message = input.message.replace(/\s+$/, '');
  if (message) {
    out.push(`${labels.message}:`);
    capped(out, message, labels);
  }
  if (input.data !== undefined && input.data !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(input.data, null, 2);
    } catch {
      json = undefined;
    }
    if (json) {
      out.push(`${labels.data}:`);
      capped(out, json, labels, 'json');
    }
  }
  const err = input.error;
  const errText = [err?.type, err?.message].filter(Boolean).join(': ');
  if (errText && !message.includes(err?.message ?? errText)) out.push(`${labels.error}: ${errText}`, '');
  const stack = err?.stack?.replace(/\s+$/, '');
  if (stack && !message.includes(stack.split('\n')[0]!)) {
    out.push(`${labels.stack}:`);
    capped(out, stack, labels);
  }
  return out.join('\n').trimEnd();
}
