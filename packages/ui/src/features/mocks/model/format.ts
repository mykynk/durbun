import type { Lang } from '../../../i18n';

/**
 * Compact durations for settings-like values (delays, thresholds): "300 ms", "1 sn" / "1 s",
 * "1,5 sn" / "1.5 s", "2 dk" / "2 min". Measured durations keep using `formatDuration`.
 */
export function formatShortDuration(ms: number, lang: Lang): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const tr = lang === 'tr';
  const num = (v: number) => {
    const s = String(Math.round(v * 10) / 10);
    return tr ? s.replace('.', ',') : s;
  };
  if (ms < 60_000) return `${num(ms / 1000)} ${tr ? 'sn' : 's'}`;
  return `${num(ms / 60_000)} ${tr ? 'dk' : 'min'}`;
}
