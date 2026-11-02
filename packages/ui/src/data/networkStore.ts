import { DEFAULT_SETTINGS, type NetworkEntry } from '@durbun/protocol';
import { VersionedStore } from './versioned';

export interface NetworkCounts {
  total: number;
  pending: number;
  /** state failed/cancelled (transport errors) */
  failed: number;
  /** HTTP 4xx */
  clientError: number;
  /** HTTP 5xx */
  serverError: number;
  mocked: number;
}

export const emptyNetworkCounts = (): NetworkCounts => ({ total: 0, pending: 0, failed: 0, clientError: 0, serverError: 0, mocked: 0 });

/** Failed transport or HTTP ≥ 400. */
export function isNetworkError(e: Pick<NetworkEntry, 'state' | 'status'>): boolean {
  return e.state === 'failed' || (typeof e.status === 'number' && e.status >= 400);
}

function applyCounts(c: NetworkCounts, e: NetworkEntry, sign: 1 | -1): void {
  c.total += sign;
  if (e.state === 'pending') c.pending += sign;
  if (e.state === 'failed' || e.state === 'cancelled') c.failed += sign;
  if (typeof e.status === 'number') {
    if (e.status >= 500) c.serverError += sign;
    else if (e.status >= 400) c.clientError += sign;
  }
  if (e.mocked) c.mocked += sign;
}

/**
 * Live network entries. `byId` holds the latest state of each request (updates replace the entry
 * object — compare by reference to detect changes); `order` is first-seen order. Trimmed at
 * `maxEntries` (oldest first), mirroring the server's `maxNetworkEntries`.
 */
export class NetworkStore extends VersionedStore {
  byId = new Map<string, NetworkEntry>();
  order: string[] = [];
  maxEntries: number = DEFAULT_SETTINGS.maxNetworkEntries;
  generation = 0;
  /** Distinct requests seen since page load (snapshot included). */
  totalReceived = 0;
  /** Distinct live requests seen since page load (snapshot excluded; used for rates). */
  liveReceived = 0;
  counts: NetworkCounts = emptyNetworkCounts();
  countsByDevice = new Map<string, NetworkCounts>();
  countsByApp = new Map<string, NetworkCounts>();
  private listCache: { version: number; generation: number; size: number; list: NetworkEntry[] } | null = null;
  private mutations = 0;

  private count(e: NetworkEntry, sign: 1 | -1): void {
    applyCounts(this.counts, e, sign);
    let d = this.countsByDevice.get(e.deviceId);
    if (!d) this.countsByDevice.set(e.deviceId, (d = emptyNetworkCounts()));
    applyCounts(d, e, sign);
    if (e.appId) {
      let a = this.countsByApp.get(e.appId);
      if (!a) this.countsByApp.set(e.appId, (a = emptyNetworkCounts()));
      applyCounts(a, e, sign);
    }
  }

  /** Insert new entries / replace updated ones (latest state wins). `history`: snapshot data (not live). */
  upsert(entries: readonly NetworkEntry[], opts: { history?: boolean } = {}): void {
    if (entries.length === 0) return;
    for (const e of entries) {
      const prev = this.byId.get(e.id);
      if (prev) this.count(prev, -1);
      else {
        this.order.push(e.id);
        this.totalReceived++;
        if (!opts.history) this.liveReceived++;
      }
      this.byId.set(e.id, e);
      this.count(e, 1);
    }
    this.trim();
    this.mutations++;
    this.changed();
  }

  private trim(): void {
    const overflow = this.order.length - this.maxEntries;
    if (overflow <= 0) return;
    const removed = this.order.splice(0, overflow);
    for (const id of removed) {
      const e = this.byId.get(id);
      if (e) {
        this.count(e, -1);
        this.byId.delete(id);
      }
    }
    this.generation++;
  }

  setMaxEntries(max: number): void {
    if (!Number.isFinite(max) || max <= 0) return;
    this.maxEntries = Math.floor(max);
    const before = this.order.length;
    this.trim();
    if (before !== this.order.length) {
      this.mutations++;
      this.changed();
    }
  }

  reset(): void {
    this.byId = new Map();
    this.order = [];
    this.counts = emptyNetworkCounts();
    this.countsByDevice = new Map();
    this.countsByApp = new Map();
    this.generation++;
    this.mutations++;
    this.changed();
  }

  removeWhere(predicate: (e: NetworkEntry) => boolean): number {
    let removed = 0;
    const kept: string[] = [];
    for (const id of this.order) {
      const e = this.byId.get(id);
      if (e && predicate(e)) {
        this.count(e, -1);
        this.byId.delete(id);
        removed++;
      } else kept.push(id);
    }
    if (removed > 0) {
      this.order = kept;
      this.generation++;
      this.mutations++;
      this.changed();
    }
    return removed;
  }

  get(id: string): NetworkEntry | undefined {
    return this.byId.get(id);
  }

  /** Entries in first-seen order (array cached until the next mutation). */
  list(): NetworkEntry[] {
    const c = this.listCache;
    if (c && c.version === this.mutations && c.generation === this.generation && c.size === this.order.length) return c.list;
    const list: NetworkEntry[] = [];
    for (const id of this.order) {
      const e = this.byId.get(id);
      if (e) list.push(e);
    }
    this.listCache = { version: this.mutations, generation: this.generation, size: this.order.length, list };
    return list;
  }

  get size(): number {
    return this.order.length;
  }
}

export const networkStore = new NetworkStore();
