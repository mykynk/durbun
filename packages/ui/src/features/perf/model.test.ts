import { describe, expect, it } from 'vitest';
import type { AppSession, MetricSample } from '@durbun/protocol';
import {
  MAX_HISTORY_MS,
  RateBuckets,
  appsStructureKey,
  canPoll,
  chooseFieldSource,
  csvEscape,
  csvFileName,
  defaultTarget,
  downsample,
  fieldStats,
  gapThresholdMs,
  jankPerSecond,
  jankStats,
  joinPoints,
  lowerBoundTs,
  mergeSamples,
  niceCeil,
  perSecondRows,
  rateSeries,
  rateStats,
  rateStepSec,
  rowsToCsv,
  sliceByTime,
  slugify,
  targetKey,
  targetSessions,
  toPoints,
  typicalIntervalMs,
  windowRange,
  yRange,
} from './model';

const DEV = 'android:R5CT';
const T0 = Date.UTC(2026, 10, 2, 11, 0, 0); // 2026-11-02T11:00:00Z

function sample(sec: number, p: Partial<MetricSample> = {}): MetricSample {
  return { ts: T0 + sec * 1000, deviceId: DEV, source: 'sdk', ...p };
}

function app(id: string, p: { bundle?: string; deviceId?: string; connected?: boolean; connectedAt?: number; metrics?: boolean; pid?: number } = {}): AppSession {
  return {
    id,
    sessionKey: `s-${id}`,
    deviceId: p.deviceId ?? DEV,
    sdk: { name: 'durbun-flutter', version: '0.1.0', platform: 'flutter' },
    app: { name: 'Pati', id: p.bundle ?? 'com.mykynk.pati', pid: p.pid },
    transport: 'adb-reverse',
    connected: p.connected ?? true,
    connectedAt: p.connectedAt ?? 0,
    capabilities: p.metrics === false ? ['logs'] : ['logs', 'metrics'],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  };
}

describe('windows', () => {
  it('fixed windows end at now', () => {
    expect(windowRange('1m', T0, undefined, undefined)).toEqual({ from: T0 - 60_000, to: T0 });
    expect(windowRange('15m', T0, T0 - 5000, T0 - 3_600_000)).toEqual({ from: T0 - 900_000, to: T0 });
  });
  it('a device clock slightly ahead moves the right edge, a wildly wrong one does not', () => {
    expect(windowRange('1m', T0, T0 + 4000, undefined).to).toBe(T0 + 4000);
    expect(windowRange('1m', T0, T0 + 3_600_000, undefined).to).toBe(T0);
  });
  it('"all" starts at the oldest data point, bounded and at least one minute wide', () => {
    expect(windowRange('all', T0, T0, T0 - 600_000)).toEqual({ from: T0 - 600_000, to: T0 });
    expect(windowRange('all', T0, T0, T0 - 10_000).from).toBe(T0 - 60_000);
    expect(windowRange('all', T0, T0, T0 - 10 * MAX_HISTORY_MS).from).toBe(T0 - MAX_HISTORY_MS);
  });
  it('rate buckets get coarser on wide windows', () => {
    expect(rateStepSec(60_000)).toBe(1);
    expect(rateStepSec(300_000)).toBe(2);
    expect(rateStepSec(900_000)).toBe(5);
    expect(rateStepSec(3_600_000)).toBe(10);
    expect(rateStepSec(7_200_000)).toBe(20);
  });
});

describe('targets', () => {
  const apps = {
    'app:1': app('app:1', { connected: false, connectedAt: 1, pid: 100 }),
    'app:2': app('app:2', { connected: true, connectedAt: 2, pid: 200 }),
    'app:3': app('app:3', { bundle: 'com.mykynk.mahalle', connectedAt: 3, metrics: false }),
    'app:4': app('app:4', { bundle: 'com.other', deviceId: 'ios-sim:1', connectedAt: 9 }),
  };
  it('keys are stable per app group / process', () => {
    expect(targetKey({ kind: 'app', deviceId: DEV, bundleId: 'b', appId: 'app:1' })).toBe(targetKey({ kind: 'app', deviceId: DEV, bundleId: 'b', appId: 'app:9' }));
    expect(targetKey({ kind: 'process', deviceId: DEV, pid: 5 })).toBe(`proc|${DEV}|5`);
    expect(targetKey(null)).toBe('');
  });
  it('app scope targets the scoped app', () => {
    expect(defaultTarget({ kind: 'app', appId: 'app:1' }, apps)).toEqual({ kind: 'app', deviceId: DEV, bundleId: 'com.mykynk.pati', appId: 'app:1' });
    expect(defaultTarget({ kind: 'app', appId: 'missing' }, apps)).toBeNull();
  });
  it('device/all scopes prefer connected apps with the metrics capability, newest first', () => {
    expect((defaultTarget({ kind: 'device', deviceId: DEV }, apps) as { appId: string }).appId).toBe('app:2');
    expect((defaultTarget({ kind: 'all' }, apps) as { appId: string }).appId).toBe('app:4');
    expect(defaultTarget({ kind: 'device', deviceId: 'nothing' }, apps)).toBeNull();
    // An app without metrics is never picked by default.
    expect(defaultTarget({ kind: 'device', deviceId: DEV }, { 'app:3': apps['app:3'] })).toBeNull();
  });
  it('sessions of an app target are the group, connected first', () => {
    const t = { kind: 'app' as const, deviceId: DEV, bundleId: 'com.mykynk.pati', appId: 'app:1' };
    expect(targetSessions(t, apps).map((a) => a.id)).toEqual(['app:2', 'app:1']);
    expect(targetSessions({ kind: 'process', deviceId: DEV, pid: 1 }, apps)).toEqual([]);
  });
  it('the apps structure key ignores per-log stats but tracks connection, pid and action values', () => {
    const a = app('app:1', { pid: 1 });
    const base = appsStructureKey({ 'app:1': a });
    expect(appsStructureKey({ 'app:1': { ...a, stats: { logs: 999, requests: 5, errors: 2 } } })).toBe(base);
    expect(appsStructureKey({ 'app:1': { ...a, connected: false } })).not.toBe(base);
    expect(appsStructureKey({ 'app:1': { ...a, app: { ...a.app, pid: 2 } } })).not.toBe(base);
    const withAction = { ...a, actions: [{ id: 'flutter.debugPaint', kind: 'toggle' as const, label: 'Debug paint', value: false }] };
    const k1 = appsStructureKey({ 'app:1': withAction }, { actions: true });
    const k2 = appsStructureKey({ 'app:1': { ...withAction, actions: [{ ...withAction.actions[0]!, value: true }] } }, { actions: true });
    expect(k1).not.toBe(k2);
    expect(appsStructureKey({ 'app:1': withAction })).toBe(appsStructureKey({ 'app:1': { ...withAction, actions: [] } }));
  });
  it('only live, local devices can be polled', () => {
    expect(canPoll({ id: 'android:x', state: 'online' })).toBe(true);
    expect(canPoll({ id: 'demo:1', state: 'online' })).toBe(true);
    expect(canPoll({ id: 'android:x', state: 'offline' })).toBe(false);
    expect(canPoll({ id: 'import:1', state: 'online' })).toBe(false);
    expect(canPoll({ id: 'net:android-x', state: 'online' })).toBe(false);
    expect(canPoll(undefined)).toBe(false);
  });
});

describe('samples', () => {
  const a = [sample(0, { cpu: 1 }), sample(2, { cpu: 3 }), sample(4, { cpu: 5 })];
  const b = [sample(1, { cpu: 2 }), sample(3, { cpu: 4 })];
  it('merges series by time and slices windows with binary search', () => {
    const m = mergeSamples([a, [], b]);
    expect(m.map((s) => s.cpu)).toEqual([1, 2, 3, 4, 5]);
    expect(mergeSamples([a])).toBe(a);
    expect(lowerBoundTs(m, T0 + 2500)).toBe(3);
    expect(sliceByTime(m, T0 + 1000, T0 + 3000).map((s) => s.cpu)).toEqual([2, 3, 4]);
    expect(sliceByTime(m, T0 - 1000, T0 + 9000)).toBe(m);
  });
  it('estimates the sampling interval and the gap threshold', () => {
    expect(typicalIntervalMs(a)).toBe(2000);
    expect(typicalIntervalMs([])).toBe(1000);
    expect(gapThresholdMs(1000)).toBe(5000);
    expect(gapThresholdMs(2000)).toBe(7000);
  });
  it('picks the app samples for a field and falls back to polled process samples', () => {
    const app = [sample(0, { heapMB: 40, fps: 60 })];
    const proc = [sample(0, { cpu: 12, memoryMB: 200 })];
    expect(chooseFieldSource(app, proc, 'heapMB').source).toBe('primary');
    expect(chooseFieldSource(app, proc, 'cpu').source).toBe('supplement');
    expect(chooseFieldSource(app, proc, 'threads')).toEqual({ samples: [], source: 'none' });
  });
});

describe('chart points', () => {
  it('skips samples without the field and breaks the line on long pauses', () => {
    const s = [sample(0, { cpu: 1 }), sample(1, {}), sample(2, { cpu: 3 }), sample(30, { cpu: 4 })];
    const p = toPoints(s, 'cpu', { gapMs: 5000 });
    expect(p.ys).toEqual([1, 3, null, 4]);
    expect(p.xs[2]).toBe((T0 + 16_000) / 1000);
  });
  it('treats absent/0 fps as idle (a gap), never as a drop to 0', () => {
    const s = [sample(0, { fps: 60 }), sample(1, { fps: 0 }), sample(2, {}), sample(3, { fps: 58 })];
    expect(toPoints(s, 'fps', { zeroIsIdle: true }).ys).toEqual([60, null, 58]);
    expect(toPoints(s, 'fps').ys).toEqual([60, 0, 58]);
  });
  it('derives janky frames per second from the sample spacing', () => {
    expect(jankPerSecond(sample(2, { jankyFrames: 4 }), sample(0), 1000)).toBe(2);
    expect(jankPerSecond(sample(0, { jankyFrames: 3 }), undefined, 1000)).toBe(3);
    expect(jankPerSecond(sample(0), undefined, 1000)).toBeUndefined();
    const p = toPoints([sample(0, { jankyFrames: 2 }), sample(2, { jankyFrames: 6 })], 'jankyFrames', { value: (x, prev) => jankPerSecond(x, prev, 1000) });
    expect(p.ys).toEqual([2, 3]);
  });
  it('aligns series on one x axis (missing → undefined, gaps stay null)', () => {
    const j = joinPoints([
      { xs: [1, 2, 3], ys: [10, null, 30] },
      { xs: [2, 4], ys: [5, 6] },
    ]);
    expect(j.xs).toEqual([1, 2, 3, 4]);
    expect(j.ys).toEqual([
      [10, null, 30, undefined],
      [undefined, 5, undefined, 6],
    ]);
    expect(joinPoints([{ xs: [1], ys: [2] }]).ys).toEqual([[2]]);
  });
});

describe('stats', () => {
  it('now / avg / peak over the window', () => {
    const s = [sample(0, { memoryMB: 100 }), sample(1, { memoryMB: 300 }), sample(2, { memoryMB: 200 }), sample(3, {})];
    const st = fieldStats(s, 'memoryMB');
    expect(st).toMatchObject({ now: 200, nowTs: T0 + 2000, avg: 200, peak: 300, count: 3, idle: false });
    expect(st.trend).toEqual([100, 300, 200]);
    expect(fieldStats([], 'cpu')).toMatchObject({ now: undefined, avg: undefined, count: 0, idle: false });
  });
  it('flags an idle Flutter app instead of reporting 0 fps', () => {
    const st = fieldStats([sample(0, { fps: 60 }), sample(1, { fps: 50 }), sample(2, {})], 'fps', { zeroIsIdle: true });
    expect(st.idle).toBe(true);
    expect(st.now).toBeUndefined();
    expect(st.avg).toBe(55);
  });
  it('jank: per second now and share of rendered frames', () => {
    const s = [sample(0, { fps: 60, jankyFrames: 0 }), sample(1, { fps: 60, jankyFrames: 3 }), sample(2, { fps: 60, jankyFrames: 3 })];
    const j = jankStats(s, 1000);
    expect(j.total).toBe(6);
    expect(j.perSecNow).toBe(3);
    expect(j.percent).toBeCloseTo((6 / 180) * 100, 5);
    expect(jankStats([sample(0, { fps: 60 })], 1000)).toMatchObject({ total: 0, count: 0, percent: undefined });
  });
  it('downsamples long series to the sparkline size', () => {
    const d = downsample(Array.from({ length: 480 }, (_, i) => i), 48);
    expect(d).toHaveLength(48);
    expect(d[0]).toBe(4.5);
    expect(downsample([1, 2], 48)).toEqual([1, 2]);
  });
});

describe('rate buckets', () => {
  const now = T0 + 120_000;
  it('counts per second and ignores data outside the retained range', () => {
    const b = new RateBuckets();
    b.add(T0 + 100, 'logs', 1, now);
    b.add(T0 + 900, 'logs', 2, now);
    b.add(T0 + 1500, 'errorLogs', 1, now);
    b.add(now - MAX_HISTORY_MS - 1000, 'logs', 1, now);
    b.add(now + 60 * 60 * 1000, 'logs', 1, now);
    b.add(Number.NaN, 'logs', 1, now);
    const s = T0 / 1000;
    expect(b.count(s, 'logs')).toBe(3);
    expect(b.series(s, s + 2, 'logs')).toEqual([3, 0, 0]);
    expect(b.sum(s, s + 1, 'errorLogs')).toBe(1);
    expect(b.earliestSec()).toBe(s);
    expect(b.size).toBe(2);
    b.prune(s + 1);
    expect(b.earliestSec()).toBe(s + 1);
    expect(b.count(s, 'logs')).toBe(0);
  });
  it('averages steps into events per second, counting complete seconds only', () => {
    const b = new RateBuckets();
    const s = T0 / 1000;
    for (let i = 0; i < 10; i++) b.add((s + i) * 1000, 'requests', i % 2 === 0 ? 2 : 0, now);
    const r = rateSeries(b, s, s + 9, 5, ['requests', 'failedRequests']);
    expect(r.xs).toEqual([s, s + 5]);
    expect(r.ys[0]).toEqual([(2 + 2 + 2) / 5, (2 + 2) / 5]);
    expect(r.ys[1]).toEqual([0, 0]);
    expect(rateSeries(b, s + 5, s, 1, ['requests']).xs).toEqual([]);
  });
  it('rate stats: last-3-seconds "now", window average and total', () => {
    const b = new RateBuckets();
    const s = T0 / 1000;
    for (let i = 0; i < 60; i++) b.add((s + i) * 1000, 'logs', i >= 57 ? 10 : 1, now);
    const st = rateStats(b, s, s + 59, 'logs');
    expect(st.now).toBe(10);
    expect(st.total).toBe(57 + 30);
    expect(st.avg).toBeCloseTo(87 / 60, 6);
    expect(st.trend.length).toBeLessThanOrEqual(48);
  });
});

describe('CSV', () => {
  it('one row per second: gauges averaged, janky frames summed, logs/requests from every bucket source', () => {
    const logs = new RateBuckets();
    const net = new RateBuckets();
    const now = T0 + 10_000;
    logs.add(T0 + 200, 'logs', 5, now);
    logs.add(T0 + 300, 'errorLogs', 1, now);
    net.add(T0 + 1200, 'requests', 2, now);
    net.add(T0 + 1300, 'failedRequests', 1, now);
    const samples = [sample(0, { cpu: 10, jankyFrames: 1 }), sample(0.5, { cpu: 20, jankyFrames: 2 }), sample(2, { cpu: 30 })];
    const rows = perSecondRows({ cpu: samples, jankyFrames: samples }, [logs, net], T0 / 1000, T0 / 1000 + 2);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ cpu: 15, jankyFrames: 3, logs: 5, errorLogs: 1, requests: 0 });
    expect(rows[1]).toMatchObject({ requests: 2, failedRequests: 1, logs: 0 });
    expect(rows[1]!.cpu).toBeUndefined();
    expect(rows[2]!.cpu).toBe(30);
    expect(perSecondRows({}, [], 5, 4)).toEqual([]);
  });
  it('RFC 4180 output with UTC times and dot decimals', () => {
    const csv = rowsToCsv([{ sec: T0 / 1000, cpu: 12.346, memoryMB: 200, logs: 3, errorLogs: 0, requests: 1, failedRequests: 0 }]);
    const [header, line, end] = csv.split('\r\n');
    expect(header).toBe('time,epoch_ms,cpu_percent,memory_mb,heap_mb,fps,janky_frames,frame_build_ms,frame_raster_ms,threads,logs,error_logs,requests,failed_requests');
    expect(line).toBe(`2026-11-02T11:00:00Z,${T0},12.35,200,,,,,,,3,0,1,0`);
    expect(end).toBe('');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('plain')).toBe('plain');
  });
  it('file names are ASCII slugs (Turkish letters transliterated)', () => {
    expect(slugify('Pati · Pixel 8 · Demo')).toBe('pati-pixel-8-demo');
    expect(slugify('Şık Ürün Çiçeği İğne')).toBe('sik-urun-cicegi-igne');
    expect(slugify('···')).toBe('target');
    expect(csvFileName('Pati', new Date(2026, 10, 2, 14, 5, 9).getTime())).toBe('durbun-perf-pati-20261102-140509.csv');
  });
});

describe('axis helpers', () => {
  it('nice ceilings and zero-based ranges with headroom', () => {
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(1.3)).toBe(2);
    expect(niceCeil(230)).toBe(250);
    expect(niceCeil(0)).toBe(1);
    expect(yRange(54, 60)).toEqual([0, 100]);
    expect(yRange(54, 60, true)).toEqual([0, 60]);
    expect(yRange(118, 120, true)).toEqual([0, 120]);
    expect(yRange(130, 120, true)).toEqual([0, 200]);
    expect(yRange(null, 10)).toEqual([0, 10]);
    expect(yRange(200, 1)).toEqual([0, 250]);
  });
});
