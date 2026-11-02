/**
 * XMLHttpRequest patch against two minimal XHR polyfills (browser-like and React-Native-like), including
 * mocks and the "capture once" guarantee with fetch implementations built on XHR.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WsClient from 'ws';
import { Durbun } from '../src/index.js';
import type { MockRule } from '../src/protocol.js';
import { FakeDesktop, waitFor, type FakeDesktopOptions } from './helpers/fakeDesktop.js';
import { BINARY, USERS_JSON, closedPort, startHttpServer, type TestServer } from './helpers/httpServer.js';
import { DomXHR, RnXHR, createXhrFetch } from './helpers/xhrPolyfill.js';

let server: TestServer;
let desktop: FakeDesktop | undefined;
const realFetch = globalThis.fetch;
const realEvent = globalThis.Event;

beforeAll(async () => {
  server = await startHttpServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  Durbun.stop();
  globalThis.fetch = realFetch;
  globalThis.Event = realEvent;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  await desktop?.close();
  desktop = undefined;
  server.hits.length = 0;
});

function rule(partial: Partial<MockRule> & Pick<MockRule, 'action'>): MockRule {
  return { id: 'rule-1', enabled: true, method: '*', url: '/mocked', match: 'contains', createdAt: 0, ...partial };
}

async function start(desktopOpts: FakeDesktopOptions = {}, opts: Parameters<typeof Durbun.start>[0] = {}) {
  desktop = await FakeDesktop.start(desktopOpts);
  // The ws client keeps the transport independent from the global Event class some tests remove.
  Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient, ...opts });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

async function exchange(d: FakeDesktop, urlPart: string) {
  const req = await d.waitForMessage((m) => m.type === 'net.request' && m.url.includes(urlPart), 5_000, `request ${urlPart}`);
  const done = await d.waitForMessage((m) => (m.type === 'net.response' || m.type === 'net.error') && m.id === req.id, 5_000, `result ${urlPart}`);
  return { req, done };
}

interface Sent {
  xhr: any;
  events: string[];
}

/** Sends a request and resolves on loadend (handler property), recording handler and listener events. */
function send(
  method: string,
  url: string,
  o: { headers?: Array<[string, string]>; body?: unknown; responseType?: string; timeout?: number; abortAfter?: number; afterOpen?: () => void } = {},
): Promise<Sent> {
  return new Promise((resolve) => {
    const XHR = (globalThis as any).XMLHttpRequest;
    const xhr = new XHR();
    const events: string[] = [];
    xhr.onreadystatechange = () => events.push(`rs${xhr.readyState}`);
    xhr.onloadstart = () => events.push('loadstart');
    xhr.onload = () => events.push('load');
    xhr.onerror = () => events.push('error');
    xhr.ontimeout = () => events.push('timeout');
    xhr.onabort = () => events.push('abort');
    xhr.addEventListener('load', () => events.push('listener:load'));
    xhr.onloadend = () => {
      events.push('loadend');
      resolve({ xhr, events });
    };
    xhr.open(method, url);
    o.afterOpen?.();
    if (o.responseType) xhr.responseType = o.responseType;
    if (o.timeout) xhr.timeout = o.timeout;
    for (const [k, v] of o.headers ?? []) xhr.setRequestHeader(k, v);
    xhr.send(o.body ?? null);
    if (o.abortAfter !== undefined) setTimeout(() => xhr.abort(), o.abortAfter);
  });
}

describe.each([
  ['browser-like', DomXHR],
  ['react-native-like', RnXHR],
] as const)('XHR patch (%s)', (style, XHRClass) => {
  beforeEach(() => {
    (globalThis as any).XMLHttpRequest = XHRClass;
  });

  it('captures a GET with headers, response body and timings; the app sees everything unchanged', async () => {
    const d = await start();
    const { xhr, events } = await send('get', `${server.url}/json`, { headers: [['Accept', 'application/json'], ['X-Trace', 't1']] });
    expect(xhr.status).toBe(200);
    expect(xhr.responseText).toBe(USERS_JSON);
    expect(events).toEqual(expect.arrayContaining(['rs2', 'rs4', 'load', 'listener:load', 'loadend']));
    const { req, done } = await exchange(d, '/json');
    expect(req).toMatchObject({ method: 'GET', url: `${server.url}/json`, source: 'xhr', headers: [['Accept', 'application/json'], ['X-Trace', 't1']] });
    expect(done).toMatchObject({ type: 'net.response', status: 200, body: { encoding: 'utf8', data: USERS_JSON, size: Buffer.byteLength(USERS_JSON) } });
    expect(done.headers).toEqual(expect.arrayContaining([['content-type', 'application/json; charset=utf-8'], ['x-request-id', 'abc-123']]));
    expect(done.timings.wait).toBeGreaterThanOrEqual(0);
    expect(done.timings.receive).toBeGreaterThanOrEqual(0);
    expect(server.hits[0].headers['x-trace']).toBe('t1');
  });

  it('captures request bodies and every responseType', async () => {
    const d = await start();
    const json = JSON.stringify({ ad: 'Ayşe', yaş: 30 });
    const post = await send('POST', `${server.url}/echo?t=post`, { headers: [['Content-Type', 'application/json']], body: json });
    expect(post.xhr.status).toBe(201);
    const asJson = await send('GET', `${server.url}/json?t=json`, { responseType: 'json' });
    expect(asJson.xhr.response).toEqual(JSON.parse(USERS_JSON));
    const asBuffer = await send('GET', `${server.url}/binary?t=ab`, { responseType: 'arraybuffer' });
    expect(Buffer.from(asBuffer.xhr.response).equals(BINARY)).toBe(true);
    const asBlob = await send('GET', `${server.url}/binary?t=blob`, { responseType: 'blob' });
    expect(asBlob.xhr.response.size).toBe(256);
    const p = await exchange(d, 't=post');
    expect(p.req.body).toEqual({ encoding: 'utf8', data: json, size: Buffer.byteLength(json) });
    expect(p.done).toMatchObject({ status: 201, body: { encoding: 'utf8', data: json } });
    expect((await exchange(d, 't=json')).done.body).toEqual({ encoding: 'utf8', data: USERS_JSON, size: Buffer.byteLength(USERS_JSON) });
    expect((await exchange(d, 't=ab')).done.body).toEqual({ encoding: 'base64', data: BINARY.toString('base64'), size: 256 });
    expect((await exchange(d, 't=blob')).done.body).toEqual({ encoding: 'base64', data: BINARY.toString('base64'), size: 256 });
  });

  it('reports connection errors, timeouts and aborts', async () => {
    const d = await start();
    const port = await closedPort();
    const failed = await send('GET', `http://127.0.0.1:${port}/x`);
    expect(failed.events).toContain('error');
    const timedOut = await send('GET', `${server.url}/slow?ms=1000&t=timeout`, { timeout: 100 });
    expect(timedOut.events).toContain('timeout');
    const aborted = await send('GET', `${server.url}/slow?ms=1000&t=abort`, { abortAfter: 50 });
    expect(aborted.events).toContain('abort');
    const err = (await exchange(d, `${port}/x`)).done;
    expect(err.type).toBe('net.error');
    if (style === 'react-native-like') expect(err.error).toContain('ECONNREFUSED'); // RN keeps the native message in _response
    else expect(err.error).toBe('Network request failed');
    expect((await exchange(d, 't=timeout')).done).toMatchObject({ type: 'net.error', error: 'Request timed out after 100 ms' });
    expect((await exchange(d, 't=abort')).done).toMatchObject({ type: 'net.error', error: 'Request cancelled', cancelled: true });
  });

  it('mock respond: full event sequence and response fields without touching the network', async () => {
    const body = JSON.stringify({ mocked: true, şehir: 'İzmir' });
    const d = await start({
      mocks: [rule({ id: 'm1', url: '/mocked/profile', action: { type: 'respond', status: 202, headers: [['Content-Type', 'application/json'], ['X-Mock', 'yes']], body } })],
    });
    const { xhr, events } = await send('GET', `${server.url}/mocked/profile`);
    expect(server.hits).toHaveLength(0);
    expect(xhr.readyState).toBe(4);
    expect(xhr.status).toBe(202);
    expect(xhr.statusText).toBe('Accepted');
    expect(xhr.responseText).toBe(body);
    expect(xhr.response).toBe(body);
    expect(xhr.responseURL).toBe(`${server.url}/mocked/profile`);
    expect(xhr.getResponseHeader('x-mock')).toBe('yes');
    expect(xhr.getResponseHeader('missing')).toBeNull();
    expect(xhr.getAllResponseHeaders()).toBe('content-type: application/json\r\nx-mock: yes\r\n');
    // rs1 comes from open(); listeners run before the on<type> handler in both implementations.
    expect(events).toEqual(['rs1', 'loadstart', 'rs2', 'rs3', 'rs4', 'listener:load', 'load', 'loadend']);
    const { done } = await exchange(d, '/mocked/profile');
    expect(done).toMatchObject({ type: 'net.response', status: 202, mocked: true, mockRuleId: 'm1', body: { encoding: 'utf8', data: body } });
    // A mocked request cannot be sent twice (like the platform's InvalidStateError).
    expect(() => xhr.send()).toThrow(/OPENED/);
  });

  it('mock respond honors responseType (json / arraybuffer / blob)', async () => {
    await start({
      mocks: [
        rule({ id: 'j', url: '/mocked/json', action: { type: 'respond', status: 200, body: '{"a":1}' } }),
        rule({ id: 'b', url: '/mocked/bin', action: { type: 'respond', status: 200, headers: [['content-type', 'image/png']], body: BINARY.toString('base64'), bodyEncoding: 'base64' } }),
      ],
    });
    const j = await send('GET', `${server.url}/mocked/json`, { responseType: 'json' });
    expect(j.xhr.response).toEqual({ a: 1 });
    expect(() => j.xhr.responseText).toThrow();
    const ab = await send('GET', `${server.url}/mocked/bin`, { responseType: 'arraybuffer' });
    expect(Buffer.from(ab.xhr.response).equals(BINARY)).toBe(true);
    const blob = await send('GET', `${server.url}/mocked/bin?b`, { responseType: 'blob' });
    expect(Buffer.from(await blob.xhr.response.arrayBuffer()).equals(BINARY)).toBe(true);
    expect(blob.xhr.response.type).toBe('image/png');
  });

  it('mock delay waits then performs the real request; mock fail raises error / timeout events', async () => {
    const d = await start({
      mocks: [
        rule({ id: 'lag', url: '/json', action: { type: 'delay', delayMs: 250 } }),
        rule({ id: 'down', url: '/mocked/down', action: { type: 'fail', error: 'connection' } }),
        rule({ id: 'slow', url: '/mocked/slow', action: { type: 'fail', error: 'timeout', delayMs: 50 } }),
      ],
    });
    const t0 = Date.now();
    const delayed = await send('GET', `${server.url}/json`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    expect(delayed.xhr.responseText).toBe(USERS_JSON);
    expect(server.hits).toHaveLength(1);
    const down = await send('GET', `${server.url}/mocked/down`);
    expect(down.events).toEqual(['rs1', 'loadstart', 'rs4', 'error', 'loadend']);
    expect(down.xhr.status).toBe(0);
    const slow = await send('GET', `${server.url}/mocked/slow`);
    expect(slow.events).toContain('timeout');
    expect(server.hits).toHaveLength(1);
    expect((await exchange(d, '/json')).done).toMatchObject({ type: 'net.response', status: 200, mocked: true, mockRuleId: 'lag' });
    expect((await exchange(d, '/mocked/down')).done).toMatchObject({
      type: 'net.error',
      error: 'Could not connect to 127.0.0.1 (connection refused).',
      mocked: true,
      mockRuleId: 'down',
    });
    expect((await exchange(d, '/mocked/slow')).done).toMatchObject({ type: 'net.error', error: 'The request timed out.', mocked: true });
  });

  it("an injected delay longer than the app's XHR timeout ends in a timeout", async () => {
    const d = await start({ mocks: [rule({ id: 'lag', url: '/mocked/lag', action: { type: 'respond', status: 200, body: 'late', delayMs: 2000 } })] });
    const t0 = Date.now();
    const res = await send('GET', `${server.url}/mocked/lag`, { timeout: 100 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.events).toContain('timeout');
    expect((await exchange(d, '/mocked/lag')).done).toMatchObject({ type: 'net.error', error: 'Request timed out after 100 ms', mocked: true });
  });

  it('abort() during a mocked delay cancels like the platform', async () => {
    const d = await start({ mocks: [rule({ id: 'hold', url: '/mocked/hold', action: { type: 'respond', status: 200, body: 'never', delayMs: 2000 } })] });
    const res = await send('GET', `${server.url}/mocked/hold`, { abortAfter: 30 });
    expect(res.events).toEqual(['rs1', 'loadstart', 'rs4', 'abort', 'loadend']);
    expect(res.xhr.readyState).toBe(0);
    expect((await exchange(d, '/mocked/hold')).done).toMatchObject({ type: 'net.error', cancelled: true, mocked: true, mockRuleId: 'hold' });
  });

  it('delivers mocked events even without a global Event class (plain-object / handler fallback)', async () => {
    await start({ mocks: [rule({ id: 'p', url: '/mocked/plain', action: { type: 'respond', status: 200, body: 'plain' } })] });
    const res = await send('GET', `${server.url}/mocked/plain`, {
      afterOpen: () => {
        delete (globalThis as Record<string, unknown>).Event;
      },
    });
    globalThis.Event = realEvent;
    expect(res.xhr.responseText).toBe('plain');
    expect(res.events).toEqual(expect.arrayContaining(['rs4', 'load', 'loadend']));
    // event-target-shim style dispatch accepts plain objects, so listeners still fire there.
    if (style === 'react-native-like') expect(res.events).toContain('listener:load');
  });

  it('never captures the desktop itself or ignored URLs', async () => {
    const d = await start({}, { ignoreUrls: [/t=private/] });
    await send('GET', `${server.url}/json?t=private`);
    await send('GET', `http://127.0.0.1:${d.port}/api/health`);
    await send('GET', `${server.url}/json?t=public`);
    await exchange(d, 't=public');
    expect(d.messages('net.request').map((m) => m.url)).toEqual([`${server.url}/json?t=public`]);
  });

  it('fetch built on XHR (whatwg-fetch, polyfill flag): fetch is left alone and each request is captured once', async () => {
    globalThis.fetch = createXhrFetch(true) as unknown as typeof fetch;
    const polyfill = globalThis.fetch;
    const d = await start({ mocks: [rule({ id: 'm', url: '/mocked/via-fetch', action: { type: 'respond', status: 200, headers: [['content-type', 'application/json']], body: '{"ok":1}' } })] });
    expect(globalThis.fetch).toBe(polyfill);
    const res = await fetch(`${server.url}/json?t=polyfill`);
    expect(await res.json()).toEqual(JSON.parse(USERS_JSON));
    const mocked = await fetch(`${server.url}/mocked/via-fetch`);
    expect(await mocked.json()).toEqual({ ok: 1 });
    await exchange(d, 't=polyfill');
    await exchange(d, '/mocked/via-fetch');
    const requests = d.messages('net.request');
    expect(requests.map((r) => r.source)).toEqual(['xhr', 'xhr']);
  });

  it('fetch built on XHR without the flag: captured once, by the fetch patch', async () => {
    globalThis.fetch = createXhrFetch(false) as unknown as typeof fetch;
    const d = await start();
    expect(globalThis.fetch).not.toBe(realFetch);
    const res = await fetch(`${server.url}/json?t=unflagged`);
    expect(res.status).toBe(200);
    await exchange(d, 't=unflagged');
    expect(d.messages('net.request').map((r) => r.source)).toEqual(['fetch']);
  });

  it('a fetch over XHR rejects naturally for mocked failures (RN: "Network request failed")', async () => {
    globalThis.fetch = createXhrFetch(true) as unknown as typeof fetch;
    await start({ mocks: [rule({ id: 'dns', url: '/mocked/dns', action: { type: 'fail', error: 'dns' } })] });
    const err = await fetch(`${server.url}/mocked/dns`).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('Network request failed');
  });

  it('restores the prototype on stop', async () => {
    const open = XHRClass.prototype.open;
    const sendFn = XHRClass.prototype.send;
    await start();
    expect(XHRClass.prototype.open).not.toBe(open);
    Durbun.stop();
    expect(XHRClass.prototype.open).toBe(open);
    expect(XHRClass.prototype.send).toBe(sendFn);
  });
});

describe('XHR instance reuse (browser semantics)', () => {
  beforeEach(() => {
    (globalThis as any).XMLHttpRequest = DomXHR;
  });

  it('a reused instance drops the previous mock overrides', async () => {
    await start({ mocks: [rule({ id: 'm', url: '/mocked/first', action: { type: 'respond', status: 299, body: 'mocked' } })] });
    const xhr: any = new DomXHR();
    await new Promise<void>((resolve) => {
      xhr.onloadend = () => resolve();
      xhr.open('GET', `${server.url}/mocked/first`);
      xhr.send();
    });
    expect(xhr.status).toBe(299);
    await new Promise<void>((resolve) => {
      xhr.onloadend = () => resolve();
      xhr.open('GET', `${server.url}/json`);
      xhr.send();
    });
    expect(xhr.status).toBe(200);
    expect(xhr.responseText).toBe(USERS_JSON);
    expect(Object.prototype.hasOwnProperty.call(xhr, 'status')).toBe(false);
  });
});
