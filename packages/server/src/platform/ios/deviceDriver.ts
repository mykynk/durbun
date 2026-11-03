/**
 * Physical iOS devices over usbmux: a persistent Listen connection for Attached/Detached/Paired,
 * lockdown GetValue (no session) for name/model/OS (devicectl enrichment), idevicesyslog for logs,
 * SDK tunnels to on-device ports 9752–9755, devicectl actions and a usbmux port bridge.
 * Phase 3 (SPEC §10): DeviceApps (devicectl apps/processes + syslog process names) and crash reports
 * (devicectl systemCrashLogs) for every build, with or without the SDK. `readers` tells the UI whether crash
 * reports can be read (frame stats: never on iOS); reports a live crash row already showed are marked
 * `duplicateOf` (crashDedupe.ts). `iosDeviceLogScope` 'apps' (default) drops system daemons' lines that do
 * not concern a third-party app (deviceLogScope.ts); while it cannot be applied (no devicectl, app list not
 * readable) the streaming `DeviceInfo.logs` carries code 'logs.scopeNotApplied' (English detail = why) and one
 * 'logs.scopeNotApplied' line {via, reason, device} says that every line is shown; a later successful app
 * listing clears the code with a 'logs.scopeApplied' line {via, device}.
 * A device whose USB connection drops and comes back within a few seconds keeps its session (no
 * disconnected/connected lines, apps keep their state): every drop is a 'logs.connectionLost' line
 * {via, connection, graceSeconds, detail} and every return a 'logs.connectionRestored' line
 * {via, connection, seconds, detail}; a drop that outlasts the grace ends with the hub's device.disconnected.
 * Stall watchdog: idevicesyslog can stay alive but silent (a choked syslog relay, e.g. several clients on one
 * iPhone). No line for `stallMs` (30 s) while the device is attached sets logs 'error' 'logs.streamStalled'
 * with one 'logs.streamStalled' line {via, seconds, detail}, and idevicesyslog is restarted with a backoff
 * (2 s, 5 s, 15 s, then every 30 s); the first line after it is 'streaming' again with a 'logs.streamStarted'
 * ("resumed") line {via, detail}.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import {
  DEFAULT_PORTS,
  type DeviceActionId,
  type DeviceActionResult,
  type DeviceInfo,
  type DriverStatus,
  type LogStreamStatus,
  type ServerSettings,
  type ToolCheck,
} from '@durbun/protocol';
import type { DeviceDriver, DeviceLogInput, DriverContext, Logger, PortForward } from '../../types';
import { silentLogger } from '../../util/logger';
import { run, StreamProcess, type StreamExitInfo } from '../exec';
import { LogBatcher } from '../shared/batcher';
import { fail } from '../shared/files';
import { FlutterErrorGrouper } from '../shared/flutter';
import { mergeReaders, ReaderReporter, readerDetail } from '../shared/readers';
import { StallWatchdog, type StallInfo } from '../shared/stallWatchdog';
import { Backoff, every, Poller, serialize } from '../shared/timing';
import { probeXcodeTools, resolveIdeviceTool, type ResolvedTool } from '../tools';
import { IosAppTracker } from './appTracker';
import { IosCrashIndex } from './crashDedupe';
import { crashReportEntry, type IpsReport } from './crashReport';
import { devicectl, parseDevicectlDevices, probeDevicectlCaps, type DevicectlCaps, type DevicectlRunner } from './devicectl';
import { iosDeviceActions, runIosDeviceAction } from './deviceActions';
import { devicectlAppSource } from './deviceApps';
import { crashCopyDir, crashReportUrl, DeviceCrashWatcher } from './deviceCrashes';
import { IosDeviceLogFilter, iosDeviceLogScope, type IosDeviceLogScope } from './deviceLogScope';
import { lockdownGetValues, type LockdownValues } from './lockdown';
import { DEVELOPER_MODE_OFF_CODE, DEVICECTL_MISSING, IOS_FRAME_STATS_UNSUPPORTED, READ_FAILED_CODE } from './readerStates';
import { SyslogLineParser } from './syslog';
import {
  pipeTunnel,
  tunnelToDuplex,
  USBMUX_RESULT,
  UsbmuxClient,
  UsbmuxError,
  USBMUXD_SOCKET,
  type UsbmuxDevice,
  type UsbmuxEvent,
  type UsbmuxListener,
} from './usbmux';

const VIA = 'idevicesyslog';
const NO_CAPS: DevicectlCaps = { available: false, screenshot: false, screenRecord: false, openURL: false };
const UNTRUSTED = {
  code: 'device.untrusted',
  detail: 'Unlock the device and tap "Trust" on the "Trust This Computer?" prompt.',
};
const SYSLOG_MISSING = {
  code: 'logs.idevicesyslogMissing',
  detail: 'idevicesyslog was not found — install libimobiledevice (brew install libimobiledevice) or Flutter',
};

/** Static product names for common ProductTypes (devicectl provides the rest when available). */
const PRODUCT_NAMES: Record<string, string> = {
  'iPhone14,7': 'iPhone 14',
  'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15',
  'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,3': 'iPhone 16',
  'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,5': 'iPhone 16e',
};

interface TunnelState {
  active?: Duplex;
  connecting: boolean;
  nextTryAt: number;
}

interface DriverShared {
  ctx: DriverContext;
  logger: Logger;
  client: UsbmuxClient;
  syslogTool: () => ResolvedTool | null;
  screenshotTool: () => ResolvedTool | null;
  caps: () => DevicectlCaps;
  /** Background devicectl calls (apps, processes, crash reports), one at a time. */
  devicectl: DevicectlRunner;
  /** Tests: the fake devicectl for device actions too (default: `xcrun devicectl`, not queued). */
  actionDevicectl?: DevicectlRunner;
  timing: IosDeviceTiming;
  /** Crash files already handled per device udid (kept across re-plugs so crashes are reported once). */
  crashSeen: (udid: string) => Set<string>;
  /** Live crash rows of every device of the driver (de-duplicates crash reports). */
  crashIndex: IosCrashIndex;
  /** Current `iosDeviceLogScope` (read per line: a settings change applies without restarting the stream). */
  logScope: () => IosDeviceLogScope;
}

/** Polling intervals of the phase-3 watchers (tests shorten them). */
export interface IosDeviceTiming {
  appsEveryMs: number;
  processesEveryMs: number;
  crashesEveryMs: number;
  /** Delay before the first crash scan (lets the first app listing finish). */
  crashStartDelayMs: number;
  /** A device whose last usbmux connection went away is kept this long in case it comes right back. */
  detachGraceMs: number;
  /** The same, while the device's connection keeps dropping (it came back within the grace lately). */
  unstableDetachGraceMs: number;
  /** No idevicesyslog line for this long while the device is attached is a stalled stream (0: never). */
  stallMs: number;
  /** Delays before each idevicesyslog restart of one stall (the last one repeats). */
  stallRestartDelaysMs: readonly number[];
}

export const DEFAULT_IOS_DEVICE_TIMING: IosDeviceTiming = {
  appsEveryMs: 5 * 60_000,
  processesEveryMs: 30_000,
  crashesEveryMs: 60_000,
  crashStartDelayMs: 3000,
  detachGraceMs: 3000,
  unstableDetachGraceMs: 10_000,
  stallMs: 30_000,
  stallRestartDelaysMs: [2000, 5000, 15_000, 30_000],
};

/** A connection that came back within the grace this recently counts as unstable (longer grace). */
const UNSTABLE_WINDOW_MS = 2 * 60_000;
/** Why `iosDeviceLogScope` 'apps' cannot be applied (params.reason of 'logs.scopeNotApplied'). */
type ScopeNotAppliedReason = 'devicectlMissing' | 'appListFailed';
const SCOPE_NOT_APPLIED = 'logs.scopeNotApplied';
const SCOPE_WHY: Record<ScopeNotAppliedReason, string> = {
  devicectlMissing: 'telling app lines from system lines needs Xcode 15 or newer (devicectl)',
  appListFailed: 'the installed apps could not be read with devicectl, so app lines cannot be told from system lines',
};
const STALL_RELAY_NOTE =
  'several idevicesyslog clients on one iPhone (Xcode, Console, another Dürbün or a terminal) can choke its syslog relay, so restarts slow down (2 s, 5 s, 15 s, then every 30 s) — close the other clients if it stays silent';

const seconds1 = (ms: number) => Math.round(ms / 100) / 10;

class IosDeviceSession {
  readonly id: string;
  private info: DeviceInfo;
  private readonly muxIds = new Map<number, 'USB' | 'Network'>();
  private trusted = false;
  private disposed = false;
  private started = false;
  private syslog?: StreamProcess;
  private readonly parser: SyslogLineParser;
  private readonly flutter: FlutterErrorGrouper;
  private readonly batcher: LogBatcher;
  private logsStatus: LogStreamStatus = 'starting';
  private streamFailed = false;
  private pairingProblem = false;
  private stopPairWatch?: () => void;
  private pairingRetry?: NodeJS.Timeout;
  private readonly tunnels = new Map<number, TunnelState>();
  private readonly seenPids = new Map<number, string>();
  /** Crash reports older than this are from before Dürbün watched the device (previousLaunch). */
  private readonly watchStart = Date.now();
  private apps?: IosAppTracker;
  private crashes?: DeviceCrashWatcher;
  /** From `devicectl list devices` ('enabled' / 'disabled'), once known. */
  private developerMode?: string;
  private readonly crashReader = new ReaderReporter((state) => this.patch({ readers: { crashReports: state } }));
  private readonly logFilter: IosDeviceLogFilter;
  /** Crash reports are delivered one after another (each waits for the first app listing). */
  private crashQueue: Promise<void> = Promise.resolve();
  /** When the last usbmux connection went away (the driver holds the session for a grace period). */
  private detachedAt?: number;
  /** The log was streaming when the last connection went away (its lines from the gap are missing). */
  private streamCut = false;
  /** Connection type of the drop the session is waiting out, once its 'logs.connectionLost' line is out. */
  private droppedVia?: 'USB' | 'Network';
  private dropSaid = false;
  /** Reasons a 'logs.scopeNotApplied' line was pushed for (once each per session). */
  private readonly scopeSaid = new Set<ScopeNotAppliedReason>();
  /** What the last scope line told the user (undefined: nothing, or that the scope applies). */
  private scopeTold?: ScopeNotAppliedReason;
  /** idevicesyslog alive but silent (choked syslog relay): restart it with a backoff. */
  private readonly watchdog: StallWatchdog;

  constructor(
    private readonly shared: DriverShared,
    readonly udid: string,
    first: UsbmuxDevice,
  ) {
    this.id = `ios:${udid}`;
    this.muxIds.set(first.deviceId, first.connectionType);
    const now = Date.now();
    this.info = {
      id: this.id,
      platform: 'ios',
      kind: 'physical',
      name: 'iOS device',
      manufacturer: 'Apple',
      serial: udid,
      connection: first.connectionType === 'Network' ? 'wifi' : 'usb',
      state: 'online',
      logs: { status: 'starting', via: VIA },
      actions: [],
      readers: { frameStats: { ...IOS_FRAME_STATS_UNSUPPORTED } },
      firstSeen: now,
      lastSeen: now,
    };
    const hub = shared.ctx.hub;
    this.batcher = new LogBatcher((entries) => hub.pushDeviceLogs(this.id, entries), shared.logger);
    this.flutter = new FlutterErrorGrouper((e) => this.batcher.push(e));
    this.logFilter = new IosDeviceLogFilter(() => this.apps, shared.logScope);
    this.parser = new SyslogLineParser(
      (e) => this.onEntry(e),
      (connected) => {
        // While stalled only real lines count ("[connected:…]" also comes from a choked relay).
        if (connected && !this.watchdog.stalled) this.setStreaming();
      },
    );
    this.watchdog = new StallWatchdog({
      stallMs: shared.timing.stallMs,
      restartDelaysMs: shared.timing.stallRestartDelaysMs,
      active: () => this.started && this.trusted && !this.disposed && this.hasMux && !!this.syslog?.running,
      onStall: (stall) => this.onStall(stall),
      restart: () => {
        if (this.disposed || !this.trusted || !this.hasMux || !this.shared.syslogTool()) return;
        this.startSyslog();
      },
      onRecovered: ({ silentMs }) => {
        this.streamFailed = true;
        this.setStreaming(`lines flow again after ${Math.round(silentMs / 1000)} s without any; lines from that time are missing`);
      },
    });
  }

  /** Preferred usbmux id (USB over Network). */
  get muxId(): number | undefined {
    let net: number | undefined;
    for (const [id, type] of this.muxIds) {
      if (type === 'USB') return id;
      net = id;
    }
    return net;
  }

  get hasMux(): boolean {
    return this.muxIds.size > 0;
  }

  get networkOnly(): boolean {
    return this.muxIds.size > 0 && [...this.muxIds.values()].every((t) => t === 'Network');
  }

  addMux(dev: UsbmuxDevice): void {
    this.muxIds.set(dev.deviceId, dev.connectionType);
    this.syncConnection();
  }

  /**
   * A usbmux connection went away. The last one: say so at once with its own line — every drop, however
   * often it happens — the driver then waits `graceMs` for the device to come back (resume) before it ends
   * the session (device.disconnected).
   */
  removeMux(id: number, graceMs: number): void {
    const type = this.muxIds.get(id);
    this.muxIds.delete(id);
    if (this.hasMux) {
      this.syncConnection();
      return;
    }
    if (this.detachedAt !== undefined) return;
    this.detachedAt = Date.now();
    this.droppedVia = type;
    if (!this.started || this.disposed) return;
    this.dropSaid = true;
    this.streamCut = this.logsStatus === 'streaming' || this.watchdog.stalled;
    const connection = type === 'Network' ? 'wifi' : 'usb';
    const graceSeconds = seconds1(graceMs);
    const detail =
      `the ${type === 'Network' ? 'Wi-Fi' : 'USB'} connection dropped` +
      (this.streamCut ? '; log lines are missing until the device is back' : '') +
      `; it is shown disconnected if it is not back within ${graceSeconds} s`;
    this.shared.ctx.hub.pushSystemLog(this.id, {
      level: 'warn',
      code: 'logs.connectionLost',
      message: `Device connection lost (${detail})`,
      params: { via: VIA, connection, graceSeconds, detail },
    });
  }

  /** Only a real change is sent: a Wi-Fi entry coming and going next to USB is no device update. */
  private syncConnection(): void {
    const connection = this.networkOnly ? 'wifi' : 'usb';
    if (this.started && connection !== this.info.connection) this.patch({ connection });
  }

  /**
   * The device came back within the grace period (a USB drop or re-enumeration): keep everything, restart
   * the log stream if it ended, and close the drop with a 'logs.connectionRestored' line (its length).
   */
  resume(): void {
    const since = this.detachedAt;
    this.detachedAt = undefined;
    if (this.disposed || since === undefined) return;
    const gapMs = Date.now() - since;
    this.shared.logger.info(`iOS device ${this.udid} came back after ${gapMs} ms (connection dropped)`);
    // idevicesyslog usually waits for the device itself; if it ended meanwhile, start it again.
    if (this.trusted && this.shared.syslogTool()) this.startSyslog();
    if (!this.dropSaid) return;
    this.dropSaid = false;
    const seconds = seconds1(gapMs);
    const connection = this.networkOnly ? 'wifi' : 'usb';
    const cut = this.streamCut;
    this.streamCut = false;
    const detail =
      `the ${this.droppedVia === 'Network' ? 'Wi-Fi' : 'USB'} connection was gone for ${seconds.toFixed(1)} s` +
      (cut ? '; log lines from that moment are missing' : '');
    this.shared.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.connectionRestored',
      message: `Device connection back (${detail})`,
      params: { via: VIA, connection, seconds, detail },
    });
  }

  /**
   * Why `iosDeviceLogScope` 'apps' cannot be applied right now — no devicectl, or the app list could not be
   * read — so every line is shown. Undefined: it applies, the scope is 'all', or the first listing is pending.
   */
  private scopeProblem(): ScopeNotAppliedReason | undefined {
    if (this.shared.logScope() !== 'apps') return undefined;
    if (!this.shared.caps().available) return 'devicectlMissing';
    if (this.apps?.listingFinished && !this.apps.knowsApps) return 'appListFailed';
    return undefined;
  }

  /** The streaming log state, with the scope problem (the UI's "system lines are hidden" note checks it). */
  private streamingLogs(reason = this.scopeProblem()): DeviceInfo['logs'] {
    if (!reason) return { status: 'streaming', via: VIA };
    return { status: 'streaming', via: VIA, code: SCOPE_NOT_APPLIED, detail: `All log lines are shown: ${SCOPE_WHY[reason]}` };
  }

  /**
   * The effective log scope changed (settings, an app listing): keep the streaming `DeviceInfo.logs` code
   * right, and say it in the log — 'logs.scopeNotApplied' once per reason and session, 'logs.scopeApplied'
   * when the app list could be read after all.
   */
  noteScope(): void {
    if (this.disposed || !this.started || this.logsStatus !== 'streaming') return;
    const reason = this.scopeProblem();
    const logs = this.streamingLogs(reason);
    if (logs.code !== this.info.logs.code || logs.detail !== this.info.logs.detail) this.setLogs(logs);
    this.announceScope(reason);
  }

  private announceScope(reason: ScopeNotAppliedReason | undefined): void {
    const device = this.info.name;
    if (reason) {
      this.scopeTold = reason;
      if (this.scopeSaid.has(reason)) return;
      this.scopeSaid.add(reason);
      this.shared.ctx.hub.pushSystemLog(this.id, {
        level: 'warn',
        code: SCOPE_NOT_APPLIED,
        message: `All log lines of ${device} are shown: ${SCOPE_WHY[reason]}`,
        params: { via: VIA, reason, device },
      });
      return;
    }
    if (this.scopeTold !== 'appListFailed' || this.shared.logScope() !== 'apps' || !this.apps?.knowsApps) return;
    this.scopeTold = undefined;
    this.shared.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.scopeApplied',
      message: `The installed apps of ${device} could be read: system processes' lines are left out from now on`,
      params: { via: VIA, device },
    });
  }

  private patch(patch: Partial<DeviceInfo>): void {
    if (this.disposed) return;
    // `readers` merges per reader id here as in the hub; the hub gets only the readers in this patch.
    const readers = mergeReaders(this.info.readers, patch.readers);
    this.info = { ...this.info, ...patch, ...(readers ? { readers } : {}), lastSeen: Date.now() };
    if (this.started) this.shared.ctx.hub.patchDevice(this.id, { ...patch, lastSeen: this.info.lastSeen });
  }

  private setLogs(logs: DeviceInfo['logs']): void {
    this.logsStatus = logs.status;
    this.patch({ logs });
  }

  private actions(): DeviceActionId[] {
    return iosDeviceActions({
      trusted: this.trusted,
      caps: this.shared.caps(),
      screenshotTool: !!this.shared.screenshotTool(),
      syslog: !!this.shared.syslogTool(),
    });
  }

  async start(): Promise<void> {
    const { client, logger } = this.shared;
    const muxId = this.muxId;
    let values: LockdownValues | undefined;
    if (muxId !== undefined) {
      values = await lockdownGetValues(client, muxId, 2500).catch((e: Error) => {
        logger.debug(`lockdown GetValue ${this.udid}: ${e.message}`);
        return undefined;
      });
    }
    this.trusted = !!(await client.readPairRecord(this.udid).catch(() => null));
    if (this.disposed) return;
    if (values) this.applyLockdown(values);
    if (!this.shared.caps().available) this.crashReader.unavailable(DEVICECTL_MISSING.code, DEVICECTL_MISSING.detail);
    const syslogTool = this.shared.syslogTool();
    this.info = {
      ...this.info,
      state: this.trusted ? 'online' : 'unauthorized',
      ...(this.trusted ? {} : { stateCode: UNTRUSTED.code, stateDetail: UNTRUSTED.detail }),
      logs: !syslogTool
        ? { status: 'unavailable', via: VIA, ...SYSLOG_MISSING }
        : this.trusted
          ? { status: 'starting', via: VIA }
          : { status: 'unavailable', via: VIA, ...UNTRUSTED },
      actions: this.actions(),
    };
    this.logsStatus = this.info.logs.status;
    this.parser.setDeviceName(this.info.name);
    this.started = true;
    this.shared.ctx.hub.upsertDevice({ ...this.info });
    if (this.trusted) {
      if (syslogTool) this.startSyslog();
      this.startAppWatch();
    } else {
      this.watchPairing();
    }
    void this.enrichFromDevicectl();
  }

  /** DeviceApps + crash reports through devicectl (needs Xcode 15+ and a trusted device). */
  private startAppWatch(): void {
    if (this.disposed || this.apps || !this.shared.caps().available) return;
    const { ctx, logger, timing } = this.shared;
    const apps = new IosAppTracker({
      deviceId: this.id,
      hub: ctx.hub,
      getDeviceApps: () => ctx.getDeviceApps(),
      source: devicectlAppSource(this.udid, this.shared.devicectl),
      logger,
      installedEveryMs: timing.appsEveryMs,
      runningEveryMs: timing.processesEveryMs,
      retryMs: Math.min(60_000, timing.appsEveryMs),
      triggerGapMs: Math.min(10_000, timing.processesEveryMs),
      // A failed (or, later, a successful) listing changes whether the log scope can be applied.
      onListed: () => this.noteScope(),
    });
    this.apps = apps;
    this.crashes = new DeviceCrashWatcher({
      udid: this.udid,
      devicectl: this.shared.devicectl,
      destDir: crashCopyDir(ctx.tempDir, this.udid),
      logger,
      isInteresting: (name) => apps.isInteresting(name),
      onReport: (report, file) => this.onCrashReport(report, file),
      onStatus: (s) => {
        if (s.ok) this.crashReader.ok();
        else this.crashReader.unavailable(this.developerMode === 'disabled' ? DEVELOPER_MODE_OFF_CODE : READ_FAILED_CODE, readerDetail(s.error));
      },
      intervalMs: timing.crashesEveryMs,
      seen: this.shared.crashSeen(this.udid),
    });
    apps.start();
    // Let the first app listing finish so crash files can be filtered by app name.
    const t = setTimeout(() => this.crashes?.start(), timing.crashStartDelayMs);
    t.unref?.();
  }

  private onCrashReport(report: IpsReport, file: string): void {
    if (this.disposed) return;
    this.crashQueue = this.crashQueue
      .then(() => this.deliverCrash(report, file))
      .catch((e: Error) => this.shared.logger.debug(`crash report ${file}: ${e.message}`));
  }

  private async deliverCrash(report: IpsReport, file: string): Promise<void> {
    // An app extension's report (com.x.app.Widget) belongs to its installed host app (com.x.app). No wait
    // for the first app listing is needed here (unlike simulators): every devicectl call goes through one
    // serialize() queue, the tracker's first call is queued before the crash watcher starts, and its
    // --include-all-apps call is queued before any report copy (a copy needs a files listing first).
    if (this.disposed) return;
    const host = this.apps?.reportApp(report);
    const known = host ? this.apps?.app(host) : undefined;
    const duplicateOf = this.shared.crashIndex.claim(this.id, report);
    this.batcher.push(
      crashReportEntry(report, {
        watchStart: this.watchStart,
        file,
        // The copy lies in <tempDir>/crash/<udid>/ (crashCopyDir) under a safe name (localCrashName).
        reportUrl: crashReportUrl(path.basename(path.dirname(file)), path.basename(file)),
        ...(duplicateOf !== undefined ? { duplicateOf } : {}),
        ...(known?.name ? { appName: known.name } : {}),
        ...(host ? { hostBundleId: host } : {}),
      }),
    );
    this.apps?.onCrash(report);
  }

  private applyLockdown(v: LockdownValues): void {
    const name = typeof v.DeviceName === 'string' && v.DeviceName.trim() ? v.DeviceName.trim() : undefined;
    const productType = typeof v.ProductType === 'string' ? v.ProductType : undefined;
    const model = productType ? (PRODUCT_NAMES[productType] ?? productType) : undefined;
    const os = typeof v.ProductVersion === 'string' ? v.ProductVersion : undefined;
    this.info = {
      ...this.info,
      ...(name ? { name } : model ? { name: model } : {}),
      ...(model ? { model } : {}),
      ...(os ? { osVersion: os } : {}),
    };
  }

  private async enrichFromDevicectl(): Promise<void> {
    if (!this.shared.caps().available) return;
    const r = await this.shared.devicectl(['list', 'devices'], 30_000);
    if (!r.ok || this.disposed) return;
    const d = parseDevicectlDevices(r.json).find((x) => x.udid === this.udid);
    if (!d) return;
    if (d.developerMode) this.developerMode = d.developerMode;
    const patch: Partial<DeviceInfo> = {};
    if (d.marketingName && d.marketingName !== this.info.model) patch.model = d.marketingName;
    if (d.osVersion && !this.info.osVersion) patch.osVersion = d.osVersion;
    if (d.name && this.info.name === 'iOS device') {
      patch.name = d.name;
      this.parser.setDeviceName(d.name);
    }
    if (Object.keys(patch).length) this.patch(patch);
  }

  /** Untrusted: poll the pair record (the Listen 'Paired' event also triggers onPaired). */
  private watchPairing(): void {
    if (this.stopPairWatch) return;
    this.stopPairWatch = every(3000, async () => {
      const rec = await this.shared.client.readPairRecord(this.udid).catch(() => null);
      if (rec) this.onPaired();
    });
  }

  onPaired(): void {
    if (this.disposed || (this.trusted && !this.pairingProblem)) return;
    this.stopPairWatch?.();
    this.stopPairWatch = undefined;
    clearTimeout(this.pairingRetry);
    this.pairingRetry = undefined;
    this.trusted = true;
    this.pairingProblem = false;
    const syslogTool = this.shared.syslogTool();
    this.patch({
      state: 'online',
      stateCode: undefined,
      stateDetail: undefined,
      actions: this.actions(),
      logs: syslogTool ? { status: 'starting', via: VIA } : { status: 'unavailable', via: VIA, ...SYSLOG_MISSING },
    });
    this.logsStatus = syslogTool ? 'starting' : 'unavailable';
    if (syslogTool) this.startSyslog();
    this.startAppWatch();
  }

  /* ───────────── logs ───────────── */

  private onEntry(entry: DeviceLogInput): void {
    if (entry.pid && entry.process && this.seenPids.get(entry.pid) !== entry.process) {
      this.seenPids.set(entry.pid, entry.process);
      if (this.seenPids.size > 5000) this.seenPids.clear();
      this.shared.ctx.hub.setProcess({ deviceId: this.id, pid: entry.pid, name: entry.process, event: 'seen', ts: entry.ts });
    }
    this.apps?.onLog(entry);
    if (!this.logFilter.admit(entry)) return;
    this.flutter.push(entry);
  }

  private startSyslog(): void {
    if (!this.syslog) {
      this.syslog = new StreamProcess({
        name: `idevicesyslog ${this.udid}`,
        logger: this.shared.logger,
        spec: () => {
          const tool = this.shared.syslogTool();
          if (!tool) return null;
          const args = ['-u', this.udid, '--no-colors'];
          if (this.networkOnly) args.push('-n');
          return { cmd: tool.path, args, env: tool.env };
        },
        onLine: (line) => {
          // Records and their continuation lines feed the stall watchdog ("[connected:…]" status lines do not).
          if (line.charCodeAt(0) !== 0x5b) this.watchdog.seen();
          this.parser.pushLine(line);
        },
        // idevicesyslog writes only records and "[connected:…]" to stdout (errors go to stderr).
        onFirstOutput: () => {
          if (!this.watchdog.stalled) this.setStreaming();
        },
        onExit: (info) => this.onSyslogExit(info),
        shouldRestart: (info) => {
          if (this.disposed || !this.hasMux) return false;
          return !isPairingError(info.stderrTail);
        },
        backoffInitialMs: 1000,
        backoffMaxMs: 15_000,
        stableAfterMs: 30_000,
      });
    }
    if (!this.syslog.start()) {
      this.setLogs({ status: 'unavailable', via: VIA, ...SYSLOG_MISSING });
      return;
    }
    this.watchdog.start();
  }

  /** `detail`: why it resumes (after a stall). */
  private setStreaming(detail?: string): void {
    if (this.logsStatus === 'streaming' || this.disposed) return;
    const recovered = this.streamFailed;
    this.streamFailed = false;
    const reason = this.scopeProblem();
    this.setLogs(this.streamingLogs(reason));
    const what = recovered ? 'resumed' : 'started';
    this.shared.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.streamStarted',
      message: `Device log stream ${what} (${VIA}${detail ? `; ${detail}` : ''})`,
      params: { via: VIA, ...(detail ? { detail } : {}) },
    });
    this.announceScope(reason);
  }

  /**
   * idevicesyslog runs but sent nothing for `stallMs` while the device is attached: show it, stop the silent
   * process (it holds one of the device's syslog relay connections) and let the watchdog restart it.
   */
  private async onStall(stall: StallInfo): Promise<void> {
    if (this.disposed) return;
    const seconds = Math.round(stall.silentMs / 1000);
    const detail =
      `no log line from the device for ${seconds} s although it is connected (idevicesyslog runs but sends nothing); ` +
      `restarting idevicesyslog in ${seconds1(stall.restartInMs)} s (attempt ${stall.attempt}); ${STALL_RELAY_NOTE}`;
    this.shared.logger.warn(`iOS device ${this.udid}: ${detail}`);
    this.streamFailed = true;
    this.setLogs({ status: 'error', via: VIA, code: 'logs.streamStalled', detail });
    if (stall.attempt === 1) {
      this.shared.ctx.hub.pushSystemLog(this.id, {
        level: 'warn',
        code: 'logs.streamStalled',
        message: `Device log stream stalled (${detail})`,
        params: { via: VIA, seconds, detail },
      });
    }
    await this.syslog?.stop();
  }

  private onSyslogExit(info: StreamExitInfo): void {
    this.parser.flush();
    this.flutter.flushAll();
    this.batcher.flush();
    if (info.stopped || this.disposed || !this.hasMux) return;
    if (isPairingError(info.stderrTail)) {
      // Not trusted (yet): wait for the Paired event instead of hammering lockdownd.
      this.trusted = false;
      this.pairingProblem = true;
      this.patch({
        state: 'unauthorized',
        stateCode: UNTRUSTED.code,
        stateDetail: UNTRUSTED.detail,
        actions: [],
        logs: { status: 'unavailable', via: VIA, ...UNTRUSTED },
      });
      this.logsStatus = 'unavailable';
      void this.shared.client
        .readPairRecord(this.udid)
        .catch(() => null)
        .then((record) => {
          if (this.disposed || this.trusted) return;
          if (!record) {
            this.watchPairing();
            return;
          }
          // The Mac has a pair record but the device refused it (e.g. trust was reset on the
          // device): wait for usbmuxd's Paired event, retrying slowly so we never spam prompts.
          clearTimeout(this.pairingRetry);
          this.pairingRetry = setTimeout(() => this.onPaired(), 30_000);
          this.pairingRetry.unref?.();
        });
      return;
    }
    if (!info.willRestart) return;
    const why = info.error ?? (info.signal ? `signal ${info.signal}` : `exit code ${info.code ?? '?'}`);
    const detail = `idevicesyslog exited (${why})${info.stderrTail ? `: ${info.stderrTail}` : ''} — restarting`;
    this.setLogs({ status: 'error', via: VIA, code: 'logs.processExited', detail });
    if (!this.streamFailed) {
      this.streamFailed = true;
      this.shared.ctx.hub.pushSystemLog(this.id, {
        level: 'warn',
        code: 'logs.streamError',
        message: `Device log stream interrupted (${detail})`,
        params: { via: VIA, detail },
      });
    }
  }

  async restartLogs(reason = 'restart requested'): Promise<void> {
    if (this.disposed || !this.trusted) return;
    if (!this.shared.syslogTool()) {
      await this.syslog?.stop();
      this.setLogs({ status: 'unavailable', via: VIA, ...SYSLOG_MISSING });
      this.patch({ actions: this.actions() });
      return;
    }
    this.shared.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.streamStopped',
      message: `Device log stream stopped (${reason})`,
      params: { via: VIA },
    });
    await this.syslog?.stop();
    this.parser.flush();
    this.flutter.flushAll();
    this.batcher.flush();
    // Restarted on purpose: a stall episode is over, silence is measured from the new start.
    this.watchdog.reset();
    this.setLogs({ status: 'starting', via: VIA });
    this.patch({ actions: this.actions() });
    this.startSyslog();
  }

  /* ───────────── SDK tunnels ───────────── */

  tryTunnels(): void {
    const muxId = this.muxId;
    if (this.disposed || !this.started || muxId === undefined) return;
    const now = Date.now();
    for (let port = DEFAULT_PORTS.deviceSdkFirst; port <= DEFAULT_PORTS.deviceSdkLast; port += 1) {
      let st = this.tunnels.get(port);
      if (!st) {
        st = { connecting: false, nextTryAt: 0 };
        this.tunnels.set(port, st);
      }
      if (st.active || st.connecting || now < st.nextTryAt) continue;
      const state = st;
      state.connecting = true;
      this.shared.client
        .connect(muxId, port, 3000)
        .then(
          (tunnel) => {
            if (this.disposed) {
              tunnel.socket.destroy();
              return;
            }
            const stream = tunnelToDuplex(tunnel);
            const openedAt = Date.now();
            state.active = stream;
            stream.once('close', () => {
              state.active = undefined;
              const silent = stream.bytesIn() === 0 && Date.now() - openedAt < 3000;
              state.nextTryAt = Date.now() + (silent ? 10_000 : 500);
            });
            try {
              this.shared.ctx.sdk.attachStream(stream, {
                transport: 'usbmux',
                deviceId: this.id,
                remote: `usbmux:${this.udid}:${port}`,
              });
              this.shared.logger.debug(`usbmux tunnel to ${this.udid}:${port} handed to the SDK layer`);
            } catch (e) {
              this.shared.logger.warn(`attachStream failed for ${this.udid}:${port}: ${(e as Error).message}`);
              stream.destroy();
            }
          },
          (err: Error) => {
            const refused = err instanceof UsbmuxError && err.code === USBMUX_RESULT.CONNREFUSED;
            // Nothing listening is the normal case: retry on the next 2 s tick.
            state.nextTryAt = Date.now() + (refused ? 0 : 5000);
          },
        )
        .finally(() => {
          state.connecting = false;
        });
    }
  }

  /* ───────────── actions ───────────── */

  async runAction(action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
    if (!this.trusted) return fail(`${this.info.name} does not trust this computer yet`, 'device.untrusted');
    if (!this.actions().includes(action)) {
      return fail(`"${action}" is not available for ${this.info.name}`, 'action.unsupported');
    }
    const result = await runIosDeviceAction(
      {
        udid: this.udid,
        deviceId: this.id,
        label: this.info.name,
        ctx: this.shared.ctx,
        caps: this.shared.caps(),
        screenshotTool: this.shared.screenshotTool(),
        syslogAvailable: !!this.shared.syslogTool(),
        restartLogs: () => this.restartLogs(),
        ...(this.shared.actionDevicectl ? { devicectl: this.shared.actionDevicectl } : {}),
      },
      action,
      params,
    );
    // The app list changed: the new app's lines and pids are known now, not at the next periodic listing.
    if (result.ok && (action === 'app-install' || action === 'app-uninstall')) this.apps?.relistNow();
    return result;
  }

  async dispose(reason: 'disconnected' | 'stopped'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watchdog.stop();
    this.stopPairWatch?.();
    clearTimeout(this.pairingRetry);
    for (const st of this.tunnels.values()) st.active?.destroy();
    this.tunnels.clear();
    // Stop the devicectl watchers now (apps → not running) but do not hold the device state back for a
    // devicectl call that is still running (it can take up to its timeout on an unplugged device).
    const watchers = Promise.all([this.crashes?.stop(), this.apps?.stop()]);
    await this.syslog?.stop();
    this.parser.flush();
    this.flutter.flushAll();
    this.batcher.dispose();
    if (this.started) {
      if (reason === 'disconnected') this.shared.ctx.hub.markDeviceDisconnected(this.id);
      else this.shared.ctx.hub.markDeviceDisconnected(this.id, 'Dürbün stopped watching iOS devices', 'device.driverStopped');
    }
    await watchers;
  }
}

function isPairingError(stderr: string): boolean {
  return /trust dialog|not paired|pairing|PasswordProtected|Invalid HostID|lockdownd.*(-18|-17|-21)|UserDeniedPairing/i.test(
    stderr,
  );
}

export interface IosDeviceDriverOptions {
  /** usbmuxd socket (tests use a fake). */
  socketPath?: string;
  /** Probe/use `xcrun devicectl` (default true; tests turn it off). */
  useDevicectl?: boolean;
  /** Tests: a fake devicectl for the background watchers and device actions (implies devicectl is available). */
  devicectl?: DevicectlRunner;
  /** Tests: shorter polling intervals. */
  timing?: Partial<IosDeviceTiming>;
}

export class IosDeviceDriver implements DeviceDriver {
  readonly id = 'ios-device' as const;
  private ctx?: DriverContext;
  private logger: Logger = silentLogger;
  private readonly client: UsbmuxClient;
  private listener?: UsbmuxListener;
  private running = false;
  private listenProblem?: string;
  private readonly listenBackoff = new Backoff(1000, 30_000);
  private retryTimer?: NodeJS.Timeout;
  private tunnelPoller?: Poller;
  private readonly sessions = new Map<string, IosDeviceSession>();
  private readonly muxToUdid = new Map<number, string>();
  private syslogTool: ResolvedTool | null = null;
  private screenshotTool: ResolvedTool | null = null;
  private caps: DevicectlCaps = NO_CAPS;
  private unsubSettings?: () => void;
  private syslogSetting?: string;
  private shared?: DriverShared;

  private readonly useDevicectl: boolean;
  private readonly fakeDevicectl?: DevicectlRunner;
  private readonly timing: IosDeviceTiming;
  private readonly crashSeen = new Map<string, Set<string>>();
  private unsubLogs?: () => void;
  private logScope: IosDeviceLogScope = 'apps';
  /** udid → pending dispose of a session whose last usbmux connection went away (grace period). */
  private readonly detaching = new Map<string, NodeJS.Timeout>();
  /**
   * udid → when its connection last proved unstable: it came back within the grace, or a new session started
   * soon after the last one ended (gaps longer than the normal grace).
   */
  private readonly lastFlapAt = new Map<string, number>();
  /** udid → when its last session ended (unplugged for longer than the grace). */
  private readonly lastGoneAt = new Map<string, number>();

  constructor(opts: IosDeviceDriverOptions = {}) {
    this.client = new UsbmuxClient({ socketPath: opts.socketPath ?? USBMUXD_SOCKET });
    this.useDevicectl = opts.useDevicectl ?? true;
    this.fakeDevicectl = opts.devicectl;
    this.timing = { ...DEFAULT_IOS_DEVICE_TIMING, ...opts.timing };
  }

  async start(ctx: DriverContext): Promise<void> {
    if (this.running) return;
    this.ctx = ctx;
    this.logger = ctx.logger.child('ios-device');
    this.running = true;
    this.resolveTools(ctx.settings());
    this.logScope = iosDeviceLogScope(ctx.settings());
    if (this.fakeDevicectl) {
      this.caps = { available: true, screenshot: false, screenRecord: false, openURL: false };
    } else if (this.useDevicectl) {
      const xcode = await probeXcodeTools();
      this.caps = xcode.devicectl ? await probeDevicectlCaps() : NO_CAPS;
    }
    this.shared = {
      ctx,
      logger: this.logger,
      client: this.client,
      syslogTool: () => this.syslogTool,
      screenshotTool: () => this.screenshotTool,
      caps: () => this.caps,
      devicectl: serialize(this.fakeDevicectl ?? ((args: string[], timeoutMs?: number) => devicectl(args, timeoutMs))),
      ...(this.fakeDevicectl ? { actionDevicectl: this.fakeDevicectl } : {}),
      timing: this.timing,
      crashSeen: (udid) => {
        let set = this.crashSeen.get(udid);
        if (!set) {
          set = new Set();
          this.crashSeen.set(udid, set);
        }
        return set;
      },
      crashIndex: new IosCrashIndex({ owns: (id) => this.owns(id), getApps: () => ctx.getApps() }),
      logScope: () => this.logScope,
    };
    const crashIndex = this.shared.crashIndex;
    this.unsubLogs = ctx.onLogs((entries) => crashIndex.add(entries));
    this.unsubSettings = ctx.onSettings((s) => void this.onSettings(s));
    await this.connectListen();
    this.tunnelPoller = new Poller(
      async () => {
        for (const s of this.sessions.values()) s.tryTunnels();
      },
      2000,
      this.logger,
      'usbmux tunnels',
    );
    this.tunnelPoller.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubSettings?.();
    this.unsubSettings = undefined;
    this.unsubLogs?.();
    this.unsubLogs = undefined;
    clearTimeout(this.retryTimer);
    this.clearDetaching();
    this.listener?.close();
    this.listener = undefined;
    await this.tunnelPoller?.stop();
    this.tunnelPoller = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.muxToUdid.clear();
    await Promise.all(sessions.map((s) => s.dispose('stopped')));
  }

  status(): DriverStatus {
    const base = { id: this.id, active: this.running };
    if (this.listenProblem) {
      return { ...base, available: false, detail: this.listenProblem, code: 'logs.usbmuxdUnavailable' };
    }
    const n = this.sessions.size;
    const devices = `${n} device${n === 1 ? '' : 's'}`;
    if (!this.syslogTool) {
      return { ...base, available: true, detail: `${devices} · ${SYSLOG_MISSING.detail}`, code: SYSLOG_MISSING.code };
    }
    return { ...base, available: true, detail: devices };
  }

  async checks(): Promise<ToolCheck[]> {
    const settings = this.ctx?.settings() ?? { idevicesyslogPath: undefined };
    const socketPath = this.client.socketPath;
    const checks: ToolCheck[] = [];
    let usbmuxOk = false;
    let usbmuxDetail = '';
    try {
      const devices = await this.client.listDevices(3000);
      usbmuxOk = true;
      usbmuxDetail = `${devices.length} device(s) attached`;
    } catch (e) {
      usbmuxDetail = (e as Error).message;
    }
    checks.push({
      id: 'usbmuxd',
      label: 'usbmuxd (iOS USB connection)',
      status: usbmuxOk ? 'ok' : fs.existsSync(socketPath) ? 'error' : 'missing',
      path: socketPath,
      detail: usbmuxDetail,
      ...(usbmuxOk ? {} : { fix: process.platform === 'darwin' ? 'sudo killall -HUP usbmuxd' : 'Install and start usbmuxd' }),
    });
    const syslog = resolveIdeviceTool('idevicesyslog', settings);
    if (!syslog) {
      checks.push({
        id: 'idevicesyslog',
        label: 'idevicesyslog (iOS device logs)',
        status: 'missing',
        detail: SYSLOG_MISSING.detail,
        fix: 'brew install libimobiledevice',
        docsUrl: 'https://libimobiledevice.org',
      });
    } else {
      const v = await run(syslog.path, ['--version'], { timeoutMs: 10_000, env: syslog.env });
      const version = v.ok ? v.stdout.trim().replace(/^idevicesyslog\s*/, '') : undefined;
      checks.push({
        id: 'idevicesyslog',
        label: 'idevicesyslog (iOS device logs)',
        status: v.ok ? 'ok' : 'error',
        ...(version ? { version } : {}),
        path: syslog.path,
        detail: v.ok ? (syslog.detail ?? `from ${syslog.source}`) : `idevicesyslog failed to run: ${v.error ?? v.stderr.trim().slice(0, 200)}`,
        ...(v.ok ? {} : { fix: 'brew install libimobiledevice' }),
      });
    }
    const shot = resolveIdeviceTool('idevicescreenshot', settings);
    const caps = this.useDevicectl ? await probeDevicectlCaps(true) : NO_CAPS;
    checks.push({
      id: 'devicectl',
      label: 'Xcode devicectl (iOS device actions)',
      status: caps.available ? 'ok' : 'warn',
      ...(caps.version ? { version: caps.version } : {}),
      detail: caps.available
        ? `screenshot: ${caps.screenshot ? 'yes' : 'no'} · screen recording: ${caps.screenRecord ? 'yes' : 'no'}`
        : 'Install Xcode 15 or newer to see installed apps and crash reports and to launch/stop/install apps on iOS devices',
      ...(caps.available ? {} : { fix: 'Install Xcode from the App Store' }),
    });
    checks.push({
      id: 'idevicescreenshot',
      label: 'idevicescreenshot (iOS screenshots, fallback)',
      status: shot ? 'ok' : caps.screenshot ? 'ok' : 'warn',
      ...(shot ? { path: shot.path } : {}),
      detail: shot ? (shot.detail ?? `from ${shot.source}`) : caps.screenshot ? 'not needed (devicectl captures screenshots)' : 'not found',
      ...(shot || caps.screenshot ? {} : { fix: 'brew install libimobiledevice' }),
    });
    return checks;
  }

  owns(deviceId: string): boolean {
    return deviceId.startsWith('ios:');
  }

  async runAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
    const s = this.sessions.get(deviceId.slice('ios:'.length));
    if (!s) return fail(`iOS device ${deviceId} is not connected`, 'action.deviceOffline');
    try {
      return await s.runAction(action, params ?? {});
    } catch (e) {
      return fail(`${action} failed: ${(e as Error).message}`);
    }
  }

  /** PlatformServices.forwardToDevice for ios:<udid>: a local server bridged through usbmux Connect. */
  async forward(deviceId: string, devicePort: number): Promise<PortForward> {
    const udid = deviceId.slice('ios:'.length);
    if (!this.sessions.has(udid)) throw new Error(`iOS device ${udid} is not connected`);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      client.pause();
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      client.on('error', () => client.destroy());
      const muxId = this.sessions.get(udid)?.muxId;
      if (muxId === undefined) {
        client.destroy();
        return;
      }
      this.client.connect(muxId, devicePort, 5000).then(
        (tunnel) => {
          if (client.destroyed) {
            tunnel.socket.destroy();
            return;
          }
          sockets.add(tunnel.socket);
          tunnel.socket.once('close', () => sockets.delete(tunnel.socket));
          pipeTunnel(tunnel, client);
        },
        (err: Error) => {
          this.logger.debug(`forward ${udid}:${devicePort}: ${err.message}`);
          client.destroy();
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (e) => this.logger.warn(`forward server: ${e.message}`));
    server.unref();
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    let disposed = false;
    return {
      host: '127.0.0.1',
      port,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        for (const s of sockets) s.destroy();
        sockets.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /* ───────────── internals ───────────── */

  private resolveTools(settings: ServerSettings): void {
    this.syslogSetting = settings.idevicesyslogPath;
    this.syslogTool = resolveIdeviceTool('idevicesyslog', settings);
    this.screenshotTool = resolveIdeviceTool('idevicescreenshot', settings);
    if (!this.syslogTool) this.logger.info('idevicesyslog not found; iOS device logs are unavailable');
    else this.logger.debug(`using idevicesyslog at ${this.syslogTool.path} (${this.syslogTool.source})`);
  }

  private async onSettings(s: ServerSettings): Promise<void> {
    if (!this.running) return;
    // Read per line by every session: no stream restart needed.
    this.logScope = iosDeviceLogScope(s);
    for (const session of this.sessions.values()) session.noteScope();
    if (s.idevicesyslogPath === this.syslogSetting) return;
    const before = this.syslogTool?.path;
    this.resolveTools(s);
    if (this.syslogTool?.path === before) return;
    await Promise.all([...this.sessions.values()].map((x) => x.restartLogs('idevicesyslog path changed')));
  }

  private async connectListen(): Promise<void> {
    if (!this.running) return;
    try {
      this.listener = await this.client.listen(
        (ev) => this.onEvent(ev),
        (err) => this.onListenClosed(err),
      );
      this.listenProblem = undefined;
      this.listenBackoff.reset();
    } catch (e) {
      this.listenProblem = (e as Error).message;
      this.logger.debug(`usbmux Listen failed: ${this.listenProblem}`);
      this.scheduleListenRetry();
    }
  }

  private scheduleListenRetry(): void {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connectListen(), this.listenBackoff.next());
    this.retryTimer.unref?.();
  }

  private onListenClosed(err?: Error): void {
    this.listener = undefined;
    if (!this.running) return;
    this.listenProblem = err?.message ?? 'usbmuxd connection closed';
    this.clearDetaching();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.muxToUdid.clear();
    void Promise.all(sessions.map((s) => s.dispose('disconnected')));
    this.scheduleListenRetry();
  }

  private onEvent(ev: UsbmuxEvent): void {
    if (!this.running || !this.shared) return;
    if (ev.type === 'attached') {
      const dev = ev.device;
      this.muxToUdid.set(dev.deviceId, dev.udid);
      const existing = this.sessions.get(dev.udid);
      if (existing) {
        const cameBack = !existing.hasMux;
        existing.addMux(dev);
        if (cameBack) {
          clearTimeout(this.detaching.get(dev.udid));
          this.detaching.delete(dev.udid);
          this.lastFlapAt.set(dev.udid, Date.now());
          existing.resume();
        }
        return;
      }
      const gone = this.lastGoneAt.get(dev.udid);
      if (gone !== undefined && Date.now() - gone <= UNSTABLE_WINDOW_MS) this.lastFlapAt.set(dev.udid, Date.now());
      const session = new IosDeviceSession(this.shared, dev.udid, dev);
      this.sessions.set(dev.udid, session);
      this.logger.info(`iOS device attached: ${dev.udid} (${dev.connectionType})`);
      void session.start().catch((e: Error) => this.logger.warn(`iOS device ${dev.udid} setup failed: ${e.message}`));
      return;
    }
    const udid = this.muxToUdid.get(ev.deviceId);
    if (!udid) return;
    const session = this.sessions.get(udid);
    if (ev.type === 'paired') {
      session?.onPaired();
      return;
    }
    this.muxToUdid.delete(ev.deviceId);
    if (!session) return;
    const grace = this.detachGrace(udid);
    session.removeMux(ev.deviceId, grace);
    if (!session.hasMux && !this.detaching.has(udid)) this.scheduleDetach(udid, session, grace);
  }

  /** How long a device whose last connection went away is held (longer while its connection keeps dropping). */
  private detachGrace(udid: string): number {
    const flapped = this.lastFlapAt.get(udid);
    const unstable = flapped !== undefined && Date.now() - flapped <= UNSTABLE_WINDOW_MS;
    return unstable ? this.timing.unstableDetachGraceMs : this.timing.detachGraceMs;
  }

  /**
   * USB drops and re-enumerations (loose cables, hubs) make usbmuxd report Detached and Attached within
   * seconds: the session is kept for a grace period, so the hub sees no disconnect / connect, the sidebar
   * keeps the device's apps, and only a real unplug ends the session.
   */
  private scheduleDetach(udid: string, session: IosDeviceSession, grace: number): void {
    const timer = setTimeout(() => {
      this.detaching.delete(udid);
      if (this.sessions.get(udid) !== session || session.hasMux) return;
      this.sessions.delete(udid);
      this.lastGoneAt.set(udid, Date.now());
      this.logger.info(`iOS device detached: ${udid}`);
      void session.dispose('disconnected');
    }, grace);
    timer.unref?.();
    this.detaching.set(udid, timer);
  }

  private clearDetaching(): void {
    for (const t of this.detaching.values()) clearTimeout(t);
    this.detaching.clear();
  }
}
