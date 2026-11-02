/**
 * Physical iOS devices over usbmux: a persistent Listen connection for Attached/Detached/Paired,
 * lockdown GetValue (no session) for name/model/OS (devicectl enrichment), idevicesyslog for logs,
 * SDK tunnels to on-device ports 9752–9755, devicectl actions and a usbmux port bridge.
 * Phase 3 (SPEC §10): DeviceApps (devicectl apps/processes + syslog process names) and crash reports
 * (devicectl systemCrashLogs) for every build, with or without the SDK.
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
import { Backoff, every, Poller, serialize } from '../shared/timing';
import { probeXcodeTools, resolveIdeviceTool, type ResolvedTool } from '../tools';
import { IosAppTracker } from './appTracker';
import { crashReportEntry, type IpsReport } from './crashReport';
import { devicectl, parseDevicectlDevices, probeDevicectlCaps, type DevicectlCaps, type DevicectlRunner } from './devicectl';
import { iosDeviceActions, runIosDeviceAction } from './deviceActions';
import { devicectlAppSource } from './deviceApps';
import { DeviceCrashWatcher } from './deviceCrashes';
import { lockdownGetValues, type LockdownValues } from './lockdown';
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
  timing: IosDeviceTiming;
  /** Crash files already handled per device udid (kept across re-plugs so crashes are reported once). */
  crashSeen: (udid: string) => Set<string>;
}

/** Polling intervals of the phase-3 watchers (tests shorten them). */
export interface IosDeviceTiming {
  appsEveryMs: number;
  processesEveryMs: number;
  crashesEveryMs: number;
  /** Delay before the first crash scan (lets the first app listing finish). */
  crashStartDelayMs: number;
}

export const DEFAULT_IOS_DEVICE_TIMING: IosDeviceTiming = {
  appsEveryMs: 5 * 60_000,
  processesEveryMs: 30_000,
  crashesEveryMs: 60_000,
  crashStartDelayMs: 3000,
};

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
      firstSeen: now,
      lastSeen: now,
    };
    const hub = shared.ctx.hub;
    this.batcher = new LogBatcher((entries) => hub.pushDeviceLogs(this.id, entries), shared.logger);
    this.flutter = new FlutterErrorGrouper((e) => this.batcher.push(e));
    this.parser = new SyslogLineParser(
      (e) => this.onEntry(e),
      (connected) => {
        if (connected) this.setStreaming();
      },
    );
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
    if (this.started) this.patch({ connection: this.networkOnly ? 'wifi' : 'usb' });
  }

  removeMux(id: number): void {
    this.muxIds.delete(id);
    if (this.started && this.hasMux) this.patch({ connection: this.networkOnly ? 'wifi' : 'usb' });
  }

  private patch(patch: Partial<DeviceInfo>): void {
    if (this.disposed) return;
    this.info = { ...this.info, ...patch, lastSeen: Date.now() };
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
    });
    this.apps = apps;
    this.crashes = new DeviceCrashWatcher({
      udid: this.udid,
      devicectl: this.shared.devicectl,
      destDir: path.join(ctx.tempDir, 'crash', this.udid),
      logger,
      isInteresting: (name) => apps.isInteresting(name),
      onReport: (report, file) => this.onCrashReport(report, file),
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
    const known = report.bundleId ? this.apps?.app(report.bundleId) : undefined;
    this.batcher.push(crashReportEntry(report, { watchStart: this.watchStart, file, ...(known?.name ? { appName: known.name } : {}) }));
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
        onLine: (line) => this.parser.pushLine(line),
        // idevicesyslog writes only records and "[connected:…]" to stdout (errors go to stderr).
        onFirstOutput: () => this.setStreaming(),
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
    }
  }

  private setStreaming(): void {
    if (this.logsStatus === 'streaming' || this.disposed) return;
    const recovered = this.streamFailed;
    this.streamFailed = false;
    this.setLogs({ status: 'streaming', via: VIA });
    this.shared.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.streamStarted',
      message: recovered ? `Device log stream resumed (${VIA})` : `Device log stream started (${VIA})`,
      params: { via: VIA },
    });
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
    return runIosDeviceAction(
      {
        udid: this.udid,
        deviceId: this.id,
        label: this.info.name,
        ctx: this.shared.ctx,
        caps: this.shared.caps(),
        screenshotTool: this.shared.screenshotTool(),
        syslogAvailable: !!this.shared.syslogTool(),
        restartLogs: () => this.restartLogs(),
      },
      action,
      params,
    );
  }

  async dispose(reason: 'disconnected' | 'stopped'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
  /** Tests: a fake devicectl for the background watchers (implies devicectl is available). */
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
      timing: this.timing,
      crashSeen: (udid) => {
        let set = this.crashSeen.get(udid);
        if (!set) {
          set = new Set();
          this.crashSeen.set(udid, set);
        }
        return set;
      },
    };
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
    clearTimeout(this.retryTimer);
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
    if (!this.running || s.idevicesyslogPath === this.syslogSetting) return;
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
        existing.addMux(dev);
        return;
      }
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
    session.removeMux(ev.deviceId);
    if (!session.hasMux) {
      this.sessions.delete(udid);
      this.logger.info(`iOS device detached: ${udid}`);
      void session.dispose('disconnected');
    }
  }
}
