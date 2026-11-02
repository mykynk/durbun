/**
 * Validation + normalization of inbound SDK messages. Anything from the wire is untrusted: required
 * fields are checked, optional ones type-checked, and unusable messages yield `undefined` (ignored).
 */
import type {
  AppActionDescriptor,
  DevicePlatform,
  ErrorInfo,
  Header,
  LogLevel,
  SdkCapability,
  SdkCommandResult,
  SdkEvent,
  SdkHello,
  SdkLog,
  SdkMetric,
  SdkNetError,
  SdkNetRequest,
  SdkNetResponse,
  SdkPlatform,
  SdkToServer,
  Timings,
  WireBody,
} from '@durbun/protocol';
import { LOG_LEVELS, PROTOCOL_VERSION } from '@durbun/protocol';
import { randomUUID } from 'node:crypto';
import { normSdkLayers } from '../hub/sanitize';

const LEVELS = new Set<string>(LOG_LEVELS);
const SDK_PLATFORMS = new Set<string>(['flutter', 'android', 'ios', 'react-native', 'js', 'dart-vm', 'demo']);
const DEVICE_PLATFORMS = new Set<string>(['android', 'ios', 'other']);
const CAPABILITIES = new Set<string>(['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands']);
const LOG_KINDS = new Set<string>(['text', 'crash', 'flutter-error']);
const ACTION_KINDS = new Set<string>(['toggle', 'select', 'button']);
const TIMING_KEYS = ['dns', 'connect', 'tls', 'send', 'wait', 'receive'] as const;
const METRIC_KEYS = ['cpu', 'memoryMB', 'heapMB', 'fps', 'jankyFrames', 'frameBuildMs', 'frameRasterMs', 'threads'] as const;

/** Upper bounds for identifiers/short strings coming from SDKs. */
const MAX_ID = 512;
const MAX_SHORT = 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const short = (v: unknown, max = MAX_SHORT): string | undefined =>
  typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : undefined;
const tsOf = (v: unknown): number => num(v) ?? Date.now();

function idOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 && v.length <= MAX_ID ? v : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function text(v: unknown): string {
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

export function parseHeaders(v: unknown): Header[] {
  const out: Header[] = [];
  if (Array.isArray(v)) {
    for (const h of v) {
      if (Array.isArray(h) && typeof h[0] === 'string') out.push([h[0], text(h[1])]);
      else if (isObj(h) && typeof h.name === 'string') out.push([h.name, text(h.value)]);
    }
  } else if (isObj(v)) {
    // Lenient: a plain { name: value | value[] } map.
    for (const [name, value] of Object.entries(v)) {
      if (Array.isArray(value)) for (const item of value) out.push([name, text(item)]);
      else out.push([name, text(value)]);
    }
  }
  return out;
}

export function parseBody(v: unknown): WireBody | undefined {
  if (!isObj(v) || typeof v.data !== 'string') return undefined;
  const encoding = v.encoding === 'base64' ? 'base64' : 'utf8';
  const data = v.data;
  const estimated =
    encoding === 'base64' ? Math.max(0, Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)) : Buffer.byteLength(data);
  const size = num(v.size);
  const body: WireBody = { encoding, data, size: size !== undefined && size >= 0 ? size : estimated };
  if (v.truncated === true) body.truncated = true;
  return body;
}

function parseError(v: unknown): ErrorInfo | undefined {
  if (typeof v === 'string') return { message: v };
  if (!isObj(v)) return undefined;
  const out: ErrorInfo = {};
  const type = short(v.type);
  if (type !== undefined) out.type = type;
  if (typeof v.message === 'string') out.message = v.message;
  if (typeof v.stack === 'string') out.stack = v.stack;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseTimings(v: unknown): Timings | undefined {
  if (!isObj(v)) return undefined;
  const out: Timings = {};
  for (const key of TIMING_KEYS) {
    const n = num(v[key]);
    if (n !== undefined && n >= 0) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseActions(v: unknown): AppActionDescriptor[] {
  if (!Array.isArray(v)) return [];
  const out: AppActionDescriptor[] = [];
  for (const a of v) {
    if (!isObj(a)) continue;
    const id = idOf(a.id);
    if (!id || typeof a.kind !== 'string' || !ACTION_KINDS.has(a.kind)) continue;
    const action: AppActionDescriptor = {
      id,
      kind: a.kind as AppActionDescriptor['kind'],
      label: short(a.label) ?? id,
    };
    const labelKey = short(a.labelKey);
    if (labelKey) action.labelKey = labelKey;
    const group = short(a.group);
    if (group) action.group = group;
    if (Array.isArray(a.options)) {
      action.options = a.options
        .filter((o): o is Obj => isObj(o) && typeof o.value === 'string')
        .map((o) => ({ value: o.value as string, label: short(o.label) ?? (o.value as string) }));
    }
    if (typeof a.value === 'boolean' || typeof a.value === 'string') action.value = a.value;
    out.push(action);
  }
  return out;
}

/** Normalized `hello`, or undefined when it lacks what the server needs (app id). */
export function parseHello(v: Obj): SdkHello | undefined {
  const appIn = isObj(v.app) ? v.app : undefined;
  const appId = appIn ? short(appIn.id, MAX_ID)?.trim() : undefined;
  if (!appIn || !appId) return undefined;
  const deviceIn = isObj(v.device) ? v.device : {};
  const platform: DevicePlatform =
    typeof deviceIn.platform === 'string' && DEVICE_PLATFORMS.has(deviceIn.platform)
      ? (deviceIn.platform as DevicePlatform)
      : 'other';
  const sdkIn = isObj(v.sdk) ? v.sdk : {};
  const sdkPlatform: SdkPlatform =
    typeof sdkIn.platform === 'string' && SDK_PLATFORMS.has(sdkIn.platform)
      ? (sdkIn.platform as SdkPlatform)
      : platform === 'android'
        ? 'android'
        : platform === 'ios'
          ? 'ios'
          : 'js';

  const hello: SdkHello = {
    type: 'hello',
    protocol: num(v.protocol) ?? PROTOCOL_VERSION,
    sdk: { name: short(sdkIn.name) || 'unknown', version: short(sdkIn.version) || '0.0.0', platform: sdkPlatform },
    app: { name: short(appIn.name)?.trim() || appId, id: appId },
    device: { platform },
    session: idOf(v.session) ?? randomUUID(),
    capabilities: Array.isArray(v.capabilities)
      ? ([...new Set(v.capabilities.filter((c): c is string => typeof c === 'string' && CAPABILITIES.has(c)))] as SdkCapability[])
      : [],
    actions: parseActions(v.actions),
    ts: tsOf(v.ts),
  };
  // Which layers of the app feed this session (Flutter plugin: 'dart' + 'android' / 'ios' when its native
  // core is attached); unknown values are dropped, nothing left = unknown.
  const layers = normSdkLayers(sdkIn.layers);
  if (layers) hello.sdk.layers = layers;
  for (const key of ['version', 'build', 'processName'] as const) {
    const s = short(appIn[key]);
    if (s) hello.app[key] = s;
  }
  const pid = num(appIn.pid);
  if (pid !== undefined && pid > 0) hello.app.pid = Math.floor(pid);
  if (typeof appIn.debug === 'boolean') hello.app.debug = appIn.debug;

  for (const key of ['model', 'manufacturer', 'name', 'osVersion'] as const) {
    const s = short(deviceIn[key])?.trim();
    if (s) hello.device[key] = s;
  }
  const apiLevel = num(deviceIn.apiLevel);
  if (apiLevel !== undefined) hello.device.apiLevel = apiLevel;
  if (typeof deviceIn.isPhysical === 'boolean') hello.device.isPhysical = deviceIn.isPhysical;
  const udid = short(deviceIn.simulatorUdid, 128)?.trim();
  if (udid && /^[A-Za-z0-9-]{8,128}$/.test(udid)) hello.device.simulatorUdid = udid.toUpperCase();
  return hello;
}

/** Validates any inbound message; undefined for garbage / unknown types / missing required fields. */
export function parseSdkMessage(value: unknown): SdkToServer | undefined {
  if (!isObj(value) || typeof value.type !== 'string') return undefined;
  const v = value;
  switch (v.type) {
    case 'hello':
      return parseHello(v);
    case 'log': {
      const level: LogLevel = typeof v.level === 'string' && LEVELS.has(v.level) ? (v.level as LogLevel) : 'info';
      const msg: SdkLog = { type: 'log', ts: tsOf(v.ts), level, message: text(v.message) };
      const tag = short(v.tag, 256);
      if (tag) msg.tag = tag;
      if (v.data !== undefined) msg.data = v.data;
      const error = parseError(v.error);
      if (error) msg.error = error;
      if (typeof v.kind === 'string' && LOG_KINDS.has(v.kind)) msg.kind = v.kind as 'text' | 'crash' | 'flutter-error';
      const tid = num(v.tid);
      if (tid !== undefined) msg.tid = tid;
      return msg;
    }
    case 'net.request': {
      const id = idOf(v.id);
      if (!id || typeof v.url !== 'string') return undefined;
      const method = typeof v.method === 'string' && v.method.trim() ? v.method.trim().toUpperCase().slice(0, 32) : 'GET';
      const msg: SdkNetRequest = {
        type: 'net.request',
        id,
        ts: tsOf(v.ts),
        method,
        url: v.url,
        headers: parseHeaders(v.headers),
        source: short(v.source, 64) || 'sdk',
      };
      const body = parseBody(v.body);
      if (body) msg.body = body;
      return msg;
    }
    case 'net.response': {
      const id = idOf(v.id);
      if (!id) return undefined;
      const status = num(v.status);
      const msg: SdkNetResponse = {
        type: 'net.response',
        id,
        ts: tsOf(v.ts),
        status: status !== undefined ? Math.floor(status) : 0,
        headers: parseHeaders(v.headers),
      };
      const statusText = short(v.statusText, 256);
      if (statusText) msg.statusText = statusText;
      const body = parseBody(v.body);
      if (body) msg.body = body;
      const protocol = short(v.protocol, 64);
      if (protocol) msg.protocol = protocol;
      const remoteAddress = short(v.remoteAddress, 256);
      if (remoteAddress) msg.remoteAddress = remoteAddress;
      const timings = parseTimings(v.timings);
      if (timings) msg.timings = timings;
      if (v.mocked === true) msg.mocked = true;
      const mockRuleId = idOf(v.mockRuleId);
      if (mockRuleId) msg.mockRuleId = mockRuleId;
      return msg;
    }
    case 'net.error': {
      const id = idOf(v.id);
      if (!id) return undefined;
      const msg: SdkNetError = {
        type: 'net.error',
        id,
        ts: tsOf(v.ts),
        error: typeof v.error === 'string' && v.error ? v.error : text(v.error) || 'Request failed',
      };
      if (v.cancelled === true) msg.cancelled = true;
      if (v.mocked === true) msg.mocked = true;
      const mockRuleId = idOf(v.mockRuleId);
      if (mockRuleId) msg.mockRuleId = mockRuleId;
      return msg;
    }
    case 'event': {
      const name = short(v.name, 256)?.trim();
      if (!name) return undefined;
      const msg: SdkEvent = { type: 'event', ts: tsOf(v.ts), name };
      if (isObj(v.props)) msg.props = v.props;
      return msg;
    }
    case 'metric': {
      const msg: SdkMetric = { type: 'metric', ts: tsOf(v.ts) };
      let any = false;
      for (const key of METRIC_KEYS) {
        const n = num(v[key]);
        if (n !== undefined) {
          msg[key] = n;
          any = true;
        }
      }
      return any ? msg : undefined;
    }
    case 'command.result': {
      const id = idOf(v.id);
      if (!id) return undefined;
      const msg: SdkCommandResult = { type: 'command.result', id, ok: v.ok === true };
      if (v.data !== undefined) msg.data = v.data;
      if (typeof v.error === 'string') msg.error = v.error;
      return msg;
    }
    case 'actions':
      return { type: 'actions', actions: parseActions(v.actions) };
    case 'pong':
      return { type: 'pong', ts: tsOf(v.ts) };
    default:
      return undefined;
  }
}
