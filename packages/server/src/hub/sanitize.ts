/** Defensive normalization of data entering the hub from drivers and imported session files. */
import type {
  AppSession,
  DeviceInfo,
  Header,
  LogEntry,
  LogKind,
  LogLevel,
  LogOrigin,
  LogSource,
  NetworkDetail,
  WireBody,
} from '@durbun/protocol';
import { LOG_LEVELS } from '@durbun/protocol';

const LEVELS = new Set<string>(LOG_LEVELS);
const KINDS = new Set<string>(['text', 'crash', 'anr', 'flutter-error', 'event', 'network', 'lifecycle', 'marker']);
const SOURCES = new Set<string>(['device', 'app', 'system']);
const NET_STATES = new Set<string>(['pending', 'complete', 'failed', 'cancelled']);
const ORIGINS = new Set<string>([
  'logcat',
  'idevicesyslog',
  'simctl-log',
  'sdk',
  'vm-service',
  'dropbox',
  'crash-report',
  'durbun',
  'demo',
  'import',
] satisfies LogOrigin[]);

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function normLevel(level: unknown): LogLevel {
  return typeof level === 'string' && LEVELS.has(level) ? (level as LogLevel) : 'info';
}

export function normKind(kind: unknown): LogKind | undefined {
  return typeof kind === 'string' && KINDS.has(kind) ? (kind as LogKind) : undefined;
}

/** A known LogOrigin, else undefined (unknown values are dropped rather than passed to the UI). */
export function normOrigin(origin: unknown): LogOrigin | undefined {
  return typeof origin === 'string' && ORIGINS.has(origin) ? (origin as LogOrigin) : undefined;
}

export function toMessage(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function sanitizeHeaders(v: unknown): Header[] {
  if (!Array.isArray(v)) return [];
  const out: Header[] = [];
  for (const h of v) {
    if (Array.isArray(h) && typeof h[0] === 'string') out.push([h[0], toMessage(h[1])]);
  }
  return out;
}

export function sanitizeBody(v: unknown): WireBody | undefined {
  if (!isRecord(v) || typeof v.data !== 'string') return undefined;
  const encoding = v.encoding === 'base64' ? 'base64' : 'utf8';
  const size = finite(v.size) ?? (encoding === 'base64' ? Math.floor((v.data.length * 3) / 4) : Buffer.byteLength(v.data));
  const body: WireBody = { encoding, data: v.data, size: Math.max(0, size) };
  if (v.truncated === true) body.truncated = true;
  return body;
}

/** An imported log line (ids/devices are remapped by the caller); undefined when unusable. */
export function sanitizeImportedLog(v: unknown): LogEntry | undefined {
  if (!isRecord(v)) return undefined;
  const ts = finite(v.ts);
  if (ts === undefined) return undefined;
  const source = typeof v.source === 'string' && SOURCES.has(v.source) ? (v.source as LogSource) : 'device';
  const entry: LogEntry = {
    id: finite(v.id) ?? 0,
    ts,
    deviceId: str(v.deviceId) ?? '',
    source,
    level: normLevel(v.level),
    tag: str(v.tag) ?? '',
    message: toMessage(v.message),
  };
  const appId = str(v.appId);
  if (appId) entry.appId = appId;
  const pid = finite(v.pid);
  if (pid !== undefined) entry.pid = pid;
  const tid = finite(v.tid);
  if (tid !== undefined) entry.tid = tid;
  for (const key of ['process', 'subsystem', 'category', 'netId', 'code'] as const) {
    const s = str(v[key]);
    if (s !== undefined) entry[key] = s;
  }
  const kind = normKind(v.kind);
  if (kind) entry.kind = kind;
  // Imported lines keep where they originally came from; files from older servers say 'import'.
  entry.origin = normOrigin(v.origin) ?? 'import';
  if (v.data !== undefined) entry.data = v.data;
  if (isRecord(v.error)) {
    entry.error = {};
    for (const key of ['type', 'message', 'stack'] as const) {
      const s = str(v.error[key]);
      if (s !== undefined) entry.error[key] = s;
    }
  }
  if (isRecord(v.params)) {
    const params: Record<string, string | number> = {};
    for (const [k, val] of Object.entries(v.params)) {
      if (typeof val === 'string' || (typeof val === 'number' && Number.isFinite(val))) params[k] = val;
    }
    entry.params = params;
  }
  return entry;
}

export function sanitizeImportedDevice(v: unknown): DeviceInfo | undefined {
  if (!isRecord(v) || typeof v.id !== 'string') return undefined;
  const platform = v.platform === 'android' || v.platform === 'ios' ? v.platform : 'other';
  const kind =
    v.kind === 'physical' || v.kind === 'emulator' || v.kind === 'simulator' || v.kind === 'virtual' ? v.kind : 'virtual';
  const now = Date.now();
  const device: DeviceInfo = {
    id: v.id,
    platform,
    kind,
    name: str(v.name) || v.id,
    connection: 'unknown',
    state: 'disconnected',
    logs: { status: 'stopped' },
    actions: [],
    firstSeen: finite(v.firstSeen) ?? now,
    lastSeen: finite(v.lastSeen) ?? now,
  };
  for (const key of ['model', 'manufacturer', 'osVersion', 'serial'] as const) {
    const s = str(v[key]);
    if (s) device[key] = s;
  }
  const apiLevel = finite(v.apiLevel);
  if (apiLevel !== undefined) device.apiLevel = apiLevel;
  if (isRecord(v.screen) && finite(v.screen.width) !== undefined && finite(v.screen.height) !== undefined) {
    device.screen = { width: v.screen.width as number, height: v.screen.height as number };
    const density = finite(v.screen.density);
    if (density !== undefined) device.screen.density = density;
  }
  return device;
}

export function sanitizeImportedApp(v: unknown): AppSession | undefined {
  if (!isRecord(v) || typeof v.id !== 'string' || !isRecord(v.app) || typeof v.app.id !== 'string') return undefined;
  const sdk = isRecord(v.sdk) ? v.sdk : {};
  const platforms = ['flutter', 'android', 'ios', 'react-native', 'js', 'dart-vm', 'demo'];
  const app: AppSession = {
    id: v.id,
    sessionKey: str(v.sessionKey) ?? v.id,
    deviceId: str(v.deviceId) ?? '',
    sdk: {
      name: str(sdk.name) ?? 'unknown',
      version: str(sdk.version) ?? '',
      platform: (platforms.includes(sdk.platform as string) ? sdk.platform : 'js') as AppSession['sdk']['platform'],
    },
    app: { name: str(v.app.name) || v.app.id, id: v.app.id },
    transport: 'import',
    connected: false,
    connectedAt: finite(v.connectedAt) ?? Date.now(),
    capabilities: Array.isArray(v.capabilities) ? (v.capabilities.filter((c) => typeof c === 'string') as AppSession['capabilities']) : [],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  };
  const disconnectedAt = finite(v.disconnectedAt);
  if (disconnectedAt !== undefined) app.disconnectedAt = disconnectedAt;
  for (const key of ['version', 'build', 'processName'] as const) {
    const s = str(v.app[key]);
    if (s) app.app[key] = s;
  }
  const pid = finite(v.app.pid);
  if (pid !== undefined) app.app.pid = pid;
  if (typeof v.app.debug === 'boolean') app.app.debug = v.app.debug;
  return app;
}

export function sanitizeImportedNetwork(v: unknown): NetworkDetail | undefined {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.url !== 'string') return undefined;
  const startTs = finite(v.startTs);
  if (startTs === undefined) return undefined;
  const state = typeof v.state === 'string' && NET_STATES.has(v.state) ? (v.state as NetworkDetail['state']) : 'complete';
  const detail: NetworkDetail = {
    id: v.id,
    deviceId: str(v.deviceId) ?? '',
    source: str(v.source) ?? 'import',
    method: str(v.method) || 'GET',
    url: v.url,
    host: str(v.host) ?? '',
    path: str(v.path) ?? '',
    startTs,
    state: state === 'pending' ? 'failed' : state,
    requestHeaders: sanitizeHeaders(v.requestHeaders),
    hasRequestBody: v.hasRequestBody === true,
    hasResponseBody: v.hasResponseBody === true,
  };
  if (state === 'pending') detail.error = 'Still pending when the session was exported';
  const appId = str(v.appId);
  if (appId) detail.appId = appId;
  for (const key of ['endTs', 'duration', 'status', 'requestBodySize', 'responseBodySize'] as const) {
    const n = finite(v[key]);
    if (n !== undefined) detail[key] = n;
  }
  for (const key of ['statusText', 'requestContentType', 'responseContentType', 'protocol', 'remoteAddress', 'mockRuleId'] as const) {
    const s = str(v[key]);
    if (s !== undefined) detail[key] = s;
  }
  const error = str(v.error);
  if (error !== undefined) detail.error = error;
  if (Array.isArray(v.responseHeaders)) detail.responseHeaders = sanitizeHeaders(v.responseHeaders);
  if (v.mocked === true) detail.mocked = true;
  if (v.bodyEvicted === true) detail.bodyEvicted = true;
  if (isRecord(v.timings)) {
    const timings: NonNullable<NetworkDetail['timings']> = {};
    for (const key of ['dns', 'connect', 'tls', 'send', 'wait', 'receive'] as const) {
      const n = finite(v.timings[key]);
      if (n !== undefined) timings[key] = n;
    }
    detail.timings = timings;
  }
  if (isRecord(v.graphql)) {
    const op = v.graphql.operationType;
    detail.graphql = {};
    if (typeof v.graphql.operationName === 'string') detail.graphql.operationName = v.graphql.operationName;
    if (op === 'query' || op === 'mutation' || op === 'subscription') detail.graphql.operationType = op;
  }
  const requestBody = sanitizeBody(v.requestBody);
  if (requestBody) detail.requestBody = requestBody;
  const responseBody = sanitizeBody(v.responseBody);
  if (responseBody) detail.responseBody = responseBody;
  return detail;
}
