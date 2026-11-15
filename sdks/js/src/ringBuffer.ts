/**
 * Bounded FIFO that keeps the most recent items: when full (by count or by total weight), the oldest
 * items are dropped. Used for outgoing messages while the desktop is not connected.
 *
 * With a `shrink` function, going over the weight limit first replaces the oldest items by their lighter
 * form (for messages: the same message without its body), and only then drops items.
 */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private weights: number[];
  private head = 0;
  private count = 0;
  private weight = 0;
  private droppedCount = 0;
  /** Items from the head (by position) already offered to `shrink`. */
  private shrunkUpTo = 0;

  constructor(
    readonly capacity: number,
    /** Upper bound for the sum of item weights (e.g. serialized length); Infinity = unbounded. */
    readonly maxWeight = Infinity,
    /** The lighter form of an item, or undefined when it has none. */
    private readonly shrink?: (item: T) => { item: T; weight: number } | undefined,
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
    if (weight > this.maxWeight && this.shrink) {
      const light = this.lighter(item);
      if (light && light.weight < weight) {
        item = light.item;
        weight = light.weight;
      }
    }
    if (this.capacity === 0 || weight > this.maxWeight) {
      this.droppedCount++;
      return 1;
    }
    while (this.count > 0 && this.count >= this.capacity) {
      this.shift();
      dropped++;
    }
    while (this.count > 0 && this.weight + weight > this.maxWeight && this.shrinkOldest()) {
      // lighter forms first
    }
    while (this.count > 0 && this.weight + weight > this.maxWeight) {
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

  private lighter(item: T): { item: T; weight: number } | undefined {
    try {
      return this.shrink ? this.shrink(item) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Replaces the oldest item that has a lighter form; false when none is left. */
  private shrinkOldest(): boolean {
    if (!this.shrink) return false;
    while (this.shrunkUpTo < this.count) {
      const idx = (this.head + this.shrunkUpTo) % this.capacity;
      this.shrunkUpTo++;
      const light = this.lighter(this.items[idx] as T);
      if (light && light.weight < this.weights[idx]) {
        this.weight += light.weight - this.weights[idx];
        this.items[idx] = light.item;
        this.weights[idx] = light.weight;
        return true;
      }
    }
    return false;
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
    if (this.shrunkUpTo > 0) this.shrunkUpTo--;
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
    this.shrunkUpTo = 0;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.head + i) % this.capacity] as T);
    return out;
  }
}
