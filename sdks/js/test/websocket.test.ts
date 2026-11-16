/**
 * The WebSocket and EventSource wrappers against fakes (a React-Native-like socket with plain-object events,
 * a browser-like EventSource): the app sees its own class, every message is reported once and in order,
 * and nothing is reported while the host does not ask for streams.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installEventSourcePatch, isNativeConstructor } from '../src/eventSource.js';
import type { NetworkHost } from '../src/network.js';
import { restoreAll, type Patch } from '../src/patch.js';
import { handshakeHeaders, installWebSocketPatch } from '../src/websocket.js';

type Listener = (ev: any) => void;

class Events {
  listeners: Record<string, Listener[]> = {};
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] || []).filter((l) => l !== fn);
  }
  dispatchEvent(ev: { type: string }): boolean {
    for (const l of (this.listeners[ev.type] || []).slice()) l.call(this, ev);
    const handler = (this as any)['on' + ev.type];
    if (typeof handler === 'function') handler.call(this, ev);
    return true;
  }
}

/** React Native's WebSocket, as far as the patch can tell: public fields, plain-object events, Blob messages. */
class RnSocket extends Events {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static made: RnSocket[] = [];
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  readyState = 0;
  binaryType = 'blob';
  protocol = '';
  extensions = '';
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;
  sent: unknown[] = [];
  closedWith: unknown[] | undefined;
  readonly args: unknown[];

  constructor(...args: unknown[]) {
    super();
    if (!args.length) throw new TypeError('url required');
    this.args = args;
    RnSocket.made.push(this);
  }
  send(data: unknown): void {
    if (this.readyState === 0) throw new Error('INVALID_STATE_ERR');
    this.sent.push(data);
  }
  close(...args: unknown[]): void {
    this.closedWith = args;
    if (this.readyState >= 2) return;
    this.readyState = 2;
  }
  pings = 0;
  /** React Native's own extra: send a ping frame. */
  ping(): void {
    this.pings++;
  }
  /* test drivers */
  serverOpen(protocol = ''): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.dispatchEvent({ type: 'open' });
  }
  receive(data: unknown): void {
    this.dispatchEvent({ type: 'message', data } as any);
  }
  closed(code: number, reason = ''): void {
    this.readyState = 3;
    this.dispatchEvent({ type: 'close', code, reason } as any);
  }
  fail(message: string): void {
    this.readyState = 3;
    this.dispatchEvent({ type: 'error', message } as any);
    this.dispatchEvent({ type: 'close', code: 1006, reason: message } as any);
  }
}

function fakeHost(cap: number | undefined) {
  const sent: any[] = [];
  let seq = 0;
  const host = {
    cap,
    bodyConfig: { captureBodies: true, maxBodyBytes: 1_000_000 },
    nextRequestId: () => String(++seq),
    emit: (m: any) => sent.push(m),
    notice: () => undefined,
    mocksPending: () => undefined,
    findMock: () => undefined,
    isIgnored: (url: string) => url.includes('127.0.0.1:9750'),
    debug: () => undefined,
    streamCapture: () => host.cap,
  };
  return { host: host as NetworkHost & { cap: number | undefined }, sent };
}

/** Messages without their timestamps (compared exactly otherwise). */
const plain = (msgs: any[]) => msgs.map(({ ts, ...rest }) => rest);

const g = globalThis as Record<string, any>;
let patches: Patch[] = [];
const savedWs = g.WebSocket;
const savedEs = g.EventSource;
const savedReader = g.FileReader;

beforeEach(() => {
  RnSocket.made = [];
  g.WebSocket = RnSocket;
});
afterEach(() => {
  restoreAll(patches);
  patches = [];
  g.WebSocket = savedWs;
  g.EventSource = savedEs;
  g.FileReader = savedReader;
});

function patchWs(cap: number | undefined, runtime: 'react-native' | 'web' = 'react-native') {
  const fake = fakeHost(cap);
  patches = installWebSocketPatch(fake.host, runtime);
  return { ...fake, WS: g.WebSocket as typeof RnSocket };
}

describe('WebSocket wrapper: the app keeps its class', () => {
  it('instanceof, statics, name, constructor arguments, handlers and listeners are the original ones', () => {
    const { WS } = patchWs(100);
    expect(WS).not.toBe(RnSocket);
    expect(WS.name).toBe('RnSocket');
    expect(WS.OPEN).toBe(1);
    expect(WS.CLOSED).toBe(3);
    const options = { headers: { Authorization: 'Bearer x' } };
    const ws = new WS('wss://chat.example.com/live', ['v2', 'v1'], options);
    expect(ws).toBeInstanceOf(RnSocket);
    expect(ws).toBeInstanceOf(WS);
    // An instance made through a reference taken before the patch still passes `instanceof WebSocket`.
    expect(new RnSocket('wss://x')).toBeInstanceOf(WS);
    expect(RnSocket.made[0].args).toEqual(['wss://chat.example.com/live', ['v2', 'v1'], options]);
    expect(new WS('wss://one').args).toEqual(['wss://one']);
    expect(() => new WS()).toThrow(TypeError);
    expect(ws.binaryType).toBe('blob');
    ws.binaryType = 'arraybuffer';
    expect(ws.binaryType).toBe('arraybuffer');
    const seen: string[] = [];
    ws.onmessage = (ev) => seen.push(`on:${ev.data}`);
    ws.addEventListener('message', (ev: any) => seen.push(`listener:${ev.data}`));
    ws.serverOpen();
    ws.receive('hi');
    expect(seen).toEqual(['listener:hi', 'on:hi']);
    // send / close are the original's, called synchronously with the same arguments.
    ws.send('out');
    expect(ws.sent).toEqual(['out']);
    ws.close(4001, 'bye');
    expect(ws.closedWith).toEqual([4001, 'bye']);
  });

  it("an app's own subclass keeps a plain instanceof", () => {
    const { WS } = patchWs(100);
    class AppSocket extends WS {}
    expect(new AppSocket('wss://a')).toBeInstanceOf(AppSocket);
    expect(new WS('wss://b')).not.toBeInstanceOf(AppSocket);
  });

  it('errors of the original reach the app unchanged (send while connecting)', () => {
    const { WS, sent } = patchWs(100);
    const ws = new WS('wss://x');
    expect(() => ws.send('early')).toThrow('INVALID_STATE_ERR');
    expect(sent.filter((m) => m.type === 'net.ws')).toEqual([]);
  });

  it('after restore the class is the original again and old instances are passthrough', () => {
    const { WS, sent } = patchWs(100);
    restoreAll(patches);
    patches = [];
    expect(g.WebSocket).toBe(RnSocket);
    const ws = new WS('wss://late');
    ws.serverOpen();
    ws.receive('x');
    expect(sent).toEqual([]);
  });
});

describe('WebSocket wrapper: what is reported', () => {
  it('handshake, 101, messages both ways, close frames from both sides', () => {
    const { WS, sent } = patchWs(1000, 'web');
    const ws = new WS('wss://chat.example.com/live?room=1', 'chat.v2', { headers: { 'X-Token': 'abc' } });
    ws.serverOpen('chat.v2');
    ws.send('{"type":"auth"}');
    ws.receive('{"ok":true}');
    ws.send(new Uint8Array([1, 2, 3]));
    ws.receive(new Uint8Array([200, 201]).buffer);
    ws.close(1000, 'done');
    ws.closed(1000, 'done');
    expect(plain(sent)).toEqual([
      {
        type: 'net.request',
        id: '1',
        method: 'GET',
        url: 'wss://chat.example.com/live?room=1',
        headers: [
          ['Connection', 'Upgrade'],
          ['Upgrade', 'websocket'],
          ['Sec-WebSocket-Version', '13'],
          ['Sec-WebSocket-Protocol', 'chat.v2'],
          ['X-Token', 'abc'],
        ],
        source: 'websocket',
      },
      {
        type: 'net.response',
        id: '1',
        status: 101,
        statusText: 'Switching Protocols',
        headers: [
          ['Connection', 'Upgrade'],
          ['Upgrade', 'websocket'],
          ['Sec-WebSocket-Protocol', 'chat.v2'],
        ],
        timings: { wait: expect.any(Number) },
      },
      { type: 'net.ws', id: '1', dir: 'out', opcode: 'text', size: 15, body: { encoding: 'utf8', data: '{"type":"auth"}', size: 15 } },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'text', size: 11, body: { encoding: 'utf8', data: '{"ok":true}', size: 11 } },
      { type: 'net.ws', id: '1', dir: 'out', opcode: 'binary', size: 3, body: { encoding: 'base64', data: 'AQID', size: 3 } },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'binary', size: 2, body: { encoding: 'base64', data: 'yMk=', size: 2 } },
      { type: 'net.ws', id: '1', dir: 'out', opcode: 'close', size: 6, closeCode: 1000, closeReason: 'done' },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'close', size: 6, closeCode: 1000, closeReason: 'done' },
    ]);
  });

  it('a server close first is an in close frame; nothing after the end', () => {
    const { WS, sent } = patchWs(1000);
    const ws = new WS('ws://10.0.2.2:8080/feed');
    ws.serverOpen();
    ws.closed(4000, 'restart');
    ws.receive('late');
    expect(plain(sent).slice(2)).toEqual([{ type: 'net.ws', id: '1', dir: 'in', opcode: 'close', size: 9, closeCode: 4000, closeReason: 'restart' }]);
  });

  it('React Native sends 1000 when close() gets no code; a 1005 close event has no code', () => {
    const { WS, sent } = patchWs(1000);
    const ws = new WS('ws://h/a');
    ws.serverOpen();
    ws.close();
    ws.closed(1005);
    expect(plain(sent).slice(2)).toEqual([
      { type: 'net.ws', id: '1', dir: 'out', opcode: 'close', size: 2, closeCode: 1000 },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'close', size: 0 },
    ]);
  });

  it('a connection that breaks after opening is a net.error with the handshake id', () => {
    const { WS, sent } = patchWs(1000);
    const ws = new WS('ws://h/a');
    ws.serverOpen();
    ws.receive('one');
    ws.fail('Software caused connection abort');
    expect(plain(sent).slice(2)).toEqual([
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'text', size: 3, body: { encoding: 'utf8', data: 'one', size: 3 } },
      { type: 'net.error', id: '1', error: 'Connection lost: Software caused connection abort' },
    ]);
  });

  it('a connect that fails before opening is a failed request, a close while connecting a cancelled one', () => {
    const { WS, sent } = patchWs(1000);
    new WS('ws://h/refused').fail('Failed to connect to /10.0.2.2:9999');
    const cancelled = new WS('ws://h/cancelled');
    cancelled.close();
    cancelled.closed(1006);
    expect(plain(sent).filter((m) => m.type !== 'net.request')).toEqual([
      { type: 'net.error', id: '1', error: 'Failed to connect to /10.0.2.2:9999' },
      { type: 'net.error', id: '2', error: 'Connection cancelled', cancelled: true },
    ]);
    expect(sent.filter((m) => m.type === 'net.response')).toEqual([]);
  });

  it('payloads are cut at the cap; cap 0 sends sizes only', () => {
    const { WS, sent, host } = patchWs(4);
    const ws = new WS('ws://h/a');
    ws.serverOpen();
    ws.receive('ğğğ');
    ws.send(new Uint8Array(10));
    host.cap = 0;
    ws.receive('hello');
    expect(plain(sent).slice(2)).toEqual([
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'text', size: 6, body: { encoding: 'utf8', data: 'ğğ', size: 6, truncated: true } },
      { type: 'net.ws', id: '1', dir: 'out', opcode: 'binary', size: 10, body: { encoding: 'base64', data: 'AAAAAA==', size: 10, truncated: true } },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'text', size: 5 },
    ]);
  });

  it('Blob messages keep the order the app saw them in, while their bytes are read', async () => {
    const { WS, sent } = patchWs(100);
    const ws = new WS('ws://h/a');
    ws.serverOpen();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new Blob([new Uint8Array([7, 7, 7])]);
    const original = slow.arrayBuffer.bind(slow);
    // A Blob whose bytes arrive late (React Native reads them over the bridge).
    (slow as any).arrayBuffer = () => gate.then(original);
    ws.receive(slow);
    ws.send('after the blob');
    ws.receive(new Blob(['fast']));
    ws.closed(1000);
    expect(sent.filter((m) => m.type === 'net.ws')).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(plain(sent).slice(2)).toEqual([
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'binary', size: 3, body: { encoding: 'base64', data: 'BwcH', size: 3 } },
      { type: 'net.ws', id: '1', dir: 'out', opcode: 'text', size: 14, body: { encoding: 'utf8', data: 'after the blob', size: 14 } },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'binary', size: 4, body: { encoding: 'base64', data: 'ZmFzdA==', size: 4 } },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'close', size: 2, closeCode: 1000 },
    ]);
    // The app can still read the Blob.
    expect([...new Uint8Array(await original())]).toEqual([7, 7, 7]);
  });

  it("React Native Blobs (no arrayBuffer) are read through FileReader as a data URL", async () => {
    class FakeReader {
      result: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: { data: string }) {
        setTimeout(() => {
          this.result = `data:application/octet-stream;base64,${Buffer.from(blob.data).toString('base64')}`;
          this.onload?.();
        }, 1);
      }
    }
    g.FileReader = FakeReader;
    const rnBlob = (data: string): any => ({ data, size: data.length, type: '', slice: (s = 0, e = data.length) => rnBlob(data.slice(s, e)) });
    const { WS, sent } = patchWs(3);
    const ws = new WS('ws://h/a');
    ws.serverOpen();
    ws.receive(rnBlob('abcdef'));
    ws.receive('next');
    await new Promise((r) => setTimeout(r, 20));
    expect(plain(sent).slice(2)).toEqual([
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'binary', size: 6, body: { encoding: 'base64', data: 'YWJj', size: 6, truncated: true } },
      { type: 'net.ws', id: '1', dir: 'in', opcode: 'text', size: 4, body: { encoding: 'utf8', data: 'nex', size: 4, truncated: true } },
    ]);
  });

  it('nothing while the host does not ask; a socket opened before it asked is reported from then on', () => {
    const { WS, sent, host } = patchWs(undefined);
    const ws = new WS('wss://chat.example.com/live', 'v1');
    ws.serverOpen('v1');
    ws.receive('before');
    ws.send('before');
    expect(sent).toEqual([]);
    host.cap = 100;
    ws.receive('now');
    host.cap = undefined;
    ws.send('off again');
    host.cap = 100;
    ws.send('back');
    expect(plain(sent).map((m) => [m.type, m.status ?? m.body?.data])).toEqual([
      ['net.request', undefined],
      ['net.response', 101],
      ['net.ws', 'now'],
      ['net.ws', 'back'],
    ]);
    // The handshake keeps its own times: start when the app created the socket.
    expect(sent[0].ts).toBeLessThanOrEqual(sent[1].ts);
  });

  it('a handshake reported while asked is completed even if the desktop stops asking', () => {
    const { WS, sent, host } = patchWs(100);
    const ws = new WS('ws://h/a');
    host.cap = undefined;
    ws.serverOpen();
    ws.receive('dropped');
    expect(plain(sent).map((m) => m.type)).toEqual(['net.request', 'net.response']);
  });

  it("React Native's ping() is reported as an out ping; a class without ping() gets none", () => {
    const { WS, sent } = patchWs(100);
    const ws = new WS('ws://h/a');
    ws.serverOpen();
    ws.ping();
    expect(ws.pings).toBe(1);
    expect(plain(sent).slice(2)).toEqual([{ type: 'net.ws', id: '1', dir: 'out', opcode: 'ping', size: 0 }]);
    restoreAll(patches);
    class Browserish extends Events {}
    g.WebSocket = Browserish;
    patches = installWebSocketPatch(fakeHost(100).host, 'web');
    expect('ping' in new g.WebSocket('ws://h')).toBe(false);
  });

  it("the desktop's own address is never captured", () => {
    const { WS, sent } = patchWs(100);
    const ws = new WS('ws://127.0.0.1:9750/sdk');
    ws.serverOpen();
    ws.receive('x');
    // Nor React DevTools in React Native dev builds.
    new WS('ws://localhost:8097').fail('refused');
    expect(sent).toEqual([]);
  });

  it('handshakeHeaders reads protocols and React Native header options', () => {
    expect(handshakeHeaders(['ws://h'])).toHaveLength(3);
    expect(handshakeHeaders(['ws://h', null, { headers: { Cookie: 'a=1', Skip: undefined, Num: 2 } }]).slice(3)).toEqual([
      ['Cookie', 'a=1'],
      ['Num', '2'],
    ]);
  });
});

/* ────────────────────────────── EventSource ────────────────────────────── */

class FakeEventSource extends Events {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  constructor(readonly url: string) {
    super();
  }
  close(): void {
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent({ type: 'open' });
  }
  event(type: string, data: string, lastEventId = ''): void {
    this.dispatchEvent({ type, data, lastEventId } as any);
  }
  drop(reconnect: boolean): void {
    this.readyState = reconnect ? 0 : 2;
    this.dispatchEvent({ type: 'error' });
  }
}

function patchEs(cap: number | undefined) {
  g.EventSource = FakeEventSource;
  const fake = fakeHost(cap);
  patches = installEventSourcePatch(fake.host, { nativeOnly: false });
  return { ...fake, ES: g.EventSource as typeof FakeEventSource };
}

describe('EventSource wrapper (browsers)', () => {
  it('a JavaScript EventSource (a polyfill on XHR / fetch) is left alone', () => {
    g.EventSource = FakeEventSource;
    expect(isNativeConstructor(FakeEventSource)).toBe(false);
    expect(isNativeConstructor(Date)).toBe(true);
    expect(installEventSourcePatch(fakeHost(100).host)).toEqual([]);
    expect(g.EventSource).toBe(FakeEventSource);
  });

  it('request, 200 headers, message and listened named events, a reconnect as a new entry, app close', () => {
    const { ES, sent } = patchEs(100);
    const es = new ES('https://api.example.com/queue');
    expect(es).toBeInstanceOf(FakeEventSource);
    const appSaw: string[] = [];
    es.addEventListener('queue', (ev: any) => appSaw.push(ev.data));
    es.open();
    es.event('message', 'hello', '1');
    es.event('queue', 'ğ', '2');
    es.event('unheard', 'never delivered to JavaScript');
    es.event('message', 'same id', '2');
    es.drop(true);
    es.open();
    es.event('message', 'again', '3');
    es.close();
    expect(appSaw).toEqual(['ğ']);
    expect(plain(sent)).toEqual([
      { type: 'net.request', id: '1', method: 'GET', url: 'https://api.example.com/queue', headers: [['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache']], source: 'eventsource' },
      { type: 'net.response', id: '1', status: 200, headers: [['Content-Type', 'text/event-stream']], timings: { wait: expect.any(Number) } },
      { type: 'net.sse', id: '1', size: 5, eventId: '1', body: { encoding: 'utf8', data: 'hello', size: 5 } },
      { type: 'net.sse', id: '1', size: 2, event: 'queue', eventId: '2', body: { encoding: 'utf8', data: 'ğ', size: 2 } },
      { type: 'net.sse', id: '1', size: 7, body: { encoding: 'utf8', data: 'same id', size: 7 } },
      { type: 'net.error', id: '1', error: 'Connection lost; reconnecting' },
      {
        type: 'net.request',
        id: '2',
        method: 'GET',
        url: 'https://api.example.com/queue',
        headers: [['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache'], ['Last-Event-ID', '2']],
        source: 'eventsource',
      },
      { type: 'net.response', id: '2', status: 200, headers: [['Content-Type', 'text/event-stream']], timings: { wait: expect.any(Number) } },
      { type: 'net.sse', id: '2', size: 5, eventId: '3', body: { encoding: 'utf8', data: 'again', size: 5 } },
      { type: 'net.error', id: '2', error: 'Stream closed by the app', cancelled: true },
    ]);
  });

  it('a connection refused before open is a failed request; nothing while not asked', () => {
    const { ES, sent, host } = patchEs(100);
    new ES('https://down.example.com/s').drop(false);
    expect(plain(sent).map((m) => [m.type, m.error])).toEqual([
      ['net.request', undefined],
      ['net.error', 'EventSource connection failed'],
    ]);
    sent.length = 0;
    host.cap = undefined;
    const quiet = new ES('https://api.example.com/q');
    quiet.open();
    quiet.event('message', 'x');
    quiet.close();
    expect(sent).toEqual([]);
  });
});
