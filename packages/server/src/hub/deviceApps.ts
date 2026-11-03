/**
 * Device apps (SPEC §10.2): apps the device itself reports (running, recently active or crashed),
 * independent of SDK sessions. Drivers own pids / running / version / build / buildType / install; the
 * store owns merging, `lastActivity` (bumped by device log lines and process events of the app) and the
 * change throttle: a log flood produces at most one activity change per app per `throttleMs`.
 *
 * Objects are kept mutable inside the store (the batcher copies them when it flushes); everything handed
 * out is a copy.
 */
import type { AppBuildType, AppInstallSource, DeviceApp, LogEntry } from '@durbun/protocol';
import type { HubSink } from '../types';
import { finite, isRecord } from './sanitize';

export type DeviceAppInput = Parameters<HubSink['upsertDeviceApp']>[0];

/** Minimum gap between two activity-only changes of the same app. */
export const DEVICE_APP_ACTIVITY_THROTTLE_MS = 1000;
/** Upper bound of stored device apps (drivers report third-party apps only; this is a safety net). */
export const MAX_DEVICE_APPS = 2000;

const BUILD_TYPES = new Set<string>(['debug', 'release', 'unknown']);
const INSTALL_SOURCES = new Set<string>(['play', 'firebase', 'adb', 'other-store', 'xcode', 'store-or-testflight', 'simulator', 'unknown']);

export const deviceAppKey = (deviceId: string, id: string): string => `${deviceId}|${id}`;

const isDeviceRecord = (e: LogEntry) => e.origin === 'dropbox' || e.origin === 'crash-report';
/** A crash / ANR record the device kept from before Dürbün was watching (SPEC §10.3 previousLaunch). */
const isPreviousLaunchRecord = (e: LogEntry) => isDeviceRecord(e) && isRecord(e.data) && e.data.previousLaunch === true;

/**
 * Tells which DeviceApp's `crashReports` a device crash record counted for, the way the drivers count
 * them: one per dropbox / .ips record (keyed by the package it names: Android `data.package`, iOS
 * `data.bundleId`, the host app for an extension), except a copy of another record (`data.duplicateOf`
 * naming a dropbox / .ips row: Android's tombstone of a native crash) and a later copy of a live crash
 * line an earlier record already copied (dropbox.ts "one crash, one report"). Feed every row in id order.
 */
export function crashRecordCounter(): (e: LogEntry) => string | undefined {
  const records = new Set<number>();
  const copied = new Set<number>();
  return (e) => {
    if (!isDeviceRecord(e)) return undefined;
    records.add(e.id);
    const data = isRecord(e.data) ? e.data : undefined;
    const dup = data?.duplicateOf;
    if (typeof dup === 'number') {
      if (records.has(dup) || copied.has(dup)) return undefined;
      copied.add(dup);
    }
    const pkg = data?.package ?? data?.bundleId;
    return typeof pkg === 'string' && pkg ? deviceAppKey(e.deviceId, pkg) : undefined;
  };
}

export function copyDeviceApp(app: DeviceApp): DeviceApp {
  return { ...app, pids: [...app.pids], install: { ...app.install } };
}

function cleanPids(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const p of v) {
    if (typeof p === 'number' && Number.isInteger(p) && p > 0 && !out.includes(p)) out.push(p);
  }
  return out;
}

function cleanInstall(v: unknown): DeviceApp['install'] | undefined {
  if (!isRecord(v)) return undefined;
  const source = typeof v.source === 'string' && INSTALL_SOURCES.has(v.source) ? (v.source as AppInstallSource) : 'unknown';
  const install: DeviceApp['install'] = { source };
  if (typeof v.installer === 'string' && v.installer) install.installer = v.installer;
  const firstInstall = finite(v.firstInstall);
  if (firstInstall !== undefined) install.firstInstall = firstInstall;
  const lastUpdate = finite(v.lastUpdate);
  if (lastUpdate !== undefined) install.lastUpdate = lastUpdate;
  return install;
}

/** Fields that make a change worth sending right away (everything except lastActivity). */
function signature(app: DeviceApp): string {
  return JSON.stringify([
    app.name,
    app.version,
    app.build,
    app.buildType,
    app.install.source,
    app.install.installer,
    app.install.firstInstall,
    app.install.lastUpdate,
    app.processName,
    [...app.pids].sort((a, b) => a - b), // a re-report in another order is not a change
    app.running,
    app.crashReports,
  ]);
}

export interface DeviceAppStoreOptions {
  onChange(app: DeviceApp): void;
  onRemove(key: string): void;
  now?: () => number;
  throttleMs?: number;
  maxApps?: number;
}

export class DeviceAppStore {
  private readonly apps = new Map<string, DeviceApp>();
  /** deviceId → pid → key */
  private readonly byPid = new Map<string, Map<number, string>>();
  /** deviceId → bundle id / process name → keys */
  private readonly byName = new Map<string, Map<string, Set<string>>>();
  /** key → last time an activity change went out */
  private readonly lastEmit = new Map<string, number>();
  /**
   * key → pids / running the driver last reported, kept while the device is offline / unauthorized. A
   * driver whose session survives such a state (iOS re-trust) only reports pid changes, so the hub puts
   * them back when the device is online again unless the driver reported pids / running meanwhile.
   */
  private readonly suspended = new Map<string, { pids: number[]; running: boolean }>();
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly maxApps: number;

  constructor(private readonly opts: DeviceAppStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.throttleMs = opts.throttleMs ?? DEVICE_APP_ACTIVITY_THROTTLE_MS;
    this.maxApps = opts.maxApps ?? MAX_DEVICE_APPS;
  }

  get size(): number {
    return this.apps.size;
  }

  list(): DeviceApp[] {
    return [...this.apps.values()].map(copyDeviceApp);
  }

  /** Live objects of one device (or all) — callers must copy before handing them out. */
  values(deviceId?: string): DeviceApp[] {
    const all = [...this.apps.values()];
    return deviceId === undefined ? all : all.filter((a) => a.deviceId === deviceId);
  }

  get(deviceId: string, id: string): DeviceApp | undefined {
    const app = this.apps.get(deviceAppKey(deviceId, id));
    return app ? copyDeviceApp(app) : undefined;
  }

  /** Merge (SPEC §10.2 / HubSink.upsertDeviceApp). Never throws; invalid input is returned unstored. */
  upsert(input: DeviceAppInput): DeviceApp {
    const now = this.now();
    if (!isRecord(input) || typeof input.deviceId !== 'string' || typeof input.id !== 'string' || !input.deviceId || !input.id) {
      const deviceId = isRecord(input) && typeof input.deviceId === 'string' ? input.deviceId : '';
      const id = isRecord(input) && typeof input.id === 'string' ? input.id : '';
      return { key: deviceAppKey(deviceId, id), deviceId, id, buildType: 'unknown', install: { source: 'unknown' }, pids: [], running: false, lastActivity: now };
    }
    const key = deviceAppKey(input.deviceId, input.id);
    const prev = this.apps.get(key);
    const before = prev ? signature(prev) : undefined;
    const prevActivity = prev?.lastActivity ?? 0;
    const prevPids = prev ? [...prev.pids] : [];
    const prevProcessName = prev?.processName;

    const app: DeviceApp = prev ?? {
      key,
      deviceId: input.deviceId,
      id: input.id,
      buildType: 'unknown',
      install: { source: 'unknown' },
      pids: [],
      running: false,
      lastActivity: 0,
    };
    for (const field of ['name', 'version', 'build', 'processName'] as const) {
      const v = input[field];
      if (typeof v === 'string') app[field] = v;
    }
    // A driver clears a process name that no longer applies (Android: ':remote' until the main process runs).
    if (input.processName === null) delete app.processName;
    if (typeof input.buildType === 'string' && BUILD_TYPES.has(input.buildType)) app.buildType = input.buildType as AppBuildType;
    const install = cleanInstall(input.install);
    if (install) app.install = install;
    const pids = cleanPids(input.pids);
    if (pids) app.pids = pids;
    if (typeof input.running === 'boolean') app.running = input.running;
    if (pids || typeof input.running === 'boolean') this.suspended.delete(key); // the driver spoke: nothing to restore
    // Activity cannot be in the future (device clock ahead, a record time read in the wrong time zone):
    // a future value would stick (max) and block every bump until the clock catches up.
    const reported = finite(input.lastActivity);
    app.lastActivity = Math.max(prevActivity, reported === undefined ? now : Math.min(reported, now));
    const delta = finite(input.crashReportsDelta);
    if (delta !== undefined && delta > 0) app.crashReports = (app.crashReports ?? 0) + Math.floor(delta);

    if (!prev) {
      this.evictIfFull();
      this.apps.set(key, app);
    }
    if (!prev || pids) this.reindexPids(app, prevPids);
    if (!prev || app.processName !== prevProcessName) this.reindexNames(app, prevProcessName);

    if (before === undefined || signature(app) !== before) this.emit(app);
    else if (app.lastActivity > prevActivity) this.throttled(app);
    return copyDeviceApp(app);
  }

  /**
   * The log rows these crash counts stood for were cleared (SPEC §10.2): `crashReports` of the apps in scope
   * starts again from nothing, so "N crash records" matches what is left to see. Returns how many changed.
   */
  resetCrashReports(inScope: (app: DeviceApp) => boolean): number {
    let changed = 0;
    for (const app of this.apps.values()) {
      if (app.crashReports === undefined || !inScope(app)) continue;
      delete app.crashReports;
      this.emit(app);
      changed++;
    }
    return changed;
  }

  /**
   * Some of the crash records these counts stood for were cleared (key → how many of them counted; see
   * crashRecordCounter): each app's `crashReports` goes down by as much, so "N crash records" still matches
   * the records left to see. Returns how many apps changed.
   */
  forgetCrashReports(removed: ReadonlyMap<string, number>): number {
    let changed = 0;
    for (const [key, n] of removed) {
      const app = this.apps.get(key);
      if (!app || app.crashReports === undefined || !(n > 0)) continue;
      const left = app.crashReports - n;
      if (left > 0) app.crashReports = left;
      else delete app.crashReports;
      this.emit(app);
      changed++;
    }
    return changed;
  }

  /** Drops apps of a device (`ids`), or all of them. Returns the removed keys. */
  remove(deviceId: string, ids?: readonly string[]): string[] {
    if (typeof deviceId !== 'string') return [];
    const wanted = Array.isArray(ids) ? new Set(ids.filter((x) => typeof x === 'string')) : undefined;
    const removed: string[] = [];
    for (const app of [...this.apps.values()]) {
      if (app.deviceId !== deviceId || (wanted && !wanted.has(app.id))) continue;
      this.drop(app);
      removed.push(app.key);
    }
    return removed;
  }

  /**
   * None of the device's apps can be confirmed running any more. `resumable`: the device is only offline /
   * unauthorized (its driver session lives on), so resumeDevice() may put the last reported pids back;
   * otherwise (device gone) nothing is kept.
   */
  markDeviceStopped(deviceId: string, resumable = false): void {
    for (const app of this.values(deviceId)) {
      if (!resumable) this.suspended.delete(app.key);
      if (!app.running && app.pids.length === 0) continue;
      if (resumable) this.suspended.set(app.key, { pids: [...app.pids], running: app.running });
      const prevPids = [...app.pids];
      app.running = false;
      app.pids = [];
      this.reindexPids(app, prevPids);
      this.emit(app);
    }
  }

  /** The device is online again: apps the driver did not re-report since it left get their pids back. */
  resumeDevice(deviceId: string): void {
    for (const app of this.values(deviceId)) {
      const saved = this.suspended.get(app.key);
      if (!saved) continue;
      this.suspended.delete(app.key);
      const owners = this.byPid.get(deviceId);
      const pids = saved.pids.filter((p) => !owners?.has(p) || owners.get(p) === app.key); // never steal a reused pid
      if (pids.length === 0 && saved.pids.length > 0) continue;
      const prevPids = [...app.pids];
      app.pids = pids;
      app.running = saved.running;
      this.reindexPids(app, prevPids);
      this.emit(app);
    }
  }

  /**
   * Device log lines (ids assigned): bumps lastActivity of the apps they belong to — at arrival time, except
   * crash / ANR records read from the device (dropbox, .ips), which count at their own time (capped at now):
   * a crash from this morning must not make the app look active just now. Records of a previous launch
   * bump nothing: their driver reports lastActivity = reportTs itself, and their pid / process name may
   * belong to another app by now.
   */
  noteLogs(deviceId: string, entries: readonly LogEntry[]): void {
    if (this.apps.size === 0 || entries.length === 0) return;
    const pidMap = this.byPid.get(deviceId);
    const nameMap = this.byName.get(deviceId);
    if (!pidMap && !nameMap) return;
    let hits: Map<string, number> | undefined;
    let now: number | undefined;
    for (const e of entries) {
      if (isPreviousLaunchRecord(e)) continue;
      const key = this.match(pidMap, nameMap, e.pid, e.process);
      if (!key) continue;
      now ??= this.now();
      const at = isDeviceRecord(e) ? Math.min(Number.isFinite(e.ts) ? e.ts : now, now) : now;
      hits ??= new Map();
      if (at > (hits.get(key) ?? -Infinity)) hits.set(key, at);
    }
    if (!hits) return;
    for (const [key, at] of hits) this.bump(key, at);
  }

  /** Process started / died: bumps lastActivity of the app the process belongs to. */
  noteProcess(deviceId: string, pid: number, name: string): void {
    if (this.apps.size === 0) return;
    const key = this.match(this.byPid.get(deviceId), this.byName.get(deviceId), pid, name);
    if (key) this.bump(key, this.now());
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  /* ───────────── internals ───────────── */

  private match(
    pidMap: Map<number, string> | undefined,
    nameMap: Map<string, Set<string>> | undefined,
    pid: number | undefined,
    process: string | undefined,
  ): string | undefined {
    if (pid !== undefined && pidMap) {
      const key = pidMap.get(pid);
      if (key) return key;
    }
    if (!process || !nameMap) return undefined;
    const exact = nameMap.get(process);
    if (exact?.size === 1) return exact.values().next().value;
    // Android ":service" processes ("com.example.app:sync") belong to the package.
    const colon = process.indexOf(':');
    if (colon > 0) {
      const base = nameMap.get(process.slice(0, colon));
      if (base?.size === 1) return base.values().next().value;
    }
    return undefined;
  }

  private bump(key: string, at: number): void {
    const app = this.apps.get(key);
    if (!app || at <= app.lastActivity) return;
    app.lastActivity = at;
    this.throttled(app);
  }

  private emit(app: DeviceApp): void {
    this.lastEmit.set(app.key, this.now());
    this.pending.delete(app.key);
    if (!this.disposed) this.opts.onChange(app);
  }

  private throttled(app: DeviceApp): void {
    const last = this.lastEmit.get(app.key);
    const now = this.now();
    if (last === undefined || now - last >= this.throttleMs) {
      this.emit(app);
      return;
    }
    this.pending.add(app.key);
    this.schedule(this.throttleMs - (now - last));
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => this.flushPending(), Math.max(1, delayMs));
    this.timer.unref?.();
  }

  private flushPending(): void {
    this.timer = undefined;
    if (this.disposed) return;
    const now = this.now();
    let nextDelay = Infinity;
    for (const key of [...this.pending]) {
      const app = this.apps.get(key);
      if (!app) {
        this.pending.delete(key);
        continue;
      }
      const wait = this.throttleMs - (now - (this.lastEmit.get(key) ?? -Infinity));
      if (wait <= 0) this.emit(app);
      else nextDelay = Math.min(nextDelay, wait);
    }
    if (this.pending.size > 0) this.schedule(Number.isFinite(nextDelay) ? nextDelay : this.throttleMs);
  }

  private drop(app: DeviceApp): void {
    this.apps.delete(app.key);
    this.reindexPids({ ...app, pids: [] }, app.pids);
    this.unindexName(app.deviceId, app.id, app.key);
    if (app.processName) this.unindexName(app.deviceId, app.processName, app.key);
    this.lastEmit.delete(app.key);
    this.pending.delete(app.key);
    this.suspended.delete(app.key);
    if (!this.disposed) this.opts.onRemove(app.key);
  }

  private evictIfFull(): void {
    if (this.apps.size < this.maxApps) return;
    let victim: DeviceApp | undefined;
    for (const app of this.apps.values()) {
      if (app.running) continue;
      if (!victim || app.lastActivity < victim.lastActivity) victim = app;
    }
    victim ??= this.apps.values().next().value;
    if (victim) this.drop(victim);
  }

  private reindexPids(app: DeviceApp, previous: readonly number[]): void {
    let map = this.byPid.get(app.deviceId);
    for (const pid of previous) if (map?.get(pid) === app.key) map.delete(pid);
    if (app.pids.length > 0) {
      if (!map) {
        map = new Map();
        this.byPid.set(app.deviceId, map);
      }
      for (const pid of app.pids) map.set(pid, app.key);
    }
    if (map && map.size === 0) this.byPid.delete(app.deviceId);
  }

  private reindexNames(app: DeviceApp, previousProcessName: string | undefined): void {
    if (previousProcessName && previousProcessName !== app.processName && previousProcessName !== app.id) {
      this.unindexName(app.deviceId, previousProcessName, app.key);
    }
    this.indexName(app.deviceId, app.id, app.key);
    if (app.processName) this.indexName(app.deviceId, app.processName, app.key);
  }

  private indexName(deviceId: string, name: string, key: string): void {
    let map = this.byName.get(deviceId);
    if (!map) {
      map = new Map();
      this.byName.set(deviceId, map);
    }
    let keys = map.get(name);
    if (!keys) {
      keys = new Set();
      map.set(name, keys);
    }
    keys.add(key);
  }

  private unindexName(deviceId: string, name: string, key: string): void {
    const map = this.byName.get(deviceId);
    const keys = map?.get(name);
    if (!map || !keys) return;
    keys.delete(key);
    if (keys.size === 0) map.delete(name);
    if (map.size === 0) this.byName.delete(deviceId);
  }
}
