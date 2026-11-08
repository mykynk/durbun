import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { LogEntry, ServerToUi } from '@durbun/protocol';
import { batchFromChange, UiChannel, type UiChannelDeps } from '../../src/http/uiSocket';
import { silentLogger } from '../../src/util/logger';

/** Minimal stand-in for a ws WebSocket whose write completion we control. */
class MockWs extends EventEmitter {
  readyState: number = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  autoFlush = true;
  closedWith: { code?: number; reason?: string } | undefined;
  terminated = false;
  pings = 0;
  private callbacks: ((err?: Error) => void)[] = [];

  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    if (!cb) return;
    if (this.autoFlush) setImmediate(() => cb());
    else this.callbacks.push(cb);
  }
  async flushAll(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const cbs = this.callbacks.splice(0);
      for (const cb of cbs) cb();
      await new Promise((r) => setImmediate(r));
      if (this.callbacks.length === 0 && cbs.length === 0) return;
    }
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 2;
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006, Buffer.alloc(0));
  }
  ping(): void {
    this.pings++;
  }
  get types(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as ServerToUi).type);
  }
  parsed(): ServerToUi[] {
    return this.sent.map((s) => JSON.parse(s) as ServerToUi);
  }
}

function logs(from: number, to: number): LogEntry[] {
  const out: LogEntry[] = [];
  for (let id = from; id <= to; id++) {
    out.push({ id, ts: 1_762_070_000_000 + id, deviceId: 'android:R5CT1234', source: 'device', level: 'info', tag: 'flutter', message: `line ${id}` });
  }
  return out;
}

function channel(buffer: LogEntry[], patch: Partial<UiChannelDeps> = {}): UiChannel {
  return new UiChannel({
    hub: { getLogs: () => buffer },
    logger: silentLogger,
    hello: () => ({ type: 'settings', settings: {} as never }),
    snapshot: () => ({ type: 'mocks', rules: [] }),
    router: { handle: async () => ({ ok: true, data: null }), clientClosed: () => {} },
    historyChunk: 5_000,
    ...patch,
  });
}

describe('UiChannel', () => {
  it('queues live messages during the history transfer and delivers them in order without duplicate lines', async () => {
    const buffer = logs(1, 12_000);
    const ch = channel(buffer);
    const ws = new MockWs();
    ws.autoFlush = false;
    ch.attach(ws as unknown as WebSocket);
    expect(ws.types).toEqual(['settings', 'mocks', 'history']); // first chunk waits for the socket

    ch.broadcastChange({ logs: [...logs(11_999, 12_000), ...logs(12_001, 12_002)] });
    ch.broadcast({ type: 'cleared', target: 'network' });
    ch.broadcast({ type: 'notice', level: 'info', message: 'hi' });
    ch.broadcastChange({ logs: logs(12_003, 12_003) });
    expect(ws.types).toEqual(['settings', 'mocks', 'history']);

    await ws.flushAll();
    const msgs = ws.parsed();
    expect(msgs.map((m) => m.type)).toEqual(['settings', 'mocks', 'history', 'history', 'history', 'batch', 'cleared', 'notice', 'batch']);
    const history = msgs.filter((m): m is Extract<ServerToUi, { type: 'history' }> => m.type === 'history');
    expect(history.map((h) => [h.logs.length, h.done])).toEqual([
      [5_000, false],
      [5_000, false],
      [2_000, true],
    ]);
    const batches = msgs.filter((m): m is Extract<ServerToUi, { type: 'batch' }> => m.type === 'batch');
    expect(batches[0]!.logs!.map((l) => l.id)).toEqual([12_001, 12_002]);
    expect(batches[1]!.logs!.map((l) => l.id)).toEqual([12_003]);

    // After the sync, live batches go straight out.
    ch.broadcastChange({ logs: logs(12_004, 12_004), devices: [] });
    expect((JSON.parse(ws.sent.at(-1)!) as { logs: LogEntry[] }).logs[0]!.id).toBe(12_004);
    ch.dispose();
  });

  it('drops a batch entirely when every line was already in the history', async () => {
    const ch = channel(logs(1, 10));
    const ws = new MockWs();
    ch.attach(ws as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 10));
    const before = ws.sent.length;
    ch.broadcastChange({ logs: logs(9, 10) });
    expect(ws.sent.length).toBe(before);
    ch.broadcastChange({ logs: logs(10, 10), apps: [{ id: 'app:1' } as never] });
    const last = JSON.parse(ws.sent.at(-1)!) as Record<string, unknown>;
    expect(last).toEqual({ type: 'batch', apps: [{ id: 'app:1' }] });
    ch.dispose();
  });

  it('closes a client that is more than 64 MB behind with 1013', async () => {
    const ch = channel([]);
    const ws = new MockWs();
    ch.attach(ws as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 10));
    ws.bufferedAmount = 65 * 1024 * 1024;
    const before = ws.sent.length;
    ch.broadcast({ type: 'notice', level: 'info', message: 'x' });
    expect(ws.closedWith?.code).toBe(1013);
    expect(ws.sent.length).toBe(before);
    ch.broadcast({ type: 'notice', level: 'info', message: 'y' });
    expect(ws.sent.length).toBe(before);
    ch.dispose();
  });

  it('closes a client that never drains its initial sync once the queue overflows', () => {
    const ch = channel(logs(1, 3));
    const ws = new MockWs();
    ws.autoFlush = false;
    ch.attach(ws as unknown as WebSocket);
    for (let i = 0; i < 20_001; i++) ch.broadcast({ type: 'notice', level: 'info', message: String(i) });
    expect(ws.closedWith?.code).toBe(1013);
    ch.dispose();
  });

  it('survives unserializable log data', async () => {
    const ch = channel([]);
    const ws = new MockWs();
    ch.attach(ws as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 10));
    const bad = { ...logs(1, 1)[0]!, data: { big: 10n } };
    ch.broadcastChange({ logs: [bad] });
    const last = JSON.parse(ws.sent.at(-1)!) as Extract<ServerToUi, { type: 'batch' }>;
    expect(last.logs![0]!.data).toBe('[unserializable data]');
    ch.dispose();
  });

  it('splits history by bytes as well as rows, and the last chunk always says done', async () => {
    // 30 rows of ~10 KB with a 32 KB chunk budget: never more than 3 rows per chunk.
    const buffer = logs(1, 30).map((l) => ({ ...l, message: `${l.id} ${'x'.repeat(10_000)}` }));
    const ch = channel(buffer, { chunkBytes: 32 * 1024 });
    const ws = new MockWs();
    ch.attach(ws as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 50));
    const history = ws.parsed().filter((m): m is Extract<ServerToUi, { type: 'history' }> => m.type === 'history');
    expect(history.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...history.map((h) => h.logs.length))).toBeLessThanOrEqual(3);
    expect(history.flatMap((h) => h.logs.map((l) => l.id))).toEqual(buffer.map((l) => l.id));
    expect(history.map((h) => h.done)).toEqual([...history.slice(1).map(() => false), true]);
    ch.dispose();
  });

  it('still ends the sync with done when the last chunk cannot be serialized', async () => {
    const bad = { ...logs(3, 3)[0]!, params: { n: 1n } } as unknown as LogEntry; // even sanitizeLog cannot fix params
    const ch = channel([...logs(1, 2), bad], { historyChunk: 2 });
    const ws = new MockWs();
    ch.attach(ws as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 50));
    const history = ws.parsed().filter((m): m is Extract<ServerToUi, { type: 'history' }> => m.type === 'history');
    expect(history.map((h) => [h.logs.length, h.done])).toEqual([
      [2, false],
      [0, true],
    ]);
    ch.broadcastChange({ logs: logs(4, 4) });
    expect((JSON.parse(ws.sent.at(-1)!) as { logs: LogEntry[] }).logs[0]!.id).toBe(4); // live after the sync
    ch.dispose();
  });

  it('splits a live batch with large rows into several, the other changes in the first', async () => {
    const ch = channel([], { chunkBytes: 32 * 1024 });
    const ws = new MockWs();
    ch.attach(ws as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 10));
    const before = ws.sent.length;
    const rows = logs(1, 9).map((l) => ({ ...l, message: 'x'.repeat(10_000) }));
    ch.broadcastChange({ logs: rows, apps: [{ id: 'app:1' } as never] });
    const batches = ws.parsed().slice(before) as Extract<ServerToUi, { type: 'batch' }>[];
    expect(batches.length).toBe(3);
    expect(batches[0]!.apps).toEqual([{ id: 'app:1' }]);
    expect(batches.slice(1).every((b) => Object.keys(b).sort().join() === 'logs,type')).toBe(true);
    expect(batches.flatMap((b) => b.logs!.map((l) => l.id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    ch.dispose();
  });

  it('terminates clients that stop answering pings', async () => {
    const ch = channel([], { pingIntervalMs: 15 });
    const ws = new MockWs();
    ch.attach(ws as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 80));
    expect(ws.pings).toBeGreaterThanOrEqual(1);
    expect(ws.terminated).toBe(true);
    expect(ch.size).toBe(0);
    ch.dispose();
  });

  it('replies to commands with the request id and keeps other clients out of it', async () => {
    const ch = channel([], {
      router: {
        handle: async (cmd, client) => {
          client.notice({ level: 'info', message: 'just for you' });
          return { ok: true, data: { echo: cmd } };
        },
        clientClosed: () => {},
      },
    });
    const a = new MockWs();
    const b = new MockWs();
    ch.attach(a as unknown as WebSocket);
    ch.attach(b as unknown as WebSocket);
    await new Promise((r) => setTimeout(r, 10));
    const bBefore = b.sent.length;
    a.emit('message', Buffer.from(JSON.stringify({ type: 'command', requestId: 'q1', command: { name: 'doctor.run' } })), false);
    await new Promise((r) => setTimeout(r, 10));
    const tail = a.parsed().slice(-2);
    expect(tail).toEqual([
      { type: 'notice', level: 'info', message: 'just for you' },
      { type: 'reply', requestId: 'q1', ok: true, data: { echo: { name: 'doctor.run' } } },
    ]);
    expect(b.sent.length).toBe(bBefore);
    ch.dispose();
  });
});

describe('batchFromChange', () => {
  it('keeps only non-empty arrays and tolerates missing fields', () => {
    expect(batchFromChange({ logs: [], network: [] })).toBeNull();
    expect(batchFromChange({ removedDevices: ['ios:1'] })).toEqual({ type: 'batch', removedDevices: ['ios:1'] });
  });
});
