/**
 * Bounded FIFO that keeps the most recent items: when full (by count or by total weight), the oldest
 * items are dropped. Used for outgoing messages while the desktop is not connected.
 */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private weights: number[];
  private head = 0;
  private count = 0;
  private weight = 0;
  private droppedCount = 0;

  constructor(
    readonly capacity: number,
    /** Upper bound for the sum of item weights (e.g. serialized length); Infinity = unbounded. */
    readonly maxWeight = Infinity,
  ) {
    const cap = Math.max(0, Math.floor(capacity));
    this.capacity = cap;
    this.items = new Array<T | undefined>(cap);
    this.weights = new Array<number>(cap).fill(0);
  }

  get size(): number {
    return this.count;
  }

  get totalWeight(): number {
    return this.weight;
  }

  /** Items evicted (or refused) since the last `takeDropped()`. */
  get dropped(): number {
    return this.droppedCount;
  }

  takeDropped(): number {
    const n = this.droppedCount;
    this.droppedCount = 0;
    return n;
  }

  /** Appends an item, evicting the oldest ones when needed. Returns the number of items dropped. */
  push(item: T, weight = 0): number {
    let dropped = 0;
    if (this.capacity === 0 || weight > this.maxWeight) {
      this.droppedCount++;
      return 1;
    }
    while (this.count > 0 && (this.count >= this.capacity || this.weight + weight > this.maxWeight)) {
      this.shift();
      dropped++;
    }
    const idx = (this.head + this.count) % this.capacity;
    this.items[idx] = item;
    this.weights[idx] = weight;
    this.count++;
    this.weight += weight;
    this.droppedCount += dropped;
    return dropped;
  }

  peek(): T | undefined {
    return this.count > 0 ? this.items[this.head] : undefined;
  }

  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.items[this.head];
    this.weight -= this.weights[this.head];
    this.items[this.head] = undefined;
    this.weights[this.head] = 0;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    if (this.count === 0) {
      this.head = 0;
      this.weight = 0;
    }
    return item;
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.capacity);
    this.weights = new Array<number>(this.capacity).fill(0);
    this.head = 0;
    this.count = 0;
    this.weight = 0;
    this.droppedCount = 0;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.head + i) % this.capacity] as T);
    return out;
  }
}
