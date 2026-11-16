/**
 * Wire-protocol shapes used by the SDK.
 *
 * These mirror `packages/protocol/src/index.ts` (the source of truth) so that the published package has
 * no runtime or type-level dependency on the private `@durbun/protocol` workspace package.
 * `test/protocol-compat.test.ts` asserts at compile time that every type here is identical to the
 * protocol's, and at runtime that the copied helpers behave identically.
 */

export const PROTOCOL_VERSION = 1;

/** Default desktop HTTP port (UI, REST and the `/sdk` WebSocket endpoint). */
export const DEFAULT_HTTP_PORT = 9750;

/** Max size of one WebSocket frame accepted by the desktop. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type LogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export const LOG_LEVELS: readonly LogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];

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

export type DevicePlatform = 'android' | 'ios' | 'other';
export type SdkPlatform = 'flutter' | 'android' | 'ios' | 'react-native' | 'js' | 'dart-vm' | 'demo';
/** `streams`: the SDK can send `net.ws` / `net.sse` (only while `config.captureStreams` is true). */
export type SdkCapability = 'logs' | 'network' | 'mocks' | 'metrics' | 'events' | 'crash' | 'commands' | 'streams';
/** Layers inside the app that feed one session ('dart' + 'android' / 'ios' for the Flutter plugin). */
export type SdkLayer = 'dart' | 'android' | 'ios';
/** `hello.sdk`. */
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
  /** Executable/process name. */
  processName?: string;
  debug?: boolean;
}

export interface AppActionDescriptor {
  /** e.g. 'rn.reload' */
  id: string;
  kind: 'toggle' | 'select' | 'button';
  /** English fallback label. */
  label: string;
  /** UI i18n key (optional). */
  labelKey?: string;
  /** Grouping, e.g. 'react-native'. */
  group?: string;
  options?: { value: string; label: string }[];
  /** Current state when known. */
  value?: boolean | string;
}

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

/** WebSocket frame opcodes Dürbün keeps (continuation frames are joined into one message). */
export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

/** One WebSocket message of the connection whose handshake was `net.request` `id`. */
export interface SdkNetWs {
  type: 'net.ws';
  /** The handshake request's id (the `net.request` that got the 101). */
  id: string;
  ts: number;
  dir: 'in' | 'out';
  opcode: WsOpcode;
  /** Full payload size in bytes. */
  size: number;
  /** Payload capped at `config.maxStreamMessageBytes` (text utf8, binary base64). */
  body?: WireBody;
  /** opcode 'close': the code and reason of the close frame. */
  closeCode?: number;
  closeReason?: string;
}

/** One Server-Sent Events event of the response to `net.request` `id`, or `end: true` at a normal end. */
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
  /** Send `net.ws` / `net.sse` messages. Absent (an older desktop) or false: send none. */
  captureStreams?: boolean;
  /** Payload cap of one stream message in bytes (0: send none, only sizes). */
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

/** Config used until the desktop's `welcome` arrives (mirrors the server's DEFAULT_SETTINGS). */
export const DEFAULT_SDK_CONFIG: SdkConfig = {
  captureBodies: true,
  maxBodyBytes: 1_048_576,
  metricsIntervalMs: 1_000,
  deviceLogsAvailable: false,
};

/** Content types captured as UTF-8 text (everything else is base64). Identical to the protocol helper. */
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
