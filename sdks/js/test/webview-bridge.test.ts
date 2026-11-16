/**
 * The web view bridge (webview/bridge.ts) against a fake page: Node's own fetch classes (Response, Request,
 * Headers), a scripted XMLHttpRequest and a recording console. Every wrapper must leave the page's behaviour
 * unchanged and report what the native side expects.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LIMITS, bootstrap, findChannel, formatConsole, installBridge } from '../webview/bridge.js';
import { bundleBridge } from '../scripts/gen-webview-bridge.mjs';

type Message = Record<string, any>;

interface FakeXhr {
  method?: string;
  url?: string;
  readyState: number;
  status: number;
  statusText: string;
  responseType: string;
  response: unknown;
  responseText: string;
  sentBody: unknown;
  requestHeaders: string[][];
  respond(status: number, headers: string, text: string): void;
  fail(kind: 'error' | 'abort' | 'timeout'): void;
}

function makeXhrClass() {
  const instances: FakeXhr[] = [];
  class Xhr {
    readyState = 0;
    status = 0;
    statusText = '';
    responseType = '';
    response: unknown = null;
    responseText = '';
    sentBody: unknown;
    requestHeaders: string[][] = [];
    method?: string;
    url?: string;
    private listeners: Record<string, Array<(e: unknown) => void>> = {};
    private rawHeaders = '';

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }
    setRequestHeader(name: string, value: string) {
      if (this.readyState !== 1) throw new Error('InvalidStateError');
      this.requestHeaders.push([name, value]);
    }
    send(body?: unknown) {
      if (this.readyState !== 1) throw new Error('InvalidStateError: not opened');
      this.sentBody = body;
      instances.push(this as unknown as FakeXhr);
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
      (this.listeners[type] ||= []).push(fn);
    }
    getAllResponseHeaders() {
      return this.rawHeaders;
    }
    private emit(type: string) {
      for (const fn of this.listeners[type] || []) fn({ type });
    }
    respond(status: number, headers: string, text: string) {
      this.readyState = 2;
      this.rawHeaders = headers;
      this.emit('readystatechange');
      this.status = status;
      this.statusText = status === 200 ? 'OK' : 'Not Found';
      this.responseText = text;
      this.response = text;
      this.readyState = 4;
      this.emit('readystatechange');
      this.emit('load');
      this.emit('loadend');
    }
    fail(kind: 'error' | 'abort' | 'timeout') {
      this.readyState = 4;
      this.emit('readystatechange');
      this.emit(kind);
      this.emit('loadend');
    }
  }
  return { Xhr, instances };
}

interface PageOptions {
  fetch?: (input: unknown, init?: unknown) => Promise<Response>;
  post?: (json: string) => void;
}

/** A fake page window with the bridge installed; `messages` are what reached the native side. */
function page(options: PageOptions = {}) {
  const messages: Message[] = [];
  const consoleCalls: Array<{ method: string; self: unknown; args: unknown[] }> = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  let clock = 1_000;
  const { Xhr, instances } = makeXhrClass();
  const fetchCalls: Array<{ self: unknown; args: unknown[] }> = [];
  const fetchImpl = options.fetch ?? (async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  const consoleObject: Record<string, unknown> = {};
  for (const method of ['debug', 'log', 'info', 'warn', 'error']) {
    consoleObject[method] = function (this: unknown, ...args: unknown[]) {
      consoleCalls.push({ method, self: this, args });
      return `returned-${method}`;
    };
  }
  const scope: any = {
    location: { href: 'https://shop.example.com/cart?step=2' },
    document: { baseURI: 'https://shop.example.com/cart?step=2' },
    URL,
    Request,
    Headers,
    Blob,
    URLSearchParams,
    TextDecoder,
    btoa,
    setTimeout,
    clearTimeout,
    performance: { now: () => clock },
    console: consoleObject,
    XMLHttpRequest: Xhr,
    fetch: function (this: unknown, ...args: unknown[]) {
      fetchCalls.push({ self: this, args });
      return fetchImpl(args[0], args[1]);
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type: string, event: unknown) {
      for (const fn of listeners[type] || []) fn(event);
    },
    __durbun: {
      post:
        options.post ??
        ((json: string) => {
          messages.push(JSON.parse(json));
        }),
    },
  };
  const installed = bootstrap(scope);
  return {
    scope,
    installed,
    messages,
    consoleCalls,
    fetchCalls,
    xhrs: instances,
    advance(ms: number) {
      clock += ms;
    },
    of(t: string) {
      return messages.filter((m) => m.t === t);
    },
  };
}

describe('channel and install', () => {
  it('finds the iOS message handler and the Android interface, and nothing else', () => {
    const ios = { webkit: { messageHandlers: { __durbun: { postMessage: vi.fn() } } } };
    findChannel(ios)?.('{"a":1}');
    expect(ios.webkit.messageHandlers.__durbun.postMessage).toHaveBeenCalledWith('{"a":1}');
    const android = { __durbun: { post: vi.fn() } };
    findChannel(android)?.('x');
    expect(android.__durbun.post).toHaveBeenCalledWith('x');
    expect(findChannel({})).toBeNull();
    expect(bootstrap({ fetch: () => undefined })).toBe(false);
  });

  it('installs once per window and leaves no enumerable trace', () => {
    const p = page();
    expect(p.installed).toBe(true);
    expect(installBridge(p.scope, () => undefined)).toBe(false);
    expect(Object.keys(p.scope)).not.toContain('__durbunWebViewBridge');
  });

  it('keeps the attributes of the properties it wraps', () => {
    const p = page();
    const descriptor = Object.getOwnPropertyDescriptor(p.scope.XMLHttpRequest.prototype, 'send');
    expect(descriptor).toMatchObject({ writable: true, enumerable: false, configurable: true });
  });
});

describe('fetch', () => {
  it('reports a GET with headers, a JSON body and timings, and the page gets the same response', async () => {
    const response = new Response('{"items":[1,2,3]}', { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'x-trace': 't1' } });
    const p = page({ fetch: async () => response });
    const self = { marker: true };
    const got = await p.scope.fetch.call(self, '/api/items?page=1', { headers: { Accept: 'application/json' } });
    expect(got).toBe(response);
    expect(p.fetchCalls[0].self).toBe(self);
    expect(p.fetchCalls[0].args).toEqual(['/api/items?page=1', { headers: { Accept: 'application/json' } }]);
    expect(await got.json()).toEqual({ items: [1, 2, 3] }); // the page's body is untouched
    await vi.waitFor(() => expect(p.of('res')).toHaveLength(1));
    const [req] = p.of('req');
    expect(req).toMatchObject({
      v: 1,
      api: 'fetch',
      method: 'GET',
      url: 'https://shop.example.com/api/items?page=1',
      headers: [['Accept', 'application/json']],
    });
    expect(req.body).toBeUndefined();
    const [res] = p.of('res');
    expect(res).toMatchObject({ id: req.id, status: 200, statusText: 'OK', body: { encoding: 'utf8', data: '{"items":[1,2,3]}', size: 17 } });
    expect(res.headers).toEqual(expect.arrayContaining([['content-type', 'application/json'], ['x-trace', 't1']]));
    expect(res.wait).toBeGreaterThanOrEqual(0);
    expect(res.receive).toBeGreaterThanOrEqual(0);
  });

  it('reports a string request body and the method from init', async () => {
    const p = page();
    await p.scope.fetch('https://api.example.com/orders', {
      method: 'post',
      headers: [['Content-Type', 'application/json']],
      body: '{"sku":"A-1","qty":2}',
    });
    const [req] = p.of('req');
    expect(req).toMatchObject({ method: 'POST', url: 'https://api.example.com/orders', body: { encoding: 'utf8', data: '{"sku":"A-1","qty":2}', size: 21 } });
  });

  it('reads a Request object body from a clone and reports it afterwards', async () => {
    const p = page({
      fetch: async (input) => {
        // The page's own request still has its body.
        expect(await (input as Request).text()).toBe('name=Ada');
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    const request = new Request('https://api.example.com/form', {
      method: 'PUT',
      body: 'name=Ada',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    await p.scope.fetch(request);
    await vi.waitFor(() => expect(p.of('reqbody')).toHaveLength(1));
    const [req] = p.of('req');
    expect(req).toMatchObject({ method: 'PUT', url: 'https://api.example.com/form' });
    expect(p.of('reqbody')[0]).toMatchObject({ id: req.id, body: { encoding: 'utf8', data: 'name=Ada', size: 8 } });
  });

  it('cuts large binary bodies, while the page still reads every byte', async () => {
    const big = new Uint8Array(LIMITS.maxBodyBytes * 3).map((_, i) => i % 251);
    const p = page({ fetch: async () => new Response(big, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(big.length) } }) });
    const got = await p.scope.fetch('https://cdn.example.com/blob.bin');
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(bytes.length).toBe(big.length);
    expect(bytes[bytes.length - 1]).toBe(big[big.length - 1]);
    await vi.waitFor(() => expect(p.of('res')).toHaveLength(1));
    const body = p.of('res')[0].body;
    expect(body).toMatchObject({ encoding: 'base64', size: big.length, truncated: true });
    expect(Buffer.from(body.data, 'base64').length).toBe(LIMITS.maxBodyBytes);
  });

  it('reports failures and keeps the page’s rejection', async () => {
    const failure = new TypeError('Failed to fetch');
    const p = page({ fetch: async () => Promise.reject(failure) });
    await expect(p.scope.fetch('https://down.example.com/')).rejects.toBe(failure);
    expect(p.of('err')[0]).toMatchObject({ error: 'TypeError: Failed to fetch', id: p.of('req')[0].id });
    expect(p.of('err')[0].cancelled).toBeUndefined();
  });

  it('marks aborted requests as cancelled', async () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    const p = page({ fetch: async () => Promise.reject(abort) });
    await expect(p.scope.fetch('https://api.example.com/slow')).rejects.toBe(abort);
    expect(p.of('err')[0]).toMatchObject({ cancelled: true });
  });

  it('passes a synchronous throw through and ends the entry', () => {
    const p = page({
      fetch: () => {
        throw new TypeError('Illegal invocation');
      },
    });
    expect(() => p.scope.fetch('https://api.example.com/x')).toThrow('Illegal invocation');
    expect(p.of('err')[0]).toMatchObject({ error: 'TypeError: Illegal invocation' });
  });

  it('reports an event stream at its headers without reading it', async () => {
    const encoder = new TextEncoder();
    let push: ((text: string) => void) | undefined;
    let close: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
        close = () => controller.close();
      },
    });
    const p = page({ fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
    const got = await p.scope.fetch('https://api.example.com/events');
    await vi.waitFor(() => expect(p.of('res')).toHaveLength(1));
    expect(p.of('res')[0].body).toBeUndefined();
    push?.('data: one\n\n');
    close?.();
    expect(await got.text()).toBe('data: one\n\n');
  });

  it('leaves other schemes alone', async () => {
    const p = page();
    await p.scope.fetch('data:text/plain,hello');
    expect(p.fetchCalls).toHaveLength(1);
    expect(p.of('req')).toHaveLength(0);
  });

  it('follows at most maxInFlight requests at once and still runs the rest', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = page({ fetch: async () => gate.then(() => new Response('')) });
    p.advance(60_000); // a full token bucket
    const calls = Array.from({ length: LIMITS.maxInFlight + 20 }, (_, i) => p.scope.fetch(`https://api.example.com/${i}`));
    expect(p.fetchCalls).toHaveLength(LIMITS.maxInFlight + 20);
    expect(p.of('req')).toHaveLength(LIMITS.maxInFlight);
    release?.();
    await Promise.all(calls);
  });

  it('keeps working when the channel throws', async () => {
    const p = page({
      post: () => {
        throw new Error('bridge gone');
      },
    });
    const got = await p.scope.fetch('https://api.example.com/ok');
    expect(await got.json()).toEqual({ ok: true });
  });
});

describe('XMLHttpRequest', () => {
  it('reports method, URL, headers, body and the text response', () => {
    const p = page();
    const xhr = new p.scope.XMLHttpRequest();
    xhr.open('post', '/echo');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-Tag', 'a');
    xhr.setRequestHeader('X-Tag', 'b');
    xhr.send('{"a":1}');
    expect(p.xhrs[0].sentBody).toBe('{"a":1}');
    expect(p.xhrs[0].requestHeaders).toEqual([['Content-Type', 'application/json'], ['X-Tag', 'a'], ['X-Tag', 'b']]);
    const [req] = p.of('req');
    expect(req).toMatchObject({
      api: 'xhr',
      method: 'POST',
      url: 'https://shop.example.com/echo',
      headers: [['Content-Type', 'application/json'], ['X-Tag', 'a, b']],
      body: { encoding: 'utf8', data: '{"a":1}', size: 7 },
    });
    p.advance(25);
    p.xhrs[0].respond(200, 'Content-Type: application/json\r\nContent-Length: 7\r\n', '{"a":1}');
    const [res] = p.of('res');
    expect(res).toMatchObject({ id: req.id, status: 200, headers: [['Content-Type', 'application/json'], ['Content-Length', '7']], body: { data: '{"a":1}', size: 7 } });
  });

  it('reports network errors, timeouts and aborts', () => {
    const p = page();
    for (const kind of ['error', 'timeout', 'abort'] as const) {
      const xhr = new p.scope.XMLHttpRequest();
      xhr.open('GET', `https://api.example.com/${kind}`);
      xhr.send();
      p.xhrs[p.xhrs.length - 1].fail(kind);
    }
    expect(p.of('err').map((m) => [m.error, m.cancelled])).toEqual([
      ['Network error', undefined],
      ['Timeout', undefined],
      ['AbortError', true],
    ]);
  });

  it('passes a send() error through and ends the entry', () => {
    const p = page();
    const xhr = new p.scope.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/x');
    (xhr as FakeXhr).readyState = 0; // the platform would throw: not opened
    expect(() => xhr.send()).toThrow('InvalidStateError');
    expect(p.of('err')).toHaveLength(1);
  });

  it('ends a request in flight when the object is opened again', () => {
    const p = page();
    const xhr = new p.scope.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/first');
    xhr.send();
    xhr.open('GET', 'https://api.example.com/second');
    expect(p.of('err')[0]).toMatchObject({ id: p.of('req')[0].id, cancelled: true });
  });
});

describe('console and errors', () => {
  it('calls the original with the same this and arguments, and returns its value', () => {
    const p = page();
    const args = ['Cart updated', { items: 3, total: 49.9 }];
    expect(p.scope.console.log(...args)).toBe('returned-log');
    expect(p.consoleCalls[0]).toMatchObject({ method: 'log', self: p.scope.console, args });
    expect(p.of('log')[0]).toMatchObject({ level: 'info', message: 'Cart updated {"items":3,"total":49.9}', page: 'https://shop.example.com/cart?step=2' });
  });

  it('maps levels and carries an Error argument as the line’s error', () => {
    const p = page();
    p.scope.console.debug('d');
    p.scope.console.info('i');
    p.scope.console.warn('w');
    p.scope.console.error('Checkout failed', new Error('Card declined'));
    expect(p.of('log').map((m) => m.level)).toEqual(['debug', 'info', 'warn', 'error']);
    const last = p.of('log')[3];
    expect(last.message).toBe('Checkout failed Error: Card declined');
    expect(last.error).toMatchObject({ type: 'Error', message: 'Card declined' });
    expect(last.error.stack).toContain('Card declined');
  });

  it('formats %s / %d / %o and drops %c', () => {
    expect(formatConsole(['%s has %d items', 'Cart', 3.7])).toBe('Cart has 3 items');
    expect(formatConsole(['%cStyled', 'color: red', 'tail'])).toBe('Styled tail');
    expect(formatConsole(['%o', { a: [1, 2] }])).toBe('{"a":[1,2]}');
    expect(formatConsole(['100%% done'])).toBe('100% done');
  });

  it('survives cycles, deep objects and huge lines', () => {
    const p = page();
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    p.scope.console.log(cyclic, { a: { b: { c: { d: { e: 1 } } } } });
    expect(p.of('log')[0].message).toBe('{"name":"loop","self":"[circular]"} {"a":{"b":{"c":{"d":"[object]"}}}}');
    p.scope.console.log('x'.repeat(LIMITS.maxConsoleChars * 2));
    expect(p.of('log')[1].message).toHaveLength(LIMITS.maxConsoleChars);
  });

  it('reports uncaught errors and unhandled rejections, not resource load errors', () => {
    const p = page();
    p.scope.dispatch('error', { message: 'TypeError: x is undefined', filename: 'https://shop.example.com/app.js', lineno: 10, colno: 4, error: new TypeError('x is undefined') });
    p.scope.dispatch('error', { type: 'error', target: {} });
    p.scope.dispatch('unhandledrejection', { reason: new Error('nope') });
    expect(p.of('log').map((m) => m.message)).toEqual([
      'Uncaught TypeError: x is undefined (https://shop.example.com/app.js:10:4)',
      'Unhandled promise rejection: Error: nope',
    ]);
    expect(p.of('log')[0].error).toMatchObject({ type: 'TypeError' });
  });

  it('limits the message rate and reports how many it dropped', () => {
    const p = page();
    for (let i = 0; i < LIMITS.burst + 50; i++) p.scope.console.log(`line ${i}`);
    expect(p.of('log')).toHaveLength(LIMITS.burst);
    expect(p.consoleCalls).toHaveLength(LIMITS.burst + 50); // the page's console got every line
    p.advance(1_000);
    p.scope.console.log('after a second');
    expect(p.of('dropped')).toEqual([{ v: 1, t: 'dropped', count: 50 }]);
    expect(p.of('log').at(-1)?.message).toBe('after a second');
  });
});

describe('bundled script', () => {
  it('runs in a bare window and wraps fetch, XMLHttpRequest and console', async () => {
    const posted: string[] = [];
    const { Xhr } = makeXhrClass();
    const window: any = {
      location: { href: 'https://m.example.com/' },
      URL,
      Response,
      Request,
      Headers,
      TextDecoder,
      btoa,
      setTimeout,
      clearTimeout,
      console: { log: () => undefined },
      XMLHttpRequest: Xhr,
      fetch: async () => new Response('hi', { headers: { 'content-type': 'text/plain' } }),
      __durbun: { post: (json: string) => posted.push(json) },
    };
    window.window = window;
    runInNewContext(bundleBridge(), window);
    window.console.log('hello from the bundle');
    await window.fetch('/x');
    await vi.waitFor(() => expect(posted.map((json) => JSON.parse(json).t)).toEqual(['log', 'req', 'res']));
    expect(JSON.parse(posted[1])).toMatchObject({ url: 'https://m.example.com/x', api: 'fetch' });
  });
});
