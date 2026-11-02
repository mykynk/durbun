/**
 * Bounded FIFO ring with O(1) append. The backing array grows lazily (doubling) up to `capacity`, so a
 * hub configured for 200 000 entries does not allocate them all up front. Once full, every append
 * overwrites (evicts) the oldest item.
 */
const INITIAL_SLOTS = 1024;

export function normalizeCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) return 1;
  return Math.max(1, Math.floor(capacity));
}

export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private len = 0;
  private cap: number;

  constructor(capacity: number) {
    this.cap = normalizeCapacity(capacity);
    this.buf = new Array(Math.min(this.cap, INITIAL_SLOTS));
  }

  get size(): number {
    return this.len;
  }

  get capacity(): number {
    return this.cap;
  }

  /** Appends an item; returns the evicted (oldest) item when the ring was full. */
  push(item: T): T | undefined {
    if (this.len < this.cap) {
      if (this.len === this.buf.length) this.grow();
      this.buf[(this.head + this.len) % this.buf.length] = item;
      this.len++;
      return undefined;
    }
    const evicted = this.buf[this.head];
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.buf.length;
    return evicted;
  }

  /** Item at logical index (0 = oldest). */
  at(index: number): T | undefined {
    if (index < 0 || index >= this.len) return undefined;
    return this.buf[(this.head + index) % this.buf.length];
  }

  first(): T | undefined {
    return this.at(0);
  }

  last(): T | undefined {
    return this.at(this.len - 1);
  }

  /** Copy of the logical range [start, end). */
  slice(start = 0, end = this.len): T[] {
    const s = Math.max(0, Math.min(this.len, start));
    const e = Math.max(s, Math.min(this.len, end));
    const out: T[] = new Array(e - s);
    const n = this.buf.length;
    for (let i = s; i < e; i++) out[i - s] = this.buf[(this.head + i) % n] as T;
    return out;
  }

  toArray(): T[] {
    return this.slice(0, this.len);
  }

  forEach(fn: (item: T, index: number) => void): void {
    const n = this.buf.length;
    for (let i = 0; i < this.len; i++) fn(this.buf[(this.head + i) % n] as T, i);
  }

  /** Keeps only the items for which `keep` returns true (order preserved); returns the removed items. */
  retain(keep: (item: T) => boolean): T[] {
    const kept: T[] = [];
    const removed: T[] = [];
    this.forEach((item) => (keep(item) ? kept : removed).push(item));
    if (removed.length > 0) this.reset(kept);
    return removed;
  }

  /** Changes the capacity; when shrinking, the oldest items are evicted and returned. */
  setCapacity(capacity: number): T[] {
    const cap = normalizeCapacity(capacity);
    if (cap === this.cap) return [];
    const items = this.toArray();
    const drop = Math.max(0, items.length - cap);
    const evicted = items.slice(0, drop);
    this.cap = cap;
    this.reset(drop > 0 ? items.slice(drop) : items);
    return evicted;
  }

  clear(): void {
    this.buf = new Array(Math.min(this.cap, INITIAL_SLOTS));
    this.head = 0;
    this.len = 0;
  }

  /**
   * Binary search over items sorted ascending by `key`: index of the first item whose key is strictly
   * greater than `value` (== size when none).
   */
  upperBound(value: number, key: (item: T) => number): number {
    let lo = 0;
    let hi = this.len;
    const n = this.buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (key(this.buf[(this.head + mid) % n] as T) <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private grow(): void {
    const next = Math.min(this.cap, Math.max(INITIAL_SLOTS, this.buf.length * 2));
    const items = this.toArray();
    this.buf = items;
    this.buf.length = next;
    this.head = 0;
  }

  private reset(items: T[]): void {
    this.head = 0;
    this.len = items.length;
    const slots = Math.min(this.cap, Math.max(INITIAL_SLOTS, items.length));
    this.buf = items;
    if (this.buf.length < slots) this.buf.length = slots;
  }
}
