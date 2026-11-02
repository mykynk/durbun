/** Metric samples: one bounded ring per series (deviceId + appId, or deviceId + pid). */
import type { MetricSample } from '@durbun/protocol';
import { RingBuffer } from './ringBuffer';

export const METRIC_SAMPLES_PER_SERIES = 3600;

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
  private readonly series = new Map<string, RingBuffer<MetricSample>>();

  constructor(private readonly perSeries = METRIC_SAMPLES_PER_SERIES) {}

  push(sample: MetricSample): void {
    const key = seriesKey(sample);
    let ring = this.series.get(key);
    if (!ring) {
      ring = new RingBuffer<MetricSample>(this.perSeries);
      this.series.set(key, ring);
    }
    ring.push(sample);
  }

  all(filter?: (sample: MetricSample) => boolean): MetricSample[] {
    const out: MetricSample[] = [];
    for (const ring of this.series.values()) {
      ring.forEach((s) => {
        if (!filter || filter(s)) out.push(s);
      });
    }
    return out;
  }

  /** Removes samples matching the predicate (whole series when all of its samples match). */
  removeWhere(pred: (sample: MetricSample) => boolean): void {
    for (const [key, ring] of [...this.series]) {
      ring.retain((s) => !pred(s));
      if (ring.size === 0) this.series.delete(key);
    }
  }

  clear(): void {
    this.series.clear();
  }

  get seriesCount(): number {
    return this.series.size;
  }
}
