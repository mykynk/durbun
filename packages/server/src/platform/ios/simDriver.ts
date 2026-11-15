/**
 * iOS simulator driver: polls `xcrun simctl list devices booted -j` every 3 s while a simulator runs. With none
 * booted it only looks at the Mac's process names (one `ps`, no simctl call: simctl keeps CoreSimulatorService
 * busy): a simulator's launchd (`launchd_sim`, one per booted simulator) → list now; Simulator.app open → look
 * again in 3 s; neither → in 10 s. `recheck()` lists at once. Per booted simulator it
 * streams `log stream --style ndjson` (restarted when the scope/level settings change) and offers
 * simctl actions + host-ps metrics. SPEC §10: DeviceApps (simctl listapps + host ps) and
 * crash reports (~/Library/Logs/DiagnosticReports, matched to the simulator's UDID, copied to
 * <tempDir>/crash/<udid>/ for download); `readers` says whether the report folder can be read.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceActionId,
  DeviceActionResult,
  DeviceInfo,
  DriverStatus,
  LogStreamStatus,
  ServerSettings,
  ToolCheck,
} from '@durbun/protocol';
import type { DeviceDriver, DeviceLogInput, DriverContext, Logger, PortForward } from '../../types';
import { silentLogger } from '../../util/logger';
import { run, StreamProcess, type RunOptions, type RunResult, type StreamExitInfo } from '../exec';
import { LogBatcher } from '../shared/batcher';
import { fail } from '../shared/files';
import { FlutterErrorGrouper } from '../shared/flutter';
import { mergeReaders, ReaderReporter, readerDetail } from '../shared/readers';
import { ScreenRecorder } from '../shared/screenRecord';
import { Poller, sleep } from '../shared/timing';
import { probeXcodeTools, type XcodeTools } from '../tools';
import { IosAppTracker, type AppSource } from './appTracker';
import { IosCrashIndex } from './crashDedupe';
import { crashReportEntry, type IpsReport } from './crashReport';
import { crashCopyDir, crashReportUrl, localCrashName } from './deviceCrashes';
import { HostProcessMetrics } from './hostMetrics';
import { IOS_FRAME_STATS_UNSUPPORTED, READ_FAILED_CODE } from './readerStates';
import { simAppSource } from './simApps';
import { SimCrashWatcher } from './simCrashes';
import { runSimAction, SIM_ACTIONS } from './simActions';
import { parseBootedDevices, simctl, XCRUN, type BootedSimulator } from './simctl';
import { latestVmAnnouncements, parseSimLogLine, SIM_VM_HISTORY, simLogStreamArgs, simVmHistoryArgs } from './simlog';

const POLL_MS = 3000;
/** Nothing booted: how often to look for a booted simulator's launchd. */
const IDLE_POLL_MS = 10_000;
const VIA = 'simctl log stream';
/** Longest a crash report waits for the first app listing (host apps of app extensions). */
const APPS_WAIT_MS = 10_000;

export interface SimDeps {
  ctx: DriverContext;
  logger: Logger;
  isBooted: (udid: string) => boolean;
  /** Fresh `simctl list devices booted` check (also nudges the poller). */
  checkBooted: (udid: string) => Promise<boolean>;
  crashes: SimCrashWatcher;
  /** Live crash rows of every simulator (de-duplicates crash reports). */
  crashIndex: IosCrashIndex;
  appSource: (udid: string) => AppSource;
  timing: IosSimTiming;
  /** Tests: a fake simctl for the actions. */
  simctl?: SimctlRunner;
}

/** Polling intervals of the phase-3 watchers (tests shorten them). */
export interface IosSimTiming {
  appsEveryMs: number;
  processesEveryMs: number;
}

export const DEFAULT_IOS_SIM_TIMING: IosSimTiming = { appsEveryMs: 3 * 60_000, processesEveryMs: 5000 };

export type SimctlRunner = (args: string[], opts?: RunOptions) => Promise<RunResult<string>>;

/**
 * Simulator processes on the Mac: 'booted' (a simulator's launchd runs), 'app' (Simulator.app is open, a
 * simulator may boot any moment), 'none', or undefined when it cannot be told (then simctl is asked).
 */
export type BootedProbe = () => Promise<'booted' | 'app' | 'none' | undefined>;

/** Process names (`ps -Aco comm=`) → what runs. */
export function simulatorProcesses(psOutput: string): 'booted' | 'app' | 'none' {
  const names = new Set(psOutput.split('\n').map((l) => l.trim()));
  if (names.has('launchd_sim')) return 'booted';
  return names.has('Simulator') ? 'app' : 'none';
}

/** One `ps` call (no simctl, no CoreSimulatorService). */
export const simulatorProcessProbe: BootedProbe = async () => {
  const r = await run('/bin/ps', ['-Aco', 'comm='], { timeoutMs: 5000 });
  return r.ok && r.stdout.trim() ? simulatorProcesses(r.stdout) : undefined;
};

export interface IosSimDriverOptions {
  /** Tests: a fake `xcrun simctl` (device list, booted checks and actions). */
  simctl?: SimctlRunner;
  /** Tests: a fake "is any simulator booted" probe (default: pgrep launchd_sim). */
  bootedProbe?: BootedProbe;
  /** Tests: a fake Xcode probe. */
  xcodeTools?: (force?: boolean) => Promise<XcodeTools>;
  /** Tests: shorter intervals. */
  pollMs?: { active: number; idle: number };
  /** Folders with macOS crash reports (default ~/Library/Logs/DiagnosticReports + Retired). */
  diagnosticReportDirs?: string[];
  /** Tests: fake app listing / process source per simulator. */
  appSource?: (udid: string) => AppSource;
  timing?: Partial<IosSimTiming>;
  crashScanMs?: number;
}

/** One booted simulator (exported for tests). */
/** The command that fixes a known Xcode set-up problem from its error text (license, first-launch components). */
export function xcodeFix(problem: string): string | undefined {
  if (/license/i.test(problem)) return 'sudo xcodebuild -license accept';
  if (/runFirstLaunch|out of date|additional (required )?components/i.test(problem)) return 'xcodebuild -runFirstLaunch';
  return undefined;
}

export class SimulatorSession {
  readonly id: string;
  private info: DeviceInfo;
  private readonly batcher: LogBatcher;
  private readonly flutter: FlutterErrorGrouper;
  private stream?: StreamProcess;
  private logsStatus: LogStreamStatus = 'starting';
  private streamFailed = false;
  private disposed = false;
  private readonly seenPids = new Map<number, string>();
  private readonly metrics = new Map<string, HostProcessMetrics>();
  private readonly watchStart = Date.now();
  private readonly apps: IosAppTracker;
  private unsubCrashes?: () => void;
  private readonly crashReader = new ReaderReporter((state) => this.patch({ readers: { crashReports: state } }));
  private readonly recorder = new ScreenRecorder((recording) => this.patch({ recording }));
  /** Crash reports are copied one after another, so their entries keep the report order. */
  private crashQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: SimDeps,
    readonly sim: BootedSimulator,
  ) {
    this.id = `ios-sim:${sim.udid}`;
    const now = Date.now();
    this.info = {
      id: this.id,
      platform: sim.platform,
      kind: 'simulator',
      name: sim.name,
      ...(sim.model ? { model: sim.model } : {}),
      manufacturer: 'Apple',
      ...(sim.osVersion ? { osVersion: sim.osVersion } : {}),
      serial: sim.udid,
      connection: 'local',
      state: 'online',
      logs: { status: 'starting', via: VIA },
      actions: [...SIM_ACTIONS],
      readers: { frameStats: { ...IOS_FRAME_STATS_UNSUPPORTED } },
      firstSeen: now,
      lastSeen: now,
    };
    const hub = deps.ctx.hub;
    this.batcher = new LogBatcher((entries) => hub.pushDeviceLogs(this.id, entries), deps.logger);
    this.flutter = new FlutterErrorGrouper((e) => this.batcher.push(e));
    this.apps = new IosAppTracker({
      deviceId: this.id,
      hub,
      getDeviceApps: () => deps.ctx.getDeviceApps(),
      source: deps.appSource(sim.udid),
      logger: deps.logger,
      installedEveryMs: deps.timing.appsEveryMs,
      runningEveryMs: deps.timing.processesEveryMs,
      retryMs: Math.min(30_000, deps.timing.appsEveryMs),
      triggerGapMs: Math.min(2000, deps.timing.processesEveryMs),
      // `log stream` is limited to user apps by default: an unknown process name means a new install
      // (read on every line: the scope setting can change while the simulator runs).
      relistOnUnknownProcess: () => deps.ctx.settings().iosSimLogScope !== 'all',
    });
  }

  get label(): string {
    return this.info.name;
  }

  start(): void {
    this.deps.ctx.hub.upsertDevice({ ...this.info });
    void this.startStreamAfterHistory();
    this.apps.start();
    this.unsubCrashes = this.deps.crashes.register(
      this.sim.udid,
      (report, file) => this.onCrashReport(report, file),
      (s) => (s.ok ? this.crashReader.ok() : this.crashReader.unavailable(READ_FAILED_CODE, readerDetail(s.error))),
    );
  }

  private onCrashReport(report: IpsReport, file: string): void {
    if (this.disposed) return;
    this.crashQueue = this.crashQueue
      .then(() => this.deliverCrash(report, file))
      .catch((e: Error) => this.deps.logger.debug(`crash report ${file}: ${e.message}`));
  }

  /** Copy the report next to the device crash copies (stable for download), then push its entry. */
  private async deliverCrash(report: IpsReport, file: string): Promise<void> {
    const dir = crashCopyDir(this.deps.ctx.tempDir, this.sim.udid);
    const name = localCrashName(file);
    let copy: string | undefined = path.join(dir, name);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(file, copy);
    } catch (e) {
      this.deps.logger.debug(`copying ${file}: ${(e as Error).message}`);
      copy = undefined;
    }
    // An app extension's report (com.x.app.Widget) belongs to its installed host app (com.x.app): the
    // first app listing must be in (reports of the last days arrive right at boot).
    await this.apps.whenListed(APPS_WAIT_MS);
    if (this.disposed) return;
    const host = this.apps.reportApp(report);
    const known = host ? this.apps.app(host) : undefined;
    const duplicateOf = this.deps.crashIndex.claim(this.id, report);
    this.batcher.push(
      crashReportEntry(report, {
        watchStart: this.watchStart,
        // Without a copy the entry still names the original report (no download link).
        file: copy ?? file,
        ...(copy ? { reportUrl: crashReportUrl(path.basename(dir), name) } : {}),
        ...(duplicateOf !== undefined ? { duplicateOf } : {}),
        ...(known?.name ? { appName: known.name } : {}),
        ...(host ? { hostBundleId: host } : {}),
      }),
    );
    this.apps.onCrash(report);
  }

  private patch(patch: Partial<DeviceInfo>): void {
    if (this.disposed) return;
    // `readers` merges per reader id here as in the hub; the hub gets only the readers in this patch.
    const readers = mergeReaders(this.info.readers, patch.readers);
    this.info = { ...this.info, ...patch, ...(readers ? { readers } : {}), lastSeen: Date.now() };
    this.deps.ctx.hub.patchDevice(this.id, { ...patch, lastSeen: this.info.lastSeen });
  }

  private setLogs(logs: DeviceInfo['logs']): void {
    this.logsStatus = logs.status;
    this.patch({ logs });
  }

  private onEntry(entry: DeviceLogInput): void {
    if (entry.pid && entry.process && this.seenPids.get(entry.pid) !== entry.process) {
      this.seenPids.set(entry.pid, entry.process);
      if (this.seenPids.size > 5000) this.seenPids.clear();
      this.deps.ctx.hub.setProcess({ deviceId: this.id, pid: entry.pid, name: entry.process, event: 'seen', ts: entry.ts });
    }
    this.apps.onLog(entry);
    this.flutter.push(entry);
  }

  /**
   * A Flutter debug app launched before Dürbün announced its VM service before the stream existed: read the
   * last minutes' announcements once (so it attaches by itself), then stream. The stream waits for that at
   * most SIM_VM_HISTORY.waitMs.
   */
  private async startStreamAfterHistory(): Promise<void> {
    const history = this.readVmHistory();
    await Promise.race([history, sleep(SIM_VM_HISTORY.waitMs)]);
    if (this.disposed) return;
    this.startStream();
  }

  private async readVmHistory(): Promise<void> {
    const r = await run(XCRUN, ['simctl', 'spawn', this.sim.udid, ...simVmHistoryArgs()], {
      timeoutMs: SIM_VM_HISTORY.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (this.disposed || !r.stdout) return;
    const found = latestVmAnnouncements(r.stdout);
    if (found.length === 0) return;
    for (const entry of found) this.onEntry(entry);
    this.batcher.flush();
  }

  private startStream(): void {
    if (!this.stream) {
      this.stream = new StreamProcess({
        name: `log stream ${this.sim.udid}`,
        logger: this.deps.logger,
        spec: () => ({
          cmd: XCRUN,
          args: ['simctl', 'spawn', this.sim.udid, ...simLogStreamArgs(this.deps.ctx.settings())],
        }),
        onLine: (line) => {
          const entry = parseSimLogLine(line);
          if (entry) this.onEntry(entry);
        },
        onFirstOutput: () => this.setStreaming(),
        onExit: (info) => this.onStreamExit(info),
        shouldRestart: () => !this.disposed && this.deps.isBooted(this.sim.udid),
        backoffInitialMs: 1000,
        backoffMaxMs: 15_000,
        stableAfterMs: 30_000,
      });
    }
    this.stream.start();
  }

  private setStreaming(): void {
    if (this.logsStatus === 'streaming' || this.disposed) return;
    const recovered = this.streamFailed;
    this.streamFailed = false;
    this.setLogs({ status: 'streaming', via: VIA });
    this.deps.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.streamStarted',
      message: recovered ? `Device log stream resumed (${VIA})` : `Device log stream started (${VIA})`,
      params: { via: VIA },
    });
  }

  private onStreamExit(info: StreamExitInfo): void {
    this.flutter.flushAll();
    this.batcher.flush();
    if (info.stopped || this.disposed || !this.deps.isBooted(this.sim.udid)) return;
    if (!info.willRestart) return;
    // `log stream` also ends when the simulator shuts down: only report a stream error when it
    // is still booted (otherwise the poller marks the device disconnected in a moment).
    void this.deps.checkBooted(this.sim.udid).then((booted) => {
      if (booted && !this.disposed) this.reportStreamError(info);
    });
  }

  private reportStreamError(info: StreamExitInfo): void {
    const why = info.error ?? (info.signal ? `signal ${info.signal}` : `exit code ${info.code ?? '?'}`);
    const detail = `log stream exited (${why})${info.stderrTail ? `: ${info.stderrTail}` : ''} — restarting`;
    this.setLogs({ status: 'error', via: VIA, code: 'logs.processExited', detail });
    if (!this.streamFailed) {
      this.streamFailed = true;
      this.deps.ctx.hub.pushSystemLog(this.id, {
        level: 'warn',
        code: 'logs.streamError',
        message: `Device log stream interrupted (${detail})`,
        params: { via: VIA, detail },
      });
    }
  }

  async restartLogs(reason = 'restart requested'): Promise<void> {
    if (this.disposed) return;
    this.deps.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.streamStopped',
      message: `Device log stream stopped (${reason})`,
      params: { via: VIA },
    });
    await this.stream?.stop();
    if (this.disposed) return; // shut down or gone while it stopped: a new `log stream` would be orphaned
    this.flutter.flushAll();
    this.batcher.flush();
    this.setLogs({ status: 'starting', via: VIA });
    this.startStream();
  }

  /** Name/runtime changes reported by simctl. */
  refresh(sim: BootedSimulator): void {
    if (sim.name !== this.info.name) this.patch({ name: sim.name });
  }

  async runAction(action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
    if (!SIM_ACTIONS.includes(action)) return fail(`"${action}" is not supported on iOS simulators`, 'action.unsupported');
    return runSimAction(
      {
        udid: this.sim.udid,
        deviceId: this.id,
        label: this.info.name,
        ctx: this.deps.ctx,
        restartLogs: () => this.restartLogs(),
        recorder: this.recorder,
        ...(this.deps.simctl ? { simctl: this.deps.simctl } : {}),
      },
      action,
      params,
    );
  }

  /** The Mac woke from sleep: start `log stream` again when it ended (or waits in a backoff). */
  afterWake(): void {
    if (this.disposed || !this.stream?.active || this.stream.running) return;
    this.startStream();
  }

  watchMetrics(target: { pid?: number; processName?: string }, enabled: boolean): void {
    const key = `${target.pid ?? ''}|${target.processName ?? ''}`;
    const existing = this.metrics.get(key);
    if (!enabled) {
      existing?.stop();
      this.metrics.delete(key);
      return;
    }
    if (existing || (!target.pid && !target.processName)) return;
    const w = new HostProcessMetrics(
      { udid: this.sim.udid, deviceId: this.id, hub: this.deps.ctx.hub, logger: this.deps.logger },
      target,
    );
    this.metrics.set(key, w);
    w.start();
  }

  async dispose(reason: 'shutdown' | 'stopped'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.recorder.dispose();
    for (const m of this.metrics.values()) m.stop();
    this.metrics.clear();
    this.unsubCrashes?.();
    // Marks the apps not running at once; an in-flight simctl/ps call is awaited after the device state.
    const apps = this.apps.stop();
    await this.stream?.stop();
    this.flutter.flushAll();
    this.batcher.dispose();
    if (reason === 'shutdown') {
      this.deps.ctx.hub.markDeviceDisconnected(this.id, 'Simulator shut down', 'device.simulatorShutdown');
    } else {
      this.deps.ctx.hub.markDeviceDisconnected(this.id, 'Dürbün stopped watching simulators', 'device.driverStopped');
    }
    await apps;
  }
}

export class IosSimDriver implements DeviceDriver {
  readonly id = 'ios-sim' as const;
  private ctx?: DriverContext;
  private logger: Logger = silentLogger;
  private xcode?: XcodeTools;
  private poller?: Poller;
  private running = false;
  private readonly sessions = new Map<string, SimulatorSession>();
  private booted = new Set<string>();
  private unsubSettings?: () => void;
  private logKey = '';
  private pollProblem?: string;
  private polls = 0;
  private readonly crashes: SimCrashWatcher;
  private crashIndex?: IosCrashIndex;
  private unsubLogs?: () => void;
  private readonly timing: IosSimTiming;
  private readonly appSource: (udid: string) => AppSource;
  private readonly simctl: SimctlRunner;
  private readonly probeBooted: BootedProbe;
  private readonly probeXcode: (force?: boolean) => Promise<XcodeTools>;
  private readonly intervals: { active: number; idle: number };
  /** List with simctl on the next poll even when the probe says nothing is booted. */
  private listNow = true;
  /** simctl list calls so far (tests). */
  listCalls = 0;

  constructor(opts: IosSimDriverOptions = {}) {
    // Delegates to the driver logger, which only exists after start().
    const logger: Logger = {
      debug: (m, ...a) => this.logger.debug(m, ...a),
      info: (m, ...a) => this.logger.info(m, ...a),
      warn: (m, ...a) => this.logger.warn(m, ...a),
      error: (m, ...a) => this.logger.error(m, ...a),
      child: (scope) => this.logger.child(scope),
    };
    this.crashes = new SimCrashWatcher({
      logger,
      ...(opts.diagnosticReportDirs ? { dirs: opts.diagnosticReportDirs } : {}),
      ...(opts.crashScanMs ? { intervalMs: opts.crashScanMs } : {}),
    });
    this.timing = { ...DEFAULT_IOS_SIM_TIMING, ...opts.timing };
    this.appSource = opts.appSource ?? simAppSource;
    this.simctl = opts.simctl ?? simctl;
    this.probeBooted = opts.bootedProbe ?? simulatorProcessProbe;
    this.probeXcode = opts.xcodeTools ?? probeXcodeTools;
    this.intervals = opts.pollMs ?? { active: POLL_MS, idle: IDLE_POLL_MS };
  }

  /** List simulators now (a simulator may have booted): no waiting for the next idle check. */
  recheck(): void {
    this.listNow = true;
    this.poller?.trigger();
  }

  /** The Mac woke from sleep: list simulators now and restart log streams that ended. Never throws. */
  resume(): void {
    if (!this.running) return;
    try {
      this.recheck();
      for (const s of this.sessions.values()) s.afterWake();
    } catch (e) {
      this.logger.debug(`ios-sim resume failed: ${(e as Error).message}`);
    }
  }

  async start(ctx: DriverContext): Promise<void> {
    if (this.running) return;
    this.ctx = ctx;
    this.logger = ctx.logger.child('ios-sim');
    this.running = true;
    this.logKey = logSettingsKey(ctx.settings());
    this.xcode = await this.probeXcode();
    if (!this.xcode.simctl) this.logger.info(`simctl unavailable: ${this.xcode.detail ?? 'unknown reason'}`);
    const crashIndex = new IosCrashIndex({ owns: (id) => this.owns(id), getApps: () => ctx.getApps() });
    this.crashIndex = crashIndex;
    this.unsubLogs = ctx.onLogs((entries) => crashIndex.add(entries));
    this.unsubSettings = ctx.onSettings((s) => void this.onSettings(s));
    this.listNow = true;
    this.poller = new Poller(() => this.poll(), this.intervals.active, this.logger, 'simctl list');
    this.poller.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubSettings?.();
    this.unsubSettings = undefined;
    this.unsubLogs?.();
    this.unsubLogs = undefined;
    await this.poller?.stop();
    this.poller = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.booted.clear();
    await Promise.all(sessions.map((s) => s.dispose('stopped')));
    await this.crashes.stop();
  }

  status(): DriverStatus {
    const base = { id: this.id, active: this.running };
    if (!this.xcode?.simctl) {
      return {
        ...base,
        available: false,
        detail: this.xcode?.detail ?? 'Xcode (simctl) is not available',
        code: 'logs.simctlMissing',
      };
    }
    if (this.pollProblem) return { ...base, available: true, detail: this.pollProblem, code: 'driver.simctlError' };
    const n = this.sessions.size;
    return { ...base, available: true, detail: `${n} booted simulator${n === 1 ? '' : 's'}` };
  }

  async checks(): Promise<ToolCheck[]> {
    const x = await this.probeXcode(true);
    if (!x.simctl) {
      return [
        {
          id: 'simctl',
          label: 'Xcode simctl (iOS simulators)',
          status: 'missing',
          detail: x.detail ?? 'Xcode is not installed or not selected',
          fix: 'Install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app',
          docsUrl: 'https://developer.apple.com/xcode/',
        },
      ];
    }
    const v = await run('/usr/bin/xcodebuild', ['-version'], { timeoutMs: 15_000 });
    const version = v.ok ? v.stdout.split('\n')[0]?.trim() : undefined;
    // `simctl list` failing (Xcode license not accepted, first-launch components missing…) is the real problem.
    const problem = this.pollProblem ?? (v.ok ? undefined : `xcodebuild -version failed: ${(v.stderr || v.stdout).trim().split('\n')[0] ?? ''}`);
    const fix = problem ? xcodeFix(problem) : undefined;
    return [
      {
        id: 'simctl',
        label: 'Xcode simctl (iOS simulators)',
        status: problem ? 'error' : 'ok',
        ...(version ? { version } : {}),
        ...(x.developerDir ? { path: x.developerDir } : {}),
        detail: problem ?? `${this.sessions.size} booted simulator(s)`,
        ...(fix ? { fix } : {}),
      },
    ];
  }

  owns(deviceId: string): boolean {
    return deviceId.startsWith('ios-sim:');
  }

  async runAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
    const s = this.sessions.get(deviceId.slice('ios-sim:'.length));
    if (!s) return fail(`Simulator ${deviceId} is not booted`, 'action.deviceOffline');
    try {
      return await s.runAction(action, params ?? {});
    } catch (e) {
      return fail(`${action} failed: ${(e as Error).message}`);
    }
  }

  watchMetrics(deviceId: string, target: { pid?: number; processName?: string }, enabled: boolean): void {
    this.sessions.get(deviceId.slice('ios-sim:'.length))?.watchMetrics(target, enabled);
  }

  /** Simulators share the host network stack: device ports are local ports. */
  async forward(_deviceId: string, devicePort: number): Promise<PortForward> {
    return { host: '127.0.0.1', port: devicePort, dispose: async () => {} };
  }

  private async onSettings(s: ServerSettings): Promise<void> {
    const key = logSettingsKey(s);
    if (key === this.logKey) return;
    this.logKey = key;
    await Promise.all([...this.sessions.values()].map((x) => x.restartLogs('log settings changed')));
  }

  private async checkBooted(udid: string): Promise<boolean> {
    const r = await this.simctl(['list', 'devices', 'booted', '-j'], { timeoutMs: 15_000 });
    if (!r.ok) return this.booted.has(udid);
    const booted = new Set(parseBootedDevices(r.stdout).map((s) => s.udid));
    if (!booted.has(udid)) {
      this.booted.delete(udid);
      this.poller?.trigger();
      return false;
    }
    return true;
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.ctx) return;
    this.polls += 1;
    if (!this.xcode?.simctl) {
      if (this.polls % 20 === 0) this.xcode = await this.probeXcode(true);
      if (!this.xcode?.simctl) return;
    }
    // Nothing booted: a cheap look for a simulator's launchd first; simctl only when one runs.
    let probed: Awaited<ReturnType<BootedProbe>>;
    if (this.sessions.size === 0 && !this.listNow) {
      probed = await this.probeBooted().catch(() => undefined);
      if (!this.running) return;
      if (probed === 'none' || probed === 'app') {
        // Simulator.app open: a simulator may boot any moment, keep looking often (still without simctl).
        this.poller?.setInterval(probed === 'app' ? this.intervals.active : this.intervals.idle);
        return;
      }
    }
    this.listNow = false;
    this.listCalls += 1;
    const r = await this.simctl(['list', 'devices', 'booted', '-j'], { timeoutMs: 20_000 });
    if (!this.running) return;
    if (!r.ok) {
      this.pollProblem = `simctl list failed: ${r.error ?? r.stderr.trim().split('\n')[0] ?? `exit ${r.code}`}`;
      return;
    }
    this.pollProblem = undefined;
    const sims = parseBootedDevices(r.stdout);
    // A simulator still booting (launchd_sim runs, simctl does not list it yet) is checked again soon.
    this.poller?.setInterval(sims.length > 0 || probed === 'booted' || probed === undefined ? this.intervals.active : this.intervals.idle);
    this.booted = new Set(sims.map((s) => s.udid));
    for (const sim of sims) {
      const existing = this.sessions.get(sim.udid);
      if (existing) {
        existing.refresh(sim);
        continue;
      }
      const session = new SimulatorSession(
        {
          ctx: this.ctx,
          logger: this.logger,
          isBooted: (udid) => this.booted.has(udid),
          checkBooted: (udid) => this.checkBooted(udid),
          crashes: this.crashes,
          crashIndex: this.crashIndex!,
          appSource: this.appSource,
          timing: this.timing,
          simctl: this.simctl,
        },
        sim,
      );
      this.sessions.set(sim.udid, session);
      this.logger.info(`simulator booted: ${sim.name} (${sim.udid})`);
      session.start();
    }
    for (const [udid, session] of [...this.sessions]) {
      if (this.booted.has(udid)) continue;
      this.sessions.delete(udid);
      this.logger.info(`simulator shut down: ${udid}`);
      await session.dispose('shutdown');
    }
  }
}

function logSettingsKey(s: Pick<ServerSettings, 'iosSimLogLevel' | 'iosSimLogScope'>): string {
  return `${s.iosSimLogScope}|${s.iosSimLogLevel}`;
}
