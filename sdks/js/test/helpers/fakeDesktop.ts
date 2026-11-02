/** A tiny stand-in for the Dürbün desktop's `/sdk` WebSocket endpoint. */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { MockRule, SdkConfig } from '../../src/protocol.js';

export interface Received {
  conn: number;
  // Parsed SdkToServer message.
  msg: any;
}

export interface FakeDesktopOptions {
  port?: number;
  appId?: string;
  config?: Partial<SdkConfig>;
  mocks?: MockRule[];
  autoWelcome?: boolean;
}

export const DEFAULT_TEST_CONFIG: SdkConfig = {
  captureBodies: true,
  maxBodyBytes: 1_048_576,
  metricsIntervalMs: 1_000,
  deviceLogsAvailable: false,
};

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeDesktop {
  readonly received: Received[] = [];
  readonly sockets = new Map<number, WebSocket>();
  connections = 0;
  config: SdkConfig;
  mocks: MockRule[];
  appId: string;
  autoWelcome: boolean;
  private barrierSeq = 0;

  private constructor(
    private readonly wss: WebSocketServer,
    readonly port: number,
    opts: FakeDesktopOptions,
  ) {
    this.config = { ...DEFAULT_TEST_CONFIG, ...opts.config };
    this.mocks = opts.mocks ?? [];
    this.appId = opts.appId ?? 'app:1';
    this.autoWelcome = opts.autoWelcome !== false;
    wss.on('connection', (ws) => this.accept(ws));
  }

  static start(opts: FakeDesktopOptions = {}): Promise<FakeDesktop> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port ?? 0, path: '/sdk' });
      wss.once('listening', () => resolve(new FakeDesktop(wss, (wss.address() as AddressInfo).port, opts)));
      wss.once('error', reject);
    });
  }

  private accept(ws: WebSocket): void {
    const conn = ++this.connections;
    this.sockets.set(conn, ws);
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.received.push({ conn, msg });
      if (msg.type === 'hello' && this.autoWelcome) this.welcome(conn);
    });
    ws.on('close', () => this.sockets.delete(conn));
    ws.on('error', () => undefined);
  }

  welcome(conn: number): void {
    this.sendTo(conn, { type: 'welcome', protocol: 1, server: 'durbun/test', appId: this.appId, config: this.config, mocks: this.mocks });
  }

  sendTo(conn: number, msg: unknown): void {
    const ws = this.sockets.get(conn);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg: unknown): void {
    for (const conn of this.sockets.keys()) this.sendTo(conn, msg);
  }

  /** Messages (optionally of one type), in arrival order. */
  messages(type?: string): any[] {
    return this.received.filter((r) => !type || r.msg.type === type).map((r) => r.msg);
  }

  /** App messages without protocol chatter (hello/pong/command results). */
  appMessages(): any[] {
    return this.messages().filter((m) => !['hello', 'pong', 'command.result', 'actions'].includes(m.type));
  }

  logs(): any[] {
    return this.messages('log');
  }

  waitForMessage(predicate: (msg: any) => boolean, timeoutMs = 5_000, what = 'message'): Promise<any> {
    return waitFor(() => this.messages().find(predicate), timeoutMs, what);
  }

  /** Every message the desktop sent before this resolves has been processed by the SDK (commands are handled in order). */
  async barrier(): Promise<void> {
    const id = `barrier-${++this.barrierSeq}`;
    this.broadcast({ type: 'command', id, name: '__barrier__' });
    await this.waitForMessage((m) => m.type === 'command.result' && m.id === id, 5_000, id);
  }

  dropConnections(): void {
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
  }

  openSockets(): number {
    let n = 0;
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) n++;
    return n;
  }

  reset(): void {
    this.received.length = 0;
  }

  close(): Promise<void> {
    this.dropConnections();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
