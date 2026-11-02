/**
 * DeviceApps for iOS devices and simulators (SPEC §10.2): which third-party apps are installed (with
 * version / build / build type / install source), which of them run (pids), and which were active in the
 * device log or crashed. Only apps that are running, recently active (≤ 15 min) or have crash reports are
 * reported to the hub; the hub owns storage and `lastActivity` bumps from log lines (pid ∈ pids).
 *
 * The platform specifics live behind `AppSource` (devicectl for physical devices, simctl + ps for
 * simulators). Every failure is data: a failed listing keeps the last known state and retries later.
 */
import type { AppBuildType, AppInstallSource, DeviceApp } from '@durbun/protocol';
import type { DeviceLogInput, HubSink, Logger } from '../../types';
import { Poller } from '../shared/timing';
import { isThirdPartyBundle, type IpsReport } from './crashReport';

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

export interface AppSource {
  /** Installed third-party apps; null when the listing failed (tool missing, device refused…). */
  listInstalled(): Promise<InstalledIosApp[] | null>;
  /** bundle id → live pids; null when it could not be determined. */
  listRunning(apps: InstalledIosApp[]): Promise<Map<string, number[]> | null>;
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
  now?: () => number;
}

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export class IosAppTracker {
  private installed = new Map<string, InstalledIosApp>();
  private byExecutable = new Map<string, string[]>();
  private installedOk = false;
  private readonly pids = new Map<string, number[]>();
  private readonly pidOwner = new Map<number, string>();
  /** Ids reported to the hub (and the info signature last sent). */
  private readonly listed = new Map<string, string>();
  private readonly unknownNames = new Set<string>();
  private poller?: Poller;
  private installedDueAt = 0;
  private runningDueAt = 0;
  private lastRunningOk = true;
  private lastTriggerAt = 0;
  private lastRelistAt = 0;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly opts: AppTrackerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Installed app listing succeeded at least once. */
  get knowsApps(): boolean {
    return this.installedOk;
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
    if (this.byExecutable.has(processName)) return true;
    for (const a of this.installed.values()) if (a.name === processName) return true;
    return false;
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
    }
    const poller = this.poller;
    this.poller = undefined;
    await poller?.stop();
  }

  /** One scheduler step (public for tests). */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (now >= this.installedDueAt) {
      const ok = await this.refreshInstalled();
      this.installedDueAt = this.now() + (ok ? this.opts.installedEveryMs : (this.opts.retryMs ?? 60_000));
    }
    if (this.stopped) return;
    if (this.installedOk && this.now() >= this.runningDueAt) {
      const ok = await this.refreshRunning();
      this.lastRunningOk = ok;
      this.runningDueAt = this.now() + (ok ? this.opts.runningEveryMs : Math.max(this.opts.runningEveryMs, this.opts.retryMs ?? 60_000));
    }
    if (this.stopped) return;
    this.prune();
  }

  async refreshInstalled(): Promise<boolean> {
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
    // Reinstalled / updated builds: refresh version info of apps already shown.
    for (const id of [...this.listed.keys()]) {
      if (this.installed.has(id) && this.listed.get(id) !== this.infoSignature(id)) this.push(id, {});
    }
    return true;
  }

  async refreshRunning(): Promise<boolean> {
    const apps = [...this.installed.values()];
    let running: Map<string, number[]> | null;
    try {
      running = apps.length ? await this.opts.source.listRunning(apps) : new Map();
    } catch (e) {
      this.opts.logger.debug(`${this.opts.deviceId}: listing processes failed: ${(e as Error).message}`);
      running = null;
    }
    if (!running || this.stopped) return false;
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

  /** A crash report of a third-party app on this device. */
  onCrash(report: IpsReport): DeviceApp | undefined {
    const id = report.bundleId;
    if (!isThirdPartyBundle(id) || this.stopped) return undefined;
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

  private requestRelist(): void {
    const now = this.now();
    if (now - this.lastRelistAt < 30_000) return;
    this.lastRelistAt = now;
    this.installedDueAt = 0;
    this.runningDueAt = 0;
    this.poller?.trigger();
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
