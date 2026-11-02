/**
 * Uncaught error capture without changing the app's behavior:
 *  - React Native: `ErrorUtils.setGlobalHandler`, chained to the previous handler (RedBox/LogBox/crash);
 *  - browsers: `error` + `unhandledrejection` listeners on the global object;
 *  - Node: `uncaughtExceptionMonitor` (observes, never swallows — covers unhandled rejections in the
 *    default `throw` mode too).
 */
import type { Runtime } from './env.js';
import type { Patch } from './patch.js';
import type { AnyRecord } from './util.js';

export type ErrorOrigin = 'uncaught' | 'unhandled-rejection';

export interface ErrorReport {
  fatal: boolean;
  origin: ErrorOrigin;
  /** "file:line:col" for browser `error` events. */
  location?: string;
}

export interface ErrorHost {
  reportError(error: unknown, report: ErrorReport): void;
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    // Reporting must never interfere with the app's own error handling.
  }
}

export function installErrorHandlers(host: ErrorHost, runtime: Runtime, target: AnyRecord): Patch[] {
  const patches: Patch[] = [];

  const errorUtils = target.ErrorUtils as AnyRecord | undefined;
  if (errorUtils && typeof errorUtils.setGlobalHandler === 'function' && typeof errorUtils.getGlobalHandler === 'function') {
    let previous: unknown;
    try {
      previous = errorUtils.getGlobalHandler();
    } catch {
      previous = undefined;
    }
    let active = true;
    const handler = function durbunGlobalHandler(error: unknown, isFatal?: boolean) {
      if (active) guard(() => host.reportError(error, { fatal: !!isFatal, origin: 'uncaught' }));
      if (typeof previous === 'function') return previous(error, isFatal);
      return undefined;
    };
    try {
      errorUtils.setGlobalHandler(handler);
      patches.push({
        restore() {
          active = false;
          guard(() => {
            if (errorUtils.getGlobalHandler() === handler) errorUtils.setGlobalHandler(previous);
          });
        },
      });
    } catch {
      // ErrorUtils present but unusable
    }
  }

  if (runtime === 'web' && typeof target.addEventListener === 'function' && typeof target.removeEventListener === 'function') {
    const onError = (ev: AnyRecord) =>
      guard(() => {
        if (!ev) return;
        // Resource load errors (img/script) do not bubble to window; script errors carry `error`/`message`.
        const err = ev.error !== undefined && ev.error !== null ? ev.error : ev.message;
        if (err === undefined || err === null) return;
        const location = typeof ev.filename === 'string' && ev.filename ? `${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : undefined;
        host.reportError(err, { fatal: false, origin: 'uncaught', location });
      });
    const onRejection = (ev: AnyRecord) =>
      guard(() => host.reportError(ev ? ev.reason : undefined, { fatal: false, origin: 'unhandled-rejection' }));
    try {
      target.addEventListener('error', onError);
      target.addEventListener('unhandledrejection', onRejection);
      patches.push({
        restore() {
          guard(() => target.removeEventListener('error', onError));
          guard(() => target.removeEventListener('unhandledrejection', onRejection));
        },
      });
    } catch {
      // ignore
    }
  }

  const proc = target.process as AnyRecord | undefined;
  if (runtime === 'node' && proc && typeof proc.on === 'function' && typeof proc.removeListener === 'function') {
    const onMonitor = (error: unknown, origin: unknown) =>
      guard(() => {
        const count = typeof proc.listenerCount === 'function' ? proc.listenerCount('uncaughtException') : 0;
        host.reportError(error, {
          fatal: count === 0,
          origin: origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught',
        });
      });
    try {
      proc.on('uncaughtExceptionMonitor', onMonitor);
      patches.push({ restore: () => guard(() => proc.removeListener('uncaughtExceptionMonitor', onMonitor)) });
    } catch {
      // ignore
    }
  }

  return patches;
}
