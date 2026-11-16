import type { RecorderPause, SessionRecording } from '@durbun/protocol';
import { translate, type Lang } from '../../i18n';
import { tCodeIn } from '../../i18n/codes';
import './i18n';

/** How a recording is worded in the offer, the list and the banner (pure: tests pass `lang` and `now`). */

/** "15 Kas 21:40" (this year) / "15 Kas 2025 21:40" (another year). */
export function recordingWhen(ts: number, lang: Lang, now = Date.now()): string {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(d)
    .replace(',', '');
}

/** "under a minute", "14 min", "2 h 14 min", "3 d 2 h". */
export function recordingSpan(ms: number, lang: Lang): string {
  if (!Number.isFinite(ms) || ms < 60_000) return translate(lang, 'recordings.span.lessThanMinute');
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return translate(lang, 'recordings.span.minutes', { m: totalMin });
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? translate(lang, 'recordings.span.hours', { h, m }) : translate(lang, 'recordings.span.hoursOnly', { h });
  return translate(lang, 'recordings.span.days', { d: Math.floor(h / 24), h: h % 24 });
}

/** The recording's length: up to its end, else its last write (interrupted, or the one being written). */
export function recordingDuration(r: Pick<SessionRecording, 'startedAt' | 'endedAt' | 'lastWriteAt'>): number {
  return Math.max(0, (r.endedAt ?? r.lastWriteAt) - r.startedAt);
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function capped(values: string[], max: number, lang: Lang): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} ${translate(lang, 'recordings.who.more', { n: values.length - max })}`;
}

/** "Pixel 8, iPhone 15 · Pati, Kumbara +2": devices, then apps. */
export function recordingWho(r: Pick<SessionRecording, 'devices' | 'apps'>, lang: Lang, max = 2): string {
  const devices = uniq(r.devices.map((d) => d.name || d.id));
  const apps = uniq(r.apps.map((a) => a.name || a.bundleId));
  const parts = [devices.length ? capped(devices, max, lang) : '', apps.length ? capped(apps, max + 1, lang) : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : translate(lang, 'recordings.who.none');
}

/** "12.408 satır · 316 istek · 3 hata" (errors and crashes only when there are some). */
export function recordingCounts(r: Pick<SessionRecording, 'counts'>, lang: Lang): string {
  const c = r.counts;
  const parts = [translate(lang, 'recordings.counts.logs', { count: c.logs }), translate(lang, 'recordings.counts.requests', { count: c.requests })];
  if (c.errors > 0) parts.push(translate(lang, 'recordings.counts.errors', { count: c.errors }));
  if (c.crashes > 0) parts.push(translate(lang, 'recordings.counts.crashes', { count: c.crashes }));
  return parts.join(' · ');
}

/** A recording other than the one being written: it can be opened, exported and deleted. */
export function isClosed(r: Pick<SessionRecording, 'state'>): boolean {
  return r.state !== 'recording';
}

/** Why recording is paused, in the UI language (the server's English text when the code is unknown). */
export function pauseText(p: Pick<RecorderPause, 'code' | 'params' | 'message'>, lang: Lang): string {
  return tCodeIn(lang, p.code, p.params, p.message);
}

/** The ids the launch offer was already shown for and closed (or used), newest last. */
const OFFER_KEY = 'durbun.recordings.offerSeen';
const OFFER_KEEP = 20;

export function offerSeen(id: string): boolean {
  try {
    const raw = localStorage.getItem(OFFER_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) && ids.includes(id);
  } catch {
    return false;
  }
}

export function markOfferSeen(id: string): void {
  try {
    const raw = localStorage.getItem(OFFER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const ids = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v !== id) : [];
    ids.push(id);
    localStorage.setItem(OFFER_KEY, JSON.stringify(ids.slice(-OFFER_KEEP)));
  } catch {
    /* private window: the offer shows again next time */
  }
}
