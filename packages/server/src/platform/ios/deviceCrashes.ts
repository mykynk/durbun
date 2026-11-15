/**
 * Crash reports from a physical iOS device (SPEC §10.3), any build — no SDK needed:
 *   xcrun devicectl device info files --device <udid> --domain-type systemCrashLogs
 *   xcrun devicectl device copy from  --device <udid> --domain-type systemCrashLogs \
 *        --source <relativePath> --destination <tempDir>/crash/<udid>/<name>
 * On connect the last 7 days are read (CRASH_HISTORY_MS, at most `maxCopiesPerScan` reports a pass), then new
 * files every 60 s. Handled files are remembered per device
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
 *
 * Where devicectl cannot read the folder (no Xcode 15+, an iPhone before iOS 17, Developer Mode off), a
 * `CrashSource` built on libimobiledevice's idevicecrashreport serves the same listing from a local mirror
 * (ideviceFallback.ts); `fallbackCrashSource` switches between the two.
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
  isJetsamFileName,
  isThirdPartyBundle,
  JETSAM_BUG_TYPE,
  parseIps,
  parseJetsam,
  type IpsReport,
  type JetsamReport,
} from './crashReport';
import { CRASH_HISTORY_MS } from '../shared/readers';
import { parseDevicectlFiles, type DevicectlFile, type DevicectlRunner } from './devicectl';

/** How far back reports are read (shared with Android's dropbox reader). */
export const CRASH_LOOKBACK_MS = CRASH_HISTORY_MS;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/** Outcome of one listing; `via` names a fallback source (absent: devicectl). */
export type CrashScanStatus = { ok: true; via?: string } | { ok: false; error: string; via?: string };

/** Lists the device's crash folder and copies one file of the last listing to a local path. */
export interface CrashSource {
  /** Set for a fallback source ('idevicecrashreport'); devicectl leaves it out. */
  readonly via?: string;
  list(): Promise<{ ok: true; files: DevicectlFile[] } | { ok: false; error: string }>;
  copy(file: DevicectlFile, dest: string): Promise<{ ok: boolean; error?: string }>;
}

export function devicectlCrashSource(udid: string, devicectl: DevicectlRunner): CrashSource {
  return {
    async list() {
      const r = await devicectl(['device', 'info', 'files', '--device', udid, '--domain-type', 'systemCrashLogs'], 60_000);
      return r.ok ? { ok: true, files: parseDevicectlFiles(r.json) } : { ok: false, error: r.error ?? 'devicectl failed' };
    },
    async copy(file, dest) {
      const r = await devicectl(
        ['device', 'copy', 'from', '--device', udid, '--domain-type', 'systemCrashLogs', '--source', file.relativePath, '--destination', dest],
        60_000,
      );
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'devicectl failed' };
    },
  };
}

/** After this many listings on the fallback, the primary source is tried again (Developer Mode turned on…). */
export const RETRY_PRIMARY_EVERY = 10;

/**
 * devicectl first; when its listing fails and a fallback exists, the fallback's listing is used (and its copies,
 * until a later listing switches back). While on the fallback the primary is retried every RETRY_PRIMARY_EVERY
 * listings. Without a primary (devicectl missing) the fallback alone.
 */
export function fallbackCrashSource(primary: CrashSource | undefined, fallback: CrashSource | undefined): CrashSource | undefined {
  if (!primary || !fallback) return primary ?? fallback;
  let active: CrashSource = primary;
  let sinceSwitch = 0;
  const source: CrashSource = {
    get via() {
      return active.via;
    },
    async list() {
      if (active === fallback && ++sinceSwitch < RETRY_PRIMARY_EVERY) return fallback.list();
      const r = await primary.list();
      if (r.ok) {
        active = primary;
        return r;
      }
      const f = await fallback.list();
      if (!f.ok) {
        active = primary;
        return { ok: false, error: `${r.error} · ${fallback.via ?? 'fallback'}: ${f.error}` };
      }
      active = fallback;
      sinceSwitch = 0;
      return f;
    },
    copy: (file, dest) => active.copy(file, dest),
  };
  return source;
}

export interface DeviceCrashWatcherOptions {
  udid: string;
  /** The device's crash folder through devicectl (used when `source` is absent). */
  devicectl?: DevicectlRunner;
  /** Where listings and copies come from (default: devicectl). */
  source?: CrashSource;
  /** Where copies go: `<tempDir>/crash/<udid>`. */
  destDir: string;
  logger: Logger;
  /**
   * Is this process a third-party app or app extension? Without a bug_type in the listing only files named
   * after one are copied; with one, they are copied first.
   */
  isInteresting(processName: string | undefined): boolean;
  onReport(report: IpsReport, file: string): void;
  /**
   * A Jetsam report (iOS killed processes to free memory). Returns true when it concerned one of the
   * device's apps (the copy is kept for download), false to delete the copy. Absent: Jetsam reports are skipped.
   */
  onJetsam?(report: JetsamReport, file: string): boolean;
  /** Outcome of every listing (the device's crash-report reader state). */
  onStatus?(status: CrashScanStatus): void;
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
  private readonly source: CrashSource;

  constructor(private readonly opts: DeviceCrashWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.seen = opts.seen ?? new Set();
    const source = opts.source ?? (opts.devicectl ? devicectlCrashSource(opts.udid, opts.devicectl) : undefined);
    if (!source) throw new Error('DeviceCrashWatcher needs a crash source');
    this.source = source;
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

  private status(s: CrashScanStatus): void {
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
    const { udid, logger } = this.opts;
    const r = await this.source.list();
    if (this.stopped) return;
    const via = this.source.via;
    if (!r.ok) {
      logger.debug(`crash report listing for ${udid} failed: ${r.error}`);
      this.status({ ok: false, error: r.error, ...(via ? { via } : {}) });
      return;
    }
    this.status({ ok: true, ...(via ? { via } : {}) });
    const cutoff = this.now() - (this.opts.lookbackMs ?? CRASH_LOOKBACK_MS);
    const candidates: Array<{ file: DevicectlFile; when: number; named: boolean; jetsam: boolean }> = [];
    for (const file of r.files) {
      // iOS moves reports into Retired/ under the same name: one key per report, not per path.
      if (file.isDirectory || PROXIED_DEVICE.test(file.relativePath) || this.seen.has(reportKey(file))) continue;
      // Memory kills (Jetsam) name the killed processes inside: copied when the session reads them.
      const jetsam = !!this.opts.onJetsam && (file.bugType === JETSAM_BUG_TYPE || (file.bugType === undefined && isJetsamFileName(file.name)));
      // The listing says the report type (bug_type xattr): only crash reports are worth a copy.
      if (!jetsam && (!isCrashFileName(file.name) || (file.bugType !== undefined && !CRASH_BUG_TYPES.has(file.bugType)))) {
        this.seen.add(reportKey(file));
        continue;
      }
      const when = file.modified ?? crashFileDate(file.name);
      if (when === undefined || when < cutoff) {
        this.seen.add(reportKey(file));
        continue;
      }
      // Not marked seen: an app installed after the last listing makes it interesting later.
      const named = !jetsam && this.opts.isInteresting(crashFileProcess(file.name));
      if (!jetsam && file.bugType === undefined && !named) continue;
      candidates.push({ file, when, named, jetsam });
    }
    // Reports named after a third-party executable first: other crashes (system daemons, extensions not seen
    // running) must not delay them when a scan has more than it copies. Memory kills come last.
    candidates.sort((a, b) => Number(b.named) - Number(a.named) || Number(a.jetsam) - Number(b.jetsam) || a.when - b.when);
    const max = this.opts.maxCopiesPerScan ?? 20;
    for (const { file, jetsam } of candidates.slice(0, max)) {
      if (this.stopped) return;
      await this.fetch(file, jetsam);
    }
  }

  private async fetch(file: DevicectlFile, jetsam = false): Promise<void> {
    const { udid, logger, destDir } = this.opts;
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
    const r = await this.source.copy(file, dest);
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
    if (jetsam) {
      const kills = text !== undefined ? parseJetsam(text) : null;
      let kept = false;
      if (kills && !this.stopped) {
        try {
          kept = this.opts.onJetsam?.(kills, local) ?? false;
        } catch (e) {
          logger.debug(`jetsam report ${file.name}: ${(e as Error).message}`);
        }
      }
      if (!kept) await fs.promises.rm(local, { force: true }).catch(() => undefined);
      return;
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
