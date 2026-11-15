/**
 * Public facade. Safe to call from anywhere: before `start()` (or when disabled) every call is a cheap
 * no-op, and nothing here ever throws into the app.
 */
import { appActions, type ActionHandle, type ActionHandler, type DurbunAction } from './actions.js';
import { DurbunClient, type LogOptions } from './client.js';
import { defaultEnabled } from './env.js';
import { isErrorLike } from './jsonSafe.js';
import { beginCall, NOOP_CALL, type DurbunNetworkCall, type DurbunRequestReport } from './manual.js';
import { trackNavigation, type NavigationContainerRefLike } from './navigation.js';
import type { DurbunOptions } from './options.js';
import type { LogLevel, MockRule } from './protocol.js';
import { sharedState } from './shared.js';

export interface DurbunLogOptions extends LogOptions {
  /** Level for `Durbun.log` (default 'info'). */
  level?: LogLevel;
}

export interface DurbunApi {
  /**
   * Starts capturing and connects to the Dürbün desktop app. Call once, as early as possible (index.js).
   * Does nothing when disabled (default: release builds) or already started.
   */
  start(options?: DurbunOptions): void;
  /** Stops capturing, restores every patched API and closes the connection. */
  stop(): void;
  /** True between `start()` (when enabled) and `stop()`. */
  readonly isStarted: boolean;
  /** True while the desktop connection is established. */
  readonly isConnected: boolean;

  /** `Durbun.log('Logged in', { tag: 'auth', data: { userId: 42 } })` — level via `options.level` (default info). */
  log(message: string, options?: DurbunLogOptions): void;
  verbose(message: string, options?: LogOptions): void;
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  /** Shortcut: `Durbun.warn('Slow response', err)`. */
  warn(message: string, error: unknown): void;
  /** `Durbun.error('Payment failed', { error: err, tag: 'payment', data: { orderId } })`. */
  error(message: string, options?: LogOptions): void;
  /** Shortcut: `catch (e) { Durbun.error('Payment failed', e) }`. */
  error(message: string, error: unknown): void;

  /** Custom event: `Durbun.event('purchase', { amount: 49.9 })`. */
  event(name: string, props?: Record<string, unknown>): void;

  /**
   * Adds a button / toggle / select to this app's card on the desktop. The handler runs when it is used;
   * for toggles/selects `params.value` holds the new value. Can be called before `start()`.
   */
  addAction(action: DurbunAction, handler: ActionHandler): ActionHandle;

  /** Reporting requests of clients the SDK does not capture by itself (see `DurbunNetworkApi`). */
  readonly network: DurbunNetworkApi;

  /**
   * Sends a `navigation` event ({ from, to }) each time the current screen changes, so logs and requests
   * show which screen they came from. Pass a React Navigation container ref (Expo Router:
   * `useNavigationContainerRef()`). Returns a function that stops tracking. Route params are not sent.
   */
  trackNavigation(navigationRef: NavigationContainerRefLike): () => void;
}

export interface DurbunNetworkApi {
  /**
   * Reports a request made by a client the SDK does not capture (react-native-blob-util, Expo FileSystem,
   * gRPC-web, a native module). Report how it ended with `call.response(...)` or `call.error(...)`. While
   * the SDK is off the call does nothing.
   */
  begin(request: DurbunRequestReport): DurbunNetworkCall;
  /**
   * The desktop's mock rule for this request, if one applies, so your own client can answer with it
   * (`rule.action`). Report the answer with `call.response({ ..., mockRuleId: rule.id })`.
   */
  findMock(method: string, url: string): MockRule | undefined;
}

const shared = sharedState();

/** The running client (shared through the global object, see shared.ts). */
function current(): DurbunClient | undefined {
  const c = shared.client as DurbunClient | undefined;
  return c && typeof c.log === 'function' ? c : undefined;
}

/** Options object, or (shortcut) an Error / any thrown value → `{ error }`. */
function normalize(options: unknown): DurbunLogOptions {
  if (options === undefined || options === null) return {};
  if (isErrorLike(options)) return { error: options };
  if (typeof options === 'object' && !Array.isArray(options)) return options as DurbunLogOptions;
  return { error: options };
}

function write(level: LogLevel | undefined, message: unknown, options: unknown): void {
  const c = current();
  if (!c) return;
  try {
    const o = normalize(options);
    c.log(level || o.level || 'info', message, o);
  } catch {
    // never throw into the app
  }
}

const network: DurbunNetworkApi = {
  begin(request: DurbunRequestReport): DurbunNetworkCall {
    const c = current();
    if (!c || !request) return NOOP_CALL;
    try {
      return beginCall(c, request);
    } catch {
      return NOOP_CALL;
    }
  },

  findMock(method: string, url: string): MockRule | undefined {
    const c = current();
    if (!c) return undefined;
    try {
      return c.findMock(String(method || 'GET').toUpperCase(), String(url));
    } catch {
      return undefined;
    }
  },
};

export const Durbun: DurbunApi = {
  start(options: DurbunOptions = {}): void {
    try {
      if (current()) return;
      const enabled = options.enabled === undefined ? defaultEnabled() : !!options.enabled;
      if (!enabled) return;
      const c = new DurbunClient(options);
      if (c.start()) shared.client = c;
    } catch {
      shared.client = undefined;
    }
  },

  stop(): void {
    const c = current();
    shared.client = undefined;
    try {
      c?.stop();
    } catch {
      // ignore
    }
  },

  get isStarted(): boolean {
    return !!current();
  },

  get isConnected(): boolean {
    const c = current();
    return !!c && c.isConnected;
  },

  log(message: string, options?: DurbunLogOptions): void {
    write(undefined, message, options);
  },

  verbose(message: string, options?: LogOptions): void {
    write('verbose', message, options);
  },

  debug(message: string, options?: LogOptions): void {
    write('debug', message, options);
  },

  info(message: string, options?: LogOptions): void {
    write('info', message, options);
  },

  warn(message: string, options?: unknown): void {
    write('warn', message, options);
  },

  error(message: string, options?: unknown): void {
    write('error', message, options);
  },

  event(name: string, props?: Record<string, unknown>): void {
    const c = current();
    if (!c) return;
    try {
      c.event(name, props);
    } catch {
      // ignore
    }
  },

  addAction(action: DurbunAction, handler: ActionHandler): ActionHandle {
    try {
      return appActions.add(action, handler);
    } catch {
      return { update() {}, remove() {} };
    }
  },

  network,

  trackNavigation(navigationRef: NavigationContainerRefLike): () => void {
    try {
      return trackNavigation(navigationRef, (name, props) => Durbun.event(name, props));
    } catch {
      return () => undefined;
    }
  },
};
