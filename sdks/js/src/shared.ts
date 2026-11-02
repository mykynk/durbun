/**
 * Process-wide SDK state kept on the global object, so the ESM and CommonJS builds (or two copies of the
 * package) loaded into the same app share one running client and one action registry instead of
 * silently splitting logs between them.
 */
import { g } from './util.js';

const KEY = '__durbunSdkState__';

export interface SharedState {
  client?: unknown;
  actions?: unknown;
}

export function sharedState(): SharedState {
  let state = g[KEY] as SharedState | undefined;
  if (!state || typeof state !== 'object') {
    state = {};
    try {
      Object.defineProperty(g, KEY, { value: state, configurable: true, enumerable: false, writable: true });
    } catch {
      g[KEY] = state;
    }
  }
  return state;
}
