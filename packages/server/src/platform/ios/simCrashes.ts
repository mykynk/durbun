/**
 * Crash reports of simulator apps (SPEC §10.3). Simulator processes are macOS processes, so macOS'
 * ReportCrash writes their .ips files to ~/Library/Logs/DiagnosticReports (later moved to Retired/).
 * A report belongs to simulator <udid> when its coalition is "com.apple.CoreSimulator.SimDevice.<udid>"
 * (macOS 26+ anonymizes paths to "/Volumes/VOLUME/*") or a path contains CoreSimulator/Devices/<udid>/.
 * One watcher per driver serves every booted simulator; matched reports are cached so a simulator that
 * boots later still gets the last 24 h. Each report reaches a simulator once: rebooting it does not
 * report the same crashes again (its earlier log entries are still in the hub).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../../types';
import { Poller } from '../shared/timing';
import {
  CRASH_BUG_TYPES,
  isCrashFileName,
  isCrashReport,
  isThirdPartyBundle,
  parseIps,
  parseIpsHeader,
  simulatorUdidOf,
  type IpsReport,
} from './crashReport';
import { CRASH_LOOKBACK_MS } from './deviceCrashes';

/** Mach-O platforms of simulators (iOS, tvOS, watchOS, visionOS). */
const SIM_PLATFORMS = new Set([7, 8, 9, 12]);
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_CACHE = 300;

export function defaultDiagnosticReportDirs(): string[] {
  const root = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
  return [root, path.join(root, 'Retired')];
}

export type SimCrashListener = (report: IpsReport, file: string) => void;

interface Cached {
  udid: string;
  report: IpsReport;
  file: string;
  ts: number;
  /** Handed to a listener of this simulator already. */
  delivered: boolean;
}

export interface SimCrashWatcherOptions {
  dirs?: string[];
  logger: Logger;
  intervalMs?: number;
  lookbackMs?: number;
  now?: () => number;
}

export class SimCrashWatcher {
  private readonly dirs: string[];
  private readonly listeners = new Map<string, Set<SimCrashListener>>();
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly cache: Cached[] = [];
  private poller?: Poller;
  private scanning?: Promise<void>;
  private rescan?: Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: SimCrashWatcherOptions) {
    this.dirs = opts.dirs ?? defaultDiagnosticReportDirs();
    this.now = opts.now ?? Date.now;
  }

  /** Deliver crash reports of simulator `udid` (the last 24 h first, then new ones). */
  register(udid: string, listener: SimCrashListener): () => void {
    const key = udid.toUpperCase();
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    const cutoff = this.now() - (this.opts.lookbackMs ?? CRASH_LOOKBACK_MS);
    for (const c of this.cache) if (c.udid === key && !c.delivered && c.ts >= cutoff) this.safeCall(listener, c);
    if (!this.poller) {
      this.poller = new Poller(() => this.scan(), this.opts.intervalMs ?? 5000, this.opts.logger, 'simulator crash reports');
      this.poller.start();
    } else {
      this.poller.trigger();
    }
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(key);
      if (this.listeners.size === 0) void this.stop();
    };
  }

  async stop(): Promise<void> {
    const p = this.poller;
    this.poller = undefined;
    await p?.stop();
  }

  /** One pass over the report folders (public for tests). Never throws; a call during a pass runs one more pass after it. */
  scan(): Promise<void> {
    if (this.scanning) {
      // A pass is running: run one more right after it (it may have listed the folder already).
      this.rescan ??= this.scanning.then(() => {
        this.rescan = undefined;
        return this.scan();
      });
      return this.rescan;
    }
    this.scanning = this.scanOnce().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const cutoff = this.now() - (this.opts.lookbackMs ?? CRASH_LOOKBACK_MS);
    for (const dir of this.dirs) {
      const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        // Reports move from the folder to Retired/ with the same name: one key per report.
        if (this.seen.has(name)) continue;
        if (!isCrashFileName(name)) {
          this.seen.add(name);
          continue;
        }
        await this.inspect(path.join(dir, name), name, cutoff);
      }
    }
  }

  private async inspect(file: string, name: string, cutoff: number): Promise<void> {
    const st = await fs.promises.stat(file).catch(() => undefined);
    if (!st?.isFile()) return;
    if (st.mtimeMs < cutoff || st.size > MAX_REPORT_BYTES) {
      this.seen.add(name);
      return;
    }
    const head = await readHead(file, 8192);
    const firstLine = head.split('\n', 1)[0] ?? '';
    const header = parseIpsHeader(firstLine);
    if (!header) {
      this.retryLater(name);
      return;
    }
    const platform = typeof header.platform === 'number' ? header.platform : undefined;
    const bundleId = typeof header.bundleID === 'string' ? header.bundleID : undefined;
    if (
      !CRASH_BUG_TYPES.has(String(header.bug_type ?? '')) ||
      header.is_simulated === 1 ||
      (platform !== undefined && !SIM_PLATFORMS.has(platform)) ||
      (bundleId !== undefined && !isThirdPartyBundle(bundleId))
    ) {
      this.seen.add(name);
      return;
    }
    const text = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
    const report = text ? parseIps(text) : null;
    if (!report || report.incomplete) {
      // Possibly still being written.
      this.retryLater(name);
      return;
    }
    this.seen.add(name);
    const udid = simulatorUdidOf(report);
    if (!udid || !isCrashReport(report) || !isThirdPartyBundle(report.bundleId)) return;
    const cached: Cached = { udid, report, file, ts: report.ts ?? st.mtimeMs, delivered: false };
    this.cache.push(cached);
    if (this.cache.length > MAX_CACHE) this.cache.splice(0, this.cache.length - MAX_CACHE);
    for (const l of this.listeners.get(udid) ?? []) this.safeCall(l, cached);
  }

  private retryLater(name: string): void {
    const n = (this.attempts.get(name) ?? 0) + 1;
    this.attempts.set(name, n);
    if (n >= 3) this.seen.add(name);
  }

  private safeCall(l: SimCrashListener, c: Cached): void {
    c.delivered = true;
    try {
      l(c.report, c.file);
    } catch (e) {
      this.opts.logger.debug(`simulator crash listener failed: ${(e as Error).message}`);
    }
  }
}

async function readHead(file: string, bytes: number): Promise<string> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
