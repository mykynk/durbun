/**
 * Growable ring of (id, ts, flags) records for the entries the row model counted, in id order.
 * When the store trims its head, the model pops records from the front and subtracts exactly what each
 * entry contributed (source counters, noise counter, histogram bucket) — no rescans, no drift.
 * Typed arrays keep 200 000 records at ~3.4 MB.
 */

/* Flag bits */
export const F_SRC_MASK = 0b11; // 0 device · 1 app · 2 system
export const F_NOISY = 1 << 2;
export const F_VISIBLE = 1 << 3;
export const F_COUNT_SRC = 1 << 4;
export const F_COUNT_NOISE = 1 << 5;
export const F_NOHIST = 1 << 6;
export const F_MARKER = 1 << 7;
/** Severity tier (2 bits) lives in bits 8–9 (flags are stored in a Uint16Array). */
export const SEV_SHIFT = 8;

export class Ledger {
  private ids: Float64Array;
  private tss: Float64Array;
  private fl: Uint16Array;
  private head = 0;
  private mask: number;
  length = 0;

  constructor(initialCapacity = 1024) {
    let cap = 16;
    while (cap < initialCapacity) cap <<= 1;
    this.ids = new Float64Array(cap);
    this.tss = new Float64Array(cap);
    this.fl = new Uint16Array(cap);
    this.mask = cap - 1;
  }

  get capacity(): number {
    return this.mask + 1;
  }

  private grow(): void {
    const cap = this.capacity;
    const next = cap * 2;
    const ids = new Float64Array(next);
    const tss = new Float64Array(next);
    const fl = new Uint16Array(next);
    for (let i = 0; i < this.length; i++) {
      const p = (this.head + i) & this.mask;
      ids[i] = this.ids[p]!;
      tss[i] = this.tss[p]!;
      fl[i] = this.fl[p]!;
    }
    this.ids = ids;
    this.tss = tss;
    this.fl = fl;
    this.head = 0;
    this.mask = next - 1;
  }

  push(id: number, ts: number, flags: number): void {
    if (this.length === this.capacity) this.grow();
    const p = (this.head + this.length) & this.mask;
    this.ids[p] = id;
    this.tss[p] = ts;
    this.fl[p] = flags;
    this.length++;
  }

  /** Id of the oldest record (Infinity when empty). */
  frontId(): number {
    return this.length ? this.ids[this.head]! : Infinity;
  }
  frontTs(): number {
    return this.tss[this.head]!;
  }
  frontFlags(): number {
    return this.fl[this.head]!;
  }
  dropFront(): void {
    if (!this.length) return;
    this.head = (this.head + 1) & this.mask;
    this.length--;
  }

  idAt(i: number): number {
    return this.ids[(this.head + i) & this.mask]!;
  }
  tsAt(i: number): number {
    return this.tss[(this.head + i) & this.mask]!;
  }
  flagsAt(i: number): number {
    return this.fl[(this.head + i) & this.mask]!;
  }
  setFlagsAt(i: number, flags: number): void {
    this.fl[(this.head + i) & this.mask] = flags;
  }

  /** Logical index of the record with this id (binary search), or -1. */
  indexOf(id: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.idAt(mid) < id) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.length && this.idAt(lo) === id ? lo : -1;
  }

  clear(): void {
    this.head = 0;
    this.length = 0;
  }
}
