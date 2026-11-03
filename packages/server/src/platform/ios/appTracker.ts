/**
 * DeviceApps for iOS devices and simulators (SPEC §10.2): which third-party apps are installed (with
 * version / build / build type / install source), which of them run (pids), and which were active in the
 * device log or crashed. Only apps that are running, recently active (≤ 15 min) or have crash reports are
 * reported to the hub; the hub owns storage and `lastActivity` bumps from log lines (pid ∈ pids).
 *
 * The platform specifics live behind `AppSource` (devicectl for physical devices, simctl + ps for
 * simulators). Every failure is data: a failed listing keeps the last known state and retries later.
 * Processes of an app installed after the last listing (`AppSource.unlistedApps`) count as third-party for
 * the device log scope right away, and the tracker relists installed apps early to learn what they are.
 * A log line of a process no listing has explained yet whose name looks like a third-party app's (not a
 * daemon's) is kept, and a process listing is asked for at once (`keepsUnknownProcess`): a freshly installed
 * app or an app extension that just started is not hidden until the next periodic listing.
 */
import type { AppBuildType, AppInstallSource, DeviceApp } from '@durbun/protocol';
import type { DeviceLogInput, HubSink, Logger } from '../../types';
import { Poller } from '../shared/timing';
import { isThirdPartyBundle, type IpsReport } from './crashReport';
import type { ThirdPartyApps } from './deviceLogScope';

export const RECENT_ACTIVITY_MS = 15 * 60_000;

export interface InstalledIosApp {
  id: string;
  name?: string;
  version?: string;
  build?: string;
  buildType: AppBuildType;
  source: AppInstallSource;
  /** CFBundleExecutable (process name in logs and crash reports, e.g. "Runner"). */
  executable?: string;
  /** Bundle location: file URL (device) or absolute path (simulator). */
  bundle?: string;
}

/** A running process inside an app bundle the last installed-app listing did not have. */
export interface UnlistedAppProcess {
  /** The app bundle ("/var/containers/Bundle/Application/<UUID>/X.app"). */
  bundle: string;
  /** Executable name (the process name in logs). */
  name?: string;
}

export interface AppSource {
  /** Installed third-party apps; null when the listing failed (tool missing, device refused…). */
  listInstalled(): Promise<InstalledIosApp[] | null>;
  /** bundle id → live pids; null when it could not be determined. */
  listRunning(apps: InstalledIosApp[]): Promise<Map<string, number[]> | null>;
  /**
   * Optional: pid → executable name of the processes the last successful `listRunning` matched, app
   * extensions included ("…/Runner.app/PlugIns/NotificationService.appex/NotificationService").
   */
  runningNames?(): ReadonlyMap<number, string>;
  /**
   * Optional: pid → processes the last successful `listRunning` saw inside app bundles that the last
   * installed-app listing did not contain (installed since). A source that can tell is asked for running
   * processes even while no third-party app is installed.
   */
  unlistedApps?(): ReadonlyMap<number, UnlistedAppProcess>;
  /**
   * Optional: executable names of the last successful `listRunning`'s processes that are not third-party
   * (daemons, Apple's apps and their extensions). A source that can tell lets the tracker keep the lines of
   * processes it has not seen yet (`keepsUnknownProcess`).
   */
  systemNames?(): ReadonlySet<string>;
}

export interface AppTrackerOptions {
  deviceId: string;
  hub: HubSink;
  getDeviceApps(): DeviceApp[];
  source: AppSource;
  logger: Logger;
  /** Re-list installed apps this often (device: minutes). */
  installedEveryMs: number;
  /** Re-check running processes this often. */
  runningEveryMs: number;
  /** Retry delay after a failed listing. */
  retryMs?: number;
  /** Minimum gap between log-triggered process checks. */
  triggerGapMs?: number;
  /**
   * Re-list installed apps when logs show a process name no installed app uses (simulators whose log
   * stream is limited to user apps). A function is read on every log line, so it follows setting changes.
   */
  relistOnUnknownProcess?: boolean | (() => boolean);
  /** After every installed-app listing, successful (`ok`) or not. */
  onListed?: (ok: boolean) => void;
  now?: () => number;
}

/** A name kept by `keepsUnknownProcess` that no listing found is not kept again for this long. */
const SETTLED_MS = 10 * 60_000;
/** At most this many names wait for a listing at once (a flood of new names is not kept). */
const MAX_PENDING_NAMES = 500;

/**
 * Daemon-like process names: Apple's daemons, tools and XPC services start with a lowercase letter
 * ("locationd", "kernel", "spotlightknowledged.updater", "com.apple.WebKit.WebContent"); third-party
 * executables almost never do ("Runner", "Mahalle", "Microsoft Authenticator", "NotificationService").
 */
function daemonLikeName(name: string): boolean {
  const c = name.charCodeAt(0);
  return c >= 97 && c <= 122;
}

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export class IosAppTracker implements ThirdPartyApps {
  private installed = new Map<string, InstalledIosApp>();
  private byExecutable = new Map<string, string[]>();
  /** Executable names seen inside third-party app bundles (main apps and their extensions). */
  private readonly helperNames = new Set<string>();
  private installedOk = false;
  private readonly pids = new Map<string, number[]>();
  private readonly pidOwner = new Map<number, string>();
  /** Ids reported to the hub (and the info signature last sent). */
  private readonly listed = new Map<string, string>();
  private readonly unknownNames = new Set<string>();
  /** Running processes of app bundles installed after the last listing (until a relist says what they are). */
  private readonly provisionalPids = new Map<number, string>();
  private readonly provisionalNames = new Set<string>();
  /** Bundles that already triggered a relist (each unlisted bundle relists once). */
  private readonly relistedBundles = new Set<string>();
  /** Names of processes that process listings found outside third-party apps. */
  private readonly systemNames = new Set<string>();
  /** Third-party-looking process names seen in logs that no listing has explained yet → when first seen. */
  private readonly pendingNames = new Map<string, number>();
  /** Names a listing asked for them did not find (the process had ended) → when (not kept for a while). */
  private readonly settledNames = new Map<string, number>();
  private poller?: Poller;
  private installedDueAt = 0;
  private runningDueAt = 0;
  private lastRunningOk = true;
  private lastTriggerAt = 0;
  private lastRelistAt = 0;
  private stopped = false;
  private readonly now: () => number;
  /** The first installed-app listing finished (either way) or the tracker stopped. */
  private listingDone = false;
  private readonly listingWaiters = new Set<() => void>();

  constructor(private readonly opts: AppTrackerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Resolves once the first installed-app listing finished (successfully or not), the tracker stopped, or
   * after `timeoutMs`. Crash reports wait for it: an app extension's report needs the app list to find its
   * host app.
   */
  whenListed(timeoutMs: number): Promise<void> {
    if (this.listingDone) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listingWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.listingWaiters.add(done);
    });
  }

  private markListed(): void {
    if (this.listingDone) return;
    this.listingDone = true;
    for (const w of [...this.listingWaiters]) w();
  }

  /** Installed app listing succeeded at least once. */
  get knowsApps(): boolean {
    return this.installedOk;
  }

  /** The first installed-app listing finished (successfully or not). */
  get listingFinished(): boolean {
    return this.listingDone;
  }

  app(id: string): InstalledIosApp | undefined {
    return this.installed.get(id);
  }

  /** Executable names of installed third-party apps. */
  executables(): Set<string> {
    return new Set(this.byExecutable.keys());
  }

  /** Is a crash file named after this process worth reading? (true while apps are unknown). */
  isInteresting(processName: string | undefined): boolean {
    if (!this.installedOk || !processName) return true;
    if (this.isAppProcess(processName)) return true;
    for (const a of this.installed.values()) if (a.name === processName) return true;
    return false;
  }

  /**
   * A running process of a third-party app (its extensions included), or of an app bundle installed after
   * the last listing.
   */
  isAppPid(pid: number): boolean {
    return this.pidOwner.has(pid) || this.provisionalPids.has(pid);
  }

  /**
   * Executable name of a third-party app, of an app extension seen running inside one, or of a process of an
   * app bundle installed after the last listing.
   */
  isAppProcess(name: string): boolean {
    return this.byExecutable.has(name) || this.helperNames.has(name) || this.provisionalNames.has(name);
  }

  /**
   * Installed third-party app a bundle id belongs to: the app itself, or the host app of an app extension
   * (iOS requires extension ids to start with the host's id: com.x.app.NotificationService → com.x.app).
   * Lenient on purpose: it only decides which system log lines are kept (crash reports use `reportApp`).
   */
  hostApp(bundleId: string): string | undefined {
    if (!isThirdPartyBundle(bundleId)) return undefined;
    if (this.installed.has(bundleId)) return bundleId;
    let id = bundleId;
    for (let dot = id.lastIndexOf('.'); dot > 0; dot = id.lastIndexOf('.')) {
      id = id.slice(0, dot);
      if (this.installed.has(id)) return id;
    }
    return undefined;
  }

  /**
   * Installed app a crash report belongs to: an installed app of the report's own bundle id, or — only for
   * an app extension's report, whose procPath lies in a .appex inside an app ("…/Runner.app/PlugIns/W.appex/W")
   * — the installed app whose bundle holds that .appex, else the installed app whose id is the extension's
   * id minus its last segment (com.x.app.Widget → com.x.app). Anything else keeps its own bundle id (undefined
   * here): a com.x.app.dev flavor's report, or a report without a procPath, is never com.x.app's.
   */
  reportApp(report: Pick<IpsReport, 'bundleId' | 'procPath'>): string | undefined {
    const id = report.bundleId;
    if (!id || !isThirdPartyBundle(id)) return undefined;
    if (this.installed.has(id)) return id;
    const host = report.procPath ? APPEX_IN_APP.exec(plainPath(report.procPath))?.[1] : undefined;
    if (!host) return undefined;
    for (const a of this.installed.values()) if (a.bundle && plainPath(a.bundle) === host) return a.id;
    const dot = id.lastIndexOf('.');
    const parent = dot > 0 ? id.slice(0, dot) : undefined;
    return parent && this.installed.has(parent) ? parent : undefined;
  }

  /**
   * Device log scope: a line of a process that is not a known third-party app. True (keep it) when its name
   * looks like a third-party executable and no process listing has explained it yet — an app installed or an
   * app extension started since the last listing — and a process listing is asked for now; that listing
   * decides (app lines stay, the rest are dropped from then on). Daemon-like names, names seen outside
   * third-party apps and names a listing did not find (for 10 min) are false. Only for sources that report
   * `systemNames`.
   */
  keepsUnknownProcess(name: string): boolean {
    if (!this.installedOk || this.stopped || !this.opts.source.systemNames) return false;
    if (this.pendingNames.has(name)) return true;
    if (daemonLikeName(name) || this.systemNames.has(name)) return false;
    const settled = this.settledNames.get(name);
    const now = this.now();
    if (settled !== undefined) {
      if (now - settled < SETTLED_MS) return false;
      this.settledNames.delete(name);
    }
    if (this.pendingNames.size >= MAX_PENDING_NAMES) return false;
    this.pendingNames.set(name, now);
    this.runningCheckSoon();
    return true;
  }

  /**
   * Relist installed apps now (after Dürbün installed or removed an app): the new app's lines and pids are
   * known without waiting for the next periodic listing.
   */
  relistNow(): void {
    if (this.stopped) return;
    this.lastRelistAt = this.now();
    this.installedDueAt = 0;
    this.runningDueAt = 0;
    this.poller?.trigger();
  }

  start(): void {
    if (this.poller || this.stopped) return;
    // DeviceApps of an earlier connection of this device stay in the hub (not running): adopt them so
    // they get the installed build's version and are dropped after 15 idle minutes like any other.
    for (const a of this.opts.getDeviceApps()) {
      if (a.deviceId === this.opts.deviceId && !this.listed.has(a.id)) this.listed.set(a.id, '');
    }
    this.poller = new Poller(() => this.tick(), Math.min(this.opts.runningEveryMs, 5000), this.opts.logger, `device apps ${this.opts.deviceId}`);
    this.poller.start();
  }

  /**
   * The device is gone: none of its apps is running any more (the hub keeps them until it removes the
   * device). Reported right away; an in-flight listing is awaited but its result is dropped.
   */
  async stop(): Promise<void> {
    if (!this.stopped) {
      for (const [id, pids] of [...this.pids]) {
        if (pids.length && this.listed.has(id)) this.push(id, { pids: [], running: false });
      }
      this.stopped = true;
      this.pids.clear();
      this.pidOwner.clear();
      this.provisionalPids.clear();
      this.markListed();
    }
    const poller = this.poller;
    this.poller = undefined;
    await poller?.stop();
  }

  /** One scheduler step (public for tests). */
  async tick(): Promise<void> {
    // A process listing that found an unlisted app bundle asks for a relist: it runs in a second pass right
    // away, not one poller interval later.
    for (let pass = 0; pass < 2; pass++) {
      if (this.stopped) return;
      const now = this.now();
      let relisted = false;
      if (now >= this.installedDueAt) {
        relisted = await this.refreshInstalled();
        this.installedDueAt = this.now() + (relisted ? this.opts.installedEveryMs : (this.opts.retryMs ?? 60_000));
      }
      if (this.stopped) return;
      // A new listing is matched against the processes right away (a relist asked for by a log line or an
      // unlisted bundle wants the new app's pids now, not at the next periodic check).
      if (this.installedOk && (relisted || this.now() >= this.runningDueAt)) {
        const ok = await this.refreshRunning();
        this.lastRunningOk = ok;
        this.runningDueAt = this.now() + (ok ? this.opts.runningEveryMs : Math.max(this.opts.runningEveryMs, this.opts.retryMs ?? 60_000));
      }
      if (this.now() < this.installedDueAt) break;
    }
    if (this.stopped) return;
    this.prune();
  }

  async refreshInstalled(): Promise<boolean> {
    let ok = false;
    try {
      ok = await this.listInstalledOnce();
      return ok;
    } finally {
      this.markListed();
      if (!this.stopped) {
        try {
          this.opts.onListed?.(ok);
        } catch (e) {
          this.opts.logger.debug(`${this.opts.deviceId}: onListed failed: ${(e as Error).message}`);
        }
      }
    }
  }

  private async listInstalledOnce(): Promise<boolean> {
    let list: InstalledIosApp[] | null;
    try {
      list = await this.opts.source.listInstalled();
    } catch (e) {
      this.opts.logger.debug(`${this.opts.deviceId}: listing apps failed: ${(e as Error).message}`);
      list = null;
    }
    if (!list || this.stopped) return false;
    this.installed = new Map(list.filter((a) => isThirdPartyBundle(a.id)).map((a) => [a.id, a]));
    this.byExecutable = new Map();
    for (const a of this.installed.values()) {
      if (!a.executable) continue;
      const ids = this.byExecutable.get(a.executable) ?? [];
      ids.push(a.id);
      this.byExecutable.set(a.executable, ids);
    }
    this.installedOk = true;
    this.unknownNames.clear();
    // The new listing decides what the unlisted bundles were (the next process listing flags what is left).
    this.provisionalPids.clear();
    this.provisionalNames.clear();
    // Reinstalled / updated builds: refresh version info of apps already shown.
    for (const id of [...this.listed.keys()]) {
      if (this.installed.has(id) && this.listed.get(id) !== this.infoSignature(id)) this.push(id, {});
    }
    return true;
  }

  async refreshRunning(): Promise<boolean> {
    const apps = [...this.installed.values()];
    const startedAt = this.now();
    let running: Map<string, number[]> | null;
    try {
      running = apps.length || this.opts.source.unlistedApps ? await this.opts.source.listRunning(apps) : new Map();
    } catch (e) {
      this.opts.logger.debug(`${this.opts.deviceId}: listing processes failed: ${(e as Error).message}`);
      running = null;
    }
    if (!running || this.stopped) return false;
    this.noteHelperNames();
    this.noteUnlisted();
    this.noteSystemNames(startedAt);
    const now = this.now();
    const ids = new Set([...this.installed.keys(), ...this.pids.keys()]);
    for (const id of ids) {
      const next = [...new Set(running.get(id) ?? [])].sort((a, b) => a - b);
      const prev = this.pids.get(id) ?? [];
      if (sameList(prev, next)) continue;
      if (next.length === 0 && !this.listed.has(id)) {
        this.setPids(id, []);
        continue;
      }
      const started = next.some((p) => !prev.includes(p));
      this.setPids(id, next);
      this.push(id, { pids: next, running: next.length > 0, ...(started ? { lastActivity: now } : {}) });
    }
    return true;
  }

  /** Every parsed device log line of this device (cheap: two map lookups). */
  onLog(entry: DeviceLogInput): void {
    const { pid, process } = entry;
    if (this.stopped || !pid || !process || this.pidOwner.has(pid)) return;
    const ids = this.byExecutable.get(process);
    if (!ids) {
      if (this.installedOk && !this.unknownNames.has(process) && this.relistOnUnknown()) {
        this.unknownNames.add(process);
        if (this.unknownNames.size > 2000) this.unknownNames.clear();
        this.requestRelist();
      }
      return;
    }
    if (ids.length === 1) {
      const id = ids[0]!;
      const pids = [...(this.pids.get(id) ?? []), pid].sort((a, b) => a - b);
      this.setPids(id, pids);
      this.push(id, { pids, running: true, lastActivity: Math.max(entry.ts || 0, this.now() - 1000) });
    }
    // Confirm with the process list (also resolves several apps sharing one executable name, e.g. "Runner").
    this.requestRunningCheck();
  }

  /** A crash report of a third-party app on this device (an app extension's counts for its host app). */
  onCrash(report: IpsReport): DeviceApp | undefined {
    if (!isThirdPartyBundle(report.bundleId) || this.stopped) return undefined;
    const id = this.reportApp(report) ?? report.bundleId;
    const pids = this.pids.get(id) ?? [];
    const next = report.pid !== undefined ? pids.filter((p) => p !== report.pid) : pids;
    if (!sameList(pids, next)) this.setPids(id, next);
    const known = this.installed.get(id);
    const fallback: Partial<DeviceApp> = known
      ? {}
      : {
          ...(report.appName ? { name: report.appName } : {}),
          ...(report.version ? { version: report.version } : {}),
          ...(report.build ? { build: report.build } : {}),
          ...(report.procName && report.procName !== id ? { processName: report.procName } : {}),
        };
    const app = this.push(id, {
      ...fallback,
      pids: next,
      running: next.length > 0,
      lastActivity: Math.max(report.ts ?? 0, this.existing(id)?.lastActivity ?? 0) || this.now(),
      crashReportsDelta: 1,
    });
    this.requestRunningCheck();
    return app;
  }

  /** Drop apps that stopped, have no crash reports and were idle for 15 min. */
  prune(): void {
    const now = this.now();
    for (const id of [...this.listed.keys()]) {
      if ((this.pids.get(id) ?? []).length) continue;
      const app = this.existing(id);
      if (!app) {
        this.listed.delete(id);
        continue;
      }
      if (app.running || (app.crashReports ?? 0) > 0) continue;
      if (now - app.lastActivity <= RECENT_ACTIVITY_MS) continue;
      this.opts.hub.removeDeviceApps(this.opts.deviceId, [id]);
      this.listed.delete(id);
    }
  }

  /* ───────────── internals ───────────── */

  private noteHelperNames(): void {
    const names = this.opts.source.runningNames?.();
    if (!names) return;
    if (this.helperNames.size > 2000) this.helperNames.clear();
    for (const name of names.values()) if (name) this.helperNames.add(name);
  }

  /**
   * Names of non-third-party processes, then the names `keepsUnknownProcess` kept until a listing started
   * after they were seen: an app's (learned above) or a system process's are known now; the others had ended
   * and are not kept again for a while.
   */
  private noteSystemNames(listingStartedAt: number): void {
    const names = this.opts.source.systemNames?.();
    if (names) {
      if (this.systemNames.size > 5000) this.systemNames.clear();
      for (const n of names) if (!this.isAppProcess(n)) this.systemNames.add(n);
    }
    if (!this.pendingNames.size) return;
    const now = this.now();
    for (const [name, since] of this.pendingNames) {
      if (since > listingStartedAt) continue;
      this.pendingNames.delete(name);
      if (!this.isAppProcess(name) && !this.systemNames.has(name)) this.settledNames.set(name, now);
    }
    if (this.settledNames.size > 2000) this.settledNames.clear();
  }

  /**
   * Processes of app bundles the last listing did not have: count them as third-party at once, and relist
   * (once per bundle, at most every 30 s) so the new app shows up with its name, version and pids.
   */
  private noteUnlisted(): void {
    const unlisted = this.opts.source.unlistedApps?.();
    this.provisionalPids.clear();
    if (!unlisted?.size) return;
    let fresh = false;
    for (const [pid, p] of unlisted) {
      this.provisionalPids.set(pid, p.bundle);
      if (p.name) this.provisionalNames.add(p.name);
      if (!this.relistedBundles.has(p.bundle)) fresh = true;
    }
    if (this.provisionalNames.size > 2000) this.provisionalNames.clear();
    if (!fresh || !this.requestRelist()) return;
    if (this.relistedBundles.size > 2000) this.relistedBundles.clear();
    for (const p of unlisted.values()) this.relistedBundles.add(p.bundle);
  }

  private relistOnUnknown(): boolean {
    const v = this.opts.relistOnUnknownProcess;
    return typeof v === 'function' ? v() : !!v;
  }

  private requestRunningCheck(): void {
    const now = this.now();
    if (!this.lastRunningOk || now - this.lastTriggerAt < (this.opts.triggerGapMs ?? 10_000)) return;
    this.lastTriggerAt = now;
    this.runningDueAt = 0;
    this.poller?.trigger();
  }

  /**
   * A process listing as soon as the log-trigger gap allows (now, or at the next poller step): unlike
   * `requestRunningCheck`, a check that is too early is postponed, not dropped.
   */
  private runningCheckSoon(): void {
    if (!this.lastRunningOk) return;
    const now = this.now();
    const at = Math.max(now, this.lastTriggerAt + (this.opts.triggerGapMs ?? 10_000));
    if (at >= this.runningDueAt) return;
    this.runningDueAt = at;
    this.lastTriggerAt = at;
    if (at <= now) this.poller?.trigger();
  }

  /** Relist installed apps soon (at most every 30 s); false when the last relist was too recent. */
  private requestRelist(): boolean {
    const now = this.now();
    if (now - this.lastRelistAt < 30_000) return false;
    this.lastRelistAt = now;
    this.installedDueAt = 0;
    this.runningDueAt = 0;
    this.poller?.trigger();
    return true;
  }

  private setPids(id: string, pids: number[]): void {
    const prev = this.pids.get(id) ?? [];
    for (const p of prev) {
      if (pids.includes(p)) continue;
      if (this.pidOwner.get(p) === id) this.pidOwner.delete(p);
      const name = this.installed.get(id)?.executable;
      if (name) this.opts.hub.setProcess({ deviceId: this.opts.deviceId, pid: p, name, event: 'died' });
    }
    for (const p of pids) this.pidOwner.set(p, id);
    if (pids.length) this.pids.set(id, pids);
    else this.pids.delete(id);
  }

  private existing(id: string): DeviceApp | undefined {
    const key = `${this.opts.deviceId}|${id}`;
    return this.opts.getDeviceApps().find((a) => a.key === key);
  }

  private info(id: string): Partial<DeviceApp> {
    const a = this.installed.get(id);
    if (!a) return {};
    return {
      ...(a.name ? { name: a.name } : {}),
      ...(a.version ? { version: a.version } : {}),
      ...(a.build ? { build: a.build } : {}),
      buildType: a.buildType,
      install: { source: a.source },
      ...(a.executable && a.executable !== a.id ? { processName: a.executable } : {}),
    };
  }

  private infoSignature(id: string): string {
    return JSON.stringify(this.info(id));
  }

  /** Upsert with the installed info; keeps the hub's lastActivity unless the patch sets one. */
  private push(
    id: string,
    patch: Partial<Omit<DeviceApp, 'key' | 'deviceId' | 'id' | 'crashReports'>> & { crashReportsDelta?: number },
  ): DeviceApp | undefined {
    const lastActivity = patch.lastActivity ?? this.existing(id)?.lastActivity ?? this.now();
    try {
      const app = this.opts.hub.upsertDeviceApp({
        deviceId: this.opts.deviceId,
        id,
        ...this.info(id),
        ...patch,
        lastActivity,
      });
      this.listed.set(id, this.infoSignature(id));
      return app;
    } catch (e) {
      this.opts.logger.debug(`upsertDeviceApp ${id} failed: ${(e as Error).message}`);
      return undefined;
    }
  }
}

/** "…/X.app/PlugIns/W.appex/…" (or ExtensionKit's "X.app/Extensions/W.appex/") → "…/X.app". */
const APPEX_IN_APP = /^(.*?\.app)\/(?:PlugIns|Extensions)\/[^/]+\.appex(?:\/|$)/i;

/** File URL or path without "file://", URL escapes, a trailing slash and "/private" ("/var/containers/…"). */
function plainPath(urlOrPath: string): string {
  let p = urlOrPath.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep it encoded */
  }
  return p.replace(/\/+$/, '').replace(/^\/private\//, '/');
}
