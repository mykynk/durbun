import { getLanguage, type Lang } from '../i18n/core';

/**
 * Formatters. Numbers/bytes/durations follow the UI language (Turkish uses a decimal comma:
 * "4,2 KB", "1,23 sn"); log timestamps use the universal "HH:mm:ss.SSS" / "+12.345" style so log
 * columns stay aligned. All accept an optional `lang` (tests, explicit contexts).
 */

const locale = (lang: Lang) => (lang === 'tr' ? 'tr-TR' : 'en-US');
const cache = new Map<string, Intl.NumberFormat>();

function nf(lang: Lang, min: number, max: number): Intl.NumberFormat {
  const key = `${lang}|${min}|${max}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(lang), { minimumFractionDigits: min, maximumFractionDigits: max });
    cache.set(key, f);
  }
  return f;
}

const DASH = '—';

export function formatNumber(n: number | null | undefined, opts: { lang?: Lang; maxFractionDigits?: number } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return nf(opts.lang ?? getLanguage(), 0, opts.maxFractionDigits ?? 0).format(n);
}

/** 999 → "999", 12 345 → "12,3K" / "12.3K", 2 500 000 → "2,5M". Units are kept language-neutral (K/M/B). */
export function formatCompact(n: number | null | undefined, opts: { lang?: Lang } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const lang = opts.lang ?? getLanguage();
  const abs = Math.abs(n);
  if (abs < 1000) return nf(lang, 0, 0).format(n);
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [div, unit] of units) {
    if (abs >= div) {
      const v = n / div;
      return `${nf(lang, 0, Math.abs(v) < 10 ? 1 : 0).format(v)}${unit}`;
    }
  }
  return nf(lang, 0, 0).format(n);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1023 → "1023 B", 4300 → "4,2 KB" (tr) / "4.2 KB" (en), 5 242 880 → "5 MB". */
export function formatBytes(bytes: number | null | undefined, opts: { lang?: Lang } = {}): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return DASH;
  const lang = opts.lang ?? getLanguage();
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${nf(lang, 0, v < 10 ? 1 : 0).format(v)} ${BYTE_UNITS[i]}`;
}

/** 0.42 → "0,42 ms", 123 → "123 ms", 1234 → "1,23 sn" (tr) / "1.23 s" (en), 125 000 → "2 dk 5 sn" / "2m 5s". */
export function formatDuration(ms: number | null | undefined, opts: { lang?: Lang } = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH;
  const lang = opts.lang ?? getLanguage();
  const tr = lang === 'tr';
  const sec = tr ? 'sn' : 's';
  if (ms < 1) return `${nf(lang, 0, 2).format(ms)} ms`;
  if (ms < 10) return `${nf(lang, 0, 1).format(ms)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${nf(lang, 2, 2).format(ms / 1000)} ${sec}`;
  if (ms < 60_000) return `${nf(lang, 1, 1).format(ms / 1000)} ${sec}`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return tr ? `${m} dk ${s} sn` : `${m}m ${s}s`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return tr ? `${h} sa ${m} dk` : `${h}h ${m}m`;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
const pad3 = (n: number) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n));

/** Local wall-clock time "HH:mm:ss.SSS" (ms optional). */
export function formatClock(ts: number, opts: { ms?: boolean; seconds?: boolean } = {}): string {
  if (!Number.isFinite(ts)) return DASH;
  const d = new Date(ts);
  let out = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (opts.seconds !== false) out += `:${pad2(d.getSeconds())}`;
  if (opts.ms !== false && opts.seconds !== false) out += `.${pad3(d.getMilliseconds())}`;
  return out;
}

/** "+12.345", "+2:05.123", "+1:02:05.123" (negative → "−…"). */
export function formatOffset(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms);
  const totalMs = Math.round(abs);
  const msPart = pad3(totalMs % 1000);
  const totalSec = Math.floor(totalMs / 1000);
  if (totalSec < 60) return `${sign}${totalSec}.${msPart}`;
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${sign}${totalMin}:${pad2(s)}.${msPart}`;
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${sign}${h}:${pad2(m)}:${pad2(s)}.${msPart}`;
}

export type TimeFormatMode = 'absolute' | 'relative' | 'delta';

/**
 * Log timestamp in the user's chosen format:
 * - absolute: "14:05:12.345"
 * - relative: offset from `base` (e.g. first visible entry or session start): "+12.345"
 * - delta: offset from the previous row (`prev`): "+0.012"
 */
export function formatTime(ts: number, opts: { format?: TimeFormatMode; base?: number; prev?: number; ms?: boolean } = {}): string {
  const format = opts.format ?? 'absolute';
  if (format === 'relative' && opts.base !== undefined) return formatOffset(ts - opts.base);
  if (format === 'delta') return opts.prev === undefined ? formatOffset(0) : formatOffset(ts - opts.prev);
  return formatClock(ts, { ms: opts.ms !== false });
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(lang: Lang): Intl.RelativeTimeFormat {
  let f = rtfCache.get(lang);
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto', style: 'short' });
    rtfCache.set(lang, f);
  }
  return f;
}

/** "3 sn. önce" / "3 sec. ago", "dün" / "yesterday". */
export function formatRelative(ts: number, now: number = Date.now(), opts: { lang?: Lang } = {}): string {
  if (!Number.isFinite(ts)) return DASH;
  const lang = opts.lang ?? getLanguage();
  const diffSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(diffSec);
  const f = rtf(lang);
  if (abs < 5) return f.format(0, 'second');
  if (abs < 60) return f.format(diffSec, 'second');
  if (abs < 3600) return f.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return f.format(Math.round(diffSec / 3600), 'hour');
  return f.format(Math.round(diffSec / 86_400), 'day');
}

/** "2 Kas 2026 14:05:12" / "Nov 2, 2026, 14:05:12". */
export function formatDateTime(ts: number, opts: { lang?: Lang; seconds?: boolean } = {}): string {
  if (!Number.isFinite(ts)) return DASH;
  const lang = opts.lang ?? getLanguage();
  return new Intl.DateTimeFormat(locale(lang), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: opts.seconds === false ? undefined : '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ts));
}

/** 45.2 → "%45" (tr) / "45%" (en). Input is a percentage (0–100+). */
export function formatPercent(value: number | null | undefined, opts: { lang?: Lang; digits?: number } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const lang = opts.lang ?? getLanguage();
  return new Intl.NumberFormat(locale(lang), { style: 'percent', maximumFractionDigits: opts.digits ?? 0 }).format(value / 100);
}
