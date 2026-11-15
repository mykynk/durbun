/**
 * Replicas of React Native's dev-mode rejection tracker (`Libraries/promiseRejectionTrackingOptions.js`
 * `onUnhandled`) and of the error pipeline it hands off to, transcribed from the published packages:
 *
 *  - 0.66–0.70 (read: 0.66.5, 0.68.7, 0.70.15): `console.warn("Possible Unhandled Promise Rejection (id: N):\n
 *    <message>\n<stack>")`;
 *  - 0.71–0.81 (read: 0.71.19, 0.72.17, 0.74.7, 0.76.9, 0.79.7, 0.81.6): `LogBox.addLog({ level: 'warn',
 *    message: { content: "Possible unhandled promise rejection (id: N):\n<message>", substitutions: [] },
 *    componentStack: [], componentStackType: null (0.76+), stack, category: 'possible_unhandled_promise_rejection' })`
 *    in `__DEV__` (`console.warn` in the release branch, which never runs: the tracker is enabled only in dev);
 *  - 0.82+ (read: 0.82.1, 0.83.10, 0.84.1, 0.85.3, 0.86.3, 0.87.1, 0.88.1, 0.89.0-rc.1):
 *    `ExceptionsManager.handleException(new Error('Uncaught (in promise, id: N): "<message>"', { cause }), false)`.
 *    `handleException` asks `global.RN$handleException` first; with the default feature flags that returns
 *    false once the bundle has loaded, and the JS pipeline runs `console.error(e)` then `LogBox.addException`.
 *    Otherwise (flag `useAlwaysAvailableJSErrorHandling`, or before the runtime is ready) the native
 *    `JsErrorHandler::handleErrorWithCppPipeline` calls `console.error("<name>: <message>")`, prefixed with
 *    "[runtime not ready]: " before the bundle has loaded.
 *
 * `<message>` is `Error.prototype.toString` for Errors, otherwise pretty-format's output; `prettyFormat` below
 * covers the values the tests use.
 */

export type Console = { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
export type LogBoxLike = { addLog: (log: unknown) => void; addException: (data: unknown) => void };

/** pretty-format's output for the values the fixtures reject with. */
export function prettyFormat(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const lines = Object.entries(value).map(([k, v]) => `  "${k}": ${prettyFormat(v)},`);
    if (lines.length === 0) return 'Object {}';
    return `Object {\n${lines.join('\n')}\n}`;
  }
  return String(value);
}

function isError(value: unknown): value is Error {
  return Object.prototype.toString.call(value) === '[object Error]';
}

/** 0.66–0.70 `onUnhandled`. */
export function trackerV070(console: Console) {
  return (id: number, rejection: unknown = {}) => {
    let message: string;
    let stack: string | undefined;
    if (isError(rejection)) {
      message = Error.prototype.toString.call(rejection);
      stack = rejection.stack;
    } else {
      message = prettyFormat(rejection);
    }
    const warning = `Possible Unhandled Promise Rejection (id: ${id}):\n` + `${message ?? ''}\n` + (stack == null ? '' : stack);
    console.warn(warning);
  };
}

/** 0.71–0.81 `onUnhandled` (`__DEV__` branch). */
export function trackerV071to081(logBox: LogBoxLike) {
  return (id: number, rejection: unknown = {}) => {
    let message: string;
    let stack: string | undefined;
    if (isError(rejection)) {
      message = Error.prototype.toString.call(rejection);
      stack = rejection.stack;
    } else {
      message = prettyFormat(rejection);
      const s = (rejection as { stack?: unknown } | null)?.stack;
      if (s && typeof s === 'string') stack = s;
    }
    const warning = `Possible unhandled promise rejection (id: ${id}):\n${message ?? ''}`;
    logBox.addLog({
      level: 'warn',
      message: { content: warning, substitutions: [] },
      componentStack: [],
      componentStackType: null,
      stack,
      category: 'possible_unhandled_promise_rejection',
    });
  };
}

export type Pipeline = 'js' | 'native' | 'native-not-ready';

/** 0.82+ `onUnhandled` plus `ExceptionsManager.handleException` (dev) down to `console.error`/LogBox. */
export function trackerV082plus(console: Console, logBox: LogBoxLike, pipeline: Pipeline = 'js') {
  const handleException = (e: Error, isFatal: boolean) => {
    if (pipeline === 'js') {
      // reportException(error, isFatal, reportToConsole = true)
      const namePrefix = e.name ? `${e.name}: ` : '';
      const message = e.message.startsWith(namePrefix) ? e.message : namePrefix + e.message;
      console.error(e);
      logBox.addException({ message, originalMessage: null, name: e.name, componentStack: null, stack: [], id: 1, isFatal, extraData: {}, isComponentError: false });
      return;
    }
    // JsErrorHandler::handleErrorWithCppPipeline with logToConsole = true
    let message = e.message;
    if (e.name && !message.startsWith(`${e.name}: `)) message = `${e.name}: ${message}`;
    console.error(pipeline === 'native' ? message : `[runtime not ready]: ${message}`);
  };
  return (id: number, rejection?: unknown) => {
    let message: string;
    if (rejection === undefined) message = '';
    else if (isError(rejection)) message = Error.prototype.toString.call(rejection);
    else message = prettyFormat(rejection);
    // `new Error(text, { cause })` as written in the source (ES2022 options argument).
    const error = new Error(`Uncaught (in promise, id: ${id})${message ? `: "${message}"` : ''}`, { cause: rejection });
    handleException(error, false);
  };
}

/** A Hermes-style Error (stack starts with the "Name: message" line). */
export function hermesError(ctor: ErrorConstructor, message: string, frame = 'load (http://localhost:8081/index.bundle?platform=ios:10:5)'): Error {
  const e = new ctor(message);
  e.stack = `${e.name}: ${message}\n    at ${frame}`;
  return e;
}

/** A JSC-style Error (stack holds frames only). */
export function jscError(ctor: ErrorConstructor, message: string): Error {
  const e = new ctor(message);
  e.stack = 'load@http://localhost:8081/index.bundle?platform=ios:10:5\nglobal code@http://localhost:8081/index.bundle?platform=ios:1:1';
  return e;
}
