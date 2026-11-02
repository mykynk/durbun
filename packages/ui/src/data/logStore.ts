import { DEFAULT_SETTINGS, type LogEntry } from '@durbun/protocol';
import { VersionedStore } from './versioned';

/** Incrementally maintained counters (cheap badges/status bar without scanning 200k entries). */
export interface LogCounts {
  total: number;
  warn: number;
  /** error + fatal */
  error: number;
  /** kind crash | anr | flutter-error */
  crash: number;
}

export const emptyLogCounts = (): LogCounts => ({ total: 0, warn: 0, error: 0, crash: 0 });

export function isCrashEntry(e: Pick<LogEntry, 'kind'>): boolean {
  return e.kind === 'crash' || e.kind === 'anr' || e.kind === 'flutter-error';
}

function applyCounts(c: LogCounts, e: LogEntry, sign: 1 | -1): void {
  c.total += sign;
  if (e.level === 'warn') c.warn += sign;
  else if (e.level === 'error' || e.level === 'fatal') c.error += sign;
  if (isCrashEntry(e)) c.crash += sign;
}

/**
 * All log entries received from the server, ordered by `id` (arrival order — SPEC §4).
 *
 * `entries` is an append-only ring trimmed at `maxEntries` (oldest dropped first). It is mutated in
 * place: read it during render keyed on `useLogVersion()` and never mutate it yourself.
 * - `headDropped`: entries trimmed from the head since the last reset (absolute index = headDropped + i).
 * - `generation`: bumped on reset / removeWhere (arbitrary removals) — drop derived caches when it changes.
 */
export class LogStore extends VersionedStore {
  entries: LogEntry[] = [];
  maxEntries: number = DEFAULT_SETTINGS.maxLogEntries;
  /** Entries accepted since page load (monotonic, history included). */
  totalReceived = 0;
  /** Live entries accepted since page load (monotonic, history excluded; used for ingest rates). */
  liveReceived = 0;
  headDropped = 0;
  generation = 0;
  lastId = 0;
  counts: LogCounts = emptyLogCounts();
  countsByDevice = new Map<string, LogCounts>();
  countsByApp = new Map<string, LogCounts>();

  private count(e: LogEntry, sign: 1 | -1): void {
    applyCounts(this.counts, e, sign);
    let d = this.countsByDevice.get(e.deviceId);
    if (!d) this.countsByDevice.set(e.deviceId, (d = emptyLogCounts()));
    applyCounts(d, e, sign);
    if (e.appId) {
      let a = this.countsByApp.get(e.appId);
      if (!a) this.countsByApp.set(e.appId, (a = emptyLogCounts()));
      applyCounts(a, e, sign);
    }
  }

  /**
   * Append a batch. Out-of-order and duplicate ids are handled. Pass `{ history: true }` for
   * replayed history so it does not count towards the live ingest rate.
   */
  append(batch: readonly LogEntry[], opts: { history?: boolean } = {}): void {
    if (batch.length === 0) return;
    const arr = this.entries;
    let prev = this.lastId;
    let sorted = true;
    for (let i = 0; i < batch.length; i++) {
      const id = batch[i]!.id;
      if (!(id > prev)) {
        sorted = false;
        break;
      }
      prev = id;
    }
    let accepted = 0;
    if (sorted) {
      for (let i = 0; i < batch.length; i++) {
        const e = batch[i]!;
        arr.push(e);
        this.count(e, 1);
      }
      accepted = batch.length;
      this.lastId = prev;
    } else {
      const items = [...batch].sort((a, b) => a.id - b.id);
      for (const e of items) {
        if (e.id > this.lastId) {
          arr.push(e);
          this.lastId = e.id;
        } else {
          const idx = this.lowerBound(e.id);
          if (idx < arr.length && arr[idx]!.id === e.id) {
            // Same id delivered twice (history/live overlap) → keep the latest copy.
            this.count(arr[idx]!, -1);
            arr[idx] = e;
            this.count(e, 1);
            continue;
          }
          arr.splice(idx, 0, e);
          this.generation++;
        }
        this.count(e, 1);
        accepted++;
      }
    }
    this.totalReceived += accepted;
    if (!opts.history) this.liveReceived += accepted;
    this.trim();
    this.changed();
  }

  private trim(): void {
    const overflow = this.entries.length - this.maxEntries;
    if (overflow <= 0) return;
    const removed = this.entries.splice(0, overflow);
    for (const e of removed) this.count(e, -1);
    this.headDropped += overflow;
  }

  setMaxEntries(max: number): void {
    if (!Number.isFinite(max) || max <= 0) return;
    this.maxEntries = Math.floor(max);
    const before = this.entries.length;
    this.trim();
    if (this.entries.length !== before) this.changed();
  }

  /** Remove everything (e.g. resync after reconnect). */
  reset(): void {
    this.entries = [];
    this.headDropped = 0;
    this.lastId = 0;
    this.counts = emptyLogCounts();
    this.countsByDevice = new Map();
    this.countsByApp = new Map();
    this.generation++;
    this.changed();
  }

  /** Remove entries matching `predicate` (server `cleared` events). Returns the number removed. */
  removeWhere(predicate: (e: LogEntry) => boolean): number {
    const kept: LogEntry[] = [];
    let removed = 0;
    for (const e of this.entries) {
      if (predicate(e)) {
        this.count(e, -1);
        removed++;
      } else kept.push(e);
    }
    if (removed > 0) {
      this.entries = kept;
      this.generation++;
      this.changed();
    }
    return removed;
  }

  /** Index of the first entry with id >= `id` (binary search). */
  lowerBound(id: number): number {
    const arr = this.entries;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.id < id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the entry with this id, or -1. */
  indexOfId(id: number): number {
    const idx = this.lowerBound(id);
    return idx < this.entries.length && this.entries[idx]!.id === id ? idx : -1;
  }

  getById(id: number): LogEntry | undefined {
    const idx = this.indexOfId(id);
    return idx >= 0 ? this.entries[idx] : undefined;
  }

  get size(): number {
    return this.entries.length;
  }
}

export const logStore = new LogStore();
