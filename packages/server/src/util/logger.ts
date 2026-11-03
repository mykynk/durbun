import type { Logger } from '../types';
import { redactLogArg, redactSecrets } from './redact';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = process.env.DURBUN_DEBUG ? 'debug' : 'info';

/** Switch internal diagnostics verbosity (e.g. from the --verbose CLI flag). */
export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Internal diagnostics logger (stderr). App/device logs never go through here. */
export function createLogger(scope = 'durbun'): Logger {
  const write = (level: Level, message: string, args: unknown[]) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const now = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
    const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    // eslint-disable-next-line no-console
    console.error(line, ...args);
  };
  return {
    debug: (m, ...a) => write('debug', m, a),
    info: (m, ...a) => write('info', m, a),
    warn: (m, ...a) => write('warn', m, a),
    error: (m, ...a) => write('error', m, a),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

/**
 * Wraps any logger (the CLI's, or an embedder's such as the Mac app's file log) so no line carries a secret:
 * Dart VM service auth tokens are masked in the message and in string / Error arguments, in child loggers too.
 */
export function redactingLogger(inner: Logger): Logger {
  const wrap = (fn: (message: string, ...args: unknown[]) => void) =>
    (message: string, ...args: unknown[]) => fn.call(inner, redactSecrets(message), ...args.map(redactLogArg));
  return {
    debug: wrap(inner.debug),
    info: wrap(inner.info),
    warn: wrap(inner.warn),
    error: wrap(inner.error),
    child: (scope) => redactingLogger(inner.child(scope)),
  };
}

/** Logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
