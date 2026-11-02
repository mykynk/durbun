/**
 * One adb device (by serial): state transitions, device info, logcat stream, pid→process map,
 * adb-reverse SDK routing, actions and metrics, plus (SPEC §10) the apps the device reports
 * (DeviceApps), dropbox crash / ANR records and frame stats.
 */
import type { DeviceActionId, DeviceActionResult, DeviceInfo, DeviceState, LogStreamStatus } from '@durbun/protocol';
import type { DeviceLogInput, DriverContext, Logger, PortForward } from '../../types';
import { StreamProcess, type StreamExitInfo, type StreamSpec } from '../exec';
import { LogBatcher } from '../shared/batcher';
import { fail } from '../shared/files';
import { humanizeModel } from '../shared/text';
import { every } from '../shared/timing';
import { androidActionsFor, runAndroidAction } from './actions';
import type { Adb } from './adb';
import type { DeviceClock } from './deviceClock';
import { basePackage, DeviceAppTracker } from './deviceApps';
import { CrashIndex, createDropboxCursor, DropboxWatcher, type DropboxCursor } from './dropbox';
import { AndroidLogPipeline, logcatSinceArg, type ProcessEvent } from './logcat';
import { AndroidMetricsWatcher, type MetricsTarget } from './metrics';
import {
  connectionForSerial,
  isEmulatorSerial,
  mapAdbState,
  parseBattery,
  parseGetprop,
  parsePs,
  parseWmOutput,
  type AdbDeviceRow,
} from './parsers';
import { AdbReverseRouter } from './reverse';

const VIA = 'logcat';
const INFO_SEP = '___DURBUN_SECTION___';

export interface AndroidSessionDeps {
  ctx: DriverContext;
  adb: () => Adb | null;
  logger: Logger;
  /** Dropbox records already reported for this serial (kept by the driver across replugs). */
  dropboxCursor?: DropboxCursor;
}

interface StateText {
  code: string;
  detail: string;
}

function stateText(raw: string): StateText {
  switch (raw) {
    case 'unauthorized':
      return {
        code: 'device.unauthorized',
        detail: 'Unlock the device and accept the "Allow USB debugging?" prompt (RSA key fingerprint).',
      };
    case 'authorizing':
      return { code: 'device.authorizing', detail: 'Waiting for the device to authorize this computer…' };
    case 'no permissions':
      return {
        code: 'device.noPermissions',
        detail: 'adb has no permission to access this USB device (check udev rules / plugdev group).',
      };
    case 'recovery':
    case 'sideload':
    case 'bootloader':
    case 'rescue':
      return { code: 'device.notBooted', detail: `The device is in ${raw} mode.` };
    default:
      return {
        code: 'device.offline',
        detail: 'adb reports the device as offline — reconnect the cable or run "adb kill-server".',
      };
  }
}

export class AndroidDeviceSession {
  readonly id: string;
  readonly serial: string;
  private info: DeviceInfo;
  private emulator: boolean;
  private apiLevel?: number;
  private online = false;
  private disposed = false;
  private gen = 0;
  private desired?: AdbDeviceRow;
  private applying?: Promise<void>;
  private lastRawState?: string;

  private readonly pipeline: AndroidLogPipeline;
  private readonly batcher: LogBatcher;
  private logcat?: StreamProcess;
  private legacyLogcat = false;
  private logsStatus: LogStreamStatus = 'starting';
  private streamFailed = false;
  private lastLineAt = 0;
  private streamingTimer?: NodeJS.Timeout;

  private router?: AdbReverseRouter;
  private timers: Array<() => void> = [];
  private readonly processes = new Map<number, string>();
  private readonly lookedUp = new Set<number>();
  private psTimer?: NodeJS.Timeout;
  private psRunning = false;
  private psLastAt = 0;
  private readonly metrics = new Map<string, AndroidMetricsWatcher>();
  private readonly forwards = new Set<number>();

  private readonly clock: DeviceClock = {};
  private readonly apps: DeviceAppTracker;
  private readonly crashes: CrashIndex;
  private readonly dropbox: DropboxWatcher;
  private watchStart?: number;
  private unsubLogs?: () => void;

  constructor(
    private readonly deps: AndroidSessionDeps,
    row: AdbDeviceRow,
  ) {
    this.serial = row.serial;
    this.id = `android:${row.serial}`;
    this.emulator = isEmulatorSerial(row.serial);
    const now = Date.now();
    const model = row.props.model ? humanizeModel(row.props.model) : undefined;
    const state = mapAdbState(row.state);
    const st = state === 'online' ? undefined : stateText(row.state);
    this.info = {
      id: this.id,
      platform: 'android',
      kind: this.emulator ? 'emulator' : 'physical',
      name: model ?? row.serial,
      ...(model ? { model } : {}),
      serial: row.serial,
      connection: connectionForSerial(row.serial),
      state,
      ...(st ? { stateCode: st.code, stateDetail: st.detail } : {}),
      logs:
        state === 'online'
          ? { status: 'starting', via: VIA }
          : { status: 'unavailable', via: VIA, code: st!.code, detail: st!.detail },
      actions: [],
      firstSeen: now,
      lastSeen: now,
    };
    const hub = deps.ctx.hub;
    this.batcher = new LogBatcher((entries) => hub.pushDeviceLogs(this.id, entries), deps.logger);
    this.pipeline = new AndroidLogPipeline({
      emit: (e: DeviceLogInput) => {
        e.origin = 'logcat';
        this.batcher.push(e);
      },
      onProcessEvent: (ev) => this.onProcessEvent(ev),
      processName: (pid) => this.processName(pid),
    });
    this.apps = new DeviceAppTracker({
      adb: deps.adb,
      serial: this.serial,
      deviceId: this.id,
      hub,
      logger: deps.logger,
      processes: () => this.processes,
      clock: this.clock,
    });
    this.crashes = new CrashIndex(this.id);
    this.dropbox = new DropboxWatcher({
      adb: deps.adb,
      serial: this.serial,
      deviceId: this.id,
      hub,
      logger: deps.logger,
      cursor: deps.dropboxCursor ?? createDropboxCursor(),
      clock: this.clock,
      watchStart: () => this.watchStart ?? Date.now(),
      apps: this.apps,
      crashes: this.crashes,
    });
    try {
      // Live logcat crashes / ANRs (with their hub ids) → de-duplication of dropbox records.
      this.unsubLogs = deps.ctx.onLogs((entries) => {
        for (const e of entries) if (e.kind === 'crash' || e.kind === 'anr') this.crashes.add(e);
      });
    } catch (e) {
      deps.logger.debug(`${this.serial}: onLogs subscription failed: ${(e as Error).message}`);
    }
  }

  get isOnline(): boolean {
    return this.online;
  }

  get deviceInfo(): DeviceInfo {
    return this.info;
  }

  /** First appearance → hub.upsertDevice. */
  announce(): void {
    this.deps.ctx.hub.upsertDevice({ ...this.info });
  }

  /** Apply the latest `adb devices` row (latest wins; transitions are serialized). */
  update(row: AdbDeviceRow): Promise<void> {
    this.desired = row;
    if (!this.applying) {
      this.applying = (async () => {
        try {
          while (this.desired && !this.disposed) {
            const r = this.desired;
            this.desired = undefined;
            await this.apply(r);
          }
        } catch (e) {
          this.deps.logger.warn(`${this.serial}: state update failed: ${(e as Error).message}`);
        } finally {
          this.applying = undefined;
        }
      })();
    }
    return this.applying;
  }

  private patch(patch: Partial<DeviceInfo>): void {
    if (this.disposed) return;
    this.info = { ...this.info, ...patch, lastSeen: Date.now() };
    this.deps.ctx.hub.patchDevice(this.id, { ...patch, lastSeen: this.info.lastSeen });
  }

  private setLogs(logs: DeviceInfo['logs']): void {
    this.logsStatus = logs.status;
    this.patch({ logs });
  }

  private async apply(row: AdbDeviceRow): Promise<void> {
    const state = mapAdbState(row.state);
    if (state === 'online') {
      if (!this.online) await this.goOnline();
    } else if (this.online || this.lastRawState !== row.state) {
      await this.goOffline(state, row.state);
    }
    this.lastRawState = row.state;
  }

  private async goOnline(): Promise<void> {
    this.online = true;
    this.watchStart ??= Date.now();
    const gen = ++this.gen;
    this.patch({
      state: 'online',
      stateCode: undefined,
      stateDetail: undefined,
      logs: { status: 'starting', via: VIA },
    });
    this.logsStatus = 'starting';
    await this.loadInfo(gen);
    if (gen !== this.gen || this.disposed) return;
    this.patch({ actions: this.actions() });
    await this.refreshProcesses();
    if (gen !== this.gen || this.disposed) return;
    void this.apps.start();
    this.startLogcat();
    await this.startRouter(gen);
    if (gen !== this.gen || this.disposed) return;
    this.dropbox.start();
    this.timers.push(
      every(30_000, () => this.refreshBattery(), this.deps.logger),
      every(
        10_000,
        async () => {
          if (this.router && this.online) await this.router.ensure();
        },
        this.deps.logger,
      ),
      every(60_000, () => this.lookedUp.clear()),
    );
  }

  private async goOffline(state: DeviceState, raw: string): Promise<void> {
    const wasOnline = this.online;
    this.online = false;
    this.gen += 1;
    this.stopTimers();
    this.dropbox.stop();
    this.apps.stop();
    if (wasOnline) {
      await this.stopLogcat();
      await this.router?.stop(false);
      this.router = undefined;
      for (const w of this.metrics.values()) w.stop();
      this.metrics.clear();
    }
    const st = stateText(raw);
    this.patch({
      state,
      stateCode: st.code,
      stateDetail: st.detail,
      actions: [],
      logs: { status: 'unavailable', via: VIA, code: state === 'unauthorized' ? st.code : 'logs.deviceOffline', detail: st.detail },
    });
    this.logsStatus = 'unavailable';
  }

  /** Device gone ('disconnected') or driver stopping ('stopped'). */
  async dispose(reason: 'disconnected' | 'stopped'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const wasOnline = this.online;
    this.gen += 1;
    this.stopTimers();
    clearTimeout(this.psTimer);
    this.unsubLogs?.();
    this.unsubLogs = undefined;
    this.dropbox.stop();
    this.apps.dispose();
    for (const w of this.metrics.values()) w.stop();
    this.metrics.clear();
    await this.stopLogcat();
    this.pipeline.dispose();
    this.batcher.dispose();
    const cleanup = reason === 'stopped' && wasOnline;
    await this.router?.stop(cleanup);
    this.router = undefined;
    if (cleanup) {
      const adb = this.deps.adb();
      if (adb) await Promise.all([...this.forwards].map((p) => adb.forwardRemove(this.serial, p)));
    }
    this.forwards.clear();
    this.online = false;
    if (reason === 'disconnected') this.deps.ctx.hub.markDeviceDisconnected(this.id);
    else this.deps.ctx.hub.markDeviceDisconnected(this.id, 'Dürbün stopped watching Android devices', 'device.driverStopped');
  }

  private stopTimers(): void {
    for (const t of this.timers) t();
    this.timers = [];
    clearTimeout(this.streamingTimer);
  }

  /* ───────────── device info ───────────── */

  private async loadInfo(gen: number): Promise<void> {
    const adb = this.deps.adb();
    if (!adb) return;
    const cmd = [
      'getprop',
      `echo ${INFO_SEP}`,
      'settings get global device_name',
      `echo ${INFO_SEP}`,
      'wm size',
      'wm density',
      `echo ${INFO_SEP}`,
      'dumpsys battery',
    ].join('; ');
    const r = await adb.shell(this.serial, cmd, { timeoutMs: 20_000 });
    if (gen !== this.gen || this.disposed) return;
    if (!r.stdout) {
      this.deps.logger.debug(`${this.serial}: device info unavailable: ${r.error ?? r.stderr.trim()}`);
      return;
    }
    const parts = r.stdout.split(new RegExp(`^${INFO_SEP}\\s*$`, 'm'));
    const props = parseGetprop(parts[0] ?? '');
    const deviceName = (parts[1] ?? '').trim();
    const screen = parseWmOutput(parts[2] ?? '');
    const battery = parseBattery(parts[3] ?? '');

    const sdk = Number(props['ro.build.version.sdk']);
    if (Number.isInteger(sdk) && sdk > 0) this.apiLevel = sdk;
    const emulator =
      this.emulator ||
      props['ro.kernel.qemu'] === '1' ||
      props['ro.boot.qemu'] === '1' ||
      props['ro.hardware'] === 'ranchu' ||
      props['ro.hardware'] === 'goldfish';
    this.emulator = emulator;
    const model = props['ro.product.model'];
    const avd = props['ro.boot.qemu.avd_name'] || props['ro.kernel.qemu.avd_name'];
    const marketName = props['ro.product.marketname'] || props['ro.config.marketing_name'];
    let name: string | undefined;
    if (emulator && avd) name = humanizeModel(avd);
    else if (deviceName && deviceName !== 'null' && !deviceName.includes('Exception')) name = deviceName;
    else name = marketName || model;

    const patch: Partial<DeviceInfo> = {
      kind: emulator ? 'emulator' : 'physical',
      ...(name ? { name } : {}),
      ...(model ? { model } : {}),
      ...(props['ro.product.manufacturer'] ? { manufacturer: props['ro.product.manufacturer'] } : {}),
      ...(props['ro.build.version.release'] ? { osVersion: props['ro.build.version.release'] } : {}),
      ...(this.apiLevel ? { apiLevel: this.apiLevel } : {}),
      ...(screen ? { screen } : {}),
      ...(battery ? { battery } : {}),
    };
    if (emulator && this.info.connection === 'usb') patch.connection = 'local';
    this.patch(patch);
  }

  private async refreshBattery(): Promise<void> {
    const adb = this.deps.adb();
    if (!adb || !this.online) return;
    const r = await adb.shell(this.serial, 'dumpsys battery', { timeoutMs: 10_000 });
    const battery = r.ok ? parseBattery(r.stdout) : undefined;
    if (!battery || !this.online) return;
    const prev = this.info.battery;
    if (!prev || prev.level !== battery.level || prev.charging !== battery.charging) this.patch({ battery });
  }

  /* ───────────── processes ───────────── */

  private processName(pid: number): string | undefined {
    const name = this.processes.get(pid);
    if (name === undefined && pid > 0 && !this.lookedUp.has(pid)) {
      this.lookedUp.add(pid);
      this.schedulePs();
    }
    return name;
  }

  /** Best known pid for a process name (newest pid wins). */
  findPid(name: string): number | undefined {
    let found: number | undefined;
    for (const [pid, n] of this.processes) if (n === name && (found === undefined || pid > found)) found = pid;
    return found;
  }

  private schedulePs(): void {
    if (this.psTimer || this.psRunning || !this.online) return;
    const wait = Math.max(1000, 3000 - (Date.now() - this.psLastAt));
    this.psTimer = setTimeout(() => {
      this.psTimer = undefined;
      void this.refreshProcesses();
    }, wait);
    this.psTimer.unref?.();
  }

  private async refreshProcesses(): Promise<void> {
    const adb = this.deps.adb();
    if (!adb || !this.online || this.psRunning) return;
    this.psRunning = true;
    try {
      let r = await adb.shell(this.serial, 'ps -A -o PID,NAME', { timeoutMs: 15_000 });
      let map = r.ok ? parsePs(r.stdout) : new Map<number, string>();
      if (map.size < 2) {
        r = await adb.shell(this.serial, 'ps', { timeoutMs: 15_000 });
        map = r.ok ? parsePs(r.stdout) : new Map<number, string>();
      }
      if (map.size < 2 || !this.online || this.disposed) return;
      const now = Date.now();
      const hub = this.deps.ctx.hub;
      for (const [pid, name] of map) {
        if (this.processes.get(pid) !== name) {
          this.processes.set(pid, name);
          hub.setProcess({ deviceId: this.id, pid, name, event: 'seen', ts: now });
        }
      }
      for (const [pid, name] of [...this.processes]) {
        if (!map.has(pid)) {
          this.processes.delete(pid);
          hub.setProcess({ deviceId: this.id, pid, name, event: 'died', ts: now });
        }
      }
      this.apps.sync();
    } finally {
      this.psRunning = false;
      this.psLastAt = Date.now();
    }
  }

  private onProcessEvent(ev: ProcessEvent): void {
    if (ev.event === 'started') {
      this.processes.set(ev.pid, ev.name);
      this.lookedUp.delete(ev.pid);
    } else {
      this.processes.delete(ev.pid);
    }
    this.deps.ctx.hub.setProcess({ deviceId: this.id, pid: ev.pid, name: ev.name, event: ev.event, ts: ev.ts });
    this.apps.onProcessEvent(ev);
  }

  /* ───────────── logcat ───────────── */

  private logcatSpec(): StreamSpec | null {
    const adb = this.deps.adb();
    if (!adb) return null;
    const args = ['-s', this.serial, 'logcat', '-v', 'threadtime'];
    const modern = !this.legacyLogcat && (this.apiLevel === undefined || this.apiLevel >= 24);
    if (modern) args.push('-v', 'epoch', '-v', 'printable');
    if (this.apiLevel === undefined || this.apiLevel >= 21) {
      const last = this.pipeline.lastTimestamp;
      const fresh = Date.now() - this.lastLineAt < 10 * 60_000;
      if (modern && last !== undefined && fresh) args.push('-T', logcatSinceArg(last));
      else args.push('-T', String(Math.max(1, Math.floor(this.deps.ctx.settings().logcatTail || 1))));
    }
    return { cmd: adb.path, args, env: adb.tool.env };
  }

  private startLogcat(): void {
    if (!this.logcat) {
      this.logcat = new StreamProcess({
        name: `logcat ${this.serial}`,
        logger: this.deps.logger,
        spec: () => this.logcatSpec(),
        onLine: (line) => {
          this.lastLineAt = Date.now();
          this.pipeline.pushLine(line);
        },
        onFirstOutput: () => this.setStreaming(),
        onExit: (info) => this.onLogcatExit(info),
        shouldRestart: () => this.online && !this.disposed,
        backoffInitialMs: 1000,
        backoffMaxMs: 15_000,
        stableAfterMs: 30_000,
      });
    }
    // Coming back online (or restarting): resume at the last record and drop the repeated boundary.
    this.pipeline.beginResume();
    if (!this.logcat.start()) {
      this.setLogs({ status: 'unavailable', via: VIA, code: 'logs.adbMissing', detail: 'adb is not available' });
      return;
    }
    clearTimeout(this.streamingTimer);
    // An idle device may print nothing for a while; a live logcat after 2 s is streaming.
    this.streamingTimer = setTimeout(() => {
      if (this.logcat?.running && this.logsStatus === 'starting') this.setStreaming();
    }, 2000);
    this.streamingTimer.unref?.();
  }

  private async stopLogcat(): Promise<void> {
    clearTimeout(this.streamingTimer);
    if (this.logcat) await this.logcat.stop();
    this.pipeline.flush();
    this.batcher.flush();
  }

  private setStreaming(): void {
    if (this.logsStatus === 'streaming' || !this.online || this.disposed) return;
    const recovered = this.streamFailed;
    this.streamFailed = false;
    this.setLogs({ status: 'streaming', via: VIA });
    this.deps.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.streamStarted',
      message: recovered ? 'Device log stream resumed (logcat)' : 'Device log stream started (logcat)',
      params: { via: VIA },
    });
  }

  private onLogcatExit(info: StreamExitInfo): void {
    if (info.stopped || this.disposed) return;
    if (
      !this.legacyLogcat &&
      !info.hadOutput &&
      info.ranForMs < 5000 &&
      /unknown format|invalid|unrecognized|usage:/i.test(info.stderrTail)
    ) {
      this.legacyLogcat = true; // pre-Android-7 logcat: no -v epoch / printable
    }
    this.pipeline.beginResume();
    this.batcher.flush();
    if (info.willRestart) void this.checkStreamFailure(info);
  }

  private async checkStreamFailure(info: StreamExitInfo): Promise<void> {
    const adb = this.deps.adb();
    const state = adb ? await adb.getState(this.serial) : undefined;
    if (this.disposed || !this.online || state !== 'device') return; // unplugged: the poller handles it
    const why = info.error ?? (info.signal ? `signal ${info.signal}` : `exit code ${info.code ?? '?'}`);
    const detail = `logcat exited (${why})${info.stderrTail ? `: ${info.stderrTail}` : ''} — restarting`;
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

  /** logs-restart action. */
  async restartLogs(): Promise<void> {
    if (!this.online) return;
    this.deps.ctx.hub.pushSystemLog(this.id, {
      level: 'info',
      code: 'logs.streamStopped',
      message: 'Device log stream stopped (restart requested)',
      params: { via: VIA },
    });
    await this.stopLogcat();
    this.pipeline.beginResume();
    this.setLogs({ status: 'starting', via: VIA });
    this.startLogcat();
  }

  /* ───────────── SDK routing ───────────── */

  private async startRouter(gen: number): Promise<void> {
    if (this.router) return;
    const router = new AdbReverseRouter({
      adb: this.deps.adb,
      serial: this.serial,
      deviceId: this.id,
      ctx: this.deps.ctx,
      logger: this.deps.logger,
    });
    try {
      await router.start();
    } catch (e) {
      this.deps.logger.warn(`${this.serial}: could not open the SDK listener: ${(e as Error).message}`);
      return;
    }
    if (gen !== this.gen || this.disposed) {
      await router.stop(false);
      return;
    }
    this.router = router;
    await router.ensure();
  }

  /* ───────────── actions / metrics / forwarding ───────────── */

  actions(): DeviceActionId[] {
    return androidActionsFor({ online: this.online, isEmulator: this.emulator, apiLevel: this.apiLevel });
  }

  async runAction(action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
    const adb = this.deps.adb();
    if (!adb) return fail('adb is not available', 'action.toolMissing');
    if (!this.online) return fail(`${this.info.name} is not online`, 'action.deviceOffline');
    if (!this.actions().includes(action)) {
      return fail(`"${action}" is not available for ${this.info.name}`, 'action.unsupported');
    }
    return runAndroidAction(
      {
        adb,
        serial: this.serial,
        deviceId: this.id,
        label: this.info.name,
        isEmulator: this.emulator,
        apiLevel: this.apiLevel,
        ctx: this.deps.ctx,
        restartLogs: () => this.restartLogs(),
      },
      action,
      params,
    );
  }

  watchMetrics(target: MetricsTarget, enabled: boolean): void {
    const key = `${target.pid ?? ''}|${target.processName ?? ''}`;
    const existing = this.metrics.get(key);
    if (!enabled) {
      existing?.stop();
      this.metrics.delete(key);
      return;
    }
    if (existing || (!target.pid && !target.processName)) return;
    const w = new AndroidMetricsWatcher(
      {
        adb: this.deps.adb,
        serial: this.serial,
        deviceId: this.id,
        hub: this.deps.ctx.hub,
        logger: this.deps.logger,
        findPid: (name) => this.findPid(name),
        packageOf: (pid) => basePackage(target.processName ?? (pid !== undefined ? this.processes.get(pid) : undefined)),
      },
      target,
    );
    this.metrics.set(key, w);
    w.start();
  }

  async forward(devicePort: number): Promise<PortForward> {
    const adb = this.deps.adb();
    if (!adb) throw new Error('adb is not available');
    const r = await adb.forward(this.serial, devicePort);
    if (!r.port) throw new Error(`adb forward to device port ${devicePort} failed: ${r.error ?? 'unknown error'}`);
    const port = r.port;
    this.forwards.add(port);
    let disposed = false;
    return {
      host: '127.0.0.1',
      port,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        this.forwards.delete(port);
        await adb.forwardRemove(this.serial, port);
      },
    };
  }
}
