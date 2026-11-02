/**
 * In-memory fakes of the hub, SDK layer, drivers and VM module (implemented by other teams) plus
 * helpers to run the HTTP app on an ephemeral port and talk to it like the UI does.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import {
  DEFAULT_SETTINGS,
  type AppSession,
  type ClearTarget,
  type DeviceActionId,
  type DeviceActionResult,
  type DeviceInfo,
  type DriverStatus,
  type LogEntry,
  type MetricSample,
  type MockRule,
  type NetworkDetail,
  type NetworkEntry,
  type ProcessUpdate,
  type SdkConfig,
  type ServerSettings,
  type ServerToUi,
  type SessionExport,
  type ToolCheck,
  type UiCommand,
  type UiNotice,
} from '@durbun/protocol';
import { loadConfig, type ConfigStore } from '../../src/config';
import { createHttpApp, type HttpApp, type HttpAppDeps } from '../../src/http/app';
import type {
  ClearEvent,
  DeviceDriver,
  DriverContext,
  FlutterVmModule,
  Hub,
  HubChange,
  SdkAttachMeta,
  SdkLayer,
  SystemLogInput,
  VirtualSdkSession,
} from '../../src/types';
import { silentLogger } from '../../src/util/logger';

/* ────────────────────────────── sample data ────────────────────────────── */

export function sampleDevice(id = 'android:R5CT1234', patch: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id,
    platform: 'android',
    kind: 'physical',
    name: 'Pixel 8',
    model: 'Pixel 8',
    manufacturer: 'Google',
    osVersion: '15',
    apiLevel: 35,
    serial: id.split(':')[1],
    connection: 'usb',
    state: 'online',
    logs: { status: 'streaming', via: 'logcat' },
    actions: ['screenshot', 'open-url', 'list-apps'],
    firstSeen: 1_762_070_000_000,
    lastSeen: 1_762_070_000_000,
    ...patch,
  };
}

export function sampleApp(id = 'app:1', patch: Partial<AppSession> = {}): AppSession {
  return {
    id,
    sessionKey: 'k-1',
    deviceId: 'android:R5CT1234',
    sdk: { name: 'durbun-flutter', version: '0.1.0', platform: 'flutter' },
    app: { name: 'Pati', id: 'com.mykynk.pati', version: '1.4.0', pid: 12345, processName: 'com.mykynk.pati' },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: 1_762_070_000_000,
    capabilities: ['logs', 'network', 'mocks', 'commands'],
    actions: [{ id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', group: 'flutter', value: false }],
    stats: { logs: 0, requests: 0, errors: 0 },
    ...patch,
  };
}

const LOGCAT_SAMPLES: Omit<LogEntry, 'id' | 'ts' | 'deviceId'>[] = [
  { source: 'device', level: 'info', tag: 'ActivityManager', message: 'Start proc 12345:com.mykynk.pati/u0a312 for top-activity', pid: 1432, tid: 1501, process: 'system_server' },
  { source: 'device', level: 'debug', tag: 'OpenGLRenderer', message: 'Davey! duration=812ms; Flags=0, IntendedVsync=91234', pid: 12345, tid: 12380, process: 'com.mykynk.pati' },
  { source: 'device', level: 'info', tag: 'flutter', message: '[auth] Kullanıcı giriş yaptı {"userId":42}', pid: 12345, tid: 12398, process: 'com.mykynk.pati' },
  { source: 'device', level: 'warn', tag: 'chatty', message: 'uid=10312(com.mykynk.pati) RenderThread identical 4 lines', pid: 12345, tid: 12380 },
  { source: 'device', level: 'error', tag: 'AndroidRuntime', message: 'FATAL EXCEPTION: main\nProcess: com.mykynk.pati, PID: 12345\njava.lang.IllegalStateException: boom', pid: 12345, tid: 12345, kind: 'crash' },
];

export function sampleNetwork(id = 'app:1:7', patch: Partial<NetworkDetail> = {}): NetworkDetail {
  const body = JSON.stringify({ items: [{ id: 1, name: 'Karabaş' }, { id: 2, name: 'Pamuk' }], total: 2 });
  return {
    id,
    appId: 'app:1',
    deviceId: 'android:R5CT1234',
    source: 'dart:io',
    method: 'GET',
    url: 'https://api.pati.app/v1/pets?page=1&limit=20',
    host: 'api.pati.app',
    path: '/v1/pets?page=1&limit=20',
    startTs: 1_762_070_001_000,
    endTs: 1_762_070_001_123,
    duration: 123,
    state: 'complete',
    status: 200,
    statusText: 'OK',
    requestHeaders: [
      ['accept', 'application/json'],
      ['authorization', 'Bearer eyJhbGciOi.test'],
      ['cookie', 'session=abc123; theme=dark'],
    ],
    responseHeaders: [
      ['content-type', 'application/json; charset=utf-8'],
      ['content-length', String(body.length)],
      ['set-cookie', 'session=def456; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; Secure'],
      ['set-cookie', 'ab=1; Path=/'],
    ],
    responseBodySize: body.length,
    responseContentType: 'application/json; charset=utf-8',
    hasRequestBody: false,
    hasResponseBody: true,
    protocol: 'h2',
    remoteAddress: '104.18.32.7:443',
    timings: { dns: 4.2, connect: 18.5, tls: 12.1, send: 0.4, wait: 88.3, receive: 11.6 },
    responseBody: { encoding: 'utf8', data: body, size: body.length },
    ...patch,
  };
}

/* ────────────────────────────── hub ────────────────────────────── */

export class FakeHub implements Hub {
  devices = new Map<string, DeviceInfo>();
  apps = new Map<string, AppSession>();
  logs: LogEntry[] = [];
  network = new Map<string, NetworkDetail>();
  metrics: MetricSample[] = [];
  processes: ProcessUpdate[] = [];
  settings: ServerSettings;
  notices: UiNotice[] = [];
  cleared: ClearEvent[] = [];
  imported: { data: SessionExport; label: string }[] = [];
  desktopRequests: NetworkDetail[] = [];
  disposed = false;
  nextId = 1;
  private readonly changeListeners = new Set<(c: HubChange) => void>();
  private readonly clearListeners = new Set<(e: ClearEvent) => void>();
  private readonly noticeListeners = new Set<(n: UiNotice) => void>();
  private readonly logListeners = new Set<(l: LogEntry[]) => void>();

  constructor(settings: ServerSettings = DEFAULT_SETTINGS) {
    this.settings = settings;
  }

  /** Append realistic logcat-like lines to the buffer (no change emitted). */
  addLogs(count: number, deviceId = 'android:R5CT1234'): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = 0; i < count; i++) {
      const sample = LOGCAT_SAMPLES[i % LOGCAT_SAMPLES.length]!;
      const entry: LogEntry = { ...sample, id: this.nextId++, ts: 1_762_070_000_000 + i, deviceId };
      this.logs.push(entry);
      out.push(entry);
    }
    return out;
  }

  /** Deliver a change to subscribers like the real batcher does. */
  emit(change: Partial<HubChange>): void {
    const full: HubChange = { logs: [], network: [], devices: [], removedDevices: [], apps: [], metrics: [], processes: [], ...change };
    for (const l of this.changeListeners) l(full);
  }

  listenerCount(): number {
    return this.changeListeners.size;
  }

  upsertDevice(device: DeviceInfo): void {
    this.devices.set(device.id, device);
  }
  patchDevice(id: string, patch: Partial<DeviceInfo>): void {
    const d = this.devices.get(id);
    if (d) this.devices.set(id, { ...d, ...patch });
  }
  markDeviceDisconnected(id: string): void {
    this.patchDevice(id, { state: 'disconnected' });
  }
  pushDeviceLogs(deviceId: string, entries: Omit<LogEntry, 'id' | 'deviceId' | 'source'>[]): void {
    for (const e of entries) this.logs.push({ ...e, id: this.nextId++, deviceId, source: 'device' });
  }
  setProcess(update: Omit<ProcessUpdate, 'ts'> & { ts?: number }): void {
    this.processes.push({ ...update, ts: update.ts ?? Date.now() });
  }
  pushSystemLog(deviceId: string, input: SystemLogInput): LogEntry {
    const entry: LogEntry = { id: this.nextId++, ts: Date.now(), deviceId, source: 'system', level: input.level ?? 'info', tag: 'durbun', message: input.message, kind: input.kind, code: input.code, params: input.params };
    this.logs.push(entry);
    return entry;
  }
  pushMetrics(samples: MetricSample[]): void {
    this.metrics.push(...samples);
  }
  notice(notice: UiNotice): void {
    this.notices.push(notice);
    for (const l of this.noticeListeners) l(notice);
  }
  getDevices(): DeviceInfo[] {
    return [...this.devices.values()];
  }
  getDevice(id: string): DeviceInfo | undefined {
    return this.devices.get(id);
  }
  getApps(): AppSession[] {
    return [...this.apps.values()];
  }
  getApp(id: string): AppSession | undefined {
    return this.apps.get(id);
  }
  registerApp(input: Omit<AppSession, 'id' | 'stats'>): AppSession {
    const app: AppSession = { ...input, id: `app:${this.apps.size + 1}`, stats: { logs: 0, requests: 0, errors: 0 } };
    this.apps.set(app.id, app);
    return app;
  }
  patchApp(id: string, patch: Partial<AppSession>): void {
    const a = this.apps.get(id);
    if (a) this.apps.set(id, { ...a, ...patch });
  }
  markAppDisconnected(id: string): void {
    this.patchApp(id, { connected: false });
  }
  pushAppLog(): LogEntry | undefined {
    return undefined;
  }
  netRequest(): void {}
  netResponse(): void {}
  netError(): void {}
  pushAppMetrics(): void {}
  recordDesktopRequest(detail: NetworkDetail): NetworkEntry {
    this.desktopRequests.push(detail);
    this.network.set(detail.id, detail);
    const { requestBody: _rq, responseBody: _rs, ...entry } = detail;
    return entry;
  }
  getLogs(opts?: { afterId?: number; limit?: number }): LogEntry[] {
    let out = this.logs.filter((l) => l.id > (opts?.afterId ?? 0));
    if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
    return out;
  }
  getLogCount(): number {
    return this.logs.length;
  }
  getNetwork(): NetworkEntry[] {
    return [...this.network.values()].map(({ requestBody: _rq, responseBody: _rs, ...entry }) => entry);
  }
  getNetworkDetail(id: string): NetworkDetail | undefined {
    return this.network.get(id);
  }
  searchNetwork(text: string, opts?: { ids?: string[]; caseSensitive?: boolean }): string[] {
    const norm = (s: string) => (opts?.caseSensitive ? s : s.toLowerCase());
    const needle = norm(text);
    return [...this.network.values()]
      .filter((d) => !opts?.ids || opts.ids.includes(d.id))
      .filter((d) =>
        [d.url, ...d.requestHeaders.flat(), ...(d.responseHeaders ?? []).flat(), d.requestBody?.data ?? '', d.responseBody?.data ?? ''].some((s) =>
          norm(s).includes(needle),
        ),
      )
      .map((d) => d.id);
  }
  getMetrics(): MetricSample[] {
    return this.metrics;
  }
  getProcesses(): ProcessUpdate[] {
    return this.processes;
  }
  clear(target: ClearTarget, scope?: { deviceId?: string; appId?: string }): void {
    if (target === 'logs' || target === 'all') this.logs = [];
    if (target === 'network' || target === 'all') this.network.clear();
    const event: ClearEvent = { target, ...scope };
    this.cleared.push(event);
    for (const l of this.clearListeners) l(event);
  }
  addMarker(label?: string, deviceId?: string): LogEntry {
    return this.pushSystemLog(deviceId ?? 'all', { message: label ?? 'Marker', kind: 'marker', code: 'marker' });
  }
  exportSession(scope?: { deviceId?: string; appId?: string }): SessionExport {
    const logs = this.logs.filter((l) => (!scope?.deviceId || l.deviceId === scope.deviceId) && (!scope?.appId || l.appId === scope.appId));
    return {
      format: 'durbun-session',
      version: 1,
      exportedAt: 1_762_070_100_000,
      server: { version: '0.1.0' },
      devices: this.getDevices(),
      apps: this.getApps(),
      logs,
      network: [...this.network.values()],
      metrics: this.metrics,
    };
  }
  importSession(data: SessionExport, label: string): { deviceIds: string[] } {
    this.imported.push({ data, label });
    return { deviceIds: data.devices.map((_, i) => `import:${i + 1}`) };
  }
  setSettings(settings: ServerSettings): void {
    this.settings = settings;
  }
  subscribe(listener: (change: HubChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  onCleared(listener: (event: ClearEvent) => void): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }
  onNotice(listener: (notice: UiNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }
  onLogs(listener: (entries: LogEntry[]) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }
  dispose(): void {
    this.disposed = true;
  }
}

/* ────────────────────────────── SDK layer ────────────────────────────── */

export class FakeSdk implements SdkLayer {
  listenCalls: { port: number; host: string }[] = [];
  listenError: Error | undefined;
  mocks: MockRule[] = [];
  configPatches: Partial<SdkConfig>[] = [];
  commands: { appId: string; name: string; params?: Record<string, unknown> }[] = [];
  commandResult: DeviceActionResult = { ok: true, data: { toggled: true } };
  sockets: { ws: WebSocket; meta: SdkAttachMeta }[] = [];
  closed = false;

  attachStream(stream: Duplex): void {
    stream.destroy();
  }
  attachWebSocket(ws: WebSocket, meta: SdkAttachMeta): void {
    this.sockets.push({ ws, meta });
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
  }
  openVirtual(): VirtualSdkSession {
    throw new Error('not used in tests');
  }
  async listen(port: number, host: string): Promise<void> {
    this.listenCalls.push({ port, host });
    if (this.listenError) throw this.listenError;
  }
  setMocks(rules: MockRule[]): void {
    this.mocks = rules;
  }
  setConfig(patch: Partial<SdkConfig>): void {
    this.configPatches.push(patch);
  }
  async sendCommand(appId: string, name: string, params?: Record<string, unknown>): Promise<DeviceActionResult> {
    this.commands.push({ appId, name, params });
    return this.commandResult;
  }
  connectionCount(): number {
    return this.sockets.length;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/* ────────────────────────────── drivers ────────────────────────────── */

export class FakeDriver implements DeviceDriver {
  started = false;
  stopped = false;
  startCalls = 0;
  context: DriverContext | undefined;
  startError: Error | undefined;
  startDelayMs = 0;
  actions: { deviceId: string; action: DeviceActionId; params: Record<string, unknown> }[] = [];
  watches: { deviceId: string; target: { pid?: number; processName?: string }; enabled: boolean }[] = [];
  result: DeviceActionResult = { ok: true, data: { url: '/api/files/shot.png', file: '/tmp/shot.png' } };
  checkResult: ToolCheck[] = [];
  checksError: Error | undefined;
  supportsMetrics = true;

  constructor(
    readonly id: DeviceDriver['id'],
    private readonly prefix: string,
  ) {}

  async start(ctx: DriverContext): Promise<void> {
    this.startCalls++;
    if (this.startDelayMs) await new Promise((r) => setTimeout(r, this.startDelayMs).unref());
    if (this.startError) throw this.startError;
    this.context = ctx;
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
  }
  status(): DriverStatus {
    return { id: this.id, available: true, active: this.started };
  }
  async checks(): Promise<ToolCheck[]> {
    if (this.checksError) throw this.checksError;
    return this.checkResult;
  }
  owns(deviceId: string): boolean {
    return deviceId.startsWith(this.prefix);
  }
  async runAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
    this.actions.push({ deviceId, action, params });
    return this.result;
  }
  get watchMetrics(): DeviceDriver['watchMetrics'] {
    if (!this.supportsMetrics) return undefined;
    return (deviceId, target, enabled) => {
      this.watches.push({ deviceId, target, enabled });
    };
  }
}

export class FakeVm implements FlutterVmModule {
  attached: { input: string; opts?: { deviceId?: string } }[] = [];
  detached: string[] = [];
  started = false;
  stopped = false;
  attachError: Error | undefined;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  status(): DriverStatus {
    return { id: 'flutter-vm', available: true, active: this.started };
  }
  async checks(): Promise<ToolCheck[]> {
    return [{ id: 'flutter', label: 'Flutter SDK', status: 'ok', version: '3.38.0' }];
  }
  async attach(input: string, opts?: { deviceId?: string }): Promise<{ appId: string }> {
    if (this.attachError) throw this.attachError;
    this.attached.push({ input, opts });
    return { appId: 'app:vm-1' };
  }
  async detach(appId: string): Promise<void> {
    this.detached.push(appId);
  }
}

/* ────────────────────────────── app harness ────────────────────────────── */

export interface TestApp {
  app: HttpApp;
  hub: FakeHub;
  sdk: FakeSdk;
  android: FakeDriver;
  demo: FakeDriver;
  vm: FakeVm;
  config: ConfigStore;
  port: number;
  base: string;
  dir: string;
  close(): Promise<void>;
}

export async function makeTempDir(prefix = 'durbun-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function fakeContext(hub: Hub, config: ConfigStore): DriverContext {
  return {
    hub,
    getDevices: () => hub.getDevices(),
    getApps: () => hub.getApps(),
    onLogs: (l) => hub.onLogs(l),
    sdk: { attachStream: () => {}, openVirtual: () => ({}) as VirtualSdkSession },
    settings: () => config.settings,
    onSettings: (l) => config.onSettings((s) => l(s)),
    logger: silentLogger,
    tempDir: config.tempDir,
    fileUrl: (name) => `/api/files/${encodeURIComponent(name)}`,
    ports: { http: 0, sdk: 0 },
  };
}

export async function startTestApp(overrides: Partial<HttpAppDeps> = {}, opts: { lanOverride?: boolean } = {}): Promise<TestApp> {
  const dir = await makeTempDir();
  const config = await loadConfig(path.join(dir, 'data'), { lanOverride: opts.lanOverride });
  const hub = new FakeHub(config.settings);
  const sdk = new FakeSdk();
  const android = new FakeDriver('android', 'android:');
  const demo = new FakeDriver('demo', 'demo:');
  const vm = new FakeVm();
  const app = createHttpApp({
    hub,
    sdk,
    drivers: [android],
    vm,
    demo,
    config,
    logger: silentLogger,
    demoContext: fakeContext(hub, config),
    uiDir: null,
    ports: { http: 0, sdk: 39_751 },
    driverStatusIntervalMs: 40,
    ...overrides,
  });
  const port = await app.listen(0, '127.0.0.1');
  return {
    app,
    hub,
    sdk,
    android,
    demo,
    vm,
    config,
    port,
    base: `http://127.0.0.1:${port}`,
    dir,
    close: async () => {
      await app.close();
      await config.flush();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/* ────────────────────────────── UI WebSocket client ────────────────────────────── */

type Reply = Extract<ServerToUi, { type: 'reply' }>;

export class UiTestClient {
  readonly messages: ServerToUi[] = [];
  closeCode: number | undefined;
  private waiters: { match: (m: ServerToUi) => boolean; from: number; resolve: (m: ServerToUi) => void }[] = [];
  private closeWaiters: ((code: number) => void)[] = [];
  private seq = 0;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerToUi;
      this.messages.push(msg);
      const index = this.messages.length - 1;
      this.waiters = this.waiters.filter((w) => {
        if (index >= w.from && w.match(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      for (const w of this.closeWaiters) w(code);
    });
  }

  /** First message (at or after index `from`) matching `match`. */
  waitFor<T extends ServerToUi = ServerToUi>(match: (m: ServerToUi) => boolean, timeoutMs = 3_000, from = 0): Promise<T> {
    const existing = this.messages.slice(from).find(match);
    if (existing) return Promise.resolve(existing as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for a message; got: ${this.messages.map((m) => m.type).join(',')}`)), timeoutMs);
      this.waiters.push({
        match,
        from,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
      });
    });
  }

  waitForType<K extends ServerToUi['type']>(type: K, timeoutMs = 3_000, from = 0): Promise<Extract<ServerToUi, { type: K }>> {
    return this.waitFor((m) => m.type === type, timeoutMs, from);
  }

  /** Wait until the initial sync (history with done) finished. */
  async synced(): Promise<void> {
    await this.waitFor((m) => m.type === 'history' && m.done, 5_000);
  }

  /** Typed loosely on purpose: tests also send malformed commands. */
  async command(command: UiCommand | object, timeoutMs = 5_000): Promise<Reply> {
    const requestId = `r${++this.seq}`;
    const from = this.messages.length;
    this.ws.send(JSON.stringify({ type: 'command', requestId, command }));
    return this.waitFor<Reply>((m) => m.type === 'reply' && m.requestId === requestId, timeoutMs, from);
  }

  waitClose(timeoutMs = 5_000): Promise<number> {
    if (this.closeCode !== undefined) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export function connectUi(port: number, headers: Record<string, string> = { Origin: `http://localhost:${port}` }): Promise<UiTestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`, { headers });
    const client = new UiTestClient(ws); // attach listeners before the first message can arrive
    ws.once('open', () => resolve(client));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
}
