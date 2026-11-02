import { SEV_ERROR, SEV_WARN, type Severity } from './types';

/**
 * Incremental log-volume histogram: per-second base buckets (3 severity tiers) updated as rows are
 * added/dropped; `view()` aggregates them into N display buckets on demand (O(base buckets)).
 */

export interface HistogramView {
  /** Start of the first display bucket (epoch ms). */
  from: number;
  /** End of the last display bucket (exclusive). */
  to: number;
  /** Display bucket width in ms. */
  step: number;
  count: number;
  err: Uint32Array;
  warn: Uint32Array;
  other: Uint32Array;
  /** Largest bucket total (for scaling). */
  max: number;
  total: number;
}

export const EMPTY_HISTOGRAM: HistogramView = {
  from: 0,
  to: 0,
  step: 1000,
  count: 0,
  err: new Uint32Array(0),
  warn: new Uint32Array(0),
  other: new Uint32Array(0),
  max: 0,
  total: 0,
};

export class HistogramIndex {
  /** key = floor(ts / resMs) → [other, warn, error] */
  private buckets = new Map<number, Int32Array>();
  total = 0;
  /** Bumped on every change (cheap "did anything change" check for throttled renders). */
  version = 0;

  constructor(readonly resMs = 1000) {}

  add(ts: number, sev: Severity, n = 1): void {
    if (!Number.isFinite(ts)) return;
    const k = Math.floor(ts / this.resMs);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = new Int32Array(3)));
    b[sev]! += n;
    this.total += n;
    this.version++;
  }

  remove(ts: number, sev: Severity, n = 1): void {
    if (!Number.isFinite(ts)) return;
    const k = Math.floor(ts / this.resMs);
    const b = this.buckets.get(k);
    if (!b) return;
    b[sev] = Math.max(0, b[sev]! - n);
    this.total = Math.max(0, this.total - n);
    if (b[0] === 0 && b[1] === 0 && b[2] === 0) this.buckets.delete(k);
    this.version++;
  }

  clear(): void {
    this.buckets.clear();
    this.total = 0;
    this.version++;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Data range [from, to) in ms, or null when empty. */
  range(): { from: number; to: number } | null {
    if (this.buckets.size === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const k of this.buckets.keys()) {
      if (k < min) min = k;
      if (k > max) max = k;
    }
    return { from: min * this.resMs, to: (max + 1) * this.resMs };
  }

  /**
   * Aggregate into at most `maxBuckets` display buckets (never narrower than the base resolution). The
   * span is at least `minSpanMs` (ending at the newest data) so a young session fills in from the right
   * instead of stretching a few seconds over the whole strip.
   */
  view(maxBuckets: number, minSpanMs = 0): HistogramView {
    const r = this.range();
    if (!r || maxBuckets <= 0) return EMPTY_HISTOGRAM;
    if (r.to - r.from < minSpanMs) r.from = r.to - Math.ceil(minSpanMs / this.resMs) * this.resMs;
    const span = r.to - r.from;
    const count = Math.max(1, Math.min(maxBuckets, Math.round(span / this.resMs)));
    const step = span / count;
    const err = new Uint32Array(count);
    const warn = new Uint32Array(count);
    const other = new Uint32Array(count);
    for (const [k, b] of this.buckets) {
      let i = Math.floor((k * this.resMs - r.from) / step);
      if (i < 0) i = 0;
      else if (i >= count) i = count - 1;
      other[i]! += b[0]!;
      warn[i]! += b[SEV_WARN]!;
      err[i]! += b[SEV_ERROR]!;
    }
    let max = 0;
    for (let i = 0; i < count; i++) {
      const s = other[i]! + warn[i]! + err[i]!;
      if (s > max) max = s;
    }
    return { from: r.from, to: r.to, step, count, err, warn, other, max, total: this.total };
  }
}
