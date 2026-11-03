/**
 * One attached Dart VM: owns the VM service connection (reconnecting through DDS when it takes over),
 * the virtual SDK session that feeds the hub, and the log / network / metrics / command pipelines.
 */
import type {
  AppInfo,
  DeviceApp,
  I18nParams,
  LogKind,
  LogLevel,
  SdkCapability,
  SdkConfig,
  SdkHello,
  SdkMetric,
  SdkToServer,
  ServerToSdk,
} from '@durbun/protocol';
import { PROTOCOL_VERSION } from '@durbun/protocol';
import type { DriverContext, Logger, PlatformServices, PortForward, VirtualSdkSession } from '../../types';
import { redactSecrets } from '../../util/redact';
import { SERVER_VERSION } from '../../version';
import { nativeTargetPlatform, type ValueContext } from './actions';
import {
  deriveAppInfo,
  deviceAppForVm,
  deviceHintsFor,
  inspectHostProcess,
  packageNameFromLibraryUri,
  sdkSessionForPid,
  uniqueOnlineDevice,
  type BundleInfo,
  type HostProcessInfo,
} from './appInfo';
import { DeviceClock } from './clock';
import { ActionController } from './commands';
import { FrameStats, parseFlutterFrame } from './frames';
import type { HttpProfileJson, HttpProfileRequestJson } from './httpProfile';
import { loggingEventKey, loggingEventToAppLog, type AppLog, type LoggingEventJson, type ObjectResolver } from './logRecord';
import {
  connectVmService,
  probeVmService,
  RpcCodes,
  RpcError,
  type CloseInfo,
  type EventMeta,
  type IsolateRefJson,
  type VmEventJson,
  type VmServiceClient,
} from './rpc';
import { sameVmProcess, type VmPersistentState, type VmStateStore } from './state';
import { StdioPipeline } from './stdio';
import { redactServiceUrl } from './url';

export type VmModuleContext = DriverContext & { platform: PlatformServices };

export interface VmTarget {
  /** Normalized ws URL to connect to first. */
  wsUrl: string;
  /** URL to re-probe after the connection drops (normally the raw VM service); defaults to wsUrl. */
  reconnectUrl?: string;
  /** Known device (auto-attach, or chosen by the user). */
  deviceId?: string;
  /** Port forward owned by this session (disposed when it ends or fails to start). */
  forward?: PortForward;
  origin: 'manual' | 'auto';
  /** URL as announced/pasted (device-side for auto-attach), for messages. */
  displayUrl: string;
  /** From the announcing log line. */
  hints?: { pid?: number; processName?: string };
  /** Auto-attach identity of the announcing process on its device. */
  processKey?: string;
}

export interface VmSessionDeps {
  ctx: VmModuleContext;
  logger: Logger;
  states: VmStateStore;
  /** Process name seen in device logs for (device, pid). */
  processName(deviceId: string | undefined, pid: number | undefined): string | undefined;
  onEnded(session: VmSession, reason: string): void;
  /** Another live session attached to the same VM process (same pid and start time), if any. */
  duplicateOf?(session: VmSession): VmSession | undefined;
  /** Delays between reconnect attempts after the connection drops (tests shorten them). */
  reconnectDelaysMs?: number[];
  /** How long to wait for a physical iPhone to report the app's pid (tests shorten it). */
  deviceAppWaitMs?: number;
}

/** The VM is already attached by another session; `appId` is that session's app. */
export class AlreadyAttachedError extends Error {
  constructor(readonly appId: string) {
    super(`This Dart VM is already attached (${appId})`);
    this.name = 'AlreadyAttachedError';
  }
}

interface VmJson {
  pid?: number;
  startTime?: number;
  operatingSystem?: string;
  isolates?: IsolateRefJson[];
  isolateGroups?: { id?: string; name?: string }[];
  _currentRSS?: number;
}

interface IsolateJson {
  type?: string;
  id?: string;
  name?: string;
  number?: string;
  isSystemIsolate?: boolean;
  isolateGroupId?: string;
  pauseEvent?: { kind?: string };
  rootLib?: { uri?: string };
  libraries?: { uri?: string }[];
  extensionRPCs?: string[];
}

interface IsolateInfo {
  id: string;
  name: string;
  extensions: Set<string>;
  paused: boolean;
  isFlutter: boolean;
  rootLib?: string;
  groupId?: string;
  firstSeen: number;
  httpEnabled: boolean;
  httpBusy: boolean;
}

interface Identity {
  pid: number;
  startTime: number;
  os: string;
}

const MAX_TEXT_CHARS = 256 * 1024;
const WELCOME_TIMEOUT_MS = 10_000;
const HTTP_POLL_MS = 1000;
const RECONNECT_DELAYS_MS = [250, 750, 1500, 3000, 5000];
/** A physical iPhone reports a new process's pid a moment after it starts (devicectl process list). */
const DEVICE_APP_WAIT_MS = 3000;
const DEVICE_APP_POLL_MS = 200;
/** Background isolates must live this long before HTTP profiling is enabled in them (skip `compute()`). */
const BACKGROUND_ISOLATE_HTTP_DELAY_MS = 3000;
const MIB = 1024 * 1024;
const PAUSE_KINDS = new Set([
  'PauseStart',
  'PauseExit',
  'PauseBreakpoint',
  'PauseInterrupted',
  'PauseException',
  'PausePostRequest',
]);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Thrown during reconnect when the VM behind the URL is not ours any more. */
class DifferentVmError extends Error {}

/** Thrown when the session was ended while it was still connecting. */
class SessionEndedError extends Error {
  constructor() {
    super('The session was closed while attaching');
  }
}

export class VmSession {
  readonly target: VmTarget;
  appId?: string;
  deviceId?: string;
  app?: AppInfo;
  viaDds = false;

  private readonly deps: VmSessionDeps;
  private readonly logger: Logger;
  private client?: VmServiceClient;
  private virtual?: VirtualSdkSession;
  private identity?: Identity;
  private state?: VmPersistentState;
  private config: SdkConfig;
  private readonly isolates = new Map<string, IsolateInfo>();
  private readonly groupNames = new Map<string, string>();
  private mainIsolateId?: string;
  private hadMainIsolate = false;
  private readonly actions: ActionController;
  private readonly frames = new FrameStats();
  private readonly clock = new DeviceClock();
  private readonly stdout: StdioPipeline;
  private readonly stderr: StdioPipeline;
  private stdioActive = false;
  private logChain: Promise<void> = Promise.resolve();
  private pendingLogs = 0;
  private active = false;
  private ended = false;
  private capturingHttp = false;
  private httpFailures = 0;
  private httpTimer?: ReturnType<typeof setTimeout>;
  private metricsTimer?: ReturnType<typeof setTimeout>;
  private mainLostTimer?: ReturnType<typeof setTimeout>;
  private readonly isolateTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastReconcile = 0;
  private readonly resolver: ObjectResolver;

  constructor(target: VmTarget, deps: VmSessionDeps) {
    this.target = target;
    this.deps = deps;
    this.logger = deps.logger;
    const s = deps.ctx.settings();
    this.config = {
      captureBodies: s.captureBodies,
      maxBodyBytes: s.maxBodyBytes,
      metricsIntervalMs: s.metricsIntervalMs,
      deviceLogsAvailable: false,
    };
    const emit = (log: AppLog) => this.queueLog(log);
    this.actions = new ActionController({
      mainIsolate: () => this.mainIsolate(),
      callExtension: (method, isolateId, params, timeoutMs) => this.requireClient().callExtension(method, isolateId, params, timeoutMs),
      connected: () => !!this.client && !this.client.closed,
      ready: () => !!this.appId && !this.ended,
      send: (msg) => this.send(msg),
      log: (log) => this.queueLog(log),
      deviceNow: () => this.clock.deviceNow(),
      valueContext: () => this.valueContext(),
      logger: this.logger,
    });
    this.stdout = new StdioPipeline({ stream: 'stdout', isFlutter: () => this.isFlutter(), emit });
    this.stderr = new StdioPipeline({ stream: 'stderr', isFlutter: () => this.isFlutter(), emit });
    this.resolver = {
      fullString: async (isolateId, objectId, maxChars) => {
        const r = await this.requireClient().call<{ valueAsString?: string; length?: number; count?: number }>(
          'getObject',
          { isolateId, objectId, offset: 0, count: maxChars },
          4000,
        );
        if (typeof r.valueAsString !== 'string') return undefined;
        const cut = typeof r.length === 'number' && r.valueAsString.length < r.length;
        return cut ? `${r.valueAsString}…` : r.valueAsString;
      },
      describe: async (isolateId, objectId, maxChars) => {
        const r = await this.requireClient().call<{
          type?: string;
          id?: string;
          kind?: string;
          valueAsString?: string;
          valueAsStringIsTruncated?: boolean;
        }>('invoke', { isolateId, targetId: objectId, selector: 'toString', argumentIds: [], disableBreakpoints: true }, 4000);
        if (!r || typeof r.valueAsString !== 'string' || (r.type ?? '').includes('Error')) return undefined;
        if (r.valueAsStringIsTruncated && r.id && r.kind === 'String') {
          return (await this.resolver.fullString(isolateId, r.id, maxChars)) ?? `${r.valueAsString}…`;
        }
        return r.valueAsString;
      },
    };
  }

  get pid(): number | undefined {
    return this.identity?.pid;
  }

  /** Both sessions talk to the same VM process. */
  isSameVm(other: VmSession): boolean {
    return !!this.identity && !!other.identity && sameVmProcess(this.identity, other.identity);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get name(): string {
    return this.app?.name ?? 'Dart app';
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  async start(): Promise<{ appId: string }> {
    const alive = () => {
      if (this.ended) throw new SessionEndedError();
    };
    try {
      await this.connect(this.target.wsUrl);
      await this.loadVm();
      alive();
      const duplicate = this.deps.duplicateOf?.(this);
      if (duplicate?.appId) throw new AlreadyAttachedError(duplicate.appId);
      await this.openAppSession();
      alive();
      await this.activate();
      alive();
    } catch (err) {
      await this.abortStart(err);
      throw err instanceof Error ? err : new Error(String(err));
    }
    const appId = this.appId!;
    const via = this.viaDds ? ' (via DDS)' : '';
    this.systemLine(`Attached to ${this.name} through the Dart VM service${via}`, 'vm.attached', {
      params: { app: this.name, url: redactServiceUrl(this.target.displayUrl) },
    });
    if (this.target.origin === 'auto') {
      this.notice('success', `Dart VM service attached: ${this.name}`, 'vm.attached', { app: this.name });
    }
    this.logger.info(`attached to ${this.name} (pid ${this.identity?.pid}) at ${redactSecrets(this.client?.url ?? '?')}${via}`);
    return { appId };
  }

  /** End the session. `cleanup` turns off what Dürbün enabled in a still-running app. */
  async end(reason: string, opts: { unexpected?: boolean; cleanup?: boolean } = {}): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.active = false;
    this.clearTimers();
    this.actions.dispose();
    this.stdout.flush();
    this.stderr.flush();
    await withTimeout(this.logChain, 2000, 'log flush timeout').catch(() => {});
    if (opts.cleanup) await this.disableOwnProfiling();
    this.state?.http.unbind();
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
    this.closeVirtual(reason);
    await this.disposeForward();
    if (this.appId) {
      this.systemLine(`Detached from ${this.name}: ${reason}`, 'vm.detached', { params: { app: this.name, reason } });
      if (opts.unexpected) this.notice('info', `Dart VM service detached: ${this.name} (${reason})`, 'vm.detached', { app: this.name, reason });
    }
    this.logger.info(`detached from ${this.name}: ${reason}`);
    this.deps.onEnded(this, reason);
  }

  private async abortStart(err: unknown): Promise<void> {
    this.ended = true;
    this.active = false;
    this.clearTimers();
    this.actions.dispose();
    this.state?.http.unbind();
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
    this.closeVirtual(`attach failed: ${errorText(err)}`);
    await this.disposeForward();
  }

  private closeVirtual(reason: string): void {
    const v = this.virtual;
    if (!v || v.closed) return;
    try {
      v.close(reason);
    } catch (err) {
      this.logger.debug(`closing the virtual session failed: ${errorText(err)}`);
    }
  }

  private forwardDisposed = false;

  private async disposeForward(): Promise<void> {
    if (this.forwardDisposed || !this.target.forward) return;
    this.forwardDisposed = true;
    await this.target.forward.dispose().catch((err: unknown) => this.logger.debug(`port forward cleanup failed: ${errorText(err)}`));
  }

  private clearTimers(): void {
    for (const t of [this.httpTimer, this.metricsTimer, this.mainLostTimer]) if (t) clearTimeout(t);
    this.httpTimer = this.metricsTimer = this.mainLostTimer = undefined;
    for (const t of this.isolateTimers) clearTimeout(t);
    this.isolateTimers.clear();
  }

  /* ───────────────────────────── connection ───────────────────────────── */

  private requireClient(): VmServiceClient {
    const c = this.client;
    if (!c || c.closed) throw new RpcError('Not connected to the VM service', RpcCodes.closed);
    return c;
  }

  /** Prefer DDS when it has taken over (a direct connection would be dropped as soon as DDS starts). */
  private async connect(url: string): Promise<void> {
    const probe = await probeVmService(url, 3000);
    let client: VmServiceClient | undefined;
    if (probe.kind === 'dds') {
      try {
        client = await connectVmService(probe.wsUrl, { logger: this.logger });
      } catch (err) {
        this.logger.debug(`connecting through DDS failed (${errorText(err)}); trying the VM service directly`);
      }
    }
    client ??= await connectVmService(url, { logger: this.logger });
    if (this.ended) {
      await client.close().catch(() => {});
      throw new SessionEndedError();
    }
    this.client = client;
    this.viaDds = probe.kind === 'dds' || client.redirected || (await client.isDds());
    client.onEvent((streamId, event, meta) => this.onEvent(client, streamId, event, meta));
    client.onClose((info) => this.onClientClose(client, info));
  }

  private onClientClose(client: VmServiceClient, info: CloseInfo): void {
    if (client !== this.client || this.ended) return;
    this.active = false;
    this.clearTimers();
    if (info.local) return;
    this.logger.info(`VM service connection of ${this.name} closed (${info.code}); reconnecting`);
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const url = this.target.reconnectUrl ?? this.target.wsUrl;
    for (const delay of this.deps.reconnectDelaysMs ?? RECONNECT_DELAYS_MS) {
      await sleep(delay);
      if (this.ended) return;
      try {
        await this.connect(url);
        const vm = await this.requireClient().call<VmJson>('getVM', {}, 5000);
        if (!this.identity || !sameVmProcess(this.identity, { pid: vm.pid ?? -1, startTime: vm.startTime ?? 0 })) {
          throw new DifferentVmError(
            `A different VM is listening at this address (pid ${vm.pid}/${vm.startTime}, expected ${this.identity?.pid}/${this.identity?.startTime})`,
          );
        }
        await this.requireClient().streamListen('Isolate');
        await this.loadIsolates(vm);
        await this.activate();
        if (this.ended) throw new SessionEndedError();
        this.logger.info(`reconnected to ${this.name}${this.viaDds ? ' via DDS' : ''}`);
        return;
      } catch (err) {
        this.active = false;
        this.clearTimers();
        const c = this.client;
        this.client = undefined;
        await c?.close().catch(() => {});
        this.logger.debug(`reconnect to ${this.name} failed: ${errorText(err)}`);
        if (err instanceof DifferentVmError || err instanceof SessionEndedError) break;
      }
    }
    if (!this.ended) await this.end('the app stopped or the device was disconnected', { unexpected: true });
  }

  /* ───────────────────────────── VM / isolates ───────────────────────────── */

  private async loadVm(): Promise<void> {
    const client = this.requireClient();
    await client.streamListen('Isolate');
    const vm = await client.call<VmJson>('getVM', {}, 8000);
    if (typeof vm.pid !== 'number') throw new Error('The VM service did not report a process id');
    this.identity = { pid: vm.pid, startTime: typeof vm.startTime === 'number' ? vm.startTime : 0, os: vm.operatingSystem ?? '' };
    await this.loadIsolates(vm);
    if (!this.mainIsolateId) {
      // Attached during startup: give the main isolate a moment to appear.
      for (let i = 0; i < 20 && !this.mainIsolateId; i++) await sleep(100);
    }
  }

  private async loadIsolates(vm: VmJson): Promise<void> {
    const refs = (vm.isolates ?? []).filter((i) => i && i.id && !i.isSystemIsolate).slice(0, 32);
    const live = new Set(refs.map((r) => r.id));
    for (const id of [...this.isolates.keys()]) if (!live.has(id)) this.removeIsolate(id);
    for (const g of vm.isolateGroups ?? []) if (g.id && g.name) this.groupNames.set(g.id, g.name);
    await Promise.all(refs.map((r) => this.refreshIsolate(r.id)));
    this.pickMainIsolate();
  }

  private async refreshIsolate(isolateId: string): Promise<IsolateInfo | undefined> {
    let r: IsolateJson | undefined;
    try {
      r = await this.requireClient().call<IsolateJson>('getIsolate', { isolateId }, 8000);
    } catch (err) {
      this.logger.debug(`getIsolate ${isolateId} failed: ${errorText(err)}`);
      return this.isolates.get(isolateId);
    }
    if (!r || r.type === 'Sentinel' || r.isSystemIsolate) {
      this.removeIsolate(isolateId);
      return undefined;
    }
    const existing = this.isolates.get(isolateId);
    const extensions = new Set(r.extensionRPCs ?? []);
    if (existing) for (const e of existing.extensions) extensions.add(e);
    const isFlutter =
      [...extensions].some((e) => e.startsWith('ext.flutter.')) ||
      (r.libraries ?? []).some((l) => typeof l.uri === 'string' && l.uri.startsWith('package:flutter/'));
    const info: IsolateInfo = {
      id: isolateId,
      name: r.name ?? existing?.name ?? 'isolate',
      extensions,
      paused: PAUSE_KINDS.has(r.pauseEvent?.kind ?? ''),
      isFlutter: isFlutter || (existing?.isFlutter ?? false),
      rootLib: r.rootLib?.uri ?? existing?.rootLib,
      groupId: r.isolateGroupId ?? existing?.groupId,
      firstSeen: existing?.firstSeen ?? Date.now(),
      httpEnabled: existing?.httpEnabled ?? false,
      httpBusy: existing?.httpBusy ?? false,
    };
    this.isolates.set(isolateId, info);
    return info;
  }

  private removeIsolate(isolateId: string): void {
    if (!this.isolates.delete(isolateId)) return;
    this.state?.http.forgetIsolate(isolateId);
    if (isolateId === this.mainIsolateId) {
      this.mainIsolateId = undefined;
      this.frames.reset();
      // A hot restart brings a new main isolate right away; only clear the actions if none comes.
      if (this.mainLostTimer) clearTimeout(this.mainLostTimer);
      this.mainLostTimer = setTimeout(() => {
        this.mainLostTimer = undefined;
        if (!this.mainIsolateId) this.actions.publish();
      }, 3000);
      this.mainLostTimer.unref?.();
    }
  }

  private mainIsolate(): IsolateInfo | undefined {
    return this.mainIsolateId ? this.isolates.get(this.mainIsolateId) : undefined;
  }

  private isFlutter(): boolean {
    return this.mainIsolate()?.isFlutter ?? [...this.isolates.values()].some((i) => i.isFlutter);
  }

  /**
   * Flutter's root isolate and a Dart program's isolate are both named "main". A newer "main" means a hot
   * restart; without any "main", the oldest isolate is the root one (never a later background isolate).
   */
  private pickMainIsolate(): void {
    const all = [...this.isolates.values()];
    if (all.length === 0) return;
    const named = all.filter((i) => i.name === 'main');
    const current = this.mainIsolate();
    if (current && (current.name === 'main' || named.length === 0)) {
      if (!named.some((i) => i.id !== current.id && i.firstSeen > current.firstSeen)) return;
    }
    const candidate = named.length
      ? named.reduce((best, i) => (i.firstSeen >= best.firstSeen ? i : best))
      : all.reduce((best, i) => (i.firstSeen < best.firstSeen ? i : best));
    if (candidate.id === this.mainIsolateId) return;
    const previous = this.mainIsolateId;
    this.mainIsolateId = candidate.id;
    if (this.mainLostTimer) clearTimeout(this.mainLostTimer);
    this.mainLostTimer = undefined;
    if (this.hadMainIsolate && previous !== candidate.id && this.appId) {
      // A hot restart resets the framework's debug flags: re-read them and re-advertise the actions.
      this.actions.reset();
      this.frames.reset();
      this.systemLine(`Hot restart: ${this.name}`, 'vm.hotRestart', { kind: 'lifecycle', params: { app: this.name } });
      void this.ensureHttp(candidate.id);
      void this.queryRefreshRate();
      this.actions.schedule(true);
    }
    this.hadMainIsolate = true;
  }

  /* ───────────────────────────── app session ───────────────────────────── */

  private async openAppSession(): Promise<void> {
    const ctx = this.deps.ctx;
    const id = this.identity!;
    const main = this.mainIsolate();
    let deviceId = this.target.deviceId;
    let host: HostProcessInfo = {};
    if (!deviceId || deviceId.startsWith('ios-sim:')) {
      host = await inspectHostProcess(id.pid, id.os);
    }
    if (!deviceId && host.simulatorUdid) {
      const simId = `ios-sim:${host.simulatorUdid}`;
      if (ctx.getDevices().some((d) => d.id === simId)) deviceId = simId;
    }
    if (!deviceId && !host.simulatorUdid && (id.os === 'android' || id.os === 'ios')) {
      deviceId = uniqueOnlineDevice(ctx.getDevices(), id.os);
    }
    const groupName = main?.groupId ? this.groupNames.get(main.groupId) : undefined;
    const packageName = packageNameFromLibraryUri(main?.rootLib) ?? packageNameFromLibraryUri(groupName);
    const sdkApp = sdkSessionForPid(ctx.getApps(), deviceId, id.pid)?.app;
    const processName = this.target.hints?.processName ?? this.deps.processName(deviceId, id.pid);
    let debug: boolean | undefined = true;
    if (main?.isFlutter) {
      const flutterExts = [...main.extensions].some((e) => e.startsWith('ext.flutter.'));
      debug = flutterExts ? main.extensions.has('ext.flutter.debugPaint') : undefined;
    }
    const bundle = host.bundle ?? (sdkApp ? undefined : await this.deviceAppBundle(deviceId, id.pid, processName));
    this.app = deriveAppInfo({ packageName, processName, bundle, sdkApp, pid: id.pid, debug });
    // Stable across re-attaches (the reported start time jitters): reuse the first one seen.
    const resolved = this.deps.states.resolve(id.pid, id.startTime);
    this.state = resolved.state;
    id.startTime = resolved.startTime;

    const virtual = ctx.sdk.openVirtual({
      transport: 'vm-service',
      deviceId,
      remote: redactServiceUrl(this.target.displayUrl),
    });
    this.virtual = virtual;
    virtual.onMessage((msg) => this.onServerMessage(msg));
    const hello: SdkHello = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      sdk: { name: 'durbun-vm-service', version: SERVER_VERSION, platform: 'dart-vm' },
      app: this.app,
      device: deviceHintsFor(id.os, { simulatorUdid: host.simulatorUdid }),
      session: `vm:${id.pid}:${id.startTime}`,
      capabilities: this.capabilities(),
      actions: this.actions.descriptors(),
      ts: Date.now(),
    };
    this.actions.markAdvertised(hello.actions);
    virtual.send(hello);
    this.appId = await withTimeout(virtual.appId, WELCOME_TIMEOUT_MS, 'The app session was not accepted by the server');
    this.deviceId = deviceId ?? ctx.getApps().find((a) => a.id === this.appId)?.deviceId;
  }

  /**
   * Identity from the device's own report (SPEC §10.2 DeviceApp) for a VM on a physical device, when it is
   * certain (deviceAppForVm); otherwise the VM's own identity stays (Dart package name). On an iPhone whose
   * apps Dürbün tracks, wait briefly for the new process's pid.
   */
  private async deviceAppBundle(deviceId: string | undefined, pid: number, processName: string | undefined): Promise<BundleInfo | undefined> {
    if (!deviceId || !(deviceId.startsWith('ios:') || deviceId.startsWith('android:'))) return undefined;
    const deviceApps = (): DeviceApp[] => {
      try {
        return this.deps.ctx.getDeviceApps();
      } catch {
        return [];
      }
    };
    let list = deviceApps();
    let app = deviceAppForVm(list, deviceId, pid, processName);
    const tracked = list.some((a) => a.deviceId === deviceId);
    const waitMs = deviceId.startsWith('ios:') && tracked ? (this.deps.deviceAppWaitMs ?? DEVICE_APP_WAIT_MS) : 0;
    for (let waited = 0; !app && waited < waitMs && !this.ended; waited += DEVICE_APP_POLL_MS) {
      await sleep(DEVICE_APP_POLL_MS);
      list = deviceApps();
      app = deviceAppForVm(list, deviceId, pid, processName);
    }
    if (!app) return undefined;
    return {
      id: app.id,
      ...(app.name ? { name: app.name } : {}),
      ...(app.version ? { version: app.version } : {}),
      ...(app.build ? { build: app.build } : {}),
    };
  }

  /** Static for the session: extensions may register only after attach (startup), so be inclusive. */
  private capabilities(): SdkCapability[] {
    const caps: SdkCapability[] = ['logs', 'metrics', 'commands'];
    const main = this.mainIsolate();
    if (!main || main.extensions.has('ext.dart.io.getHttpProfile') || main.extensions.size === 0) caps.push('network');
    return caps;
  }

  private send(message: SdkToServer): void {
    const v = this.virtual;
    if (!v || v.closed) return;
    try {
      v.send(message);
    } catch (err) {
      this.logger.debug(`virtual session send failed: ${errorText(err)}`);
    }
  }

  private onServerMessage(msg: ServerToSdk): void {
    switch (msg.type) {
      case 'welcome':
      case 'config':
        this.applyConfig(msg.config);
        return;
      case 'command':
        void this.actions.handle(msg);
        return;
      case 'ping':
        this.send({ type: 'pong', ts: Date.now() });
        return;
      default:
        return; // mocks: the VM service cannot mock requests
    }
  }

  private applyConfig(config: SdkConfig | undefined): void {
    if (!config) return;
    const intervalChanged = config.metricsIntervalMs !== this.config.metricsIntervalMs;
    this.config = { ...this.config, ...config };
    if (!this.active) return;
    void this.syncStdio();
    if (intervalChanged) this.scheduleMetrics();
  }

  /* ───────────────────────────── activation ───────────────────────────── */

  /** Subscribe streams and start the loops (first attach and every reconnect). */
  private async activate(): Promise<void> {
    const client = this.requireClient();
    const state = this.state!;
    this.stdioActive = false;
    state.http.bind({
      getProfile: async (isolateId, since) => {
        const p = await this.requireClient().callExtension<HttpProfileJson>(
          'ext.dart.io.getHttpProfile',
          isolateId,
          since !== undefined ? { updatedSince: since } : {},
          8000,
        );
        if (typeof p?.timestamp === 'number') this.clock.observe(p.timestamp / 1000);
        return p;
      },
      getRequest: (isolateId, id) =>
        this.requireClient().callExtension<HttpProfileRequestJson>('ext.dart.io.getHttpProfileRequest', isolateId, { id }, 20_000),
      clearProfile: async (isolateId) => {
        await this.requireClient().callExtension('ext.dart.io.clearHttpProfile', isolateId, {}, 5000);
      },
      emit: (msg) => this.send(msg),
      policy: () => ({ captureBodies: this.config.captureBodies, maxBodyBytes: this.config.maxBodyBytes }),
      now: () => Date.now(),
      logger: this.logger,
    });
    for (const info of this.isolates.values()) info.httpEnabled = false;
    // Active before subscribing: DDS replays history (Logging/Extension/Stdout) before streamListen returns.
    this.active = true;
    await client.streamListen('Debug');
    await client.streamListen('Extension');
    await client.streamListen('Logging');
    await this.syncStdio();
    this.capturingHttp = !this.networkCoveredBySdk();
    if (this.capturingHttp) for (const id of this.isolates.keys()) await this.ensureHttp(id);
    this.scheduleHttpPoll(HTTP_POLL_MS);
    this.scheduleMetrics();
    void this.queryRefreshRate();
    this.actions.schedule(true);
  }

  private networkCoveredBySdk(): boolean {
    return !!sdkSessionForPid(this.deps.ctx.getApps(), this.deviceId, this.identity?.pid, 'network');
  }

  /** Stdout/Stderr only when nothing else delivers the app's output (device logs or an SDK session). */
  private async syncStdio(): Promise<void> {
    const want =
      !this.config.deviceLogsAvailable &&
      !sdkSessionForPid(this.deps.ctx.getApps(), this.deviceId, this.identity?.pid, 'logs');
    if (want === this.stdioActive) return;
    this.stdioActive = want;
    const client = this.client;
    if (!client || client.closed) return;
    for (const stream of ['Stdout', 'Stderr']) {
      try {
        if (want) await client.streamListen(stream);
        else await client.streamCancel(stream);
      } catch (err) {
        this.logger.debug(`${want ? 'subscribing to' : 'cancelling'} ${stream} failed: ${errorText(err)}`);
      }
    }
    if (!want) {
      this.stdout.flush();
      this.stderr.flush();
    }
  }

  /** Re-evaluate SDK overlap (an SDK session of the same process may connect or leave later). */
  private reconcileCapture(): void {
    const now = Date.now();
    if (now - this.lastReconcile < 5000) return;
    this.lastReconcile = now;
    void this.syncStdio();
    const capture = !this.networkCoveredBySdk();
    if (capture === this.capturingHttp) return;
    this.capturingHttp = capture;
    if (capture) {
      for (const id of this.isolates.keys()) void this.ensureHttp(id);
    } else {
      this.logger.info(`${this.name}: an SDK session captures the network; pausing VM HTTP profiling`);
      void this.disableOwnProfiling();
    }
  }

  /* ───────────────────────────── events ───────────────────────────── */

  private onEvent(client: VmServiceClient, streamId: string, event: VmEventJson, meta: EventMeta): void {
    if (client !== this.client || this.ended) return;
    if (!meta.historical) this.clock.observe(event.timestamp);
    try {
      switch (streamId) {
        case 'Logging':
          this.onLogging(event as LoggingEventJson, meta.historical);
          return;
        case 'Stdout':
        case 'Stderr':
          this.onStdio(streamId, event, meta.historical);
          return;
        case 'Extension':
          this.onExtension(event, meta.historical);
          return;
        case 'Isolate':
          this.onIsolateEvent(event);
          return;
        case 'Debug':
          this.onDebugEvent(event);
          return;
        default:
          return;
      }
    } catch (err) {
      this.logger.warn(`handling a ${streamId} event failed: ${errorText(err)}`);
    }
  }

  private queueLog(log: AppLog): void {
    this.logChain = this.logChain.then(() => this.send({ type: 'log', ...log }));
  }

  private onLogging(event: LoggingEventJson, historical: boolean): void {
    if (!this.active || !this.state) return;
    const key = loggingEventKey(event);
    if (historical && this.state.replay.seen('Logging', event.timestamp, key)) return;
    this.state.replay.mark('Logging', event.timestamp, key);
    // Under a flood, skip RPC resolution (truncated text is still readable) to keep up.
    const resolver = this.pendingLogs > 500 ? undefined : this.resolver;
    this.pendingLogs++;
    const converted = loggingEventToAppLog(event, resolver, { maxChars: MAX_TEXT_CHARS }).catch((err) => {
      this.logger.debug(`log conversion failed: ${errorText(err)}`);
      return undefined;
    });
    this.logChain = this.logChain.then(async () => {
      const log = await converted;
      this.pendingLogs--;
      if (log) this.send({ type: 'log', ...log });
    });
  }

  private onStdio(streamId: 'Stdout' | 'Stderr', event: VmEventJson, historical: boolean): void {
    if (!this.active || !this.state || !this.stdioActive) return;
    const bytes = typeof event.bytes === 'string' ? event.bytes : '';
    if (!bytes) return;
    const key = bytes.slice(0, 96);
    if (historical && this.state.replay.seen(streamId, event.timestamp, key)) return;
    this.state.replay.mark(streamId, event.timestamp, key);
    const text = Buffer.from(bytes, 'base64').toString('utf8');
    const ts = typeof event.timestamp === 'number' ? event.timestamp : this.clock.deviceNow();
    (streamId === 'Stdout' ? this.stdout : this.stderr).push(text, ts);
  }

  private onExtension(event: VmEventJson, historical: boolean): void {
    if (!this.active || !this.state) return;
    const kind = typeof event.extensionKind === 'string' ? event.extensionKind : '';
    const data = (event.extensionData ?? {}) as Record<string, unknown>;
    const ts = typeof event.timestamp === 'number' ? event.timestamp : this.clock.deviceNow();
    const dedupe = () => {
      const key = `${kind}|${JSON.stringify(data).slice(0, 160)}`;
      if (historical && this.state!.replay.seen('Extension', event.timestamp, key)) return true;
      this.state!.replay.mark('Extension', event.timestamp, key);
      return false;
    };
    switch (kind) {
      case 'Flutter.Frame': {
        if (historical) return;
        const frame = parseFlutterFrame(data);
        if (frame) this.frames.add(frame);
        return;
      }
      case 'Flutter.Error': {
        if (dedupe()) return;
        const text =
          typeof data.renderedErrorText === 'string' && data.renderedErrorText.trim()
            ? data.renderedErrorText
            : typeof data.description === 'string'
              ? data.description
              : 'Flutter error';
        this.queueLog({ ts, level: 'error', tag: 'flutter', message: text, kind: 'flutter-error' });
        return;
      }
      case 'Flutter.Navigation': {
        if (dedupe()) return;
        const label = routeLabel(data.route);
        if (label) this.queueLog({ ts, level: 'info', tag: 'navigation', message: `→ ${label}`, kind: 'text' });
        return;
      }
      case 'Flutter.ServiceExtensionStateChanged':
        if (typeof data.extension === 'string') this.actions.onStateChanged(data.extension, data.value);
        return;
      case 'HttpTimelineLoggingStateChange': {
        if (historical || data.enabled !== false || !this.capturingHttp) return;
        const isolateId = typeof data.isolateId === 'string' ? data.isolateId : event.isolate?.id;
        const info = isolateId ? this.isolates.get(isolateId) : undefined;
        if (!info) return;
        // Another tool turned profiling off; Dürbün still needs it.
        info.httpEnabled = false;
        void this.ensureHttp(info.id);
        return;
      }
      default:
        return;
    }
  }

  private onIsolateEvent(event: VmEventJson): void {
    const isolateId = event.isolate?.id;
    if (!isolateId || event.isolate?.isSystemIsolate) return;
    switch (event.kind) {
      case 'IsolateStart':
      case 'IsolateRunnable':
        void this.refreshIsolate(isolateId).then((info) => {
          if (!info || this.ended) return;
          this.pickMainIsolate();
          void this.ensureHttp(isolateId);
          if (isolateId === this.mainIsolateId) this.actions.schedule(true);
        });
        return;
      case 'IsolateExit':
        this.removeIsolate(isolateId);
        this.pickMainIsolate();
        return;
      case 'IsolateUpdate': {
        const info = this.isolates.get(isolateId);
        if (info && typeof event.isolate?.name === 'string') info.name = event.isolate.name;
        return;
      }
      case 'IsolateReload':
        if (isolateId === this.mainIsolateId && this.active) {
          this.systemLine(`Hot reload: ${this.name}`, 'vm.hotReload', { kind: 'lifecycle', params: { app: this.name } });
        }
        return;
      case 'ServiceExtensionAdded': {
        const ext = typeof event.extensionRPC === 'string' ? event.extensionRPC : undefined;
        const info = this.isolates.get(isolateId);
        if (!info || !ext) {
          void this.refreshIsolate(isolateId).then(() => this.pickMainIsolate());
          return;
        }
        info.extensions.add(ext);
        if (ext.startsWith('ext.flutter.')) info.isFlutter = true;
        if (ext.startsWith('ext.dart.io.')) void this.ensureHttp(isolateId);
        if (isolateId === this.mainIsolateId && ext.startsWith('ext.flutter.')) this.actions.schedule(true);
        return;
      }
      default:
        return;
    }
  }

  private onDebugEvent(event: VmEventJson): void {
    const info = event.isolate?.id ? this.isolates.get(event.isolate.id) : undefined;
    if (!info || !event.kind) return;
    if (PAUSE_KINDS.has(event.kind)) info.paused = true;
    else if (event.kind === 'Resume') info.paused = false;
  }

  /* ───────────────────────────── network ───────────────────────────── */

  private async ensureHttp(isolateId: string): Promise<void> {
    const info = this.isolates.get(isolateId);
    const state = this.state;
    if (!info || !state || !this.active || !this.capturingHttp || info.httpEnabled || info.httpBusy) return;
    if (!info.extensions.has('ext.dart.io.httpEnableTimelineLogging') || !info.extensions.has('ext.dart.io.getHttpProfile')) {
      return;
    }
    const age = Date.now() - info.firstSeen;
    if (isolateId !== this.mainIsolateId && age < BACKGROUND_ISOLATE_HTTP_DELAY_MS) {
      const t = setTimeout(() => {
        this.isolateTimers.delete(t);
        void this.ensureHttp(isolateId);
      }, BACKGROUND_ISOLATE_HTTP_DELAY_MS - age + 50);
      t.unref?.();
      this.isolateTimers.add(t);
      return;
    }
    info.httpBusy = true;
    try {
      const client = this.requireClient();
      const current = await client.callExtension<{ enabled?: boolean }>('ext.dart.io.httpEnableTimelineLogging', isolateId, {}, 5000);
      if (current?.enabled !== true) {
        // 'enable' is the pre-1.4 dart:io parameter name; current SDKs read 'enabled'.
        await client.callExtension('ext.dart.io.httpEnableTimelineLogging', isolateId, { enabled: true, enable: true }, 5000);
        state.httpEnabledByUs.add(isolateId);
      }
      state.http.setClearingAllowed(isolateId, state.httpEnabledByUs.has(isolateId));
      info.httpEnabled = true;
    } catch (err) {
      this.logger.debug(`enabling HTTP profiling in ${isolateId} failed: ${errorText(err)}`);
    } finally {
      info.httpBusy = false;
    }
  }

  /** Turn off what Dürbün turned on, so a still-running app stops accumulating its HTTP profile. */
  private async disableOwnProfiling(): Promise<void> {
    const state = this.state;
    const client = this.client;
    if (!state || !client || client.closed) return;
    for (const isolateId of [...state.httpEnabledByUs]) {
      if (!this.isolates.has(isolateId)) continue;
      try {
        await client.callExtension('ext.dart.io.httpEnableTimelineLogging', isolateId, { enabled: false, enable: false }, 2000);
        await client.callExtension('ext.dart.io.clearHttpProfile', isolateId, {}, 2000);
        state.httpEnabledByUs.delete(isolateId);
        const info = this.isolates.get(isolateId);
        if (info) info.httpEnabled = false;
      } catch (err) {
        this.logger.debug(`disabling HTTP profiling in ${isolateId} failed: ${errorText(err)}`);
      }
    }
  }

  private scheduleHttpPoll(delayMs: number): void {
    if (this.httpTimer) clearTimeout(this.httpTimer);
    this.httpTimer = setTimeout(() => {
      this.httpTimer = undefined;
      void this.pollHttp();
    }, delayMs);
    this.httpTimer.unref?.();
  }

  private async pollHttp(): Promise<void> {
    if (!this.active || !this.state) return;
    let failed = false;
    if (this.capturingHttp) {
      for (const info of [...this.isolates.values()]) {
        if (!info.httpEnabled || info.paused) continue;
        try {
          await this.state.http.poll(info.id);
        } catch (err) {
          if (err instanceof RpcError && err.code === RpcCodes.methodNotFound) info.httpEnabled = false;
          else failed = true;
          this.logger.debug(`HTTP profile poll of ${info.id} failed: ${errorText(err)}`);
        }
        if (!this.active) return;
      }
    }
    this.httpFailures = failed ? Math.min(this.httpFailures + 1, 4) : 0;
    this.scheduleHttpPoll(Math.min(HTTP_POLL_MS * 2 ** this.httpFailures, 10_000));
  }

  /* ───────────────────────────── metrics ───────────────────────────── */

  private metricsInterval(): number {
    const ms = Number(this.config.metricsIntervalMs);
    return Number.isFinite(ms) ? Math.min(Math.max(ms, 250), 60_000) : 1000;
  }

  private scheduleMetrics(): void {
    if (this.metricsTimer) clearTimeout(this.metricsTimer);
    this.metricsTimer = setTimeout(() => {
      this.metricsTimer = undefined;
      void this.metricsTick();
    }, this.metricsInterval());
    this.metricsTimer.unref?.();
  }

  private async metricsTick(): Promise<void> {
    if (!this.active) return;
    if (this.virtual?.closed) {
      void this.end('the server closed the app session', { cleanup: true });
      return;
    }
    const interval = this.metricsInterval();
    const client = this.client;
    const main = this.mainIsolateId;
    const [mem, vm] = await Promise.all([
      main && client
        ? client.call<{ heapUsage?: number; externalUsage?: number }>('getMemoryUsage', { isolateId: main }, 5000).catch(() => undefined)
        : Promise.resolve(undefined),
      client ? client.call<VmJson>('getVM', {}, 5000).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    if (!this.active) return;
    const sample: SdkMetric = { type: 'metric', ts: this.clock.deviceNow() };
    if (mem && typeof mem.heapUsage === 'number') {
      sample.heapMB = round((mem.heapUsage + (typeof mem.externalUsage === 'number' ? mem.externalUsage : 0)) / MIB, 2);
    }
    if (vm && typeof vm._currentRSS === 'number' && vm._currentRSS > 0) sample.memoryMB = round(vm._currentRSS / MIB, 1);
    const frameSample = this.frames.sample(interval);
    if (frameSample) Object.assign(sample, frameSample);
    if (Object.keys(sample).length > 2) this.send(sample);
    this.reconcileCapture();
    this.scheduleMetrics();
  }

  /** Display refresh rate sets the jank budget (8.3 ms at 120 Hz); Flutter engines only. */
  private async queryRefreshRate(): Promise<void> {
    if (!this.isFlutter()) return;
    try {
      const client = this.requireClient();
      const list = await client.call<{ views?: { id?: string; isolate?: { id?: string } }[] }>('_flutter.listViews', {}, 3000);
      const views = list.views ?? [];
      const view = views.find((v) => v.isolate?.id === this.mainIsolateId) ?? views[0];
      if (!view?.id) return;
      const rate = await client.call<{ fps?: number }>('_flutter.getDisplayRefreshRate', { viewId: view.id }, 3000);
      if (typeof rate.fps === 'number') this.frames.setRefreshRate(rate.fps);
    } catch (err) {
      this.logger.debug(`display refresh rate unavailable: ${errorText(err)}`);
    }
  }

  /* ───────────────────────────── actions ───────────────────────────── */

  private valueContext(): ValueContext {
    return { nativePlatform: nativeTargetPlatform(this.identity?.os) };
  }

  /* ───────────────────────────── hub output ───────────────────────────── */

  private systemLine(
    message: string,
    code: string,
    opts: { level?: LogLevel; kind?: LogKind; params?: I18nParams } = {},
  ): void {
    if (!this.deviceId) return;
    try {
      this.deps.ctx.hub.pushSystemLog(this.deviceId, {
        message,
        code,
        level: opts.level ?? 'info',
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.params ? { params: opts.params } : {}),
        ...(this.appId ? { appId: this.appId } : {}),
      });
    } catch (err) {
      this.logger.debug(`pushSystemLog failed: ${errorText(err)}`);
    }
  }

  private notice(level: 'info' | 'success' | 'warn' | 'error', message: string, code: string, params?: I18nParams): void {
    try {
      this.deps.ctx.hub.notice({
        level,
        message,
        code,
        ...(params ? { params } : {}),
        ...(this.deviceId ? { deviceId: this.deviceId } : {}),
        ...(this.appId ? { appId: this.appId } : {}),
      });
    } catch (err) {
      this.logger.debug(`notice failed: ${errorText(err)}`);
    }
  }
}

/** Route name from a `Flutter.Navigation` event (`{route: {description, settings: {name, arguments}}}`). */
export function routeLabel(route: unknown): string | undefined {
  if (!route || typeof route !== 'object') return undefined;
  const r = route as { description?: unknown; settings?: { name?: unknown } };
  if (typeof r.settings?.name === 'string' && r.settings.name.trim()) return r.settings.name.trim();
  if (typeof r.description === 'string' && r.description.trim()) {
    const d = r.description.trim();
    const paren = d.indexOf('(');
    return (paren > 0 ? d.slice(0, paren) : d).trim();
  }
  return undefined;
}
