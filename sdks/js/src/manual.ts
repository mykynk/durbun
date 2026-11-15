/**
 * Manual network reporting for clients the SDK does not patch (react-native-blob-util, Expo FileSystem
 * downloads, gRPC-web, native modules): `begin` reports the request, the returned call reports how it ended.
 * Same shape as the Flutter SDK's `DurbunNetwork.begin`.
 */
import { captureRequestBody, inferContentType, isArrayBufferLike, isArrayBufferViewLike, isBlobLike, isFormDataLike, sizeOnly } from './body.js';
import { findHeader, headersFromInit } from './headers.js';
import { errorInfo, isErrorLike, toJsonSafe } from './jsonSafe.js';
import { statusText } from './mocks.js';
import type { NetworkHost } from './network.js';
import type { Header, WireBody } from './protocol.js';
import { g, isPromiseLike, resolveUrl } from './util.js';

/** Headers as a record, an array of pairs or a `Headers` object. */
export type DurbunHeaders = Record<string, string | string[]> | Array<[string, string]> | { forEach(cb: (value: string, name: string) => void): void };

export interface DurbunRequestReport {
  url: string;
  /** Default 'GET'. */
  method?: string;
  headers?: DurbunHeaders;
  /** A string, bytes (ArrayBuffer / typed array), a Blob, FormData, or a plain object (shown as JSON). */
  body?: unknown;
  /** Shown as the request's source on the desktop (default 'manual'), e.g. 'blob-util', 'grpc'. */
  source?: string;
}

export interface DurbunResponseReport {
  status: number;
  statusText?: string;
  headers?: DurbunHeaders;
  /** Same types as the request body. Leave it out for downloads written to a file and pass `bodySize`. */
  body?: unknown;
  /** Size in bytes when the body itself is not passed (a file download). */
  bodySize?: number;
  /** The response came from a mock rule your code applied (see `Durbun.network.findMock`). */
  mockRuleId?: string;
}

export interface DurbunNetworkCall {
  readonly id: string;
  /** The request completed with an HTTP status (any status, 4xx/5xx included). Only the first report counts. */
  response(report: DurbunResponseReport): void;
  /** The request failed without a status (no connection, timeout) or was cancelled. Only the first report counts. */
  error(error: unknown, options?: { cancelled?: boolean; mockRuleId?: string }): void;
}

/** Plain objects and arrays become JSON; everything else is captured as the patches capture it. */
function prepareBody(body: unknown): { value: unknown; contentType?: string } {
  if (body === undefined || body === null || typeof body !== 'object') return { value: body };
  if (isBlobLike(body) || isFormDataLike(body) || isArrayBufferLike(body) || isArrayBufferViewLike(body)) return { value: body };
  const USP = g.URLSearchParams;
  if (typeof USP === 'function' && body instanceof USP) return { value: body };
  try {
    return { value: JSON.stringify(toJsonSafe(body)), contentType: 'application/json' };
  } catch {
    return { value: undefined };
  }
}

function captureBody(host: NetworkHost, body: unknown, headers: Header[]): WireBody | PromiseLike<WireBody | undefined> | undefined {
  const prepared = prepareBody(body);
  const contentType = findHeader(headers, 'content-type') || prepared.contentType || inferContentType(prepared.value);
  return captureRequestBody(prepared.value, contentType, host.bodyConfig);
}

function describeError(error: unknown): string {
  if (isErrorLike(error)) {
    const info = errorInfo(error);
    return [info.type, info.message].filter(Boolean).join(': ') || 'Error';
  }
  return typeof error === 'string' ? error : String(error);
}

export function beginCall(host: NetworkHost, report: DurbunRequestReport): DurbunNetworkCall {
  const id = host.nextRequestId();
  const startTs = Date.now();
  const headers = headersFromInit(report.headers);
  let url = String(report.url);
  try {
    url = resolveUrl(url);
  } catch {
    // keep as given
  }
  const request = {
    type: 'net.request' as const,
    id,
    ts: startTs,
    method: String(report.method || 'GET').toUpperCase(),
    url,
    headers,
    source: report.source ? String(report.source) : 'manual',
  };
  // The request goes first; its body may be read asynchronously (Blob), so the result waits for it.
  let ready: Promise<void> | undefined;
  const body = captureBody(host, report.body, headers);
  if (isPromiseLike(body)) {
    ready = Promise.resolve(body)
      .then((b) => (b ? { ...request, body: b } : request), () => request)
      .then((msg) => host.emit(msg));
  } else host.emit(body ? { ...request, body } : request);
  const after = (fn: () => void) => {
    const safe = () => {
      try {
        fn();
      } catch (e) {
        host.debug('manual network report', e);
      }
    };
    if (ready) ready.then(safe, safe);
    else safe();
  };

  let finished = false;
  return {
    id,
    response(r: DurbunResponseReport): void {
      if (finished) return;
      finished = true;
      try {
        const endTs = Date.now();
        const status = Math.floor(Number(r && r.status)) || 0;
        const resHeaders = headersFromInit(r && r.headers);
        const text = (r && r.statusText) || statusText(status);
        const mock = r && r.mockRuleId ? { mocked: true, mockRuleId: String(r.mockRuleId) } : {};
        const size = r && typeof r.bodySize === 'number' && isFinite(r.bodySize) && r.bodySize >= 0 ? Math.floor(r.bodySize) : undefined;
        const emit = (b: WireBody | undefined) =>
          after(() =>
            host.emit({
              type: 'net.response',
              id,
              ts: endTs,
              status,
              ...(text ? { statusText: text } : {}),
              headers: resHeaders,
              ...(b ? { body: b } : {}),
              timings: { wait: endTs - startTs, receive: 0 },
              ...mock,
            }),
          );
        const captured = r && r.body !== undefined ? captureBody(host, r.body, resHeaders) : size !== undefined ? sizeOnly(size) : undefined;
        if (isPromiseLike(captured)) Promise.resolve(captured).then(emit, () => emit(undefined));
        else emit(captured);
      } catch (e) {
        host.debug('manual network response', e);
      }
    },
    error(error: unknown, options: { cancelled?: boolean; mockRuleId?: string } = {}): void {
      if (finished) return;
      finished = true;
      try {
        const endTs = Date.now();
        const message = describeError(error);
        after(() =>
          host.emit({
            type: 'net.error',
            id,
            ts: endTs,
            error: message,
            ...(options && options.cancelled ? { cancelled: true } : {}),
            ...(options && options.mockRuleId ? { mocked: true, mockRuleId: String(options.mockRuleId) } : {}),
          }),
        );
      } catch (e) {
        host.debug('manual network error', e);
      }
    },
  };
}

/** What `Durbun.network.begin` returns while the SDK is off: reports go nowhere. */
export const NOOP_CALL: DurbunNetworkCall = Object.freeze({ id: '', response() {}, error() {} });
