/**
 * Global `fetch` capture + mocks for runtimes where fetch is native (browsers, Node ≥ 18).
 * Skipped when fetch is the XHR-based polyfill (React Native, whatwg-fetch): those requests are already
 * captured by the XHR patch. Even if a non-flagged polyfill on XHR slips through, `fetchGuard` makes the
 * XHR patch ignore the XHR created inside our fetch call, so nothing is reported twice.
 *
 * Bodies are read from `response.clone()` (a tee), never from the app's own stream; reading stops at the
 * body limit so a large download is not pulled further than the app itself would.
 */
import { bodyFromBytes, captureRequestBody, inferContentType, utf8Encode, base64Decode, type BodyConfig } from './body.js';
import { findHeader, headersFromInit } from './headers.js';
import { describeMockFailure, mockDelayMs, statusText, type FailAction, type RespondAction } from './mocks.js';
import { fetchGuard, type NetworkHost } from './network.js';
import { patchMethod, type Patch } from './patch.js';
import type { Header, MockRule, SdkNetRequest, WireBody } from './protocol.js';
import { errorMessage, g, hostOfUrl, isPromiseLike, resolveUrl, setTimer, clearTimer, type AnyRecord } from './util.js';
import type { Runtime } from './env.js';

interface RequestInfo {
  method: string;
  url: string;
  headers: Header[];
  /** init.body, or the Request object to clone for its body. */
  body: unknown;
  bodyFromRequest?: AnyRecord;
  signal?: AnyRecord;
}

/** True for fetch implementations built on XMLHttpRequest (whatwg-fetch sets `fetch.polyfill = true`). */
export function isXhrBasedFetch(fetchFn: unknown, runtime: Runtime): boolean {
  if (typeof fetchFn !== 'function') return false;
  if ((fetchFn as AnyRecord).polyfill === true) return true;
  return runtime === 'react-native' && typeof g.XMLHttpRequest === 'function' && !/\[native code\]/.test(String(fetchFn));
}

function isRequestLike(v: unknown): v is AnyRecord {
  return !!v && typeof v === 'object' && typeof (v as AnyRecord).url === 'string' && typeof (v as AnyRecord).method === 'string' && typeof (v as AnyRecord).clone === 'function';
}

function describeRequest(input: unknown, init: AnyRecord | undefined): RequestInfo {
  const req = isRequestLike(input) ? input : undefined;
  const rawUrl = req ? String(req.url) : String(input);
  const method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
  const headers = init && init.headers !== undefined ? headersFromInit(init.headers) : req ? headersFromInit(req.headers) : [];
  const info: RequestInfo = { method, url: resolveUrl(rawUrl), headers, body: init ? init.body : undefined };
  if (info.body === undefined && req && req.body) info.bodyFromRequest = req;
  const signal = (init && init.signal) || (req && req.signal);
  if (signal && typeof signal === 'object') info.signal = signal;
  return info;
}

function abortReason(signal: AnyRecord): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const DE = g.DOMException;
  if (typeof DE === 'function') {
    try {
      return new DE('This operation was aborted', 'AbortError');
    } catch {
      // fall through
    }
  }
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal: AnyRecord | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    let timer: unknown;
    const onAbort = () => {
      clearTimer(timer);
      reject(abortReason(signal as AnyRecord));
    };
    timer = setTimer(() => {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);
  });
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as AnyRecord).name === 'AbortError';
}

function describeFetchError(err: unknown): string {
  if (isAbortError(err)) return 'Request cancelled';
  const base = err && typeof err === 'object' && (err as AnyRecord).name === 'TimeoutError' ? `Timeout: ${errorMessage(err)}` : errorMessage(err);
  const cause = err && typeof err === 'object' ? (err as AnyRecord).cause : undefined;
  if (cause && typeof cause === 'object') {
    const causeMessage = errorMessage(cause);
    const code = typeof (cause as AnyRecord).code === 'string' ? (cause as AnyRecord).code : '';
    if (causeMessage && causeMessage !== base) return `${base}: ${causeMessage}${code && causeMessage.indexOf(code) < 0 ? ` (${code})` : ''}`;
  }
  return base;
}

function withCause<T extends Error>(err: T, cause: unknown): T {
  try {
    Object.defineProperty(err, 'cause', { value: cause, configurable: true, writable: true, enumerable: false });
  } catch {
    // ignore
  }
  return err;
}

/** The error this runtime's fetch would raise for such a failure. */
export function naturalFetchError(action: FailAction, url: string, runtime: Runtime): Error {
  const message = describeMockFailure(action, url);
  if (runtime === 'node') {
    const host = hostOfUrl(url) || 'localhost';
    const port = /^https:/i.test(url) ? 443 : 80;
    let cause: Error;
    switch (action.error) {
      case 'timeout':
        cause = Object.assign(new Error(action.message || `Connect Timeout Error (attempted address: ${host}:${port}, timeout: 10000ms)`), {
          name: 'ConnectTimeoutError',
          code: 'UND_ERR_CONNECT_TIMEOUT',
        });
        break;
      case 'dns':
        cause = Object.assign(new Error(action.message || `getaddrinfo ENOTFOUND ${host}`), {
          code: 'ENOTFOUND',
          syscall: 'getaddrinfo',
          hostname: host,
        });
        break;
      case 'tls':
        cause = Object.assign(new Error(action.message || 'unable to verify the first certificate'), {
          code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        });
        break;
      case 'connection':
        cause = Object.assign(new Error(action.message || `connect ECONNREFUSED ${host}:${port}`), {
          code: 'ECONNREFUSED',
          syscall: 'connect',
        });
        break;
      default:
        cause = new Error(message);
    }
    return withCause(new TypeError('fetch failed'), cause);
  }
  if (runtime === 'react-native') {
    return new TypeError(action.error === 'timeout' ? 'Network request timed out' : 'Network request failed');
  }
  return withCause(new TypeError('Failed to fetch'), new Error(message));
}

function makeMockResponse(action: RespondAction, url: string): unknown {
  const ResponseCtor = g.Response;
  if (typeof ResponseCtor !== 'function') return undefined;
  const status = action.status;
  const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
  let body: unknown = null;
  if (!nullBody && action.body) body = action.bodyEncoding === 'base64' ? base64Decode(action.body) : action.body;
  const init = { status, statusText: statusText(status), headers: action.headers ? action.headers.slice() : [] };
  let res: AnyRecord;
  try {
    res = new ResponseCtor(body, init);
  } catch {
    // Status outside 200–599 (or other constructor limits): build a 200 and override the fields.
    res = new ResponseCtor(body, { ...init, status: 200, statusText: init.statusText });
    try {
      Object.defineProperty(res, 'status', { value: status });
      Object.defineProperty(res, 'ok', { value: status >= 200 && status < 300 });
    } catch {
      // ignore
    }
  }
  try {
    if (!res.url) Object.defineProperty(res, 'url', { value: url });
  } catch {
    // ignore
  }
  return res;
}

async function readStreamPrefix(stream: AnyRecord, max: number): Promise<{ bytes: Uint8Array; total: number; complete: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      const chunk: Uint8Array = value instanceof Uint8Array ? value : typeof value === 'string' ? utf8Encode(value) : new Uint8Array(value);
      total += chunk.length;
      if (kept < max) {
        const part = chunk.length > max - kept ? chunk.subarray(0, max - kept) : chunk;
        chunks.push(part);
        kept += part.length;
      }
      if (total > max) break; // enough: never pull more than the app itself would
    }
  } catch {
    complete = false;
  } finally {
    try {
      if (!complete) await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, total, complete };
}

/** Response body from a clone; resolves when fully read (or the limit was reached). */
async function captureResponseBody(response: AnyRecord, headers: Header[], cfg: BodyConfig): Promise<WireBody | undefined> {
  const contentType = findHeader(headers, 'content-type');
  const lengthHeader = Number(findHeader(headers, 'content-length'));
  const declared = isFinite(lengthHeader) && lengthHeader >= 0 ? lengthHeader : undefined;
  if (!cfg.captureBodies) return declared ? { encoding: 'utf8', data: '', size: declared, truncated: true } : undefined;
  let clone: AnyRecord;
  try {
    clone = response.clone();
  } catch {
    return declared ? { encoding: 'utf8', data: '', size: declared, truncated: true } : undefined;
  }
  const max = Math.max(0, cfg.maxBodyBytes);
  if (clone.body && typeof clone.body.getReader === 'function') {
    const { bytes, total, complete } = await readStreamPrefix(clone.body, max);
    if (total === 0 && complete) return undefined;
    const size = complete ? total : Math.max(declared || 0, total);
    const body = bodyFromBytes(bytes, contentType, cfg, size);
    if (!complete) body.truncated = true;
    return body;
  }
  if (typeof clone.arrayBuffer === 'function') {
    const ab: ArrayBuffer = await clone.arrayBuffer();
    if (!ab.byteLength) return undefined;
    return bodyFromBytes(new Uint8Array(ab), contentType, cfg);
  }
  return undefined;
}

async function requestBodyFrom(info: RequestInfo, cfg: BodyConfig): Promise<WireBody | undefined> {
  const contentType = findHeader(info.headers, 'content-type') || inferContentType(info.body);
  if (info.bodyFromRequest) {
    if (!cfg.captureBodies) return undefined;
    try {
      const ab: ArrayBuffer = await info.bodyFromRequest.clone().arrayBuffer();
      return ab.byteLength ? bodyFromBytes(new Uint8Array(ab), contentType, cfg) : undefined;
    } catch {
      return undefined;
    }
  }
  const captured = captureRequestBody(info.body, contentType, cfg);
  return isPromiseLike(captured) ? await captured : captured;
}

export function installFetchPatch(host: NetworkHost, runtime: Runtime): Patch[] {
  const current = g.fetch;
  if (typeof current !== 'function') return [];
  if (isXhrBasedFetch(current, runtime)) {
    host.debug('fetch runs on XMLHttpRequest here: captured by the XHR patch');
    return [];
  }

  const patch = patchMethod<(...args: unknown[]) => unknown>(g, 'fetch', (original, isActive) => {
    const callOriginal = (thisArg: unknown, args: unknown[]): unknown => {
      fetchGuard.depth++;
      try {
        return original.apply(thisArg, args);
      } finally {
        fetchGuard.depth--;
      }
    };

    const run = async (thisArg: unknown, args: unknown[], info: RequestInfo): Promise<unknown> => {
      const id = host.nextRequestId();
      const startTs = Date.now();
      let requestSent = false;
      const message: SdkNetRequest = { type: 'net.request', id, ts: startTs, method: info.method, url: info.url, headers: info.headers, source: 'fetch' };
      const requestReady = requestBodyFrom(info, host.bodyConfig)
        .then(
          (body) => {
            if (body) message.body = body;
          },
          () => undefined,
        )
        .then(() => {
          requestSent = true;
          host.emit(message);
        });
      const afterRequest = (fn: () => void) => {
        const safe = () => {
          try {
            fn();
          } catch (e) {
            host.debug('fetch report', e);
          }
        };
        if (requestSent) safe();
        else requestReady.then(safe, safe);
      };

      let rule: MockRule | undefined;
      try {
        rule = host.findMock(info.method, info.url);
      } catch {
        rule = undefined;
      }
      let mockInfo: { mocked?: true; mockRuleId?: string } = rule ? { mocked: true, mockRuleId: rule.id } : {};
      let reported = false;

      try {
        if (rule) {
          const action = rule.action;
          const delay = mockDelayMs(action);
          if (delay > 0 || (info.signal && info.signal.aborted)) await sleep(delay, info.signal);
          if (action.type === 'respond') {
            const res = makeMockResponse(action, info.url);
            if (res) {
              const endTs = Date.now();
              const headers = action.headers ? action.headers.slice() : [];
              const contentType = findHeader(headers, 'content-type');
              const bytes = action.body ? (action.bodyEncoding === 'base64' ? base64Decode(action.body) : utf8Encode(action.body)) : undefined;
              const body = bytes && bytes.length ? bodyFromBytes(bytes, contentType, host.bodyConfig) : undefined;
              const text = statusText(action.status);
              reported = true;
              afterRequest(() =>
                host.emit({
                  type: 'net.response',
                  id,
                  ts: endTs,
                  status: action.status,
                  ...(text ? { statusText: text } : {}),
                  headers,
                  ...(body ? { body } : {}),
                  timings: { wait: endTs - startTs, receive: 0 },
                  ...mockInfo,
                }),
              );
              return res;
            }
            // No Response constructor in this runtime: fall back to the real network, reported as unmocked.
            mockInfo = {};
          } else if (action.type === 'fail') {
            const err = naturalFetchError(action, info.url, runtime);
            const endTs = Date.now();
            reported = true;
            afterRequest(() => host.emit({ type: 'net.error', id, ts: endTs, error: describeMockFailure(action, info.url), ...mockInfo }));
            throw err;
          }
        }

        const response = (await callOriginal(thisArg, args)) as AnyRecord;
        const headersAt = Date.now();
        reported = true;
        let status = 0;
        let text = '';
        let headers: Header[] = [];
        try {
          status = Number(response.status) || 0;
          text = String(response.statusText || '');
          headers = headersFromInit(response.headers);
        } catch {
          // exotic response object
        }
        captureResponseBody(response, headers, host.bodyConfig)
          .then(undefined, () => undefined)
          .then((body) => {
            const endTs = Date.now();
            afterRequest(() =>
              host.emit({
                type: 'net.response',
                id,
                ts: endTs,
                status,
                ...(text ? { statusText: text } : {}),
                headers,
                ...(body ? { body } : {}),
                timings: { wait: headersAt - startTs, receive: endTs - headersAt },
                ...mockInfo,
              }),
            );
          });
        return response;
      } catch (err) {
        if (!reported) {
          const endTs = Date.now();
          afterRequest(() =>
            host.emit({
              type: 'net.error',
              id,
              ts: endTs,
              error: describeFetchError(err),
              ...(isAbortError(err) ? { cancelled: true } : {}),
              ...mockInfo,
            }),
          );
        }
        throw err;
      }
    };

    return function durbunFetch(this: unknown, ...args: unknown[]) {
      if (!isActive()) return original.apply(this, args);
      let info: RequestInfo;
      try {
        info = describeRequest(args[0], args[1] && typeof args[1] === 'object' ? (args[1] as AnyRecord) : undefined);
        if (host.isIgnored(info.url)) return callOriginal(this, args);
      } catch (e) {
        host.debug('fetch', e);
        return callOriginal(this, args);
      }
      return run(this, args, info);
    };
  });
  return patch ? [patch] : [];
}
