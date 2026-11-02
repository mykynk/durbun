import type { NetworkEntry, Timings } from '@durbun/protocol';

/** Timing phases and waterfall geometry. */

export type Phase = 'queue' | 'dns' | 'connect' | 'tls' | 'send' | 'wait' | 'receive';

export const TIMING_PHASES: readonly Exclude<Phase, 'queue'>[] = ['dns', 'connect', 'tls', 'send', 'wait', 'receive'];

export interface PhaseSpan {
  phase: Phase;
  /** Offset from the request start (ms). */
  start: number;
  ms: number;
}

export interface TimingBreakdown {
  spans: PhaseSpan[];
  /** Total duration (ms), or undefined while pending without an end. */
  total: number | undefined;
  /** At least one phase was reported by the SDK. */
  known: boolean;
  /** Sum of the reported phases (ms). */
  reported: number;
}

function phaseMs(t: Timings | undefined, p: Exclude<Phase, 'queue'>): number {
  const v = t?.[p];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Phases laid out one after another. Time the SDK did not attribute to a phase (queueing, stalls,
 * redirects) is shown first as "queue"; phases that add up to more than the total (clock rounding)
 * are scaled down to fit.
 */
export function timingBreakdown(e: Pick<NetworkEntry, 'timings' | 'duration' | 'startTs' | 'endTs'>): TimingBreakdown {
  const total = e.duration ?? (e.endTs !== undefined ? Math.max(0, e.endTs - e.startTs) : undefined);
  const raw = TIMING_PHASES.map((p) => ({ phase: p, ms: phaseMs(e.timings, p) })).filter((x) => x.ms > 0);
  const reported = raw.reduce((s, x) => s + x.ms, 0);
  const spans: PhaseSpan[] = [];
  if (raw.length === 0) return { spans, total, known: false, reported: 0 };
  const scale = total !== undefined && reported > total && reported > 0 ? total / reported : 1;
  let t = 0;
  const gap = total !== undefined ? Math.max(0, total - reported) : 0;
  if (gap >= 1) {
    spans.push({ phase: 'queue', start: 0, ms: gap });
    t = gap;
  }
  for (const x of raw) {
    const ms = x.ms * scale;
    spans.push({ phase: x.phase, start: t, ms });
    t += ms;
  }
  return { spans, total, known: true, reported };
}

export interface TimeRange {
  start: number;
  end: number;
}

/** Time range covered by the given entries (pending ones extend to `now`). */
export function rangeOf(entries: readonly (NetworkEntry | undefined)[], now: number): TimeRange | null {
  let start = Infinity;
  let end = -Infinity;
  for (const e of entries) {
    if (!e) continue;
    start = Math.min(start, e.startTs);
    const stop = e.endTs ?? (e.state === 'pending' ? Math.max(now, e.startTs) : e.startTs + (e.duration ?? 0));
    end = Math.max(end, stop);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end - start < 1) end = start + 1;
  return { start, end };
}

export interface BarLayout {
  /** Fraction of the cell width (0–1). */
  left: number;
  width: number;
  /** Still pending: the bar runs to the end of the range. */
  open: boolean;
}

/** Position of an entry's bar within a range (at least a 2px-ish sliver so short requests stay visible). */
export function barLayout(e: NetworkEntry, range: TimeRange, now: number): BarLayout {
  const span = range.end - range.start;
  const open = e.state === 'pending' && e.endTs === undefined;
  const stop = e.endTs ?? (open ? Math.max(now, e.startTs) : e.startTs + (e.duration ?? 0));
  const left = Math.min(1, Math.max(0, (e.startTs - range.start) / span));
  const width = Math.min(1 - left, Math.max(0.004, (stop - e.startTs) / span));
  return { left, width, open };
}
