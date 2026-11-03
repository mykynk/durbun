/**
 * Minimal Dart VM service client: JSON-RPC 2.0 over WebSocket with request ids, per-call timeouts,
 * stream subscriptions, redirect following (the VM service redirects to DDS once DDS has taken over) and
 * clean shutdown.
 *
 * Behaviour verified against the Dart 3.10 VM and DDS:
 *  - while DDS is active, a WebSocket upgrade on the VM service answers 302 → DDS's http root, and a GET of
 *    the service root answers 302 → `<dds>/devtools/?uri=<dds ws url>`; without DDS the root answers 200;
 *  - a plain (non-upgrade) GET of `/<token>=/ws` kills the raw VM service's HTTP server — never probe it;
 *  - when DDS starts it disconnects existing direct clients (they must reconnect through DDS);
 *  - DDS replays the history of Logging/Stdout/Stderr/Extension events to a new subscriber *before*
 *    answering its `streamListen` call — events received while that call is pending are flagged historical.
 */
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import type { Logger } from '../../types';
import { redactSecrets } from '../../util/redact';
import { normalizeVmServiceUrl, toHttpBase, wsUrlFromRedirect } from './url';

export const RpcCodes = {
  methodNotFound: -32601,
  invalidParams: -32602,
  featureDisabled: 100,
  streamAlreadySubscribed: 103,
  streamNotSubscribed: 104,
  isolateMustBeRunnable: 105,
  /** Local: the call timed out. */
  timeout: -40001,
  /** Local: the connection closed before the reply. */
  closed: -40002,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method?: string;

  constructor(message: string, code: number, data?: unknown, method?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.method = method;
  }

  /** `data.details` of VM errors (the useful part, e.g. "Unable to find request with id: '42'"). */
  get details(): string | undefined {
    const d = this.data as { details?: unknown } | undefined;
    return typeof d?.details === 'string' ? d.details : undefined;
  }
}

export interface IsolateRefJson {
  type?: string;
  id: string;
  name?: string;
  number?: string;
  isSystemIsolate?: boolean;
  isolateGroupId?: string;
}

export interface VmEventJson {
  type?: string;
  kind?: string;
  timestamp?: number;
  isolate?: IsolateRefJson;
  [key: string]: unknown;
}

export interface EventMeta {
  /** Replayed by DDS from its history buffer while our `streamListen` was pending. */
  historical: boolean;
}

export type EventListener = (streamId: string, event: VmEventJson, meta: EventMeta) => void;

export interface CloseInfo {
  code: number;
  reason: string;
  /** close() was called by us. */
  local: boolean;
}

/** Max inbound message size: bodies of large HTTP responses arrive as JSON int arrays. */
const MAX_PAYLOAD = 512 * 1024 * 1024;

export interface ConnectOptions {
  /** Handshake timeout per hop (ms). */
  timeoutMs?: number;
  maxRedirects?: number;
  /** Default per-call timeout (ms). */
  requestTimeoutMs?: number;
  logger?: Logger;
}

function rawToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

type HandshakeResult = { ws: WebSocket } | { redirect: string };

function openSocket(url: string, timeoutMs: number): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        followRedirects: false,
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Stays attached for the socket's lifetime so a late error can never become an unhandled 'error' event.
    ws.on('error', (err) => settle(() => reject(err)));
    ws.on('close', () => settle(() => reject(new Error('The VM service closed the connection during the handshake'))));
    ws.once('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      res.resume();
      settle(() => {
        if (status >= 300 && status < 400 && location) resolve({ redirect: location });
        else reject(new Error(`The VM service refused the WebSocket connection (HTTP ${status})`));
      });
      ws.terminate();
    });
    ws.once('open', () => settle(() => resolve({ ws })));
  });
}

/** Connect to a VM service / DDS WebSocket URL, following HTTP redirects (VM service → DDS). */
export async function connectVmService(wsUrl: string, opts: ConnectOptions = {}): Promise<VmServiceClient> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = normalizeVmServiceUrl(wsUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const result = await openSocket(current, timeoutMs);
    if ('ws' in result) return new VmServiceClient(result.ws, current, hop > 0, opts);
    const next = wsUrlFromRedirect(result.redirect, current);
    opts.logger?.debug(`VM service redirected ${redactSecrets(current)} → ${redactSecrets(next)}`);
    current = next;
  }
  throw new Error(`Too many redirects while connecting to ${redactSecrets(wsUrl)}`);
}

export type ProbeResult =
  | { kind: 'dds'; wsUrl: string }
  | { kind: 'vm'; status: number }
  | { kind: 'unreachable'; error: string };

/**
 * Non-intrusive probe of a VM service: GET of the service root (never `/ws`). A redirect means DDS has
 * taken over (its ws URL is returned); anything else means the URL itself is the endpoint to use.
 */
export function probeVmService(wsUrl: string, timeoutMs = 3000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let base: string;
    try {
      base = toHttpBase(normalizeVmServiceUrl(wsUrl));
    } catch (err) {
      resolve({ kind: 'unreachable', error: String(err) });
      return;
    }
    let done = false;
    const finish = (r: ProbeResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const client = base.startsWith('https:') ? https : http;
    const req = client.get(base, { agent: false, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      res.resume();
      if (status >= 300 && status < 400 && location) {
        try {
          finish({ kind: 'dds', wsUrl: wsUrlFromRedirect(location, base) });
        } catch (err) {
          finish({ kind: 'unreachable', error: `Bad redirect from the VM service: ${String(err)}` });
        }
      } else {
        finish({ kind: 'vm', status });
      }
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', (err) => finish({ kind: 'unreachable', error: err.message }));
  });
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Runs synchronously when the reply is dispatched (before any later message is handled). */
  onSettle?: () => void;
}

export class VmServiceClient {
  /** Final endpoint after redirects. */
  readonly url: string;
  readonly redirected: boolean;
  private readonly ws: WebSocket;
  private readonly logger?: Logger;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<EventListener>();
  private readonly closeListeners = new Set<(info: CloseInfo) => void>();
  /** streamId → number of in-flight streamListen calls (history replay window). */
  private readonly subscribing = new Map<string, number>();
  private closedInfo: CloseInfo | undefined;
  private localClose = false;

  constructor(ws: WebSocket, url: string, redirected: boolean, opts: ConnectOptions = {}) {
    this.ws = ws;
    this.url = url;
    this.redirected = redirected;
    this.logger = opts.logger;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.dispatch(rawToString(data));
    });
    ws.on('error', (err) => this.logger?.debug(`VM service socket error: ${err.message}`));
    ws.on('close', (code, reason) => this.handleClose(code, reason.toString('utf8')));
  }

  get closed(): boolean {
    return this.closedInfo !== undefined || this.ws.readyState === WebSocket.CLOSED;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (info: CloseInfo) => void): () => void {
    if (this.closedInfo) {
      const info = this.closedInfo;
      queueMicrotask(() => listener(info));
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.send<T>(method, params, timeoutMs);
  }

  private send<T>(method: string, params: Record<string, unknown>, timeoutMs?: number, onSettle?: () => void): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      onSettle?.();
      return Promise.reject(new RpcError('The VM service connection is closed', RpcCodes.closed, undefined, method));
    }
    const id = String(this.nextId++);
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const limit = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        onSettle?.();
        reject(new RpcError(`${method} timed out after ${limit} ms`, RpcCodes.timeout, undefined, method));
      }, limit);
      timer.unref?.();
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer, onSettle });
      this.ws.send(payload, (err) => {
        if (!err) return;
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.onSettle?.();
        reject(new RpcError(`Failed to send ${method}: ${err.message}`, RpcCodes.closed, undefined, method));
      });
    });
  }

  /** Call a service extension in an isolate. Extension handlers receive Map<String, String>, so values are stringified. */
  callExtension<T = Record<string, unknown>>(
    method: string,
    isolateId: string,
    params: Record<string, string | number | boolean | undefined> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const args: Record<string, string> = { isolateId };
    for (const [k, v] of Object.entries(params)) if (v !== undefined) args[k] = String(v);
    return this.call<T>(method, args, timeoutMs);
  }

  /** Subscribe to a stream; "already subscribed" counts as success. */
  async streamListen(streamId: string, timeoutMs?: number): Promise<void> {
    this.subscribing.set(streamId, (this.subscribing.get(streamId) ?? 0) + 1);
    // The history window must close exactly when the reply is dispatched: live events can follow in the
    // same socket read, before an awaiting continuation would run.
    const settle = () => {
      const n = (this.subscribing.get(streamId) ?? 1) - 1;
      if (n > 0) this.subscribing.set(streamId, n);
      else this.subscribing.delete(streamId);
    };
    try {
      await this.send('streamListen', { streamId }, timeoutMs, settle);
    } catch (err) {
      if (!(err instanceof RpcError && err.code === RpcCodes.streamAlreadySubscribed)) throw err;
    }
  }

  async streamCancel(streamId: string): Promise<void> {
    try {
      await this.call('streamCancel', { streamId });
    } catch (err) {
      if (!(err instanceof RpcError && err.code === RpcCodes.streamNotSubscribed)) throw err;
    }
  }

  /** True when connected through DDS (it advertises the 'DDS' protocol). */
  async isDds(): Promise<boolean> {
    try {
      const r = await this.call<{ protocols?: { protocolName?: string }[] }>('getSupportedProtocols', {}, 5000);
      return (r.protocols ?? []).some((p) => p.protocolName === 'DDS');
    } catch {
      return false;
    }
  }

  /** Close the connection and fail pending calls. */
  async close(): Promise<void> {
    if (this.closedInfo) return;
    this.localClose = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1000);
      timer.unref?.();
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(1000);
        else {
          clearTimeout(timer);
          resolve();
        }
      } catch {
        this.ws.terminate();
      }
    });
    this.handleClose(1000, 'closed by Dürbün');
  }

  private dispatch(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.logger?.debug('VM service sent a non-JSON message');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const id = msg.id;
    if (id !== undefined && id !== null && ('result' in msg || 'error' in msg)) {
      const key = String(id);
      const p = this.pending.get(key);
      if (!p) return; // timed out already
      this.pending.delete(key);
      clearTimeout(p.timer);
      p.onSettle?.();
      if ('error' in msg && msg.error) {
        const e = msg.error as { code?: number; message?: string; data?: unknown };
        const details = (e.data as { details?: unknown } | undefined)?.details;
        const text = [e.message ?? 'VM service error', typeof details === 'string' ? details : undefined]
          .filter(Boolean)
          .join(': ');
        p.reject(new RpcError(text, typeof e.code === 'number' ? e.code : -32000, e.data, p.method));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'streamNotify') {
      const params = msg.params as { streamId?: string; event?: VmEventJson } | undefined;
      if (!params?.streamId || !params.event) return;
      const meta: EventMeta = { historical: (this.subscribing.get(params.streamId) ?? 0) > 0 };
      for (const listener of [...this.listeners]) {
        try {
          listener(params.streamId, params.event, meta);
        } catch (err) {
          this.logger?.warn(`VM event listener failed: ${String(err)}`);
        }
      }
      return;
    }
    if (typeof msg.method === 'string' && id !== undefined && id !== null) {
      // A request from the service (e.g. for a registered service): we register none.
      this.ws.send(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: RpcCodes.methodNotFound, message: 'Method not found' } }),
        () => {},
      );
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.closedInfo) return;
    const info: CloseInfo = { code, reason, local: this.localClose };
    this.closedInfo = info;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.onSettle?.();
      p.reject(new RpcError('The VM service connection closed', RpcCodes.closed, undefined, p.method));
      this.pending.delete(id);
    }
    for (const listener of [...this.closeListeners]) {
      try {
        listener(info);
      } catch (err) {
        this.logger?.warn(`VM close listener failed: ${String(err)}`);
      }
    }
    this.closeListeners.clear();
  }
}
