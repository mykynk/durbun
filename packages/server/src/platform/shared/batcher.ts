import type { DeviceLogInput, Logger } from '../../types';

/**
 * Collects parsed device log lines and hands them to the hub in batches (≈50 ms, or immediately
 * once `maxBatch` lines are queued) so 1000+ lines/s cost a handful of hub calls per second.
 */
export class LogBatcher {
  private buf: DeviceLogInput[] = [];
  private timer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly sink: (entries: DeviceLogInput[]) => void,
    private readonly logger: Logger,
    private readonly intervalMs = 50,
    private readonly maxBatch = 1000,
  ) {}

  get pending(): number {
    return this.buf.length;
  }

  push(entry: DeviceLogInput): void {
    if (this.disposed) return;
    this.buf.push(entry);
    if (this.buf.length >= this.maxBatch) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    try {
      this.sink(batch);
    } catch (e) {
      this.logger.warn(`dropping ${batch.length} log lines: hub rejected batch: ${(e as Error).message}`);
    }
  }

  /** Flush what is queued and ignore further pushes. */
  dispose(): void {
    this.flush();
    this.disposed = true;
  }
}
