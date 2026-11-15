import type { AppSession } from '@durbun/protocol';
import { t } from '../i18n';
import { formatDuration, formatNumber } from '../lib/format';

/** Below this the device clock is taken as matching the Mac (keepalive estimates are rough). */
export const CLOCK_NOTE_MS = 5_000;

export interface ClockSkew {
  /** The device clock against the Mac's. */
  direction: 'ahead' | 'behind';
  ms: number;
  accuracyMs?: number;
}

/** How far the device clock is off, when it is off by more than `CLOCK_NOTE_MS`. */
export function clockSkewOf(s: Pick<AppSession, 'clockOffsetMs' | 'clockOffsetAccuracyMs'> | undefined): ClockSkew | undefined {
  const off = s?.clockOffsetMs;
  if (typeof off !== 'number' || !Number.isFinite(off) || Math.abs(off) <= CLOCK_NOTE_MS) return undefined;
  const acc = s?.clockOffsetAccuracyMs;
  // clockOffsetMs is Mac minus device: positive means the device clock is behind.
  return { direction: off > 0 ? 'behind' : 'ahead', ms: Math.abs(off), ...(typeof acc === 'number' && Number.isFinite(acc) && acc >= 0 ? { accuracyMs: acc } : {}) };
}

/** "12 sn" under a minute and a half, then "3 dk 5 sn" / "2 sa 1 dk". */
function skewAmount(ms: number): string {
  return ms < 90_000 ? t('sources.session.seconds', { n: formatNumber(Math.round(ms / 1000)) }) : formatDuration(ms);
}

/** "Cihaz saati Mac’ten 12 sn ileri (± 180 ms)". */
export function clockSkewText(skew: ClockSkew): string {
  const text = t(`sources.session.clock.${skew.direction}`, { amount: skewAmount(skew.ms) });
  return skew.accuracyMs !== undefined ? `${text} (± ${formatDuration(skew.accuracyMs)})` : text;
}

/** "Flutter SDK 0.3.0 · protokol 2" pieces: the protocol part, when the SDK announced one. */
export function protocolText(s: Pick<AppSession, 'sdkProtocol'>): string | undefined {
  return typeof s.sdkProtocol === 'number' ? t('sources.session.protocol', { n: s.sdkProtocol }) : undefined;
}

/** Badge label and one-line explanation of a protocol mismatch, or undefined when compatible or unknown. */
export function protocolMismatchText(s: Pick<AppSession, 'protocolMismatch'>): { label: string; body: string } | undefined {
  if (s.protocolMismatch !== 'sdk-newer' && s.protocolMismatch !== 'sdk-older') return undefined;
  return { label: t(`sources.session.mismatch.${s.protocolMismatch}.label`), body: t(`sources.session.mismatch.${s.protocolMismatch}.body`) };
}
