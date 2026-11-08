/** Native fetch (Node/undici) capture and mocks against a local HTTP server. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Durbun } from '../src/index.js';
import type { MockRule } from '../src/protocol.js';
import { FakeDesktop, waitFor, type FakeDesktopOptions } from './helpers/fakeDesktop.js';
import { BINARY, USERS_JSON, closedPort, startHttpServer, type TestServer } from './helpers/httpServer.js';

let server: TestServer;
let desktop: FakeDesktop | undefined;
const nativeFetch = globalThis.fetch;

beforeAll(async () => {
  server = await startHttpServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  Durbun.stop();
  await desktop?.close();
  desktop = undefined;
  server.hits.length = 0;
});

function rule(partial: Partial<MockRule> & Pick<MockRule, 'action'>): MockRule {
  return { id: 'rule-1', enabled: true, method: '*', url: '/mocked', match: 'contains', createdAt: 0, ...partial };
}

async function start(desktopOpts: FakeDesktopOptions = {}, opts: Parameters<typeof Durbun.start>[0] = {}) {
  desktop = await FakeDesktop.start(desktopOpts);
  Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, ...opts });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

/** request + final message (response or error) for one request id. */
async function exchange(d: FakeDesktop, urlPart: string) {
  const req = await d.waitForMessage((m) => m.type === 'net.request' && m.url.includes(urlPart), 5_000, `request ${urlPart}`);
  const done = await d.waitForMessage((m) => (m.type === 'net.response' || m.type === 'net.error') && m.id === req.id, 5_000, `result ${urlPart}`);
  return { req, done };
}

describe('fetch capture', () => {
  it('patches fetch only while started and restores it on stop', async () => {
    await start();
    expect(globalThis.fetch).not.toBe(nativeFetch);
    Durbun.stop();
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  it('captures a JSON GET (headers, body, timings) while the app still reads the body', async () => {
    const d = await start();
    const res = await fetch(`${server.url}/json?page=1`, { headers: { Accept: 'application/json', 'X-Trace': 't-1' } });
    expect(await res.json()).toEqual(JSON.parse(USERS_JSON));
    const { req, done } = await exchange(d, '/json?page=1');
    expect(req).toMatchObject({ method: 'GET', url: `${server.url}/json?page=1`, source: 'fetch', headers: [['Accept', 'application/json'], ['X-Trace', 't-1']] });
    expect(req.body).toBeUndefined();
    expect(done).toMatchObject({ type: 'net.response', status: 200, statusText: 'OK', body: { encoding: 'utf8', data: USERS_JSON, size: Buffer.byteLength(USERS_JSON) } });
    expect(done.headers).toEqual(expect.arrayContaining([['content-type', 'application/json; charset=utf-8'], ['x-request-id', 'abc-123']]));
    expect(done.timings.wait).toBeGreaterThanOrEqual(0);
    expect(done.timings.receive).toBeGreaterThanOrEqual(0);
    expect(done.mocked).toBeUndefined();
  });

  it('redactHeaders masks the values sent to the desktop, not the ones sent to the server', async () => {
    const d = await start({}, { redactHeaders: ['Authorization', 'set-cookie'] });
    const res = await fetch(`${server.url}/users`, { headers: { Authorization: 'Bearer secret', 'X-Trace': 't-1' } });
    await res.text();
    const { req, done } = await exchange(d, '/users');
    expect(req.headers).toContainEqual(['Authorization', '••••']);
    expect(req.headers).toContainEqual(['X-Trace', 't-1']);
    expect(server.hits[server.hits.length - 1]!.headers.authorization).toBe('Bearer secret');
    expect(done.type).toBe('net.response');
  });

  it('captures request bodies: JSON string, URLSearchParams, Blob, ArrayBuffer, Request objects', async () => {
    const d = await start();
    const json = JSON.stringify({ name: 'Ayşe', items: [1, 2] });
    const r1 = await fetch(`${server.url}/echo?k=json`, { method: 'post', headers: { 'Content-Type': 'application/json' }, body: json });
    expect(await r1.text()).toBe(json);
    await fetch(`${server.url}/echo?k=form`, { method: 'POST', body: new URLSearchParams({ q: 'dürbün' }) });
    await fetch(`${server.url}/echo?k=blob`, { method: 'PUT', body: new Blob(['blob-body'], { type: 'text/plain' }) });
    await fetch(`${server.url}/echo?k=bytes`, { method: 'PATCH', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]).buffer });
    await fetch(new Request(`${server.url}/echo?k=request`, { method: 'POST', body: 'from request', headers: { 'content-type': 'text/plain' } }));
    const json1 = await exchange(d, 'k=json');
    expect(json1.req).toMatchObject({ method: 'POST', body: { encoding: 'utf8', data: json, size: Buffer.byteLength(json) } });
    expect(json1.done).toMatchObject({ status: 201, body: { encoding: 'utf8', data: json } });
    expect((await exchange(d, 'k=form')).req.body).toEqual({ encoding: 'utf8', data: 'q=d%C3%BCrb%C3%BCn', size: 18 });
    expect((await exchange(d, 'k=blob')).req).toMatchObject({ method: 'PUT', body: { encoding: 'utf8', data: 'blob-body', size: 9 } });
    expect((await exchange(d, 'k=bytes')).req.body).toEqual({ encoding: 'base64', data: 'AQID', size: 3 });
    const fromRequest = await exchange(d, 'k=request');
    expect(fromRequest.req).toMatchObject({ method: 'POST', body: { encoding: 'utf8', data: 'from request' } });
    expect(server.hits.find((h) => h.path.includes('k=request'))?.body.toString()).toBe('from request');
  });

  it('reads only a capped prefix of a Request object body', async () => {
    const d = await start({ config: { maxBodyBytes: 100 } });
    const payload = 'x'.repeat(5000);
    await (await fetch(new Request(`${server.url}/echo?k=large-request`, { method: 'POST', body: payload, headers: { 'content-type': 'text/plain' } }))).text();
    const { req } = await exchange(d, 'k=large-request');
    expect(req.body).toMatchObject({ encoding: 'utf8', data: 'x'.repeat(100), truncated: true });
    expect(req.body.size).toBeGreaterThanOrEqual(100);
    expect(server.hits.find((h) => h.path.includes('k=large-request'))?.body.toString()).toBe(payload);
  });

  it('reports event streams when the headers arrive, without waiting for the stream to end', async () => {
    const d = await start();
    const controller = new AbortController();
    const res = await fetch(`${server.url}/sse`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: merhaba');
    const { done } = await exchange(d, '/sse');
    expect(done).toMatchObject({ type: 'net.response', status: 200 });
    expect(done.body).toBeUndefined();
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it('captures binary responses as base64 and HTTP errors as responses', async () => {
    const d = await start();
    const img = await fetch(`${server.url}/binary`);
    expect(Buffer.from(await img.arrayBuffer()).equals(BINARY)).toBe(true);
    const notFound = await fetch(`${server.url}/status/404`);
    expect(notFound.status).toBe(404);
    const noContent = await fetch(`${server.url}/nocontent`);
    expect(noContent.status).toBe(204);
    expect((await exchange(d, '/binary')).done).toMatchObject({ status: 200, body: { encoding: 'base64', data: BINARY.toString('base64'), size: 256 } });
    expect((await exchange(d, '/status/404')).done).toMatchObject({ status: 404, statusText: 'Not Found', body: { data: 'status 404' } });
    const nc = (await exchange(d, '/nocontent')).done;
    expect(nc.status).toBe(204);
    expect(nc.body).toBeUndefined();
  });

  it('honors maxBodyBytes / captureBodies from the desktop config', async () => {
    const d = await start({ config: { maxBodyBytes: 100 } });
    const res = await fetch(`${server.url}/big?n=5000`);
    expect((await res.text()).length).toBe(5000);
    const big = (await exchange(d, '/big?n=5000')).done;
    expect(big.body).toEqual({ encoding: 'utf8', data: 'a'.repeat(100), size: 5000, truncated: true });
    d.broadcast({ type: 'config', config: { captureBodies: false, maxBodyBytes: 100, metricsIntervalMs: 1000, deviceLogsAvailable: false } });
    await d.barrier();
    await (await fetch(`${server.url}/binary`)).arrayBuffer();
    const sizeOnly = (await exchange(d, '/binary')).done;
    expect(sizeOnly.body).toEqual({ encoding: 'utf8', data: '', size: 256, truncated: true });
  });

  it('reports network errors and keeps the original error for the app', async () => {
    const d = await start();
    const port = await closedPort();
    const err = await fetch(`http://127.0.0.1:${port}/nothing`).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    const { done } = await exchange(d, `${port}/nothing`);
    expect(done.type).toBe('net.error');
    expect(done.error).toContain('fetch failed');
    expect(done.error).toContain('ECONNREFUSED');
    expect(done.cancelled).toBeUndefined();
  });

  it('reports aborts as cancelled', async () => {
    const d = await start();
    const controller = new AbortController();
    const pending = fetch(`${server.url}/slow?ms=2000`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const err = await pending.catch((e) => e);
    expect(err.name).toBe('AbortError');
    const { done } = await exchange(d, '/slow?ms=2000');
    expect(done).toMatchObject({ type: 'net.error', cancelled: true, error: 'Request cancelled' });
  });

  it('never captures the desktop itself or ignored URLs', async () => {
    const d = await start({}, { ignoreUrls: ['/status/', /k=secret/] });
    await (await fetch(`${server.url}/status/200`)).text();
    await (await fetch(`${server.url}/echo?k=secret`, { method: 'POST', body: 'x' })).text();
    await fetch(`http://127.0.0.1:${d.port}/api/health`).catch(() => undefined);
    await (await fetch(`${server.url}/json`)).text();
    await exchange(d, '/json');
    const urls = d.messages('net.request').map((m) => m.url);
    expect(urls).toEqual([`${server.url}/json`]);
  });
});

describe('fetch mocks', () => {
  it('respond: synthesizes the response without touching the network', async () => {
    const body = JSON.stringify({ mocked: true, items: ['ş'] });
    const d = await start({
      mocks: [rule({ id: 'm-respond', url: '/mocked/users', action: { type: 'respond', status: 201, headers: [['Content-Type', 'application/json'], ['X-Mock', '1']], body } })],
    });
    const res = await fetch(`${server.url}/mocked/users?x=1`);
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.statusText).toBe('Created');
    expect(res.headers.get('x-mock')).toBe('1');
    expect(await res.json()).toEqual({ mocked: true, items: ['ş'] });
    expect(server.hits).toHaveLength(0);
    const { done } = await exchange(d, '/mocked/users');
    expect(done).toMatchObject({ type: 'net.response', status: 201, mocked: true, mockRuleId: 'm-respond', body: { encoding: 'utf8', data: body } });
  });

  it('respond: base64 bodies, 204 without body, and statuses outside 200-599', async () => {
    const d = await start({
      mocks: [
        rule({ id: 'png', url: '/img.png', action: { type: 'respond', status: 200, headers: [['Content-Type', 'image/png']], body: BINARY.toString('base64'), bodyEncoding: 'base64' } }),
        rule({ id: 'empty', url: '/empty', action: { type: 'respond', status: 204, body: 'ignored' } }),
        rule({ id: 'weird', url: '/weird', action: { type: 'respond', status: 103 } }),
      ],
    });
    const img = await fetch(`${server.url}/img.png`);
    expect(Buffer.from(await img.arrayBuffer()).equals(BINARY)).toBe(true);
    const empty = await fetch(`${server.url}/empty`);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
    const weird = await fetch(`${server.url}/weird`);
    expect(weird.status).toBe(103);
    expect((await exchange(d, '/img.png')).done.body).toEqual({ encoding: 'base64', data: BINARY.toString('base64'), size: 256 });
    expect(server.hits).toHaveLength(0);
  });

  it('respond with delay respects AbortSignal', async () => {
    const d = await start({ mocks: [rule({ id: 'slow', action: { type: 'respond', status: 200, body: 'late', delayMs: 2000 } })] });
    const controller = new AbortController();
    const pending = fetch(`${server.url}/mocked`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const err = await pending.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect((await exchange(d, '/mocked')).done).toMatchObject({ type: 'net.error', cancelled: true, mocked: true, mockRuleId: 'slow' });
  });

  it('delay: waits, then performs the real request', async () => {
    const d = await start({ mocks: [rule({ id: 'lag', url: '/json', action: { type: 'delay', delayMs: 300 } })] });
    const t0 = Date.now();
    const res = await fetch(`${server.url}/json`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(await res.json()).toEqual(JSON.parse(USERS_JSON));
    expect(server.hits).toHaveLength(1);
    const { done } = await exchange(d, '/json');
    expect(done).toMatchObject({ status: 200, mocked: true, mockRuleId: 'lag', body: { data: USERS_JSON } });
    expect(done.timings.wait).toBeGreaterThanOrEqual(290);
  });

  it('fail: raises the natural Node fetch error (TypeError with a coded cause)', async () => {
    const d = await start({
      mocks: [
        rule({ id: 'dns', url: '/dns', action: { type: 'fail', error: 'dns' } }),
        rule({ id: 'refused', url: '/refused', action: { type: 'fail', error: 'connection', delayMs: 100 } }),
        rule({ id: 'custom', url: '/custom', action: { type: 'fail', error: 'custom', message: 'Sunucu bakımda' } }),
      ],
    });
    const dns = await fetch('https://api.example.com/dns').catch((e) => e);
    expect(dns).toBeInstanceOf(TypeError);
    expect(dns.message).toBe('fetch failed');
    expect(dns.cause).toMatchObject({ code: 'ENOTFOUND', hostname: 'api.example.com' });
    const t0 = Date.now();
    const refused = await fetch(`${server.url}/refused`).catch((e) => e);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(refused.cause.code).toBe('ECONNREFUSED');
    const custom = await fetch(`${server.url}/custom`).catch((e) => e);
    expect(custom.cause.message).toBe('Sunucu bakımda');
    expect(server.hits).toHaveLength(0);
    expect((await exchange(d, '/dns')).done).toMatchObject({ type: 'net.error', error: 'Could not resolve host "api.example.com".', mocked: true, mockRuleId: 'dns' });
    expect((await exchange(d, '/custom')).done.error).toBe('Sunucu bakımda');
  });

  it('mock rules end with the connection that pushed them', async () => {
    const d = await start({ mocks: [rule({ id: 'm-json', url: '/json', action: { type: 'respond', status: 418, body: 'teapot' } })] });
    expect((await fetch(`${server.url}/json`)).status).toBe(418);
    expect(server.hits).toHaveLength(0);
    // Whoever answered the hello is not authenticated: once it is gone, its rules must not stay active.
    await d.close();
    desktop = undefined;
    await waitFor(() => !Durbun.isConnected, 3_000, 'disconnect');
    const res = await fetch(`${server.url}/json`);
    expect(res.status).toBe(200);
    await res.text();
    expect(server.hits).toHaveLength(1);
  });

  it('mock rules can be changed live and are scoped by method / app', async () => {
    const d = await start({}, { appId: 'com.mykynk.pati' });
    await (await fetch(`${server.url}/json`)).text();
    expect(server.hits).toHaveLength(1);
    d.broadcast({
      type: 'mocks',
      rules: [
        rule({ id: 'other-app', url: '/json', apps: ['com.other'], action: { type: 'respond', status: 500 } }),
        rule({ id: 'post-only', url: '/json', method: 'POST', action: { type: 'respond', status: 500 } }),
        rule({ id: 'mine', url: `${server.url}/js?n`, match: 'glob', apps: ['com.mykynk.pati'], action: { type: 'respond', status: 418, body: 'teapot' } }),
      ],
    });
    await d.barrier();
    const res = await fetch(`${server.url}/json`);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('teapot');
    expect(server.hits).toHaveLength(1);
  });
});
