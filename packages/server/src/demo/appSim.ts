/**
 * Base class of a simulated app with a Dürbün SDK inside: process lifecycle (pid, start, death), the
 * virtual SDK session (hello / welcome / mocks / config / commands / ping), an outbox while reconnecting
 * (like real SDKs), generation-scoped timers and logging helpers.
 */
import type {
  AppActionDescriptor,
  AppBuildType,
  DeviceApp,
  ErrorInfo,
  Header,
  LogLevel,
  MockRule,
  SdkCapability,
  SdkIdentity,
  SdkToServer,
  ServerToSdk,
} from '@durbun/protocol';
import { PROTOCOL_VERSION } from '@durbun/protocol';
import type { DeviceLogInput, DriverContext, Logger, VirtualSdkSession } from '../types';
import { type FailureKind, type HttpOutcome, HttpSim } from './http';
import type { Rng } from './rng';
import type { Scheduler } from './scheduler';

export interface AppDeps {
  ctx: DriverContext;
  sched: Scheduler;
  rng: Rng;
  deviceId: string;
  platform: 'android' | 'ios';
  logger: Logger;
}

export interface AppIdentity {
  name: string;
  bundleId: string;
  version: string;
  build: string;
  processName: string;
  sdk: SdkIdentity;
  /** NetworkEntry.source of its requests. */
  source: string;
  capabilities: SdkCapability[];
  device: { model: string; name: string; osVersion: string; apiLevel?: number; manufacturer: string; isPhysical?: boolean };
}

export type StopReason = 'crash' | 'user' | 'restart' | 'clear-data' | 'uninstall' | 'demo-stop';

/** How the demo device reports an installed build (SPEC §10.2 DeviceApp). */
export interface DemoDeviceAppMeta {
  buildType: AppBuildType;
  install: DeviceApp['install'];
}

/**
 * What the device actions and the driver need from any simulated app process — with the SDK
 * (DemoApp) or without it (DeviceOnlyApp).
 */
export interface SimApp {
  readonly deviceId: string;
  readonly identity: { name: string; bundleId: string; version: string; build: string; processName: string };
  installed: boolean;
  readonly running: boolean;
  readonly pid: number | undefined;
  launch(reason?: string): boolean;
  stop(reason: StopReason): void;
}

/** DeviceApp upsert for a simulated app (identity + how it was installed + live process state). */
export function deviceAppInput(
  app: Pick<SimApp, 'deviceId' | 'identity'>,
  platform: 'android' | 'ios',
  meta: DemoDeviceAppMeta,
  state: { pids: number[]; running: boolean },
): Parameters<DriverContext['hub']['upsertDeviceApp']>[0] {
  const input: Parameters<DriverContext['hub']['upsertDeviceApp']>[0] = {
    deviceId: app.deviceId,
    id: app.identity.bundleId,
    name: app.identity.name,
    version: app.identity.version,
    build: app.identity.build,
    buildType: meta.buildType,
    install: { ...meta.install },
    pids: [...state.pids],
    running: state.running,
  };
  if (platform === 'ios' || app.identity.processName !== app.identity.bundleId) input.processName = app.identity.processName;
  return input;
}

export interface CommandOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const OUTBOX_LIMIT = 5000;

export abstract class DemoApp implements SimApp {
  pid: number | undefined;
  appId: string | undefined;
  state: 'stopped' | 'starting' | 'running' = 'stopped';
  installed = true;
  /** When set, the app is also reported as a DeviceApp (the device's view of the installed build). */
  deviceApp: DemoDeviceAppMeta | undefined;
  /** Changes on every process start/stop: timers of an old process never fire. */
  protected gen = 0;
  protected mocks: MockRule[] = [];
  protected metricsIntervalMs = 1000;
  protected deviceLogsAvailable = true;
  protected readonly http: HttpSim;
  private session: VirtualSdkSession | undefined;
  private online = false;
  private sessionKey = '';
  private outbox: SdkToServer[] = [];
  private nextPid: number;
  private launches = 0;

  constructor(
    protected readonly deps: AppDeps,
    readonly identity: AppIdentity,
    firstPid: number,
  ) {
    this.nextPid = firstPid;
    this.http = new HttpSim(
      {
        bundleId: identity.bundleId,
        source: identity.source,
        send: (m) => this.send(m),
        after: (ms, fn) => this.after(ms, fn),
        now: () => this.now(),
        mocks: () => this.mocks,
        baseHeaders: (url) => this.baseHeaders(url),
        errorText: (kind, host, url) => this.errorText(kind, host, url),
        onStart: (info) => this.onRequestStart(info),
        onFinish: (outcome) => this.onRequestFinish(outcome),
      },
      deps.rng.fork(identity.bundleId.length * 7919 + firstPid),
    );
  }

  get rng(): Rng {
    return this.deps.rng;
  }

  get deviceId(): string {
    return this.deps.deviceId;
  }

  /** Device clock: the planned time of the running scheduler task (exact, not tick-quantized). */
  now(): number {
    return this.deps.sched.now();
  }

  get running(): boolean {
    return this.state === 'running';
  }

  /* ───────────── hooks for concrete apps ───────────── */

  abstract actions(): AppActionDescriptor[];
  /** Device log lines when the process starts (cold start). */
  protected abstract onProcessStart(reason: string): void;
  /** Device log lines when the process ends. */
  protected abstract onProcessEnd(reason: StopReason): void;
  /** Called once the SDK session is up: schedule this process's behaviour. */
  protected abstract onRunning(firstLaunch: boolean): void;
  protected abstract onCommand(name: string, params: Record<string, unknown>): CommandOutcome;
  protected abstract metric(): Record<string, number>;
  protected abstract baseHeaders(url: URL): Header[];
  protected abstract errorText(kind: FailureKind, host: string, url: string): string;
  protected onRequestStart(_info: { id: string; method: string; url: string }): void {}
  protected onRequestFinish(_outcome: HttpOutcome): void {}

  /* ───────────── lifecycle ───────────── */

  /** Starts the process (no-op when running or uninstalled). Returns false when it cannot start. */
  launch(reason = 'user'): boolean {
    if (!this.installed || this.state !== 'stopped') return false;
    this.gen++;
    this.state = 'starting';
    this.pid = this.nextPid;
    this.nextPid += this.rng.int(37, 420);
    this.launches++;
    const firstLaunch = this.launches === 1;
    // The device reports the app (with its pid) before anyone sees the process start.
    this.reportDeviceApp([this.pid], true);
    this.deps.ctx.hub.setProcess({ deviceId: this.deviceId, pid: this.pid, name: this.identity.processName, event: 'started', ts: this.now() });
    this.onProcessStart(reason);
    this.after(this.rng.int(220, 520), () => {
      this.openSession(`${this.identity.bundleId}-${Date.now().toString(36)}-${this.rng.hex(8)}`);
      this.state = 'running';
      this.startMetrics();
      this.onRunning(firstLaunch);
    });
    return true;
  }

  /** Ends the process. */
  stop(reason: StopReason): void {
    if (this.state === 'stopped') return;
    const pid = this.pid;
    this.gen++;
    this.state = 'stopped';
    this.outbox = [];
    this.closeSession(reason === 'crash' ? 'process crashed' : 'process ended');
    if (reason === 'demo-stop') return; // the device goes away; the process did not die
    this.onProcessEnd(reason);
    if (pid !== undefined) this.deps.ctx.hub.setProcess({ deviceId: this.deviceId, pid, name: this.identity.processName, event: 'died', ts: this.now() });
    if (reason === 'uninstall') {
      if (this.deviceApp) this.deps.ctx.hub.removeDeviceApps(this.deviceId, [this.identity.bundleId]);
    } else this.reportDeviceApp([], false);
  }

  /** The device's view of this build: pids / running plus install source and build type. */
  reportDeviceApp(pids: number[], running: boolean, extra: { lastActivity?: number } = {}): void {
    if (!this.deviceApp) return;
    this.deps.ctx.hub.upsertDeviceApp({ ...deviceAppInput(this, this.deps.platform, this.deviceApp, { pids, running }), ...extra });
  }

  /** Transport blip: the SDK loses its connection and reconnects with the same session key. */
  reconnect(gapMs: number): void {
    if (!this.running || !this.session) return;
    const key = this.sessionKey;
    this.closeSession('connection reset');
    this.after(gapMs, () => this.openSession(key));
  }

  private openSession(key: string): void {
    let session: VirtualSdkSession;
    try {
      session = this.deps.ctx.sdk.openVirtual({ transport: 'demo', deviceId: this.deviceId });
    } catch (err) {
      this.deps.logger.warn(`demo: could not open an SDK session for ${this.identity.name}`, err);
      return;
    }
    this.session = session;
    this.sessionKey = key;
    this.online = false;
    session.onMessage((m) => {
      if (session === this.session) this.onServerMessage(m);
    });
    session.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      sdk: this.identity.sdk,
      app: {
        name: this.identity.name,
        id: this.identity.bundleId,
        version: this.identity.version,
        build: this.identity.build,
        pid: this.pid,
        processName: this.identity.processName,
        debug: true,
      },
      device: {
        platform: this.deps.platform,
        model: this.identity.device.model,
        manufacturer: this.identity.device.manufacturer,
        name: this.identity.device.name,
        osVersion: this.identity.device.osVersion,
        apiLevel: this.identity.device.apiLevel,
        isPhysical: this.identity.device.isPhysical ?? false,
      },
      session: key,
      capabilities: this.identity.capabilities,
      actions: this.actions(),
      ts: this.now(),
    });
  }

  private closeSession(reason: string): void {
    const session = this.session;
    this.session = undefined;
    this.online = false;
    if (session && !session.closed) session.close(reason);
  }

  private onServerMessage(m: ServerToSdk): void {
    switch (m.type) {
      case 'welcome': {
        this.appId = m.appId;
        this.online = true;
        this.mocks = m.mocks;
        this.applyConfig(m.config);
        const queued = this.outbox;
        this.outbox = [];
        for (const msg of queued) this.send(msg);
        return;
      }
      case 'mocks':
        this.mocks = m.rules;
        return;
      case 'config':
        this.applyConfig(m.config);
        return;
      case 'ping':
        this.send({ type: 'pong', ts: this.now() });
        return;
      case 'command': {
        let outcome: CommandOutcome;
        try {
          outcome = this.onCommand(m.name, m.params ?? {});
        } catch (err) {
          outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const result: SdkToServer = { type: 'command.result', id: m.id, ok: outcome.ok };
        if (outcome.data !== undefined) result.data = outcome.data;
        if (outcome.error) result.error = outcome.error;
        this.send(result);
        return;
      }
    }
  }

  private applyConfig(config: { metricsIntervalMs: number; deviceLogsAvailable: boolean }): void {
    const interval = Number.isFinite(config.metricsIntervalMs) ? Math.min(60_000, Math.max(250, config.metricsIntervalMs)) : 1000;
    this.metricsIntervalMs = interval;
    this.deviceLogsAvailable = config.deviceLogsAvailable;
  }

  /** Sends through the SDK session; buffers (bounded) while the session is reconnecting. */
  protected send(message: SdkToServer): void {
    if (this.state === 'stopped') return;
    if (this.session && this.online && !this.session.closed) {
      this.session.send(message);
      return;
    }
    this.outbox.push(message);
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
  }

  /** Pushes the current action descriptors (after a toggle changed). */
  protected publishActions(): void {
    this.send({ type: 'actions', actions: this.actions() });
  }

  private startMetrics(): void {
    const tick = () => {
      if (!this.running) return;
      this.send({ type: 'metric', ts: this.now(), ...this.metric() });
      this.after(this.metricsIntervalMs, tick);
    };
    this.after(this.rng.int(150, 400), tick);
  }

  /* ───────────── helpers ───────────── */

  /** Runs `fn` after `ms` if this process is still the same one. */
  protected after(ms: number, fn: () => void): void {
    const gen = this.gen;
    this.deps.sched.after(ms, () => {
      if (gen === this.gen) fn();
    });
  }

  /** Repeats `fn` (Poisson-ish, mean `meanMs`) while this process lives. */
  protected every(meanMs: number, fn: () => void, minMs = 40): void {
    const gen = this.gen;
    const cancel = this.deps.sched.repeat(
      () => Math.max(minMs, this.rng.exp(meanMs)),
      () => {
        if (gen !== this.gen) {
          cancel();
          return;
        }
        fn();
      },
    );
  }

  /** Runs `fn` with a uniformly random period in [minMs, maxMs] while this process lives. */
  protected periodically(minMs: number, maxMs: number, fn: () => void, firstMs?: number): void {
    const gen = this.gen;
    const loop = () => {
      if (gen !== this.gen) return;
      fn();
      this.deps.sched.after(this.rng.int(minMs, maxMs), loop);
    };
    this.deps.sched.after(firstMs ?? this.rng.int(minMs, maxMs), loop);
  }

  log(level: LogLevel, tag: string, message: string, extra: { data?: unknown; error?: ErrorInfo; kind?: 'text' | 'crash' | 'flutter-error' } = {}): void {
    const msg: SdkToServer = { type: 'log', ts: this.now(), level, tag, message };
    if (extra.data !== undefined) msg.data = extra.data;
    if (extra.error) msg.error = extra.error;
    if (extra.kind) msg.kind = extra.kind;
    this.send(msg);
  }

  event(name: string, props?: Record<string, unknown>): void {
    const msg: SdkToServer = { type: 'event', ts: this.now(), name };
    if (props) msg.props = props;
    this.send(msg);
  }

  /** Device log lines from this app's own process (stdout, framework, OS libraries). */
  deviceLog(lines: Omit<DeviceLogInput, 'pid' | 'ts'>[], tsOffsetMs = 0): void {
    if (this.pid === undefined || lines.length === 0) return;
    const ts = this.now() + tsOffsetMs;
    const pid = this.pid;
    this.deps.ctx.hub.pushDeviceLogs(
      this.deviceId,
      lines.map((l, i) => {
        const entry: DeviceLogInput = { ...l, ts: ts + i * 0.01, pid };
        if (entry.tid === undefined) entry.tid = pid;
        if (this.deps.platform === 'ios' && !entry.process) entry.process = this.identity.processName;
        return entry;
      }),
    );
  }

  /** Device log lines from another process (system_server, runningboardd, …). */
  systemLog(lines: DeviceLogInput[]): void {
    if (lines.length > 0) this.deps.ctx.hub.pushDeviceLogs(this.deviceId, restamp(lines, this.now()));
  }
}

/** Moves lines to `base` keeping their relative offsets (lines are built with wall-clock stamps). */
export function restamp(lines: DeviceLogInput[], base: number): DeviceLogInput[] {
  const first = lines[0]?.ts ?? base;
  for (const l of lines) l.ts = base + Math.max(0, l.ts - first);
  return lines;
}
