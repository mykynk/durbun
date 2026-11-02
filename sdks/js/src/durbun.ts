/**
 * Public facade. Safe to call from anywhere: before `start()` (or when disabled) every call is a cheap
 * no-op, and nothing here ever throws into the app.
 */
import { appActions, type ActionHandle, type ActionHandler, type DurbunAction } from './actions.js';
import { DurbunClient, type LogOptions } from './client.js';
import { defaultEnabled } from './env.js';
import { isErrorLike } from './jsonSafe.js';
import type { DurbunOptions } from './options.js';
import type { LogLevel } from './protocol.js';
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
};
