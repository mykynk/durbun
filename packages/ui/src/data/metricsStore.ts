import type { MetricSample } from '@durbun/protocol';
import { VersionedStore } from './versioned';

/** Series key: one series per (deviceId, appId) or (deviceId, pid) — mirrors the server's metric rings. */
export function metricSeriesKey(s: Pick<MetricSample, 'deviceId' | 'appId' | 'pid'>): string {
  if (s.appId) return `${s.deviceId}|${s.appId}`;
  return `${s.deviceId}|pid:${s.pid ?? '?'}`;
}

export interface MetricSeries {
  key: string;
  deviceId: string;
  appId?: string;
  pid?: number;
  /** Samples ordered by arrival (ts ascending in practice); ring of `maxSamples`. */
  samples: MetricSample[];
  /** Last sample's arrival time (Date.now()). */
  updatedAt: number;
}

/** Live metric series (CPU / memory / FPS / jank) keyed by `metricSeriesKey`. */
export class MetricsStore extends VersionedStore {
  series = new Map<string, MetricSeries>();
  maxSamples = 3600;
  generation = 0;

  push(samples: readonly MetricSample[]): void {
    if (samples.length === 0) return;
    const now = Date.now();
    for (const s of samples) {
      const key = metricSeriesKey(s);
      let series = this.series.get(key);
      if (!series) {
        series = { key, deviceId: s.deviceId, appId: s.appId, pid: s.pid, samples: [], updatedAt: now };
        this.series.set(key, series);
      }
      const arr = series.samples;
      // Keep ts order when samples arrive slightly out of order.
      if (arr.length > 0 && s.ts < arr[arr.length - 1]!.ts) {
        let i = arr.length - 1;
        while (i > 0 && arr[i - 1]!.ts > s.ts) i--;
        arr.splice(i, 0, s);
      } else arr.push(s);
      if (arr.length > this.maxSamples) arr.splice(0, arr.length - this.maxSamples);
      series.updatedAt = now;
      if (s.pid !== undefined) series.pid = s.pid;
    }
    this.changed();
  }

  get(key: string): MetricSeries | undefined {
    return this.series.get(key);
  }

  /** Series for an app session or a (device, pid) target. */
  seriesFor(target: { deviceId: string; appId?: string; pid?: number }): MetricSeries | undefined {
    return this.series.get(metricSeriesKey(target));
  }

  latest(key: string): MetricSample | undefined {
    const s = this.series.get(key);
    return s && s.samples.length > 0 ? s.samples[s.samples.length - 1] : undefined;
  }

  keys(): string[] {
    return [...this.series.keys()];
  }

  reset(): void {
    this.series = new Map();
    this.generation++;
    this.changed();
  }

  removeWhere(predicate: (series: MetricSeries) => boolean): number {
    let removed = 0;
    for (const [key, s] of this.series) {
      if (predicate(s)) {
        this.series.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.generation++;
      this.changed();
    }
    return removed;
  }
}

export const metricsStore = new MetricsStore();
