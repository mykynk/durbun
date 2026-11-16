/**
 * Dürbün web view bridge: the script the Android and iOS SDKs inject into a web view at document start
 * (`DurbunWebView.attach(...)`). It reports the page's `fetch` and `XMLHttpRequest` calls and its `console.*`
 * lines (plus uncaught errors) to the native SDK, which sends them on as its own requests and logs, marked as
 * coming from the web view.
 *
 * Rules:
 * - The page's behaviour never changes: every wrapper calls the original with the same `this` and arguments and
 *   returns what it returns (fetch: the same response, through a promise that settles like the original);
 *   bodies are read from clones only (`Response.clone()`, never the page's own stream); every error of the
 *   bridge is swallowed.
 * - Bounded: messages per second, requests in flight, body, header, URL and console sizes are capped here, and
 *   again by the native side (page content is untrusted: a page can also call the channel itself, so entries
 *   from a web view are whatever the page claims).
 * - Self-contained: no imports. `npm run webview:generate -w @durbun/react-native` bundles it into the copies
 *   the native SDKs embed (a test fails when they drift).
 *
 * Messages to the native side (JSON strings, `v: 1`):
 *   { t: 'req',     id, api: 'fetch' | 'xhr', ts, method, url, headers: [[name, value]], body? }
 *   { t: 'reqbody', id, body }                                   (a `Request` object's body, read later)
 *   { t: 'res',     id, ts, status, statusText, headers, body?, wait, receive }
 *   { t: 'err',     id, ts, error, cancelled? }
 *   { t: 'log',     ts, level: 'debug' | 'info' | 'warn' | 'error', message, page, error? }
 *   { t: 'dropped', count }                                      (messages the rate limit dropped)
 * `body`: { encoding: 'utf8' | 'base64', data, size, truncated? } (size: full size in bytes when known).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Post = (json: string) => void;

export const LIMITS = {
  /** Bytes of a body kept (binary bodies are base64-encoded after the cut). */
  maxBodyBytes: 64 * 1024,
  /** Characters of one console line. */
  maxConsoleChars: 16 * 1024,
  maxUrlChars: 8 * 1024,
  maxHeaders: 100,
  /** Characters of all header names and values of one request or response together. */
  maxHeaderChars: 16 * 1024,
  /** Requests followed at the same time; more are passed through unreported. */
  maxInFlight: 100,
  /** Token bucket for messages: steady rate per second and burst size. */
  ratePerSecond: 50,
  burst: 200,
  /** A response body still being read after this long is reported without it. */
  bodyTimeoutMs: 30_000,
  maxDepth: 4,
  maxKeys: 50,
} as const;

/** Marks a window that already has the bridge (one per document, whatever injects it twice). */
const INSTALLED = typeof Symbol === 'function' ? Symbol.for('durbun.webviewBridge') : '__durbunWebViewBridge';

interface Body {
  encoding: 'utf8' | 'base64';
  data: string;
  size: number;
  truncated?: boolean;
}

interface Tracked {
  id: string;
  started: number;
  method: string;
}

interface Ctx {
  scope: any;
  stringify(value: unknown): string;
  send(message: Record<string, unknown>, free?: boolean): boolean;
  begin(api: 'fetch' | 'xhr', method: string, url: string, headers: string[][], body: Body | undefined): Tracked | null;
  end(tracked: Tracked): void;
  now(): number;
  clock(): number;
}

/** The channel the native side gave this document, or null when there is none (not attached). */
export function findChannel(scope: any): Post | null {
  try {
    const handler = scope.webkit && scope.webkit.messageHandlers && scope.webkit.messageHandlers.__durbun;
    if (handler && typeof handler.postMessage === 'function') return (json) => handler.postMessage(json);
  } catch {
    // fall through
  }
  try {
    const bridge = scope.__durbun;
    if (bridge && typeof bridge.post === 'function') return (json) => bridge.post(json);
  } catch {
    // fall through
  }
  return null;
}

/** Entry point of the injected script: installs the bridge when the native side gave this document a channel. */
export function bootstrap(scope: any): boolean {
  try {
    const post = findChannel(scope);
    return post ? installBridge(scope, post) : false;
  } catch {
    return false;
  }
}

/** Installs the wrappers once per window. Returns false when already installed or nothing could be wrapped. */
export function installBridge(scope: any, post: Post): boolean {
  if (!scope || scope[INSTALLED]) return false;
  try {
    Object.defineProperty(scope, INSTALLED, { value: true, enumerable: false, configurable: false, writable: false });
  } catch {
    return false;
  }
  // The originals, taken before any page script runs.
  const stringify: (value: unknown) => string = JSON.stringify.bind(JSON);
  const dateNow: () => number = Date.now.bind(Date);
  const perf = scope.performance && typeof scope.performance.now === 'function' ? scope.performance : null;
  const monotonic: () => number = perf ? () => perf.now() : dateNow;

  const prefix = 'w' + Math.floor(Math.random() * 0x7fffffff).toString(36) + '-';
  let seq = 0;
  let inFlight = 0;
  let tokens: number = LIMITS.burst;
  let refilled = monotonic();
  let dropped = 0;
  let busy = false;

  const take = (): boolean => {
    const t = monotonic();
    tokens = Math.min(LIMITS.burst, tokens + ((t - refilled) * LIMITS.ratePerSecond) / 1000);
    refilled = t;
    if (tokens < 1) {
      dropped++;
      return false;
    }
    tokens -= 1;
    return true;
  };

  const ctx: Ctx = {
    scope,
    stringify,
    now: monotonic,
    clock: dateNow,
    send(message, free) {
      if (busy) return false;
      busy = true;
      try {
        if (!free && !take()) return false;
        if (dropped > 0 && tokens >= 1) {
          tokens -= 1;
          post(stringify({ v: 1, t: 'dropped', count: dropped }));
          dropped = 0;
        }
        message.v = 1;
        post(stringify(message));
        return true;
      } catch {
        return false;
      } finally {
        busy = false;
      }
    },
    begin(api, method, url, headers, body) {
      if (inFlight >= LIMITS.maxInFlight) return null;
      const tracked: Tracked = { id: prefix + ++seq, started: monotonic(), method };
      const message: Record<string, unknown> = { t: 'req', id: tracked.id, api, ts: dateNow(), method, url, headers };
      if (body) message.body = body;
      if (!ctx.send(message)) return null;
      inFlight++;
      return tracked;
    },
    end() {
      if (inFlight > 0) inFlight--;
    },
  };

  let wrapped = false;
  wrapped = wrapFetch(ctx) || wrapped;
  wrapped = wrapXhr(ctx) || wrapped;
  wrapped = wrapConsole(ctx) || wrapped;
  watchErrors(ctx);
  return wrapped;
}

/* ───────────────────────── helpers ───────────────────────── */

/** Replaces `target[name]` keeping its property attributes; false when it cannot be replaced. */
function replace(target: any, name: string, make: (original: any) => any): boolean {
  try {
    const original = target[name];
    if (typeof original !== 'function') return false;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const replacement = make(original);
    if (descriptor && !descriptor.configurable && !descriptor.writable) return false;
    if (descriptor && 'value' in descriptor) {
      Object.defineProperty(target, name, {
        value: replacement,
        writable: descriptor.writable,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
      });
    } else {
      target[name] = replacement;
    }
    return true;
  } catch {
    return false;
  }
}

function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Absolute http(s) URL of a request, or null for other schemes (data:, blob:, about:, file: …). */
function absoluteUrl(scope: any, raw: string): string | null {
  let url = raw;
  try {
    const base = (scope.document && scope.document.baseURI) || (scope.location && scope.location.href) || undefined;
    url = new scope.URL(raw, base).href;
  } catch {
    // keep the raw value
  }
  if (!/^https?:/i.test(url)) return null;
  return cut(url, LIMITS.maxUrlChars);
}

function pushHeader(list: string[][], budget: { left: number }, name: unknown, value: unknown): void {
  if (list.length >= LIMITS.maxHeaders) return;
  const n = String(name);
  const v = String(value);
  if (n.length + v.length > budget.left) return;
  budget.left -= n.length + v.length;
  list.push([n, v]);
}

/** Header pairs from a Headers object, an array of pairs or a plain record. */
function headerPairs(source: any): string[][] {
  const list: string[][] = [];
  const budget = { left: LIMITS.maxHeaderChars };
  if (!source) return list;
  try {
    if (typeof source.forEach === 'function' && !Array.isArray(source)) {
      source.forEach((value: unknown, name: unknown) => pushHeader(list, budget, name, value));
    } else if (Array.isArray(source)) {
      for (const pair of source) if (pair && pair.length >= 2) pushHeader(list, budget, pair[0], pair[1]);
    } else if (typeof source === 'object') {
      for (const name of Object.keys(source)) pushHeader(list, budget, name, source[name]);
    }
  } catch {
    // partial list
  }
  return list;
}

function headerValue(headers: string[][], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const pair of headers) if (pair[0].toLowerCase() === lower) return pair[1];
  return undefined;
}

/** Same rule as the protocol's `isTextContentType`, kept short. */
function isText(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return (
    type.startsWith('text/') ||
    /[/+](json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|x-ndjson|yaml|csv)\b/.test(type)
  );
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function textBody(text: string, size?: number): Body {
  const truncated = text.length > LIMITS.maxBodyBytes;
  const data = truncated ? text.slice(0, LIMITS.maxBodyBytes) : text;
  const full = size !== undefined && size >= 0 ? size : utf8Length(text);
  const body: Body = { encoding: 'utf8', data, size: Math.max(full, utf8Length(data)) };
  if (truncated) body.truncated = true;
  return body;
}

function base64(scope: any, bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + 0x8000)));
  }
  return scope.btoa(binary);
}

function decodeUtf8(scope: any, bytes: Uint8Array): string | null {
  try {
    if (typeof scope.TextDecoder !== 'function') return null;
    return new scope.TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/** Kept bytes → body: text for text content types, base64 otherwise. */
function bytesBody(scope: any, kept: Uint8Array, size: number, truncated: boolean, contentType: string | undefined | null): Body {
  if (isText(contentType)) {
    const text = decodeUtf8(scope, kept);
    if (text !== null) {
      const body: Body = { encoding: 'utf8', data: text, size };
      if (truncated) body.truncated = true;
      return body;
    }
  }
  const body: Body = { encoding: 'base64', data: base64(scope, kept), size };
  if (truncated) body.truncated = true;
  return body;
}

function sizeOnly(size: number): Body | undefined {
  return size > 0 ? { encoding: 'utf8', data: '', size, truncated: true } : undefined;
}

/** A request body the page passed (fetch `init.body`, `xhr.send(body)`), read without side effects. */
function requestBody(scope: any, body: any, contentType: string | undefined): Body | undefined {
  try {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string') return textBody(body);
    if (typeof scope.URLSearchParams === 'function' && body instanceof scope.URLSearchParams) return textBody(String(body));
    if (typeof scope.Blob === 'function' && body instanceof scope.Blob) return sizeOnly(body.size);
    let bytes: Uint8Array | null = null;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
      bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (bytes) {
      const kept = bytes.length > LIMITS.maxBodyBytes ? bytes.subarray(0, LIMITS.maxBodyBytes) : bytes;
      return bytesBody(scope, kept, bytes.length, kept.length < bytes.length, contentType);
    }
    // FormData, ReadableStream, Document: not read (that would change or consume them).
    return undefined;
  } catch {
    return undefined;
  }
}

function errorText(error: any): string {
  try {
    if (error && typeof error === 'object') {
      const name = error.name ? String(error.name) : 'Error';
      return cut(error.message ? `${name}: ${String(error.message)}` : name, 1024);
    }
    return cut(String(error), 1024);
  } catch {
    return 'Error';
  }
}

/* ───────────────────────── fetch ───────────────────────── */

function wrapFetch(ctx: Ctx): boolean {
  const scope = ctx.scope;
  return replace(scope, 'fetch', (original) =>
    function fetch(this: unknown, input: any, init?: any) {
      let tracked: Tracked | null = null;
      let pendingBody: (() => void) | null = null;
      try {
        const RequestClass = scope.Request;
        const isRequest = typeof RequestClass === 'function' && input instanceof RequestClass;
        const rawUrl = isRequest ? input.url : input && typeof input === 'object' && 'href' in input ? input.href : String(input);
        const url = absoluteUrl(scope, String(rawUrl));
        if (url) {
          const method = String((init && init.method) || (isRequest ? input.method : 'GET')).toUpperCase();
          const headers = headerPairs(init && init.headers !== undefined ? init.headers : isRequest ? input.headers : undefined);
          let body: Body | undefined;
          if (init && init.body !== undefined) {
            body = requestBody(scope, init.body, headerValue(headers, 'content-type'));
          } else if (isRequest && input.body && !input.bodyUsed && method !== 'GET' && method !== 'HEAD') {
            // A Request carries its own body: read a clone of it before the original is sent.
            const copy = input.clone();
            const type = headerValue(headers, 'content-type');
            pendingBody = () => {
              readCapped(scope, copy).then(
                (read) => {
                  if (tracked && read) ctx.send({ t: 'reqbody', id: tracked.id, body: bytesBody(scope, read.kept, read.size, read.truncated, type) }, true);
                },
                () => undefined,
              );
            };
          }
          tracked = ctx.begin('fetch', method, url, headers, body);
          if (tracked && pendingBody) pendingBody();
        }
      } catch {
        tracked = null;
      }
      if (!tracked) {
        // eslint-disable-next-line prefer-rest-params
        return original.apply(this, arguments);
      }
      const record = tracked;
      let promise: any;
      try {
        // eslint-disable-next-line prefer-rest-params
        promise = original.apply(this, arguments);
      } catch (error) {
        ctx.send({ t: 'err', id: record.id, ts: ctx.clock(), error: errorText(error) }, true);
        ctx.end(record);
        throw error;
      }
      try {
        return promise.then(
          (response: any) => {
            try {
              onFetchResponse(ctx, record, response);
            } catch {
              ctx.end(record);
            }
            return response;
          },
          (error: any) => {
            try {
              const message: Record<string, unknown> = { t: 'err', id: record.id, ts: ctx.clock(), error: errorText(error) };
              if (error && error.name === 'AbortError') message.cancelled = true;
              ctx.send(message, true);
            } catch {
              // ignore
            }
            ctx.end(record);
            throw error;
          },
        );
      } catch {
        ctx.end(record);
        return promise;
      }
    },
  );
}

interface Read {
  kept: Uint8Array;
  size: number;
  truncated: boolean;
}

/** Reads at most `LIMITS.maxBodyBytes` of a cloned body, then cancels the clone (the page's body is untouched). */
function readCapped(scope: any, clone: any): Promise<Read | null> {
  const stream = clone && clone.body;
  if (!stream || typeof stream.getReader !== 'function') {
    if (!clone || typeof clone.arrayBuffer !== 'function') return Promise.resolve(null);
    return clone.arrayBuffer().then((buffer: ArrayBuffer) => {
      const all = new Uint8Array(buffer);
      const kept = all.length > LIMITS.maxBodyBytes ? all.subarray(0, LIMITS.maxBodyBytes) : all;
      return { kept, size: all.length, truncated: kept.length < all.length };
    });
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let size = 0;
  const finish = (complete: boolean): Read => {
    const out = new Uint8Array(kept);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return { kept: out, size, truncated: !complete };
  };
  const pump = (): Promise<Read> =>
    reader.read().then((step: { done: boolean; value?: Uint8Array }) => {
      if (step.done) return finish(true);
      const value = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value || []);
      size += value.length;
      if (kept < LIMITS.maxBodyBytes) {
        const part = value.subarray(0, LIMITS.maxBodyBytes - kept);
        chunks.push(part);
        kept += part.length;
      }
      if (size > LIMITS.maxBodyBytes) {
        try {
          reader.cancel().then(undefined, () => undefined);
        } catch {
          // ignore
        }
        return finish(false);
      }
      return pump();
    });
  return pump();
}

function onFetchResponse(ctx: Ctx, tracked: Tracked, response: any): void {
  const scope = ctx.scope;
  const headersAt = ctx.now();
  const headers = headerPairs(response && response.headers);
  const contentType = headerValue(headers, 'content-type');
  const lengthHeader = Number(headerValue(headers, 'content-length'));
  const declared = Number.isFinite(lengthHeader) && lengthHeader >= 0 ? lengthHeader : -1;
  const status = Number(response && response.status) || 0;
  let done = false;
  const report = (body: Body | undefined) => {
    if (done) return;
    done = true;
    const end = ctx.now();
    const message: Record<string, unknown> = {
      t: 'res',
      id: tracked.id,
      ts: ctx.clock(),
      status,
      statusText: cut(String((response && response.statusText) || ''), 256),
      headers,
      wait: Math.max(0, headersAt - tracked.started),
      receive: Math.max(0, end - headersAt),
    };
    if (body) message.body = body;
    ctx.send(message, true);
    ctx.end(tracked);
  };
  const streaming = !!contentType && /^text\/event-stream|^application\/(x-)?ndjson/i.test(contentType);
  const noBody =
    !response || !response.body || response.type === 'opaque' || tracked.method === 'HEAD' || status === 204 || status === 304;
  if (noBody || streaming || typeof response.clone !== 'function') {
    report(declared > 0 ? sizeOnly(declared) : undefined);
    return;
  }
  let clone: any;
  try {
    clone = response.clone();
  } catch {
    report(declared > 0 ? sizeOnly(declared) : undefined);
    return;
  }
  const timer = scope.setTimeout(() => report(declared > 0 ? sizeOnly(declared) : undefined), LIMITS.bodyTimeoutMs);
  readCapped(scope, clone).then(
    (read) => {
      scope.clearTimeout(timer);
      if (!read) return report(declared > 0 ? sizeOnly(declared) : undefined);
      const size = read.truncated && declared > read.size ? declared : read.size;
      report(read.size > 0 || read.kept.length > 0 ? bytesBody(scope, read.kept, size, read.truncated, contentType) : undefined);
    },
    () => {
      scope.clearTimeout(timer);
      report(declared > 0 ? sizeOnly(declared) : undefined);
    },
  );
}

/* ───────────────────────── XMLHttpRequest ───────────────────────── */

interface XhrState {
  method: string;
  url: string | null;
  headers: string[][];
  tracked: Tracked | null;
  headersAt: number;
  failure: '' | 'error' | 'abort' | 'timeout';
  listening: boolean;
}

function wrapXhr(ctx: Ctx): boolean {
  const scope = ctx.scope;
  const Xhr = scope.XMLHttpRequest;
  if (typeof Xhr !== 'function' || !Xhr.prototype) return false;
  const proto = Xhr.prototype;
  const states: WeakMap<object, XhrState> = new WeakMap();

  const opened = replace(proto, 'open', (original) =>
    function open(this: any, method: unknown, url: unknown) {
      try {
        const previous = states.get(this);
        if (previous && previous.tracked) {
          // open() on a request in flight ends it without events.
          ctx.send({ t: 'err', id: previous.tracked.id, ts: ctx.clock(), error: 'AbortError', cancelled: true }, true);
          ctx.end(previous.tracked);
        }
        states.set(this, {
          method: String(method).toUpperCase(),
          url: absoluteUrl(scope, String(url)),
          headers: [],
          tracked: null,
          headersAt: 0,
          failure: '',
          listening: previous ? previous.listening : false,
        });
      } catch {
        // ignore
      }
      // eslint-disable-next-line prefer-rest-params
      return original.apply(this, arguments);
    },
  );
  replace(proto, 'setRequestHeader', (original) =>
    function setRequestHeader(this: any, name: unknown, value: unknown) {
      // eslint-disable-next-line prefer-rest-params
      const result = original.apply(this, arguments);
      try {
        const state = states.get(this);
        if (state && !state.tracked) {
          const existing = state.headers.find((pair) => pair[0].toLowerCase() === String(name).toLowerCase());
          if (existing) existing[1] = `${existing[1]}, ${String(value)}`;
          else pushHeader(state.headers, { left: LIMITS.maxHeaderChars }, name, value);
        }
      } catch {
        // ignore
      }
      return result;
    },
  );
  replace(proto, 'send', (original) =>
    function send(this: any, body?: unknown) {
      let state: XhrState | undefined;
      try {
        state = states.get(this);
        if (state && state.url && !state.tracked) {
          state.failure = '';
          state.headersAt = 0;
          if (!state.listening) {
            state.listening = true;
            listen(ctx, this, states);
          }
          const sent = state.method === 'GET' || state.method === 'HEAD' ? undefined : requestBody(scope, body, headerValue(state.headers, 'content-type'));
          state.tracked = ctx.begin('xhr', state.method, state.url, state.headers, sent);
        }
      } catch {
        // ignore
      }
      try {
        // eslint-disable-next-line prefer-rest-params
        return original.apply(this, arguments);
      } catch (error) {
        const tracked = state && state.tracked;
        if (state && tracked) {
          state.tracked = null;
          ctx.send({ t: 'err', id: tracked.id, ts: ctx.clock(), error: errorText(error) }, true);
          ctx.end(tracked);
        }
        throw error;
      }
    },
  );
  return opened;
}

function listen(ctx: Ctx, xhr: any, states: WeakMap<object, XhrState>): void {
  const scope = ctx.scope;
  xhr.addEventListener('readystatechange', () => {
    try {
      const state = states.get(xhr);
      if (state && state.tracked && !state.headersAt && xhr.readyState >= 2) state.headersAt = ctx.now();
    } catch {
      // ignore
    }
  });
  for (const kind of ['error', 'abort', 'timeout'] as const) {
    xhr.addEventListener(kind, () => {
      const state = states.get(xhr);
      if (state && state.tracked) state.failure = kind;
    });
  }
  xhr.addEventListener('loadend', () => {
    const state = states.get(xhr);
    if (!state || !state.tracked) return;
    const tracked = state.tracked;
    state.tracked = null;
    try {
      if (state.failure) {
        const message: Record<string, unknown> = {
          t: 'err',
          id: tracked.id,
          ts: ctx.clock(),
          error: state.failure === 'timeout' ? 'Timeout' : state.failure === 'abort' ? 'AbortError' : 'Network error',
        };
        if (state.failure === 'abort') message.cancelled = true;
        ctx.send(message, true);
        return;
      }
      const end = ctx.now();
      const headersAt = state.headersAt || end;
      const headers = parseRawHeaders(String(xhr.getAllResponseHeaders() || ''));
      const message: Record<string, unknown> = {
        t: 'res',
        id: tracked.id,
        ts: ctx.clock(),
        status: Number(xhr.status) || 0,
        statusText: cut(String(xhr.statusText || ''), 256),
        headers,
        wait: Math.max(0, headersAt - tracked.started),
        receive: Math.max(0, end - headersAt),
      };
      const body = xhrBody(ctx, xhr, headers, tracked.method);
      if (body) message.body = body;
      ctx.send(message, true);
    } catch {
      // ignore
    } finally {
      ctx.end(tracked);
    }
  });
}

function parseRawHeaders(raw: string): string[][] {
  const list: string[][] = [];
  const budget = { left: LIMITS.maxHeaderChars };
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) pushHeader(list, budget, line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return list;
}

function xhrBody(ctx: Ctx, xhr: any, headers: string[][], method: string): Body | undefined {
  const scope = ctx.scope;
  if (method === 'HEAD') return undefined;
  const lengthHeader = Number(headerValue(headers, 'content-length'));
  const declared = Number.isFinite(lengthHeader) && lengthHeader >= 0 ? lengthHeader : undefined;
  const type = xhr.responseType || '';
  if (type === '' || type === 'text') {
    const text = String(xhr.responseText || '');
    return text.length ? textBody(text, declared) : undefined;
  }
  if (type === 'json') {
    if (xhr.response === null || xhr.response === undefined) return undefined;
    return textBody(ctx.stringify(xhr.response), declared);
  }
  if (type === 'arraybuffer' && xhr.response) {
    const all = new Uint8Array(xhr.response);
    const kept = all.length > LIMITS.maxBodyBytes ? all.subarray(0, LIMITS.maxBodyBytes) : all;
    return bytesBody(scope, kept, all.length, kept.length < all.length, headerValue(headers, 'content-type'));
  }
  if (type === 'blob' && xhr.response) return sizeOnly(Number(xhr.response.size) || 0);
  return declared ? sizeOnly(declared) : undefined;
}

/* ───────────────────────── console and errors ───────────────────────── */

const CONSOLE_LEVELS: Array<[string, 'debug' | 'info' | 'warn' | 'error']> = [
  ['debug', 'debug'],
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
];

function describe(value: unknown, stringify: (v: unknown) => string): string {
  try {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined || typeof value !== 'object') {
      return typeof value === 'function' ? `function ${(value as { name?: string }).name || ''}`.trim() : String(value);
    }
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    const node = value as { nodeType?: number; tagName?: string };
    if (node.nodeType === 1 && node.tagName) return `<${String(node.tagName).toLowerCase()}>`;
    return stringify(safeCopy(value, 0, []));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** A JSON-safe copy: depth, key and item counts capped, cycles and functions described. */
function safeCopy(value: unknown, depth: number, seen: unknown[]): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (seen.indexOf(value) >= 0) return '[circular]';
  if (depth >= LIMITS.maxDepth) return Array.isArray(value) ? '[array]' : '[object]';
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  seen.push(value);
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, LIMITS.maxKeys).map((item) => safeCopy(item, depth + 1, seen));
      if (value.length > LIMITS.maxKeys) out.push(`… ${value.length - LIMITS.maxKeys} more`);
      return out;
    }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as object);
    for (const key of keys.slice(0, LIMITS.maxKeys)) out[key] = safeCopy((value as Record<string, unknown>)[key], depth + 1, seen);
    if (keys.length > LIMITS.maxKeys) out['…'] = `${keys.length - LIMITS.maxKeys} more keys`;
    return out;
  } finally {
    seen.pop();
  }
}

/** `console.log('%s has %d items', a, b)` → one line; `%c` (CSS) arguments are dropped. */
export function formatConsole(args: unknown[], stringify: (v: unknown) => string = JSON.stringify): string {
  const rest = args.slice();
  let head = '';
  if (typeof rest[0] === 'string' && /%[sdifoOc%]/.test(rest[0] as string)) {
    const format = rest.shift() as string;
    head = format.replace(/%([sdifoOc%])/g, (match, kind: string) => {
      if (kind === '%') return '%';
      if (!rest.length) return match;
      const arg = rest.shift();
      if (kind === 'c') return '';
      if (kind === 'd' || kind === 'i') return String(parseInt(String(arg), 10));
      if (kind === 'f') return String(parseFloat(String(arg)));
      return describe(arg, stringify);
    });
  }
  const parts = rest.map((arg) => describe(arg, stringify));
  if (head) parts.unshift(head);
  return parts.join(' ');
}

function errorInfo(error: unknown): Record<string, string> | undefined {
  if (!(error instanceof Error)) return undefined;
  const info: Record<string, string> = { type: cut(String(error.name || 'Error'), 256), message: cut(String(error.message || ''), 4096) };
  if (error.stack) info.stack = cut(String(error.stack), 32 * 1024);
  return info;
}

function pageUrl(scope: any): string {
  try {
    return cut(String(scope.location && scope.location.href), 2048);
  } catch {
    return '';
  }
}

function sendLog(ctx: Ctx, level: string, message: string, error?: Record<string, string>): void {
  const entry: Record<string, unknown> = {
    t: 'log',
    ts: ctx.clock(),
    level,
    message: cut(message, LIMITS.maxConsoleChars),
    page: pageUrl(ctx.scope),
  };
  if (error) entry.error = error;
  ctx.send(entry);
}

function wrapConsole(ctx: Ctx): boolean {
  const target = ctx.scope.console;
  if (!target || typeof target !== 'object') return false;
  let wrappedAny = false;
  for (const [method, level] of CONSOLE_LEVELS) {
    wrappedAny =
      replace(target, method, (original) =>
        function durbunConsole(this: unknown, ...args: unknown[]) {
          try {
            const error = args.find((arg) => arg instanceof Error);
            // An Error argument reads `Name: message` in the line; its stack goes along as the line's error.
            sendLog(ctx, level, formatConsole(args, ctx.stringify), errorInfo(error));
          } catch {
            // never let capture break logging
          }
          return original.apply(this, args);
        },
      ) || wrappedAny;
  }
  return wrappedAny;
}

function watchErrors(ctx: Ctx): void {
  const scope = ctx.scope;
  if (typeof scope.addEventListener !== 'function') return;
  try {
    scope.addEventListener('error', (event: any) => {
      try {
        // Resource load errors (an <img> that failed) are plain events without a message.
        if (!event || typeof event.message !== 'string') return;
        const where = event.filename ? ` (${event.filename}:${event.lineno || 0}:${event.colno || 0})` : '';
        sendLog(ctx, 'error', `Uncaught ${event.message}${where}`, errorInfo(event.error));
      } catch {
        // ignore
      }
    });
    scope.addEventListener('unhandledrejection', (event: any) => {
      try {
        const reason = event ? event.reason : undefined;
        sendLog(ctx, 'error', `Unhandled promise rejection: ${describe(reason, ctx.stringify)}`, errorInfo(reason));
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}
