/**
 * `console.*` capture. The original methods are always called (with the same `this` and arguments), so
 * Metro / DevTools / LogBox output is unchanged; a re-entrancy guard keeps the SDK's own work (or a
 * getter that logs while being serialized) from looping.
 */
import type { LogLevel } from './protocol.js';
import { patchMethod, type Patch } from './patch.js';
import { g } from './util.js';

export type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error' | 'trace' | 'assert' | 'dir' | 'table';

export const CONSOLE_LEVELS: ReadonlyArray<[ConsoleMethod, LogLevel]> = [
  ['debug', 'debug'],
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
  ['trace', 'debug'],
  ['assert', 'error'],
  ['dir', 'info'],
  ['table', 'info'],
];

export interface ConsoleHost {
  onConsole(method: ConsoleMethod, level: LogLevel, args: unknown[]): void;
}

let busy = false;

/**
 * Runs SDK work with console capture suspended: anything the platform logs while we serialize or send
 * (e.g. a WebSocket warning) goes to the original console only, never back into the SDK.
 */
export function quietly<T>(fn: () => T): T {
  if (busy) return fn();
  busy = true;
  try {
    return fn();
  } finally {
    busy = false;
  }
}

export function installConsolePatch(host: ConsoleHost): Patch[] {
  const target = g.console;
  if (!target || typeof target !== 'object') return [];
  const patches: Patch[] = [];
  for (const [method, level] of CONSOLE_LEVELS) {
    const patch = patchMethod<(...args: unknown[]) => unknown>(target, method, (original, isActive) =>
      function durbunConsole(this: unknown, ...args: unknown[]) {
        if (isActive() && !busy) {
          busy = true;
          try {
            host.onConsole(method, level, args);
          } catch {
            // Never let capture break logging.
          } finally {
            busy = false;
          }
        }
        return original.apply(this, args);
      },
    );
    if (patch) patches.push(patch);
  }
  return patches;
}
