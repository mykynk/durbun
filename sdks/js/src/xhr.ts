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
  utf8Decode,
  utf8Encode,
} from './body.js';
import { findHeader, parseRawHeaders, toRawHeaders } from './headers.js';
import { describeMockFailure, mockDelayMs, statusText, type RespondAction } from './mocks.js';
import { fetchGuard, type NetworkHost } from './network.js';
import { patchMethod, type Patch } from './patch.js';
import type { Header, MockRule, SdkNetRequest, Timings, WireBody } from './protocol.js';
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
  overrides?: Override[];
  listeners?: Array<[string, (ev: unknown) => void]>;
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

function makeBlob(bytes: Uint8Array | undefined, text: string, contentType: string | undefined): unknown {
  const BlobCtor = g.Blob;
  if (typeof BlobCtor !== 'function') return null;
  const opts = contentType ? { type: contentType } : undefined;
  if (bytes) {
    try {
      return new BlobCtor([bytes], opts);
    } catch {
      // React Native's Blob only accepts string/Blob parts: fall back to text
    }
  }
  try {
    return new BlobCtor([text], opts);
  } catch {
    return null;
  }
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

  const captureResponseBody = (xhr: AnyRecord, contentType: string | undefined): WireBody | Promise<WireBody | undefined> | undefined => {
    const cfg = host.bodyConfig;
    const responseType = attempt(() => String(xhr.responseType || ''), '');
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
        body = captureResponseBody(xhr, findHeader(headers, 'content-type'));
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

  const watch = (xhr: AnyRecord, rec: XhrRecord) => {
    if (typeof xhr.addEventListener !== 'function') return;
    const add = (type: string, fn: (ev: unknown) => void) => {
      try {
        xhr.addEventListener(type, fn);
        (rec.listeners || (rec.listeners = [])).push([type, fn]);
      } catch {
        // ignore
      }
    };
    add('readystatechange', () => {
      if (records.get(xhr) !== rec || rec.headersAt !== undefined) return;
      if (attempt(() => Number(xhr.readyState) || 0, 0) >= 2) rec.headersAt = Date.now();
    });
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
          if (rec.rule && !rec.sentToNetwork) {
            throw invalidStateError("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.");
          }
          return original.apply(this, args);
        }
        let rule: MockRule | undefined;
        try {
          rec.id = host.nextRequestId();
          rec.startTs = Date.now();
          rec.requestEmitted = emitRequest(rec, args[0]);
          rule = host.findMock(rec.method, rec.url);
        } catch (e) {
          host.debug('xhr send', e);
          if (rec.id === undefined) return original.apply(this, args);
        }
        if (rule) {
          rec.rule = rule;
          try {
            startMock(this, rec, rule, () => original.apply(this, args));
            return undefined;
          } catch (e) {
            host.debug('xhr mock start', e);
            if (rec.done || rec.sentToNetwork) return undefined;
            rec.rule = undefined;
          }
        }
        rec.sentToNetwork = true;
        watch(this, rec);
        try {
          return original.apply(this, args);
        } catch (e) {
          if (!rec.done) {
            rec.done = true;
            unwatch(this, rec);
            const id = rec.id as string;
            after(rec, undefined, () => host.emit({ type: 'net.error', id, ts: Date.now(), error: errorMessage(e) }));
          }
          throw e;
        }
      },
    ),
  );

  patches.push(
    patchMethod<(...args: unknown[]) => unknown>(proto, 'abort', (original) =>
      function durbunAbort(this: AnyRecord, ...args: unknown[]) {
        const rec = records.get(this);
        if (rec && rec.mockTimer !== undefined && !rec.done) {
          // A mocked (or delayed) request still waiting: cancel it like the platform would.
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
