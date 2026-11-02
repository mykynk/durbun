/**
 * Log / network traffic of a performance target, bucketed per second, plus timeline annotations
 * (crashes, markers, app (re)connects). Logs are scanned incrementally (by id) — never the whole ring per
 * update; network entries (≤ maxNetworkEntries, a few thousand) are re-bucketed on each throttled update
 * because their state changes after they were first seen.
 */
import type { LogEntry, NetworkEntry } from '@durbun/protocol';
import { MAX_HISTORY_MS, RateBuckets } from './model';

export type AnnotationType = 'crash' | 'anr' | 'marker' | 'connect' | 'reconnect';

export interface Annotation {
  /** Log entry id (click → show in Logs). */
  id: number;
  ts: number;
  type: AnnotationType;
  text: string;
}

/** Minimal log store surface (see data/logStore). */
export interface LogSource {
  readonly entries: readonly LogEntry[];
  readonly generation: number;
  readonly lastId: number;
  lowerBound(id: number): number;
}

const MAX_ANNOTATIONS = 400;

export function annotationType(e: LogEntry): AnnotationType | null {
  if (e.kind === 'crash') return 'crash';
  if (e.kind === 'anr') return 'anr';
  if (e.kind === 'marker') return 'marker';
  if (e.source === 'system' && e.code === 'app.connected') return 'connect';
  if (e.source === 'system' && e.code === 'app.reconnected') return 'reconnect';
  return null;
}

export function isErrorLog(e: Pick<LogEntry, 'level'>): boolean {
  return e.level === 'error' || e.level === 'fatal';
}

/** Incremental per-second log counters + annotations for one target (reset when the key or the store generation changes). */
export class LogTraffic {
  readonly buckets = new RateBuckets();
  annotations: Annotation[] = [];
  /** Bumped whenever buckets/annotations changed (memo dependency). */
  revision = 0;
  private key = '';
  private generation = -1;
  private lastId = 0;

  /**
   * Scan entries that arrived since the last call. `describe` turns an annotated entry into its label
   * (localized by the caller).
   */
  update(store: LogSource, key: string, inScope: (e: LogEntry) => boolean, describe: (e: LogEntry, type: AnnotationType) => string, now = Date.now()): boolean {
    let changed = false;
    if (key !== this.key || store.generation !== this.generation) {
      this.key = key;
      this.generation = store.generation;
      this.lastId = 0;
      this.buckets.clear();
      this.annotations = [];
      changed = true;
    }
    if (!key) return changed;
    const entries = store.entries;
    const start = this.lastId > 0 ? store.lowerBound(this.lastId + 1) : 0;
    const floor = now - MAX_HISTORY_MS;
    let added: Annotation[] | null = null;
    for (let i = start; i < entries.length; i++) {
      const e = entries[i]!;
      if (!inScope(e)) continue;
      this.buckets.add(e.ts, 'logs', 1, now);
      if (isErrorLog(e)) this.buckets.add(e.ts, 'errorLogs', 1, now);
      const type = annotationType(e);
      if (type && e.ts >= floor) (added ??= []).push({ id: e.id, ts: e.ts, type, text: describe(e, type) });
      changed = true;
    }
    if (store.lastId > this.lastId) this.lastId = store.lastId;
    if (added) {
      const next = this.annotations.concat(added);
      this.annotations = next.length > MAX_ANNOTATIONS ? next.slice(next.length - MAX_ANNOTATIONS) : next;
    }
    if (changed) {
      this.buckets.prune(Math.floor(floor / 1000));
      this.revision++;
    }
    return changed;
  }
}

/**
 * Requests per second (by start time) and failed requests per second (by end time, failed transport or
 * HTTP ≥ 400) for the entries in scope.
 */
export function networkTraffic(list: readonly NetworkEntry[], inScope: (e: NetworkEntry) => boolean, isError: (e: NetworkEntry) => boolean, now = Date.now()): RateBuckets {
  const b = new RateBuckets();
  for (const e of list) {
    if (!inScope(e)) continue;
    b.add(e.startTs, 'requests', 1, now);
    if (isError(e)) b.add(e.endTs ?? e.startTs, 'failedRequests', 1, now);
  }
  return b;
}
