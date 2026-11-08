import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { createHub } from '../../src/hub/index';
import { capLogData, capLogText, jsonSize, logEntryBytes, LOG_DATA_PREVIEW_CHARS, MAX_LOG_DATA_CHARS, MAX_LOG_TEXT_CHARS } from '../../src/hub/logSize';
import { RingBuffer } from '../../src/hub/ringBuffer';
import type { Hub } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { appInput, device, makeHub, makeSettings } from './helpers';

/**
 * An SDK frame may be 16 MB and an import 500 MB: rows are capped when stored and the log ring has a byte
 * budget next to its row count, so a flood of large lines cannot fill the Mac app's heap.
 */

let hub: Hub;
afterEach(() => hub?.dispose());

describe('log row limits', () => {
  it('cuts long text like the VM path (… at the end, never inside a surrogate pair)', () => {
    expect(capLogText('short')).toBe('short');
    const long = 'a'.repeat(MAX_LOG_TEXT_CHARS + 10);
    expect(capLogText(long)).toBe(`${'a'.repeat(MAX_LOG_TEXT_CHARS)}…`);
    expect(capLogText('ab😀cd', 3)).toBe('ab…');
  });

  it('keeps small data, replaces large data by a preview with its full size', () => {
    const small = { user: { id: 7, tags: ['a', 'b'] } };
    expect(capLogData(small)).toBe(small);
    const big = { rows: Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `row ${i}` })) };
    const capped = capLogData(big) as { truncated: boolean; size: number; preview: string };
    expect(capped.truncated).toBe(true);
    expect(capped.size).toBe(Buffer.byteLength(JSON.stringify(big)));
    expect(capped.preview.length).toBe(LOG_DATA_PREVIEW_CHARS + 1);
    expect(capped.preview.startsWith('{"rows":[{"id":0,"name":"row 0"}')).toBe(true);
    expect(capped.preview.endsWith('…')).toBe(true);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(capLogData(cyclic)).toEqual({ truncated: true, preview: '[unserializable data]' });
    expect(capLogData('x'.repeat(MAX_LOG_DATA_CHARS + 1))).toHaveLength(MAX_LOG_DATA_CHARS + 1);
  });

  it('estimates JSON size without serializing and stops at the limit', () => {
    const value = { a: 'xyz', b: [1, true, null] };
    expect(jsonSize(value)).toBeGreaterThanOrEqual(JSON.stringify(value).length - 4);
    const huge = Array.from({ length: 100_000 }, () => 'x'.repeat(100));
    const partial = jsonSize(huge, 1000);
    expect(partial).toBeGreaterThan(1000);
    expect(partial).toBeLessThan(200_000); // ~10 MB of strings not walked
  });

  it('caps SDK, device and imported rows when the hub stores them', () => {
    hub = makeHub();
    hub.upsertDevice(device('android:R5CT'));
    const app = hub.registerApp(appInput('android:R5CT'));
    const huge = 'm'.repeat(2 * MAX_LOG_TEXT_CHARS);
    const stored = hub.pushAppLog(app.id, {
      ts: 1,
      level: 'error',
      message: huge,
      data: { blob: 'd'.repeat(2 * MAX_LOG_DATA_CHARS) },
      error: { type: 'StateError', message: huge, stack: huge },
    })!;
    expect(stored.message).toHaveLength(MAX_LOG_TEXT_CHARS + 1);
    expect(stored.message.endsWith('…')).toBe(true);
    expect(stored.data).toMatchObject({ truncated: true, size: 2 * MAX_LOG_DATA_CHARS + 11 });
    expect(stored.error).toEqual({ type: 'StateError', message: `${'m'.repeat(MAX_LOG_TEXT_CHARS)}…`, stack: `${'m'.repeat(MAX_LOG_TEXT_CHARS)}…` });

    hub.pushDeviceLogs('android:R5CT', [{ ts: 2, level: 'info', tag: 'x', message: huge }]);
    expect(hub.getLogs().at(-1)!.message).toHaveLength(MAX_LOG_TEXT_CHARS + 1);

    hub.importSession({ format: 'durbun-session', version: 1, exportedAt: 1, server: { version: '0' }, devices: [], apps: [], logs: [{ id: 1, ts: 3, deviceId: 'd', source: 'device', level: 'info', tag: 't', message: huge }], network: [], metrics: [] }, 'big.json');
    expect(hub.getLogs().at(-1)!.message).toHaveLength(MAX_LOG_TEXT_CHARS + 1);
  });
});

describe('log ring byte budget', () => {
  const line = (i: number, kind?: LogEntry['kind']) => ({ ts: i, level: 'info' as const, tag: 'spam', message: `${i} ${'x'.repeat(1000)}`, ...(kind ? { kind } : {}) });

  it('evicts the oldest rows while over budget; evicted crashes are kept apart', () => {
    hub = createHub({ settings: makeSettings({ maxLogEntries: 100_000 }), logger: silentLogger, maxLogBytes: 50_000 });
    hub.pushDeviceLogs('android:X', [line(0, 'crash'), ...Array.from({ length: 199 }, (_, i) => line(i + 1))]);
    const rows = hub.getLogs();
    const ring = rows.filter((r) => r.kind !== 'crash');
    const bytes = ring.reduce((n, r) => n + logEntryBytes(r), 0);
    expect(bytes).toBeLessThanOrEqual(50_000);
    expect(ring.length).toBeGreaterThan(30);
    expect(ring.length).toBeLessThan(50);
    expect(ring.at(-1)!.message.startsWith('199 ')).toBe(true);
    expect(rows[0]!.kind).toBe('crash'); // protected store
    expect(hub.getLogCount()).toBe(ring.length + 1);
  });

  it('kept crashes have their own byte budget: the oldest go, the newest stays', () => {
    hub = createHub({ settings: makeSettings({ maxLogEntries: 100_000 }), logger: silentLogger, maxLogBytes: 5_000, maxKeptCrashBytes: 20_000 });
    hub.pushDeviceLogs('android:X', [...Array.from({ length: 60 }, (_, i) => line(i, 'crash')), ...Array.from({ length: 10 }, (_, i) => line(100 + i))]);
    const kept = hub.getLogs().filter((r) => r.kind === 'crash');
    expect(kept.reduce((n, r) => n + logEntryBytes(r), 0)).toBeLessThanOrEqual(20_000);
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.at(-1)!.ts).toBe(59);
    // A clear recounts: new crashes fill the budget again instead of evicting each other.
    hub.clear('logs', { deviceId: 'android:X' });
    hub.pushDeviceLogs('android:Y', [...Array.from({ length: 5 }, (_, i) => line(i, 'crash')), ...Array.from({ length: 10 }, (_, i) => line(100 + i))]);
    expect(hub.getLogs().filter((r) => r.kind === 'crash' && r.deviceId === 'android:Y')).toHaveLength(5);
  });

  it('a single row larger than the budget stays (the newest is never dropped)', () => {
    hub = createHub({ settings: makeSettings(), logger: silentLogger, maxLogBytes: 1_000 });
    hub.pushDeviceLogs('android:X', [line(1), line(2)]);
    expect(hub.getLogs().map((r) => r.ts)).toEqual([2]);
  });

  it('recounts after a scoped clear, so later rows are not evicted for bytes already gone', () => {
    hub = createHub({ settings: makeSettings(), logger: silentLogger, maxLogBytes: 60_000 });
    hub.pushDeviceLogs('android:A', Array.from({ length: 40 }, (_, i) => line(i)));
    hub.clear('logs', { deviceId: 'android:A' });
    hub.pushDeviceLogs('android:B', Array.from({ length: 40 }, (_, i) => line(i)));
    expect(hub.getLogs().filter((r) => r.deviceId === 'android:B')).toHaveLength(40);
  });
});

describe('RingBuffer.shift', () => {
  it('removes the oldest and keeps pushing in order', () => {
    const ring = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4]) ring.push(n);
    expect(ring.shift()).toBe(2);
    ring.push(5);
    ring.push(6);
    expect(ring.toArray()).toEqual([4, 5, 6]);
    expect(ring.shift()).toBe(4);
    expect(ring.shift()).toBe(5);
    expect(ring.shift()).toBe(6);
    expect(ring.shift()).toBeUndefined();
    ring.push(7);
    expect(ring.toArray()).toEqual([7]);
  });
});
