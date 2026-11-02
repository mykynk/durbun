import type { Logger } from '../../types';

/** Exponential backoff: initial, initial*factor, … capped at max. */
export class Backoff {
  private current = 0;

  constructor(
    private readonly initialMs: number,
    private readonly maxMs: number,
    private readonly factor = 2,
  ) {}

  next(): number {
    this.current = this.current === 0 ? this.initialMs : Math.min(this.maxMs, this.current * this.factor);
    return this.current;
  }

  reset(): void {
    this.current = 0;
  }
}

/** Promise that resolves after `ms` (unref'd timer). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Runs `fn` repeatedly, waiting `intervalMs` after each run completes (never overlapping).
 * Errors are logged and never stop the loop. Timers are unref'd.
 */
export class Poller {
  private running = false;
  private timer?: NodeJS.Timeout;
  private wake?: () => void;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly fn: () => Promise<void>,
    private intervalMs: number,
    private readonly logger: Logger,
    private readonly name: string,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
  }

  /** Run the next iteration now (if sleeping). */
  trigger(): void {
    if (this.wake) {
      clearTimeout(this.timer);
      const w = this.wake;
      this.wake = undefined;
      w();
    }
  }

  /** Stop; resolves when the current iteration (if any) finished. */
  async stop(): Promise<void> {
    this.running = false;
    this.trigger();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.fn();
      } catch (e) {
        this.logger.warn(`${this.name}: poll failed: ${(e as Error).message}`);
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(() => {
          this.wake = undefined;
          resolve();
        }, this.intervalMs);
        this.timer.unref?.();
      });
    }
  }
}

/** setInterval that never keeps the process alive and swallows handler errors. */
export function every(ms: number, fn: () => void | Promise<void>, logger?: Logger): () => void {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    Promise.resolve()
      .then(fn)
      .catch((e) => logger?.warn(`periodic task failed: ${(e as Error).message}`))
      .finally(() => {
        busy = false;
      });
  }, ms);
  t.unref?.();
  return () => clearInterval(t);
}
