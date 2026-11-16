import { formatClock } from '../../../components';
import { getLanguage, t } from '../../../i18n';
import type { GalleryItem } from './store';

const DAY = 24 * 3600_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "14:02:10" today, "Dün 14:02" yesterday, "14 Kas 14:02" earlier (the gallery spans 30 days). */
export function mediaTime(ts: number, now = Date.now()): string {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return formatClock(ts, { ms: false });
  const hm = formatClock(ts, { ms: false, seconds: false });
  if (day === today - DAY) return `${t('media.yesterday')} ${hm}`;
  const date = new Intl.DateTimeFormat(getLanguage() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short' }).format(new Date(ts));
  return `${date} ${hm}`;
}

/** Group heading of a day: "Bugün", "Dün", "14 Kasım Cuma". */
export function dayLabel(ts: number, now = Date.now()): string {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return t('media.today');
  if (day === today - DAY) return t('media.yesterday');
  return new Intl.DateTimeFormat(getLanguage() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'long', weekday: 'long' }).format(new Date(ts));
}

/** Items grouped by day (input newest first). */
export function groupByDay(items: readonly GalleryItem[], now = Date.now()): { key: number; label: string; items: GalleryItem[] }[] {
  const out: { key: number; label: string; items: GalleryItem[] }[] = [];
  for (const i of items) {
    const key = startOfDay(i.ts);
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(i.ts, now), items: [] };
      out.push(g);
    }
    g.items.push(i);
  }
  return out;
}

/** "0:42", "1:05:09". */
export function clock(sec: number | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function itemTitle(i: Pick<GalleryItem, 'kind' | 'ts'>, now = Date.now()): string {
  return t(i.kind === 'screenshot' ? 'media.shotTitle' : 'media.recTitle', { time: mediaTime(i.ts, now) });
}

async function pngBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${res.status}`);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  // Clipboard images must be PNG: re-encode other formats through a canvas.
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'));
}

/** Copy an image URL to the clipboard as PNG (the promise keeps the click's user activation). */
export async function copyImage(url: string): Promise<'ok' | 'denied' | 'unsupported' | 'failed'> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return 'unsupported';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(url) })]);
    return 'ok';
  } catch (err) {
    return (err as { name?: string })?.name === 'NotAllowedError' ? 'denied' : 'failed';
  }
}
