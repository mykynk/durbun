/**
 * Minimal XMLHttpRequest implementations on top of node:http, used to exercise the XHR patch:
 *  - `DomXHR`: browser-like — state behind prototype getters, extends EventTarget, real Event objects.
 *  - `RnXHR`: React-Native-like — public instance fields (readyState/status), `_response` holding the
 *    native error text, an event-target-shim style registry dispatching plain `{ type }` objects.
 * Plus `createXhrFetch`: a whatwg-fetch style fetch that creates its XHR synchronously.
 */
import http from 'node:http';

const UNSENT = 0;
const OPENED = 1;
const HEADERS_RECEIVED = 2;
const LOADING = 3;
const DONE = 4;

interface Callbacks {
  response(status: number, statusText: string, rawHeaders: string): void;
  data(chunk: Buffer): void;
  end(body: Buffer): void;
  error(err: Error): void;
  timeout(): void;
}

async function toBuffer(body: unknown): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  return Buffer.from(String(body), 'utf8');
}

function perform(method: string, url: string, headers: Array<[string, string]>, body: unknown, timeoutMs: number, cb: Callbacks): () => void {
  let aborted = false;
  let timedOut = false;
  let req: http.ClientRequest | undefined;
  void toBuffer(body).then((buf) => {
    if (aborted) return;
    const u = new URL(url);
    const hdrs: Record<string, string | string[]> = {};
    for (const [k, v] of headers) {
      const prev = hdrs[k];
      hdrs[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: hdrs });
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        timedOut = true;
        req?.destroy(new Error('timeout'));
      });
    }
    req.on('response', (res) => {
      const lines: string[] = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i].toLowerCase()}: ${res.rawHeaders[i + 1]}`);
      cb.response(res.statusCode || 0, res.statusMessage || '', lines.length ? lines.join('\r\n') + '\r\n' : '');
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        cb.data(c);
      });
      res.on('end', () => {
        if (!aborted) cb.end(Buffer.concat(chunks));
      });
      res.on('error', (e) => {
        if (!aborted) cb.error(e);
      });
    });
    req.on('error', (e) => {
      if (aborted) return;
      if (timedOut) cb.timeout();
      else cb.error(e);
    });
    if (buf) req.write(buf);
    req.end();
  });
  return () => {
    aborted = true;
    req?.destroy();
  };
}

function decodeResponse(type: string, body: Buffer, contentType: string | undefined): unknown {
  switch (type) {
    case 'json':
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        return null;
      }
    case 'arraybuffer':
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    case 'blob':
      return new Blob([new Uint8Array(body)], contentType ? { type: contentType } : undefined);
    default:
      return body.toString('utf8');
  }
}

function headerFrom(raw: string, name: string): string | null {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).toLowerCase() === lower) values.push(line.slice(i + 1).trim());
  }
  return values.length ? values.join(', ') : null;
}

/* ────────────────────────────── browser-like ────────────────────────────── */

export class DomXHR extends EventTarget {
  static UNSENT = UNSENT;
  static OPENED = OPENED;
  static HEADERS_RECEIVED = HEADERS_RECEIVED;
  static LOADING = LOADING;
  static DONE = DONE;
  readonly UNSENT = UNSENT;
  readonly OPENED = OPENED;
  readonly HEADERS_RECEIVED = HEADERS_RECEIVED;
  readonly LOADING = LOADING;
  readonly DONE = DONE;

  responseType = '';
  timeout = 0;
  withCredentials = false;
  upload = new EventTarget();
  onreadystatechange: ((ev: Event) => void) | null = null;
  onloadstart: ((ev: Event) => void) | null = null;
  onprogress: ((ev: Event) => void) | null = null;
  onload: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onabort: ((ev: Event) => void) | null = null;
  ontimeout: ((ev: Event) => void) | null = null;
  onloadend: ((ev: Event) => void) | null = null;

  #state = UNSENT;
  #status = 0;
  #statusText = '';
  #url = '';
  #method = 'GET';
  #headers: Array<[string, string]> = [];
  #raw = '';
  #text = '';
  #response: unknown = null;
  #sent = false;
  #cancel: (() => void) | undefined;

  get readyState(): number {
    return this.#state;
  }
  get status(): number {
    return this.#status;
  }
  get statusText(): string {
    return this.#statusText;
  }
  get responseURL(): string {
    return this.#state >= HEADERS_RECEIVED ? this.#url : '';
  }
  get responseText(): string {
    if (this.responseType !== '' && this.responseType !== 'text') {
      throw new DOMException("The value is only accessible if the object's 'responseType' is '' or 'text'", 'InvalidStateError');
    }
    return this.#text;
  }
  get response(): unknown {
    if (this.responseType === '' || this.responseType === 'text') return this.#text;
    return this.#state === DONE ? this.#response : null;
  }
  get responseXML(): null {
    return null;
  }

  override dispatchEvent(ev: Event): boolean {
    const result = super.dispatchEvent(ev);
    const handler = (this as unknown as Record<string, unknown>)['on' + ev.type];
    if (typeof handler === 'function') handler.call(this, ev);
    return result;
  }

  #fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  #setState(state: number): void {
    this.#state = state;
    this.#fire('readystatechange');
  }

  open(method: string, url: string): void {
    this.#cancel?.();
    this.#method = method;
    this.#url = url;
    this.#headers = [];
    this.#sent = false;
    this.#status = 0;
    this.#statusText = '';
    this.#raw = '';
    this.#text = '';
    this.#response = null;
    this.#setState(OPENED);
  }

  setRequestHeader(name: string, value: string): void {
    if (this.#state !== OPENED || this.#sent) throw new DOMException('Invalid state', 'InvalidStateError');
    this.#headers.push([name, value]);
  }

  getAllResponseHeaders(): string {
    return this.#state >= HEADERS_RECEIVED ? this.#raw : '';
  }

  getResponseHeader(name: string): string | null {
    return this.#state >= HEADERS_RECEIVED ? headerFrom(this.#raw, name) : null;
  }

  overrideMimeType(): void {}

  send(body?: unknown): void {
    if (this.#state !== OPENED || this.#sent) throw new DOMException("The object's state must be OPENED.", 'InvalidStateError');
    this.#sent = true;
    this.#fire('loadstart');
    let contentType: string | undefined;
    this.#cancel = perform(this.#method, this.#url, this.#headers, body, this.timeout, {
      response: (status, statusText, raw) => {
        this.#status = status;
        this.#statusText = statusText;
        this.#raw = raw;
        contentType = headerFrom(raw, 'content-type') ?? undefined;
        this.#setState(HEADERS_RECEIVED);
      },
      data: () => {
        if (this.#state !== LOADING) this.#setState(LOADING);
      },
      end: (buf) => {
        if (this.responseType === '' || this.responseType === 'text') this.#text = buf.toString('utf8');
        else this.#response = decodeResponse(this.responseType, buf, contentType);
        this.#setState(DONE);
        this.#fire('load');
        this.#fire('loadend');
      },
      error: () => this.#fail('error'),
      timeout: () => this.#fail('timeout'),
    });
  }

  #fail(type: 'error' | 'timeout' | 'abort'): void {
    this.#status = 0;
    this.#raw = '';
    this.#setState(DONE);
    this.#fire(type);
    this.#fire('loadend');
  }

  abort(): void {
    const inFlight = (this.#state === OPENED && this.#sent) || this.#state === HEADERS_RECEIVED || this.#state === LOADING;
    this.#cancel?.();
    this.#cancel = undefined;
    if (inFlight) this.#fail('abort');
    if (this.#state === DONE) this.#state = UNSENT;
  }
}

/* ────────────────────────────── React-Native-like ────────────────────────────── */

type Listener = (ev: any) => void;

export class RnXHR {
  static UNSENT = UNSENT;
  static OPENED = OPENED;
  static HEADERS_RECEIVED = HEADERS_RECEIVED;
  static LOADING = LOADING;
  static DONE = DONE;
  UNSENT = UNSENT;
  OPENED = OPENED;
  HEADERS_RECEIVED = HEADERS_RECEIVED;
  LOADING = LOADING;
  DONE = DONE;

  // Public fields like RN's implementation.
  readyState = UNSENT;
  status = 0;
  timeout = 0;
  responseURL: string | null = null;
  withCredentials = true;
  responseHeaders: string | undefined;
  upload = {};
  _response: unknown = '';
  _responseType = '';
  _method = 'GET';
  _url = '';
  _headers: Array<[string, string]> = [];
  _sent = false;
  _aborted = false;
  _listeners: Record<string, Listener[]> = {};
  _cancel: (() => void) | undefined;
  _contentType: string | undefined;

  onreadystatechange: Listener | null = null;
  onload: Listener | null = null;
  onerror: Listener | null = null;
  onabort: Listener | null = null;
  ontimeout: Listener | null = null;
  onloadend: Listener | null = null;
  onloadstart: Listener | null = null;
  onprogress: Listener | null = null;

  get responseType(): string {
    return this._responseType;
  }
  set responseType(value: string) {
    this._responseType = value;
  }

  get responseText(): string {
    if (this._responseType !== '' && this._responseType !== 'text') {
      throw new Error(`The 'responseText' property is only available if 'responseType' is set to '' or 'text', but it is '${this._responseType}'.`);
    }
    return typeof this._response === 'string' ? this._response : '';
  }

  get response(): unknown {
    if (this._responseType === '' || this._responseType === 'text') return this.readyState < LOADING ? '' : this._response;
    if (this.readyState !== DONE) return null;
    if (this._response instanceof Buffer) return decodeResponse(this._responseType, this._response, this._contentType);
    return null;
  }

  addEventListener(type: string, fn: Listener): void {
    (this._listeners[type] ||= []).push(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this._listeners[type] = (this._listeners[type] || []).filter((l) => l !== fn);
  }

  /** event-target-shim style: any object with a string `type`; listener errors are logged, not thrown. */
  dispatchEvent(event: { type: string }): boolean {
    if (!event || typeof event.type !== 'string') throw new TypeError('"event.type" should be a string.');
    for (const l of (this._listeners[event.type] || []).slice()) {
      try {
        l.call(this, event);
      } catch (e) {
        console.error(e);
      }
    }
    const handler = (this as unknown as Record<string, unknown>)['on' + event.type];
    if (typeof handler === 'function') {
      try {
        handler.call(this, event);
      } catch (e) {
        console.error(e);
      }
    }
    return true;
  }

  setReadyState(state: number): void {
    this.readyState = state;
    this.dispatchEvent({ type: 'readystatechange' });
  }

  open(method: string, url: string): void {
    if (this.readyState !== UNSENT) throw new Error('Cannot open, already sending');
    this._method = method;
    this._url = url;
    this._aborted = false;
    this.setReadyState(OPENED);
  }

  setRequestHeader(name: string, value: string): void {
    if (this.readyState !== OPENED) throw new Error('Request has not been opened');
    this._headers.push([name, String(value)]);
  }

  getAllResponseHeaders(): string | null {
    return this.responseHeaders === undefined ? null : this.responseHeaders;
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders === undefined ? null : headerFrom(this.responseHeaders, name);
  }

  send(body?: unknown): void {
    if (this.readyState !== OPENED) throw new Error('Request has not been opened');
    if (this._sent) throw new Error('Request has already been sent');
    this._sent = true;
    this._cancel = perform(this._method, this._url, this._headers, body, this.timeout, {
      response: (status, _text, raw) => {
        this.status = status;
        this.responseHeaders = raw;
        this.responseURL = this._url;
        this._contentType = headerFrom(raw, 'content-type') ?? undefined;
        this.setReadyState(HEADERS_RECEIVED);
      },
      data: () => {
        if (this.readyState !== LOADING) this.setReadyState(LOADING);
      },
      end: (buf) => {
        this._response = this._responseType === '' || this._responseType === 'text' ? buf.toString('utf8') : buf;
        this.finish(undefined);
      },
      error: (err) => {
        this._response = `Could not connect: ${err.message}`;
        this.finish('error');
      },
      timeout: () => {
        this._response = 'timeout';
        this.finish('timeout');
      },
    });
  }

  finish(kind: 'error' | 'timeout' | 'abort' | undefined): void {
    this.setReadyState(DONE);
    this.dispatchEvent({ type: kind ?? 'load' });
    this.dispatchEvent({ type: 'loadend' });
  }

  abort(): void {
    this._aborted = true;
    this._cancel?.();
    this._cancel = undefined;
    if (!(this.readyState === UNSENT || (this.readyState === OPENED && !this._sent) || this.readyState === DONE)) {
      this.status = 0;
      this.finish('abort');
    }
    this.readyState = UNSENT;
  }
}

/* ────────────────────────────── whatwg-fetch style fetch on XHR ────────────────────────────── */

export interface MiniResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Reads the global XMLHttpRequest at call time and creates it synchronously (like whatwg-fetch). */
export function createXhrFetch(polyfillFlag: boolean): (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<MiniResponse> {
  const fetchFn = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<MiniResponse>((resolve, reject) => {
      const XHR = (globalThis as any).XMLHttpRequest;
      const xhr = new XHR();
      xhr.onload = () => {
        const text = xhr.responseText as string;
        resolve({
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 300,
          headers: { get: (n: string) => xhr.getResponseHeader(n) },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      };
      xhr.onerror = () => setTimeout(() => reject(new TypeError('Network request failed')), 0);
      xhr.ontimeout = () => setTimeout(() => reject(new TypeError('Network request timed out')), 0);
      xhr.onabort = () => setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 0);
      xhr.open(init.method || 'GET', url, true);
      for (const [k, v] of Object.entries(init.headers || {})) xhr.setRequestHeader(k, v);
      xhr.send(init.body ?? null);
    });
  if (polyfillFlag) (fetchFn as any).polyfill = true;
  return fetchFn;
}
