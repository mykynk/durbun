import type { NetworkEntry } from '@durbun/protocol';

/** The parts of `networkStore` the index reads (kept minimal for tests). */
export interface NetSource {
  readonly generation: number;
  /** Entry ids in first-seen order: append-only, trimmed from the head, arbitrary removals bump `generation`. */
  readonly order: readonly string[];
  get(id: string): NetworkEntry | undefined;
}

/**
 * Incrementally maintained list of the entry ids that pass a predicate, in first-seen order.
 *
 * - entries appended to `source.order` are evaluated once;
 * - entries that changed (ids given to `markDirty`, e.g. from WS batches) are re-evaluated, so a request
 *   that completes with a 404 appears under "4xx" without rescanning the store;
 * - head trims (store at capacity) drop ids from the front in O(trimmed);
 * - anything else (reset, scoped clear, a new predicate) rebuilds the list once.
 */
export class NetRowIndex {
  private gen = -1;
  private filter: ((e: NetworkEntry) => boolean) | null = null;
  private lastId: string | null = null;
  /** id → first-seen sequence for every processed id still in the store (Map order = seq order). */
  private seq = new Map<string, number>();
  private nextSeq = 0;
  private list: string[] = [];
  private matched = new Set<string>();
  private dirty = new Set<string>();
  /** Matching entries appended at the end since creation (drives the "N new" pill). */
  appended = 0;
  /** Full rebuilds so far (tests, diagnostics). */
  rebuilds = 0;

  get ids(): readonly string[] {
    return this.list;
  }

  get size(): number {
    return this.list.length;
  }

  has(id: string): boolean {
    return this.matched.has(id);
  }

  markDirty(ids: Iterable<string>): void {
    for (const id of ids) this.dirty.add(id);
  }

  /** Force a full rebuild on the next sync (e.g. after a resync replaced every entry object). */
  invalidate(): void {
    this.filter = null;
  }

  /** Bring the list up to date. Returns true when the id list changed (new array identity). */
  sync(source: NetSource, filter: (e: NetworkEntry) => boolean): boolean {
    if (filter !== this.filter) {
      this.rebuild(source, filter);
      return true;
    }
    const order = source.order;
    let pos = -1;
    if (this.lastId !== null) {
      for (let i = order.length - 1; i >= 0; i--) {
        if (order[i] === this.lastId) {
          pos = i;
          break;
        }
      }
      if (pos < 0) {
        this.rebuild(source, filter);
        return true;
      }
    }
    let next: string[] | null = null;
    const mutable = () => (next ??= this.list.slice());

    if (source.generation !== this.gen) {
      this.gen = source.generation;
      // Head trim: everything older than the first stored entry is gone.
      const firstSeq = order.length > 0 ? this.seq.get(order[0]!) : undefined;
      if (order.length > 0 && firstSeq === undefined) {
        this.rebuild(source, filter);
        return true;
      }
      for (const [id, s] of this.seq) {
        if (firstSeq !== undefined && s >= firstSeq) break;
        this.seq.delete(id);
        this.matched.delete(id);
      }
      if (this.list.length > 0 && firstSeq !== undefined && (this.seq.get(this.list[0]!) ?? -1) < firstSeq) {
        const arr = mutable();
        let k = 0;
        while (k < arr.length && (this.seq.get(arr[k]!) === undefined || this.seq.get(arr[k]!)! < firstSeq)) k++;
        arr.splice(0, k);
      }
      // Removals in the middle (scoped clear): the processed prefix no longer lines up with `seq`.
      if (this.seq.size !== pos + 1) {
        for (const id of [...this.seq.keys()]) {
          if (!source.get(id)) {
            this.seq.delete(id);
            this.matched.delete(id);
          }
        }
        const arr = mutable();
        const kept = arr.filter((id) => this.matched.has(id));
        next = kept;
        if (this.seq.size !== pos + 1) {
          this.rebuild(source, filter);
          return true;
        }
      }
    }

    // New entries.
    for (let i = pos + 1; i < order.length; i++) {
      const id = order[i]!;
      this.seq.set(id, this.nextSeq++);
      const e = source.get(id);
      this.dirty.delete(id);
      if (e && filter(e)) {
        this.matched.add(id);
        mutable().push(id);
        this.appended++;
      }
    }
    if (order.length > 0) this.lastId = order[order.length - 1]!;

    // Updated entries.
    if (this.dirty.size > 0) {
      for (const id of this.dirty) {
        const s = this.seq.get(id);
        if (s === undefined) continue;
        const e = source.get(id);
        const want = !!e && filter(e);
        const has = this.matched.has(id);
        if (want === has) continue;
        const arr = mutable();
        const at = this.lowerBound(arr, s);
        if (want) {
          arr.splice(at, 0, id);
          this.matched.add(id);
        } else {
          if (arr[at] === id) arr.splice(at, 1);
          else {
            const i = arr.indexOf(id);
            if (i >= 0) arr.splice(i, 1);
          }
          this.matched.delete(id);
        }
      }
      this.dirty.clear();
    }

    if (next) {
      this.list = next;
      return true;
    }
    return false;
  }

  private lowerBound(arr: readonly string[], s: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.seq.get(arr[mid]!) ?? -1) < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private rebuild(source: NetSource, filter: (e: NetworkEntry) => boolean): void {
    this.rebuilds++;
    this.filter = filter;
    this.gen = source.generation;
    this.seq = new Map();
    this.matched = new Set();
    this.dirty.clear();
    const list: string[] = [];
    const order = source.order;
    for (let i = 0; i < order.length; i++) {
      const id = order[i]!;
      this.seq.set(id, this.nextSeq++);
      const e = source.get(id);
      if (e && filter(e)) {
        list.push(id);
        this.matched.add(id);
      }
    }
    this.lastId = order.length > 0 ? order[order.length - 1]! : null;
    this.list = list;
  }
}
