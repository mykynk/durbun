/**
 * Dürbün shared protocol — the single source of truth for data exchanged between
 *  - SDKs inside apps → desktop server (wire protocol: NDJSON over TCP, or JSON text frames over WebSocket)
 *  - desktop server ↔ UI (WebSocket /ui + REST /api)
 *
 * Dependency-free: types plus a few pure helpers so every package (server, UI, JS SDK) can import it.
 * Other SDKs (Dart, Kotlin, Swift) mirror these shapes by hand — keep field names stable.
 */

export const PROTOCOL_VERSION = 1;
export const PRODUCT_NAME = 'Dürbün';

export const DEFAULT_PORTS = {
  /** HTTP: UI static files, REST /api, WebSocket /ui (UI) and /sdk (JS/RN SDK). */
  http: 9750,
  /** Raw TCP NDJSON SDK listener on the desktop (adb reverse target, simulators, LAN). */
  sdk: 9751,
  /** First port of the on-device SDK listener range (iOS physical devices, reached via usbmux). */
  deviceSdkFirst: 9752,
  /** Last port (inclusive) of the on-device SDK listener range. */
  deviceSdkLast: 9755,
} as const;

/* ────────────────────────────── Common ────────────────────────────── */

export type LogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export const LOG_LEVELS: readonly LogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];
export function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** HTTP header as an ordered [name, value] pair (duplicates allowed, order preserved). */
export type Header = [name: string, value: string];

/** A captured body. `size` is the full decoded size in bytes even when `data` was truncated. */
export interface WireBody {
  encoding: 'utf8' | 'base64';
  data: string;
  size: number;
  truncated?: boolean;
}

/** Request phase durations in milliseconds (omit unknown phases). */
export interface Timings {
  dns?: number;
  connect?: number;
  tls?: number;
  send?: number;
  /** Time to first byte after the request was sent. */
  wait?: number;
  receive?: number;
}

export interface ErrorInfo {
  type?: string;
  message?: string;
  stack?: string;
}

/** i18n params for server-generated texts. */
export type I18nParams = Record<string, string | number>;

/* ────────────────────────────── Devices ────────────────────────────── */

export type DevicePlatform = 'android' | 'ios' | 'other';
export type DeviceKind = 'physical' | 'emulator' | 'simulator' | 'virtual';
export type ConnectionType = 'usb' | 'wifi' | 'local' | 'unknown';
export type DeviceState = 'online' | 'offline' | 'unauthorized' | 'disconnected';
export type LogStreamStatus = 'starting' | 'streaming' | 'unavailable' | 'stopped' | 'error';

export interface DeviceInfo {
  /** 'android:<serial>' | 'ios:<udid>' | 'ios-sim:<udid>' | 'demo:<n>' | 'import:<n>' | 'net:<key>' | 'desktop' */
  id: string;
  platform: DevicePlatform;
  kind: DeviceKind;
  /** User-facing name, e.g. "Pixel 8" or "Yusuf's iPhone". */
  name: string;
  /** Marketing name or model identifier, e.g. "Pixel 8", "iPhone16,2". */
  model?: string;
  manufacturer?: string;
  osVersion?: string;
  /** Android API level. */
  apiLevel?: number;
  /** adb serial or UDID. */
  serial?: string;
  connection: ConnectionType;
  state: DeviceState;
  /** English explanation of `state` (e.g. "Accept the USB debugging prompt on the device"). */
  stateDetail?: string;
  /** i18n code for `stateDetail`, e.g. 'device.unauthorized'. */
  stateCode?: string;
  battery?: { level: number; charging: boolean };
  screen?: { width: number; height: number; density?: number };
  logs: {
    status: LogStreamStatus;
    /** English detail. */
    detail?: string;
    /** i18n code, e.g. 'logs.idevicesyslogMissing'. */
    code?: string;
    /** Tool used, e.g. 'logcat', 'idevicesyslog', 'simctl log stream'. */
    via?: string;
  };
  /** Device actions that work for this device right now. */
  actions: DeviceActionId[];
  /**
   * Readers that work without an SDK (SPEC §10.3 / §10.4), so the UI can tell "nothing found" from "cannot
   * read". Absent reader = not reported (older server, or not applicable to this device). The hub merges
   * this per reader id on `upsertDevice` / `patchDevice`.
   */
  readers?: Partial<Record<DeviceReaderId, DeviceReaderState>>;
  firstSeen: number;
  lastSeen: number;
}

/** SDK-less readers: device crash / ANR records (dropbox, .ips) and Android frame stats. */
export type DeviceReaderId = 'crashReports' | 'frameStats';

/**
 * 'ok' = reading works (an empty result really means there is nothing); 'unavailable' = tried and failed
 * (tool missing, refused by the OEM, an error); 'unsupported' = not possible on this device or OS.
 */
export type DeviceReaderStatus = 'ok' | 'unavailable' | 'unsupported';

export interface DeviceReaderState {
  status: DeviceReaderStatus;
  /** i18n code, `reader.<readerId>.<reason>`, e.g. 'reader.crashReports.devicectlMissing' (SPEC §10.3). */
  code?: string;
  /** English detail (fallback text). */
  detail?: string;
  /** Last successful read (epoch ms). */
  lastOk?: number;
}

export interface ProcessUpdate {
  deviceId: string;
  pid: number;
  name: string;
  event: 'started' | 'died' | 'seen';
  ts: number;
}

/* ────────────────────────────── Device apps (installed / running, with or without an SDK) ────────────────────────────── */

/**
 * Where an installed build came from (best effort, SPEC §10). Drivers fill what the platform exposes:
 * Android reads the installer package (`dumpsys package`), iOS devices only say whether it is a developer
 * (Xcode-installed) app.
 */
export type AppInstallSource =
  /** Android: installer com.android.vending. */
  | 'play'
  /** Android: Firebase App Tester (installer dev.firebase.appdistribution). */
  | 'firebase'
  /** Android: installed over adb / Android Studio / flutter run (installer shell or none). */
  | 'adb'
  /** Android: another installer package (Galaxy Store, AppGallery…; see `installer`). */
  | 'other-store'
  /** iOS: developer app (installed from Xcode, devicectl or flutter run). */
  | 'xcode'
  /** iOS device: not a developer app — App Store, TestFlight or ad-hoc (iOS does not say which). */
  | 'store-or-testflight'
  /** iOS simulator build. */
  | 'simulator'
  | 'unknown';

/** Android FLAG_DEBUGGABLE / iOS developer build. 'unknown' when the platform does not say. */
export type AppBuildType = 'debug' | 'release' | 'unknown';

/**
 * An app the device itself reports (running, recently active or crashed), independent of any SDK.
 * SDK / VM-service sessions stay `AppSession`s; the UI joins both by `deviceId` + bundle `id`.
 */
export interface DeviceApp {
  /** '<deviceId>|<bundle id>' — stable key. */
  key: string;
  deviceId: string;
  /** Bundle id / package name, e.g. "com.mykynk.pati". */
  id: string;
  /** Display name when known (iOS CFBundleDisplayName, Android label when cheap; else undefined). */
  name?: string;
  version?: string;
  build?: string;
  buildType: AppBuildType;
  install: {
    source: AppInstallSource;
    /** Raw installer package (Android) for 'other-store' / diagnostics. */
    installer?: string;
    firstInstall?: number;
    lastUpdate?: number;
  };
  /** Executable / process name when it differs from `id` (iOS "Runner"). */
  processName?: string;
  /** Live pids of this app's processes (main + ":service" processes on Android). Owned by the driver. */
  pids: number[];
  running: boolean;
  /** Last time a log line, process event or crash report was seen for it (epoch ms). */
  lastActivity: number;
  /** Crash / ANR reports read from the device for this app (dropbox, .ips) since Dürbün started watching. */
  crashReports?: number;
}

/* ────────────────────────────── Apps (SDK sessions) ────────────────────────────── */

export type SdkPlatform = 'flutter' | 'android' | 'ios' | 'react-native' | 'js' | 'dart-vm' | 'demo';
export type Transport = 'adb-reverse' | 'usbmux' | 'tcp' | 'websocket' | 'vm-service' | 'demo' | 'import';
export type SdkCapability = 'logs' | 'network' | 'mocks' | 'metrics' | 'events' | 'crash' | 'commands';
/**
 * Layers inside the app that feed one session (SPEC §10.6): 'dart' = the Flutter / Dart side; 'android' /
 * 'ios' = the plugin's native core is attached (native logs, native crashes, OkHttp via DurbunInterceptor /
 * URLSession). Sent in `hello.sdk.layers`; absent = unknown (older SDKs, single-layer SDKs).
 */
export type SdkLayer = 'dart' | 'android' | 'ios';
/** `hello.sdk` / `AppSession.sdk`. */
export interface SdkIdentity {
  name: string;
  version: string;
  platform: SdkPlatform;
  layers?: SdkLayer[];
}

export interface AppInfo {
  /** Display name, e.g. "Pati". */
  name: string;
  /** Bundle id / package name, e.g. "com.mykynk.pati". */
  id: string;
  version?: string;
  build?: string;
  pid?: number;
  /** Executable/process name (iOS Flutter apps are usually "Runner"). */
  processName?: string;
  debug?: boolean;
}

export interface AppActionDescriptor {
  /** e.g. 'flutter.debugPaint' */
  id: string;
  kind: 'toggle' | 'select' | 'button';
  /** English fallback label. */
  label: string;
  /** UI i18n key (optional). */
  labelKey?: string;
  /** Grouping, e.g. 'flutter'. */
  group?: string;
  options?: { value: string; label: string }[];
  /** Current state when known. */
  value?: boolean | string;
}

export interface AppSession {
  /** Server-assigned id, e.g. 'app:3'. */
  id: string;
  /** SDK-provided per-launch id (`hello.session`). */
  sessionKey: string;
  deviceId: string;
  sdk: SdkIdentity;
  app: AppInfo;
  transport: Transport;
  connected: boolean;
  connectedAt: number;
  disconnectedAt?: number;
  capabilities: SdkCapability[];
  actions: AppActionDescriptor[];
  stats: { logs: number; requests: number; errors: number };
}

/* ────────────────────────────── Logs ────────────────────────────── */

export type LogSource = 'device' | 'app' | 'system';
export type LogKind =
  | 'text'
  | 'crash'
  | 'anr'
  | 'flutter-error'
  | 'event'
  | 'network'
  | 'lifecycle'
  | 'marker';

/**
 * Exactly where a line came from — drives the "where does this come from" UI (SPEC §10). Optional:
 * the UI falls back to `source` when absent.
 */
export type LogOrigin =
  | 'logcat'
  | 'idevicesyslog'
  | 'simctl-log'
  | 'sdk'
  | 'vm-service'
  /** Android `dumpsys dropbox` crash / ANR / tombstone record. */
  | 'dropbox'
  /** iOS crash report (.ips) from the device (devicectl) or the Mac (simulator DiagnosticReports). */
  | 'crash-report'
  | 'durbun'
  | 'demo'
  | 'import';

export interface LogEntry {
  /** Global, monotonically increasing; the UI orders by id (arrival order). */
  id: number;
  /** Epoch milliseconds (device clock; fractional allowed). */
  ts: number;
  deviceId: string;
  appId?: string;
  source: LogSource;
  /** Precise origin (see LogOrigin). */
  origin?: LogOrigin;
  level: LogLevel;
  /** Android tag / iOS subsystem or library / SDK logger name / 'network' / 'event' / 'durbun'. */
  tag: string;
  message: string;
  pid?: number;
  tid?: number;
  process?: string;
  subsystem?: string;
  category?: string;
  kind?: LogKind;
  /** Structured payload (SDK fields, event props, system params). */
  data?: unknown;
  error?: ErrorInfo;
  /** For kind 'network': the NetworkEntry id. */
  netId?: string;
  /** For system lines: i18n code (see SPEC §4); `message` is the English fallback. */
  code?: string;
  params?: I18nParams;
}

/* ────────────────────────────── Network ────────────────────────────── */

export type NetworkState = 'pending' | 'complete' | 'failed' | 'cancelled';

export interface NetworkEntry {
  /** '<appId>:<sdk request id>' (or 'replay:<n>' / 'import:<n>:<id>'). */
  id: string;
  appId?: string;
  deviceId: string;
  /** 'dart:io' | 'dio' | 'okhttp' | 'urlsession' | 'fetch' | 'xhr' | 'vm-service' | 'replay' | 'demo' | … */
  source: string;
  method: string;
  url: string;
  host: string;
  /** pathname + search */
  path: string;
  startTs: number;
  endTs?: number;
  duration?: number;
  state: NetworkState;
  status?: number;
  statusText?: string;
  requestHeaders: Header[];
  responseHeaders?: Header[];
  requestBodySize?: number;
  responseBodySize?: number;
  requestContentType?: string;
  responseContentType?: string;
  hasRequestBody: boolean;
  hasResponseBody: boolean;
  /** Bodies dropped from memory by the server's body budget. */
  bodyEvicted?: boolean;
  error?: string;
  protocol?: string;
  remoteAddress?: string;
  timings?: Timings;
  mocked?: boolean;
  mockRuleId?: string;
  graphql?: { operationName?: string; operationType?: 'query' | 'mutation' | 'subscription' };
}

export interface NetworkDetail extends NetworkEntry {
  requestBody?: WireBody;
  responseBody?: WireBody;
}

/* ────────────────────────────── Metrics ────────────────────────────── */

export interface MetricSample {
  ts: number;
  deviceId: string;
  appId?: string;
  pid?: number;
  source: 'sdk' | 'vm-service' | 'adb' | 'host' | 'demo';
  /** Percent of ONE core (may exceed 100 on multi-core). */
  cpu?: number;
  /** Resident / footprint memory in MB. */
  memoryMB?: number;
  /** Managed heap (Dart/JVM/JS) in MB. */
  heapMB?: number;
  fps?: number;
  /** Frames over budget since the previous sample. */
  jankyFrames?: number;
  frameBuildMs?: number;
  frameRasterMs?: number;
  threads?: number;
}

/* ────────────────────────────── Mocks ────────────────────────────── */

export type UrlMatchType = 'contains' | 'exact' | 'glob' | 'regex';

export type MockAction =
  | {
      type: 'respond';
      status: number;
      headers?: Header[];
      body?: string;
      bodyEncoding?: 'utf8' | 'base64';
      delayMs?: number;
    }
  | { type: 'delay'; delayMs: number }
  | {
      type: 'fail';
      error: 'timeout' | 'connection' | 'dns' | 'tls' | 'custom';
      message?: string;
      delayMs?: number;
    };

export interface MockRule {
  id: string;
  enabled: boolean;
  name?: string;
  /** '*' = any method, otherwise an uppercase HTTP method. */
  method: string;
  url: string;
  match: UrlMatchType;
  /** App ids (bundle/package) the rule applies to; empty/undefined = all apps. */
  apps?: string[];
  action: MockAction;
  createdAt: number;
}

/**
 * Reference matcher. Every SDK implements identical semantics:
 *  - method: '*' matches anything, otherwise case-insensitive equality;
 *  - contains / exact / glob: case-insensitive; glob '*' = any run of chars (incl. '/'), '?' = one char,
 *    and must match the WHOLE url;
 *  - regex: pattern used as-is (case-sensitive), searched anywhere in the url; invalid regex never matches;
 *  - apps: empty/undefined = all apps, otherwise must contain the app id.
 */
export function mockRuleMatches(rule: MockRule, method: string, url: string, appId?: string): boolean {
  if (!rule.enabled) return false;
  if (rule.apps && rule.apps.length > 0 && (!appId || !rule.apps.includes(appId))) return false;
  if (rule.method !== '*' && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  const u = url.toLowerCase();
  const p = rule.url.toLowerCase();
  switch (rule.match) {
    case 'contains':
      return p.length > 0 && u.includes(p);
    case 'exact':
      return u === p;
    case 'glob': {
      const re = '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      return new RegExp(re).test(u);
    }
    case 'regex':
      try {
        return new RegExp(rule.url).test(url);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** First enabled matching rule (rules are ordered; first match wins). */
export function findMockRule(rules: MockRule[], method: string, url: string, appId?: string): MockRule | undefined {
  return rules.find((r) => mockRuleMatches(r, method, url, appId));
}

/* ────────────────────────────── Device actions ────────────────────────────── */

/**
 * Params per action (all optional unless noted):
 *  screenshot {}                          → data: { url: string; file: string; width?: number; height?: number }
 *  open-url { url* }
 *  list-apps { includeSystem?: boolean }  → data: InstalledApp[]
 *  app-launch | app-stop | app-restart | app-clear-data | app-uninstall { appId* }  (bundle id / package)
 *  app-install { file* }                  (server path returned by POST /api/upload)
 *  logs-clear-buffer {} · logs-restart {}
 *  appearance { mode*: 'dark' | 'light' }
 *  font-scale { scale*: number }          (Android 0.85–2.0; iOS simulator maps to content size)
 *  animations { enabled*: boolean }       (Android)
 *  input-text { text* }                   (Android)
 *  key-event { key*: 'back'|'home'|'recents'|'power'|'volume-up'|'volume-down'|'enter'|'delete'|'menu' }
 *  push-notification { appId*, payload*: object }   (iOS simulator)
 *  location { lat*, lon* }                (iOS simulator, Android emulator)
 *  status-bar { mode*: 'clean' | 'reset' }           (iOS simulator)
 *  screen-record { durationSec*: number } → data: { url: string; file: string }
 */
export type DeviceActionId =
  | 'screenshot'
  | 'open-url'
  | 'list-apps'
  | 'app-launch'
  | 'app-stop'
  | 'app-restart'
  | 'app-clear-data'
  | 'app-uninstall'
  | 'app-install'
  | 'logs-clear-buffer'
  | 'logs-restart'
  | 'appearance'
  | 'font-scale'
  | 'animations'
  | 'input-text'
  | 'key-event'
  | 'push-notification'
  | 'location'
  | 'status-bar'
  | 'screen-record';

export interface InstalledApp {
  id: string;
  name?: string;
  version?: string;
  debuggable?: boolean;
  system?: boolean;
}

export interface DeviceActionResult {
  ok: boolean;
  /** English message for a toast. */
  message?: string;
  /** i18n code for the message. */
  code?: string;
  data?: unknown;
  error?: string;
}

/* ────────────────────────────── Server settings & status ────────────────────────────── */

export interface ServerSettings {
  maxLogEntries: number;
  maxNetworkEntries: number;
  /** Per-body capture limit pushed to SDKs. */
  maxBodyBytes: number;
  /** Total in-memory body budget on the server. */
  maxBodyStoreMB: number;
  captureBodies: boolean;
  /** Lines of existing logcat history to load when a device connects. */
  logcatTail: number;
  iosSimLogScope: 'apps' | 'all';
  iosSimLogLevel: 'default' | 'info' | 'debug';
  /**
   * Physical iPhones (idevicesyslog): 'apps' keeps lines of third-party apps (DeviceApp pids / process names)
   * plus crash-related system lines; 'all' keeps every daemon (~1000 lines/s on a busy phone). Optional for
   * older servers; absent = 'apps'.
   */
  iosDeviceLogScope?: 'apps' | 'all';
  autoAttachVmService: boolean;
  /** App ids whose process start/stop is announced in the log stream (besides SDK apps). */
  watchedApps: string[];
  /** Bind SDK/HTTP listeners on 0.0.0.0 so devices on the LAN can connect. */
  allowLan: boolean;
  metricsIntervalMs: number;
  adbPath?: string;
  idevicesyslogPath?: string;
}

export const DEFAULT_SETTINGS: ServerSettings = {
  maxLogEntries: 200_000,
  maxNetworkEntries: 5_000,
  maxBodyBytes: 1_048_576,
  maxBodyStoreMB: 256,
  captureBodies: true,
  logcatTail: 2_000,
  iosSimLogScope: 'apps',
  iosSimLogLevel: 'info',
  iosDeviceLogScope: 'apps',
  autoAttachVmService: true,
  watchedApps: [],
  allowLan: false,
  metricsIntervalMs: 1_000,
};

export type DriverId = 'android' | 'ios-sim' | 'ios-device' | 'flutter-vm' | 'demo';

export interface DriverStatus {
  id: DriverId;
  /** Tooling present and usable. */
  available: boolean;
  /** Running right now. */
  active: boolean;
  detail?: string;
  code?: string;
}

export interface ToolCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'missing' | 'error';
  version?: string;
  path?: string;
  detail?: string;
  /** Shell command or short instruction that fixes the problem. */
  fix?: string;
  docsUrl?: string;
  /** i18n code for a variant the UI should word specially, e.g. 'doctor.node.embedded' {electron, node}. */
  code?: string;
  params?: I18nParams;
}

export interface ServerInfo {
  name: 'durbun';
  version: string;
  protocol: number;
  ports: { http: number; sdk: number };
  startedAt: number;
  demo: boolean;
  lan: boolean;
  /** Non-internal IPv4 addresses of the desktop (for Wi-Fi setup hints). */
  hostAddresses: string[];
  dataDir: string;
  /** process.platform */
  platform: string;
}

/* ────────────────────────────── Server ↔ UI (WebSocket /ui) ────────────────────────────── */

export type ClearTarget = 'logs' | 'network' | 'metrics' | 'all';

export interface UiNotice {
  level: 'info' | 'success' | 'warn' | 'error';
  /** English fallback. */
  message: string;
  code?: string;
  params?: I18nParams;
  deviceId?: string;
  appId?: string;
}

export type ServerToUi =
  | { type: 'hello'; server: ServerInfo; settings: ServerSettings }
  | {
      type: 'snapshot';
      devices: DeviceInfo[];
      apps: AppSession[];
      network: NetworkEntry[];
      mocks: MockRule[];
      drivers: DriverStatus[];
      processes: ProcessUpdate[];
      metrics: MetricSample[];
      logCount: number;
      /** Apps the devices report (SPEC §10). Optional for older servers. */
      deviceApps?: DeviceApp[];
    }
  | { type: 'history'; logs: LogEntry[]; done: boolean }
  | {
      type: 'batch';
      logs?: LogEntry[];
      network?: NetworkEntry[];
      devices?: DeviceInfo[];
      removedDevices?: string[];
      apps?: AppSession[];
      metrics?: MetricSample[];
      processes?: ProcessUpdate[];
      /** Inserted / changed device apps (full objects). */
      deviceApps?: DeviceApp[];
      /** DeviceApp keys that are gone (device removed, app uninstalled). */
      removedDeviceApps?: string[];
    }
  | { type: 'cleared'; target: ClearTarget; deviceId?: string; appId?: string }
  | { type: 'mocks'; rules: MockRule[] }
  | { type: 'settings'; settings: ServerSettings }
  | { type: 'drivers'; drivers: DriverStatus[] }
  | ({ type: 'notice' } & UiNotice)
  | { type: 'reply'; requestId: string; ok: boolean; data?: unknown; error?: string; code?: string };

export interface ReplayOverrides {
  method?: string;
  url?: string;
  headers?: Header[];
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
}

/**
 * Reply `data` per command:
 *  clear → null · marker.add → LogEntry · device.action → DeviceActionResult.data (reply.ok = result.ok)
 *  app.action → DeviceActionResult.data · mocks.set → MockRule[] · settings.update → ServerSettings
 *  vm.attach → { appId } · vm.detach → null · metrics.watch → null · net.replay → NetworkEntry
 *  demo.set → { enabled } · doctor.run → ToolCheck[]
 */
export type UiCommand =
  | { name: 'clear'; target: ClearTarget; deviceId?: string; appId?: string }
  | { name: 'marker.add'; label?: string; deviceId?: string }
  | { name: 'device.action'; deviceId: string; action: DeviceActionId; params?: Record<string, unknown> }
  | { name: 'app.action'; appId: string; action: string; params?: Record<string, unknown> }
  | { name: 'mocks.set'; rules: MockRule[] }
  | { name: 'settings.update'; patch: Partial<ServerSettings> }
  | { name: 'vm.attach'; input: string; deviceId?: string }
  | { name: 'vm.detach'; appId: string }
  | { name: 'metrics.watch'; deviceId: string; pid?: number; processName?: string; enabled: boolean }
  | { name: 'net.replay'; id: string; overrides?: ReplayOverrides }
  | { name: 'demo.set'; enabled: boolean }
  | { name: 'doctor.run' };

export interface UiToServer {
  type: 'command';
  requestId: string;
  command: UiCommand;
}

/* ────────────────────────────── Session export ────────────────────────────── */

export interface SessionExport {
  format: 'durbun-session';
  version: 1;
  exportedAt: number;
  server: { version: string };
  devices: DeviceInfo[];
  apps: AppSession[];
  logs: LogEntry[];
  network: NetworkDetail[];
  metrics?: MetricSample[];
  /** Apps the devices reported (SPEC §10.2). Optional: older exports have none. */
  deviceApps?: DeviceApp[];
}

/* ────────────────────────────── SDK wire protocol ────────────────────────────── */

export interface DeviceHints {
  platform: DevicePlatform;
  model?: string;
  manufacturer?: string;
  name?: string;
  osVersion?: string;
  apiLevel?: number;
  isPhysical?: boolean;
  /** iOS simulator: value of the SIMULATOR_UDID environment variable. */
  simulatorUdid?: string;
}

export interface SdkHello {
  type: 'hello';
  protocol: number;
  sdk: SdkIdentity;
  app: AppInfo;
  device: DeviceHints;
  /** Random id per app launch. */
  session: string;
  capabilities: SdkCapability[];
  actions?: AppActionDescriptor[];
  ts: number;
}

export interface SdkLog {
  type: 'log';
  ts: number;
  level: LogLevel;
  tag?: string;
  message: string;
  data?: unknown;
  error?: ErrorInfo;
  kind?: 'text' | 'crash' | 'flutter-error';
  tid?: number;
}

export interface SdkNetRequest {
  type: 'net.request';
  id: string;
  ts: number;
  method: string;
  url: string;
  headers: Header[];
  body?: WireBody;
  /** 'dart:io' | 'dio' | 'okhttp' | 'urlsession' | 'fetch' | 'xhr' | 'vm-service' | 'demo' | … */
  source: string;
}

export interface SdkNetResponse {
  type: 'net.response';
  id: string;
  ts: number;
  status: number;
  statusText?: string;
  headers: Header[];
  body?: WireBody;
  protocol?: string;
  remoteAddress?: string;
  timings?: Timings;
  mocked?: boolean;
  mockRuleId?: string;
}

export interface SdkNetError {
  type: 'net.error';
  id: string;
  ts: number;
  error: string;
  cancelled?: boolean;
  mocked?: boolean;
  mockRuleId?: string;
}

export interface SdkEvent {
  type: 'event';
  ts: number;
  name: string;
  props?: Record<string, unknown>;
}

export interface SdkMetric {
  type: 'metric';
  ts: number;
  cpu?: number;
  memoryMB?: number;
  heapMB?: number;
  fps?: number;
  jankyFrames?: number;
  frameBuildMs?: number;
  frameRasterMs?: number;
  threads?: number;
}

export interface SdkCommandResult {
  type: 'command.result';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface SdkActionsUpdate {
  type: 'actions';
  actions: AppActionDescriptor[];
}

export interface SdkPong {
  type: 'pong';
  ts: number;
}

export type SdkToServer =
  | SdkHello
  | SdkLog
  | SdkNetRequest
  | SdkNetResponse
  | SdkNetError
  | SdkEvent
  | SdkMetric
  | SdkCommandResult
  | SdkActionsUpdate
  | SdkPong;

export interface SdkConfig {
  captureBodies: boolean;
  maxBodyBytes: number;
  metricsIntervalMs: number;
  /** The desktop already receives this device's logs (stdout of the app included where the OS logs it). */
  deviceLogsAvailable: boolean;
}

export interface ServerWelcome {
  type: 'welcome';
  protocol: number;
  /** e.g. 'durbun/0.1.0' */
  server: string;
  appId: string;
  config: SdkConfig;
  mocks: MockRule[];
}

export type ServerToSdk =
  | ServerWelcome
  | { type: 'mocks'; rules: MockRule[] }
  | { type: 'config'; config: SdkConfig }
  | { type: 'command'; id: string; name: string; params?: Record<string, unknown> }
  | { type: 'ping'; ts: number };

/** Max size of one NDJSON line / WebSocket frame. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Content types captured as UTF-8 text (everything else is base64). */
export function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('html') ||
    ct.includes('javascript') ||
    ct.includes('x-www-form-urlencoded') ||
    ct.includes('graphql') ||
    ct.includes('yaml') ||
    ct.includes('csv')
  );
}
