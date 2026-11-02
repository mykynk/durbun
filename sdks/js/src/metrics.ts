/**
 * Periodic `metric` samples: JS heap (Hermes instrumented stats, Chrome `performance.memory`, Node
 * `process.memoryUsage`), Node CPU/RSS, and JS-thread FPS / janky frames via requestAnimationFrame
 * (React Native and browsers — the same signal as RN's "JS FPS" perf monitor).
 */
import type { SdkMetric } from './protocol.js';
import { clearRepeating, g, setRepeating, type AnyRecord, type TimerHandle } from './util.js';

const MB = 1024 * 1024;

function round(n: number, digits = 1): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/** Managed JS heap in use, in MB (undefined when the runtime does not expose it). */
export function readHeapMB(): number | undefined {
  try {
    const hermes = g.HermesInternal;
    if (hermes && typeof hermes.getInstrumentedStats === 'function') {
      const stats = hermes.getInstrumentedStats() as AnyRecord;
      const bytes = typeof stats.js_allocatedBytes === 'number' ? stats.js_allocatedBytes : stats.js_heapSize;
      if (typeof bytes === 'number' && isFinite(bytes)) return round(bytes / MB);
    }
  } catch {
    // ignore
  }
  try {
    const mem = g.performance && g.performance.memory;
    if (mem && typeof mem.usedJSHeapSize === 'number') return round(mem.usedJSHeapSize / MB);
  } catch {
    // ignore
  }
  try {
    const proc = g.process;
    if (proc && typeof proc.memoryUsage === 'function') return round(proc.memoryUsage().heapUsed / MB);
  } catch {
    // ignore
  }
  return undefined;
}

export function metricsSupported(): boolean {
  return readHeapMB() !== undefined || typeof g.requestAnimationFrame === 'function';
}

export class MetricsSampler {
  private timer: TimerHandle | undefined;
  private raf: unknown;
  private frames = 0;
  private janky = 0;
  private lastFrameTs = 0;
  private expectedFrameMs = 1000 / 60;
  private windowMinDelta = Infinity;
  private windowStart = 0;
  private lastCpu: { user: number; system: number } | undefined;
  private lastCpuAt = 0;
  private running = false;

  constructor(private readonly emit: (sample: SdkMetric) => void) {}

  start(intervalMs: number): void {
    this.stop();
    if (!metricsSupported()) return;
    this.running = true;
    this.windowStart = Date.now();
    this.primeCpu();
    this.startFrames();
    this.timer = setRepeating(() => {
      const sample = this.sample();
      if (sample) this.emit(sample);
    }, Math.max(250, intervalMs));
  }

  stop(): void {
    this.running = false;
    clearRepeating(this.timer);
    this.timer = undefined;
    if (this.raf !== undefined && typeof g.cancelAnimationFrame === 'function') {
      try {
        g.cancelAnimationFrame(this.raf);
      } catch {
        // ignore
      }
    }
    this.raf = undefined;
    this.frames = 0;
    this.janky = 0;
    this.lastFrameTs = 0;
  }

  /** Builds one sample from everything measured since the previous one. */
  sample(): SdkMetric | undefined {
    const now = Date.now();
    const sample: SdkMetric = { type: 'metric', ts: now };
    const heap = readHeapMB();
    if (heap !== undefined) sample.heapMB = heap;
    this.readNodeProcess(sample, now);
    const elapsed = now - this.windowStart;
    if (this.raf !== undefined && elapsed > 0 && this.frames > 0) {
      sample.fps = round(Math.min(240, (this.frames * 1000) / elapsed));
      sample.jankyFrames = this.janky;
      if (this.windowMinDelta !== Infinity) {
        // Refresh-rate estimate for the next window (60/90/120 Hz screens).
        this.expectedFrameMs = Math.min(34, Math.max(6, this.windowMinDelta));
      }
    }
    this.frames = 0;
    this.janky = 0;
    this.windowMinDelta = Infinity;
    this.windowStart = now;
    const keys = Object.keys(sample);
    return keys.length > 2 ? sample : undefined;
  }

  private startFrames(): void {
    const raf = g.requestAnimationFrame;
    if (typeof raf !== 'function') return;
    const onFrame = (ts: number) => {
      if (!this.running) return;
      const t = typeof ts === 'number' && ts > 0 ? ts : Date.now();
      if (this.lastFrameTs > 0) {
        const delta = t - this.lastFrameTs;
        // Gaps over 1 s (app in background, debugger pause) start a fresh measurement instead of counting as jank.
        if (delta > 0 && delta <= 1000) {
          this.frames++;
          if (delta < this.windowMinDelta) this.windowMinDelta = delta;
          if (delta > this.expectedFrameMs * 1.5 + 1) this.janky++;
        }
      }
      this.lastFrameTs = t;
      try {
        this.raf = raf(onFrame);
      } catch {
        this.raf = undefined;
      }
    };
    try {
      this.raf = raf(onFrame);
    } catch {
      this.raf = undefined;
    }
  }

  private primeCpu(): void {
    const proc = g.process;
    if (!proc || typeof proc.cpuUsage !== 'function') return;
    try {
      this.lastCpu = proc.cpuUsage();
      this.lastCpuAt = Date.now();
    } catch {
      this.lastCpu = undefined;
    }
  }

  private readNodeProcess(sample: SdkMetric, now: number): void {
    const proc = g.process;
    if (!proc) return;
    try {
      if (typeof proc.memoryUsage === 'function') sample.memoryMB = round(proc.memoryUsage().rss / MB);
    } catch {
      // ignore
    }
    try {
      if (typeof proc.cpuUsage === 'function') {
        const usage = proc.cpuUsage() as { user: number; system: number };
        if (this.lastCpu && now > this.lastCpuAt) {
          const usedMicros = usage.user - this.lastCpu.user + (usage.system - this.lastCpu.system);
          sample.cpu = round(Math.max(0, (usedMicros / 1000 / (now - this.lastCpuAt)) * 100));
        }
        this.lastCpu = usage;
        this.lastCpuAt = now;
      }
    } catch {
      // ignore
    }
  }
}
