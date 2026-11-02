/**
 * `Flutter.Frame` events → FPS / jank metrics.
 *
 * The framework posts one event per rendered frame (scheduler/binding.dart `_profileFramePostEvent`):
 * `{number, startTime, elapsed, build, raster, vsyncOverhead}`, all in microseconds; `startTime` is the
 * build start on the engine's monotonic clock and `elapsed` spans vsync start → raster finish. The engine
 * reports timings in batches (~every 100 ms in debug/profile), so FPS is computed on the frames' own
 * clock (frames that ended within the last window), never on arrival time — arrival-based counting would
 * jitter by a whole batch per window.
 */

export interface FlutterFrame {
  number?: number;
  /** Build start, engine clock, µs. */
  startTime: number;
  /** vsync start → raster finish, µs. */
  elapsed: number;
  /** UI thread (build) duration, µs. */
  build: number;
  /** Raster thread duration, µs. */
  raster: number;
  /** vsync start → build start, µs. */
  vsyncOverhead: number;
}

export interface FrameSample {
  fps?: number;
  jankyFrames?: number;
  frameBuildMs?: number;
  frameRasterMs?: number;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function parseFlutterFrame(data: unknown): FlutterFrame | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const startTime = num(d.startTime);
  const build = num(d.build);
  const raster = num(d.raster);
  if (startTime === undefined || build === undefined || raster === undefined) return undefined;
  return {
    number: num(d.number),
    startTime,
    elapsed: num(d.elapsed) ?? build + raster,
    build,
    raster,
    vsyncOverhead: num(d.vsyncOverhead) ?? 0,
  };
}

/** Raster finish of a frame on the engine clock (µs). */
export function frameEnd(frame: FlutterFrame): number {
  return frame.startTime - frame.vsyncOverhead + frame.elapsed;
}

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export class FrameStats {
  private budgetMs: number;
  /** Raster-finish times (engine µs) of recent frames. */
  private ends: number[] = [];
  /** Frames received since the previous sample. */
  private pending: FlutterFrame[] = [];
  private latestEnd = Number.NEGATIVE_INFINITY;
  private everSeen = false;

  constructor(refreshRateHz = 60) {
    this.budgetMs = 1000 / refreshRateHz;
  }

  /** Display refresh rate (e.g. from `_flutter.getDisplayRefreshRate`): sets the jank budget. */
  setRefreshRate(hz: number): void {
    if (Number.isFinite(hz) && hz >= 1 && hz <= 1000) this.budgetMs = 1000 / hz;
  }

  get frameBudgetMs(): number {
    return this.budgetMs;
  }

  /** Forget frame history (e.g. after a hot restart). */
  reset(): void {
    this.ends = [];
    this.pending = [];
    this.latestEnd = Number.NEGATIVE_INFINITY;
  }

  /** A frame is janky when its build (UI thread) or raster time exceeds the frame budget. */
  isJanky(frame: FlutterFrame): boolean {
    return frame.build / 1000 > this.budgetMs || frame.raster / 1000 > this.budgetMs;
  }

  add(frame: FlutterFrame): void {
    const end = frameEnd(frame);
    this.pending.push(frame);
    this.ends.push(end);
    if (end > this.latestEnd) this.latestEnd = end;
    this.everSeen = true;
    if (this.ends.length > 8192) this.ends = this.ends.slice(-4096);
    if (this.pending.length > 8192) this.pending = this.pending.slice(-4096);
  }

  /**
   * Metrics for the window that just ended. `undefined` until the first frame was ever seen (non-Flutter
   * VMs report no frame metrics at all); `{fps: 0, jankyFrames: 0}` while the app renders nothing (Flutter
   * only renders on change). jankyFrames/averages cover frames received since the previous sample.
   */
  sample(windowMs: number): FrameSample | undefined {
    if (!this.everSeen) return undefined;
    if (this.pending.length === 0) return { fps: 0, jankyFrames: 0 };
    const windowUs = Math.max(1, windowMs) * 1000;
    const from = this.latestEnd - windowUs;
    let count = 0;
    for (const e of this.ends) if (e > from && e <= this.latestEnd) count++;
    this.ends = this.ends.filter((e) => e > this.latestEnd - 2 * windowUs);
    const frames = this.pending;
    this.pending = [];
    let janky = 0;
    let build = 0;
    let raster = 0;
    for (const f of frames) {
      if (this.isJanky(f)) janky++;
      build += f.build;
      raster += f.raster;
    }
    return {
      fps: round(count / (windowUs / 1_000_000), 1),
      jankyFrames: janky,
      frameBuildMs: round(build / frames.length / 1000, 2),
      frameRasterMs: round(raster / frames.length / 1000, 2),
    };
  }
}
