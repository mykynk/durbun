import type { WebSocketConstructor } from './connection.js';
import { discoverHosts, type Runtime } from './env.js';
import { DEFAULT_HTTP_PORT, type DeviceHints } from './protocol.js';

export interface DurbunOptions {
  /**
   * Desktop host running Dürbün. Default `'localhost'` — works on Android over USB (Dürbün sets up
   * `adb reverse tcp:9750` automatically), Android emulators and iOS simulators. For an iOS device use
   * the Mac's LAN IP (and start Dürbün with `--lan`). When omitted, the Metro dev-server host is tried too.
   */
  host?: string;
  /** Desktop HTTP port (default 9750). */
  port?: number;
  /** WebSocket path (default '/sdk'). */
  path?: string;
  /** Full WebSocket URL; overrides host/port/path (e.g. 'ws://192.168.1.20:9750/sdk'). */
  url?: string;
  /** Default: `__DEV__` in React Native; elsewhere true unless `process.env.NODE_ENV === 'production'`. */
  enabled?: boolean;
  /**
   * Capture `console.*`. `'auto'` (default) skips console lines the desktop already receives through the
   * device's own log stream (Android logcat, iOS simulator log) to avoid duplicate rows; `true` always
   * captures; `false` never.
   */
  captureConsole?: boolean | 'auto';
  /** Capture XMLHttpRequest / fetch traffic and apply mock rules (default true). */
  captureNetwork?: boolean;
  /**
   * Report uncaught errors and unhandled promise rejections (default true). In React Native, rejections are
   * picked up from the dev-mode warning React Native's own rejection tracker prints (it does not track them
   * in release builds); browsers use `unhandledrejection`, Node the uncaught-exception monitor.
   */
  captureErrors?: boolean;
  /** Send JS heap / FPS samples (default true). */
  captureMetrics?: boolean;
  /** Outgoing messages kept while the desktop is not connected (default 5000, oldest dropped first). */
  maxBufferedMessages?: number;
  /** Bundle id / package name override (used for mock rule scoping and log association). */
  appId?: string;
  /** Display name override. */
  appName?: string;
  appVersion?: string;
  /** Device description overrides (e.g. `{ name: "Yusuf's iPhone" }`). */
  device?: Partial<DeviceHints>;
  /** Requests never captured or mocked (substring or RegExp). The desktop and the Metro dev server are always ignored. */
  ignoreUrls?: Array<string | RegExp>;
  /**
   * Header names (case-insensitive) whose values are shown as `••••` in captured requests and responses,
   * e.g. `['Authorization', 'Cookie']`. The real request is unchanged. Default none.
   */
  redactHeaders?: string[];
  /** WebSocket implementation for runtimes without a global one (e.g. Node < 22: `import WebSocket from 'ws'`). */
  WebSocket?: unknown;
  /** Print SDK diagnostics to the console (default false). */
  debug?: boolean;
}

export interface ResolvedOptions {
  urls: string[];
  captureConsole: boolean | 'auto';
  captureNetwork: boolean;
  captureErrors: boolean;
  captureMetrics: boolean;
  maxBufferedMessages: number;
  appId?: string;
  appName?: string;
  appVersion?: string;
  device?: Partial<DeviceHints>;
  ignoreUrls: Array<string | RegExp>;
  /** Lower-cased. */
  redactHeaders: string[];
  WebSocket?: WebSocketConstructor;
  debug: boolean;
}

function formatHost(host: string): string {
  return host.indexOf(':') >= 0 && !host.startsWith('[') ? `[${host}]` : host;
}

function validPort(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) && n > 0 && n < 65536 && Math.floor(n) === n ? n : undefined;
}

/** Candidate WebSocket URLs, most specific first (all are tried at once; the first to open wins). */
export function resolveUrls(options: DurbunOptions, runtime: Runtime): string[] {
  if (typeof options.url === 'string' && options.url.trim()) return [options.url.trim()];
  let host = typeof options.host === 'string' ? options.host.trim() : '';
  if (/^wss?:\/\//i.test(host)) return [host];
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  let port = validPort(options.port);
  // "192.168.1.20:9750" (but not a bare IPv6 address)
  const hostPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host);
  if (hostPort) {
    host = hostPort[1];
    if (port === undefined) port = validPort(hostPort[2]);
  }
  host = host.replace(/^\[|\]$/g, '');
  const finalPort = port ?? DEFAULT_HTTP_PORT;
  let path = typeof options.path === 'string' && options.path ? options.path : '/sdk';
  if (!path.startsWith('/')) path = '/' + path;

  const hosts: string[] = [];
  const explicit = host.length > 0;
  hosts.push(explicit ? host : 'localhost');
  // 'localhost' may resolve to ::1 first while Dürbün listens on 127.0.0.1.
  if (!explicit || host === 'localhost') hosts.push('127.0.0.1');
  if (!explicit) for (const h of discoverHosts(runtime)) hosts.push(h);
  const unique = hosts.filter((h, i) => hosts.indexOf(h) === i);
  return unique.map((h) => `ws://${formatHost(h)}:${finalPort}${path}`);
}

export function resolveOptions(options: DurbunOptions, runtime: Runtime): ResolvedOptions {
  const max = typeof options.maxBufferedMessages === 'number' && isFinite(options.maxBufferedMessages) ? Math.max(0, Math.floor(options.maxBufferedMessages)) : 5000;
  const ignore = Array.isArray(options.ignoreUrls)
    ? options.ignoreUrls.filter((p): p is string | RegExp => (typeof p === 'string' && p.length > 0) || p instanceof RegExp)
    : [];
  return {
    urls: resolveUrls(options, runtime),
    captureConsole: options.captureConsole === undefined ? 'auto' : options.captureConsole === 'auto' ? 'auto' : !!options.captureConsole,
    captureNetwork: options.captureNetwork !== false,
    captureErrors: options.captureErrors !== false,
    captureMetrics: options.captureMetrics !== false,
    maxBufferedMessages: max,
    appId: typeof options.appId === 'string' && options.appId ? options.appId : undefined,
    appName: typeof options.appName === 'string' && options.appName ? options.appName : undefined,
    appVersion: typeof options.appVersion === 'string' && options.appVersion ? options.appVersion : undefined,
    device: options.device && typeof options.device === 'object' ? options.device : undefined,
    ignoreUrls: ignore,
    redactHeaders: Array.isArray(options.redactHeaders)
      ? options.redactHeaders.filter((h): h is string => typeof h === 'string' && h.length > 0).map((h) => h.toLowerCase())
      : [],
    WebSocket: typeof options.WebSocket === 'function' ? (options.WebSocket as WebSocketConstructor) : undefined,
    debug: options.debug === true,
  };
}
