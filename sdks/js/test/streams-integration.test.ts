/**
 * WebSocket messages and Server-Sent Events end to end, through the fake desktop: the `config.captureStreams`
 * gate (an older desktop gets nothing; a `config` message starts and stops it at once), payload caps, the
 * order of Blob messages, close and failure paths, SSE over fetch (real HTTP) and over a React-Native-style
 * XMLHttpRequest, the bounded buffer, and the SDK's own socket. Every message the SDK sends goes through the
 * desktop's validator unchanged.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WsClient, { WebSocketServer } from 'ws';
import { parseSdkMessage } from '../../../packages/server/src/sdk/validate';
import { Durbun } from '../src/index.js';
import type { SdkConfig } from '../src/protocol.js';
import { closedPort } from './helpers/httpServer.js';
import { FakeDesktop, sleep, waitFor, type FakeDesktopOptions } from './helpers/fakeDesktop.js';

const g = globalThis as Record<string, any>;
const NodeWebSocket = g.WebSocket; // undici: Blob messages by default
const savedXhr = g.XMLHttpRequest;

/* ────────────────────────────── servers ────────────────────────────── */

let wss: WebSocketServer;
let wsUrl = '';
const handshakes: http.IncomingHttpHeaders[] = [];

let api: http.Server;
let apiUrl = '';
let liveClosed = 0;

const EVENTS_TEXT = 'retry: 3000\r\nid: 1\r\nevent: queue\r\ndata: {"n":1}\r\n\r\n: keep-alive\n\ndata: ğüş 🔭\ndata: line 2\n\nid: 2\ndata: son\n\n';
const EVENTS_BYTES = Buffer.from(EVENTS_TEXT, 'utf8');
/** Cut inside "\r\n", inside "ş" and inside the telescope emoji. */
const CUTS = [12, EVENTS_BYTES.indexOf(Buffer.from('ş')) + 1, EVENTS_BYTES.indexOf(Buffer.from('🔭')) + 2];

beforeAll(async () => {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (sock, req) => {
    handshakes.push(req.headers);
    sock.on('message', (data, isBinary) => {
      const text = isBinary ? undefined : String(data);
      if (text === 'close-me') sock.close(4000, 'bye');
      else if (text === 'ping-me') sock.ping('srv');
      else if (text === 'kill') sock.terminate();
      else if (text === 'mixed') {
        sock.send(Buffer.from([1, 2, 3]));
        sock.send('between');
        sock.send(Buffer.from([4, 5]));
      } else sock.send(data, { binary: isBinary });
    });
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/chat`;

  api = http.createServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let at = 0;
      for (const cut of [...CUTS, EVENTS_BYTES.length]) {
        res.write(EVENTS_BYTES.subarray(at, cut));
        at = cut;
        await sleep(15);
      }
      res.end();
    } else if (req.url === '/live') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      const timer = setInterval(() => res.write('data: tick\n\n'), 30);
      res.on('close', () => {
        clearInterval(timer);
        liveClosed++;
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  api.closeAllConnections?.();
  await new Promise<void>((r) => api.close(() => r()));
});

/* ────────────────────────────── SDK ────────────────────────────── */

let desktop: FakeDesktop | undefined;
const STREAMS_ON: Partial<SdkConfig> = { captureStreams: true, maxStreamMessageBytes: 65_536 };

async function start(desktopOpts: FakeDesktopOptions = {}, transport: unknown = WsClient) {
  desktop = await FakeDesktop.start(desktopOpts);
  Durbun.start({
    host: '127.0.0.1',
    port: desktop.port,
    enabled: true,
    captureConsole: false,
    captureMetrics: false,
    captureErrors: false,
    ...(transport ? { WebSocket: transport as any } : {}),
  });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

/** Sends a full config (as the desktop does) and waits until the SDK has applied it. */
async function setConfig(d: FakeDesktop, patch: Partial<SdkConfig>) {
  d.config = { ...d.config, ...patch };
  for (const key of Object.keys(patch) as Array<keyof SdkConfig>) if (patch[key] === undefined) delete d.config[key];
  d.broadcast({ type: 'config', config: d.config });
  await d.barrier();
}

interface AppSocket {
  ws: any;
  inbox: unknown[];
}

async function connect(...args: unknown[]): Promise<AppSocket> {
  const WS = g.WebSocket;
  const ws = new WS(...args);
  const inbox: unknown[] = [];
  ws.addEventListener('message', (ev: any) => inbox.push(ev.data));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('connect failed')));
  });
  return { ws, inbox };
}

async function roundTrip(s: AppSocket, data: unknown, replies = 1): Promise<void> {
  const want = s.inbox.length + replies;
  s.ws.send(data);
  await waitFor(() => s.inbox.length >= want, 5_000, 'echo');
}

function closed(s: AppSocket): Promise<void> {
  return new Promise((r) => s.ws.addEventListener('close', () => r()));
}

const streamMessages = (d: FakeDesktop) => d.messages().filter((m) => m.type === 'net.ws' || m.type === 'net.sse');
const ofEntry = (d: FakeDesktop, id: string) => d.messages().filter((m) => m.id === id && m.type !== 'command.result');
const strip = (msgs: any[]) => msgs.map(({ ts, id, ...rest }) => rest);

afterEach(async () => {
  const d = desktop;
  Durbun.stop();
  g.WebSocket = NodeWebSocket;
  if (savedXhr === undefined) delete g.XMLHttpRequest;
  else g.XMLHttpRequest = savedXhr;
  desktop = undefined;
  handshakes.length = 0;
  if (!d) return;
  await d.close();
  const all = d.messages();
  const hello = all.find((m) => m.type === 'hello');
  expect(hello.capabilities).toContain('streams');
  for (const msg of all) {
    // The SDK's own connection is never captured.
    if (typeof msg.url === 'string') expect(msg.url).not.toContain(`:${d.port}`);
    if (msg.type === 'hello') continue;
    expect(parseSdkMessage(msg), JSON.stringify(msg).slice(0, 300)).toEqual(msg);
  }
});

/* ────────────────────────────── WebSocket ────────────────────────────── */

describe('WebSocket messages', () => {
  it('an older desktop (no captureStreams in its config) gets no stream messages and no socket entries', async () => {
    g.WebSocket = WsClient;
    const d = await start();
    const s = await connect(wsUrl);
    await roundTrip(s, 'hello');
    s.ws.close(1000, 'done');
    await closed(s);
    const sse = await fetch(`${apiUrl}/events`);
    expect(await sse.text()).toBe(EVENTS_TEXT);
    await d.barrier();
    expect(streamMessages(d)).toEqual([]);
    expect(d.messages('net.request').map((m) => m.url)).toEqual([`${apiUrl}/events`]);
    // The event stream is reported as before: headers, size only.
    const res = await d.waitForMessage((m) => m.type === 'net.response');
    expect(res.status).toBe(200);
  });

  it('a config message starts and stops them at once; a socket opened before is reported from then on', async () => {
    g.WebSocket = WsClient;
    const d = await start();
    const s = await connect(wsUrl, 'chat.v2', { headers: { 'X-Token': 'abc' } });
    await roundTrip(s, 'a: before');
    await setConfig(d, STREAMS_ON);
    await roundTrip(s, 'b: on');
    await setConfig(d, { captureStreams: false });
    await roundTrip(s, 'c: off');
    await setConfig(d, { captureStreams: true });
    await roundTrip(s, 'd: on again');
    s.ws.close(1000, 'done');
    await closed(s);
    await d.barrier();

    // The app's own handshake went out unchanged.
    expect(handshakes[0]['x-token']).toBe('abc');
    expect(handshakes[0]['sec-websocket-protocol']).toBe('chat.v2');
    const request = d.messages('net.request').find((m) => m.url === wsUrl);
    expect(request).toMatchObject({ method: 'GET', source: 'websocket' });
    expect(request.headers).toEqual(expect.arrayContaining([['Sec-WebSocket-Protocol', 'chat.v2'], ['X-Token', 'abc']]));
    expect(strip(ofEntry(d, request.id).slice(1))).toEqual([
      {
        type: 'net.response',
        status: 101,
        statusText: 'Switching Protocols',
        headers: [['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Protocol', 'chat.v2']],
        timings: { wait: expect.any(Number) },
      },
      { type: 'net.ws', dir: 'out', opcode: 'text', size: 5, body: { encoding: 'utf8', data: 'b: on', size: 5 } },
      { type: 'net.ws', dir: 'in', opcode: 'text', size: 5, body: { encoding: 'utf8', data: 'b: on', size: 5 } },
      { type: 'net.ws', dir: 'out', opcode: 'text', size: 11, body: { encoding: 'utf8', data: 'd: on again', size: 11 } },
      { type: 'net.ws', dir: 'in', opcode: 'text', size: 11, body: { encoding: 'utf8', data: 'd: on again', size: 11 } },
      { type: 'net.ws', dir: 'out', opcode: 'close', size: 6, closeCode: 1000, closeReason: 'done' },
      { type: 'net.ws', dir: 'in', opcode: 'close', size: 6, closeCode: 1000, closeReason: 'done' },
    ]);
    // Handshake first, then the messages: the 101 keeps its time, the request its start.
    const [req, res] = ofEntry(d, request.id);
    expect(req.ts).toBeLessThanOrEqual(res.ts);
  });

  it('payloads are cut at maxStreamMessageBytes; 0 sends sizes only', async () => {
    g.WebSocket = WsClient;
    const d = await start({ config: { captureStreams: true, maxStreamMessageBytes: 8 } });
    const s = await connect(wsUrl);
    s.ws.binaryType = 'arraybuffer';
    await roundTrip(s, 'ğ'.repeat(10));
    await roundTrip(s, new Uint8Array(20).fill(255));
    await setConfig(d, { maxStreamMessageBytes: 0 });
    await roundTrip(s, 'sizes only');
    await d.barrier();
    expect(strip(streamMessages(d))).toEqual([
      { type: 'net.ws', dir: 'out', opcode: 'text', size: 20, body: { encoding: 'utf8', data: 'ğğğğ', size: 20, truncated: true } },
      { type: 'net.ws', dir: 'in', opcode: 'text', size: 20, body: { encoding: 'utf8', data: 'ğğğğ', size: 20, truncated: true } },
      { type: 'net.ws', dir: 'out', opcode: 'binary', size: 20, body: { encoding: 'base64', data: '//////////8=', size: 20, truncated: true } },
      { type: 'net.ws', dir: 'in', opcode: 'binary', size: 20, body: { encoding: 'base64', data: '//////////8=', size: 20, truncated: true } },
      { type: 'net.ws', dir: 'out', opcode: 'text', size: 10 },
      { type: 'net.ws', dir: 'in', opcode: 'text', size: 10 },
    ]);
    // The app received its messages intact.
    expect(s.inbox[0]).toBe('ğ'.repeat(10));
    expect(new Uint8Array(s.inbox[1] as ArrayBuffer)).toEqual(new Uint8Array(20).fill(255));
  });

  it('Blob messages (the runtime default here, as in React Native) keep their order', async () => {
    g.WebSocket = NodeWebSocket;
    const d = await start({ config: STREAMS_ON });
    const s = await connect(wsUrl);
    expect(s.ws.binaryType).toBe('blob');
    expect(s.ws).toBeInstanceOf(NodeWebSocket);
    await roundTrip(s, 'mixed', 3);
    s.ws.send(new Blob([new Uint8Array([9, 8])]));
    await waitFor(() => s.inbox.length >= 4, 5_000, 'blob echo');
    s.ws.close();
    await closed(s);
    await waitFor(() => streamMessages(d).some((m) => m.opcode === 'close' && m.dir === 'in'), 5_000, 'close');
    expect(strip(streamMessages(d))).toEqual([
      { type: 'net.ws', dir: 'out', opcode: 'text', size: 5, body: { encoding: 'utf8', data: 'mixed', size: 5 } },
      { type: 'net.ws', dir: 'in', opcode: 'binary', size: 3, body: { encoding: 'base64', data: 'AQID', size: 3 } },
      { type: 'net.ws', dir: 'in', opcode: 'text', size: 7, body: { encoding: 'utf8', data: 'between', size: 7 } },
      { type: 'net.ws', dir: 'in', opcode: 'binary', size: 2, body: { encoding: 'base64', data: 'BAU=', size: 2 } },
      { type: 'net.ws', dir: 'out', opcode: 'binary', size: 2, body: { encoding: 'base64', data: 'CQg=', size: 2 } },
      { type: 'net.ws', dir: 'in', opcode: 'binary', size: 2, body: { encoding: 'base64', data: 'CQg=', size: 2 } },
      { type: 'net.ws', dir: 'out', opcode: 'close', size: 0 },
      { type: 'net.ws', dir: 'in', opcode: 'close', size: 0 },
    ]);
    // The app still reads its Blobs.
    expect(new Uint8Array(await (s.inbox[0] as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('server close, a broken connection and a refused connect', async () => {
    g.WebSocket = WsClient;
    const d = await start({ config: STREAMS_ON });
    const a = await connect(wsUrl);
    a.ws.send('close-me');
    await closed(a);
    const b = await connect(wsUrl);
    b.ws.send('kill');
    await closed(b);
    const port = await closedPort();
    await connect(`ws://127.0.0.1:${port}/nobody`).catch(() => undefined);
    await waitFor(() => d.messages('net.error').length >= 2, 5_000, 'errors');

    const [ra, rb, rc] = d.messages('net.request');
    expect(strip(ofEntry(d, ra.id).slice(2))).toEqual([
      { type: 'net.ws', dir: 'out', opcode: 'text', size: 8, body: { encoding: 'utf8', data: 'close-me', size: 8 } },
      { type: 'net.ws', dir: 'in', opcode: 'close', size: 5, closeCode: 4000, closeReason: 'bye' },
    ]);
    expect(ofEntry(d, rb.id).slice(-1)[0]).toMatchObject({ type: 'net.error', error: expect.stringMatching(/^Connection lost/) });
    expect(ofEntry(d, rb.id).find((m) => m.type === 'net.error').cancelled).toBeUndefined();
    // Never opened: a failed request, no 101 and no stream.
    expect(ofEntry(d, rc.id).map((m) => m.type)).toEqual(['net.request', 'net.error']);
  });

  it("ping / pong where the runtime shows them (Node's ws): the app's ping, the server's ping, the pong", async () => {
    g.WebSocket = WsClient;
    const d = await start({ config: STREAMS_ON });
    const s = await connect(wsUrl);
    const pong = new Promise<void>((r) => s.ws.once('pong', () => r()));
    s.ws.ping('hb');
    await pong;
    const ping = new Promise<void>((r) => s.ws.once('ping', () => r()));
    s.ws.send('ping-me');
    await ping;
    await waitFor(() => streamMessages(d).length >= 4, 5_000, 'control frames');
    expect(strip(streamMessages(d))).toEqual([
      { type: 'net.ws', dir: 'out', opcode: 'ping', size: 2, body: { encoding: 'utf8', data: 'hb', size: 2 } },
      { type: 'net.ws', dir: 'in', opcode: 'pong', size: 2, body: { encoding: 'base64', data: 'aGI=', size: 2 } },
      { type: 'net.ws', dir: 'out', opcode: 'text', size: 7, body: { encoding: 'utf8', data: 'ping-me', size: 7 } },
      { type: 'net.ws', dir: 'in', opcode: 'ping', size: 3, body: { encoding: 'base64', data: 'c3J2', size: 3 } },
    ]);
  });

  it("the SDK's own socket (the same global WebSocket class) is never captured", async () => {
    g.WebSocket = WsClient;
    const d = await start({ config: STREAMS_ON }, null);
    const s = await connect(wsUrl);
    await roundTrip(s, 'x');
    Durbun.info('a log line travels over the SDK socket');
    await d.waitForMessage((m) => m.type === 'log');
    expect(g.WebSocket).not.toBe(WsClient);
    expect(d.messages('net.request').map((m) => m.url)).toEqual([wsUrl]);
  });
});

/* ────────────────────────────── Server-Sent Events ────────────────────────────── */

const EXPECTED_EVENTS = [
  { type: 'net.sse', size: 7, event: 'queue', eventId: '1', retry: 3000, body: { encoding: 'utf8', data: '{"n":1}', size: 7 } },
  { type: 'net.sse', size: 18, body: { encoding: 'utf8', data: 'ğüş 🔭\nline 2', size: 18 } },
  { type: 'net.sse', size: 3, eventId: '2', body: { encoding: 'utf8', data: 'son', size: 3 } },
];

describe('Server-Sent Events over fetch', () => {
  it('headers at once without a body, one message per event (chunks split anywhere), then the end', async () => {
    const d = await start({ config: STREAMS_ON });
    const res = await fetch(`${apiUrl}/events`);
    expect(res).toBeInstanceOf(Response);
    expect(res.url).toBe(`${apiUrl}/events`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    // The app read exactly what the server sent.
    expect(Buffer.concat(chunks).toString('utf8')).toBe(EVENTS_TEXT);
    const end = await d.waitForMessage((m) => m.type === 'net.sse' && m.end === true);
    const entry = ofEntry(d, end.id);
    expect(entry[1]).toMatchObject({ type: 'net.response', status: 200 });
    expect(entry[1].body).toBeUndefined();
    expect(strip(entry.slice(2))).toEqual([...EXPECTED_EVENTS, { type: 'net.sse', end: true }]);
  });

  it('response.text() works on the stream and the events are still reported', async () => {
    const d = await start({ config: STREAMS_ON });
    const res = await fetch(`${apiUrl}/events`);
    expect(await res.text()).toBe(EVENTS_TEXT);
    const end = await d.waitForMessage((m) => m.type === 'net.sse' && m.end === true);
    expect(strip(ofEntry(d, end.id).slice(2, -1))).toEqual(EXPECTED_EVENTS);
  });

  it('the app cancelling its reader closes the connection and ends the stream as cancelled', async () => {
    const d = await start({ config: { ...STREAMS_ON, maxStreamMessageBytes: 3 } });
    const before = liveClosed;
    const res = await fetch(`${apiUrl}/live`);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitFor(() => liveClosed > before, 5_000, 'server saw the close');
    const err = await d.waitForMessage((m) => m.type === 'net.error');
    expect(err).toMatchObject({ error: 'Stream closed by the app', cancelled: true });
    const events = ofEntry(d, err.id).filter((m) => m.type === 'net.sse');
    expect(strip(events.slice(0, 1))).toEqual([{ type: 'net.sse', size: 5, body: { encoding: 'utf8', data: 'fir', size: 5, truncated: true } }]);
  });

  it('aborting the fetch ends the stream as cancelled', async () => {
    const d = await start({ config: STREAMS_ON });
    const ctrl = new AbortController();
    const res = await fetch(`${apiUrl}/live`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    await expect(reader.read()).rejects.toThrow();
    const err = await d.waitForMessage((m) => m.type === 'net.error');
    expect(err).toMatchObject({ error: 'Stream closed by the app', cancelled: true });
  });
});

/** React Native's XMLHttpRequest as SSE libraries use it (react-native-sse): text grows chunk by chunk. */
class StreamXhr {
  static made: StreamXhr[] = [];
  readyState = 0;
  status = 0;
  responseType = '';
  timeout = 0;
  _response = '';
  _incrementalEvents = false;
  _raw = '';
  _listeners: Record<string, Array<(ev: any) => void>> = {};
  onreadystatechange: ((ev: any) => void) | null = null;
  url = '';

  get responseText(): string {
    return this._response;
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    if (type === 'readystatechange' || type === 'progress') this._incrementalEvents = true;
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type: string, fn: (ev: any) => void): void {
    this._listeners[type] = (this._listeners[type] || []).filter((l) => l !== fn);
  }
  dispatchEvent(ev: { type: string }): boolean {
    for (const l of (this._listeners[ev.type] || []).slice()) l.call(this, ev);
    const h = (this as any)['on' + ev.type];
    if (typeof h === 'function') h.call(this, ev);
    return true;
  }
  open(_method: string, url: string): void {
    this.url = url;
    this.readyState = 1;
    StreamXhr.made.push(this);
  }
  setRequestHeader(): void {}
  getAllResponseHeaders(): string {
    return this.readyState >= 2 ? this._raw : '';
  }
  send(): void {}
  abort(): void {
    this._response = '';
    this.readyState = 4;
    this.dispatchEvent({ type: 'readystatechange' });
    this.dispatchEvent({ type: 'abort' });
    this.dispatchEvent({ type: 'loadend' });
  }
  /* drivers */
  headers(status: number, raw: string): void {
    this.status = status;
    this._raw = raw;
    this.readyState = 2;
    this.dispatchEvent({ type: 'readystatechange' });
  }
  chunk(text: string): void {
    this._response += text;
    this.readyState = 3;
    this.dispatchEvent({ type: 'readystatechange' });
    this.dispatchEvent({ type: 'progress' });
  }
  finish(): void {
    this.readyState = 4;
    this.dispatchEvent({ type: 'readystatechange' });
    this.dispatchEvent({ type: 'load' });
    this.dispatchEvent({ type: 'loadend' });
  }
}

describe('Server-Sent Events over XMLHttpRequest (React Native)', () => {
  it('events from the growing responseText, the end, and an abort by the app', async () => {
    g.XMLHttpRequest = StreamXhr;
    StreamXhr.made = [];
    const d = await start({ config: STREAMS_ON });
    const appSaw: string[] = [];
    const open = (url: string) => {
      const xhr = new g.XMLHttpRequest();
      xhr.addEventListener('readystatechange', () => appSaw.push(`${xhr.readyState}:${xhr.responseText.length}`));
      xhr.open('GET', url);
      xhr.send();
      return StreamXhr.made[StreamXhr.made.length - 1];
    };
    const a = open('https://api.example.com/queue');
    a.headers(200, 'content-type: text/event-stream\r\n');
    // The app's listener switched the request to incremental delivery, not ours.
    expect(a._incrementalEvents).toBe(true);
    const text = EVENTS_TEXT;
    for (const [from, to] of [[0, 5], [5, 13], [13, 60], [60, text.length]]) a.chunk(text.slice(from, to));
    a.finish();
    const b = open('https://api.example.com/live');
    b.headers(200, 'content-type: text/event-stream; charset=utf-8\r\n');
    b.chunk('data: one\n\nda');
    b.abort();
    await d.barrier();

    const [ra, rb] = d.messages('net.request');
    expect(ofEntry(d, ra.id)[1]).toMatchObject({ type: 'net.response', status: 200 });
    expect(ofEntry(d, ra.id)[1].body).toBeUndefined();
    expect(strip(ofEntry(d, ra.id).slice(2))).toEqual([...EXPECTED_EVENTS, { type: 'net.sse', end: true }]);
    expect(strip(ofEntry(d, rb.id).slice(2))).toEqual([
      { type: 'net.sse', size: 3, body: { encoding: 'utf8', data: 'one', size: 3 } },
      { type: 'net.error', error: 'Stream closed by the app', cancelled: true },
    ]);
    expect(appSaw.length).toBeGreaterThan(5);
  });

  it('without captureStreams the response is reported as before and no event is sent', async () => {
    g.XMLHttpRequest = StreamXhr;
    StreamXhr.made = [];
    const d = await start();
    const xhr = new g.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/queue');
    xhr.send();
    const x = StreamXhr.made[0];
    x.headers(200, 'content-type: text/event-stream\r\ncontent-length: 100\r\n');
    x.chunk('data: one\n\n');
    x.finish();
    await d.barrier();
    expect(streamMessages(d)).toEqual([]);
    expect(d.messages('net.response')[0].body).toEqual({ encoding: 'utf8', data: '', size: 100, truncated: true });
    expect(d.messages('net.error')).toEqual([]);
  });
});

/* ────────────────────────────── bounded buffer ────────────────────────────── */

class QuietSocket {
  static OPEN = 1;
  readyState = 0;
  _listeners: Record<string, Array<(ev: any) => void>> = {};
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: any) => void): void {
    (this._listeners[type] ||= []).push(fn);
  }
  dispatchEvent(ev: { type: string }): boolean {
    for (const l of this._listeners[ev.type] || []) l(ev);
    return true;
  }
  send(): void {}
  close(): void {}
  open(): void {
    this.readyState = 1;
    this.dispatchEvent({ type: 'open' });
  }
  receive(data: string): void {
    this.dispatchEvent({ type: 'message', data } as any);
  }
}

describe('buffer while the desktop is away', () => {
  it('a busy socket drops its own oldest messages; logs and requests are kept', async () => {
    g.WebSocket = QuietSocket;
    const d = await start({ config: STREAMS_ON });
    const ws = new g.WebSocket('wss://feed.example.com/prices');
    ws.open();
    ws.receive('connected');
    await d.waitForMessage((m) => m.type === 'net.ws');
    d.dropConnections();
    await waitFor(() => !Durbun.isConnected, 5_000, 'disconnect');
    for (let i = 0; i < 1_500; i++) {
      ws.receive(`price ${i}`);
      if (i % 100 === 0) Durbun.info(`log ${i}`);
    }
    await waitFor(() => d.messages().some((m) => m.type === 'log' && /WebSocket \/ SSE message/.test(m.message)), 10_000, 'drop warning');
    const prices = streamMessages(d).map((m) => m.body?.data).filter((t) => /^price/.test(t));
    expect(prices).toHaveLength(1_000);
    expect(prices[0]).toBe('price 500');
    expect(prices[prices.length - 1]).toBe('price 1499');
    expect(d.logs().filter((m) => /^log \d+$/.test(m.message))).toHaveLength(15);
    // Everything arrives in the order it happened.
    const order = d.messages().filter((m) => m.type === 'log' || m.type === 'net.ws').map((m) => (m.type === 'log' ? m.message : m.body?.data));
    expect(order.indexOf('log 600')).toBeGreaterThan(order.indexOf('price 600'));
    expect(order.indexOf('log 600')).toBeLessThan(order.indexOf('price 601'));
  });

  it('stream messages kept for a desktop that no longer asks for them are not sent', async () => {
    g.WebSocket = QuietSocket;
    const d = await start({ config: STREAMS_ON });
    const ws = new g.WebSocket('wss://feed.example.com/prices');
    ws.open();
    d.config = { captureBodies: true, maxBodyBytes: 1_048_576, metricsIntervalMs: 1_000, deviceLogsAvailable: false };
    d.dropConnections();
    await waitFor(() => !Durbun.isConnected, 5_000, 'disconnect');
    ws.receive('while away');
    Durbun.info('also while away');
    await waitFor(() => d.logs().some((m) => m.message === 'also while away'), 10_000, 'reconnect');
    await d.barrier();
    expect(streamMessages(d)).toEqual([]);
  });
});
