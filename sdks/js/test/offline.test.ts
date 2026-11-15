/**
 * Without a desktop: no body reads after the grace period, a bounded buffer that sheds bodies before rows,
 * the one-time "not connected" note; plus XHR streams and binary mocks in React Native.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WsClient from 'ws';
import { DurbunClient, MAX_BUFFERED_CHARS } from '../src/client.js';
import { DEFAULT_TIMING } from '../src/connection.js';
import { connectionHint } from '../src/hints.js';
import { Durbun } from '../src/index.js';
import type { MockRule } from '../src/protocol.js';
import { RingBuffer } from '../src/ringBuffer.js';
import { FakeDesktop, sleep, waitFor } from './helpers/fakeDesktop.js';
import { BINARY, closedPort, startHttpServer, type TestServer } from './helpers/httpServer.js';
import { DomXHR, RnXHR } from './helpers/xhrPolyfill.js';

let server: TestServer;
let desktop: FakeDesktop | undefined;
let client: DurbunClient | undefined;
const realBlob = globalThis.Blob;

beforeAll(async () => {
  server = await startHttpServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  client?.stop();
  client = undefined;
  Durbun.stop();
  globalThis.Blob = realBlob;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  vi.restoreAllMocks();
  await desktop?.close();
  desktop = undefined;
});

function startClient(port: number, timing: Partial<typeof DEFAULT_TIMING> = {}, opts: Record<string, unknown> = {}) {
  client = new DurbunClient(
    { host: '127.0.0.1', port, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient as never, ...opts },
    { ...DEFAULT_TIMING, backoffInitialMs: 50, backoffMaxMs: 100, ...timing },
  );
  client.start();
  return client;
}

function get(url: string, responseType = ''): Promise<any> {
  return new Promise((resolve) => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.onloadend = () => resolve(xhr);
    xhr.open('GET', url);
    if (responseType) xhr.responseType = responseType;
    xhr.send(null);
  });
}

const responses = (d: FakeDesktop) => d.received.map((r) => r.msg).filter((m) => m.type === 'net.response');

describe('no desktop: bodies', () => {
  it('reads bodies during the grace period after start, only sizes after it; both arrive once a desktop connects', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    const port = await closedPort();
    startClient(port, { noDesktopGraceMs: 300, connectHintMs: 60_000 });
    await get(`${server.url}/big?n=500&early`);
    await sleep(350);
    const late = await get(`${server.url}/big?n=700&late`);
    expect(late.responseText).toHaveLength(700); // the app's own response is untouched
    desktop = await FakeDesktop.start({ port });
    await waitFor(() => responses(desktop!).length >= 2, 8_000, 'buffered responses');
    const [early, idle] = responses(desktop);
    expect(early.body).toEqual({ encoding: 'utf8', data: 'a'.repeat(500), size: 500 });
    expect(idle.body).toEqual({ encoding: 'utf8', data: '', size: 700, truncated: true });
  });

  it('reads bodies again while connected, and for the grace period after the desktop went away', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    desktop = await FakeDesktop.start();
    const c = startClient(desktop.port, { noDesktopGraceMs: 300, connectHintMs: 60_000 });
    await waitFor(() => c.isConnected, 5_000, 'connection');
    expect(c.bodyConfig.captureBodies).toBe(true);
    await desktop.close();
    desktop = undefined;
    await waitFor(() => !c.isConnected, 5_000, 'disconnect');
    expect(c.bodyConfig.captureBodies).toBe(true);
    await sleep(350);
    expect(c.bodyConfig.captureBodies).toBe(false);
  });

  it('a JSON response is not serialized just to measure it', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    const port = await closedPort();
    startClient(port, { noDesktopGraceMs: 0, connectHintMs: 60_000 });
    const stringify = vi.spyOn(JSON, 'stringify');
    await get(`${server.url}/users`, 'json');
    const bodyStringify = stringify.mock.calls.filter(([v]) => Array.isArray(v) || (v && typeof v === 'object' && !('type' in (v as object))));
    expect(bodyStringify).toHaveLength(0);
  });
});

describe('buffer limit', () => {
  it('sheds the oldest bodies before any message', async () => {
    (globalThis as any).XMLHttpRequest = DomXHR;
    const port = await closedPort();
    const c = startClient(port, { noDesktopGraceMs: 60_000, connectHintMs: 60_000 });
    const n = 1_000_000;
    for (let i = 0; i < 10; i++) await get(`${server.url}/big?n=${n}&i=${i}`);
    desktop = await FakeDesktop.start({ port, config: { maxBodyBytes: 2_000_000 } });
    await waitFor(() => responses(desktop!).length >= 10, 10_000, 'ten responses');
    const got = responses(desktop);
    const withData = got.filter((m) => m.body.data.length === n);
    const shed = got.filter((m) => m.body.data === '' && m.body.truncated && m.body.size === n);
    expect(withData.length + shed.length).toBe(10);
    expect(withData.length).toBeLessThanOrEqual(Math.floor(MAX_BUFFERED_CHARS / n));
    expect(shed.length).toBeGreaterThan(0);
    // The oldest lost their bodies, the newest kept them; every request row is there; nothing was dropped.
    expect(got.slice(0, shed.length).every((m) => m.body.data === '')).toBe(true);
    expect(desktop.received.filter((r) => r.msg.type === 'net.request')).toHaveLength(10);
    expect(desktop.received.some((r) => r.msg.tag === 'durbun' && /dropped/.test(r.msg.message))).toBe(false);
    expect(c.isConnected).toBe(true);
  });

  it('RingBuffer: lighter forms first, oldest first, then eviction', () => {
    const buf = new RingBuffer<{ w: number; lite?: number }>(10, 10, (x) => (x.lite !== undefined ? { item: { w: x.lite }, weight: x.lite } : undefined));
    buf.push({ w: 4, lite: 1 }, 4);
    buf.push({ w: 4, lite: 1 }, 4);
    buf.push({ w: 4 }, 4); // 12 > 10: the first item shrinks to 1 → 9
    expect(buf.toArray().map((x) => x.w)).toEqual([1, 4, 4]);
    expect(buf.dropped).toBe(0);
    buf.push({ w: 4 }, 4); // 13: second shrinks → 10
    expect(buf.toArray().map((x) => x.w)).toEqual([1, 1, 4, 4]);
    buf.push({ w: 4 }, 4); // nothing left to shrink: evict the oldest until it fits
    expect(buf.totalWeight).toBeLessThanOrEqual(10);
    expect(buf.dropped).toBeGreaterThan(0);
    expect(buf.push({ w: 20, lite: 2 }, 20)).toBe(0); // too heavy alone, but its lighter form fits
    expect(buf.toArray().pop()).toEqual({ w: 2 });
  });
});

describe('not connected note', () => {
  it('is printed once, a while after start, and followed by a line when the connection works', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const port = await closedPort();
    startClient(port, { connectHintMs: 100 });
    await waitFor(() => info.mock.calls.length > 0, 3_000, 'note');
    await sleep(300);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain(`ws://127.0.0.1:${port}/sdk`);
    desktop = await FakeDesktop.start({ port });
    await waitFor(() => info.mock.calls.length > 1, 8_000, 'connected line');
    expect(info.mock.calls[1][0]).toBe(`[Dürbün] Connected to ws://127.0.0.1:${port}/sdk.`);
  });

  it('is not printed when a desktop accepts the app in time', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    desktop = await FakeDesktop.start();
    const c = startClient(desktop.port, { connectHintMs: 300 });
    await waitFor(() => c.isConnected, 5_000, 'connection');
    await sleep(400);
    expect(info).not.toHaveBeenCalled();
  });

  it('says what to do for each kind of device', () => {
    const local = ['ws://localhost:9750/sdk', 'ws://127.0.0.1:9750/sdk'];
    const android = connectionHint({ runtime: 'react-native', device: { platform: 'android', isPhysical: true }, urls: local, explicitHost: false });
    expect(android).toContain('Tried ws://localhost:9750/sdk, ws://127.0.0.1:9750/sdk.');
    expect(android).toContain('over USB');
    expect(android).toContain('Allow local network (Wi-Fi) connections');
    expect(android).not.toContain('adb reverse tcp:9750 tcp:9750');

    const iphone = connectionHint({ runtime: 'react-native', device: { platform: 'ios', isPhysical: true }, urls: [...local, 'ws://192.168.1.20:9750/sdk'], explicitHost: false });
    expect(iphone).toContain('only over Wi-Fi');
    expect(iphone).toContain("Durbun.start({ host: '192.168.1.20' })");
    expect(iphone).toContain('Local Network');

    const iphoneWithHost = connectionHint({ runtime: 'react-native', device: { platform: 'ios', isPhysical: true }, urls: ['ws://10.0.0.5:9750/sdk'], explicitHost: true });
    expect(iphoneWithHost).toContain('check that 10.0.0.5 is still the Mac');

    const sim = connectionHint({ runtime: 'react-native', device: { platform: 'ios', isPhysical: false }, urls: local, explicitHost: false });
    expect(sim).toContain('iOS Simulator: open Dürbün on this Mac');
    expect(sim).not.toContain('Wi-Fi');

    const web = connectionHint({ runtime: 'web', device: { platform: 'other' }, urls: local, explicitHost: false, openedUrl: local[0] });
    expect(web).toContain('accepted the connection but did not answer like Dürbün');
    expect(web).toContain('Open Dürbün on this computer');
  });
});

describe('XHR streams', () => {
  it.each([
    ['browser-like', DomXHR],
    ['react-native-like', RnXHR],
  ] as const)('%s: an event stream is reported when its headers arrive, not left pending', async (_style, XHRClass) => {
    (globalThis as any).XMLHttpRequest = XHRClass;
    desktop = await FakeDesktop.start();
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');
    const xhr = new (globalThis as any).XMLHttpRequest();
    const chunks: string[] = [];
    xhr.addEventListener('progress', () => chunks.push(xhr.responseText));
    xhr.onreadystatechange = () => undefined;
    xhr.open('GET', `${server.url}/sse`);
    xhr.send();
    const res = await desktop.waitForMessage((m) => m.type === 'net.response', 5_000, 'stream response');
    expect(xhr.readyState).toBeLessThan(4); // still open
    expect(res).toMatchObject({ status: 200, timings: { receive: 0 } });
    expect(res.headers.some(([k, v]: [string, string]) => k.toLowerCase() === 'content-type' && v === 'text/event-stream')).toBe(true);
    expect(res.body).toBeUndefined();
    xhr.abort();
    await sleep(200);
    expect(desktop.received.filter((r) => r.msg.type === 'net.error' || r.msg.type === 'net.response')).toHaveLength(1);
  });

  it('react-native-like: watching a request does not switch it to chunk-by-chunk delivery', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    desktop = await FakeDesktop.start();
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');
    const plain = new RnXHR();
    plain.onload = () => undefined;
    plain.open('GET', `${server.url}/users`);
    plain.send();
    expect(plain._incrementalEvents).toBe(false);
    const listening = new RnXHR();
    listening.addEventListener('progress', () => undefined);
    listening.open('GET', `${server.url}/users`);
    listening.send();
    expect(listening._incrementalEvents).toBe(true);
    await desktop.waitForMessage((m) => m.type === 'net.response', 5_000, 'response');
  });
});

/** React Native's Blob: string and Blob parts only, strings stored as UTF-8. */
class RnBlob {
  readonly bytes: Uint8Array;
  readonly type: string;
  constructor(parts: unknown[] = [], opts?: { type?: string }) {
    const out: number[] = [];
    for (const p of parts) {
      if (p instanceof ArrayBuffer || ArrayBuffer.isView(p)) throw new Error("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported");
      const b = p instanceof RnBlob ? p.bytes : Buffer.from(String(p), 'utf8');
      out.push(...b);
    }
    this.bytes = Uint8Array.from(out);
    this.type = opts?.type ?? '';
  }
  get size(): number {
    return this.bytes.length;
  }
}

describe('binary mocks in React Native', () => {
  function rule(id: string, url: string, body: Buffer, contentType: string): MockRule {
    return { id, name: id, enabled: true, method: '*', url, match: 'contains', createdAt: 0, action: { type: 'respond', status: 200, headers: [['content-type', contentType]], body: body.toString('base64'), bodyEncoding: 'base64' } };
  }

  it('UTF-8 bytes arrive intact in a Blob; other binary goes to the network instead of arriving corrupted', async () => {
    (globalThis as any).XMLHttpRequest = RnXHR;
    (globalThis as any).Blob = RnBlob;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">ü</svg>', 'utf8');
    desktop = await FakeDesktop.start({ mocks: [rule('svg', '/binary?svg', svg, 'image/svg+xml'), rule('png', '/binary?png', BINARY, 'image/png')] });
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');

    const mockedSvg = await get(`${server.url}/binary?svg`, 'blob');
    expect(Buffer.from((mockedSvg.response as RnBlob).bytes).equals(svg)).toBe(true);
    expect(server.hits.some((h) => h.path.includes('svg'))).toBe(false);

    const png = await get(`${server.url}/binary?png`, 'blob');
    const png2 = await get(`${server.url}/binary?png&again`, 'blob');
    expect(png.status).toBe(200);
    expect(png2.status).toBe(200);
    expect(server.hits.filter((h) => h.path.includes('png'))).toHaveLength(2); // real network
    const notes = await waitFor(() => {
      const n = desktop!.received.filter((r) => r.msg.type === 'log' && r.msg.tag === 'durbun');
      return n.length > 0 && n;
    }, 5_000, 'notice');
    await sleep(100);
    expect(desktop.received.filter((r) => r.msg.type === 'log' && r.msg.tag === 'durbun')).toHaveLength(1); // once per rule
    expect(notes[0].msg).toMatchObject({ level: 'warn' });
    expect(notes[0].msg.message).toContain('Mock rule "png" was not applied');
    const pngResponses = responses(desktop).filter((m) => !m.mocked);
    expect(pngResponses.length).toBeGreaterThanOrEqual(2);

    // arraybuffer responses carry any bytes: still mocked.
    const ab = await get(`${server.url}/binary?png&ab`, 'arraybuffer');
    expect(Buffer.from(ab.response).equals(BINARY)).toBe(true);
    expect(server.hits.filter((h) => h.path.includes('png'))).toHaveLength(2);
  });
});
