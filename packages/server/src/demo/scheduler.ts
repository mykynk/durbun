/**
 * Single-timer task scheduler for the demo: one interval drives a min-heap of due tasks, so stopping the
 * demo is one clearInterval and nothing else can keep firing.
 */
const MAX_LAG_MS = 1000;

interface Task {
  at: number;
  seq: number;
  fn: () => void;
}

export class Scheduler {
  private heap: Task[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Planned time of the task being executed (tasks run up to one tick late). */
  private current: number | undefined;

  constructor(
    private readonly tickMs: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  get pending(): number {
    return this.heap.length;
  }

  /**
   * Virtual "now": inside a task, the time the task was planned for; otherwise the wall clock. Using it
   * for timestamps keeps durations exact instead of quantized to the tick.
   */
  now(): number {
    return this.current ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDue(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.heap = [];
  }

  /** Runs `fn` after `delayMs` (ignored while stopped). */
  after(delayMs: number, fn: () => void): void {
    if (!this.timer) return;
    this.push({ at: this.now() + Math.max(0, delayMs), seq: this.seq++, fn });
  }

  /** Runs `fn` repeatedly; `nextDelay` is evaluated before every run. Returns a cancel function. */
  repeat(nextDelay: () => number, fn: () => void): () => void {
    let cancelled = false;
    const loop = () => {
      if (cancelled) return;
      fn();
      if (!cancelled) this.after(nextDelay(), loop);
    };
    this.after(nextDelay(), loop);
    return () => {
      cancelled = true;
    };
  }

  /** Executes every due task (exposed for tests). */
  runDue(now = Date.now()): void {
    let budget = 10_000;
    while (this.heap.length > 0 && this.heap[0]!.at <= now && budget-- > 0) {
      const task = this.pop();
      // Never lag more than MAX_LAG_MS behind the wall clock (after a sleep/stall there is no catch-up
      // flood: chained tasks continue from "almost now").
      this.current = Math.max(task.at, now - MAX_LAG_MS);
      try {
        task.fn();
      } catch (err) {
        this.onError(err);
      } finally {
        this.current = undefined;
      }
      if (!this.timer) return;
    }
  }

  private push(task: Task): void {
    const heap = this.heap;
    heap.push(task);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  }

  private pop(): Task {
    const heap = this.heap;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  }
}

function less(a: Task, b: Task): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}
