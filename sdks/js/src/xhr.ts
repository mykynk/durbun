/**
 * XMLHttpRequest capture + mocks. React Native's `fetch` (whatwg-fetch) and axios both run on XHR, so this
 * is the main network hook on RN; in browsers it covers XHR traffic (native fetch is patched separately).
 *
 * The prototype methods `open` / `setRequestHeader` / `send` / `abort` are wrapped (like RN's own
 * XHRInterceptor), so `instanceof`, subclassing and other interceptors keep working. Capture only adds
 * listeners and reads response properties — it never consumes anything the app reads.
 *
 * Mocked requests never reach the network: the instance gets own-property overrides for the response
 * fields (status, response, headers, readyState, …) and the usual event sequence is dispatched, so app
 * code, whatwg-fetch and axios see a normal response / a natural network error / timeout / abort.
 */
import {
  base64Decode,
  bodyFromBlob,
  bodyFromBytes,
  bodyFromString,
  captureRequestBody,
  inferContentType,
  isArrayBufferLike,
  isBlobLike,
  isStreamingContentType,
  sizeOnly,
  utf8Decode,
  utf8Encode,
  utf8Length,
} from './body.js';
import { findHeader, parseRawHeaders, toRawHeaders } from './headers.js';
import { describeMockFailure, mockDelayMs, statusText, type RespondAction } from './mocks.js';
import { fetchGuard, type NetworkHost } from './network.js';
import { patchMethod, type Patch } from './patch.js';
import type { Header, MockRule, SdkNetRequest, Timings, WireBody } from './protocol.js';
import { isEventStream, SseTap } from './streams.js';
import {
  attempt,
  clearTimer,
  errorMessage,
  g,
  isPromiseLike,
  resolveUrl,
  setTimer,
  type AnyRecord,
  type TimerHandle,
} from './util.js';

interface Override {
  key: string;
  hadOwn: boolean;
  desc?: PropertyDescriptor;
}

interface XhrRecord {
  method: string;
  url: string;
  headers: Header[];
  async: boolean;
  passthrough: boolean;
  id?: string;
  startTs?: number;
  headersAt?: number;
  /** net.request was handed to the host (bodies may be read asynchronously). */
  requestDone?: boolean;
  requestEmitted?: Promise<void>;
  done?: boolean;
  rule?: MockRule;
  mockTimer?: TimerHandle;
  /** The real (network) send() was called. */
  sentToNetwork?: boolean;
  /** send() was called and waits for the desktop's mock rules (see `NetworkHost.mocksPending`). */
  waiting?: boolean;
  overrides?: Override[];
  listeners?: Array<[string, (ev: unknown) => void]>;
  /** An event stream being read as Server-Sent Events. */
  sse?: { tap: SseTap; listeners: Array<[string, (ev: unknown) => void]> };
}

const THROWS = {};

type Progress = { loaded: number; total: number };

function makeEvent(type: string, progress?: Progress): unknown {
  const PE = g.ProgressEvent;
  if (progress && typeof PE === 'function') {
    try {
      return new PE(type, { lengthComputable: progress.total > 0, loaded: progress.loaded, total: progress.total });
    } catch {
      // fall through
    }
  }
  const Ev = g.Event;
  if (typeof Ev === 'function') {
    try {
      const ev = new Ev(type);
      if (progress) {
        try {
          Object.defineProperties(ev, {
            lengthComputable: { value: progress.total > 0 },
            loaded: { value: progress.loaded },
            total: { value: progress.total },
          });
        } catch {
          // read-only event objects: fine
        }
      }
      return ev;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Dispatches a synthetic XHR event: a real Event when the runtime has one, else a plain `{ type }` object
 * (event-target-shim, used by RN's XHR, accepts both), else calls the `on<type>` handler directly.
 */
export function fireXhrEvent(target: AnyRecord, type: string, progress?: Progress): void {
  const canDispatch = typeof target.dispatchEvent === 'function';
  const ev = makeEvent(type, progress);
  if (ev && canDispatch) {
    try {
      target.dispatchEvent(ev);
      return;
    } catch {
      // implementation rejected the event object; try a plain one
    }
  }
  const plain = {
    type,
    target,
    currentTarget: target,
    srcElement: target,
    bubbles: false,
    cancelable: false,
    defaultPrevented: false,
    eventPhase: 2,
    isTrusted: false,
    timeStamp: Date.now(),
    lengthComputable: progress ? progress.total > 0 : false,
    loaded: progress ? progress.loaded : 0,
    total: progress ? progress.total : 0,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
  if (canDispatch) {
    try {
      target.dispatchEvent(plain);
      return;
    } catch {
      // fall back to the handler property
    }
  }
  const handler = attempt(() => target['on' + type], undefined);
  if (typeof handler === 'function') {
    try {
      handler.call(target, plain);
    } catch (e) {
      // Like the platform: an exception in an event handler is reported, not thrown into the dispatcher.
      setTimer(() => {
        throw e;
      }, 0);
    }
  }
}

function invalidStateError(message: string): Error {
  const DE = g.DOMException;
  if (typeof DE === 'function') {
    try {
      return new DE(message, 'InvalidStateError');
    } catch {
      // fall through
    }
  }
  const err = new Error(message);
  err.name = 'InvalidStateError';
  return err;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A Blob holding exactly `bytes`, or undefined when this runtime cannot build one. React Native's Blob takes
 * only string and Blob parts and stores strings as UTF-8, so there the bytes survive only when they are
 * valid UTF-8 (text, JSON, SVG…); other binary data (images, PDFs) has no exact JS-side form.
 */
function binaryBlob(bytes: Uint8Array, text: string, contentType: string | undefined): unknown {
  const BlobCtor = g.Blob;
  if (typeof BlobCtor !== 'function') return undefined;
  const opts = contentType ? { type: contentType } : undefined;
  try {
    return new BlobCtor([bytes], opts);
  } catch {
    // React Native: string parts only
  }
  if (!sameBytes(utf8Encode(text), bytes)) return undefined;
  try {
    return new BlobCtor([text], opts);
  } catch {
    return undefined;
  }
}

function makeBlob(bytes: Uint8Array | undefined, text: string, contentType: string | undefined): unknown {
  const BlobCtor = g.Blob;
  if (typeof BlobCtor !== 'function') return null;
  if (bytes) {
    const blob = binaryBlob(bytes, text, contentType);
    if (blob !== undefined) return blob;
  }
  try {
    return new BlobCtor([text], contentType ? { type: contentType } : undefined);
  } catch {
    return null;
  }
}

/** Can a `respond` mock be delivered intact for this response type? (Binary Blob bodies in React Native may not.) */
function mockBodyDeliverable(responseType: string, action: RespondAction): boolean {
  if (responseType !== 'blob' || action.bodyEncoding !== 'base64' || !action.body) return true;
  const BlobCtor = g.Blob;
  if (typeof BlobCtor !== 'function') return true;
  try {
    new BlobCtor([new Uint8Array(0)]);
    return true; // byte parts are supported
  } catch {
    // React Native: only valid UTF-8 survives the string part
  }
  const bytes = base64Decode(action.body);
  return sameBytes(utf8Encode(utf8Decode(bytes)), bytes);
}

function parseDocument(text: string, contentType: string | undefined): unknown {
  const DP = g.DOMParser;
  if (typeof DP !== 'function') return null;
  try {
    return new DP().parseFromString(text, contentType && /html/i.test(contentType) ? 'text/html' : 'application/xml');
  } catch {
    return null;
  }
}

function mockResponseValue(responseType: string, text: string, bytes: Uint8Array | undefined, contentType: string | undefined): unknown {
  switch (responseType) {
    case '':
    case 'text':
      return text;
    case 'json':
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    case 'arraybuffer': {
      const source = bytes || utf8Encode(text);
      const copy = new Uint8Array(source.length);
      copy.set(source);
      return copy.buffer;
    }
    case 'blob':
      return makeBlob(bytes, text, contentType);
    case 'document':
      return parseDocument(text, contentType);
    default:
      return text;
  }
}

export function installXhrPatch(host: NetworkHost): Patch[] {
  const XHR = g.XMLHttpRequest;
  if (typeof XHR !== 'function' || !XHR.prototype) return [];
  const proto = XHR.prototype as AnyRecord;
  const records = new WeakMap<object, XhrRecord>();
  /** Mock rules already reported as not applicable (one note per rule). */
  const notedRules = new Set<string>();

  /* ── reporting helpers ── */

  const emitRequest = (rec: XhrRecord, body: unknown): Promise<void> => {
    const message: SdkNetRequest = {
      type: 'net.request',
      id: rec.id as string,
      ts: rec.startTs as number,
      method: rec.method,
      url: rec.url,
      headers: rec.headers.slice(),
      source: 'xhr',
    };
    const finish = (b: WireBody | undefined) => {
      if (b) message.body = b;
      rec.requestDone = true;
      host.emit(message);
    };
    let captured: WireBody | Promise<WireBody | undefined> | undefined;
    try {
      captured = captureRequestBody(body, findHeader(rec.headers, 'content-type') || inferContentType(body), host.bodyConfig);
    } catch (e) {
      host.debug('xhr request body', e);
      captured = undefined;
    }
    if (isPromiseLike(captured)) {
      return Promise.resolve(captured).then(finish, () => finish(undefined));
    }
    finish(captured);
    return Promise.resolve();
  };

  /** Runs `send` once the request was reported and the body (maybe async) is ready — synchronously when possible. */
  const after = (
    rec: XhrRecord,
    body: WireBody | Promise<WireBody | undefined> | undefined,
    send: (body: WireBody | undefined) => void,
  ): void => {
    const run = (b: WireBody | undefined) => {
      try {
        send(b);
      } catch (e) {
        host.debug('xhr report', e);
      }
    };
    if (rec.requestDone && !isPromiseLike(body)) {
      run(body);
      return;
    }
    Promise.all([rec.requestEmitted || Promise.resolve(), Promise.resolve(body)]).then(
      ([, b]) => run(b),
      () => run(undefined),
    );
  };

  const mockFields = (rec: XhrRecord): { mocked?: true; mockRuleId?: string } =>
    rec.rule ? { mocked: true, mockRuleId: rec.rule.id } : {};

  /* ── listeners on real requests ── */

  const unwatch = (xhr: AnyRecord, rec: XhrRecord) => {
    if (!rec.listeners) return;
    for (const [type, fn] of rec.listeners) {
      try {
        xhr.removeEventListener(type, fn);
      } catch {
        // ignore
      }
    }
    rec.listeners = undefined;
  };

  const captureResponseBody = (xhr: AnyRecord, headers: Header[]): WireBody | Promise<WireBody | undefined> | undefined => {
    const cfg = host.bodyConfig;
    const contentType = findHeader(headers, 'content-type');
    const responseType = attempt(() => String(xhr.responseType || ''), '');
    if (!cfg.captureBodies) return responseSize(xhr, responseType, headers);
    switch (responseType) {
      case '':
      case 'text': {
        const text = attempt<unknown>(() => xhr.responseText, undefined);
        return typeof text === 'string' && text.length > 0 ? bodyFromString(text, contentType, cfg) : undefined;
      }
      case 'json': {
        const value = attempt<unknown>(() => xhr.response, null);
        if (value === null || value === undefined) return undefined;
        let text: string;
        try {
          text = JSON.stringify(value);
        } catch {
          return undefined;
        }
        return bodyFromString(text, contentType || 'application/json', cfg);
      }
      case 'arraybuffer': {
        const ab = attempt<unknown>(() => xhr.response, null);
        return isArrayBufferLike(ab) && ab.byteLength > 0 ? bodyFromBytes(new Uint8Array(ab), contentType, cfg) : undefined;
      }
      case 'blob': {
        const blob = attempt<unknown>(() => xhr.response, null);
        return isBlobLike(blob) ? bodyFromBlob(blob, contentType, cfg) : undefined;
      }
      case 'document': {
        const doc = attempt<unknown>(() => xhr.responseXML, null);
        const XS = g.XMLSerializer;
        if (doc && typeof XS === 'function') {
          try {
            return bodyFromString(new XS().serializeToString(doc), contentType || 'application/xml', cfg);
          } catch {
            return undefined;
          }
        }
        return undefined;
      }
      default:
        return undefined;
    }
  };

  /** Size only, from what the response already holds: never reads, decodes or serializes the body. */
  const responseSize = (xhr: AnyRecord, responseType: string, headers: Header[]): WireBody | undefined => {
    const declared = Number(findHeader(headers, 'content-length'));
    if (isFinite(declared) && declared > 0) return sizeOnly(declared);
    if (responseType === '' || responseType === 'text') {
      const text = attempt<unknown>(() => xhr.responseText, undefined);
      return typeof text === 'string' && text.length > 0 ? sizeOnly(utf8Length(text)) : undefined;
    }
    const value = attempt<unknown>(() => xhr.response, null);
    if (responseType === 'arraybuffer' && isArrayBufferLike(value) && value.byteLength > 0) return sizeOnly(value.byteLength);
    if (responseType === 'blob' && isBlobLike(value) && typeof value.size === 'number' && value.size > 0) return sizeOnly(value.size);
    return undefined;
  };

  const timings = (rec: XhrRecord, endTs: number): Timings | undefined => {
    if (rec.headersAt === undefined || rec.startTs === undefined) return undefined;
    return { wait: Math.max(0, rec.headersAt - rec.startTs), receive: Math.max(0, endTs - rec.headersAt) };
  };

  const complete = (xhr: AnyRecord, rec: XhrRecord, kind: 'load' | 'error' | 'timeout' | 'abort' | 'loadend') => {
    if (rec.done || records.get(xhr) !== rec) return;
    let outcome = kind;
    if (outcome === 'loadend') outcome = attempt(() => Number(xhr.status) || 0, 0) > 0 ? 'load' : 'error';
    rec.done = true;
    unwatch(xhr, rec);
    const endTs = Date.now();
    const id = rec.id as string;
    if (outcome === 'load') {
      const status = attempt(() => Number(xhr.status) || 0, 0);
      const text = attempt(() => String(xhr.statusText || ''), '');
      const headers = parseRawHeaders(attempt<unknown>(() => xhr.getAllResponseHeaders(), ''));
      let body: WireBody | Promise<WireBody | undefined> | undefined;
      try {
        body = captureResponseBody(xhr, headers);
      } catch (e) {
        host.debug('xhr response body', e);
        body = undefined;
      }
      const t = timings(rec, endTs);
      after(rec, body, (b) =>
        host.emit({
          type: 'net.response',
          id,
          ts: endTs,
          status,
          ...(text ? { statusText: text } : {}),
          headers,
          ...(b ? { body: b } : {}),
          ...(t ? { timings: t } : {}),
          ...mockFields(rec),
        }),
      );
      return;
    }
    let error: string;
    if (outcome === 'abort') error = 'Request cancelled';
    else if (outcome === 'timeout') {
      const timeout = attempt(() => Number(xhr.timeout) || 0, 0);
      error = timeout > 0 ? `Request timed out after ${timeout} ms` : 'Request timed out';
    } else {
      // React Native keeps the native error text (e.g. "Unable to resolve host …") in `_response`.
      const detail = attempt(() => (typeof xhr._response === 'string' ? xhr._response : ''), '');
      error = detail || 'Network request failed';
    }
    after(rec, undefined, () =>
      host.emit({ type: 'net.error', id, ts: endTs, error, ...(outcome === 'abort' ? { cancelled: true } : {}), ...mockFields(rec) }),
    );
  };

  /**
   * A response that stays open (SSE, NDJSON, media…; the list `fetch` uses): reported as soon as its headers
   * arrive, with its declared size only, like the fetch capture. Its end (load / abort) is not reported again.
   */
  const completeStreaming = (xhr: AnyRecord, rec: XhrRecord): boolean => {
    if (rec.done) return true;
    const headers = parseRawHeaders(attempt<unknown>(() => xhr.getAllResponseHeaders(), ''));
    const contentType = findHeader(headers, 'content-type');
    if (!isStreamingContentType(contentType)) return false;
    rec.done = true;
    unwatch(xhr, rec);
    const ts = Date.now();
    const status = attempt(() => Number(xhr.status) || 0, 0);
    const text = attempt(() => String(xhr.statusText || ''), '');
    const declared = Number(findHeader(headers, 'content-length'));
    const startTs = rec.startTs as number;
    const responseType = attempt(() => String(xhr.responseType || ''), '');
    // Server-Sent Events read as text: its events are reported one by one (while the desktop asks for
    // streams), so the response carries no body.
    const sse = isEventStream(contentType) && (responseType === '' || responseType === 'text') && status >= 200 && status < 300;
    const asStream = sse && host.streamCapture() !== undefined;
    after(rec, undefined, () =>
      host.emit({
        type: 'net.response',
        id: rec.id as string,
        ts,
        status,
        ...(text ? { statusText: text } : {}),
        headers,
        ...(!asStream && isFinite(declared) && declared > 0 ? { body: sizeOnly(declared) } : {}),
        timings: { wait: Math.max(0, ts - startTs), receive: 0 },
        ...mockFields(rec),
      }),
    );
    if (sse) {
      try {
        tapEventStream(xhr, rec);
      } catch (e) {
        host.debug('xhr event stream', e);
      }
    }
    return true;
  };

  /**
   * Reads the growing `responseText` of an event stream as the app's own SSE library does (it reads the same
   * text): new text on every readystatechange / progress, the end on load / abort / error. Only listeners are
   * added; the request and its response stay the app's.
   */
  const tapEventStream = (xhr: AnyRecord, rec: XhrRecord) => {
    if (typeof xhr.addEventListener !== 'function') return;
    const tap = new SseTap(host, rec.id as string, (msg) => after(rec, undefined, () => host.emit(msg)));
    const sse: NonNullable<XhrRecord['sse']> = { tap, listeners: [] };
    rec.sse = sse;
    let offset = 0;
    /** `final`: the load event (the whole text). Otherwise only while LOADING: on an error React Native puts
     * the error message where the text was. */
    const pump = (final = false) => {
      if (!final && attempt(() => Number(xhr.readyState) || 0, 0) !== 3) return;
      const text = attempt<unknown>(() => xhr.responseText, '');
      // Shorter than before: the runtime reset it (abort); never read it twice.
      if (typeof text === 'string' && text.length > offset) {
        const chunk = text.slice(offset);
        offset = text.length;
        tap.text(chunk);
      }
    };
    const stop = (end: () => void) => {
      if (tap.finished) return;
      for (const [type, fn] of sse.listeners) {
        try {
          xhr.removeEventListener(type, fn);
        } catch {
          // ignore
        }
      }
      sse.listeners = [];
      end();
    };
    const incremental = attempt<unknown>(() => xhr._incrementalEvents, undefined);
    const add = (type: string, fn: () => void) => {
      const listener = () => {
        try {
          fn();
        } catch (e) {
          host.debug('xhr event stream', e);
        }
      };
      try {
        xhr.addEventListener(type, listener);
        sse.listeners.push([type, listener]);
      } catch {
        // ignore
      }
    };
    add('readystatechange', () => pump());
    add('progress', () => pump());
    if (typeof incremental === 'boolean') {
      try {
        xhr._incrementalEvents = incremental;
      } catch {
        // ignore
      }
    }
    add('load', () => {
      pump(true);
      stop(() => tap.end());
    });
    add('abort', () => stop(() => tap.cancel()));
    add('error', () => {
      const detail = attempt(() => (typeof xhr._response === 'string' ? xhr._response : ''), '');
      stop(() => tap.fail(detail || 'Network request failed'));
    });
    add('timeout', () => {
      const timeout = attempt(() => Number(xhr.timeout) || 0, 0);
      stop(() => tap.fail(timeout > 0 ? `Request timed out after ${timeout} ms` : 'Request timed out'));
    });
    add('loadend', () => {
      if (attempt(() => Number(xhr.status) || 0, 0) > 0) {
        pump(true);
        stop(() => tap.end());
      } else stop(() => tap.fail('Network request failed'));
    });
    // Text that arrived with the headers.
    pump();
  };

  const watch = (xhr: AnyRecord, rec: XhrRecord) => {
    if (typeof xhr.addEventListener !== 'function') return;
    // React Native switches a request to incremental (chunk by chunk) delivery when anyone listens to
    // 'readystatechange' or 'progress'; our listener must not make the app's responses more expensive.
    const incremental = attempt<unknown>(() => xhr._incrementalEvents, undefined);
    const add = (type: string, fn: (ev: unknown) => void) => {
      try {
        xhr.addEventListener(type, fn);
        (rec.listeners || (rec.listeners = [])).push([type, fn]);
      } catch {
        // ignore
      }
    };
    add('readystatechange', () => {
      if (records.get(xhr) !== rec || rec.headersAt !== undefined || rec.done) return;
      if (attempt(() => Number(xhr.readyState) || 0, 0) >= 2) {
        rec.headersAt = Date.now();
        try {
          completeStreaming(xhr, rec);
        } catch (e) {
          host.debug('xhr stream', e);
        }
      }
    });
    if (typeof incremental === 'boolean') {
      try {
        xhr._incrementalEvents = incremental;
      } catch {
        // ignore
      }
    }
    add('load', () => complete(xhr, rec, 'load'));
    add('error', () => complete(xhr, rec, 'error'));
    add('timeout', () => complete(xhr, rec, 'timeout'));
    add('abort', () => complete(xhr, rec, 'abort'));
    add('loadend', () => complete(xhr, rec, 'loadend'));
  };

  /* ── mocked responses ── */

  const override = (xhr: AnyRecord, rec: XhrRecord, props: Record<string, unknown>) => {
    const list = rec.overrides || (rec.overrides = []);
    for (const key of Object.keys(props)) {
      if (!list.some((o) => o.key === key)) {
        const desc = attempt(() => Object.getOwnPropertyDescriptor(xhr, key), undefined);
        list.push({ key, hadOwn: !!desc, desc });
      }
      const value = props[key];
      try {
        if (value === THROWS) {
          Object.defineProperty(xhr, key, {
            configurable: true,
            enumerable: true,
            get() {
              throw invalidStateError(
                `Failed to read the '${key}' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text'.`,
              );
            },
          });
        } else {
          Object.defineProperty(xhr, key, { configurable: true, enumerable: typeof value !== 'function', writable: true, value });
        }
      } catch {
        // non-configurable property: leave it
      }
    }
  };

  const restoreOverrides = (xhr: AnyRecord, rec: XhrRecord) => {
    if (!rec.overrides) return;
    for (const o of rec.overrides) {
      try {
        if (o.hadOwn && o.desc) Object.defineProperty(xhr, o.key, o.desc);
        else delete xhr[o.key];
      } catch {
        // ignore
      }
    }
    rec.overrides = undefined;
  };

  const setReadyState = (xhr: AnyRecord, rec: XhrRecord, state: number) => override(xhr, rec, { readyState: state });

  const synthesizeResponse = (xhr: AnyRecord, rec: XhrRecord, rule: MockRule, action: RespondAction) => {
    const headers = action.headers ? action.headers.slice() : [];
    const contentType = findHeader(headers, 'content-type');
    const bytes = action.bodyEncoding === 'base64' ? base64Decode(action.body || '') : undefined;
    const text = bytes ? utf8Decode(bytes) : action.body || '';
    const responseType = attempt(() => String(xhr.responseType || ''), '');
    const isText = responseType === '' || responseType === 'text';
    const response = mockResponseValue(responseType, text, bytes, contentType);
    const size = bytes ? bytes.length : utf8Encode(text).length;
    const status = action.status;
    const endTs = Date.now();
    rec.done = true;
    const wire = bytes ? bodyFromBytes(bytes, contentType, host.bodyConfig) : text ? bodyFromString(text, contentType, host.bodyConfig) : undefined;
    const text2 = statusText(status);
    // Report before the app reacts, so the desktop timeline shows the response first.
    after(rec, wire, (b) =>
      host.emit({
        type: 'net.response',
        id: rec.id as string,
        ts: endTs,
        status,
        ...(text2 ? { statusText: text2 } : {}),
        headers,
        ...(b ? { body: b } : {}),
        timings: { wait: Math.max(0, endTs - (rec.startTs as number)), receive: 0 },
        mocked: true,
        mockRuleId: rule.id,
      }),
    );
    const raw = toRawHeaders(headers);
    override(xhr, rec, {
      status,
      statusText: text2,
      responseURL: rec.url,
      response,
      responseText: isText ? text : THROWS,
      responseXML: responseType === 'document' ? response : null,
      getAllResponseHeaders: () => raw,
      getResponseHeader: (name: unknown) => (name === undefined || name === null ? null : findHeader(headers, String(name)) ?? null),
    });
    const progress = { loaded: size, total: size };
    setReadyState(xhr, rec, 2);
    fireXhrEvent(xhr, 'readystatechange');
    setReadyState(xhr, rec, 3);
    fireXhrEvent(xhr, 'readystatechange');
    fireXhrEvent(xhr, 'progress', progress);
    setReadyState(xhr, rec, 4);
    fireXhrEvent(xhr, 'readystatechange');
    fireXhrEvent(xhr, 'load', progress);
    fireXhrEvent(xhr, 'loadend', progress);
  };

  const synthesizeFailure = (xhr: AnyRecord, rec: XhrRecord, kind: 'error' | 'timeout' | 'abort', message: string) => {
    const endTs = Date.now();
    rec.done = true;
    after(rec, undefined, () =>
      host.emit({
        type: 'net.error',
        id: rec.id as string,
        ts: endTs,
        error: message,
        ...(kind === 'abort' ? { cancelled: true } : {}),
        ...mockFields(rec),
      }),
    );
    const responseType = attempt(() => String(xhr.responseType || ''), '');
    const isText = responseType === '' || responseType === 'text';
    override(xhr, rec, {
      status: 0,
      statusText: '',
      responseURL: '',
      response: isText ? '' : null,
      responseText: isText ? '' : THROWS,
      responseXML: null,
      getAllResponseHeaders: () => '',
      getResponseHeader: () => null,
    });
    setReadyState(xhr, rec, 4);
    fireXhrEvent(xhr, 'readystatechange');
    fireXhrEvent(xhr, kind, { loaded: 0, total: 0 });
    fireXhrEvent(xhr, 'loadend', { loaded: 0, total: 0 });
    if (kind === 'abort') setReadyState(xhr, rec, 0);
  };

  const startMock = (xhr: AnyRecord, rec: XhrRecord, rule: MockRule, sendReal: () => unknown) => {
    const action = rule.action;
    const delay = mockDelayMs(action);
    const timeout = attempt(() => Number(xhr.timeout) || 0, 0);
    const run = (fn: () => void, ms: number) => {
      if (!rec.async) {
        fn();
        return;
      }
      rec.mockTimer = setTimer(() => {
        rec.mockTimer = undefined;
        if (records.get(xhr) !== rec || rec.done) return;
        try {
          fn();
        } catch (e) {
          host.debug('xhr mock', e);
        }
      }, ms);
    };
    if (action.type !== 'delay' && rec.async) fireXhrEvent(xhr, 'loadstart', { loaded: 0, total: 0 });
    // The app's own XHR timeout still applies to an injected delay — realistic latency testing.
    if (rec.async && timeout > 0 && delay >= timeout) {
      run(() => synthesizeFailure(xhr, rec, 'timeout', `Request timed out after ${timeout} ms`), timeout);
      return;
    }
    switch (action.type) {
      case 'respond':
        run(() => synthesizeResponse(xhr, rec, rule, action), delay);
        return;
      case 'fail':
        run(
          () => synthesizeFailure(xhr, rec, action.error === 'timeout' ? 'timeout' : 'error', describeMockFailure(action, rec.url)),
          delay,
        );
        return;
      case 'delay':
        run(() => {
          rec.sentToNetwork = true;
          watch(xhr, rec);
          try {
            sendReal();
          } catch (e) {
            if (!rec.done) {
              rec.done = true;
              unwatch(xhr, rec);
              after(rec, undefined, () =>
                host.emit({ type: 'net.error', id: rec.id as string, ts: Date.now(), error: errorMessage(e), ...mockFields(rec) }),
              );
            }
          }
        }, delay);
        return;
      default:
        sendReal();
    }
  };

  /** A reused instance (`open()` again): forget the previous request and remove our overrides. */
  const resetRecord = (xhr: AnyRecord, rec: XhrRecord) => {
    if (rec.mockTimer !== undefined) {
      clearTimer(rec.mockTimer);
      rec.mockTimer = undefined;
    }
    unwatch(xhr, rec);
    const sse = rec.sse;
    if (sse && !sse.tap.finished) {
      for (const [type, fn] of sse.listeners) {
        try {
          xhr.removeEventListener(type, fn);
        } catch {
          // ignore
        }
      }
      sse.tap.cancel();
    }
    if (rec.id !== undefined && !rec.done) {
      rec.done = true;
      after(rec, undefined, () =>
        host.emit({ type: 'net.error', id: rec.id as string, ts: Date.now(), error: 'Request cancelled', cancelled: true, ...mockFields(rec) }),
      );
    }
    restoreOverrides(xhr, rec);
  };

  /* ── prototype patches ── */

  const patches: Array<Patch | undefined> = [];

  patches.push(
    patchMethod<(...args: unknown[]) => unknown>(proto, 'open', (original, isActive) =>
      function durbunOpen(this: AnyRecord, ...args: unknown[]) {
        const prev = records.get(this);
        if (prev) {
          records.delete(this);
          resetRecord(this, prev);
        }
        if (isActive()) {
          try {
            const url = resolveUrl(String(args[1]));
            records.set(this, {
              method: String(args[0] === undefined ? 'GET' : args[0]).toUpperCase(),
              url,
              headers: [],
              async: args.length < 3 ? true : !!args[2],
              passthrough: fetchGuard.depth > 0 || host.isIgnored(url),
            });
          } catch (e) {
            host.debug('xhr open', e);
          }
        }
        return original.apply(this, args);
      },
    ),
  );

  patches.push(
    patchMethod<(...args: unknown[]) => unknown>(proto, 'setRequestHeader', (original) =>
      function durbunSetRequestHeader(this: AnyRecord, ...args: unknown[]) {
        const result = original.apply(this, args);
        const rec = records.get(this);
        if (rec && rec.id === undefined && args.length >= 2) rec.headers.push([String(args[0]), String(args[1])]);
        return result;
      },
    ),
  );

  patches.push(
    patchMethod<(...args: unknown[]) => unknown>(proto, 'send', (original, isActive) =>
      function durbunSend(this: AnyRecord, ...args: unknown[]) {
        const rec = records.get(this);
        if (!rec || rec.passthrough || !isActive()) return original.apply(this, args);
        if (rec.id !== undefined) {
          // Second send() on the same request: a mocked one never reached the network, mirror the platform error.
          if (rec.waiting || (rec.rule && !rec.sentToNetwork)) {
            throw invalidStateError("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.");
          }
          return original.apply(this, args);
        }
        let pending: Promise<void> | undefined;
        try {
          rec.id = host.nextRequestId();
          rec.startTs = Date.now();
          rec.requestEmitted = emitRequest(rec, args[0]);
          // Launch requests wait for the desktop's mock rules (async requests only: send() returns at once anyway).
          if (rec.async) pending = host.mocksPending();
        } catch (e) {
          host.debug('xhr send', e);
          if (rec.id === undefined) return original.apply(this, args);
        }
        if (pending) {
          rec.waiting = true;
          const xhr = this;
          const go = () => {
            rec.waiting = false;
            // Aborted or re-opened meanwhile: nothing to send.
            if (rec.done || records.get(xhr) !== rec) return;
            try {
              sendNow(xhr, rec, original, args);
            } catch (e) {
              host.debug('xhr send after wait', e);
            }
          };
          pending.then(go, go);
          return undefined;
        }
        return sendNow(this, rec, original, args);
      },
    ),
  );

  /** The rest of send(): mock rule lookup, then the mock or the real request. */
  function sendNow(xhr: AnyRecord, rec: XhrRecord, original: (...args: unknown[]) => unknown, args: unknown[]): unknown {
    let rule: MockRule | undefined;
    try {
      rule = host.findMock(rec.method, rec.url);
    } catch (e) {
      host.debug('xhr send', e);
    }
    if (rule && rule.action.type === 'respond' && !mockBodyDeliverable(attempt(() => String(xhr.responseType || ''), ''), rule.action)) {
      // Better the real response than corrupted bytes: say why once, and let the request through.
      if (!notedRules.has(rule.id)) {
        notedRules.add(rule.id);
        host.notice(
          `Mock rule "${rule.name || rule.url}" was not applied to ${rec.method} ${rec.url}: React Native cannot hold this binary (base64) body in a Blob response without corrupting it, so the request went to the network. Text, JSON and arraybuffer responses are mocked as usual.`,
        );
      }
      rule = undefined;
    }
    if (rule) {
      rec.rule = rule;
      try {
        startMock(xhr, rec, rule, () => original.apply(xhr, args));
        return undefined;
      } catch (e) {
        host.debug('xhr mock start', e);
        if (rec.done || rec.sentToNetwork) return undefined;
        rec.rule = undefined;
      }
    }
    rec.sentToNetwork = true;
    watch(xhr, rec);
    try {
      return original.apply(xhr, args);
    } catch (e) {
      if (!rec.done) {
        rec.done = true;
        unwatch(xhr, rec);
        const id = rec.id as string;
        after(rec, undefined, () => host.emit({ type: 'net.error', id, ts: Date.now(), error: errorMessage(e) }));
      }
      throw e;
    }
  }

  patches.push(
    patchMethod<(...args: unknown[]) => unknown>(proto, 'abort', (original) =>
      function durbunAbort(this: AnyRecord, ...args: unknown[]) {
        const rec = records.get(this);
        if (rec && (rec.mockTimer !== undefined || rec.waiting) && !rec.done) {
          // A mocked (or delayed) request, or one waiting for mock rules: cancel it like the platform would.
          clearTimer(rec.mockTimer);
          rec.mockTimer = undefined;
          try {
            synthesizeFailure(this, rec, 'abort', 'Request cancelled');
          } catch (e) {
            host.debug('xhr abort', e);
          }
          try {
            original.apply(this, args);
          } catch {
            // the native object was never sent
          }
          return undefined;
        }
        return original.apply(this, args);
      },
    ),
  );

  return patches.filter((p): p is Patch => !!p);
}
