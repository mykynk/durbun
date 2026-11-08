/**
 * Uncaught error capture without changing the app's behavior:
 *  - React Native: `ErrorUtils.setGlobalHandler`, chained to the previous handler (RedBox/LogBox/crash);
 *    unhandled promise rejections through the warning React Native's own rejection tracker prints in dev
 *    ("Possible unhandled promise rejection (id: N): …", JSC and Hermes) — the tracker is left untouched,
 *    so LogBox keeps showing it;
 *  - browsers: `error` + `unhandledrejection` listeners on the global object;
 *  - Node: `uncaughtExceptionMonitor` (observes, never swallows — covers unhandled rejections in the
 *    default `throw` mode too).
 */
import type { Runtime } from './env.js';
import { patchMethod, type Patch } from './patch.js';
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

/** React Native's rejection tracker warning (`promiseRejectionTrackingOptions`; older versions capitalize it). */
const RN_REJECTION = /^Possible unhandled promise rejection \(id: (\d+)\):\r?\n?/i;

/** True for the console line React Native prints for an unhandled rejection (reported as an error instead). */
export function isRejectionWarning(args: unknown[]): boolean {
  return typeof args[0] === 'string' && RN_REJECTION.test(args[0]);
}

/**
 * The rejection as an error-like value, rebuilt from React Native's warning text:
 * `Possible unhandled promise rejection (id: 0):\n<String(reason) or pretty value>\n<stack>`.
 */
export function rejectionFromWarning(text: string): { name: string; message: string; stack?: string } | undefined {
  const head = RN_REJECTION.exec(text);
  if (!head) return undefined;
  const body = text.slice(head[0].length).replace(/\s+$/, '');
  const newline = body.indexOf('\n');
  const first = newline < 0 ? body : body.slice(0, newline);
  const rest = newline < 0 ? '' : body.slice(newline + 1);
  const typed = /^([A-Za-z_$][\w$]*): ([\s\S]*)$/.exec(first);
  if (typed && /(Error|Exception)$/.test(typed[1])) {
    // An Error: `rest` is its stack (Hermes and JSC stacks start with the "Name: message" line or a frame).
    const stack = rest ? (rest.indexOf(first) === 0 ? rest : `${first}\n${rest}`) : undefined;
    return { name: typed[1], message: typed[2], ...(stack ? { stack } : {}) };
  }
  // Not an Error (a string, an object…): no stack, the whole value is the message.
  return { name: 'Error', message: body };
}

export function installErrorHandlers(host: ErrorHost, runtime: Runtime, target: AnyRecord): Patch[] {
  const patches: Patch[] = [];

  if (runtime === 'react-native' && target.console && typeof target.console === 'object') {
    for (const method of ['warn', 'error'] as const) {
      const patch = patchMethod<(...args: unknown[]) => unknown>(target.console as AnyRecord, method, (original, isActive) =>
        function durbunRejectionWatch(this: unknown, ...args: unknown[]) {
          if (isActive() && isRejectionWarning(args)) {
            guard(() => {
              const rejection = rejectionFromWarning(args[0] as string);
              if (rejection) host.reportError(rejection, { fatal: false, origin: 'unhandled-rejection' });
            });
          }
          return original.apply(this, args);
        },
      );
      if (patch) patches.push(patch);
    }
  }

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
