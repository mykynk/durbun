/** Output side of the three transports: NDJSON byte streams, WebSockets and in-process sessions. */
import type { Duplex } from 'node:stream';
import type { ServerToSdk } from '@durbun/protocol';
import type { RawData, WebSocket } from 'ws';
import type { Logger } from '../types';
import type { Wire } from './connection';
import { encodeNdjson } from './ndjson';

/**
 * NDJSON writer that respects backpressure: once `write()` returns false, further lines wait for
 * 'drain'. If more than `maxBuffered` bytes pile up the client is not reading → `onOverflow`.
 */
export function streamWire(stream: Duplex, maxBuffered: number, onOverflow: () => void, logger: Logger): Wire {
  let blocked = false;
  let queue: string[] = [];
  let queuedBytes = 0;
  let closed = false;

  const writeLine = (line: string): boolean => {
    try {
      return stream.write(line);
    } catch (err) {
      logger.debug('stream write failed', err);
      return true;
    }
  };

  const onDrain = () => {
    blocked = false;
    while (queue.length > 0 && !closed) {
      const line = queue.shift() as string;
      queuedBytes -= line.length;
      if (!writeLine(line)) {
        blocked = true;
        stream.once('drain', onDrain);
        return;
      }
    }
  };

  return {
    kind: 'stream',
    send(message: ServerToSdk) {
      if (closed || stream.destroyed || !stream.writable) return;
      const line = encodeNdjson(message);
      if (blocked) {
        queue.push(line);
        queuedBytes += line.length;
        if (queuedBytes > maxBuffered) onOverflow();
        return;
      }
      if (!writeLine(line)) {
        blocked = true;
        stream.once('drain', onDrain);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      queue = [];
      queuedBytes = 0;
      stream.off('drain', onDrain);
      if (stream.destroyed) return;
      try {
        stream.end();
      } catch {
        // already ending
      }
      const timer = setTimeout(() => {
        if (!stream.destroyed) stream.destroy();
      }, 1000);
      timer.unref?.();
    },
  };
}

export function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** JSON text frames over a `ws` WebSocket. */
export function webSocketWire(ws: WebSocket, maxBuffered: number, onOverflow: () => void, logger: Logger): Wire {
  let closed = false;
  return {
    kind: 'websocket',
    send(message: ServerToSdk) {
      if (closed || ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > maxBuffered) {
        onOverflow();
        return;
      }
      ws.send(JSON.stringify(message), (err) => {
        if (err) logger.debug('websocket send failed', err);
      });
    },
    close(reason: string, code = 1000) {
      if (closed) return;
      closed = true;
      try {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason.slice(0, 100));
      } catch (err) {
        logger.debug('websocket close failed', err);
      }
      const timer = setTimeout(() => {
        try {
          if (ws.readyState !== ws.CLOSED) ws.terminate();
        } catch {
          // ignore
        }
      }, 2000);
      timer.unref?.();
    },
  };
}

/** In-process delivery to a virtual session's listeners (asynchronous, in order, errors contained). */
export function virtualWire(listeners: Set<(message: ServerToSdk) => void>, logger: Logger): Wire {
  let closed = false;
  return {
    kind: 'virtual',
    send(message: ServerToSdk) {
      if (closed) return;
      queueMicrotask(() => {
        if (closed && message.type !== 'welcome') return;
        for (const listener of [...listeners]) {
          try {
            listener(message);
          } catch (err) {
            logger.warn('virtual SDK session listener failed', err);
          }
        }
      });
    },
    close() {
      closed = true;
    },
  };
}
