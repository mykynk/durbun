/**
 * Crash reports from a physical iOS device (SPEC §10.3), any build — no SDK needed:
 *   xcrun devicectl device info files --device <udid> --domain-type systemCrashLogs
 *   xcrun devicectl device copy from  --device <udid> --domain-type systemCrashLogs \
 *        --source <relativePath> --destination <tempDir>/crash/<udid>/<name>
 * On connect the last 24 h are read, then new files every 60 s. Handled files are remembered per device
 * by the driver (`seen`), so re-plugging a device does not report its crashes again; only .ips crash
 * reports of third-party apps become log entries. A file the listing marks as a crash (bug_type 309/109)
 * is copied whatever its name: app extensions' reports are named after the extension's executable, and
 * the report's bundle id decides (system crashes are rare: 2 a day on a real phone, deleted after the
 * check). Without a bug_type only files named after a third-party executable are copied; the others are
 * re-checked on every scan (the app may be installed after the last app listing).
 * Real listing (devicectl 651.32, iOS 27.2): `name` and `relativePath` are both the path inside the domain
 * ("Retired/Runner-2026-11-02-095019.ips"); nearly every report sits in Retired/. `--destination` is the
 * file to write (an existing folder there makes the copy fail). ProxiedDevice-<id>/ holds a paired Apple
 * Watch's reports: not this device's crashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../types';
import { Poller } from '../shared/timing';
import {
  CRASH_BUG_TYPES,
  crashFileDate,
  crashFileProcess,
  isCrashFileName,
  isCrashReport,
  isThirdPartyBundle,
  parseIps,
  type IpsReport,
} from './crashReport';
import { parseDevicectlFiles, type DevicectlFile, type DevicectlRunner } from './devicectl';

export const CRASH_LOOKBACK_MS = 24 * 3600_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export interface DeviceCrashWatcherOptions {
  udid: string;
  devicectl: DevicectlRunner;
  /** Where copies go: `<tempDir>/crash/<udid>`. */
  destDir: string;
  logger: Logger;
  /**
   * Is this process a third-party app or app extension? Without a bug_type in the listing only files named
   * after one are copied; with one, they are copied first.
   */
  isInteresting(processName: string | undefined): boolean;
  onReport(report: IpsReport, file: string): void;
  /** Outcome of every listing (the device's crash-report reader state). */
  onStatus?(status: { ok: true } | { ok: false; error: string }): void;
  intervalMs?: number;
  lookbackMs?: number;
  maxCopiesPerScan?: number;
  now?: () => number;
  /** Report names already handled for this device; pass the same set for every session of one device. */
  seen?: Set<string>;
}

/**
 * Safe local file name for a crash file name, always /^[A-Za-z0-9][A-Za-z0-9._-]{0,155}\.ips$/ without "..":
 * the copy can be served by name and never points outside its folder.
 */
export function localCrashName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, '/'));
  const stem = (/\.ips$/i.test(base) ? base.slice(0, -4) : base)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .slice(0, 156)
    .replace(/\.+$/, '');
  return `${stem || 'crash'}.ips`;
}

/** URL path the UI downloads a copied report from (served from `<tempDir>/crash/<udid>/`). */
export function crashReportUrl(udid: string, fileName: string): string {
  return `/api/files/crash/${encodeURIComponent(udid)}/${encodeURIComponent(fileName)}`;
}

/** `<tempDir>/crash/<udid>` (the udid kept to letters, digits and dashes, like the download route). */
export function crashCopyDir(tempDir: string, udid: string): string {
  const safe = udid.replace(/[^A-Za-z0-9-]+/g, '').replace(/^-+/, '').slice(0, 100);
  return path.join(tempDir, 'crash', safe || 'device');
}

/** Reports of a paired Apple Watch (synced through the phone), not of this device. */
const PROXIED_DEVICE = /^ProxiedDevice-[^/]*\//;

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

  private status(s: { ok: true } | { ok: false; error: string }): void {
    try {
      this.opts.onStatus?.(s);
    } catch (e) {
      this.opts.logger.debug(`crash report status ${this.opts.udid}: ${(e as Error).message}`);
    }
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
    if (this.stopped) return;
    if (!r.ok) {
      logger.debug(`crash report listing for ${udid} failed: ${r.error ?? 'unknown error'}`);
      this.status({ ok: false, error: r.error ?? 'devicectl failed' });
      return;
    }
    this.status({ ok: true });
    const cutoff = this.now() - (this.opts.lookbackMs ?? CRASH_LOOKBACK_MS);
    const candidates: Array<{ file: DevicectlFile; when: number; named: boolean }> = [];
    for (const file of parseDevicectlFiles(r.json)) {
      // iOS moves reports into Retired/ under the same name: one key per report, not per path.
      if (file.isDirectory || PROXIED_DEVICE.test(file.relativePath) || this.seen.has(reportKey(file))) continue;
      // The listing says the report type (bug_type xattr): only crash reports are worth a copy.
      if (!isCrashFileName(file.name) || (file.bugType !== undefined && !CRASH_BUG_TYPES.has(file.bugType))) {
        this.seen.add(reportKey(file));
        continue;
      }
      const when = file.modified ?? crashFileDate(file.name);
      if (when === undefined || when < cutoff) {
        this.seen.add(reportKey(file));
        continue;
      }
      // Not marked seen: an app installed after the last listing makes it interesting later.
      const named = this.opts.isInteresting(crashFileProcess(file.name));
      if (file.bugType === undefined && !named) continue;
      candidates.push({ file, when, named });
    }
    // Reports named after a third-party executable first: other crashes (system daemons, extensions not seen
    // running) must not delay them when a scan has more than it copies.
    candidates.sort((a, b) => Number(b.named) - Number(a.named) || a.when - b.when);
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
    const local = await resolveCopied(dest);
    if (!r.ok || !local) {
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      if (n < 3) this.seen.delete(key);
      logger.debug(`copying crash report ${file.name} from ${udid} failed: ${r.error ?? 'no file written'}`);
      return;
    }
    this.attempts.delete(key);
    let text: string | undefined;
    try {
      const st = await fs.promises.stat(local);
      if (st.size <= MAX_REPORT_BYTES) text = await fs.promises.readFile(local, 'utf8');
    } catch (e) {
      logger.debug(`reading ${local}: ${(e as Error).message}`);
    }
    const report = text !== undefined ? parseIps(text) : null;
    if (!report || report.incomplete || !isCrashReport(report) || !isThirdPartyBundle(report.bundleId)) {
      // Not a third-party crash: nothing links to this copy.
      await fs.promises.rm(local, { force: true }).catch(() => undefined);
      return;
    }
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

/** The copy devicectl wrote at `--destination` (always a file path). */
async function resolveCopied(dest: string): Promise<string | undefined> {
  const st = await fs.promises.stat(dest).catch(() => undefined);
  return st?.isFile() ? dest : undefined;
}
