/**
 * Uncaught error capture without changing the app's behavior:
 *  - React Native: `ErrorUtils.setGlobalHandler`, chained to the previous handler (RedBox/LogBox/crash);
 *    unhandled promise rejections from React Native's own rejection tracker, which only runs in dev
 *    builds (`Libraries/promiseRejectionTrackingOptions.js`, JSC and Hermes alike). It reports them in
 *    one of three ways depending on the version, and each is observed without being changed:
 *      - 0.81 and older back to 0.71: `LogBox.addLog({ category: 'possible_unhandled_promise_rejection' })`
 *        with "Possible unhandled promise rejection (id: N):\n<value>" and the error's stack;
 *      - 0.70 and older: `console.warn("Possible Unhandled Promise Rejection (id: N):\n<value>\n<stack>")`;
 *      - 0.82 and newer: `ExceptionsManager.handleException(new Error('Uncaught (in promise, id: N): "<value>"',
 *        { cause }))`, which logs through `console.error` (the Error itself on the JS pipeline, the
 *        "Error: Uncaught (in promise, id: N): …" text on the native one) before LogBox shows it.
 *    The wrappers only look at the arguments and always call the original, so LogBox keeps working.
 *    Each rejection id is reported once, whichever path carried it;
 *  - browsers: `error` + `unhandledrejection` listeners on the global object;
 *  - Node: `uncaughtExceptionMonitor` (observes, never swallows — covers unhandled rejections in the
 *    default `throw` mode too).
 */
import { loadReactNative, type Runtime } from './env.js';
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

type ErrorShape = { name: string; message: string; stack?: string };

/** React Native ≤ 0.81 tracker text (`promiseRejectionTrackingOptions`; 0.70 and older capitalize it). */
const RN_REJECTION = /^Possible unhandled promise rejection \(id: (\d+)\):\r?\n?/i;

/**
 * React Native ≥ 0.82 tracker text: the Error's message, `Uncaught (in promise, id: N)` plus `: "<value>"`
 * unless the value was undefined. The native error pipeline logs it as "Error: <message>", prefixed with
 * "[runtime not ready]: " before the bundle has finished loading.
 */
const RN_UNCAUGHT = /^(?:\[runtime not ready\]: )?(?:Error: )?Uncaught \(in promise, id: (\d+)\)(?:: "([\s\S]*)")?\s*$/;

/** The LogBox category React Native 0.71–0.81 gives the tracker's log. */
const RN_REJECTION_CATEGORY = 'possible_unhandled_promise_rejection';

function stringProp(value: unknown, key: string): string | undefined {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const v = (value as AnyRecord)[key];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The ≥ 0.82 message carried by a console.error argument (the Error itself, or the native pipeline's text). */
function uncaughtText(arg: unknown): string | undefined {
  const text = typeof arg === 'string' ? arg : stringProp(arg, 'message');
  return text !== undefined && text.indexOf('Uncaught (in promise, id: ') >= 0 && RN_UNCAUGHT.test(text) ? text : undefined;
}

/**
 * True for a console line React Native writes for an unhandled rejection (reported as an error instead):
 * the ≤ 0.70 warning, or the ≥ 0.82 `console.error` of the "Uncaught (in promise, id: N)" Error or text.
 */
export function isRejectionWarning(args: unknown[], method: 'warn' | 'error' = 'warn'): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  if (typeof first === 'string' && RN_REJECTION.test(first)) return true;
  return method === 'error' && uncaughtText(first) !== undefined;
}

/** "TypeError: boom" → `{ name: 'TypeError', message: 'boom' }`; any other value text is an Error message. */
function shapeFromValueText(text: string, stack: string | undefined): ErrorShape {
  const typed = /^([A-Za-z_$][\w$]*): ([\s\S]*)$/.exec(text);
  if (typed && /(Error|Exception)$/.test(typed[1])) return { name: typed[1], message: typed[2], ...(stack ? { stack } : {}) };
  return { name: 'Error', message: text, ...(stack ? { stack } : {}) };
}

/**
 * The rejection as an error-like value, rebuilt from React Native's warning text:
 * `Possible unhandled promise rejection (id: 0):\n<String(reason) or pretty value>\n<stack>`.
 */
export function rejectionFromWarning(text: string): ErrorShape | undefined {
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

/**
 * The rejection behind a React Native 0.71–0.81 LogBox log, or undefined for any other log. The content is
 * "Possible unhandled promise rejection (id: N):\n<value>" (no stack: LogBox gets it separately).
 */
export function rejectionFromLogBoxLog(log: unknown): { id: string; value: ErrorShape } | undefined {
  if (!log || typeof log !== 'object') return undefined;
  const entry = log as AnyRecord;
  if (entry.category !== RN_REJECTION_CATEGORY) return undefined;
  const content = stringProp(entry.message, 'content');
  if (content === undefined) return undefined;
  const head = RN_REJECTION.exec(content);
  if (!head) return undefined;
  const body = content.slice(head[0].length).replace(/\s+$/, '');
  const stack = typeof entry.stack === 'string' && entry.stack ? entry.stack : undefined;
  return { id: head[1], value: shapeFromValueText(body, stack) };
}

/**
 * The rejection behind a React Native ≥ 0.82 `console.error` argument, or undefined for any other value.
 * The JS pipeline passes the Error, whose `cause` is the original rejection value (stack included); the
 * native pipeline passes only its text.
 */
export function rejectionFromUncaught(arg: unknown): { id: string; value: unknown } | undefined {
  const text = uncaughtText(arg);
  if (text === undefined) return undefined;
  const match = RN_UNCAUGHT.exec(text);
  if (!match) return undefined;
  if (typeof arg === 'object' && arg !== null) {
    try {
      // Engines without Error `cause` support leave the property out: fall back to the text then.
      if (Object.prototype.hasOwnProperty.call(arg, 'cause')) return { id: match[1], value: (arg as AnyRecord).cause };
    } catch {
      // fall back to the text
    }
  }
  // No value text: the promise was rejected with undefined.
  if (match[2] === undefined) return { id: match[1], value: undefined };
  return { id: match[1], value: shapeFromValueText(match[2], undefined) };
}

/** Rejection ids already reported (one per id, whichever path carried it); bounded. */
class SeenIds {
  private readonly ids: string[] = [];

  /** True the first time an id is offered. */
  add(id: string): boolean {
    if (this.ids.indexOf(id) >= 0) return false;
    this.ids.push(id);
    if (this.ids.length > 200) this.ids.shift();
    return true;
  }
}

/** The ≤ 0.70 console.warn text, as `{ id, value }`. */
function rejectionFromConsoleText(text: string): { id: string; value: ErrorShape } | undefined {
  const head = RN_REJECTION.exec(text);
  const value = head ? rejectionFromWarning(text) : undefined;
  return head && value ? { id: head[1], value } : undefined;
}

export function installErrorHandlers(
  host: ErrorHost,
  runtime: Runtime,
  target: AnyRecord,
  reactNative: AnyRecord | undefined = runtime === 'react-native' ? loadReactNative() : undefined,
): Patch[] {
  const patches: Patch[] = [];

  if (runtime === 'react-native') {
    const seen = new SeenIds();
    const report = (found: { id: string; value: unknown } | undefined) => {
      if (found && seen.add(found.id)) host.reportError(found.value, { fatal: false, origin: 'unhandled-rejection' });
    };

    if (target.console && typeof target.console === 'object') {
      for (const method of ['warn', 'error'] as const) {
        const patch = patchMethod<(...args: unknown[]) => unknown>(target.console as AnyRecord, method, (original, isActive) =>
          function durbunRejectionWatch(this: unknown, ...args: unknown[]) {
            if (isActive() && args.length > 0) {
              guard(() => {
                const first = args[0];
                if (typeof first === 'string' && RN_REJECTION.test(first)) report(rejectionFromConsoleText(first));
                else if (method === 'error') report(rejectionFromUncaught(first));
              });
            }
            return original.apply(this, args);
          },
        );
        if (patch) patches.push(patch);
      }
    }

    // React Native 0.71–0.81 hand the rejection straight to LogBox in dev builds.
    let logBox: unknown;
    try {
      logBox = reactNative ? reactNative.LogBox : undefined;
    } catch {
      logBox = undefined;
    }
    if (logBox && typeof logBox === 'object') {
      const patch = patchMethod<(...args: unknown[]) => unknown>(logBox as AnyRecord, 'addLog', (original, isActive) =>
        function durbunLogBoxWatch(this: unknown, ...args: unknown[]) {
          if (isActive()) guard(() => report(rejectionFromLogBoxLog(args[0])));
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
