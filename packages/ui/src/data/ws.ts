import type { ServerToUi, UiToServer } from '@durbun/protocol';
import { useConnection } from './stores/connection';
import { failInFlightCommands, setCommandTransport } from './commands';
import { handleServerMessage } from './dispatch';

/**
 * The single WebSocket to the server (`/ui`). Reconnects forever with backoff; every new connection
 * re-syncs from scratch (the snapshot clears the stores, then history refills them).
 */

const BACKOFF_MS = [300, 1000, 2000, 3000, 5000];

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let url = '';
let ready = false; // hello received on the current socket
let cleanupListeners: (() => void) | null = null;
let lastAttemptAt = 0;
/** Focus/online events may retry early, but not more often than this. */
const MIN_EARLY_RETRY_MS = 2000;

export function defaultSocketUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ui`;
}

function backoff(attempt: number): number {
  const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 5000;
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

function scheduleRetry(error: string | null): void {
  if (!started) return;
  const attempt = useConnection.getState().attempt + 1;
  const delay = backoff(attempt);
  useConnection.setState({
    status: 'reconnecting',
    attempt,
    nextRetryAt: Date.now() + delay,
    lastError: error,
  });
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    open();
  }, delay);
}

function onMessage(ev: MessageEvent): void {
  if (typeof ev.data !== 'string') return;
  let msg: ServerToUi;
  try {
    msg = JSON.parse(ev.data) as ServerToUi;
  } catch {
    console.warn('[durbun] ignoring malformed message');
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
  if (msg.type === 'hello') ready = true;
  try {
    handleServerMessage(msg);
  } catch (err) {
    console.error('[durbun] failed to handle message', msg.type, err);
  }
}

function open(): void {
  if (!started) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  ready = false;
  lastAttemptAt = Date.now();
  const s = useConnection.getState();
  if (!s.everConnected && s.attempt === 0) useConnection.setState({ status: 'connecting' });
  else useConnection.setState({ nextRetryAt: null });
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    scheduleRetry(err instanceof Error ? err.message : String(err));
    return;
  }
  socket = ws;
  ws.onmessage = onMessage;
  ws.onclose = (ev) => {
    if (socket !== ws) return;
    socket = null;
    ready = false;
    failInFlightCommands();
    // 1006 = abnormal closure (server not running / connection refused): not worth showing.
    scheduleRetry(ev.reason || (ev.code !== 1000 && ev.code !== 1005 && ev.code !== 1006 ? `code ${ev.code}` : null));
  };
  ws.onerror = () => {
    /* a close event follows */
  };
}

/** Start the connection (idempotent). */
export function startConnection(opts: { url?: string } = {}): void {
  if (started) return;
  started = true;
  url = opts.url ?? defaultSocketUrl();
  setCommandTransport({
    isOpen: () => ready && socket?.readyState === WebSocket.OPEN,
    send: sendMessage,
  });
  const retrySoon = () => {
    if (retryTimer && document.visibilityState !== 'hidden' && Date.now() - lastAttemptAt >= MIN_EARLY_RETRY_MS) reconnectNow();
  };
  window.addEventListener('online', retrySoon);
  document.addEventListener('visibilitychange', retrySoon);
  cleanupListeners = () => {
    window.removeEventListener('online', retrySoon);
    document.removeEventListener('visibilitychange', retrySoon);
  };
  open();
}

export function stopConnection(): void {
  started = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  cleanupListeners?.();
  cleanupListeners = null;
  const ws = socket;
  socket = null;
  ready = false;
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close(1000, 'bye');
    } catch {
      /* ignore */
    }
  }
  failInFlightCommands();
  setCommandTransport(null);
}

/** Retry right away (e.g. "Reconnect now" button). */
export function reconnectNow(): void {
  if (!started) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  open();
}

/** Send a raw message. Returns false when the socket is not open. Prefer `sendCommand`. */
export function sendMessage(message: UiToServer): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}
