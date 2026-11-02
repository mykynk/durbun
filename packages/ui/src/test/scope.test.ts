import { describe, expect, it } from 'vitest';
import type { AppSession, LogEntry, NetworkEntry } from '@durbun/protocol';
import { compileScope, entryInScope, networkInScope, scopeLogCounts, scopeNetworkCounts } from '../data/scope';
import { LogStore } from '../data/logStore';
import { NetworkStore } from '../data/networkStore';
import { groupApps, sortDevices } from '../data/stores/hub';

const PIXEL = 'android:R5CT20XK9QM';
const SIM = 'ios-sim:7C1F2B9E';

function app(id: string, p: { deviceId?: string; bundle?: string; pid?: number; processName?: string; connected?: boolean; connectedAt?: number } = {}): AppSession {
  return {
    id,
    sessionKey: `s-${id}`,
    deviceId: p.deviceId ?? PIXEL,
    sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter' },
    app: { name: 'Pati', id: p.bundle ?? 'com.mykynk.pati', pid: p.pid, processName: p.processName ?? p.bundle ?? 'com.mykynk.pati' },
    transport: 'adb-reverse',
    connected: p.connected ?? true,
    connectedAt: p.connectedAt ?? 0,
    capabilities: ['logs', 'network'],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  };
}

let id = 1;
function log(p: Partial<LogEntry>): LogEntry {
  return { id: id++, ts: 0, deviceId: PIXEL, source: 'device', level: 'info', tag: 't', message: 'm', ...p };
}

const apps: Record<string, AppSession> = {
  'app:1': app('app:1', { pid: 11873, connected: false, connectedAt: 1 }), // older Pati run
  'app:2': app('app:2', { pid: 12345, connectedAt: 2 }), // current Pati run
  'app:3': app('app:3', { bundle: 'com.mykynk.kasa', pid: 13002 }),
  'app:4': app('app:4', { deviceId: SIM, pid: 48211, processName: 'Runner' }),
};
const hub = { apps };

describe('compileScope', () => {
  it('all scope accepts everything', () => {
    const c = compileScope({ kind: 'all' }, hub);
    expect(c.logs(log({}))).toBe(true);
    expect(c.metrics({ deviceId: 'x' })).toBe(true);
  });

  it('device scope keeps the device, markers and desktop replays', () => {
    const c = compileScope({ kind: 'device', deviceId: PIXEL }, hub);
    expect(c.logs(log({ deviceId: PIXEL }))).toBe(true);
    expect(c.logs(log({ deviceId: SIM }))).toBe(false);
    expect(c.logs(log({ deviceId: SIM, source: 'system', kind: 'marker' }))).toBe(true);
    const n = (deviceId: string): NetworkEntry =>
      ({ id: 'x', deviceId, source: 'dart:io', method: 'GET', url: 'u', host: 'h', path: '/', startTs: 0, state: 'pending', requestHeaders: [], hasRequestBody: false, hasResponseBody: false }) as NetworkEntry;
    expect(c.network(n(PIXEL))).toBe(true);
    expect(c.network(n('desktop'))).toBe(true);
    expect(c.network(n(SIM))).toBe(false);
  });

  it('app scope covers every session of the app on that device by default', () => {
    const c = compileScope({ kind: 'app', appId: 'app:2' }, hub);
    expect([...(c.appIds ?? [])].sort()).toEqual(['app:1', 'app:2']);
    expect(c.logs(log({ appId: 'app:1', source: 'app' }))).toBe(true);
    expect(c.logs(log({ appId: 'app:3', source: 'app' }))).toBe(false);
    // device line attributed by process name (incl. ":remote" sub-processes)
    expect(c.logs(log({ process: 'com.mykynk.pati' }))).toBe(true);
    expect(c.logs(log({ process: 'com.mykynk.pati:remote' }))).toBe(true);
    expect(c.logs(log({ process: 'com.mykynk.kasa' }))).toBe(false);
    // unknown process name → pid decides
    expect(c.logs(log({ pid: 12345 }))).toBe(true);
    expect(c.logs(log({ pid: 999 }))).toBe(false);
    // other device never matches
    expect(c.logs(log({ deviceId: SIM, process: 'com.mykynk.pati' }))).toBe(false);
  });

  it('app scope keeps device-level system lines and the app process lifecycle', () => {
    const c = compileScope({ kind: 'app', appId: 'app:2' }, hub);
    expect(c.logs(log({ source: 'system', code: 'device.connected' }))).toBe(true);
    expect(c.logs(log({ source: 'system', code: 'logs.streamStarted' }))).toBe(true);
    // Real server params: { process, pid } (SPEC §9.2) — a restart's new pid is matched by process name.
    expect(c.logs(log({ source: 'system', code: 'process.started', params: { process: 'com.mykynk.pati', pid: 13001 } }))).toBe(true);
    expect(c.logs(log({ source: 'system', code: 'process.died', params: { process: 'com.android.chrome', pid: 777 } }))).toBe(false);
    // Older { name } params keep working.
    expect(c.logs(log({ source: 'system', code: 'process.died', params: { name: 'com.mykynk.pati', pid: 11873 } }))).toBe(true);
    expect(c.logs(log({ source: 'system', code: 'process.died', params: { name: 'com.android.chrome', pid: 777 } }))).toBe(false);
    expect(c.logs(log({ deviceId: SIM, source: 'system', kind: 'marker', code: 'marker' }))).toBe(true);
  });

  it('exact app scope only matches that session (pid wins over the shared process name)', () => {
    const c = compileScope({ kind: 'app', appId: 'app:2', exact: true }, hub);
    expect([...(c.appIds ?? [])]).toEqual(['app:2']);
    expect(c.logs(log({ appId: 'app:1', source: 'app' }))).toBe(false);
    expect(c.logs(log({ pid: 12345, process: 'com.mykynk.pati' }))).toBe(true);
    expect(c.logs(log({ pid: 11873, process: 'com.mykynk.pati' }))).toBe(false);
    // pid reused by another process later
    expect(c.logs(log({ pid: 12345, process: 'com.android.vending' }))).toBe(false);
  });

  it('metrics follow app sessions or their pids', () => {
    const c = compileScope({ kind: 'app', appId: 'app:4' }, hub);
    expect(c.metrics({ deviceId: SIM, appId: 'app:4' })).toBe(true);
    expect(c.metrics({ deviceId: SIM, pid: 48211 })).toBe(true);
    expect(c.metrics({ deviceId: SIM, pid: 1 })).toBe(false);
  });

  it('unknown app ids degrade to a plain appId filter', () => {
    const c = compileScope({ kind: 'app', appId: 'app:99' }, hub);
    expect(c.logs(log({ appId: 'app:99' }))).toBe(true);
    expect(c.logs(log({}))).toBe(false);
  });

  it('entryInScope / networkInScope are one-off conveniences', () => {
    expect(entryInScope(log({ appId: 'app:3' }), { kind: 'app', appId: 'app:3' }, hub)).toBe(true);
    const e = { id: 'x', appId: 'app:3', deviceId: PIXEL } as NetworkEntry;
    expect(networkInScope(e, { kind: 'app', appId: 'app:2' }, hub)).toBe(false);
  });
});

describe('scope counters', () => {
  it('sums incremental counters for the scope without scanning', () => {
    const logs = new LogStore();
    logs.append([log({ appId: 'app:1', level: 'error' }), log({ appId: 'app:2' }), log({ appId: 'app:3', level: 'error' }), log({ deviceId: SIM })]);
    expect(scopeLogCounts(compileScope({ kind: 'all' }, hub), logs).total).toBe(4);
    expect(scopeLogCounts(compileScope({ kind: 'device', deviceId: SIM }, hub), logs).total).toBe(1);
    const pati = scopeLogCounts(compileScope({ kind: 'app', appId: 'app:2' }, hub), logs);
    expect(pati).toEqual({ total: 2, warn: 0, error: 1, crash: 0 });

    const nets = new NetworkStore();
    nets.upsert([
      { id: 'a', appId: 'app:2', deviceId: PIXEL, state: 'failed' } as NetworkEntry,
      { id: 'b', deviceId: 'desktop', state: 'complete', status: 200 } as NetworkEntry,
    ]);
    expect(scopeNetworkCounts(compileScope({ kind: 'app', appId: 'app:2' }, hub), nets)).toMatchObject({ total: 2, failed: 1 });
  });
});

describe('device and app grouping', () => {
  it('groups sessions of the same app on the same device, connected session first', () => {
    const groups = groupApps(Object.values(apps));
    const pixel = groups.get(PIXEL)!;
    const pati = pixel.find((g) => g.bundleId === 'com.mykynk.pati')!;
    expect(pati.latest?.id).toBe('app:2');
    expect(pati.sessions.map((s) => s.id)).toEqual(['app:2', 'app:1']);
    expect(groups.get(SIM)).toHaveLength(1);
  });

  it('sorts devices: live before demo/import, disconnected last, then first seen', () => {
    const d = (id: string, firstSeen: number, state: 'online' | 'disconnected' = 'online') =>
      ({ id, name: id, firstSeen, state, platform: 'android', kind: 'physical', connection: 'usb', logs: { status: 'streaming' }, actions: [], lastSeen: 0 }) as never;
    const sorted = sortDevices([d('import:1', 0), d('demo:1', 1), d('android:b', 5, 'disconnected'), d('android:a', 9)]);
    expect(sorted.map((x: { id: string }) => x.id)).toEqual(['android:a', 'android:b', 'demo:1', 'import:1']);
  });
});
