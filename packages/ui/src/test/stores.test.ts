import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry, MetricSample, NetworkEntry } from '@durbun/protocol';
import { LogStore } from '../data/logStore';
import { NetworkStore } from '../data/networkStore';
import { MetricsStore, metricSeriesKey } from '../data/metricsStore';
import { createFrameScheduler } from '../data/versioned';

let nextId = 1;
function log(partial: Partial<LogEntry> = {}): LogEntry {
  return {
    id: partial.id ?? nextId++,
    ts: 1_793_600_000_000,
    deviceId: 'android:R5CT20XK9QM',
    source: 'device',
    level: 'info',
    tag: 'ActivityManager',
    message: 'Displayed com.mykynk.pati/.MainActivity: +412ms',
    ...partial,
  };
}

function net(partial: Partial<NetworkEntry> & { id: string }): NetworkEntry {
  return {
    deviceId: 'android:R5CT20XK9QM',
    appId: 'app:2',
    source: 'dart:io',
    method: 'GET',
    url: 'https://api.pati.app/v1/pets?page=2',
    host: 'api.pati.app',
    path: '/v1/pets?page=2',
    startTs: 1_793_600_000_000,
    state: 'pending',
    requestHeaders: [['Accept', 'application/json']],
    hasRequestBody: false,
    hasResponseBody: false,
    ...partial,
  };
}

beforeEach(() => {
  nextId = 1;
});

describe('LogStore', () => {
  it('appends in id order and keeps counters', () => {
    const s = new LogStore();
    s.append([log({ level: 'warn' }), log({ level: 'error', appId: 'app:2' }), log({ level: 'fatal', kind: 'crash', appId: 'app:3' })]);
    expect(s.entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(s.counts).toEqual({ total: 3, warn: 1, error: 2, crash: 1 });
    expect(s.countsByApp.get('app:2')).toEqual({ total: 1, warn: 0, error: 1, crash: 0 });
    expect(s.countsByDevice.get('android:R5CT20XK9QM')?.total).toBe(3);
    expect(s.lastId).toBe(3);
  });

  it('trims the ring at maxEntries (oldest first) and adjusts counters', () => {
    const s = new LogStore();
    s.setMaxEntries(5);
    s.append(Array.from({ length: 4 }, () => log({ level: 'error' })));
    s.append(Array.from({ length: 4 }, () => log()));
    expect(s.size).toBe(5);
    expect(s.entries[0]!.id).toBe(4);
    expect(s.entries[4]!.id).toBe(8);
    expect(s.headDropped).toBe(3);
    expect(s.counts.total).toBe(5);
    expect(s.counts.error).toBe(1); // ids 1–3 (errors) were dropped, id 4 remains
    expect(s.totalReceived).toBe(8);
  });

  it('merges out-of-order and duplicate ids', () => {
    const s = new LogStore();
    s.append([log({ id: 10 }), log({ id: 12 })]);
    s.append([log({ id: 11, message: 'late' }), log({ id: 12, message: 'replaced' }), log({ id: 13 })]);
    expect(s.entries.map((e) => e.id)).toEqual([10, 11, 12, 13]);
    expect(s.getById(12)?.message).toBe('replaced');
    expect(s.counts.total).toBe(4);
    expect(s.indexOfId(11)).toBe(1);
    expect(s.indexOfId(99)).toBe(-1);
  });

  it('does not count history towards the live ingest counter', () => {
    const s = new LogStore();
    s.append([log(), log()], { history: true });
    s.append([log()]);
    expect(s.totalReceived).toBe(3);
    expect(s.liveReceived).toBe(1);
  });

  it('removeWhere drops matching entries and bumps the generation', () => {
    const s = new LogStore();
    s.append([log({ deviceId: 'a' }), log({ deviceId: 'b' }), log({ deviceId: 'a', level: 'error' })]);
    const gen = s.generation;
    expect(s.removeWhere((e) => e.deviceId === 'a')).toBe(2);
    expect(s.entries.map((e) => e.deviceId)).toEqual(['b']);
    expect(s.counts).toEqual({ total: 1, warn: 0, error: 0, crash: 0 });
    expect(s.generation).toBe(gen + 1);
  });
});

describe('version bump scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('bumps the version once per frame using the timer fallback when rAF is missing', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
    const s = new LogStore();
    const listener = vi.fn();
    s.subscribe(listener);
    s.append([log()]);
    s.append([log()]);
    s.append([log()]);
    expect(s.version).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(s.version).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    s.append([log()]);
    vi.advanceTimersByTime(20);
    expect(s.version).toBe(2);
  });

  it('uses requestAnimationFrame when available (with a safety timeout)', () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const cb = vi.fn();
    const sched = createFrameScheduler(cb);
    sched.schedule();
    sched.schedule();
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(cb).toHaveBeenCalledTimes(1);
    // A throttled rAF never fires: the safety timer still delivers.
    sched.schedule();
    vi.advanceTimersByTime(130);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('flush delivers a pending change synchronously', () => {
    vi.useFakeTimers();
    const s = new NetworkStore();
    s.upsert([net({ id: 'app:2:1' })]);
    expect(s.dirty).toBe(true);
    s.flush();
    expect(s.version).toBe(1);
    expect(s.dirty).toBe(false);
  });
});

describe('NetworkStore', () => {
  it('replaces entries by id and keeps counters consistent across state changes', () => {
    const s = new NetworkStore();
    s.upsert([net({ id: 'app:2:1' }), net({ id: 'app:2:2' })]);
    expect(s.counts.pending).toBe(2);
    s.upsert([
      net({ id: 'app:2:1', state: 'complete', status: 503 }),
      net({ id: 'app:2:2', state: 'failed', error: 'SocketException: Connection timed out' }),
    ]);
    expect(s.size).toBe(2);
    expect(s.counts).toMatchObject({ total: 2, pending: 0, failed: 1, serverError: 1, clientError: 0 });
    expect(s.order).toEqual(['app:2:1', 'app:2:2']);
    expect(s.countsByApp.get('app:2')?.total).toBe(2);
  });

  it('trims the oldest entries and caches list() until the next mutation', () => {
    const s = new NetworkStore();
    s.setMaxEntries(2);
    s.upsert([net({ id: 'a' }), net({ id: 'b' }), net({ id: 'c' })]);
    expect(s.order).toEqual(['b', 'c']);
    expect(s.get('a')).toBeUndefined();
    const l1 = s.list();
    expect(s.list()).toBe(l1);
    s.upsert([net({ id: 'c', state: 'complete', status: 200 })]);
    expect(s.list()).not.toBe(l1);
    expect(s.list()[1]!.status).toBe(200);
  });

  it('separates snapshot entries from live ones for rates', () => {
    const s = new NetworkStore();
    s.upsert([net({ id: 'a' })], { history: true });
    s.upsert([net({ id: 'b' })]);
    s.upsert([net({ id: 'b', state: 'complete', status: 200 })]);
    expect(s.totalReceived).toBe(2);
    expect(s.liveReceived).toBe(1);
  });
});

describe('MetricsStore', () => {
  const sample = (p: Partial<MetricSample>): MetricSample => ({ ts: 1000, deviceId: 'd', source: 'sdk', ...p });

  it('keys series by app or by pid', () => {
    expect(metricSeriesKey({ deviceId: 'd', appId: 'app:2' })).toBe('d|app:2');
    expect(metricSeriesKey({ deviceId: 'd', pid: 42 })).toBe('d|pid:42');
  });

  it('keeps a bounded, time-ordered ring per series', () => {
    const s = new MetricsStore();
    s.maxSamples = 3;
    s.push([sample({ appId: 'app:2', ts: 1, cpu: 1 }), sample({ appId: 'app:2', ts: 3, cpu: 3 }), sample({ appId: 'app:2', ts: 2, cpu: 2 })]);
    expect(s.get('d|app:2')!.samples.map((x) => x.ts)).toEqual([1, 2, 3]);
    s.push([sample({ appId: 'app:2', ts: 4, cpu: 4 })]);
    expect(s.get('d|app:2')!.samples.map((x) => x.ts)).toEqual([2, 3, 4]);
    expect(s.latest('d|app:2')?.cpu).toBe(4);
    expect(s.seriesFor({ deviceId: 'd', appId: 'app:2' })).toBeDefined();
    expect(s.removeWhere((x) => x.appId === 'app:2')).toBe(1);
    expect(s.keys()).toEqual([]);
  });
});
