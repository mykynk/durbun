/** Small seeded PRNG (mulberry32) with helpers, so demo content is deterministic-ish run to run. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Independent stream derived from this one (stable for a given salt). */
  fork(salt: number): Rng {
    return new Rng(Math.imul(this.state ^ Math.imul(salt + 1, 0x85ebca6b), 0xc2b2ae35) >>> 0);
  }

  float(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Picks `n` distinct items (order randomized). */
  sample<T>(items: readonly T[], n: number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return items[items.length - 1]![0];
  }

  /** Normal distribution (Box–Muller). */
  gauss(mean = 0, sd = 1): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Exponential inter-arrival time with the given mean (Poisson process). */
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  hex(length: number): string {
    let out = '';
    while (out.length < length) out += Math.floor(this.next() * 0x100000000).toString(16).padStart(8, '0');
    return out.slice(0, length);
  }

  uuid(upper = false): string {
    const h = this.hex(32);
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[this.int(0, 3)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
    return upper ? id.toUpperCase() : id;
  }

  base64url(bytes: number): string {
    const buf = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) buf[i] = this.int(0, 255);
    return buf.toString('base64url');
  }
}

/** Mean-reverting random walk (for believable metric curves). */
export class Walk {
  constructor(
    public value: number,
    public mean: number,
    private readonly reversion: number,
    private readonly volatility: number,
    private readonly min: number,
    private readonly max: number,
  ) {}

  step(rng: Rng): number {
    this.value += this.reversion * (this.mean - this.value) + rng.gauss(0, this.volatility);
    this.value = Math.min(this.max, Math.max(this.min, this.value));
    return this.value;
  }

  bump(delta: number): void {
    this.value = Math.min(this.max, Math.max(this.min, this.value + delta));
  }
}

export const round = (n: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
