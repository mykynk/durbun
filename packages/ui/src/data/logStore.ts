import { DEFAULT_SETTINGS, type LogEntry, type LogLevel, type StoreEvictions } from '@durbun/protocol';
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

/**
 * Crash / ANR entries outlive the ring (the hub keeps them the same way, SPEC §10.3): a device that floods its log
 * (an iPhone streams ~1000 lines/s) must not push them out, or the crash panels and counts would lie. Kind crash |
 * anr, or a record the device kept itself (dropbox, .ips). Flutter error boxes are ordinary lines here.
 */
export function isProtectedEntry(e: Pick<LogEntry, 'kind' | 'origin' | 'data'>): boolean {
  if (e.kind === 'crash' || e.kind === 'anr') return true;
  if (e.origin === 'dropbox' || e.origin === 'crash-report') return true;
  const o = (e.data as { origin?: unknown } | null | undefined)?.origin;
  return o === 'dropbox' || o === 'crash-report';
}

/** At most this many protected entries are kept after the ring trimmed them (the newest). */
export const PROTECTED_MAX = 5_000;

function applyCounts(c: LogCounts, e: LogEntry, sign: 1 | -1): void {
  c.total += sign;
  if (e.level === 'warn') c.warn += sign;
  else if (e.level === 'error' || e.level === 'fatal') c.error += sign;
  if (isCrashEntry(e)) c.crash += sign;
}

/** Index of the first entry with id >= `id` (binary search). */
function lowerBoundIn(arr: readonly LogEntry[], id: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.id < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * All log entries received from the server, ordered by `id` (arrival order — SPEC §4).
 *
 * `entries` is an append-only ring trimmed at the head (oldest dropped first). It is mutated in
 * place: read it during render keyed on `useLogVersion()` and never mutate it yourself.
 * - `kept`: crash / ANR entries (`isProtectedEntry`) the ring trimmed, kept so a flooding device cannot push
 *   them out (SPEC §10.3, the hub keeps them the same way). Ordered by id and all older than `entries[0]`;
 *   the newest `keptCap` stay (≤ PROTECTED_MAX, ≤ half the ring), and `entries.length + kept.length ≤
 *   maxEntries`. Moving an entry there is still a plain head trim of `entries` (views built on `entries` drop
 *   ids < `entries[0].id`; `generation` does not change). The array is replaced, not mutated; `keptRevision`
 *   is bumped whenever it changes. `counts`, `size`, `getById` and `findLast` include it.
 * - `headDropped`: entries trimmed from the head of `entries` since the last reset (absolute index = headDropped + i).
 * - `dropped`: entries the memory limit deleted since the last reset (head trims minus the crash records moved to
 *   `kept`, plus kept records evicted). The views tell the user about it. With a server that reports its
 *   evictions (`followServer`) it is the server's count: the window drops what the server no longer holds, so
 *   both delete the same lines for the same reason (line limit or memory budget).
 * - `generation`: bumped on reset / removeWhere / out-of-order inserts (arbitrary changes) — drop derived
 *   caches when it changes.
 */
export class LogStore extends VersionedStore {
  entries: LogEntry[] = [];
  kept: readonly LogEntry[] = [];
  keptRevision = 0;
  maxEntries: number = DEFAULT_SETTINGS.maxLogEntries;
  /** Entries accepted since page load (monotonic, history included). */
  totalReceived = 0;
  /** Live entries accepted since page load (monotonic, history excluded; used for ingest rates). */
  liveReceived = 0;
  headDropped = 0;
  dropped = 0;
  /** The server's latest eviction counts (null when it does not report them). */
  evictions: StoreEvictions | null = null;
  generation = 0;
  /**
   * Bumped when an entry's level changed in place (a network row took its request's outcome level). Row
   * models re-run their filters on it; ids and order do not change, so it is not a `generation` change.
   */
  levelRevision = 0;
  /** Network log rows by request id (`netId` → entry id), for that level update. Pruned with the ring. */
  private netRows = new Map<string, number>();
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
        } else if (this.kept.length > 0 && e.id <= this.kept[this.kept.length - 1]!.id) {
          // Older than lines the ring already let go: only a crash record still has a place (in `kept`).
          if (!this.insertKept(e)) continue;
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
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i]!;
      if (e.kind === 'network' && e.netId) this.netRows.set(e.netId, e.id);
    }
    this.totalReceived += accepted;
    if (!opts.history) this.liveReceived += accepted;
    this.trim();
    this.changed();
  }

  /**
   * A request's outcome arrived: its log row takes [level] (the hub's `networkLogLevel`), as the server already did
   * for its own copy. A row that reached this client while the request was pending still says `info`; without this
   * "errors only" would miss a failed request until the next resync. Counts follow; returns true when it changed.
   */
  setNetworkLevel(netId: string, level: LogLevel): boolean {
    const id = this.netRows.get(netId);
    if (id === undefined) return false;
    const idx = this.indexOfId(id);
    if (idx < 0) {
      this.netRows.delete(netId);
      return false;
    }
    const e = this.entries[idx]!;
    if (e.level === level) return false;
    // A new object: rows and views compare entries by reference.
    const next: LogEntry = { ...e, level };
    this.count(e, -1);
    this.entries[idx] = next;
    this.count(next, 1);
    this.levelRevision++;
    this.changed();
    return true;
  }

  /** Out-of-order entry at or before the newest kept one. Returns true when it was added (not a duplicate). */
  private insertKept(e: LogEntry): boolean {
    const kept = this.kept.slice();
    const idx = lowerBoundIn(kept, e.id);
    if (idx < kept.length && kept[idx]!.id === e.id) {
      this.count(kept[idx]!, -1);
      kept[idx] = e;
      this.count(e, 1);
      this.kept = kept;
      this.keptRevision++;
      return false;
    }
    if (!isProtectedEntry(e)) return false;
    kept.splice(idx, 0, e);
    this.kept = kept;
    this.keptRevision++;
    this.generation++;
    return true;
  }

  /** Crash / ANR entries kept after the ring trimmed them: at most PROTECTED_MAX, at most half the ring. */
  get keptCap(): number {
    return Math.max(0, Math.min(PROTECTED_MAX, Math.floor(this.maxEntries / 2)));
  }

  /**
   * Head trim of `entries` down to `maxEntries` (minus what `kept` holds) and below `floorId` (the oldest line the
   * server still holds). Protected entries on the way move to `kept` (oldest kept ones go when it is over
   * `keptCap`); everything else is dropped.
   */
  private trim(floorId = 0): void {
    const arr = this.entries;
    const kept = this.kept;
    const cap = this.keptCap;
    let evict = Math.max(0, kept.length - cap);
    let total = arr.length + kept.length - evict;
    let n = 0;
    let moved: LogEntry[] | null = null;
    while (n < arr.length && (total > this.maxEntries || arr[n]!.id < floorId)) {
      const e = arr[n++]!;
      if (cap > 0 && isProtectedEntry(e)) {
        (moved ??= []).push(e);
        if (kept.length + moved.length - evict > cap) {
          evict++;
          total--;
        }
      } else {
        this.count(e, -1);
        this.dropped++;
        total--;
      }
    }
    if (n > 0) {
      arr.splice(0, n);
      this.headDropped += n;
      if (this.netRows.size > this.maxEntries) {
        const first = arr.length > 0 ? arr[0]!.id : Infinity;
        for (const [netId, id] of this.netRows) if (id < first) this.netRows.delete(netId);
      }
    }
    if (moved || evict > 0) {
      // Moved entries come from the head of `entries`, so they are newer than every kept one.
      const next = moved ? kept.concat(moved) : kept.slice();
      for (const e of next.splice(0, evict)) {
        this.count(e, -1);
        this.dropped++;
      }
      this.kept = next;
      this.keptRevision++;
    }
  }

  /**
   * The server's eviction counts arrived (snapshot, batch, cleared): drop the lines it no longer holds (ids below
   * `oldestLogId`; crash records move to `kept` as with a local trim) and take its count as `dropped`.
   */
  followServer(evictions: StoreEvictions): void {
    this.evictions = evictions;
    const before = this.size;
    const keptBefore = this.kept;
    if (evictions.oldestLogId > 0 && this.entries.length > 0 && this.entries[0]!.id < evictions.oldestLogId) this.trim(evictions.oldestLogId);
    const changed = this.dropped !== evictions.logs || this.size !== before || this.kept !== keptBefore;
    this.dropped = evictions.logs;
    if (changed) this.changed();
  }

  setMaxEntries(max: number): void {
    if (!Number.isFinite(max) || max <= 0) return;
    this.maxEntries = Math.floor(max);
    const before = this.size;
    this.trim();
    if (this.size !== before) this.changed();
  }

  /** Remove everything (e.g. resync after reconnect). */
  reset(): void {
    this.entries = [];
    this.kept = [];
    this.keptRevision++;
    this.headDropped = 0;
    this.dropped = 0;
    this.evictions = null;
    this.netRows = new Map();
    this.lastId = 0;
    this.counts = emptyLogCounts();
    this.countsByDevice = new Map();
    this.countsByApp = new Map();
    this.generation++;
    this.changed();
  }

  /** Remove entries matching `predicate` (server `cleared` events). Returns the number removed. */
  removeWhere(predicate: (e: LogEntry) => boolean): number {
    let removed = 0;
    const filter = (list: readonly LogEntry[]): LogEntry[] => {
      const out: LogEntry[] = [];
      for (const e of list) {
        if (predicate(e)) {
          this.count(e, -1);
          removed++;
        } else out.push(e);
      }
      return out;
    };
    const kept = filter(this.kept);
    const keptRemoved = removed;
    const entries = filter(this.entries);
    if (keptRemoved > 0) {
      this.kept = kept;
      this.keptRevision++;
    }
    if (removed > 0) {
      this.entries = entries;
      this.generation++;
      this.changed();
    }
    return removed;
  }

  /** Index in `entries` of the first entry with id >= `id` (binary search). */
  lowerBound(id: number): number {
    return lowerBoundIn(this.entries, id);
  }

  /** Index in `entries` of the entry with this id, or -1 (kept crash records are not in `entries`). */
  indexOfId(id: number): number {
    const idx = this.lowerBound(id);
    return idx < this.entries.length && this.entries[idx]!.id === id ? idx : -1;
  }

  /** The entry with this id, from `entries` or `kept`. */
  getById(id: number): LogEntry | undefined {
    const idx = this.indexOfId(id);
    if (idx >= 0) return this.entries[idx];
    const k = this.kept;
    const ki = k.length > 0 && id <= k[k.length - 1]!.id ? lowerBoundIn(k, id) : -1;
    return ki >= 0 && ki < k.length && k[ki]!.id === id ? k[ki] : undefined;
  }

  /** Newest entry matching `predicate`, searching `entries` and then `kept` (e.g. "latest crash"). */
  findLast(predicate: (e: LogEntry) => boolean): LogEntry | undefined {
    for (const list of [this.entries, this.kept]) {
      for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i]!)) return list[i];
    }
    return undefined;
  }

  /** Entries held: the ring plus the kept crash records. */
  get size(): number {
    return this.entries.length + this.kept.length;
  }
}

export const logStore = new LogStore();

/**
 * Protected rows newer than `afterId`, oldest first. A burst can push a crash out of the ring before a
 * scan reaches it, and a resync rebuilds the ring without the rows it trimmed: both only exist in `kept`.
 */
export function keptAfter(kept: readonly LogEntry[] | undefined, afterId: number): readonly LogEntry[] {
  if (!kept || kept.length === 0 || kept[kept.length - 1]!.id <= afterId) return [];
  let i = kept.length;
  while (i > 0 && kept[i - 1]!.id > afterId) i--;
  return kept.slice(i);
}
