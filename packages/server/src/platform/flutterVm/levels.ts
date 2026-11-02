import type { LogLevel } from '@durbun/protocol';

/**
 * Map a `dart:developer` / `package:logging` level value to a Dürbün level.
 *
 * package:logging: ALL 0 · FINEST 300 · FINER 400 · FINE 500 · CONFIG 700 · INFO 800 · WARNING 900 ·
 * SEVERE 1000 · SHOUT 1200 · OFF 2000. `developer.log()` defaults to 0 ("no level"), which reads as info
 * — unless an error is attached (see `hasError`): an error must never look like info.
 */
export function mapDartLogLevel(level: unknown, hasError = false): LogLevel {
  const n = typeof level === 'number' && Number.isFinite(level) ? level : 0;
  if (n <= 0) return hasError ? 'error' : 'info';
  if (n < 500) return 'verbose';
  if (n < 800) return 'debug';
  if (n < 900) return 'info';
  if (n < 1000) return 'warn';
  if (n < 1200) return 'error';
  return 'fatal';
}
