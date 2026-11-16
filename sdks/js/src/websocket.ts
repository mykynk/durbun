/**
 * WebSocket capture (SPEC §6.1.1, capability `streams`). The global `WebSocket` becomes a subclass of itself:
 * the constructor (URL, protocols, React Native's `{ headers }` options), `binaryType`, the `on*` handlers,
 * `addEventListener`, static constants and `instanceof` are the original's. The subclass only adds one
 * listener per event type and notes what `send()` / `close()` were given after the original ran.
 *
 * One connection is one network entry: `net.request` (GET, the ws(s) URL, the handshake headers the app
 * set), `net.response` 101 when it opens, then one `net.ws` per message in the order the app saw them. A
 * connection that fails before it opens is a failed request (`net.error`). Nothing is sent while the desktop
 * does not ask for streams; a connection that opened before it asked is reported when it does (handshake
 * first, then the messages from that moment on). Ping / pong frames are reported only where the runtime shows
 * them (React Native's and Node `ws`'s `ping()`, the `ping` / `pong` events of `ws`); browsers never do. The
 * SDK's own connection uses the original constructor and the desktop's address is ignored.
 */
import { isBlobLike } from './body.js';
import type { Runtime } from './env.js';
import type { NetworkHost } from './network.js';
import type { Patch } from './patch.js';
import type { Header, SdkNetWs } from './protocol.js';
import {
  binaryBytes,
  blobPayload,
  bytesPayload,
  closeFrameSize,
  patchGlobalClass,
  StreamLane,
  textPayload,
  wsMessage,
  type CloseInfo,
  type Payload,
} from './streams.js';
import { attempt, isPromiseLike, resolveUrl, type AnyRecord } from './util.js';

const CONNECTING = 0;
const OPEN = 1;
/** Blob reads in flight per connection; past it, messages carry their size only (bounded memory). */
const MAX_PENDING_READS = 64;
/** React Native dev builds keep (re)connecting to React DevTools here: tooling, like Metro's own sockets. */
const REACT_DEVTOOLS = /^wss?:\/\/[^/?#]+:8097(?:[/?#]|$)/i;

interface Socket {
  url: string;
  args: unknown[];
  startTs: number;
  /** Set once the handshake was reported. */
  id?: string;
  openTs?: number;
  /** The app called close(): while connecting (a cancel) or while open (an 'out' close frame). */
  closing?: 'cancel' | 'out';
  /** Text of the last 'error' event (React Native carries the native message). */
  error?: string;
  ended: boolean;
  lane: StreamLane;
}

/** The handshake headers the app chose plus the ones every WebSocket handshake carries (RFC 6455). */
export function handshakeHeaders(args: unknown[]): Header[] {
  const headers: Header[] = [
    ['Connection', 'Upgrade'],
    ['Upgrade', 'websocket'],
    ['Sec-WebSocket-Version', '13'],
  ];
  const protocols = args[1];
  const list = typeof protocols === 'string' ? [protocols] : Array.isArray(protocols) ? protocols.map(String) : [];
  if (list.length > 0) headers.push(['Sec-WebSocket-Protocol', list.join(', ')]);
  // React Native (and Node's `ws`): new WebSocket(url, protocols, { headers: { … } }).
  const options = args[2];
  const extra = options && typeof options === 'object' ? (options as AnyRecord).headers : undefined;
  if (extra && typeof extra === 'object') {
    for (const key of Object.keys(extra)) {
      const value = extra[key];
      if (value !== undefined && value !== null) headers.push([key, String(value)]);
    }
  }
  return headers;
}

function socketUrl(raw: unknown): string {
  const url = resolveUrl(String(raw));
  // A relative URL resolves against the page (http / https): the socket uses ws / wss.
  return /^https?:/i.test(url) ? url.replace(/^http/i, 'ws') : url;
}

function closeInfo(code: unknown, reason: unknown): CloseInfo {
  const info: CloseInfo = {};
  // 1005: the frame had no status code.
  if (typeof code === 'number' && isFinite(code) && code !== 1005) info.code = Math.floor(code);
  if (typeof reason === 'string' && reason) info.reason = reason;
  return info;
}

export function installWebSocketPatch(host: NetworkHost, runtime: Runtime): Patch[] {
  const sockets = new WeakMap<object, Socket>();

  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      host.debug(`websocket ${what}`, e);
    }
  };

  const respond = (ws: AnyRecord, s: Socket): void => {
    const headers: Header[] = [
      ['Connection', 'Upgrade'],
      ['Upgrade', 'websocket'],
    ];
    const protocol = attempt(() => String(ws.protocol || ''), '');
    const extensions = attempt(() => String(ws.extensions || ''), '');
    if (protocol) headers.push(['Sec-WebSocket-Protocol', protocol]);
    if (extensions) headers.push(['Sec-WebSocket-Extensions', extensions]);
    const openTs = s.openTs as number;
    host.emit({
      type: 'net.response',
      id: s.id as string,
      ts: openTs,
      status: 101,
      statusText: 'Switching Protocols',
      headers,
      timings: { wait: Math.max(0, openTs - s.startTs) },
    });
  };

  /** Reports the handshake (once, only while the desktop asks for streams). False when not reported. */
  const announce = (ws: AnyRecord, s: Socket): boolean => {
    if (s.id !== undefined) return true;
    if (host.streamCapture() === undefined) return false;
    s.id = host.nextRequestId();
    host.emit({ type: 'net.request', id: s.id, ts: s.startTs, method: 'GET', url: s.url, headers: handshakeHeaders(s.args), source: 'websocket' });
    if (s.openTs !== undefined) respond(ws, s);
    return true;
  };

  /** Queues one `net.ws` (payload maybe still being read) behind the connection's earlier messages. */
  const record = (ws: AnyRecord, s: Socket, dir: 'in' | 'out', opcode: SdkNetWs['opcode'], data: unknown, close?: CloseInfo): void => {
    const cap = host.streamCapture();
    if (cap === undefined || s.ended || !announce(ws, s)) return;
    const id = s.id as string;
    const ts = Date.now();
    let payload: Payload | Promise<Payload>;
    if (close) payload = { size: closeFrameSize(close) };
    else if (data === undefined || data === null) payload = { size: 0 };
    else if (typeof data === 'string') payload = textPayload(data, cap);
    else if (isBlobLike(data)) payload = s.lane.pending >= MAX_PENDING_READS ? { size: data.size } : blobPayload(data, cap);
    else {
      const bytes = binaryBytes(data);
      payload = bytes ? bytesPayload(bytes, cap) : textPayload(attempt(() => String(data), ''), cap);
    }
    if (isPromiseLike<Payload>(payload)) s.lane.push(payload.then((p) => wsMessage(id, ts, dir, opcode, p)));
    else s.lane.push(wsMessage(id, ts, dir, opcode, payload, close));
  };

  const opcodeOf = (data: unknown): SdkNetWs['opcode'] => (typeof data === 'string' ? 'text' : 'binary');

  const onOpen = (ws: AnyRecord, s: Socket): void => {
    if (s.openTs !== undefined) return;
    s.openTs = Date.now();
    // A reported handshake always completes; otherwise it is reported now if the desktop asks for streams.
    if (s.id !== undefined) respond(ws, s);
    else announce(ws, s);
  };

  const onClose = (ws: AnyRecord, s: Socket, ev: AnyRecord | undefined): void => {
    if (s.ended) return;
    const code = attempt(() => ev && ev.code, undefined);
    const reason = attempt(() => ev && ev.reason, undefined);
    if (s.openTs === undefined) {
      // Never opened: a failed (or cancelled) request, not a stream.
      s.ended = true;
      if (!announce(ws, s)) return;
      const cancelled = s.closing === 'cancel';
      const detail = typeof code === 'number' && code !== 1006 && code !== 1005 ? ` (close code ${code})` : '';
      s.lane.push({
        type: 'net.error',
        id: s.id as string,
        ts: Date.now(),
        error: cancelled ? 'Connection cancelled' : s.error || `WebSocket connection failed${detail}`,
        ...(cancelled ? { cancelled: true } : {}),
      });
      return;
    }
    // 1006 (React Native has no wasClean): the connection went away without a close frame.
    const abnormal = code === 1006 || attempt(() => ev && ev.wasClean === false, false);
    if (!abnormal) {
      record(ws, s, 'in', 'close', undefined, closeInfo(code, reason));
      s.ended = true;
      return;
    }
    s.ended = true;
    // The app had closed it already: its close frame ended the stream, the answer just never came.
    if (s.closing === 'out' || host.streamCapture() === undefined || !announce(ws, s)) return;
    const text = s.error || (typeof reason === 'string' && reason) || '';
    s.lane.push({ type: 'net.error', id: s.id as string, ts: Date.now(), error: text ? `Connection lost: ${text}` : 'Connection lost (close code 1006)' });
  };

  const track = (ws: AnyRecord, args: unknown[]): void => {
    if (typeof ws.addEventListener !== 'function') return;
    const url = socketUrl(args[0]);
    if (host.isIgnored(url) || host.isIgnored(url.replace(/^ws/i, 'http'))) return;
    if (runtime === 'react-native' && REACT_DEVTOOLS.test(url)) return;
    const s: Socket = { url, args, startTs: Date.now(), ended: false, lane: new StreamLane((m) => host.emit(m)) };
    sockets.set(ws, s);
    announce(ws, s);
    ws.addEventListener('open', () => guard('open', () => onOpen(ws, s)));
    ws.addEventListener('message', (ev: AnyRecord) =>
      guard('message', () => {
        if (s.ended || host.streamCapture() === undefined) return;
        if (s.openTs === undefined) onOpen(ws, s); // a message proves the socket is open
        const data = attempt(() => ev && ev.data, undefined);
        record(ws, s, 'in', opcodeOf(data), data);
      }),
    );
    ws.addEventListener('error', (ev: AnyRecord) =>
      guard('error', () => {
        const message = attempt(() => ev && ev.message, undefined);
        if (typeof message === 'string' && message) s.error = message;
      }),
    );
    ws.addEventListener('close', (ev: AnyRecord) => guard('close', () => onClose(ws, s, ev)));
    // Node's `ws` shows control frames as EventEmitter events.
    if (typeof ws.on === 'function' && typeof ws.ping === 'function') {
      for (const opcode of ['ping', 'pong'] as const) {
        ws.on(opcode, (data: unknown) => guard(opcode, () => s.openTs !== undefined && record(ws, s, 'in', opcode, data)));
      }
    }
  };

  const patch = patchGlobalClass('WebSocket', (Original, isActive) => {
    const Sub = class DurbunWebSocket extends Original {
      constructor(...args: any[]) {
        super(...args);
        if (isActive()) guard('setup', () => track(this, args));
      }

      send(...args: any[]): any {
        const s = sockets.get(this);
        const state = s ? attempt(() => this.readyState, -1) : -1;
        const result = super.send(...args);
        if (s && state === OPEN) guard('send', () => record(this, s, 'out', opcodeOf(args[0]), args[0]));
        return result;
      }

      close(...args: any[]): any {
        const s = sockets.get(this);
        const state = s ? attempt(() => this.readyState, -1) : -1;
        // Node's `ws` answers the server's close frame through close(): that is the runtime, not the app.
        const echo = !!s && attempt(() => this._closeFrameReceived === true, false);
        const result = super.close(...args);
        if (s && !s.ended && !s.closing && !echo) {
          guard('close', () => {
            if (state === CONNECTING) s.closing = 'cancel';
            else if (state === OPEN) {
              s.closing = 'out';
              // React Native sends 1000 when no code is given; browsers send a close frame without one.
              const code = args[0] === undefined && runtime === 'react-native' ? 1000 : args[0];
              record(this, s, 'out', 'close', undefined, closeInfo(code, args[1]));
            }
          });
        }
        return result;
      }
    };
    // ping() only where the original has one (React Native, Node `ws`): browsers keep no such method.
    if (typeof Original.prototype.ping === 'function') {
      Object.defineProperty(Sub.prototype, 'ping', {
        configurable: true,
        writable: true,
        value: function ping(this: AnyRecord, ...args: any[]): any {
          const s = sockets.get(this);
          const state = s ? attempt(() => this.readyState, -1) : -1;
          const result = Original.prototype.ping.apply(this, args);
          if (s && state === OPEN) guard('ping', () => record(this, s, 'out', 'ping', typeof args[0] === 'function' ? undefined : args[0]));
          return result;
        },
      });
    }
    return Sub;
  });
  return patch ? [patch] : [];
}
