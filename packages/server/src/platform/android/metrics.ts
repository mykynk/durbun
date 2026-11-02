/**
 * CPU / memory / frame polling for one Android process (every 2 s, source 'adb').
 *
 * Reads /proc/<pid>/stat (utime+stime ticks → CPU % of one core from deltas) and /proc/<pid>/status
 * (VmRSS, Threads) in ONE `adb shell` call. This is cheaper and more precise than `top -n 1` (whose
 * first-iteration %CPU is not a delta) and, unlike `dumpsys meminfo`, does not make the app walk its
 * own smaps every sample (which would cause jank in the very app being measured).
 *
 * Frame stats (fps / jankyFrames, SPEC §10.4) come from a second, parallel call (gfxinfo +
 * SurfaceFlinger latency, see frameStats.ts) so a hung app (slow `dumpsys gfxinfo`) never costs the
 * CPU/memory sample. Whether frames can be read at all goes to DeviceInfo.readers.frameStats: 'ok' with
 * every sample, 'unavailable' once a watch of a live process gave none for FRAME_TIMING.noDataReads reads.
 */
import type { MetricSample } from '@durbun/protocol';
import type { HubSink, Logger } from '../../types';
import { every } from '../shared/timing';
import type { Adb } from './adb';
import { FRAME_TIMING, FrameStatsReader, type FrameSample } from './frameStats';
import { cpuPercent, parsePidof, parseProcStat, parseVmRssMB } from './parsers';
import { READER_CODES, type ReaderReport } from './readers';

export interface MetricsTarget {
  pid?: number;
  processName?: string;
}

export interface AndroidMetricsDeps {
  adb: () => Adb | null;
  serial: string;
  deviceId: string;
  hub: HubSink;
  logger: Logger;
  /** Local pid→name knowledge (fallback for name → pid). */
  findPid?: (name: string) => number | undefined;
  /** Package of the watched process (pid → process name → package); enables frame stats. */
  packageOf?: (pid: number | undefined) => string | undefined;
  /** Frame stats readable or not (→ DeviceInfo.readers.frameStats); repeats are expected, the receiver dedupes. */
  onFrameReader?: (report: ReaderReport) => void;
}

export const ANDROID_METRICS_INTERVAL_MS = 2000;

export class AndroidMetricsWatcher {
  private cancel?: () => void;
  private pid?: number;
  private prev?: { ticks: number; at: number };
  private misses = 0;
  private readonly frames?: FrameStatsReader;
  private framesSeen = false;
  private frameMisses = 0;

  constructor(
    private readonly deps: AndroidMetricsDeps,
    readonly target: MetricsTarget,
  ) {
    this.pid = target.pid;
    const packageOf = deps.packageOf;
    if (packageOf) {
      this.frames = new FrameStatsReader({
        serial: deps.serial,
        logger: deps.logger,
        packageName: () => packageOf(this.pid),
      });
    }
  }

  start(): void {
    if (this.cancel) return;
    this.cancel = every(ANDROID_METRICS_INTERVAL_MS, () => this.tick(), this.deps.logger);
    void this.tick();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  private async resolvePid(adb: Adb): Promise<number | undefined> {
    const name = this.target.processName;
    if (!name || !/^[A-Za-z0-9_.:\-/]+$/.test(name)) return undefined;
    const r = await adb.shell(this.deps.serial, `pidof ${name}`, { timeoutMs: 5000 });
    return (r.ok ? parsePidof(r.stdout) : undefined) ?? this.deps.findPid?.(name);
  }

  private async tick(): Promise<void> {
    const adb = this.deps.adb();
    if (!adb || !this.cancel) return;
    if (!this.pid) {
      this.pid = await this.resolvePid(adb);
      this.prev = undefined;
      if (!this.pid) return;
    }
    const pid = this.pid;
    const framesP: Promise<FrameSample | undefined> = this.frames
      ? this.frames.read(adb).catch(() => undefined)
      : Promise.resolve(undefined);
    const [r, frames] = await Promise.all([
      adb.shell(this.deps.serial, `cat /proc/${pid}/stat && grep -E '^(VmRSS|Threads):' /proc/${pid}/status`, {
        timeoutMs: 5000,
      }),
      framesP,
    ]);
    if (!this.cancel) return;
    const stat = r.ok ? parseProcStat(r.stdout) : undefined;
    if (!stat) {
      // Process gone: re-resolve by name next time, or give up after a few misses.
      this.prev = undefined;
      this.misses += 1;
      if (this.target.processName) this.pid = undefined;
      else if (this.misses >= 5) this.stop();
      return;
    }
    this.misses = 0;
    this.noteFrames(frames);
    const now = Date.now();
    const cpu = this.prev ? cpuPercent(this.prev.ticks, stat.cpuTicks, now - this.prev.at) : undefined;
    this.prev = { ticks: stat.cpuTicks, at: now };
    const memoryMB = parseVmRssMB(r.stdout);
    if (cpu === undefined && memoryMB === undefined && !frames) return;
    const sample: MetricSample = { ts: now, deviceId: this.deps.deviceId, pid, source: 'adb' };
    if (cpu !== undefined) sample.cpu = cpu;
    if (memoryMB !== undefined) sample.memoryMB = memoryMB;
    if (stat.threads !== undefined) sample.threads = stat.threads;
    if (frames) {
      sample.fps = frames.fps;
      sample.jankyFrames = frames.jankyFrames;
    }
    this.deps.hub.pushMetrics([sample]);
  }

  /** Called only while the process lives (a dead app's missing frames say nothing about the device). */
  private noteFrames(frames: FrameSample | undefined): void {
    const reader = this.frames;
    if (!reader) return;
    if (frames) {
      this.framesSeen = true;
      this.deps.onFrameReader?.({ status: 'ok' });
      return;
    }
    // Once frames came, a quiet spell (app in the background, SurfaceView gone) is not "unreadable".
    if (this.framesSeen || reader.lastRead !== 'none') return;
    this.frameMisses += 1;
    if (this.frameMisses !== FRAME_TIMING.noDataReads) return;
    this.deps.onFrameReader?.({ status: 'unavailable', code: READER_CODES.frameStatsNoData, detail: reader.noDataDetail() });
  }
}
