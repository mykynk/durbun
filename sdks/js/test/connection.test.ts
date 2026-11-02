/** Connection state machine with a scripted WebSocket and fake timers (no network). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, DEFAULT_TIMING, type ConnectionHandlers, type WebSocketLike } from '../src/connection.js';
import type { SdkHello } from '../src/protocol.js';

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('INVALID_STATE_ERR');
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  // test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  fail(): void {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({ code: 1006 });
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  remoteClose(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1001 });
  }
  messages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const HELLO = { type: 'hello', session: 's1' } as unknown as SdkHello;
const WELCOME = { type: 'welcome', protocol: 1, server: 'durbun/test', appId: 'app:7', config: {}, mocks: [] };

function setup(urls = ['ws://a/sdk', 'ws://b/sdk']) {
  const events: string[] = [];
  const handlers: ConnectionHandlers = {
    hello: () => {
      events.push('hello');
      return HELLO;
    },
    welcome: (_m, url) => events.push(`welcome:${url}`),
    message: (m) => events.push(`message:${m.type}`),
    disconnected: () => events.push('disconnected'),
    debug: () => undefined,
  };
  const conn = new Connection(urls, FakeSocket as never, handlers, DEFAULT_TIMING);
  return { conn, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Connection', () => {
  it('races all candidates: the first to open gets the hello, the others are closed silently', () => {
    const { conn, events } = setup();
    conn.start();
    expect(FakeSocket.all.map((s) => s.url)).toEqual(['ws://a/sdk', 'ws://b/sdk']);
    const [a, b] = FakeSocket.all;
    b.open();
    expect(a.closed).toBe(true);
    expect(b.messages()).toEqual([HELLO]);
    expect(a.sent).toEqual([]);
    a.open(); // late open of the loser: ignored
    expect(events).toEqual(['hello']);
    expect(conn.isActive).toBe(false);
    b.receive(WELCOME);
    expect(conn.isActive).toBe(true);
    expect(conn.url).toBe('ws://b/sdk');
    expect(events).toEqual(['hello', 'welcome:ws://b/sdk']);
    expect(conn.send('{"type":"log"}')).toBe(true);
    expect(b.sent).toHaveLength(2);
    conn.stop();
  });

  it('answers ping with pong and forwards other messages only after welcome', () => {
    const { conn, events } = setup(['ws://a/sdk']);
    conn.start();
    const [a] = FakeSocket.all;
    a.open();
    a.receive({ type: 'mocks', rules: [] });
    expect(events).toEqual(['hello']);
    a.receive(WELCOME);
    a.receive({ type: 'ping', ts: 1 });
    expect(a.messages().at(-1)).toMatchObject({ type: 'pong' });
    a.receive({ type: 'config', config: {} });
    a.onmessage?.({ data: 'not json' });
    a.onmessage?.({ data: new ArrayBuffer(2) });
    expect(events).toEqual(['hello', 'welcome:ws://a/sdk', 'message:config']);
    conn.stop();
  });

  it('reconnects with backoff 0.5 s → 1 s → 2 s → 3 s → 3 s while nothing answers', () => {
    const { conn } = setup(['ws://a/sdk']);
    conn.start();
    const delays: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 5; i++) {
      const sock = FakeSocket.all.at(-1)!;
      sock.fail();
      const before = FakeSocket.all.length;
      // advance until the next attempt is created
      let waited = 0;
      while (FakeSocket.all.length === before && waited < 10_000) {
        vi.advanceTimersByTime(50);
        waited += 50;
      }
      delays.push(Date.now() - last);
      last = Date.now();
    }
    expect(delays).toEqual([500, 1000, 2000, 3000, 3000]);
    conn.stop();
  });

  it('resets the backoff after a welcome and reports the lost connection', () => {
    const { conn, events } = setup(['ws://a/sdk']);
    conn.start();
    FakeSocket.all[0].fail();
    vi.advanceTimersByTime(500);
    FakeSocket.all[1].fail();
    vi.advanceTimersByTime(1000);
    const s = FakeSocket.all[2];
    s.open();
    s.receive(WELCOME);
    s.remoteClose();
    expect(events).toContain('disconnected');
    expect(conn.isActive).toBe(false);
    expect(conn.send('x')).toBe(false);
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(4);
    conn.stop();
  });

  it('gives up on a socket without welcome after 10 s and on a silent link after 45 s', () => {
    const { conn, events } = setup(['ws://a/sdk']);
    conn.start();
    FakeSocket.all[0].open();
    vi.advanceTimersByTime(9_999);
    expect(FakeSocket.all[0].closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all[0].closed).toBe(true);
    vi.advanceTimersByTime(500);
    const s = FakeSocket.all[1];
    s.open();
    s.receive(WELCOME);
    vi.advanceTimersByTime(30_000);
    s.receive({ type: 'ping', ts: 1 }); // keeps the link alive
    vi.advanceTimersByTime(44_000);
    expect(s.closed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(s.closed).toBe(true);
    expect(events.filter((e) => e === 'disconnected')).toHaveLength(1);
    conn.stop();
  });

  it('times out connect attempts that never open', () => {
    const { conn } = setup(['ws://a/sdk', 'ws://b/sdk']);
    conn.start();
    vi.advanceTimersByTime(8_000);
    expect(FakeSocket.all.slice(0, 2).every((s) => s.closed)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(4);
    conn.stop();
  });

  it('a send() failure drops the socket and reconnects', () => {
    const { conn, events } = setup(['ws://a/sdk']);
    conn.start();
    const s = FakeSocket.all[0];
    s.open();
    s.receive(WELCOME);
    s.readyState = 2; // closing: send throws
    expect(conn.send('x')).toBe(false);
    expect(events).toContain('disconnected');
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(2);
    conn.stop();
  });

  it('stop() closes everything and never reconnects', () => {
    const { conn } = setup(['ws://a/sdk', 'ws://b/sdk']);
    conn.start();
    conn.stop();
    expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('a constructor that throws counts as a failed candidate', () => {
    let n = 0;
    const Throwing = function (this: unknown, url: string) {
      n++;
      if (url.includes('bad')) throw new SyntaxError('bad url');
      return new FakeSocket(url);
    } as unknown as new (url: string) => WebSocketLike;
    const conn = new Connection(['ws://bad', 'ws://good/sdk'], Throwing, {
      hello: () => HELLO,
      welcome: () => undefined,
      message: () => undefined,
      disconnected: () => undefined,
      debug: () => undefined,
    });
    conn.start();
    expect(n).toBe(2);
    FakeSocket.all[0].open();
    expect(FakeSocket.all[0].messages()).toEqual([HELLO]);
    conn.stop();
  });
});
