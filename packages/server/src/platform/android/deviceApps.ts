/**
 * Android DeviceApps (SPEC §10.2): third-party apps the device itself reports — running processes,
 * plus apps that only have a crash record — with version / build / debuggable / installer read from
 * `dumpsys package <pkg>`. Works for any build (no SDK needed).
 *
 * Cost: one `pm list packages -3` + `-s` call per 5 min (or when an unknown package's process
 * appears, at most every 15 s), one batched `dumpsys package` call per newly seen package (refreshed on
 * `Start proc` when the cached info is older than 30 s, which catches reinstalls / updates).
 *
 * App label (DeviceApp.name): stock adb has no aapt and nothing resolves string resources without loading
 * the APK, so only a literal manifest label is read — `cmd package resolve-activity` (Android 7+, a binder
 * call, no resources) prints it as `nonLocalizedLabel=`. Flutter's template label (`android:label="pati"`)
 * and manifest placeholders are literals; `@string/app_name` labels stay undefined (the UI shows the id).
 */
import type { AppBuildType, AppInstallSource, DeviceApp } from '@durbun/protocol';
import type { HubSink, Logger } from '../../types';
import type { Adb } from './adb';
import { deviceLocalToEpoch, parseTzName, parseUtcOffset, type DeviceClock } from './deviceClock';
import { parsePackageList } from './parsers';

/* ───────────────────────────── parsers ───────────────────────────── */

export const PKG_SECTION = '___DURBUN_PKGS___';
export const PKG_DUMP_SEP = '___DURBUN_PKG___';
export const PKG_LABEL_SEP = '___DURBUN_LABEL___';

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

/** Package name of a process name ("com.foo:remote" → "com.foo"); undefined for daemons / paths. */
export function basePackage(processName: string | undefined): string | undefined {
  if (!processName) return undefined;
  const colon = processName.indexOf(':');
  const base = colon === -1 ? processName : processName.slice(0, colon);
  return base.length <= 255 && PACKAGE_RE.test(base) ? base : undefined;
}

export function isPackageName(text: string): boolean {
  return text.length <= 255 && PACKAGE_RE.test(text);
}

/** The `pm list packages` command the tracker runs (time zone first, then both lists). */
export function packageListCommand(): string {
  return [
    'date +%z',
    'getprop persist.sys.timezone',
    `echo ${PKG_SECTION}`,
    'pm list packages -3',
    `echo ${PKG_SECTION}`,
    'pm list packages -s',
  ].join('; ');
}

export interface PackageLists {
  thirdParty: Set<string>;
  system: Set<string>;
  clock: DeviceClock;
}

/** Output of `packageListCommand()`; undefined when the sections are missing (command failed). */
export function parsePackageLists(text: string): PackageLists | undefined {
  const parts = text.split(new RegExp(`^${PKG_SECTION}\\s*$`, 'm'));
  if (parts.length < 3) return undefined;
  const head = (parts[0] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const clock: DeviceClock = {};
  for (const line of head) {
    const off = parseUtcOffset(line);
    if (off !== undefined && clock.offsetMinutes === undefined) clock.offsetMinutes = off;
    else if (clock.tzName === undefined) {
      const tz = parseTzName(line);
      if (tz) clock.tzName = tz;
    }
  }
  const third = parts[1] ?? '';
  // "pm" printing an error instead of packages (package service not up yet).
  if (/Error:|Exception|Can't find service|Failure/.test(third) && !/^package:/m.test(third)) return undefined;
  return {
    thirdParty: new Set(parsePackageList(third)),
    system: new Set(parsePackageList(parts[2] ?? '')),
    clock,
  };
}

export interface PackageDetails {
  id: string;
  /** Literal launcher / application label (see the header comment), when the manifest has one. */
  label?: string;
  versionName?: string;
  versionCode?: string;
  debuggable?: boolean;
  /** `installerPackageName=` (installer of record). */
  installer?: string;
  /** `initiatingPackageName=` / `installInitiatingPackageName=` (Android 11+ InstallSource). */
  initiator?: string;
  originator?: string;
  updateOwner?: string;
  /** Raw device-local "yyyy-MM-dd HH:mm:ss". */
  firstInstallTime?: string;
  lastUpdateTime?: string;
}

// Case-insensitive: some builds print "InstallerPackageName" (SPEC §10.2).
const INSTALL_KEY_RE =
  /\b(installerPackageName|installInitiatingPackageName|initiatingPackageName|installOriginatingPackageName|originatingPackageName|updateOwnerPackageName)[=:]\s*([A-Za-z0-9_.]+)/gi;

function nonNull(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t && t !== 'null' ? t : undefined;
}

/**
 * `dumpsys package <pkg>` → the package's block under "Packages:" (Android 5 … 15 shapes):
 *   "  Package [com.foo] (8f3e2a1):" … "versionCode=42 minSdk=21 targetSdk=34" … "versionName=2.3.1"
 *   "flags=[ DEBUGGABLE HAS_CODE … ]" / "pkgFlags=[ … ]" … "firstInstallTime=…" (package-level up to
 *   Android 12, under "User 0:" from 13) … "lastUpdateTime=…" … "installerPackageName=…" (+ Android 11+
 *   "initiatingPackageName=", "originatingPackageName=", 14+ "updateOwnerPackageName=").
 * Undefined when the package is not installed ("Unable to find package: …" / no block).
 */
export function parseDumpsysPackage(text: string, pkg: string): PackageDetails | undefined {
  const lines = text.split('\n');
  let start = -1;
  let indent = 0;
  const header = `Package [${pkg}]`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = line.indexOf(header);
    if (at !== -1 && line.slice(0, at).trim() === '') {
      start = i;
      indent = at;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const lead = line.length - line.trimStart().length;
    if (lead <= indent) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start + 1, end);
  const out: PackageDetails = { id: pkg };
  for (const raw of block) {
    const line = raw.trim();
    if (out.versionCode === undefined) {
      const m = /^versionCode=(\d+)/.exec(line);
      if (m) {
        out.versionCode = m[1];
        continue;
      }
    }
    if (out.versionName === undefined && line.startsWith('versionName=')) {
      out.versionName = nonNull(line.slice('versionName='.length));
      if (out.versionName === undefined) out.versionName = '';
      continue;
    }
    const fm = /^(?:pkg)?[Ff]lags=\[(.*)\]/.exec(line);
    if (fm) {
      const debug = /(?:^|\s)DEBUGGABLE(?:\s|$)/.test(fm[1]!);
      out.debuggable = (out.debuggable ?? false) || debug;
      continue;
    }
    if (out.firstInstallTime === undefined && line.startsWith('firstInstallTime=')) {
      out.firstInstallTime = line.slice('firstInstallTime='.length).trim();
      continue;
    }
    if (out.lastUpdateTime === undefined && line.startsWith('lastUpdateTime=')) {
      out.lastUpdateTime = line.slice('lastUpdateTime='.length).trim();
      continue;
    }
    INSTALL_KEY_RE.lastIndex = 0;
    for (let m = INSTALL_KEY_RE.exec(line); m; m = INSTALL_KEY_RE.exec(line)) {
      const value = nonNull(m[2]);
      switch (m[1]!.toLowerCase()) {
        case 'installerpackagename':
          if (!('installer' in out)) out.installer = value;
          break;
        case 'initiatingpackagename':
        case 'installinitiatingpackagename':
          if (!('initiator' in out)) out.initiator = value;
          break;
        case 'originatingpackagename':
        case 'installoriginatingpackagename':
          if (!('originator' in out)) out.originator = value;
          break;
        case 'updateownerpackagename':
          if (!('updateOwner' in out)) out.updateOwner = value;
          break;
      }
    }
  }
  if (out.versionName === '') delete out.versionName;
  for (const k of ['installer', 'initiator', 'originator', 'updateOwner'] as const) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

/** Shell command reading one package: `dumpsys package` + its launcher label lines (filtered on the device). */
export function packageInfoCommand(pkg: string): string {
  return [
    `dumpsys package ${pkg}`,
    `echo ${PKG_LABEL_SEP}`,
    `cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg} 2>/dev/null | grep -E 'packageName=|nonLocalizedLabel='`,
  ].join('; ');
}

const LABEL_RE = /\bnonLocalizedLabel=(.*?) icon=0x[0-9a-f]+/;

/**
 * Label from `cmd package resolve-activity` (ResolveInfo.dump: "packageName=…" then "labelRes=0x0
 * nonLocalizedLabel=Pati icon=0x… banner=0x…" for the activity, then for its ApplicationInfo). The
 * activity's own label wins (the launcher shows it); lines of another package (a chooser) are ignored.
 */
export function parseLauncherLabel(text: string, pkg: string): string | undefined {
  let owner: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('packageName=')) {
      owner = line.slice('packageName='.length).trim();
      continue;
    }
    if (owner !== pkg) continue;
    const label = LABEL_RE.exec(line)?.[1]?.trim();
    // eslint-disable-next-line no-control-regex
    if (label && label !== 'null' && label.length <= 100 && !/[\u0000-\u001f]/.test(label)) return label;
  }
  return undefined;
}

/** Several `packageInfoCommand` outputs separated by `echo PKG_DUMP_SEP`, in `pkgs` order. */
export function splitPackageDumps(text: string, pkgs: string[]): Map<string, PackageDetails | undefined> {
  const chunks = text.split(new RegExp(`^${PKG_DUMP_SEP}\\s*$`, 'm'));
  const out = new Map<string, PackageDetails | undefined>();
  pkgs.forEach((pkg, i) => {
    const chunk = chunks[i];
    if (chunk === undefined) return;
    const [dump = '', labels = ''] = chunk.split(new RegExp(`^${PKG_LABEL_SEP}\\s*$`, 'm'));
    const details = parseDumpsysPackage(dump, pkg);
    const label = details ? parseLauncherLabel(labels, pkg) : undefined;
    if (details && label) details.label = label;
    out.set(pkg, details);
  });
  return out;
}

const PLAY = 'com.android.vending';
const FIREBASE = 'dev.firebase.appdistribution';
const SHELL_INSTALLERS = new Set(['com.android.shell', 'shell', 'adb', 'android']);

/** Installer package → install source (SPEC §10.2). */
export function installSourceOf(details: Pick<PackageDetails, 'installer' | 'initiator'>): {
  source: AppInstallSource;
  installer?: string;
} {
  const installer = details.installer ?? details.initiator;
  if (!installer) return { source: 'adb' };
  if (installer === PLAY) return { source: 'play', installer };
  if (installer === FIREBASE) return { source: 'firebase', installer };
  if (SHELL_INSTALLERS.has(installer)) return { source: 'adb', installer };
  return { source: 'other-store', installer };
}

export function buildTypeOf(debuggable: boolean | undefined): AppBuildType {
  return debuggable === undefined ? 'unknown' : debuggable ? 'debug' : 'release';
}

/* ───────────────────────────── tracker ───────────────────────────── */

export const DEVICE_APP_TIMING = {
  /** Periodic `pm list packages` refresh (detects installs / uninstalls). */
  listRefreshMs: 5 * 60_000,
  /** Minimum gap between refreshes triggered by an unknown package's process. */
  unknownRefreshMinMs: 15_000,
  /** Retry when the lists could not be read. */
  listRetryMs: 30_000,
  /** A `Start proc` re-reads `dumpsys package` when the cached info is older than this. */
  infoRefreshMinMs: 30_000,
  /** Batch window for `dumpsys package` calls. */
  infoBatchDelayMs: 200,
  infoBatchSize: 6,
};

export type DeviceAppInput = Parameters<HubSink['upsertDeviceApp']>[0];

/** What a crash record says about the app (fallback when `dumpsys package` has nothing). */
export interface CrashAppMeta {
  reportTs: number;
  version?: string;
  build?: string;
  debuggable?: boolean;
}

export interface DeviceAppTrackerDeps {
  adb: () => Adb | null;
  serial: string;
  deviceId: string;
  hub: Pick<HubSink, 'upsertDeviceApp' | 'removeDeviceApps'>;
  logger: Logger;
  /** Live pid → process name map (owned by the session). */
  processes: () => ReadonlyMap<number, string>;
  /** Shared clock object; the tracker fills it from `date +%z` / `persist.sys.timezone`. */
  clock: DeviceClock;
}

interface TrackedApp {
  id: string;
  pids: number[];
  processName?: string;
  info?: PackageDetails;
  infoAt: number;
  infoState: 'pending' | 'done' | 'failed';
  crash?: CrashAppMeta;
  pendingDelta: number;
  pendingActivity?: number;
  lastSent?: string;
}

export class DeviceAppTracker {
  private thirdParty?: Set<string>;
  private system = new Set<string>();
  private listedAt = 0;
  private listing?: Promise<boolean>;
  private readonly apps = new Map<string, TrackedApp>();
  private readonly infoQueue = new Set<string>();
  private infoTimer?: NodeJS.Timeout;
  private infoRunning = false;
  private unknownTimer?: NodeJS.Timeout;
  private readonly unknownPending = new Set<string>();
  private readonly checkedUnknown = new Set<string>();
  private listTimer?: NodeJS.Timeout;
  private active = false;
  private gen = 0;

  constructor(private readonly deps: DeviceAppTrackerDeps) {}

  /** Device came online: read the package lists, then publish running apps. */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const gen = ++this.gen;
    const ok = await this.refreshLists();
    if (gen !== this.gen) return;
    this.scheduleListRefresh(ok ? DEVICE_APP_TIMING.listRefreshMs : DEVICE_APP_TIMING.listRetryMs);
    this.sync(true);
  }

  /** Device went offline: stop polling; apps stay but are no longer running. */
  stop(): void {
    this.active = false;
    this.gen += 1;
    clearTimeout(this.listTimer);
    clearTimeout(this.infoTimer);
    clearTimeout(this.unknownTimer);
    this.listTimer = this.infoTimer = this.unknownTimer = undefined;
    this.infoQueue.clear();
    this.unknownPending.clear();
    for (const app of this.apps.values()) {
      if (app.infoState === 'pending') app.infoState = app.info ? 'done' : 'failed';
      if (app.pids.length) {
        app.pids = [];
        this.publish(app);
      }
    }
  }

  /**
   * Device unplugged / driver stopping: stop and forget. The apps stay in the hub (not running), like the
   * device's logs; the hub drops them itself when the device is removed. Only uninstalls remove apps here.
   */
  dispose(): void {
    this.stop();
    this.apps.clear();
  }

  /** true when the package lists are known (waits for a read in progress; false = not readable now). */
  async ready(): Promise<boolean> {
    if (this.thirdParty) return true;
    if (!this.active || !this.listing) return false;
    await this.listing;
    return !!this.thirdParty;
  }

  /** true / false once lists are known; undefined before. */
  isThirdParty(pkg: string): boolean | undefined {
    return this.thirdParty ? this.thirdParty.has(pkg) : undefined;
  }

  isSystem(pkg: string): boolean {
    return this.system.has(pkg);
  }

  /** Known DeviceApp ids (tests / diagnostics). */
  get trackedIds(): string[] {
    return [...this.apps.keys()];
  }

  /**
   * Package a process belongs to: "com.foo" / "com.foo:remote" → com.foo; a global process name such
   * as "com.google.android.gms.persistent" → its longest listed package prefix.
   */
  classifyProcess(name: string): { pkg: string; kind: 'third-party' | 'system' | 'unknown' } | undefined {
    const base = basePackage(name);
    if (!base || !this.thirdParty) return undefined;
    if (this.thirdParty.has(base)) return { pkg: base, kind: 'third-party' };
    if (this.system.has(base)) return { pkg: base, kind: 'system' };
    let prefix = base;
    for (let dot = prefix.lastIndexOf('.'); dot > 0; dot = prefix.lastIndexOf('.')) {
      prefix = prefix.slice(0, dot);
      if (prefix.indexOf('.') === -1) break;
      if (this.thirdParty.has(prefix)) return { pkg: prefix, kind: 'third-party' };
      if (this.system.has(prefix)) return { pkg: prefix, kind: 'system' };
    }
    return { pkg: base, kind: 'unknown' };
  }

  /**
   * Re-derive pids of every app from the session's process map (after `ps`). `listsAreNewer`: the lists
   * were just read after these processes existed, so names in neither list are not packages (no re-list).
   */
  sync(listsAreNewer = false): void {
    if (!this.thirdParty || !this.active) return;
    const unknown: string[] = [];
    const byPkg = this.pidIndex(undefined, unknown);
    for (const pkg of unknown) {
      if (listsAreNewer) this.checkedUnknown.add(pkg);
      else this.noteUnknown(pkg);
    }
    for (const [pkg, procs] of byPkg) {
      const app = this.ensure(pkg);
      this.applyPids(app, procs);
    }
    for (const app of this.apps.values()) {
      if (!byPkg.has(app.id) && app.pids.length) this.applyPids(app, []);
    }
  }

  /** ActivityManager "Start proc" / death seen in logcat (the session's map is already updated). */
  onProcessEvent(ev: { pid: number; name: string; event: 'started' | 'died' }): void {
    if (!this.active || !this.thirdParty) return;
    const c = this.classifyProcess(ev.name);
    if (!c) return;
    const pkg = c.pkg;
    if (c.kind !== 'third-party') {
      if (ev.event === 'started' && c.kind === 'unknown') this.noteUnknown(pkg);
      return;
    }
    const app = ev.event === 'started' ? this.ensure(pkg) : this.apps.get(pkg);
    if (!app) return;
    if (
      ev.event === 'started' &&
      app.infoState !== 'pending' &&
      Date.now() - app.infoAt > DEVICE_APP_TIMING.infoRefreshMinMs
    ) {
      // A new process after a while: the app may have been reinstalled / updated meanwhile.
      this.queueInfo(app);
    }
    this.applyPids(app, this.pidIndex(pkg).get(pkg) ?? []);
  }

  /** A crash / ANR record for `pkg` (dropbox). Creates the DeviceApp when the package is installed. */
  noteCrash(pkg: string, meta: CrashAppMeta): void {
    if (!this.thirdParty?.has(pkg)) return;
    const existed = this.apps.has(pkg);
    const app = this.ensure(pkg);
    app.crash = !app.crash || meta.reportTs >= app.crash.reportTs ? { ...app.crash, ...meta } : app.crash;
    app.pendingDelta += 1;
    app.pendingActivity = Math.max(app.pendingActivity ?? 0, meta.reportTs);
    if (!existed) this.applyPidsSilently(app, this.pidIndex(pkg).get(pkg) ?? []);
    this.publish(app);
  }

  /* ───────────── internals ───────────── */

  private pidIndex(only?: string, unknown?: string[]): Map<string, Array<{ pid: number; name: string }>> {
    const out = new Map<string, Array<{ pid: number; name: string }>>();
    if (!this.thirdParty) return out;
    for (const [pid, name] of this.deps.processes()) {
      if (only && !name.startsWith(only)) continue;
      const c = this.classifyProcess(name);
      if (!c || (only && c.pkg !== only)) continue;
      if (c.kind !== 'third-party') {
        if (c.kind === 'unknown' && unknown && !this.checkedUnknown.has(c.pkg)) unknown.push(c.pkg);
        continue;
      }
      const pkg = c.pkg;
      let list = out.get(pkg);
      if (!list) out.set(pkg, (list = []));
      list.push({ pid, name });
    }
    return out;
  }

  private ensure(pkg: string): TrackedApp {
    let app = this.apps.get(pkg);
    if (!app) {
      app = { id: pkg, pids: [], infoAt: 0, infoState: 'pending', pendingDelta: 0 };
      this.apps.set(pkg, app);
      this.queueInfo(app);
    }
    return app;
  }

  private applyPidsSilently(app: TrackedApp, procs: Array<{ pid: number; name: string }>): void {
    app.pids = procs.map((p) => p.pid).sort((a, b) => a - b);
    const main = procs.find((p) => p.name === app.id);
    app.processName = procs.length && !main ? procs[0]!.name : undefined;
  }

  private applyPids(app: TrackedApp, procs: Array<{ pid: number; name: string }>): void {
    this.applyPidsSilently(app, procs);
    this.publish(app);
  }

  private publish(app: TrackedApp): void {
    if (app.infoState === 'pending') return; // first publish waits for dumpsys package
    const input: DeviceAppInput = {
      deviceId: this.deps.deviceId,
      id: app.id,
      pids: [...app.pids],
      running: app.pids.length > 0,
    };
    if (app.processName) input.processName = app.processName;
    const info = app.info;
    if (info?.label) input.name = info.label;
    const crash = app.crash;
    const version = info?.versionName ?? crash?.version;
    const build = info?.versionCode ?? crash?.build;
    if (version) input.version = version;
    if (build) input.build = build;
    input.buildType = buildTypeOf(info?.debuggable ?? crash?.debuggable);
    if (info) {
      const src = installSourceOf(info);
      const install: DeviceApp['install'] = { source: src.source };
      if (src.installer) install.installer = src.installer;
      const first = deviceLocalToEpoch(info.firstInstallTime, this.deps.clock);
      const last = deviceLocalToEpoch(info.lastUpdateTime, this.deps.clock);
      if (first !== undefined) install.firstInstall = first;
      if (last !== undefined) install.lastUpdate = last;
      input.install = install;
    }
    const sig = JSON.stringify(input);
    if (sig === app.lastSent && app.pendingDelta === 0 && app.pendingActivity === undefined) return;
    app.lastSent = sig;
    if (app.pendingDelta) input.crashReportsDelta = app.pendingDelta;
    if (app.pendingActivity !== undefined) input.lastActivity = app.pendingActivity;
    app.pendingDelta = 0;
    app.pendingActivity = undefined;
    try {
      this.deps.hub.upsertDeviceApp(input);
    } catch (e) {
      this.deps.logger.debug(`${this.deps.serial}: upsertDeviceApp(${app.id}) failed: ${(e as Error).message}`);
    }
  }

  /* package lists */

  private refreshLists(): Promise<boolean> {
    if (this.listing) return this.listing;
    const gen = this.gen;
    this.listing = (async () => {
      const adb = this.deps.adb();
      if (!adb) return false;
      const r = await adb.shell(this.deps.serial, packageListCommand(), { timeoutMs: 20_000 });
      if (gen !== this.gen) return false;
      const lists = parsePackageLists(r.stdout);
      if (!lists) {
        this.deps.logger.debug(`${this.deps.serial}: pm list packages failed: ${r.error ?? r.stderr.trim()}`);
        return false;
      }
      if (lists.clock.tzName !== undefined) this.deps.clock.tzName = lists.clock.tzName;
      if (lists.clock.offsetMinutes !== undefined) this.deps.clock.offsetMinutes = lists.clock.offsetMinutes;
      const before = this.thirdParty;
      this.thirdParty = lists.thirdParty;
      this.system = lists.system;
      this.listedAt = Date.now();
      // checkedUnknown is kept: a name that was in neither list after a refresh is a process name, not a
      // package (an app installed later shows up in the third-party list, which is checked first).
      if (before) this.dropUninstalled();
      return true;
    })()
      .catch((e: Error) => {
        this.deps.logger.debug(`${this.deps.serial}: package list refresh failed: ${e.message}`);
        return false;
      })
      .finally(() => {
        this.listing = undefined;
      });
    return this.listing;
  }

  private dropUninstalled(): void {
    const gone: string[] = [];
    for (const app of this.apps.values()) {
      if (!this.thirdParty!.has(app.id)) gone.push(app.id);
    }
    if (!gone.length) return;
    for (const id of gone) {
      this.apps.delete(id);
      this.infoQueue.delete(id);
    }
    this.deps.hub.removeDeviceApps(this.deps.deviceId, gone);
  }

  private scheduleListRefresh(ms: number): void {
    clearTimeout(this.listTimer);
    if (!this.active) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = undefined;
      void this.refreshLists().then((ok) => {
        if (!this.active) return;
        this.sync(ok);
        this.scheduleListRefresh(ok ? DEVICE_APP_TIMING.listRefreshMs : DEVICE_APP_TIMING.listRetryMs);
      });
    }, ms);
    this.listTimer.unref?.();
  }

  /** A process of a package that is in neither list: maybe just installed → re-list (throttled). */
  private noteUnknown(pkg: string): void {
    if (this.system.has(pkg) || this.checkedUnknown.has(pkg) || !this.active) return;
    this.unknownPending.add(pkg);
    if (this.unknownTimer) return;
    const wait = Math.max(0, DEVICE_APP_TIMING.unknownRefreshMinMs - (Date.now() - this.listedAt));
    this.unknownTimer = setTimeout(() => {
      this.unknownTimer = undefined;
      const asked = [...this.unknownPending];
      this.unknownPending.clear();
      void this.refreshLists().then((ok) => {
        if (!this.active) return;
        for (const p of asked) if (ok && !this.thirdParty?.has(p)) this.checkedUnknown.add(p);
        this.sync(ok);
      });
    }, wait);
    this.unknownTimer.unref?.();
  }

  /* dumpsys package */

  private queueInfo(app: TrackedApp): void {
    if (!this.active) {
      if (app.infoState === 'pending') app.infoState = 'failed';
      return;
    }
    app.infoState = app.info ? app.infoState : 'pending';
    this.infoQueue.add(app.id);
    if (this.infoTimer || this.infoRunning) return;
    this.infoTimer = setTimeout(() => {
      this.infoTimer = undefined;
      void this.runInfo();
    }, DEVICE_APP_TIMING.infoBatchDelayMs);
    this.infoTimer.unref?.();
  }

  private async runInfo(): Promise<void> {
    if (this.infoRunning) return;
    this.infoRunning = true;
    const gen = this.gen;
    try {
      while (this.infoQueue.size && gen === this.gen) {
        const batch = [...this.infoQueue].slice(0, DEVICE_APP_TIMING.infoBatchSize);
        for (const id of batch) this.infoQueue.delete(id);
        const pkgs = batch.filter(isPackageName);
        const adb = this.deps.adb();
        let parsed = new Map<string, PackageDetails | undefined>();
        let failed = !adb;
        if (adb && pkgs.length) {
          const cmd = pkgs.map(packageInfoCommand).join(`; echo ${PKG_DUMP_SEP}; `);
          try {
            const r = await adb.shell(this.deps.serial, cmd, { timeoutMs: 20_000 + pkgs.length * 3000 });
            if (gen !== this.gen) return;
            if (!r.stdout.trim()) {
              failed = true;
              this.deps.logger.debug(`${this.deps.serial}: dumpsys package failed: ${r.error ?? r.stderr.trim()}`);
            } else parsed = splitPackageDumps(r.stdout, pkgs);
          } catch (e) {
            if (gen !== this.gen) return;
            failed = true;
            this.deps.logger.debug(`${this.deps.serial}: dumpsys package failed: ${(e as Error).message}`);
          }
        }
        const now = Date.now();
        for (const id of batch) {
          const app = this.apps.get(id);
          if (!app) continue;
          const info = parsed.get(id);
          if (info) {
            app.info = info;
            app.infoState = 'done';
          } else if (app.infoState === 'pending') app.infoState = app.info ? 'done' : 'failed';
          app.infoAt = failed ? now - DEVICE_APP_TIMING.infoRefreshMinMs / 2 : now;
          this.publish(app);
        }
      }
    } catch (e) {
      this.deps.logger.debug(`${this.deps.serial}: dumpsys package batch failed: ${(e as Error).message}`);
    } finally {
      this.infoRunning = false;
      if (this.infoQueue.size && this.active && !this.infoTimer) {
        this.infoTimer = setTimeout(() => {
          this.infoTimer = undefined;
          void this.runInfo();
        }, DEVICE_APP_TIMING.infoBatchDelayMs);
        this.infoTimer.unref?.();
      }
    }
  }
}
