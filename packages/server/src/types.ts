/**
 * Server-internal contracts shared by the hub, SDK layer, platform drivers, Flutter VM module, demo
 * driver and HTTP layer. Owned by the lead: do not change existing signatures (add OPTIONAL members only,
 * and mention it in your report).
 *
 * Implementations live in:
 *   src/hub/index.ts               export function createHub(opts: CreateHubOptions): Hub
 *   src/sdk/index.ts               export function createSdkLayer(opts: CreateSdkLayerOptions): SdkLayer
 *   src/platform/index.ts          export function createPlatform(): Platform
 *   src/platform/flutterVm/index.ts export function createFlutterVmModule(): FlutterVmModule
 *   src/demo/index.ts              export function createDemoDriver(): DeviceDriver   (id 'demo')
 *   src/server.ts                  export async function startServer(opts: StartServerOptions): Promise<RunningServer>
 */
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import type {
  AppSession,
  DeviceApp,
  ClearTarget,
  DeviceActionId,
  DeviceActionResult,
  DeviceInfo,
  DriverId,
  DriverStatus,
  I18nParams,
  LogEntry,
  LogKind,
  LogLevel,
  MetricSample,
  MockRule,
  NetworkDetail,
  NetworkEntry,
  ProcessUpdate,
  SdkConfig,
  SdkLog,
  SdkNetError,
  SdkNetRequest,
  SdkNetResponse,
  SdkToServer,
  ServerSettings,
  ServerToSdk,
  SessionExport,
  ToolCheck,
  Transport,
  UiNotice,
} from '@durbun/protocol';

/* ────────────────────────────── Logging (internal diagnostics) ────────────────────────────── */

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

/* ────────────────────────────── Hub ────────────────────────────── */

/** A device log line before the hub assigns id/deviceId/source. */
export type DeviceLogInput = Omit<LogEntry, 'id' | 'deviceId' | 'source'>;

export interface SystemLogInput {
  message: string;
  level?: LogLevel;
  kind?: LogKind;
  code?: string;
  params?: I18nParams;
  data?: unknown;
  appId?: string;
}

/** What platform drivers / modules may write into the hub. */
export interface HubSink {
  /** Insert or replace a device (merge by id; the hub keeps firstSeen and emits device.connected lines). */
  upsertDevice(device: DeviceInfo): void;
  /** Shallow-merge a patch into a known device (ignored for unknown ids). */
  patchDevice(id: string, patch: Partial<DeviceInfo>): void;
  /** Mark a device disconnected; its logs stay. */
  markDeviceDisconnected(id: string, detail?: string, code?: string): void;
  /** Parsed device log lines (logcat / syslog / os_log), in arrival order. */
  pushDeviceLogs(deviceId: string, entries: DeviceLogInput[]): void;
  /** pid → process name knowledge (started/died/seen). */
  setProcess(update: Omit<ProcessUpdate, 'ts'> & { ts?: number }): void;
  /** Dürbün-generated line (lifecycle, marker, stream status) for a device. */
  pushSystemLog(deviceId: string, input: SystemLogInput): LogEntry;
  /** Samples from polling (adb / host ps). */
  pushMetrics(samples: MetricSample[]): void;
  /** Toast for connected UIs. */
  notice(notice: UiNotice): void;
  /**
   * Insert or merge an app the device reports (SPEC §10). Merge by `deviceId` + `id`: defined fields of
   * the input win, `pids`/`running` replace when given, `lastActivity` = max(old, input, now when absent),
   * `crashReports` adds `crashReportsDelta`, `processName: null` removes the process name. Emits a batched
   * `deviceApps` change only when something changed.
   */
  upsertDeviceApp(
    input: Pick<DeviceApp, 'deviceId' | 'id'> &
      Partial<Omit<DeviceApp, 'key' | 'deviceId' | 'id' | 'crashReports' | 'processName'>> & {
        crashReportsDelta?: number;
        /** A string sets it; null clears it (e.g. Android: 'com.foo:remote' once the main process runs). */
        processName?: string | null;
      },
  ): DeviceApp;
  /** Drop device apps of a device (`ids`), or all of them when `ids` is omitted (device removed). */
  removeDeviceApps(deviceId: string, ids?: string[]): void;
}

export interface HubChange {
  logs: LogEntry[];
  network: NetworkEntry[];
  devices: DeviceInfo[];
  removedDevices: string[];
  apps: AppSession[];
  metrics: MetricSample[];
  processes: ProcessUpdate[];
  deviceApps: DeviceApp[];
  removedDeviceApps: string[];
}

export interface ClearEvent {
  target: ClearTarget;
  deviceId?: string;
  appId?: string;
  bundleId?: string;
}

export interface Hub extends HubSink {
  /* devices & apps */
  getDevices(): DeviceInfo[];
  getDevice(id: string): DeviceInfo | undefined;
  getApps(): AppSession[];
  getApp(id: string): AppSession | undefined;
  getDeviceApps(): DeviceApp[];
  /** Register a new app session or reuse the one with the same sessionKey + deviceId (marks it connected). */
  registerApp(input: Omit<AppSession, 'id' | 'stats'>): AppSession;
  patchApp(id: string, patch: Partial<AppSession>): void;
  /** Mark an app session disconnected (pending requests → failed, lifecycle line). */
  markAppDisconnected(id: string): void;

  /* app data (called by the SDK layer) */
  pushAppLog(appId: string, log: Omit<SdkLog, 'type'> | (Omit<SdkLog, 'type' | 'kind'> & { kind?: LogKind })): LogEntry | undefined;
  netRequest(appId: string, msg: SdkNetRequest): void;
  netResponse(appId: string, msg: SdkNetResponse): void;
  netError(appId: string, msg: SdkNetError): void;
  pushAppMetrics(appId: string, sample: Omit<MetricSample, 'deviceId' | 'appId'>): void;
  /** A request performed by the desktop itself (replay) on the virtual 'desktop' device. */
  recordDesktopRequest(detail: NetworkDetail): NetworkEntry;

  /* queries */
  getLogs(opts?: { afterId?: number; limit?: number }): LogEntry[];
  getLogCount(): number;
  getNetwork(): NetworkEntry[];
  getNetworkDetail(id: string): NetworkDetail | undefined;
  /** Search URL, headers and bodies; returns matching network ids. */
  searchNetwork(text: string, opts?: { ids?: string[]; caseSensitive?: boolean }): string[];
  getMetrics(): MetricSample[];
  /** Latest known process info per (deviceId, pid). */
  getProcesses(): ProcessUpdate[];

  /* mutations from the UI */
  /**
   * Removes what the UI scope shows (hub/appScope.ts): `bundleId` (with `deviceId`, without `appId`) one app of
   * the device; `appId` one session and the device lines of its process. Global markers stay.
   */
  clear(target: ClearTarget, scope?: { deviceId?: string; appId?: string; bundleId?: string }): void;
  addMarker(label?: string, deviceId?: string): LogEntry;
  /**
   * `bundleId` (with `deviceId`, without `appId`): one app of the device — its sessions, the device lines of
   * its processes, its crash records, requests, metrics and its DeviceApp (the UI's device-app scope).
   */
  exportSession(scope?: { deviceId?: string; appId?: string; bundleId?: string }): SessionExport;
  importSession(data: SessionExport, label: string): { deviceIds: string[] };

  /* settings */
  setSettings(settings: ServerSettings): void;

  /* subscriptions */
  /** Batched changes (~100 ms). Returns an unsubscribe function. */
  subscribe(listener: (change: HubChange) => void): () => void;
  onCleared(listener: (event: ClearEvent) => void): () => void;
  onNotice(listener: (notice: UiNotice) => void): () => void;
  /** Synchronous tap on every appended log batch (after ids are assigned). */
  onLogs(listener: (entries: LogEntry[]) => void): () => void;

  dispose(): void;
}

export interface CreateHubOptions {
  settings: ServerSettings;
  logger: Logger;
}

/* ────────────────────────────── SDK layer ────────────────────────────── */

export interface SdkAttachMeta {
  transport: Transport;
  /** Known when the transport identifies the device (adb reverse per-device port, usbmux). */
  deviceId?: string;
  /** Remote address for diagnostics. */
  remote?: string;
}

/** In-process "SDK" used by the Flutter VM module and the demo driver. */
export interface VirtualSdkSession {
  /** Deliver a message as if it came over the wire. The first message must be 'hello'. */
  send(message: SdkToServer): void;
  /** Messages the server sends to this session (welcome, mocks, config, command, ping). */
  onMessage(listener: (message: ServerToSdk) => void): () => void;
  close(reason?: string): void;
  readonly closed: boolean;
  /** Resolves with the app id once 'welcome' was produced. */
  readonly appId: Promise<string>;
}

export interface SdkLayer {
  /** Raw byte stream speaking NDJSON (TCP socket, usbmux tunnel). */
  attachStream(stream: Duplex, meta: SdkAttachMeta): void;
  /** WebSocket from the HTTP server's /sdk upgrade (JSON text frames). */
  attachWebSocket(ws: WebSocket, meta: SdkAttachMeta): void;
  openVirtual(meta: SdkAttachMeta): VirtualSdkSession;
  /** Listen for generic raw-TCP SDK connections. Can be called again to rebind (e.g. LAN toggle). */
  listen(port: number, host: string): Promise<void>;
  setMocks(rules: MockRule[]): void;
  setConfig(patch: Partial<SdkConfig>): void;
  /** Send a command to an app ('commands' capability). Resolves with the SDK's command.result. */
  sendCommand(appId: string, name: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<DeviceActionResult>;
  /** Number of live connections (for status/diagnostics). */
  connectionCount(): number;
  close(): Promise<void>;
}

export interface CreateSdkLayerOptions {
  hub: Hub;
  logger: Logger;
  settings: () => ServerSettings;
  mocks: () => MockRule[];
  serverVersion: string;
}

/* ────────────────────────────── Drivers ────────────────────────────── */

export interface DriverContext {
  hub: HubSink;
  getDevices(): DeviceInfo[];
  getApps(): AppSession[];
  getDeviceApps(): DeviceApp[];
  onLogs(listener: (entries: LogEntry[]) => void): () => void;
  sdk: Pick<SdkLayer, 'attachStream' | 'openVirtual'>;
  settings(): ServerSettings;
  onSettings(listener: (settings: ServerSettings) => void): () => void;
  logger: Logger;
  /** Writable directory for screenshots, recordings and uploads (served at GET /api/files/:name). */
  tempDir: string;
  /** URL path the UI can GET for a file saved directly inside tempDir. */
  fileUrl(fileName: string): string;
  ports: { http: number; sdk: number };
}

export interface DeviceDriver {
  readonly id: Exclude<DriverId, 'flutter-vm'>;
  /** Must not throw when tooling is missing: report it via status()/checks() instead. */
  start(ctx: DriverContext): Promise<void>;
  stop(): Promise<void>;
  status(): DriverStatus;
  checks(): Promise<ToolCheck[]>;
  owns(deviceId: string): boolean;
  runAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult>;
  /** Start/stop periodic CPU/memory polling for a process (adb top / host ps). */
  watchMetrics?(deviceId: string, target: { pid?: number; processName?: string }, enabled: boolean): void;
}

export interface PortForward {
  host: string;
  port: number;
  dispose(): Promise<void>;
}

export interface PlatformServices {
  /** Make a device-side TCP port reachable from the desktop (adb forward / usbmux bridge / identity for simulators). */
  forwardToDevice(deviceId: string, devicePort: number): Promise<PortForward>;
}

export interface Platform {
  drivers: DeviceDriver[];
  services: PlatformServices;
}

export interface FlutterVmModule {
  start(ctx: DriverContext & { platform: PlatformServices }): Promise<void>;
  stop(): Promise<void>;
  status(): DriverStatus;
  checks(): Promise<ToolCheck[]>;
  /** Input: VM service URL, DevTools URL, or pasted `flutter run` output containing one. */
  attach(input: string, opts?: { deviceId?: string }): Promise<{ appId: string }>;
  detach(appId: string): Promise<void>;
}

/* ────────────────────────────── Server ────────────────────────────── */

export interface StartServerOptions {
  httpPort: number;
  sdkPort: number;
  /** Overrides settings.allowLan for this run when set. */
  lan?: boolean;
  demo: boolean;
  dataDir: string;
  uiDir?: string;
  verbose: boolean;
}

/**
 * A start-up problem with a stable code and parameters, so an embedder (the Mac app) can word it in its own
 * language. `message` is the English text, the same as the matching entry of StartedServer.warnings.
 * Codes: 'config.invalid' {file, detail}, 'config.unreadable' {file, error, backup?}, 'config.dataDirFallback'
 * {dir, fallback, error}, 'config.tempDirFallback' {dir, error}, 'ui.missing', 'ui.dirInvalid' {dir, fallback?},
 * 'sdk.portBusy' {port}, 'sdk.listenFailed' {port, error}, 'sdk.unavailable' / 'drivers.unavailable' /
 * 'vm.unavailable' / 'demo.unavailable' {reason}, 'demo.startFailed' {reason}.
 */
export interface ServerNotice {
  code: string;
  params?: Record<string, string | number>;
  message: string;
}

export interface RunningServer {
  url: string;
  info: import('@durbun/protocol').ServerInfo;
  stop(): Promise<void>;
}
