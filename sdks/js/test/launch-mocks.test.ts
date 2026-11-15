/** Mock rules for requests made at launch: they wait for the desktop's rules, but never for a desktop that is not there. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WsClient from 'ws';
import { Durbun } from '../src/index.js';
import type { MockRule } from '../src/protocol.js';
import { FakeDesktop, sleep, waitFor } from './helpers/fakeDesktop.js';
import { closedPort, startHttpServer, type TestServer } from './helpers/httpServer.js';
import { RnXHR } from './helpers/xhrPolyfill.js';

let server: TestServer;
let desktop: FakeDesktop | undefined;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = await startHttpServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  Durbun.stop();
  globalThis.fetch = realFetch;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  await desktop?.close();
  desktop = undefined;
  server.hits.length = 0;
});

const remoteConfig: MockRule = {
  id: 'rc',
  enabled: true,
  method: '*',
  url: '/remote-config',
  match: 'contains',
  createdAt: 0,
  action: { type: 'respond', status: 200, headers: [['Content-Type', 'application/json']], body: '{"newCheckout":true}' },
};

const base = { enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient } as const;

/** XHR as React Native's fetch uses it; resolves on loadend. */
function xhrGet(url: string, abortAfter?: number): Promise<{ status: number; text: string; events: string[] }> {
  return new Promise((resolve) => {
    const XHR = (globalThis as any).XMLHttpRequest;
    const xhr = new XHR();
    const events: string[] = [];
    xhr.onload = () => events.push('load');
    xhr.onabort = () => events.push('abort');
    xhr.onerror = () => events.push('error');
    xhr.onloadend = () => resolve({ status: xhr.status, text: xhr.responseText, events });
    xhr.open('GET', url);
    xhr.send();
    if (abortAfter !== undefined) setTimeout(() => xhr.abort(), abortAfter);
  });
}

describe('requests made at launch', () => {
  it('with waitForDesktop, a request made before the connection is mocked once the rules arrive', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    desktop = await FakeDesktop.start({ mocks: [remoteConfig], autoWelcome: false });
    Durbun.start({ ...base, host: '127.0.0.1', port: desktop.port, waitForDesktop: 3_000 });
    const pending = xhrGet(`${server.url}/remote-config`);
    await desktop.waitForMessage((m) => m.type === 'hello');
    await sleep(100);
    desktop.welcome(1);
    const res = await pending;
    expect(res).toMatchObject({ status: 200, text: '{"newCheckout":true}' });
    expect(server.hits.some((h) => h.path.includes('remote-config'))).toBe(false);
    const done = await desktop.waitForMessage((m) => m.type === 'net.response');
    expect(done).toMatchObject({ mocked: true, mockRuleId: 'rc' });
  });

  it('without the option, a request made while the desktop is answering still waits for its rules', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    desktop = await FakeDesktop.start({ mocks: [remoteConfig], autoWelcome: false });
    Durbun.start({ ...base, host: '127.0.0.1', port: desktop.port });
    await desktop.waitForMessage((m) => m.type === 'hello');
    const pending = xhrGet(`${server.url}/remote-config`);
    await sleep(100);
    desktop.welcome(1);
    expect((await pending).text).toBe('{"newCheckout":true}');
  });

  it('fetch (not built on XHR) waits the same way', async () => {
    desktop = await FakeDesktop.start({ mocks: [remoteConfig], autoWelcome: false });
    Durbun.start({ ...base, host: '127.0.0.1', port: desktop.port, waitForDesktop: 3_000 });
    const pending = globalThis.fetch(`${server.url}/remote-config`).then((r) => r.text());
    await desktop.waitForMessage((m) => m.type === 'hello');
    await sleep(50);
    desktop.welcome(1);
    expect(await pending).toBe('{"newCheckout":true}');
  });

  it('no desktop running: requests go out at once, whatever waitForDesktop says', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    Durbun.start({ ...base, host: '127.0.0.1', port: await closedPort(), waitForDesktop: 10_000 });
    const t0 = Date.now();
    const res = await xhrGet(`${server.url}/json`);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a desktop that never welcomes holds requests no longer than waitForDesktop', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    desktop = await FakeDesktop.start({ mocks: [remoteConfig], autoWelcome: false });
    Durbun.start({ ...base, host: '127.0.0.1', port: desktop.port, waitForDesktop: 300 });
    const t0 = Date.now();
    const res = await xhrGet(`${server.url}/json`);
    expect(res.status).toBe(200);
    // 300 ms window, plus the 0.8 s handshake wait at most.
    expect(Date.now() - t0).toBeLessThan(1_600);
  });

  it('a waiting request can be aborted: abort event, reported as cancelled, never sent', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    desktop = await FakeDesktop.start({ autoWelcome: false });
    Durbun.start({ ...base, host: '127.0.0.1', port: desktop.port, waitForDesktop: 3_000 });
    const res = await xhrGet(`${server.url}/json?t=abort`, 50);
    expect(res.events).toEqual(['abort']);
    desktop.welcome(1);
    const err = await desktop.waitForMessage((m) => m.type === 'net.error');
    expect(err.cancelled).toBe(true);
    await sleep(50);
    expect(server.hits.length).toBe(0);
  });

  it('after the first welcome nothing waits again, even while reconnecting', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    desktop = await FakeDesktop.start({ mocks: [remoteConfig] });
    Durbun.start({ ...base, host: '127.0.0.1', port: desktop.port, waitForDesktop: 5_000 });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');
    await desktop.close();
    desktop = undefined;
    const t0 = Date.now();
    expect((await xhrGet(`${server.url}/json`)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
