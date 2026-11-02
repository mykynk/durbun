import { describe, expect, it } from 'vitest';
import type { AppSession, DeviceInfo, LogEntry, NetworkEntry, ProcessUpdate } from '@durbun/protocol';
import { LogTraffic, annotationType, isErrorLog, networkTraffic, type LogSource } from './traffic';
import { clusterAnnotations } from './EventLane';
import { buildOptions, filterOptions } from './TargetPicker';

const DEV = 'demo:1';
const T0 = Date.UTC(2026, 10, 2, 11, 0, 0);

let nextId = 1;
function log(sec: number, p: Partial<LogEntry> = {}): LogEntry {
  return { id: nextId++, ts: T0 + sec * 1000, deviceId: DEV, source: 'app', appId: 'app:1', level: 'info', tag: 'app', message: 'hello', ...p };
}

/** A minimal LogStore stand-in (entries ordered by id). */
class FakeStore implements LogSource {
  entries: LogEntry[] = [];
  generation = 0;
  get lastId() {
    return this.entries[this.entries.length - 1]?.id ?? 0;
  }
  lowerBound(id: number): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid]!.id < id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

const describe2 = (e: LogEntry) => e.message.split('\n')[0]!;

describe('annotations', () => {
  it('classifies crashes, ANRs, markers and app (re)connects', () => {
    expect(annotationType(log(0, { kind: 'crash', level: 'fatal' }))).toBe('crash');
    expect(annotationType(log(0, { kind: 'anr', level: 'error' }))).toBe('anr');
    expect(annotationType(log(0, { kind: 'marker', source: 'system' }))).toBe('marker');
    expect(annotationType(log(0, { source: 'system', code: 'app.connected' }))).toBe('connect');
    expect(annotationType(log(0, { source: 'system', code: 'app.reconnected' }))).toBe('reconnect');
    expect(annotationType(log(0, { source: 'system', code: 'app.disconnected' }))).toBeNull();
    expect(annotationType(log(0, { kind: 'flutter-error', level: 'error' }))).toBeNull();
    expect(isErrorLog({ level: 'fatal' })).toBe(true);
    expect(isErrorLog({ level: 'warn' })).toBe(false);
  });
});

describe('LogTraffic', () => {
  it('buckets logs and error logs per second and collects annotations', () => {
    const store = new FakeStore();
    store.entries.push(
      log(0),
      log(0.2, { level: 'error' }),
      log(1, { appId: 'app:other' }),
      log(1.5, { kind: 'crash', level: 'fatal', message: 'Unhandled exception\n#0 main' }),
      log(2, { kind: 'marker', source: 'system', appId: undefined, deviceId: '', message: 'Login' }),
    );
    const inScope = (e: LogEntry) => e.appId === 'app:1' || e.kind === 'marker';
    const tr = new LogTraffic();
    expect(tr.update(store, 'k', inScope, describe2, T0 + 5000)).toBe(true);
    const s = T0 / 1000;
    expect(tr.buckets.series(s, s + 2, 'logs')).toEqual([2, 1, 1]);
    expect(tr.buckets.series(s, s + 2, 'errorLogs')).toEqual([1, 1, 0]);
    expect(tr.annotations.map((a) => [a.type, a.text])).toEqual([
      ['crash', 'Unhandled exception'],
      ['marker', 'Login'],
    ]);
  });

  it('scans only new entries and resets on key or generation change', () => {
    const store = new FakeStore();
    store.entries.push(log(0), log(1));
    let calls = 0;
    const inScope = () => {
      calls++;
      return true;
    };
    const tr = new LogTraffic();
    tr.update(store, 'a', inScope, describe2, T0 + 5000);
    expect(calls).toBe(2);
    const rev = tr.revision;
    expect(tr.update(store, 'a', inScope, describe2, T0 + 5000)).toBe(false);
    expect(tr.revision).toBe(rev);
    store.entries.push(log(2));
    tr.update(store, 'a', inScope, describe2, T0 + 5000);
    expect(calls).toBe(3);
    expect(tr.buckets.sum(T0 / 1000, T0 / 1000 + 2, 'logs')).toBe(3);
    // A different target rescans everything from scratch.
    tr.update(store, 'b', inScope, describe2, T0 + 5000);
    expect(calls).toBe(6);
    expect(tr.buckets.sum(T0 / 1000, T0 / 1000 + 2, 'logs')).toBe(3);
    // Store cleared / resynced → generation bump → rebuild.
    store.generation++;
    store.entries = [log(3)];
    tr.update(store, 'b', inScope, describe2, T0 + 5000);
    expect(tr.buckets.sum(T0 / 1000, T0 / 1000 + 3, 'logs')).toBe(1);
  });

  it('an empty key (no target) collects nothing', () => {
    const store = new FakeStore();
    store.entries.push(log(0));
    const tr = new LogTraffic();
    tr.update(store, '', () => true, describe2, T0);
    expect(tr.buckets.size).toBe(0);
  });
});

describe('networkTraffic', () => {
  const net = (id: string, p: Partial<NetworkEntry>): NetworkEntry => ({
    id,
    appId: 'app:1',
    deviceId: DEV,
    source: 'demo',
    method: 'GET',
    url: 'https://api.pati.app/x',
    host: 'api.pati.app',
    path: '/x',
    startTs: T0,
    state: 'complete',
    requestHeaders: [],
    hasRequestBody: false,
    hasResponseBody: false,
    ...p,
  });
  it('counts requests by start time and failures by end time', () => {
    const list = [
      net('a', { startTs: T0, status: 200 }),
      net('b', { startTs: T0 + 100, endTs: T0 + 2500, state: 'failed', error: 'timeout' }),
      net('c', { startTs: T0 + 1000, endTs: T0 + 1200, status: 503 }),
      net('d', { startTs: T0, appId: 'app:2' }),
    ];
    const isError = (e: NetworkEntry) => e.state === 'failed' || (e.status ?? 0) >= 400;
    const b = networkTraffic(list, (e) => e.appId === 'app:1', isError, T0 + 5000);
    const s = T0 / 1000;
    expect(b.series(s, s + 2, 'requests')).toEqual([2, 1, 0]);
    expect(b.series(s, s + 2, 'failedRequests')).toEqual([0, 1, 1]);
  });
});

describe('event lane clustering', () => {
  it('groups events closer than a marker width and keeps the most severe type', () => {
    const a = (id: number, sec: number, type: 'crash' | 'marker' | 'connect') => ({ id, ts: T0 + sec * 1000, type, text: '' });
    const clusters = clusterAnnotations([a(1, 10, 'connect'), a(2, 10.5, 'crash'), a(3, 40, 'marker'), a(4, 120, 'marker')], T0, T0 + 60_000, 600);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ type: 'crash' });
    expect(clusters[0]!.items.map((i) => i.id)).toEqual([1, 2]);
    expect(clusters[1]!.x).toBe(400);
    expect(clusterAnnotations([], T0, T0, 100)).toEqual([]);
  });
});

describe('target picker options', () => {
  const device = (id: string, state: DeviceInfo['state'] = 'online'): DeviceInfo => ({
    id,
    platform: 'android',
    kind: 'emulator',
    name: id === DEV ? 'Pixel 8 · Demo' : 'Other',
    connection: 'local',
    state,
    logs: { status: 'streaming' },
    actions: [],
    firstSeen: 0,
    lastSeen: 0,
  });
  const session = (id: string, p: { bundle?: string; name?: string; connected?: boolean; connectedAt?: number; caps?: AppSession['capabilities']; deviceId?: string }): AppSession => ({
    id,
    sessionKey: id,
    deviceId: p.deviceId ?? DEV,
    sdk: { name: 'demo', version: '1', platform: 'flutter' },
    app: { name: p.name ?? 'Pati', id: p.bundle ?? 'com.mykynk.pati' },
    transport: 'demo',
    connected: p.connected ?? true,
    connectedAt: p.connectedAt ?? 0,
    capabilities: p.caps ?? ['metrics'],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  });
  const proc = (pid: number, name: string, event: ProcessUpdate['event'] = 'seen'): ProcessUpdate => ({ deviceId: DEV, pid, name, event, ts: 0 });
  const labels = { sessions: (n: number) => `${n} sessions`, pid: (p: number) => `pid ${p}`, vm: 'VM Service', sdk: 'SDK' };

  it('one option per app group (newest session), processes of pollable devices only', () => {
    const opts = buildOptions({
      scopeDeviceIds: null,
      apps: {
        'app:1': session('app:1', { connected: false, connectedAt: 1 }),
        'app:2': session('app:2', { connectedAt: 2 }),
        'app:3': session('app:3', { bundle: 'com.mykynk.mahalle', name: 'Mahalle', caps: ['logs'] }),
        'app:9': session('app:9', { bundle: 'x', name: 'Imported', deviceId: 'import:1' }),
      },
      devices: { [DEV]: device(DEV), 'import:1': device('import:1') },
      processes: { [DEV]: { 1043: proc(1043, 'system_server'), 8421: proc(8421, 'com.mykynk.pati', 'died') }, 'import:1': { 5: proc(5, 'x') } },
      labels,
    });
    // Connected first, apps that send metrics before those that do not, then by name.
    expect(opts.apps.map((o) => [o.name, o.connected, o.noMetrics])).toEqual([
      ['Imported', true, false],
      ['Pati', true, false],
      ['Mahalle', true, true],
    ]);
    const pati = opts.apps.find((o) => o.name === 'Pati')!;
    expect(pati.target).toMatchObject({ kind: 'app', appId: 'app:2' });
    expect(pati.detail).toBe('com.mykynk.pati · 2 sessions');
    // import:<n> devices cannot be polled; alive processes first.
    expect(opts.processes.map((o) => [o.name, o.died])).toEqual([
      ['system_server', false],
      ['com.mykynk.pati', true],
    ]);
  });

  it('scopes to devices and filters by every search term', () => {
    const opts = buildOptions({
      scopeDeviceIds: ['nothing'],
      apps: { 'app:2': session('app:2', {}) },
      devices: { [DEV]: device(DEV) },
      processes: { [DEV]: { 1: proc(1, 'init') } },
      labels,
    });
    expect(opts.apps).toEqual([]);
    expect(opts.processes).toEqual([]);
    const all = buildOptions({ scopeDeviceIds: null, apps: {}, devices: { [DEV]: device(DEV) }, processes: { [DEV]: { 1043: proc(1043, 'system_server'), 312: proc(312, 'logd') } }, labels });
    expect(filterOptions(all.processes, 'system').map((o) => o.name)).toEqual(['system_server']);
    expect(filterOptions(all.processes, '312').map((o) => o.name)).toEqual(['logd']);
    expect(filterOptions(all.processes, 'pixel logd').map((o) => o.name)).toEqual(['logd']);
    expect(filterOptions(all.processes, '').length).toBe(2);
  });
});
