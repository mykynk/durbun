import type { LogEntry } from '@durbun/protocol';
import { formatDuration } from '../../../lib/format';
import { systemLineText, t, type Lang } from '../../../i18n';
import { FLAP_DROP_CODES } from './types';

/**
 * Localized text of a Dürbün system line (lifecycle separators, markers — SPEC §9.2). The shared
 * `code.*` dictionary understands the params the server sends (`{device}`, `{app}`, `{process}`,
 * `{label, n}`, `failedRequests`…); unknown codes fall back to the server's English message.
 */
export function systemText(e: Pick<LogEntry, 'code' | 'params' | 'message'>): string {
  return systemLineText({ code: e.code, params: e.params, message: e.message });
}

export interface FlapSummary {
  /** «Yusuf iPhone’u: bağlantı 6 kez koptu ve geri geldi · 40 sn içinde» */
  text: string;
  /** What to check when it keeps happening (a loose cable). */
  hint?: string;
}

/** "40 sn" / "1 dk 5 sn" — whole seconds (the separators carry second-precision times). */
function spanText(ms: number, lang?: Lang): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec < 60 ? t('logs.flap.seconds', { count: sec }) : formatDuration(sec * 1000, { lang });
}

type FlapEvent = Pick<LogEntry, 'code' | 'params' | 'ts'>;

const isDrop = (e: FlapEvent) => FLAP_DROP_CODES.has(e.code ?? '');

/**
 * How long one outage lasted: from the first event `from` matches to the first later event that says it is back.
 * The group's first event is usually the plug-in connect, so the group's span would count normal connected time.
 */
function outage(events: readonly FlapEvent[], from: (e: FlapEvent) => boolean): number {
  const i = events.findIndex(from);
  if (i < 0) return 0;
  const j = events.findIndex((e, k) => k > i && !isDrop(e));
  return (j < 0 ? events[events.length - 1]! : events[j]!).ts - events[i]!.ts;
}

/**
 * One line for a device's merged connection / log-stream separators (`LogRow.flap`). `deviceName` is the hub's
 * display name of the row's device; the server's `params.device` and "Cihaz" are fallbacks.
 */
export function flapSummary(events: readonly FlapEvent[], deviceName?: string, lang?: Lang): FlapSummary {
  const named = events.map((e) => e.params?.device).find((v): v is string => typeof v === 'string' && v.length > 0);
  const device = deviceName || named || t('logs.flap.device');
  const last = events[events.length - 1]!;
  // Several drops: the time it kept dropping (first drop → newest event).
  const firstDrop = events.find(isDrop) ?? events[0]!;
  const span = spanText(last.ts - firstDrop.ts, lang);
  const back = !isDrop(last);
  // A device that went away: hub disconnects, or an iPhone's USB drop it came back from within the grace.
  const isConnectionDrop = (e: FlapEvent) => e.code === 'device.disconnected' || e.code === 'logs.connectionLost';
  const drops = events.filter(isConnectionDrop).length;
  if (drops > 0) {
    if (drops === 1 && back) return { text: t('logs.flap.backAfter', { device, span: spanText(outage(events, isConnectionDrop), lang) }) };
    return { text: t(back ? 'logs.flap.dropsBack' : 'logs.flap.drops', { device, count: drops, span }), hint: drops >= 3 ? t('logs.flap.hint') : undefined };
  }
  // Failures count; a requested restart (logs.streamStopped) next to one is part of the same outage.
  const isFailure = (e: FlapEvent) => e.code === 'logs.streamError' || e.code === 'logs.streamStalled';
  const fails = events.filter(isFailure).length;
  const stops = Math.max(1, fails || events.filter((e) => e.code === 'logs.streamStopped').length);
  const oneSpan = stops === 1 && back ? spanText(outage(events, (e) => isFailure(e) || e.code === 'logs.streamStopped'), lang) : span;
  return { text: t(back ? 'logs.flap.streamBack' : 'logs.flap.stream', { device, count: stops, span: oneSpan }) };
}

/** "23:50:42–23:51:20", or one clock when both ends fall in the same second. */
export function flapTimeRange(first: number, last: number, clock: (ts: number) => string): string {
  const a = clock(first);
  const b = clock(last);
  return a === b ? a : `${a}–${b}`;
}
