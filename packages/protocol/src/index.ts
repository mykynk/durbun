/**
 * Dürbün shared protocol — the single source of truth for data exchanged between
 *  - SDKs inside apps → desktop server (wire protocol: NDJSON over TCP, or JSON text frames over WebSocket)
 *  - desktop server ↔ UI (WebSocket /ui + REST /api)
 *
 * Dependency-free: types plus a few pure helpers so every package (server, UI, JS SDK) can import it.
 * Other SDKs (Dart, Kotlin, Swift) mirror these shapes by hand — keep field names stable.
 */

import type { FlowRun, FlowRunDelta, FlowSummary } from './flows/types';

export * from './flows/index';
export * from './package';
export * from './secrets';
export * from './bugReport';
export * from './har';

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

/**
 * Level of a request's row in the log list (kind 'network'), from the request's outcome: a failed request or a
 * 5xx response is an error, a 4xx response a warning, anything else (pending, cancelled, 1xx-3xx) info.
 * The server raises the row's level when the outcome arrives; a client that already holds the row applies the
 * same rule to the network entry the row's netId names.
 */
export function networkLogLevel(entry: { state?: string; status?: number }): LogLevel {
  if (entry.state === 'failed') return 'error';
  const status = typeof entry.status === 'number' ? entry.status : 0;
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
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
  /**
   * Android: the phone's own serial (`ro.serialno`, Settings › About phone › Status). Equals `serial` over
   * USB; over Wi-Fi `serial` is the ip:port / mDNS name of the transport. Tells same-name phones apart.
   */
  hardwareSerial?: string;
  connection: ConnectionType;
  /**
   * Every way the device is reachable right now, the one in use (`connection`) first; set only when there
   * is more than one (an Android phone on USB with wireless debugging also on: ['usb', 'wifi']).
   */
  connections?: ConnectionType[];
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
  /** The screen recording running on the device (absent = none). */
  recording?: DeviceRecording;
  /**
   * Readers that work without an SDK (SPEC §10.3 / §10.4), so the UI can tell "nothing found" from "cannot
   * read". Absent reader = not reported (older server, or not applicable to this device). The hub merges
   * this per reader id on `upsertDevice` / `patchDevice`.
   */
  readers?: Partial<Record<DeviceReaderId, DeviceReaderState>>;
  /**
   * Device settings Dürbün changed through device actions, with the value from before (Android: animations,
   * font scale, dark mode). The same action with `{ restore: true }` puts the old value back. Absent: nothing
   * changed (or an older server).
   */
  settingOverrides?: DeviceSettingOverride[];
  /**
   * Actions this platform has that this device cannot do right now, each with why (Developer Mode off, a
   * tool missing on the Mac, the OS too old, emulators only, a Wi-Fi connection the action would cut).
   * Never lists an action that is in `actions`. Absent: nothing missing for a known reason (or an older
   * server); an offline / untrusted device lists nothing here (its `stateCode` says why).
   */
  unavailableActions?: DeviceUnavailableAction[];
  /**
   * Android users and profiles on the phone (`pm list users`), set only when there is more than one (a work
   * profile, Secure Folder, a second user). App actions take an optional `userId` for one of them.
   */
  users?: DeviceUser[];
  /** The full device report (`bug-report`) being collected (absent = none). */
  bugReport?: DeviceBugReport;
  firstSeen: number;
  lastSeen: number;
}

/**
 * An action missing from `DeviceInfo.actions` and why. Codes: 'action.developerModeOff', 'action.osTooOld'
 * {osVersion, minVersion}, 'action.apiTooLow' {apiLevel, minApi, minVersion}, 'action.emulatorOnly',
 * 'action.toolMissing' {tool, detail, minXcode?, install?}, 'action.toolTooOld' {tool, detail, from?},
 * 'logs.idevicesyslogMissing', 'action.wouldDisconnect' {connection}. `detail` is English (older UIs); the
 * other params word it in the UI language.
 */
export interface DeviceUnavailableAction {
  action: DeviceActionId;
  code: string;
  params?: Record<string, string | number>;
}

/** One Android user or profile (`DeviceInfo.users`). */
export interface DeviceUser {
  /** The id `--user` takes (0 = the main user). */
  id: number;
  /** As the phone names it ("Owner", "Work profile", "Secure Folder"). */
  name: string;
  /** 'work' = managed (work) profile; 'profile' = another profile of the main user (clone, private space). */
  kind: 'main' | 'work' | 'profile' | 'secondary';
  running?: boolean;
  /** The user in the foreground now (`am get-current-user`). */
  current?: boolean;
}

/** A running `bug-report` (Android `adb bugreport`, usually 1–3 minutes). */
export interface DeviceBugReport {
  /** Server clock (ms) when it started. */
  startedAt: number;
  /** 0–100 as the phone reports it, once it does. */
  progress?: number;
}

/** One device setting Dürbün changed, as `DeviceInfo.settingOverrides` lists it. */
export interface DeviceSettingOverride {
  /** The action that changed it ('animations', 'font-scale', 'appearance', 'rotation', 'app-permission'…). */
  action: DeviceActionId;
  /** Per-app settings ('app-permission', 'app-locale'): the app it belongs to. */
  appId?: string;
  /** 'app-permission': the permission. */
  key?: string;
  /** The value before Dürbün's first change, as the device reported it ("1", "1.15", "no"…; "default" when unset). */
  previous: string;
  /** The value Dürbün set last. */
  current: string;
  /** When Dürbün first changed it (epoch ms). */
  since: number;
}

/** A running `screen-record`: it lasts until `screen-record-stop` or `limitSec`, whichever comes first. */
export interface DeviceRecording {
  /** Server clock (ms) when the recording started. */
  startedAt: number;
  /** The recording stops by itself after this many seconds (the platform limit or the requested duration). */
  limitSec: number;
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
/** `streams`: the SDK can send `net.ws` / `net.sse` (it still sends them only when `config.captureStreams` is true). */
export type SdkCapability = 'logs' | 'network' | 'mocks' | 'metrics' | 'events' | 'crash' | 'commands' | 'streams';
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
  /**
   * Mock rule conditions (`MockRule.when` keys, see MOCK_MATCHERS) this SDK evaluates, e.g. ['graphql']. The server
   * sends a rule that uses a condition only to sessions that declared it; absent = none (older SDKs: they get only
   * the rules without conditions). Unknown values are dropped by the server.
   */
  mockMatchers?: MockMatcher[];
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
  /** Wire protocol version the SDK announced in its hello; absent when it sent none (unknown). */
  sdkProtocol?: number;
  /**
   * Set when the SDK speaks a protocol this server does not fully understand: 'sdk-newer' (update
   * Dürbün) or 'sdk-older' (update the SDK in the app). Absent when compatible or unknown.
   */
  protocolMismatch?: 'sdk-newer' | 'sdk-older';
  /**
   * Estimated difference between the Mac clock and the device clock, in ms (Mac minus device: positive
   * means the device clock is behind). Measured from keepalive round trips, so it is approximate:
   * `clockOffsetAccuracyMs` is the uncertainty (half the round trip of the best sample). Log times are
   * never corrected with it. Absent until measured (and for in-process sessions).
   */
  clockOffsetMs?: number;
  clockOffsetAccuracyMs?: number;
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
  /** 'dart:io' | 'dio' | 'okhttp' | 'urlsession' | 'fetch' | 'xhr' | 'vm-service' | 'replay' | 'flow' | 'demo' | … */
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
  /**
   * The app sent this part of the exchange in a message larger than Dürbün accepts (MAX_FRAME_BYTES), so
   * it was not received: 'response' ends the entry as failed instead of leaving it pending; 'request'
   * keeps what could be read (method, URL) without headers or body.
   */
  tooLarge?: { part: 'request' | 'response'; bytes: number; limit: number };
  /**
   * A WebSocket (101 handshake) or Server-Sent Events stream: its state and message counts. The messages
   * themselves: GET /api/network/:id/messages (StreamMessage). Optional for older servers.
   */
  stream?: StreamInfo;
}

export interface NetworkDetail extends NetworkEntry {
  requestBody?: WireBody;
  responseBody?: WireBody;
  /**
   * The stream's messages the server still holds, oldest first (session export / import and HAR only; the
   * request's REST detail leaves them out: page through GET /api/network/:id/messages instead).
   */
  streamMessages?: StreamMessage[];
}

/* ────────────────────────────── Stream messages (WebSocket, Server-Sent Events) ────────────────────────────── */
/*
 * A long-lived connection is ONE network entry (the handshake request; its response is the 101 / the SSE
 * response headers) plus its messages. SDKs send them as `net.ws` / `net.sse` (SDK wire protocol below,
 * SPEC §6.1.1); the server numbers them per connection (`seq`) in arrival order and keeps them within limits.
 *
 * gRPC (and other HTTP/2 streams) is out on purpose: a call there is a sequence of length-prefixed protobuf
 * messages inside one request / response body, each side able to stream, ended by trailers (grpc-status,
 * grpc-message). It would need a `net.grpc` message per message (dir, compressed flag, protobuf bytes),
 * trailers on the entry and a schema (descriptor set / reflection) to show anything better than bytes.
 */

/** What kind of long-lived connection an entry is. */
export type StreamKind = 'websocket' | 'sse';

/** WebSocket frame opcodes Dürbün keeps (continuation frames are joined into one message by the SDK). */
export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

/** One WebSocket message or one SSE event of a stream entry, as the server keeps it. */
export interface StreamMessage {
  /**
   * Position in the connection, 1-based, assigned by the server in arrival order. Order by it (not by `ts`):
   * a gap means the limits dropped the messages in between (StreamInfo.dropped).
   */
  seq: number;
  /** Device clock, epoch ms. "Time since open" = ts − StreamInfo.openTs. */
  ts: number;
  /** 'out' = the app sent it, 'in' = the app received it (SSE events are always 'in'). */
  dir: 'in' | 'out';
  /** WebSocket opcode, or 'event' for one SSE event. */
  type: WsOpcode | 'event';
  /** Full payload size in bytes, also when `body` was cut or left out. */
  size: number;
  /**
   * The payload (text → utf8, binary → base64), capped at SdkConfig.maxStreamMessageBytes (`truncated`).
   * Absent when payloads are not captured (captureBodies off) or the frame had none.
   */
  body?: WireBody;
  /** type 'close': the close code (1000 normal, 1001 going away, …) and reason, when the frame carried them. */
  closeCode?: number;
  closeReason?: string;
  /** SSE: the `event:` field (absent = the default "message"). */
  event?: string;
  /** SSE: the `id:` field. */
  eventId?: string;
  /** SSE: the `retry:` field, ms. */
  retry?: number;
}

/** A stream entry's state and counts (NetworkEntry.stream). Counts include messages the limits dropped since. */
export interface StreamInfo {
  kind: StreamKind;
  /**
   * 'open' until a close frame (either side) / the SSE end / an error; 'failed' when the connection broke
   * (`error`); an app that disconnects closes its open streams.
   */
  state: 'open' | 'closed' | 'failed';
  /** The handshake's response (101 / SSE headers), epoch ms. */
  openTs?: number;
  closedTs?: number;
  /** Who closed first: 'out' the app, 'in' the server. Absent when the connection just went away. */
  closedBy?: 'in' | 'out';
  closeCode?: number;
  closeReason?: string;
  /** Why the stream failed (the SDK's `net.error` after the connection opened). */
  error?: string;
  /** Every message received so far, dropped ones included. */
  count: number;
  in: number;
  out: number;
  /** Ping / pong frames among `count` (keep-alive noise the view can hide). */
  control: number;
  /** Full payload bytes received / sent. */
  bytesIn: number;
  bytesOut: number;
  /** Messages the limits deleted (oldest first; the first STREAM_HEAD_KEPT of a connection are kept longest). */
  dropped: number;
  /** `seq` of the newest message (0 = none yet): fetch the messages after the seq you hold. */
  lastSeq: number;
  lastTs?: number;
}

/** Answer of GET /api/network/:id/messages?after=<seq>&limit=<n> (seq order, oldest first). */
export interface StreamMessagesPage {
  messages: StreamMessage[];
  /** The entry's stream (counts and state at the time of the answer). */
  stream?: StreamInfo;
  /** More messages after the last one returned: ask again with `after` = its seq. */
  more: boolean;
}

/** Limits of stream messages: the server keeps these first messages of a connection longest (handshake, auth, subscribe). */
export const STREAM_HEAD_KEPT = 100;

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
  /**
   * Conditions besides method / URL / apps (mock matching v2): the rule matches only when every condition present
   * holds too. Absent = method / URL / apps only (the rules every SDK understands). The server sends a rule with a
   * condition only to SDKs that declared that matcher in `hello.sdk.mockMatchers` (see `mockRuleSendableTo`).
   */
  when?: MockRuleConditions;
}

export type GraphqlOperationType = 'query' | 'mutation' | 'subscription';
export const GRAPHQL_OPERATION_TYPES: readonly GraphqlOperationType[] = ['query', 'mutation', 'subscription'];
/** GraphQL name syntax (operation names). */
export const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;
/** Longest operation name a rule may hold. */
export const MAX_GRAPHQL_OPERATION_NAME = 128;

/** `MockRule.when.graphql`: the GraphQL operation a rule is limited to. */
export interface MockGraphqlCondition {
  /** Operation name, exact and case-sensitive (`GetUser`): GRAPHQL_NAME_RE, at most MAX_GRAPHQL_OPERATION_NAME chars. */
  operationName: string;
  /** Also require this operation type; absent = any type. A request whose type cannot be read does not match it. */
  operationType?: GraphqlOperationType;
}

/**
 * Extra conditions of a mock rule. Each key is one matcher; later matchers (headers, body text, devices, times)
 * are added here as new optional keys. An SDK evaluates only the keys it declared in `hello.sdk.mockMatchers`;
 * a rule carrying a key the SDK does not know never matches there (never "every request to that URL").
 */
export interface MockRuleConditions {
  graphql?: MockGraphqlCondition;
}

/** A matcher an SDK can evaluate: a key of `MockRuleConditions`. */
export type MockMatcher = 'graphql';
export const MOCK_MATCHERS: readonly MockMatcher[] = ['graphql'];

/** The condition keys a rule uses (keys of `when` with a value), in order; unknown keys included ('when' itself when it is not an object). */
export function mockRuleMatchersUsed(rule: Pick<MockRule, 'when'>): string[] {
  const when = rule.when as unknown;
  if (when === undefined || when === null) return [];
  // Not an object: a condition nobody can evaluate (never matches, never sent).
  if (typeof when !== 'object' || Array.isArray(when)) return ['when'];
  const rec = when as Record<string, unknown>;
  return Object.keys(rec).filter((k) => rec[k] !== undefined && rec[k] !== null);
}

/**
 * Whether a rule may be sent to an SDK session that declared `declared` (`hello.sdk.mockMatchers`; absent = none):
 * every condition the rule uses must be declared. Rules without conditions go to every SDK.
 */
export function mockRuleSendableTo(rule: Pick<MockRule, 'when'>, declared: readonly string[] | undefined): boolean {
  const used = mockRuleMatchersUsed(rule);
  return used.length === 0 || used.every((m) => !!declared && declared.includes(m));
}

/** What a mock rule is matched against: what an SDK knows about a request when it intercepts it. */
export interface MockRequestInput {
  method: string;
  url: string;
  /** Bundle / package id of the app. */
  appId?: string;
  /** The request's Content-Type header, if any. */
  contentType?: string;
  /**
   * The request body as text, only when the SDK holds it already (a string, or bytes it decodes as UTF-8 without
   * reading a stream). Undefined = no body or not available (stream, file, form data, not read).
   */
  body?: string;
}

/** One GraphQL operation of a request. `name` absent = an anonymous operation; `type` absent = not known. */
export interface GraphqlOperationRef {
  name?: string;
  type?: GraphqlOperationType;
}

/** Longest text (UTF-16 code units: a body or a `query` URL parameter) the GraphQL reading looks at. */
export const MOCK_GRAPHQL_MAX_CHARS = 64 * 1024;

const isGqlNameStart = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isGqlNameChar = (c: string | undefined): boolean => isGqlNameStart(c) || (c !== undefined && c >= '0' && c <= '9');

/**
 * The operation definitions of a GraphQL document, in order (fragments skipped). Tokens: `#` comments run to the
 * end of the line; "strings" (backslash escapes, ending at the closing quote or the line end) and """block
 * strings""" (`\"""` escaped) are skipped; whitespace, commas and U+FEFF are insignificant. At brace depth 0 and
 * outside parentheses: the word `query` / `mutation` / `subscription` starts an operation whose name is the next
 * name token after whitespace / commas / comments, if one follows (anything else: anonymous); `fragment` starts a fragment; a `{` that no definition word
 * preceded is an anonymous query (shorthand). Malformed input never throws: whatever was read is returned.
 */
export function graphqlDocumentOperations(doc: string): { type: GraphqlOperationType; name?: string }[] {
  const ops: { type: GraphqlOperationType; name?: string }[] = [];
  const n = doc.length;
  let i = 0;
  let depth = 0;
  let parens = 0;
  // A definition word was read at depth 0 and its selection set has not started yet.
  let pending: 'operation' | 'fragment' | null = null;
  while (i < n) {
    const c = doc[i];
    if (c === '#') {
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') i++;
    } else if (c === '"') {
      if (doc.startsWith('"""', i)) {
        i += 3;
        while (i < n && !doc.startsWith('"""', i)) i += doc.startsWith('\\"""', i) ? 4 : 1;
        i = Math.min(n, i + 3);
      } else {
        i++;
        while (i < n && doc[i] !== '"' && doc[i] !== '\n') i += doc[i] === '\\' ? 2 : 1;
        i = Math.min(n, i + 1);
      }
    } else if (c === '(') {
      parens++;
      i++;
    } else if (c === ')') {
      parens = Math.max(0, parens - 1);
      i++;
    } else if (c === '{') {
      if (depth === 0 && parens === 0) {
        if (pending === null) ops.push({ type: 'query' });
        pending = null;
      }
      depth++;
      i++;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (isGqlNameStart(c)) {
      const start = i;
      while (i < n && isGqlNameChar(doc[i])) i++;
      if (depth === 0 && parens === 0 && pending === null) {
        const word = doc.slice(start, i);
        if (word === 'query' || word === 'mutation' || word === 'subscription') {
          let j = i;
          while (j < n) {
            if (doc[j] === '#') while (j < n && doc[j] !== '\n' && doc[j] !== '\r') j++;
            else if (doc[j] === ' ' || doc[j] === '\t' || doc[j] === '\n' || doc[j] === '\r' || doc[j] === ',' || doc[j] === '﻿') j++;
            else break;
          }
          if (isGqlNameStart(doc[j])) {
            let k = j;
            while (k < n && isGqlNameChar(doc[k])) k++;
            ops.push({ type: word, name: doc.slice(j, k) });
            i = k;
          } else {
            ops.push({ type: word });
          }
          pending = 'operation';
        } else if (word === 'fragment') {
          pending = 'fragment';
        }
      }
    } else {
      i++;
    }
  }
  return ops;
}

/** One `{ query?, operationName? }` payload: the operation the server runs (see `graphqlOperationsOf`). */
function graphqlPayloadOperation(query: unknown, operationName: unknown): GraphqlOperationRef | null {
  const name = typeof operationName === 'string' && operationName !== '' ? operationName : undefined;
  if (typeof query === 'string') {
    if (query.length > MOCK_GRAPHQL_MAX_CHARS) return null;
    const ops = graphqlDocumentOperations(query);
    if (name !== undefined) {
      const named = ops.find((o) => o.name === name);
      return named ? { name, type: named.type } : { name };
    }
    const first = ops[0];
    if (!first) return null;
    return first.name !== undefined ? { name: first.name, type: first.type } : { type: first.type };
  }
  return name !== undefined ? { name } : null;
}

function trimAsciiWhitespace(s: string): string {
  const ws = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let a = 0;
  let b = s.length;
  while (a < b && ws(s[a])) a++;
  while (b > a && ws(s[b - 1])) b--;
  return s.slice(a, b);
}

/** `name=value` pairs of a URL's query string (`+` = space, percent-decoded); null when one cannot be decoded. */
function urlQueryParams(url: string): Map<string, string> | null {
  const q = url.indexOf('?');
  const params = new Map<string, string>();
  if (q < 0) return params;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      if (!params.has(key)) params.set(key, decodeURIComponent(rawValue.replace(/\+/g, ' ')));
    } catch {
      return null;
    }
  }
  return params;
}

/**
 * Reference: the GraphQL operation(s) of a request, from what an SDK has when it intercepts it. Every SDK
 * implements exactly these rules (parity vectors: packages/protocol/vectors/mock-graphql.json):
 *  1. `body` present and not empty after trimming ASCII whitespace (space, tab, CR, LF; lengths count UTF-16 code
 *     units, JSON is strict RFC 8259):
 *     - `body` (untrimmed) longer than MOCK_GRAPHQL_MAX_CHARS → unknown (null);
 *     - content type contains `application/graphql` and not `json` → the body is a GraphQL document: its first
 *       operation (none → null);
 *     - trimmed body starts with `{` or `[` → parsed as JSON (invalid JSON → null). An object is one payload; an
 *       array (batched operations) gives one operation per payload element that has one (none → null). A payload:
 *       `operationName` (non-empty string) wins — its type is the type of that named operation in `query`, else
 *       unknown; without it, the first operation of `query`; with only `operationName` (persisted queries) the
 *       name alone; neither → no operation. A `query` longer than MOCK_GRAPHQL_MAX_CHARS → no operation;
 *     - any other body → null.
 *  2. No body and method GET (case-insensitive): the URL's `query` and `operationName` parameters, read like one
 *     payload. The query string runs from the first `?` to `#`; pairs split on `&` and the first `=`; `+` becomes a
 *     space, then percent-decoding (UTF-8); the first occurrence of a name wins; an undecodable pair → null.
 *  3. Otherwise null.
 * null means "unknown": a rule with a GraphQL condition does not match, the request goes to the network.
 */
export function graphqlOperationsOf(req: Pick<MockRequestInput, 'method' | 'url' | 'contentType' | 'body'>): GraphqlOperationRef[] | null {
  const held = req.body; // read once (a caller may compute it lazily)
  const raw = typeof held === 'string' ? held : '';
  const body = trimAsciiWhitespace(raw);
  if (body !== '') {
    if (raw.length > MOCK_GRAPHQL_MAX_CHARS) return null;
    const ct = (req.contentType ?? '').toLowerCase();
    if (ct.includes('application/graphql') && !ct.includes('json')) {
      const first = graphqlDocumentOperations(body)[0];
      if (!first) return null;
      return [first.name !== undefined ? { name: first.name, type: first.type } : { type: first.type }];
    }
    if (body[0] !== '{' && body[0] !== '[') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const payloads = Array.isArray(parsed) ? parsed : [parsed];
    const ops: GraphqlOperationRef[] = [];
    for (const p of payloads) {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) continue;
      const rec = p as Record<string, unknown>;
      const op = graphqlPayloadOperation(rec.query, rec.operationName);
      if (op) ops.push(op);
    }
    return ops.length > 0 ? ops : null;
  }
  if (req.method.toUpperCase() !== 'GET') return null;
  const params = urlQueryParams(req.url);
  if (!params) return null;
  const op = graphqlPayloadOperation(params.get('query'), params.get('operationName'));
  return op ? [op] : null;
}

/** Whether the request's operations satisfy a rule's GraphQL condition (unknown operations never do). */
function graphqlConditionHolds(cond: unknown, ops: GraphqlOperationRef[] | null): boolean {
  if (!ops || typeof cond !== 'object' || cond === null) return false;
  const c = cond as Record<string, unknown>;
  if (typeof c.operationName !== 'string' || c.operationName === '') return false;
  const type = c.operationType;
  if (type !== undefined && type !== null && type !== 'query' && type !== 'mutation' && type !== 'subscription') return false;
  return ops.some((op) => op.name === c.operationName && (type === undefined || type === null || op.type === type));
}

/**
 * Reference matcher v2: `mockRuleMatches` on method / URL / apps, then every condition of `rule.when`:
 *  - `graphql`: one of `graphqlOperationsOf(req)` has exactly that name (case-sensitive) and, when the condition
 *    names a type, that type; unknown operations (null) never match. Batched bodies match when any element does;
 *  - any other key (a matcher this code does not know) → the rule never matches.
 * `ops` lets a caller read the request once for many rules (pass what `graphqlOperationsOf(req)` returned).
 */
export function mockRuleMatchesRequest(rule: MockRule, req: MockRequestInput, ops?: GraphqlOperationRef[] | null): boolean {
  if (!mockUrlRuleMatches(rule, req.method, req.url, req.appId)) return false;
  const used = mockRuleMatchersUsed(rule);
  if (used.length === 0) return true;
  for (const key of used) if (key !== 'graphql') return false;
  return graphqlConditionHolds(rule.when?.graphql, ops === undefined ? graphqlOperationsOf(req) : ops);
}

/** First enabled matching rule for a request (rules are ordered; first match wins). Reads the body at most once. */
export function findMockRuleForRequest(rules: readonly MockRule[], req: MockRequestInput): MockRule | undefined {
  let ops: GraphqlOperationRef[] | null | undefined;
  for (const rule of rules) {
    if (!mockUrlRuleMatches(rule, req.method, req.url, req.appId)) continue;
    if (mockRuleMatchersUsed(rule).length === 0) return rule;
    if (ops === undefined) ops = graphqlOperationsOf(req);
    if (mockRuleMatchesRequest(rule, req, ops)) return rule;
  }
  return undefined;
}

/**
 * Reference matcher. Every SDK implements identical semantics:
 *  - method: '*' matches anything, otherwise case-insensitive equality;
 *  - contains / exact / glob: case-insensitive; glob '*' = any run of chars (incl. '/'), '?' = one char,
 *    and must match the WHOLE url;
 *  - regex: pattern used as-is (case-sensitive), searched anywhere in the url; invalid regex never matches;
 *  - apps: empty/undefined = all apps, otherwise must contain the app id.
 * A rule with conditions (`when`) is checked as `mockRuleMatchesRequest` with no body: a GraphQL condition can then
 * only be read from a GET request's URL, otherwise it does not match.
 */
export function mockRuleMatches(rule: MockRule, method: string, url: string, appId?: string): boolean {
  if (mockRuleMatchersUsed(rule).length === 0) return mockUrlRuleMatches(rule, method, url, appId);
  return mockRuleMatchesRequest(rule, { method, url, appId });
}

/** Method / URL / apps part of the reference matcher (see `mockRuleMatches`). */
function mockUrlRuleMatches(rule: MockRule, method: string, url: string, appId?: string): boolean {
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
 *      Android app-stop also takes `background: true`: Home, then the system's background kill (`am kill`) as
 *      under memory pressure (`action.backgroundKilled`; `action.backgroundKillRefused` when a foreground
 *      service keeps it alive, `action.appNotRunning` when it does not run).
 *  app-install { file* }                  (server path returned by POST /api/upload; Android: .apk, .apks, .xapk)
 *  logs-clear-buffer {} · logs-restart {}
 *  appearance { mode*: 'dark' | 'light' }
 *  font-scale { scale*: number }          (Android 0.85–2.0; iOS simulator maps to content size)
 *  animations { enabled*: boolean }       (Android)
 *  input-text { text* }                   (Android)
 *  key-event { key*: 'back'|'home'|'recents'|'power'|'volume-up'|'volume-down'|'enter'|'delete'|'menu' }
 *  push-notification { appId*, payload*: object }   (iOS simulator)
 *  location { lat*, lon* }                (iOS simulator, Android emulator)
 *  status-bar { mode*: 'clean' | 'reset' }           (iOS simulator)
 *  screen-record { durationSec?: number } → data: ScreenRecordData
 *      Records until `screen-record-stop`, `durationSec` or the platform limit (Android 180 s, iOS 600 s) and
 *      replies once the file is ready. One recording per device (`action.recording.busy`); while it runs,
 *      `DeviceInfo.recording` is set.
 *  screen-record-stop {}                  → data: ScreenRecordData (the same file the `screen-record` reply gets)
 *      `action.recording.notRunning` when the device is not recording.
 *  app-install also takes `replace: true`: after a refusal over the installed copy (`action.install.signatureMismatch`,
 *      `action.install.downgrade`; their data: InstallRefusalData) it uninstalls that app first, which deletes its
 *      data (the UI asks), then installs: `action.install.replaced` {packageId}; `action.install.packageUnknown`
 *      (the file's app id could not be read), `action.install.replaceUninstallFailed` {packageId, detail} (nothing
 *      changed), `action.install.replaceInstallFailed` {packageId, detail} (the old app is gone, the new one failed).
 *  Android phones with several users (DeviceInfo.users): list-apps, app-launch, app-stop, app-restart, app-clear-data,
 *      app-uninstall, app-install, app-permission, app-locale, app-settings take `userId?: number` (default: the
 *      phone's default); an id the phone does not have is `action.invalidParams`.
 *  Settings with `{ restore: true }` (the value from before Dürbün's first change, DeviceInfo.settingOverrides;
 *  `action.settingRestored` / `action.nothingToRestore`): appearance, font-scale, animations, airplane-mode, wifi,
 *  mobile-data, rotation, dont-keep-activities (Android), app-permission and app-locale (with their appId /
 *  permission).
 *  app-permission { appId*, permission*, grant*: boolean }
 *      Android 6+: a runtime permission ("android.permission.CAMERA"; revoking one ends the app);
 *      `action.permissionUnknown`, `action.permissionNotRequested`, `action.permissionNotChangeable`.
 *      iOS simulator: a privacy service (all, calendar, contacts, contacts-limited, location, location-always,
 *      photos, photos-add, media-library, microphone, motion, reminders, siri); `restore: true` there means "ask
 *      again" (simctl privacy reset: the simulator cannot say what was set before), `action.permissionReset`.
 *  app-settings { appId* }                (Android) opens the app's page in the system settings
 *  app-locale { appId*, locale*: BCP 47 tag ('tr-TR') | 'system' }   (Android 13+) the app's own language
 *  airplane-mode { enabled*: boolean }    (Android 11+; not over a Wi-Fi adb connection: `action.wouldDisconnect`)
 *  wifi { enabled*: boolean }             (Android; not over a Wi-Fi adb connection)
 *  mobile-data { enabled*: boolean }      (Android)
 *  rotation { orientation*: 'auto' | 'portrait' | 'landscape' | 'reverse-portrait' | 'reverse-landscape' }  (Android)
 *  dont-keep-activities { enabled*: boolean }   (Android "Don't keep activities": every activity ends when left)
 *  keychain-reset {}                      (iOS simulator) deletes every keychain item of the simulator
 *  bug-report {}                          → data: BugReportData (Android 7+, `adb bugreport`: 1–3 minutes, 10–50 MB)
 *      Replies once the file is ready; while it runs `DeviceInfo.bugReport` shows its progress. One per device
 *      (`action.bugReport.busy`).
 *  bug-report-cancel {}                   stops it (`action.bugReport.cancelled` on the `bug-report` reply;
 *      `action.bugReport.notRunning` when none runs).
 *  app-data { appId*, userId? }           → data: AppDataPullData. A copy of the app's own data folder (shared
 *      preferences, databases, files; cache folders left out) as one .tar.gz in the temp folder. Android: debuggable
 *      apps through `run-as` (`action.appData.notDebuggable`, `action.appData.notInstalled`, `action.appData.locked`
 *      before the first unlock, `action.appData.noTar`); iOS simulator: the app's data container
 *      (`action.appNotFound`). Not on a physical iPhone (`action.appData.iphoneUnsupported` in `unavailable`).
 *      Past 1 GiB of data (before compression) it stops with `action.appData.tooLarge` {limit}; an app without
 *      data gives `action.appData.empty`; a stream cut short `action.appData.incomplete`; past 10 minutes
 *      `action.appData.timeout` {minutes}. One pull per device at a time (`action.appData.busy`).
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
  /**
   * Android also takes an optional `{ bufferSize: '16M' }` (64K–256M): the device's log buffers get that
   * size (`logcat -G`, until the phone restarts) before the stream restarts; reply data LogBufferSizeData.
   */
  | 'logs-restart'
  /**
   * 'appearance', 'font-scale', 'animations': on Android the value from before Dürbün's first change is kept
   * (`DeviceInfo.settingOverrides`); `{ restore: true }` instead of the usual params puts it back
   * (`action.settingRestored`, or `action.nothingToRestore` when Dürbün changed nothing).
   */
  | 'appearance'
  | 'font-scale'
  | 'animations'
  | 'input-text'
  | 'key-event'
  | 'push-notification'
  | 'location'
  | 'status-bar'
  | 'screen-record'
  | 'screen-record-stop'
  | 'app-permission'
  | 'app-settings'
  | 'app-locale'
  | 'airplane-mode'
  | 'wifi'
  | 'mobile-data'
  | 'rotation'
  | 'dont-keep-activities'
  | 'keychain-reset'
  | 'bug-report'
  | 'bug-report-cancel'
  | 'app-data';

/** Reply data of a refused `app-install` the installed copy is in the way of (see `replace: true`). */
export interface InstallRefusalData {
  /** Package / bundle id of the file (read from the file itself); absent when it could not be read. */
  packageId?: string;
  /** "Uninstall and install" can work: the id is known and the refusal is about the installed copy. */
  replaceable: boolean;
}

/** Reply data of `bug-report`. */
export interface BugReportData {
  /** Same-origin URL of the .zip. */
  url: string;
  /** Server-side path. */
  file: string;
  bytes: number;
  durationSec: number;
}

/** Reply data of `app-data`: the app's data folder as one .tar.gz. */
export interface AppDataPullData {
  /** Same-origin URL of the .tar.gz. */
  url: string;
  /** Server-side path. */
  file: string;
  /** File name for a download ("app-data-com.example.shop-Pixel-8-20261116-141502.tar.gz"). */
  fileName: string;
  appId: string;
  /** Size of the .tar.gz. */
  bytes: number;
  /** Size of the data before compression. */
  rawBytes: number;
  durationSec: number;
}

/** Reply data of `screen-record` / `screen-record-stop`. */
/** Reply data of Android `logs-restart` with `bufferSize`: ring buffer size per log buffer (bytes) before and after. */
export interface LogBufferSizeData {
  before: Record<string, number>;
  after: Record<string, number>;
  /** The size asked for, e.g. "16M". */
  requested: string;
}

export interface ScreenRecordData {
  /** Same-origin URL of the video. */
  url: string;
  /** Server-side path. */
  file: string;
  /** Recorded length (s). */
  durationSec?: number;
  /** 'limit' = it stopped by itself at `DeviceRecording.limitSec`. */
  endedBy?: 'stop' | 'limit';
  /** The copy kept in the media library (absent: the server keeps none, e.g. a flow run's own recording). */
  media?: MediaItem;
}

/* ────────────────────────────── Media library (screenshots, recordings) ────────────────────────────── */

export type MediaKind = 'screenshot' | 'recording';

/**
 * A screenshot or screen recording a window took, kept on disk under `<dataDir>/media/` (GET /api/media). The
 * `screenshot` reply data and ScreenRecordData carry it as `media`; the device's log timeline gets a marker line
 * (`code: 'media.screenshot' | 'media.recording'`, `data.media: MediaRef`).
 */
export interface MediaItem {
  id: string;
  kind: MediaKind;
  deviceId: string;
  /** Device name when it was taken (the device may be gone later). */
  deviceName?: string;
  platform?: DevicePlatform;
  /** Taken at (a recording: when it started), epoch ms (Mac clock). */
  ts: number;
  /** Recording: when it ended. */
  endTs?: number;
  durationSec?: number;
  width?: number;
  height?: number;
  bytes: number;
  /** Same-origin URL of the file (`/api/media/<id>`; `?download=1` for a download). */
  url: string;
  /** File name for a download ("screenshot-Pixel-8-20261116-140210.png"). */
  fileName: string;
  /** Id of the marker line on the device's log timeline (while the logs still hold it). */
  logId?: number;
}

/** `data.media` of a marker line: which library item it points at. */
export interface MediaRef {
  id: string;
  kind: MediaKind;
}

/** How long the media library keeps files: the oldest go first past any limit. */
export interface MediaPolicy {
  maxAgeDays: number;
  maxBytes: number;
  maxItems: number;
}

/** GET /api/media[?deviceId=] — newest first. */
export interface MediaList {
  items: MediaItem[];
  policy: MediaPolicy;
  /** Bytes the whole library uses (every device). */
  usedBytes: number;
  /** Items in the whole library (every device). */
  total: number;
}

/* ────────────────────────────── Android wireless debugging (pair over Wi-Fi) ────────────────────────────── */

/** A phone on this network that advertises wireless debugging (`adb mdns services`). */
export interface AdbWirelessService {
  /** mDNS instance name ("adb-R5CT20XK9QM-x7Kp2a"). */
  name: string;
  /** 'pairing': the phone shows its "Pair device with pairing code" screen; 'connect': wireless debugging is on. */
  kind: 'pairing' | 'connect';
  host: string;
  port: number;
  /** The phone's serial number, from the name. */
  serial?: string;
  /** adb already has this phone connected over Wi-Fi. */
  connected?: boolean;
}

/**
 * GET /api/android/wireless — what the pairing screen can offer. `adb: false` when adb is missing (code
 * `action.toolMissing`); `discovery: 'unavailable'` when this adb cannot list mDNS services (pairing by typing the
 * address still works).
 */
export interface AdbWirelessState {
  adb: boolean;
  discovery: 'ok' | 'unavailable';
  services: AdbWirelessService[];
  /** Why discovery is unavailable (adb's own words). */
  detail?: string;
}

/**
 * POST /api/android/wireless/pair { host, port, code } and /connect { host, port } reply. A refused pairing or
 * connection is HTTP 200 with `ok: false` and a code (`adb.wireless.wrongCode`, `.unreachable`, `.refused`,
 * `.notPaired`, `.badAddress`, `.timeout`, `.adbTooOld`, `.failed` {detail}); bad input is HTTP 400.
 * After a pairing the server looks for the phone's connect service and connects to it (`connected`).
 */
export interface AdbWirelessResult {
  ok: boolean;
  code: string;
  message: string;
  params?: I18nParams;
  /** pair: the address it paired with; connect: the address connected to. */
  address?: string;
  /** connect (or pair + automatic connect): adb's serial of the phone. */
  serial?: string;
  /** pair: whether it was connected afterwards, and where; absent when no connect service was found. */
  connected?: { ok: boolean; address: string; code: string; message?: string };
}

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
  /** Params of `code` (tool, versions, app id, the tool's own output as `detail`…), so the UI words it fully. */
  params?: I18nParams;
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
  /**
   * Capture WebSocket messages and SSE events of the apps (SDKs with the `streams` capability). Their payloads
   * follow `captureBodies`; one payload is kept up to min(maxBodyBytes, 64 KiB). Optional for older servers
   * (absent = on).
   */
  captureStreams?: boolean;
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
  captureStreams: true,
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
  /** Params of `code` (device counts, tool versions…; the English `detail` is the fallback). */
  params?: I18nParams;
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

/**
 * The store limits as the server applies them. The UI holds no more than the server does: it learns the limits
 * here and follows the server's evictions (`StoreEvictions.oldestLogId`), so both always show the same data.
 */
export interface StoreLimits {
  maxLogEntries: number;
  /** Estimated memory of the log ring (bytes): the oldest lines go when it is full, even below maxLogEntries. */
  maxLogBytes: number;
  /** Crash / ANR records kept after the ring let them go (the newest this many). */
  maxKeptCrashes: number;
  maxNetworkEntries: number;
  /** Memory for request / response bodies (bytes): the oldest bodies go first, their requests stay (`bodyEvicted`). */
  maxBodyStoreBytes: number;
}

export interface EvictedCounts {
  logs: number;
  requests: number;
}

/**
 * What the limits deleted since the server started or the last full clear (a scoped clear takes its device or
 * sessions out). Lines with an id below `oldestLogId` are gone, except crash / ANR records kept apart.
 */
export interface StoreEvictions {
  logs: number;
  /** Of `logs`: deleted because the log memory (`StoreLimits.maxLogBytes`) was full before the line limit. */
  logsByBytes: number;
  requests: number;
  /** Request bodies the body memory deleted (their requests stay). */
  bodies: number;
  /** Oldest line id still held in the ring; 0 when it is empty. */
  oldestLogId: number;
  /** Time of the newest deleted line: everything before it may be incomplete. */
  lastEvictedLogTs?: number;
  /** Time of the newest deleted request (`startTs`). */
  lastEvictedRequestTs?: number;
  byDevice: Record<string, EvictedCounts>;
  /** Per app session (`AppSession.id`): lines that carried its `appId`, its requests. */
  byApp: Record<string, EvictedCounts>;
  /**
   * Device lines without an app session, per `"<deviceId>|<process name>"` (apps without an SDK); Dürbün's own
   * lines about the device (connection, log stream), which every app scope of the device shows, under
   * `"<deviceId>|"`.
   */
  byProcess: Record<string, number>;
}

/**
 * A snapshot that continues the copy a reconnecting UI still holds. The UI asks for it by opening
 * `/ui?epoch=<snapshot.epoch>&afterLogId=<newest log id it holds>&netSeq=<newest netSeq it saw>`; a server
 * that cannot continue (restarted, cleared meanwhile, unknown values) sends an ordinary full snapshot.
 * When resumed: `network` holds only the requests changed after `netSeq`, `metrics` all series again, and the
 * `history` that follows only lines newer than `afterLogId` (`logCount` is their number).
 */
/** Requests one mock rule answered since the server started (see MockRuleHits). */
export interface MockRuleHitCount {
  count: number;
  /** Device time of the latest answer (epoch ms). */
  lastTs: number;
  /** Per app session id (a bounded number of sessions; the total stays exact). */
  byApp?: Record<string, number>;
}

/**
 * The server's count of the requests each mock rule answered, by rule id: the same in every window and kept when
 * the request list is cleared. A deleted rule loses its count; a server restart starts every count at 0.
 */
export type MockRuleHits = Record<string, MockRuleHitCount>;

export interface UiResumed {
  afterLogId: number;
  /** Every request id the server holds: the UI drops the others (deleted while it was away). */
  networkIds: string[];
}

export type ServerToUi =
  | {
      type: 'hello';
      server: ServerInfo;
      settings: ServerSettings;
      /** Optional for older servers. */
      limits?: StoreLimits;
    }
  | {
      type: 'snapshot';
      /** The data generation: a new server run or a clear makes a new one. Echoed back to resume. */
      epoch?: string;
      /** Network change counter after this snapshot (echoed back to resume). */
      netSeq?: number;
      /** Present when the snapshot continues the UI's copy instead of replacing it. */
      resumed?: UiResumed;
      evictions?: StoreEvictions;
      /** Mock rule hit counts (every rule that answered something). Optional for older servers. */
      mockHits?: MockRuleHits;
      devices: DeviceInfo[];
      apps: AppSession[];
      network: NetworkEntry[];
      mocks: MockRule[];
      /** Revision of the mock rule list (see `mocks.set` `baseRevision`). */
      mocksRevision?: number;
      drivers: DriverStatus[];
      processes: ProcessUpdate[];
      metrics: MetricSample[];
      logCount: number;
      /** Apps the devices report (SPEC §10). Optional for older servers. */
      deviceApps?: DeviceApp[];
      /** Saved flows (Akışlar). Optional for older servers. */
      flows?: FlowSummary[];
      /** Flow runs still running. */
      flowRuns?: FlowRun[];
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
      /** Network change counter after this batch (see snapshot.netSeq). */
      netSeq?: number;
      /** Sent when the limits deleted something since the previous batch. */
      evictions?: StoreEvictions;
      /** Every mock rule's hit count, sent when one changed since the previous batch (replaces the previous map). */
      mockHits?: MockRuleHits;
    }
  | {
      type: 'cleared';
      target: ClearTarget;
      deviceId?: string;
      appId?: string;
      bundleId?: string;
      /** The data generation after the clear (see snapshot.epoch). */
      epoch?: string;
      /** The eviction counts after the clear. */
      evictions?: StoreEvictions;
    }
  | {
      type: 'mocks';
      rules: MockRule[];
      /** Revision of the rule list; send it back as `mocks.set` `baseRevision`. */
      revision?: number;
    }
  | { type: 'settings'; settings: ServerSettings; limits?: StoreLimits }
  | { type: 'drivers'; drivers: DriverStatus[] }
  | ({ type: 'notice' } & UiNotice)
  /** `params`: of `code` (a device refusal's tool, versions, app…); `error` stays the English text. */
  | { type: 'reply'; requestId: string; ok: boolean; data?: unknown; error?: string; code?: string; params?: I18nParams }
  /** The flow list changed (saved, deleted, imported, a run ended). */
  | { type: 'flows'; flows: FlowSummary[] }
  /** A flow run changed: its header plus the steps that changed since the previous message. */
  | ({ type: 'flowRun' } & FlowRunDelta);

export interface ReplayOverrides {
  method?: string;
  url?: string;
  headers?: Header[];
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
  /** Send without verifying the server certificate (a self-signed test server); the reply warns `replay.tlsUnverified`. */
  skipTlsVerify?: boolean;
}

/**
 * Reply `data` per command:
 *  clear → null · marker.add → LogEntry · device.action → DeviceActionResult.data (reply.ok = result.ok)
 *  app.action → DeviceActionResult.data · mocks.set → MockRule[] · settings.update → ServerSettings
 *  vm.attach → { appId } · vm.detach → null · metrics.watch → null · net.replay → NetworkEntry
 *  demo.set → { enabled } · doctor.run → ToolCheck[]
 *
 * `clear` removes what the UI scope shows: no ids = everything · deviceId = one device · deviceId + bundleId =
 * one app of the device (its sessions, its processes' device lines, its crash records) · appId = one session
 * and the device lines of its process. Global markers stay in a scoped clear.
 */
export type UiCommand =
  | { name: 'clear'; target: ClearTarget; deviceId?: string; appId?: string; bundleId?: string }
  | { name: 'marker.add'; label?: string; deviceId?: string }
  | { name: 'device.action'; deviceId: string; action: DeviceActionId; params?: Record<string, unknown> }
  | { name: 'app.action'; appId: string; action: string; params?: Record<string, unknown> }
  /**
   * `baseRevision`: the revision the edited list was based on (snapshot `mocksRevision` / `mocks` `revision`).
   * When another window changed the rules since, the command fails with `mocks.conflict` (data: the current
   * `{ rules, revision }`) instead of overwriting them; leave it out to overwrite.
   */
  | { name: 'mocks.set'; rules: MockRule[]; baseRevision?: number }
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
  /**
   * true: secret header values, cookies, secret-looking query parameters and body fields were replaced by
   * "••••" when the file was written (GET /api/export without mask=0). Absent in raw exports.
   */
  masked?: boolean;
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
  /**
   * The SDK cannot see this connection's messages (a WebSocket opened outside its hook): the server opens no
   * stream for this handshake and the entry stays a plain response (SPEC §6.1.1).
   */
  noStream?: boolean;
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

/**
 * One WebSocket message of the connection whose handshake was `net.request` `id` (SPEC §6.1.1). Send it only
 * while `config.captureStreams` is true (an older server leaves it out of the config and would count the message
 * as an unknown type). Continuation frames are joined: one message per text / binary message.
 */
export interface SdkNetWs {
  type: 'net.ws';
  /** The handshake request's id (the `net.request` that got the 101). */
  id: string;
  ts: number;
  dir: 'in' | 'out';
  opcode: WsOpcode;
  /** Full payload size in bytes. */
  size: number;
  /** Payload capped at `config.maxStreamMessageBytes` (text utf8, binary base64); none when captureBodies is off. */
  body?: WireBody;
  /** opcode 'close': the code and reason of the close frame. */
  closeCode?: number;
  closeReason?: string;
}

/**
 * One Server-Sent Events event of the response to `net.request` `id` (send the `net.response` as soon as the
 * headers arrive, without a body), or `end: true` when the stream ended normally (a broken stream: `net.error`).
 * Same gating as `net.ws`.
 */
export interface SdkNetSse {
  type: 'net.sse';
  id: string;
  ts: number;
  /** `event:` field (omit for the default "message"). */
  event?: string;
  /** `id:` field. */
  eventId?: string;
  /** `retry:` field, ms. */
  retry?: number;
  /** Full size of `data` in bytes (UTF-8). */
  size?: number;
  /** The `data:` lines joined with "\n", utf8, capped like `net.ws`. */
  body?: WireBody;
  /** The stream ended normally (no other field needed). */
  end?: boolean;
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
  | SdkNetWs
  | SdkNetSse
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
  /**
   * Send `net.ws` / `net.sse` messages. Absent (an older server) or false: send none. Optional for older servers.
   */
  captureStreams?: boolean;
  /** Payload cap of one stream message in bytes (0: send none, only sizes). Optional for older servers. */
  maxStreamMessageBytes?: number;
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
