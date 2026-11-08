/**
 * Metric samples: one bounded ring per series (deviceId + appId, or deviceId + pid). Every Flutter hot
 * restart is a new app session and so a new series, and the Mac app runs for days, so the store is bounded
 * as a whole too: at most MAX_METRIC_SAMPLES samples (the series that went longest without a sample go first)
 * and series without a sample for METRIC_SERIES_TTL_MS are dropped. Series the hub wants kept (`keep`: a
 * connected session, the newest session of each app, which the Performance view shows) are spared by the
 * TTL and evicted for the cap only after all others.
 */
import type { MetricSample } from '@durbun/protocol';
import { RingBuffer } from './ringBuffer';

export const METRIC_SAMPLES_PER_SERIES = 3600;
/** All series together (~15 MB as JSON; every UI snapshot carries them). */
export const MAX_METRIC_SAMPLES = 100_000;
/** A series that got no sample for this long is dropped unless kept. */
export const METRIC_SERIES_TTL_MS = 6 * 60 * 60_000;
const PRUNE_EVERY_MS = 60_000;

/** What `keep` sees of a series. */
export interface MetricSeriesInfo {
  deviceId: string;
  appId?: string;
  pid?: number;
}

export interface MetricsStoreOptions {
  perSeries?: number;
  maxSamples?: number;
  ttlMs?: number;
  /** Called once per pruning pass; the returned predicate says which series must be spared. */
  keep?: () => (series: MetricSeriesInfo) => boolean;
  now?: () => number;
}

interface Series extends MetricSeriesInfo {
  ring: RingBuffer<MetricSample>;
  /** Arrival time of the newest sample (the store's clock, not the device's). */
  updatedAt: number;
}

const NUMERIC_FIELDS = [
  'cpu',
  'memoryMB',
  'heapMB',
  'fps',
  'jankyFrames',
  'frameBuildMs',
  'frameRasterMs',
  'threads',
] as const;

const SOURCES = new Set<MetricSample['source']>(['sdk', 'vm-service', 'adb', 'host', 'demo']);

export function seriesKey(sample: Pick<MetricSample, 'deviceId' | 'appId' | 'pid'>): string {
  if (sample.appId) return `${sample.deviceId}\u0000app\u0000${sample.appId}`;
  return `${sample.deviceId}\u0000pid\u0000${sample.pid ?? '?'}`;
}

/** Copies a sample keeping only valid fields (finite numbers); undefined when nothing useful remains. */
export function sanitizeSample(input: Partial<MetricSample> & { deviceId: string }): MetricSample | undefined {
  const ts = typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : Date.now();
  const source = input.source && SOURCES.has(input.source) ? input.source : 'sdk';
  const out: MetricSample = { ts, deviceId: input.deviceId, source };
  if (typeof input.appId === 'string' && input.appId) out.appId = input.appId;
  if (typeof input.pid === 'number' && Number.isFinite(input.pid)) out.pid = input.pid;
  let any = false;
  for (const field of NUMERIC_FIELDS) {
    const v = input[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[field] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

export class MetricsStore {
  private readonly series = new Map<string, Series>();
  private total = 0;
  private lastPrune: number;
  private readonly perSeries: number;
  private readonly maxSamples: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: MetricsStoreOptions = {}) {
    this.perSeries = opts.perSeries ?? METRIC_SAMPLES_PER_SERIES;
    this.maxSamples = Math.max(this.perSeries, opts.maxSamples ?? MAX_METRIC_SAMPLES);
    this.ttlMs = opts.ttlMs ?? METRIC_SERIES_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.lastPrune = this.now();
  }

  push(sample: MetricSample): void {
    const now = this.now();
    const key = seriesKey(sample);
    let series = this.series.get(key);
    if (!series) {
      series = { deviceId: sample.deviceId, ring: new RingBuffer<MetricSample>(this.perSeries), updatedAt: now };
      if (sample.appId) series.appId = sample.appId;
      else if (sample.pid !== undefined) series.pid = sample.pid;
      this.series.set(key, series);
    }
    if (series.ring.push(sample) === undefined) this.total++;
    series.updatedAt = now;
    if (this.total > this.maxSamples) this.evictOldest(key);
    if (now - this.lastPrune >= PRUNE_EVERY_MS) this.prune(now);
  }

  /** Drop series that got no sample for `ttlMs`, unless kept. Runs from push() about once a minute. */
  prune(now = this.now()): void {
    this.lastPrune = now;
    const keep = this.opts.keep?.();
    for (const [key, series] of this.series) {
      if (now - series.updatedAt <= this.ttlMs || keep?.(series)) continue;
      this.drop(key, series);
    }
  }

  all(filter?: (sample: MetricSample) => boolean): MetricSample[] {
    const out: MetricSample[] = [];
    for (const { ring } of this.series.values()) {
      ring.forEach((s) => {
        if (!filter || filter(s)) out.push(s);
      });
    }
    return out;
  }

  /** Removes samples matching the predicate (whole series when all of its samples match). */
  removeWhere(pred: (sample: MetricSample) => boolean): void {
    for (const [key, series] of [...this.series]) {
      this.total -= series.ring.retain((s) => !pred(s)).length;
      if (series.ring.size === 0) this.series.delete(key);
    }
  }

  clear(): void {
    this.series.clear();
    this.total = 0;
  }

  get seriesCount(): number {
    return this.series.size;
  }

  get sampleCount(): number {
    return this.total;
  }

  /**
   * Over the cap: drop whole series, least recently updated first, kept ones last, never `except`, down to
   * 90 % of the cap (so the next pushes do not scan again at once).
   */
  private evictOldest(except: string): void {
    const keep = this.opts.keep?.();
    const target = Math.max(this.perSeries, Math.floor(this.maxSamples * 0.9));
    while (this.total > target) {
      let victim: [string, Series] | undefined;
      let victimKept = true;
      for (const entry of this.series) {
        if (entry[0] === except) continue;
        const kept = keep?.(entry[1]) ?? false;
        if (!victim || (victimKept && !kept) || (victimKept === kept && entry[1].updatedAt < victim[1].updatedAt)) {
          victim = entry;
          victimKept = kept;
        }
      }
      if (!victim) return;
      this.drop(victim[0], victim[1]);
    }
  }

  private drop(key: string, series: Series): void {
    this.series.delete(key);
    this.total -= series.ring.size;
  }
}
