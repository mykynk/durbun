/**
 * Demo streams, sent the way an SDK with the `streams` capability sends them (SPEC §6.1.1): Mahalle's seller chat
 * over a WebSocket (auth, subscribe, chat, typing, read receipts, keep-alive pings, a binary presence frame, a
 * server restart with close 1001 and a reconnect) and Pati's live clinic queue over Server-Sent Events (retry,
 * event ids, a normal end and a reconnect with Last-Event-ID). Only while `config.captureStreams` is on.
 */
import type { Header, SdkToServer, WireBody } from '@durbun/protocol';
import type { Rng } from './rng';

export interface StreamHost {
  send(message: SdkToServer): void;
  /** Runs `fn` later while the app process lives. */
  after(ms: number, fn: () => void): void;
  now(): number;
  rng: Rng;
  /** `config.captureStreams` and `config.maxStreamMessageBytes` as the server sent them. */
  capture(): { on: boolean; cap: number };
  /** The process this connection belongs to is still running. */
  alive(): boolean;
}

let seq = 0;

function textBody(text: string, cap: number): { size: number; body?: WireBody } {
  const size = Buffer.byteLength(text);
  if (cap <= 0) return { size };
  const data = text.length > cap ? text.slice(0, cap) : text;
  return { size, body: data === text ? { encoding: 'utf8', data, size } : { encoding: 'utf8', data, size, truncated: true } };
}

function binaryBody(bytes: Buffer, cap: number): { size: number; body?: WireBody } {
  const size = bytes.length;
  if (cap <= 0) return { size };
  const kept = bytes.subarray(0, cap);
  const body: WireBody = { encoding: 'base64', data: kept.toString('base64'), size };
  if (kept.length < size) body.truncated = true;
  return { size, body };
}

const SELLER_LINES = [
  'Merhaba, siparişiniz hazırlanıyor 🙂',
  'Domatesler bugün çok taze, 2 kg yerine 3 kg ister misiniz?',
  'Kurye 10 dakika içinde çıkıyor.',
  'Ekmek bitti, yerine tam buğday koyabilirim.',
  'Teşekkürler, iyi günler!',
];
const BUYER_LINES = ['Tamam, teşekkürler', 'Evet olur', 'Kapıda kartla ödeyeceğim', 'Zile basmayın lütfen, bebek uyuyor'];

/** Mahalle's seller chat: one WebSocket per process, reconnecting after the server restarts it. */
export class DemoChatSocket {
  private id = '';
  private open = false;
  private messages = 0;

  constructor(
    private readonly host: StreamHost,
    private readonly url: string,
    private readonly baseHeaders: () => Header[],
  ) {}

  start(delayMs = 1500): void {
    this.host.after(delayMs, () => this.connect());
  }

  private connect(): void {
    if (!this.host.alive() || !this.host.capture().on) return;
    const h = this.host;
    this.id = `ws-${++seq}`;
    this.messages = 0;
    const ts = h.now();
    const key = Buffer.from(Array.from({ length: 16 }, () => h.rng.int(0, 255))).toString('base64');
    h.send({
      type: 'net.request',
      id: this.id,
      ts,
      method: 'GET',
      url: this.url,
      headers: [
        ...this.baseHeaders(),
        ['Connection', 'Upgrade'],
        ['Upgrade', 'websocket'],
        ['Sec-WebSocket-Key', key],
        ['Sec-WebSocket-Version', '13'],
        ['Sec-WebSocket-Protocol', 'mahalle-chat.v2'],
      ],
      source: 'okhttp',
    });
    h.after(h.rng.int(90, 240), () => {
      if (!h.alive()) return;
      h.send({
        type: 'net.response',
        id: this.id,
        ts: h.now(),
        status: 101,
        statusText: 'Switching Protocols',
        headers: [
          ['Connection', 'Upgrade'],
          ['Upgrade', 'websocket'],
          ['Sec-WebSocket-Accept', Buffer.from(key).toString('base64').slice(0, 28)],
          ['Sec-WebSocket-Protocol', 'mahalle-chat.v2'],
        ],
        protocol: 'http/1.1',
      });
      this.open = true;
      this.handshake();
    });
  }

  private frame(dir: 'in' | 'out', opcode: 'text' | 'binary' | 'ping' | 'pong' | 'close', payload?: string | Buffer, close?: { code: number; reason: string }): void {
    if (!this.host.alive() || !this.host.capture().on) return;
    const cap = this.host.capture().cap;
    const part = payload === undefined ? { size: 0 } : typeof payload === 'string' ? textBody(payload, cap) : binaryBody(payload, cap);
    const msg: SdkToServer = { type: 'net.ws', id: this.id, ts: this.host.now(), dir, opcode, size: part.size };
    if (part.body) msg.body = part.body;
    if (close) {
      msg.closeCode = close.code;
      msg.closeReason = close.reason;
    }
    this.host.send(msg);
    this.messages++;
  }

  private json(dir: 'in' | 'out', value: unknown): void {
    this.frame(dir, 'text', JSON.stringify(value));
  }

  private handshake(): void {
    const h = this.host;
    const token = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0ODIxMyJ9.${h.rng.int(100_000, 999_999)}`;
    this.json('out', { type: 'auth', token, device: 'android', app: '5.12.0' });
    h.after(h.rng.int(40, 120), () => this.json('in', { type: 'auth.ok', userId: 48_213, unread: 2 }));
    h.after(h.rng.int(150, 260), () => this.json('out', { type: 'subscribe', channels: ['order.88213', 'chat.seller.1042'] }));
    h.after(h.rng.int(300, 420), () => this.json('in', { type: 'subscribed', channels: ['order.88213', 'chat.seller.1042'], history: 0 }));
    this.loop();
  }

  private loop(): void {
    const h = this.host;
    const tick = () => {
      if (!this.open || !h.alive()) return;
      const roll = h.rng.next();
      if (roll < 0.3) this.chatFromSeller();
      else if (roll < 0.45) this.json('out', { type: 'message', channel: 'chat.seller.1042', text: h.rng.pick(BUYER_LINES), clientId: `c${h.rng.int(1000, 9999)}` });
      else if (roll < 0.6) this.json('in', { type: 'order.status', orderId: 88_213, status: h.rng.pick(['preparing', 'courier_assigned', 'on_the_way']), etaMin: h.rng.int(8, 25) });
      else if (roll < 0.7) {
        // Presence as MessagePack: a binary frame.
        this.frame('in', 'binary', Buffer.from([0x82, 0xa4, 0x75, 0x73, 0x65, 0x72, 0xcd, 0x04, 0x12, 0xa6, 0x6f, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0xc3]));
      } else {
        this.frame('out', 'ping');
        h.after(h.rng.int(30, 90), () => this.open && this.frame('in', 'pong'));
      }
      // The server restarts now and then: close 1001, the app answers and reconnects.
      if (this.messages > h.rng.int(60, 90)) {
        this.frame('in', 'close', undefined, { code: 1001, reason: 'Server restarting' });
        this.open = false;
        h.after(h.rng.int(5, 20), () => this.frame('out', 'close', undefined, { code: 1001, reason: '' }));
        this.start(h.rng.int(1500, 3000));
        return;
      }
      h.after(h.rng.int(1500, 5000), tick);
    };
    h.after(h.rng.int(800, 1600), tick);
  }

  private chatFromSeller(): void {
    const h = this.host;
    this.json('in', { type: 'typing', channel: 'chat.seller.1042', from: 'seller', on: true });
    h.after(h.rng.int(600, 1800), () => {
      if (!this.open) return;
      this.json('in', { type: 'message', channel: 'chat.seller.1042', from: 'seller', id: `m${h.rng.int(10_000, 99_999)}`, text: h.rng.pick(SELLER_LINES), sentAt: new Date(h.now()).toISOString() });
      h.after(h.rng.int(200, 900), () => this.open && this.json('out', { type: 'read', channel: 'chat.seller.1042', upTo: 'latest' }));
    });
  }
}

/** Pati's live clinic queue: Server-Sent Events, ending normally now and then and reconnecting with Last-Event-ID. */
export class DemoQueueStream {
  private id = '';
  private eventId = 0;
  private position = 0;

  constructor(
    private readonly host: StreamHost,
    private readonly url: string,
    private readonly baseHeaders: () => Header[],
    private readonly source: string,
  ) {}

  start(delayMs = 2500): void {
    this.host.after(delayMs, () => this.connect());
  }

  private connect(): void {
    const h = this.host;
    if (!h.alive() || !h.capture().on) return;
    this.id = `sse-${++seq}`;
    if (this.position <= 0) this.position = h.rng.int(4, 7);
    const headers: Header[] = [...this.baseHeaders(), ['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache']];
    if (this.eventId > 0) headers.push(['Last-Event-ID', String(this.eventId)]);
    h.send({ type: 'net.request', id: this.id, ts: h.now(), method: 'GET', url: this.url, headers, source: this.source });
    h.after(h.rng.int(120, 300), () => {
      if (!h.alive()) return;
      h.send({
        type: 'net.response',
        id: this.id,
        ts: h.now(),
        status: 200,
        statusText: 'OK',
        headers: [
          ['Content-Type', 'text/event-stream; charset=utf-8'],
          ['Cache-Control', 'no-cache'],
          ['X-Accel-Buffering', 'no'],
        ],
        protocol: 'h2',
      });
      this.event('queue', { position: this.position, etaMin: this.position * 6 }, 5000);
      this.loop(h.rng.int(8, 14));
    });
  }

  private event(name: string | undefined, data: unknown, retry?: number): void {
    const h = this.host;
    if (!h.alive() || !h.capture().on) return;
    const part = textBody(JSON.stringify(data), h.capture().cap);
    const msg: SdkToServer = { type: 'net.sse', id: this.id, ts: h.now(), eventId: String(++this.eventId), size: part.size };
    if (name) msg.event = name;
    if (part.body) msg.body = part.body;
    if (retry !== undefined) msg.retry = retry;
    h.send(msg);
  }

  private loop(left: number): void {
    const h = this.host;
    h.after(h.rng.int(4000, 9000), () => {
      if (!h.alive()) return;
      if (left <= 0) {
        // The server ends the stream after a while (a load balancer's limit); the app reconnects.
        h.send({ type: 'net.sse', id: this.id, ts: h.now(), end: true });
        this.start(h.rng.int(1000, 2500));
        return;
      }
      if (h.rng.chance(0.25)) this.event(undefined, { type: 'notice', text: 'Dr. Ayşe Demir 5 dakika gecikiyor' });
      else {
        if (this.position > 1 && h.rng.chance(0.6)) this.position--;
        else if (this.position <= 1) this.position = h.rng.int(4, 7);
        this.event('queue', { position: this.position, etaMin: this.position * 6 });
        if (this.position === 1) this.event('called', { room: 'Muayene 2', pet: 'Pamuk' });
      }
      this.loop(left - 1);
    });
  }
}
