/**
 * `@durbun/react-native/noop`: the same API with empty bodies and no SDK code behind it. Point release
 * builds here (a Metro resolver alias, a bundler alias or a `package.json` "react-native" field switch)
 * when the store bundle must not contain Dürbün at all. Every call does nothing; `begin` returns a call
 * whose reports go nowhere.
 */
import type { ActionHandle } from './actions.js';
import type { DurbunApi, DurbunNetworkApi } from './durbun.js';
import type { DurbunNetworkCall } from './manual.js';

const noopCall: DurbunNetworkCall = Object.freeze({ id: '', response() {}, error() {} });
const noopHandle: ActionHandle = Object.freeze({ update() {}, remove() {} });
const nothing = (): void => undefined;

const network: DurbunNetworkApi = {
  begin: () => noopCall,
  findMock: () => undefined,
};

export const Durbun: DurbunApi = {
  start: nothing,
  stop: nothing,
  isStarted: false,
  isConnected: false,
  log: nothing,
  verbose: nothing,
  debug: nothing,
  info: nothing,
  warn: nothing,
  error: nothing,
  event: nothing,
  addAction: () => noopHandle,
  network,
  trackNavigation: () => nothing,
};

export type { DurbunApi, DurbunLogOptions, DurbunNetworkApi } from './durbun.js';
export type { DurbunHeaders, DurbunNetworkCall, DurbunRequestReport, DurbunResponseReport } from './manual.js';
export type { NavigationContainerRefLike } from './navigation.js';
export type { DurbunOptions } from './options.js';
export type { LogOptions } from './client.js';
export type { ActionHandle, ActionHandler, DurbunAction } from './actions.js';
export type { DeviceHints, LogLevel, MockAction, MockRule } from './protocol.js';
export { SDK_NAME, SDK_VERSION } from './version.js';
