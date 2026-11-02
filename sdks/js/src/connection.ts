/**
 * WebSocket link to the desktop (`ws://<host>:9750/sdk`, one JSON object per text frame).
 *
 *  - Opens every candidate URL at once; the first socket that OPENS wins and gets the `hello`, all others are
 *    closed before saying anything (so the desktop never sees duplicate sessions).
 *  - The connection is active only after `welcome`; no welcome within 10 s → retry.
 *  - Reconnects forever with backoff 0.5 s → 1 s → 2 s → 3 s (max) while started; reset after a welcome.
 *  - Answers `ping` with `pong`; treats 45 s without any inbound frame as a dead link.
 */
import type { SdkHello, ServerToSdk, ServerWelcome } from './protocol.js';
import { clearTimer, setTimer, type TimerHandle } from './util.js';

export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface ConnectionTiming {
  backoffInitialMs: number;
  backoffMaxMs: number;
  connectTimeoutMs: number;
  welcomeTimeoutMs: number;
  idleTimeoutMs: number;
}

export const DEFAULT_TIMING: ConnectionTiming = {
  backoffInitialMs: 500,
  backoffMaxMs: 3_000,
  connectTimeoutMs: 8_000,
  welcomeTimeoutMs: 10_000,
  idleTimeoutMs: 45_000,
};

export interface ConnectionHandlers {
  /** Called right after a socket wins the race; the returned hello is sent immediately. */
  hello(): SdkHello;
  welcome(message: ServerWelcome, url: string): void;
  /** Any other server message while active (ping is answered internally). */
  message(message: ServerToSdk): void;
  /** An active connection was lost (not called for failed attempts). */
  disconnected(): void;
  debug(message: string): void;
}

type State = 'idle' | 'connecting' | 'handshaking' | 'active' | 'stopped';

const noop = (): void => undefined;

/** Detaches our handlers (no-ops rather than null: the `ws` package throws on unhandled 'error' events). */
function silence(ws: WebSocketLike): void {
  try {
    ws.onopen = noop;
    ws.onmessage = noop;
    ws.onerror = noop;
    ws.onclose = noop;
  } catch {
    // ignore
  }
}

function safeClose(ws: WebSocketLike, code = 1000, reason = 'durbun'): void {
  silence(ws);
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}

export class Connection {
  private state: State = 'idle';
  private current: WebSocketLike | null = null;
  private currentUrl = '';
  private pending: WebSocketLike[] = [];
  private attemptSeq = 0;
  private backoff: number;
  private reconnectTimer: TimerHandle | undefined;
  private connectTimer: TimerHandle | undefined;
  private welcomeTimer: TimerHandle | undefined;
  private idleTimer: TimerHandle | undefined;

  constructor(
    private readonly urls: readonly string[],
    private readonly WS: WebSocketConstructor,
    private readonly handlers: ConnectionHandlers,
    private readonly timing: ConnectionTiming = DEFAULT_TIMING,
  ) {
    this.backoff = timing.backoffInitialMs;
  }

  get isActive(): boolean {
    return this.state === 'active';
  }

  get url(): string {
    return this.currentUrl;
  }

  get bufferedAmount(): number {
    const ws = this.current;
    if (!ws) return 0;
    try {
      return typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
    } catch {
      return 0;
    }
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.state = 'idle';
    this.backoff = this.timing.backoffInitialMs;
    this.attempt();
  }

  stop(): void {
    this.state = 'stopped';
    this.attemptSeq++;
    this.clearAllTimers();
    for (const ws of this.pending) safeClose(ws);
    this.pending = [];
    if (this.current) safeClose(this.current, 1000, 'stopped');
    this.current = null;
  }

  /** Sends a frame on the active connection; false when not active or the socket refused it. */
  send(text: string): boolean {
    const ws = this.current;
    if (this.state !== 'active' || !ws) return false;
    try {
      ws.send(text);
      return true;
    } catch (e) {
      this.handlers.debug(`send failed, reconnecting: ${String(e)}`);
      this.drop(ws);
      return false;
    }
  }

  private attempt(): void {
    if (this.state === 'stopped') return;
    this.clearTimer('connectTimer');
    const seq = ++this.attemptSeq;
    this.state = 'connecting';
    const sockets: WebSocketLike[] = [];
    const failed = new Set<WebSocketLike>();
    let settled = false;
    const total = this.urls.length;

    const onFail = (ws: WebSocketLike) => {
      if (settled || seq !== this.attemptSeq || failed.has(ws)) return;
      failed.add(ws);
      safeClose(ws);
      if (failed.size >= total) {
        settled = true;
        this.pending = [];
        this.clearTimer('connectTimer');
        this.scheduleReconnect();
      }
    };

    for (const url of this.urls) {
      let ws: WebSocketLike;
      try {
        ws = new this.WS(url);
      } catch (e) {
        this.handlers.debug(`cannot open ${url}: ${String(e)}`);
        const dummy = { readyState: 3 } as WebSocketLike;
        failed.add(dummy);
        continue;
      }
      sockets.push(ws);
      ws.onopen = () => {
        if (settled || seq !== this.attemptSeq || this.state === 'stopped') {
          safeClose(ws);
          return;
        }
        settled = true;
        this.clearTimer('connectTimer');
        for (const other of sockets) if (other !== ws) safeClose(other);
        this.pending = [];
        this.adopt(ws, url);
      };
      ws.onerror = () => onFail(ws);
      ws.onclose = () => onFail(ws);
      ws.onmessage = noop;
    }
    this.pending = sockets;

    if (failed.size >= total) {
      settled = true;
      this.pending = [];
      this.scheduleReconnect();
      return;
    }
    this.connectTimer = setTimer(() => {
      this.connectTimer = undefined;
      if (settled || seq !== this.attemptSeq) return;
      settled = true;
      for (const ws of sockets) safeClose(ws);
      this.pending = [];
      this.handlers.debug('connect timeout');
      this.scheduleReconnect();
    }, this.timing.connectTimeoutMs);
  }

  private adopt(ws: WebSocketLike, url: string): void {
    this.current = ws;
    this.currentUrl = url;
    this.state = 'handshaking';
    ws.onmessage = (ev: { data?: unknown }) => this.onData(ws, ev ? ev.data : undefined);
    ws.onclose = () => this.drop(ws);
    ws.onerror = () => {
      // Most implementations follow with 'close'; make sure a dead socket is not kept around.
      try {
        if (ws.readyState === 2 || ws.readyState === 3) this.drop(ws);
      } catch {
        this.drop(ws);
      }
    };
    let hello: SdkHello;
    try {
      hello = this.handlers.hello();
      ws.send(JSON.stringify(hello));
    } catch (e) {
      this.handlers.debug(`hello failed: ${String(e)}`);
      this.drop(ws);
      return;
    }
    this.welcomeTimer = setTimer(() => {
      this.welcomeTimer = undefined;
      if (this.current === ws && this.state === 'handshaking') {
        this.handlers.debug('no welcome from the desktop, retrying');
        this.drop(ws);
      }
    }, this.timing.welcomeTimeoutMs);
  }

  private onData(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.current || this.state === 'stopped') return;
    this.armIdleTimer(ws);
    if (typeof data !== 'string') return;
    let msg: ServerToSdk;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;

    if (msg.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } catch {
        this.drop(ws);
      }
      return;
    }
    if (msg.type === 'welcome') {
      if (typeof msg.appId !== 'string') return;
      this.clearTimer('welcomeTimer');
      this.state = 'active';
      this.backoff = this.timing.backoffInitialMs;
      try {
        this.handlers.welcome(msg, this.currentUrl);
      } catch (e) {
        this.handlers.debug(`welcome handler failed: ${String(e)}`);
      }
      return;
    }
    if (this.state !== 'active') return;
    try {
      this.handlers.message(msg);
    } catch (e) {
      this.handlers.debug(`message handler failed: ${String(e)}`);
    }
  }

  private armIdleTimer(ws: WebSocketLike): void {
    this.clearTimer('idleTimer');
    this.idleTimer = setTimer(() => {
      this.idleTimer = undefined;
      if (this.current === ws) {
        this.handlers.debug('no data from the desktop for a while, reconnecting');
        this.drop(ws);
      }
    }, this.timing.idleTimeoutMs);
  }

  /** Forgets `ws` (closing it) and schedules a reconnect. */
  private drop(ws: WebSocketLike): void {
    if (ws !== this.current) return;
    const wasActive = this.state === 'active';
    this.current = null;
    this.clearTimer('welcomeTimer');
    this.clearTimer('idleTimer');
    safeClose(ws);
    if (this.state === 'stopped') return;
    this.state = 'idle';
    if (wasActive) {
      try {
        this.handlers.disconnected();
      } catch {
        // ignore
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped' || this.reconnectTimer !== undefined) return;
    this.state = 'idle';
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.timing.backoffMaxMs);
    this.reconnectTimer = setTimer(() => {
      this.reconnectTimer = undefined;
      this.attempt();
    }, delay);
  }

  private clearTimer(name: 'reconnectTimer' | 'connectTimer' | 'welcomeTimer' | 'idleTimer'): void {
    const t = this[name];
    if (t !== undefined) clearTimer(t);
    this[name] = undefined;
  }

  private clearAllTimers(): void {
    this.clearTimer('reconnectTimer');
    this.clearTimer('connectTimer');
    this.clearTimer('welcomeTimer');
    this.clearTimer('idleTimer');
  }
}
