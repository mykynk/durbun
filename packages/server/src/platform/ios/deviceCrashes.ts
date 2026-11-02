/**
 * Crash reports from a physical iOS device (SPEC §10.3), any build — no SDK needed:
 *   xcrun devicectl device info files --device <udid> --domain-type systemCrashLogs
 *   xcrun devicectl device copy from  --device <udid> --domain-type systemCrashLogs \
 *        --source <relativePath> --destination <tempDir>/crash/<udid>/<name>
 * On connect the last 24 h are read, then new files every 60 s. Handled files are remembered per device
 * by the driver (`seen`), so re-plugging a device does not report its crashes again; only .ips crash
 * reports of third-party apps become log entries. Files named after a process that is not an installed
 * app are re-checked on every scan (the app may be installed after the last app listing).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../types';
import { Poller } from '../shared/timing';
import { crashFileDate, crashFileProcess, isCrashFileName, isCrashReport, isThirdPartyBundle, parseIps, type IpsReport } from './crashReport';
import { parseDevicectlFiles, type DevicectlFile, type DevicectlRunner } from './devicectl';

export const CRASH_LOOKBACK_MS = 24 * 3600_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export interface DeviceCrashWatcherOptions {
  udid: string;
  devicectl: DevicectlRunner;
  /** Where copies go: `<tempDir>/crash/<udid>`. */
  destDir: string;
  logger: Logger;
  /** Is a crash file named after this process worth copying (installed third-party app)? */
  isInteresting(processName: string | undefined): boolean;
  onReport(report: IpsReport, file: string): void;
  intervalMs?: number;
  lookbackMs?: number;
  maxCopiesPerScan?: number;
  now?: () => number;
  /** Report names already handled for this device; pass the same set for every session of one device. */
  seen?: Set<string>;
}

/** Safe local file name for a device-side crash file name. */
export function localCrashName(name: string): string {
  const base = path.posix.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base && base !== '.' && base !== '..' ? base : 'crash.ips';
}

export class DeviceCrashWatcher {
  private readonly seen: Set<string>;
  private readonly attempts = new Map<string, number>();
  private poller?: Poller;
  private scanning?: Promise<void>;
  private rescan?: Promise<void>;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly opts: DeviceCrashWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.seen = opts.seen ?? new Set();
  }

  start(): void {
    if (this.poller || this.stopped) return;
    this.poller = new Poller(() => this.scan(), this.opts.intervalMs ?? 60_000, this.opts.logger, `crash reports ${this.opts.udid}`);
    this.poller.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.poller?.stop();
    this.poller = undefined;
  }

  /** One listing + copy round (public for tests). Never throws; a call during a round runs one more round after it. */
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
    if (this.stopped) return;
    const { udid, devicectl, logger } = this.opts;
    const r = await devicectl(['device', 'info', 'files', '--device', udid, '--domain-type', 'systemCrashLogs'], 60_000);
    if (!r.ok) {
      logger.debug(`crash report listing for ${udid} failed: ${r.error ?? 'unknown error'}`);
      return;
    }
    const cutoff = this.now() - (this.opts.lookbackMs ?? CRASH_LOOKBACK_MS);
    const candidates: Array<{ file: DevicectlFile; when: number }> = [];
    for (const file of parseDevicectlFiles(r.json)) {
      // iOS moves reports into Retired/ under the same name: one key per report, not per path.
      if (file.isDirectory || this.seen.has(reportKey(file))) continue;
      if (!isCrashFileName(file.name)) {
        this.seen.add(reportKey(file));
        continue;
      }
      const when = file.modified ?? crashFileDate(file.name);
      if (when === undefined || when < cutoff) {
        this.seen.add(reportKey(file));
        continue;
      }
      // Not marked seen: an app installed after the last listing makes it interesting later.
      if (!this.opts.isInteresting(crashFileProcess(file.name))) continue;
      candidates.push({ file, when });
    }
    candidates.sort((a, b) => a.when - b.when);
    const max = this.opts.maxCopiesPerScan ?? 20;
    for (const { file } of candidates.slice(0, max)) {
      if (this.stopped) return;
      await this.fetch(file);
    }
  }

  private async fetch(file: DevicectlFile): Promise<void> {
    const { udid, devicectl, logger, destDir } = this.opts;
    const key = reportKey(file);
    this.seen.add(key);
    const dest = path.join(destDir, localCrashName(file.name));
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
      // A stale copy (earlier session of this device) must not make the copy fail or be read instead.
      await fs.promises.rm(dest, { recursive: true, force: true });
    } catch (e) {
      logger.debug(`cannot create ${destDir}: ${(e as Error).message}`);
      return;
    }
    const r = await devicectl(
      ['device', 'copy', 'from', '--device', udid, '--domain-type', 'systemCrashLogs', '--source', file.relativePath, '--destination', dest],
      60_000,
    );
    if (this.stopped) {
      // The device session ended meanwhile: leave the file to the next session of this device.
      this.seen.delete(key);
      return;
    }
    const local = await resolveCopied(dest, file.name);
    if (!r.ok || !local) {
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      if (n < 3) this.seen.delete(key);
      logger.debug(`copying crash report ${file.name} from ${udid} failed: ${r.error ?? 'no file written'}`);
      return;
    }
    this.attempts.delete(key);
    let text: string;
    try {
      const st = await fs.promises.stat(local);
      if (st.size > MAX_REPORT_BYTES) return;
      text = await fs.promises.readFile(local, 'utf8');
    } catch (e) {
      logger.debug(`reading ${local}: ${(e as Error).message}`);
      return;
    }
    const report = parseIps(text);
    if (!report || report.incomplete || !isCrashReport(report) || !isThirdPartyBundle(report.bundleId)) return;
    if (this.stopped) {
      this.seen.delete(key);
      return;
    }
    try {
      this.opts.onReport(report, local);
    } catch (e) {
      logger.debug(`crash report ${file.name}: ${(e as Error).message}`);
    }
  }
}

const reportKey = (file: DevicectlFile): string => path.posix.basename(file.relativePath) || file.name;

/** devicectl may treat --destination as a file or as a folder; find the copied file either way. */
async function resolveCopied(dest: string, name: string): Promise<string | undefined> {
  const st = await fs.promises.stat(dest).catch(() => undefined);
  if (st?.isFile()) return dest;
  if (st?.isDirectory()) {
    const inner = path.join(dest, path.posix.basename(name));
    const s2 = await fs.promises.stat(inner).catch(() => undefined);
    if (s2?.isFile()) return inner;
  }
  return undefined;
}
