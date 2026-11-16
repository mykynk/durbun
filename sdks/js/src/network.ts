import type { BodyConfig } from './body.js';
import type { MockRule, SdkNetError, SdkNetRequest, SdkNetResponse, SdkNetSse, SdkNetWs } from './protocol.js';

/** What the XHR / fetch patches need from the client. */
export interface NetworkHost {
  readonly bodyConfig: BodyConfig;
  nextRequestId(): string;
  emit(message: SdkNetRequest | SdkNetResponse | SdkNetError | SdkNetWs | SdkNetSse): void;
  /**
   * While the desktop asks for WebSocket / SSE messages (`config.captureStreams`): the payload cap in bytes
   * (0 = sizes only). Undefined = send no stream messages (SPEC §6.1.1).
   */
  streamCapture(): number | undefined;
  /** A warning row on the desktop (tag "durbun"), e.g. a mock rule that could not be applied. */
  notice(message: string): void;
  /**
   * Before the first mock rules arrived: resolves once they did (or waiting no longer makes sense), so a
   * launch request can still be mocked. Undefined when the request should go right away.
   */
  mocksPending(): Promise<void> | undefined;
  /** First enabled matching mock rule for this request, if any. */
  findMock(method: string, url: string): MockRule | undefined;
  /** Requests that must never be captured or mocked (the desktop itself, the Metro dev server, user list). */
  isIgnored(url: string): boolean;
  debug(message: string, error?: unknown): void;
}

/**
 * > 0 while a patched `fetch` is calling the original implementation. A fetch polyfill built on XHR
 * (whatwg-fetch, unfetch, …) creates its XMLHttpRequest synchronously inside that call; the XHR patch
 * then leaves it alone, so every request is reported exactly once.
 */
export const fetchGuard = { depth: 0 };
