/**
 * WebSocket /ui: per connection `hello` → `snapshot` → the whole log buffer as `history` chunks (5 000
 * entries, `done: true` on the last) → live messages. Live messages that arrive while the initial sync is
 * still being written are queued and delivered afterwards in order; log lines already contained in the
 * history are filtered out of later batches by id, and `cleared` events that happened before the sync
 * point are dropped (their effect is already in the snapshot). History chunks are written with
 * backpressure; a client that falls more than 64 MB behind is closed with 1013 so it resyncs.
 */
import { WebSocket } from 'ws';
import type { LogEntry, ServerToUi, UiNotice } from '@durbun/protocol';
import { isPlainObject } from '../config';
import type { Hub, HubChange, Logger } from '../types';
import type { CommandClient, CommandReply } from './commands';
import { errorMessage } from './util';

export const HISTORY_CHUNK = 5_000;
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** Close code for "try again later" (client reconnects and resyncs). */
export const CLOSE_TRY_AGAIN = 1013;
const MAX_PENDING_MESSAGES = 20_000;
const HISTORY_WRITE_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

type BatchMessage = Extract<ServerToUi, { type: 'batch' }>;

export interface UiChannelDeps {
  hub: Pick<Hub, 'getLogs'>;
  logger: Logger;
  /** Builds the hello message (server info + effective settings). */
  hello(): ServerToUi;
  /** Builds the snapshot message (devices, apps, network, mocks, drivers, processes, metrics, logCount). */
  snapshot(): ServerToUi;
  router: {
    handle(command: unknown, client: CommandClient): Promise<CommandReply>;
    clientClosed(clientId: number): void;
  };
  historyChunk?: number;
  maxBufferedBytes?: number;
  pingIntervalMs?: number;
}

class UiClient {
  ready = false;
  closed = false;
  alive = true;
  historyMaxId = 0;
  pending: ServerToUi[] = [];
  constructor(
    readonly id: number,
    readonly ws: WebSocket,
  ) {}
}

/** HubChange → batch message (null when nothing changed). Tolerates missing arrays. */
export function batchFromChange(change: Partial<HubChange>): BatchMessage | null {
  const msg: BatchMessage = { type: 'batch' };
  let any = false;
  const keys = ['logs', 'network', 'devices', 'removedDevices', 'apps', 'metrics', 'processes'] as const;
  for (const key of keys) {
    const value = change[key];
    if (Array.isArray(value) && value.length > 0) {
      (msg as Record<string, unknown>)[key] = value;
      any = true;
    }
  }
  return any ? msg : null;
}

function sanitizeLog(log: LogEntry): LogEntry {
  try {
    JSON.stringify(log);
    return log;
  } catch {
    const copy: LogEntry = { ...log };
    if (copy.data !== undefined) copy.data = '[unserializable data]';
    if (copy.error !== undefined) copy.error = { message: String(copy.error.message ?? '[unserializable error]') };
    return copy;
  }
}

export class UiChannel {
  private readonly clients = new Map<number, UiClient>();
  private nextId = 1;
  private readonly pingTimer: NodeJS.Timeout;
  private readonly historyChunk: number;
  private readonly maxBuffered: number;

  constructor(private readonly deps: UiChannelDeps) {
    this.historyChunk = deps.historyChunk ?? HISTORY_CHUNK;
    this.maxBuffered = deps.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.pingTimer = setInterval(() => this.ping(), deps.pingIntervalMs ?? PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  attach(ws: WebSocket): void {
    const client = new UiClient(this.nextId++, ws);
    this.clients.set(client.id, client);
    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('close', () => this.onClose(client));
    ws.on('error', (err) => this.deps.logger.debug(`ui client #${client.id}: ${err.message}`));
    ws.on('pong', () => {
      client.alive = true;
    });
    this.deps.logger.debug(`ui client #${client.id} connected (${this.clients.size} open)`);
    void this.sync(client);
  }

  /** Send to every client (queued for clients still receiving their initial sync). */
  broadcast(message: ServerToUi): void {
    let json: string | undefined;
    for (const client of this.clients.values()) {
      if (client.closed) continue;
      if (!client.ready) {
        this.enqueue(client, message);
        continue;
      }
      json ??= this.serialize(message);
      if (json !== undefined) this.sendRaw(client, json);
    }
  }

  /** Fan a hub change out as one batch message. */
  broadcastChange(change: Partial<HubChange>): void {
    const batch = batchFromChange(change);
    if (!batch) return;
    let minLogId = Infinity;
    for (const l of batch.logs ?? []) if (l.id < minLogId) minLogId = l.id;
    let shared: string | undefined;
    for (const client of this.clients.values()) {
      if (client.closed) continue;
      if (!client.ready) {
        this.enqueue(client, batch);
        continue;
      }
      if (client.historyMaxId >= minLogId) {
        this.deliver(client, batch);
        continue;
      }
      shared ??= this.serialize(batch);
      if (shared !== undefined) this.sendRaw(client, shared);
    }
  }

  /** Send a message to a single client right away (replies, client-specific notices). */
  sendTo(clientId: number, message: ServerToUi): void {
    const client = this.clients.get(clientId);
    if (!client || client.closed) return;
    const json = this.serialize(message);
    if (json !== undefined) this.sendRaw(client, json);
  }

  closeAll(code = 1001, reason = 'Dürbün is shutting down'): void {
    clearInterval(this.pingTimer);
    for (const client of this.clients.values()) {
      client.closed = true;
      try {
        client.ws.close(code, reason);
      } catch {
        client.ws.terminate();
      }
      setTimeout(() => client.ws.terminate(), 1_000).unref();
    }
  }

  dispose(): void {
    clearInterval(this.pingTimer);
  }

  /* ───────────── internals ───────────── */

  private async sync(client: UiClient): Promise<void> {
    try {
      // Sync point: everything below is computed synchronously, so no hub event can interleave.
      client.pending = client.pending.filter((m) => m.type !== 'cleared');
      const hello = this.deps.hello();
      const snapshot = this.deps.snapshot();
      const logs = this.deps.hub.getLogs();
      let maxId = 0;
      for (const l of logs) if (l.id > maxId) maxId = l.id;
      client.historyMaxId = maxId;

      this.sendMessage(client, hello);
      this.sendMessage(client, snapshot);
      if (logs.length === 0) {
        await this.sendAndWait(client, { type: 'history', logs: [], done: true });
      }
      for (let i = 0; i < logs.length; i += this.historyChunk) {
        if (client.closed) return;
        const done = i + this.historyChunk >= logs.length;
        await this.sendAndWait(client, { type: 'history', logs: logs.slice(i, i + this.historyChunk), done });
      }
      if (client.closed) return;
      client.ready = true;
      const queued = client.pending;
      client.pending = [];
      for (const message of queued) {
        if (client.closed) break;
        this.deliver(client, message);
      }
    } catch (err) {
      if (!client.closed) {
        this.deps.logger.warn(`ui client #${client.id}: initial sync failed: ${errorMessage(err)}`);
        client.closed = true;
        client.ws.terminate();
      }
    }
  }

  private enqueue(client: UiClient, message: ServerToUi): void {
    client.pending.push(message);
    if (client.pending.length > MAX_PENDING_MESSAGES) {
      this.dropSlowClient(client, 'too many queued messages during initial sync');
    }
  }

  /** Send a live message, removing log lines the client already got through history. */
  private deliver(client: UiClient, message: ServerToUi): void {
    if (message.type === 'batch' && message.logs && message.logs.some((l) => l.id <= client.historyMaxId)) {
      const logs = message.logs.filter((l) => l.id > client.historyMaxId);
      const filtered: BatchMessage = { ...message };
      if (logs.length > 0) filtered.logs = logs;
      else delete filtered.logs;
      if (Object.keys(filtered).length === 1) return; // only `type` left
      this.sendMessage(client, filtered);
      return;
    }
    this.sendMessage(client, message);
  }

  private sendMessage(client: UiClient, message: ServerToUi): void {
    const json = this.serialize(message);
    if (json !== undefined) this.sendRaw(client, json);
  }

  private serialize(message: ServerToUi): string | undefined {
    try {
      return JSON.stringify(message);
    } catch (err) {
      if ((message.type === 'batch' || message.type === 'history') && message.logs) {
        try {
          return JSON.stringify({ ...message, logs: message.logs.map(sanitizeLog) });
        } catch {
          /* fall through */
        }
      }
      this.deps.logger.error(`could not serialize ${message.type} message: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private sendRaw(client: UiClient, json: string): void {
    const ws = client.ws;
    if (client.closed || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.maxBuffered) {
      this.dropSlowClient(client, `more than ${Math.round(this.maxBuffered / 1024 / 1024)} MB unsent`);
      return;
    }
    ws.send(json, (err) => {
      if (err) this.deps.logger.debug(`ui client #${client.id}: send failed: ${err.message}`);
    });
  }

  /** Send one history chunk and wait until it has been handed to the socket (backpressure). */
  private sendAndWait(client: UiClient, message: ServerToUi): Promise<void> {
    const json = this.serialize(message);
    const ws = client.ws;
    if (json === undefined || client.closed || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client is not reading (history write timed out)')), HISTORY_WRITE_TIMEOUT_MS);
      timer.unref();
      ws.send(json, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private dropSlowClient(client: UiClient, why: string): void {
    if (client.closed) return;
    client.closed = true;
    client.pending = [];
    this.deps.logger.warn(`ui client #${client.id} is too slow (${why}); closing so it resyncs`);
    try {
      client.ws.close(CLOSE_TRY_AGAIN, 'Client too slow, please resync');
    } catch {
      /* ignore */
    }
    setTimeout(() => client.ws.terminate(), 5_000).unref();
  }

  private onMessage(client: UiClient, data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) return;
    let msg: unknown;
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
      msg = JSON.parse(text);
    } catch {
      this.deps.logger.debug(`ui client #${client.id}: ignoring a non-JSON message`);
      return;
    }
    if (!isPlainObject(msg) || msg.type !== 'command') return;
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : typeof msg.requestId === 'number' ? String(msg.requestId) : undefined;
    if (requestId === undefined) return;
    const ref: CommandClient = {
      id: client.id,
      notice: (notice: UiNotice) => this.sendTo(client.id, { type: 'notice', ...notice }),
    };
    this.deps.router
      .handle(msg.command, ref)
      .catch((err): CommandReply => ({ ok: false, error: errorMessage(err), code: 'command.failed' }))
      .then((reply) => {
        const message: Extract<ServerToUi, { type: 'reply' }> = { type: 'reply', requestId, ok: reply.ok };
        if (reply.data !== undefined) message.data = reply.data;
        if (reply.error !== undefined) message.error = reply.error;
        if (reply.code !== undefined) message.code = reply.code;
        this.sendTo(client.id, message);
      });
  }

  private onClose(client: UiClient): void {
    client.closed = true;
    client.pending = [];
    this.clients.delete(client.id);
    try {
      this.deps.router.clientClosed(client.id);
    } catch (err) {
      this.deps.logger.warn(`cleanup for ui client #${client.id} failed: ${errorMessage(err)}`);
    }
    this.deps.logger.debug(`ui client #${client.id} disconnected (${this.clients.size} open)`);
  }

  private ping(): void {
    for (const client of this.clients.values()) {
      if (client.closed) continue;
      if (!client.alive) {
        this.deps.logger.debug(`ui client #${client.id} stopped answering pings; closing`);
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        /* closed meanwhile */
      }
    }
  }
}
