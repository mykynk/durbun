import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, DeviceApp, DeviceInfo, LogEntry, ProcessUpdate } from '@durbun/protocol';
import { compileScope, scopeLogCounts, scopeSignature, scopeTarget } from '../data/scope';
import { LogStore } from '../data/logStore';
import { groupApps, hubActions, useHub, type HubState } from '../data/stores/hub';
import { useScopeStore, setScope } from '../data/stores/scope';
import { handleServerMessage, validateScope } from '../data/dispatch';

/* Realistic ids and process names: an Android phone with a Play build (no SDK) and a Flutter debug app with the SDK,
 * an iPhone where two Flutter apps are both "Runner". */
const PIXEL = 'android:R5CT20XK9QM';
const IPHONE = 'ios:00008120-001A2C3E0E43C01E';

function da(deviceId: string, id: string, p: Partial<DeviceApp> = {}): DeviceApp {
  return {
    key: `${deviceId}|${id}`,
    deviceId,
    id,
    buildType: 'release',
    install: { source: 'play', installer: 'com.android.vending' },
    pids: [],
    running: false,
    lastActivity: 0,
    ...p,
  };
}

function app(id: string, p: { deviceId?: string; bundle?: string; pid?: number; processName?: string; connected?: boolean; connectedAt?: number; name?: string } = {}): AppSession {
  return {
    id,
    sessionKey: `s-${id}`,
    deviceId: p.deviceId ?? PIXEL,
    sdk: { name: 'durbun-flutter', version: '0.3.0', platform: 'flutter' },
    app: { name: p.name ?? 'Pati', id: p.bundle ?? 'com.mykynk.pati', pid: p.pid, processName: p.processName },
    transport: 'adb-reverse',
    connected: p.connected ?? true,
    connectedAt: p.connectedAt ?? 0,
    capabilities: ['logs', 'network', 'mocks', 'metrics'],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  };
}

let nextId = 1;
function log(p: Partial<LogEntry>): LogEntry {
  return { id: nextId++, ts: 1_793_600_000_000, deviceId: PIXEL, source: 'device', origin: 'logcat', level: 'info', tag: 'flutter', message: 'm', ...p };
}

const KUMBARA = da(PIXEL, 'com.mykynk.kumbara', { name: 'Kumbara', version: '3.1.0', build: '412', pids: [12873, 12901], running: true, lastActivity: 5000 });
const RUNNER_A = da(IPHONE, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' }, processName: 'Runner', pids: [811], running: true });
const RUNNER_B = da(IPHONE, 'com.mykynk.pati', { install: { source: 'xcode' }, buildType: 'debug', processName: 'Runner', pids: [902], running: true });

function hub(extra: Partial<HubState> = {}): Pick<HubState, 'apps' | 'deviceApps' | 'processes'> {
  return {
    apps: {},
    deviceApps: { [KUMBARA.key]: KUMBARA, [RUNNER_A.key]: RUNNER_A, [RUNNER_B.key]: RUNNER_B },
    processes: {},
    ...extra,
  };
}

describe('device-app scope (SDK-less apps)', () => {
  const scope = { kind: 'deviceApp' as const, deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' };

  it('matches device lines by pid, by process name and by ":service" sub-processes', () => {
    const c = compileScope(scope, hub());
    expect(c.deviceId).toBe(PIXEL);
    expect(c.bundleId).toBe('com.mykynk.kumbara');
    expect(c.deviceApp?.name).toBe('Kumbara');
    // logcat threadtime line whose process is not resolved yet → pid decides
    expect(c.logs(log({ pid: 12873, tag: 'flutter', message: 'I/flutter: sepet güncellendi' }))).toBe(true);
    expect(c.logs(log({ pid: 4242 }))).toBe(false);
    expect(c.logs(log({ process: 'com.mykynk.kumbara', pid: 13555 }))).toBe(true); // restarted, new pid
    expect(c.logs(log({ process: 'com.mykynk.kumbara:push', pid: 12999 }))).toBe(true);
    expect(c.logs(log({ process: 'com.android.vending', pid: 12873 }))).toBe(false); // pid reused by another process
    expect(c.logs(log({ deviceId: IPHONE, pid: 12873 }))).toBe(false);
  });

  it('counts the app’s processes under other names by live pid: iOS extensions, Android global-named processes (regression)', () => {
    const kumbara = da(IPHONE, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' }, processName: 'Runner', pids: [3100, 3150], running: true });
    const whatsapp = da(IPHONE, 'net.whatsapp.WhatsApp', { install: { source: 'store-or-testflight' }, processName: 'WhatsApp', pids: [4000], running: true });
    const h = { apps: {}, deviceApps: { [kumbara.key]: kumbara, [RUNNER_B.key]: RUNNER_B, [whatsapp.key]: whatsapp }, processes: {} };
    const ios = compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.kumbara' }, h);
    const at = (p: Partial<LogEntry>) => log({ deviceId: IPHONE, origin: 'idevicesyslog', ...p });
    // …/Kumbara.app/PlugIns/KumbaraWidgetExtension.appex: its pid is one of the app's.
    expect(ios.logs(at({ process: 'KumbaraWidgetExtension', pid: 3150 }))).toBe(true);
    expect(ios.logs(at({ process: 'KumbaraWidgetExtension', pid: 7777 }))).toBe(false);
    // Round 1's Runner protection stays: Pati's "Runner" is not Kumbara's.
    expect(ios.logs(at({ process: 'Runner', pid: 902 }))).toBe(false);
    expect(ios.logs(at({ process: 'Runner', pid: 3100 }))).toBe(true);
    // A name another app owns never counts, even if Kumbara got its old pid.
    expect(ios.logs(at({ process: 'WhatsApp', pid: 3150 }))).toBe(false);
    const android = compileScope(scope, hub());
    expect(android.logs(log({ process: 'com.mykynk.kumbara.remote', pid: 12901 }))).toBe(true);
    expect(android.logs(log({ process: 'com.mykynk.sync', pid: 12901 }))).toBe(true);
    expect(android.logs(log({ process: 'com.mykynk.kumbara.remote', pid: 4242 }))).toBe(false);
    expect(android.logs(log({ process: 'com.android.vending', pid: 12873 }))).toBe(false); // another package: an old line with a recycled pid
    // The compiled scope follows the device's live pids.
    const moved = { ...h, deviceApps: { ...h.deviceApps, [kumbara.key]: { ...kumbara, pids: [3100] } } };
    expect(scopeSignature({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.kumbara' }, moved)).not.toBe(ios.key);
  });

  it('includes SDK sessions of the same app and their traffic', () => {
    const sdk = app('app:7', { bundle: 'com.mykynk.kumbara', pid: 14001, name: 'Kumbara' });
    const c = compileScope(scope, hub({ apps: { 'app:7': sdk, 'app:2': app('app:2') } }));
    expect([...(c.appIds ?? [])]).toEqual(['app:7']);
    expect(c.app?.id).toBe('app:7');
    expect(c.logs(log({ appId: 'app:7', source: 'app', origin: 'sdk' }))).toBe(true);
    expect(c.logs(log({ appId: 'app:2', source: 'app', origin: 'sdk' }))).toBe(false);
    expect(c.logs(log({ pid: 14001 }))).toBe(true);
    expect(c.network({ id: 'app:7:1', appId: 'app:7', deviceId: PIXEL } as never)).toBe(true);
    expect(c.network({ id: 'app:2:1', appId: 'app:2', deviceId: PIXEL } as never)).toBe(false);
    expect(c.network({ id: 'replay:1', deviceId: 'desktop' } as never)).toBe(true);
    expect(c.metrics({ deviceId: PIXEL, pid: 12901 })).toBe(true);
    expect(c.metrics({ deviceId: PIXEL, appId: 'app:7' })).toBe(true);
  });

  it('keeps device-level system lines, markers and the app process lifecycle', () => {
    const c = compileScope(scope, hub());
    expect(c.logs(log({ source: 'system', origin: 'durbun', code: 'device.connected' }))).toBe(true);
    expect(c.logs(log({ source: 'system', origin: 'durbun', code: 'process.died', params: { process: 'com.mykynk.kumbara', pid: 12873 } }))).toBe(true);
    expect(c.logs(log({ source: 'system', origin: 'durbun', code: 'process.started', params: { process: 'com.whatsapp', pid: 777 } }))).toBe(false);
    expect(c.logs(log({ deviceId: '', source: 'system', kind: 'marker', code: 'marker' }))).toBe(true);
  });

  it('attributes device crash records by the package they name', () => {
    const c = compileScope(scope, hub());
    const dropbox = log({ origin: 'dropbox', kind: 'crash', level: 'fatal', tag: 'data_app_crash', process: undefined, data: { origin: 'dropbox', package: 'com.mykynk.kumbara', reportTs: 1, previousLaunch: true } });
    expect(c.logs(dropbox)).toBe(true);
    expect(c.logs({ ...dropbox, id: nextId++, data: { origin: 'dropbox', package: 'com.whatsapp' } })).toBe(false);
  });

  it('a crash record’s package decides even when its pid is dead or its process is a shared "Runner"', () => {
    // Kumbara (TestFlight) crashed and is gone; Pati (Xcode) is also "Runner" and still running.
    const gone = { ...RUNNER_A, pids: [], running: false };
    const h = hub({ deviceApps: { [gone.key]: gone, [RUNNER_B.key]: RUNNER_B, [KUMBARA.key]: KUMBARA } });
    const ips = log({ deviceId: IPHONE, origin: 'crash-report', kind: 'crash', level: 'fatal', tag: 'crash-report', process: 'Runner', pid: 811, data: { origin: 'crash-report', bundleId: 'com.mykynk.kumbara', previousLaunch: false, symbolicated: false } });
    expect(compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.kumbara' }, h).logs(ips)).toBe(true);
    expect(compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.pati' }, h).logs(ips)).toBe(false);
    // Android: a tombstone record of this launch carries the (dead) pid but no process name.
    const tomb = log({ origin: 'dropbox', kind: 'crash', level: 'fatal', tag: 'SYSTEM_TOMBSTONE', pid: 12000, data: { origin: 'dropbox', package: 'com.mykynk.kumbara', pid: 12000 } });
    expect(compileScope(scope, h).logs(tomb)).toBe(true);
    // ActivityManager reports the ANR from system_server's process; data.package names the app.
    const anr = log({ kind: 'anr', level: 'error', tag: 'ActivityManager', process: 'system_server', pid: 1520, data: { reporterPid: 1520, package: 'com.mykynk.kumbara:push' } });
    expect(compileScope(scope, h).logs(anr)).toBe(true);
    expect(compileScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.pati' }, h).logs(anr)).toBe(false);
  });

  it('pids of earlier runs come from the process list', () => {
    const procs: Record<number, ProcessUpdate> = {
      11000: { deviceId: PIXEL, pid: 11000, name: 'com.mykynk.kumbara', event: 'died', ts: 1 },
      11001: { deviceId: PIXEL, pid: 11001, name: 'com.mykynk.kumbara:push', event: 'died', ts: 1 },
      11002: { deviceId: PIXEL, pid: 11002, name: 'com.google.android.gms', event: 'seen', ts: 1 },
    };
    const c = compileScope(scope, hub({ processes: { [PIXEL]: procs } }));
    expect(c.logs(log({ pid: 11000 }))).toBe(true);
    expect(c.logs(log({ pid: 11001 }))).toBe(true);
    expect(c.logs(log({ pid: 11002 }))).toBe(false);
  });

  it('a process name two apps share ("Runner") matches only with the app’s own pid', () => {
    const a = compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.kumbara' }, hub());
    const line = (pid: number) => log({ deviceId: IPHONE, origin: 'idevicesyslog', process: 'Runner', pid, tag: 'Runner' });
    expect(a.logs(line(811))).toBe(true);
    expect(a.logs(line(902))).toBe(false);
    const b = compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.pati' }, hub());
    expect(b.logs(line(902))).toBe(true);
    expect(b.logs(line(811))).toBe(false);
  });

  it('a unique processName matches by name', () => {
    const only = da(IPHONE, 'com.mykynk.kumbara', { processName: 'Runner', pids: [811], running: true });
    const c = compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.kumbara' }, { apps: {}, deviceApps: { [only.key]: only } });
    expect(c.logs(log({ deviceId: IPHONE, process: 'Runner', pid: 9999 }))).toBe(true);
  });

  it('an app scope also covers the device’s report of the app (pids of SDK-less lines)', () => {
    const pati = da(PIXEL, 'com.mykynk.pati', { pids: [16000, 16001], running: true });
    const c = compileScope({ kind: 'app', appId: 'app:2' }, { apps: { 'app:2': app('app:2', { pid: 15000 }) }, deviceApps: { [pati.key]: pati } });
    expect(c.logs(log({ pid: 16001 }))).toBe(true);
    expect(c.deviceApp?.key).toBe(pati.key);
    // exact mode stays on the session's own pid
    const exact = compileScope({ kind: 'app', appId: 'app:2', exact: true }, { apps: { 'app:2': app('app:2', { pid: 15000 }) }, deviceApps: { [pati.key]: pati } });
    expect(exact.logs(log({ pid: 16001 }))).toBe(false);
    expect(exact.logs(log({ pid: 15000, process: 'com.mykynk.pati' }))).toBe(true);
  });

  it('signature: stable across stats churn and activity, changes with pids and sessions', () => {
    const base = hub({ apps: { 'app:2': app('app:2') } });
    const sig = scopeSignature(scope, base);
    const churn = { ...base, apps: { 'app:2': { ...base.apps['app:2']!, stats: { logs: 99, requests: 1, errors: 0 } } }, deviceApps: { ...base.deviceApps, [KUMBARA.key]: { ...KUMBARA, lastActivity: 99_999 } } };
    expect(scopeSignature(scope, churn)).toBe(sig);
    const restarted = { ...base, deviceApps: { ...base.deviceApps, [KUMBARA.key]: { ...KUMBARA, pids: [13555] } } };
    expect(scopeSignature(scope, restarted)).not.toBe(sig);
    const withSdk = { ...base, apps: { ...base.apps, 'app:9': app('app:9', { bundle: 'com.mykynk.kumbara' }) } };
    expect(scopeSignature(scope, withSdk)).not.toBe(sig);
    expect(compileScope(scope, base).key).toBe(sig);
  });

  it('counts its lines incrementally and subtracts what the ring trims', () => {
    const store = new LogStore();
    store.setMaxEntries(4);
    const c = compileScope(scope, hub());
    store.append([log({ pid: 12873, level: 'error' }), log({ pid: 1 }), log({ pid: 12901, kind: 'anr', level: 'error', tag: 'ActivityManager' })]);
    expect(scopeLogCounts(c, store)).toEqual({ total: 2, warn: 0, error: 2, crash: 1 });
    store.append([log({ pid: 12873, level: 'warn' }), log({ pid: 2 }), log({ pid: 3 })]); // trims the first two
    expect(scopeLogCounts(c, store)).toEqual({ total: 2, warn: 1, error: 1, crash: 1 });
  });

  it('scopeTarget names the device app and its newest session', () => {
    const t = scopeTarget(scope, { apps: { 'app:7': app('app:7', { bundle: 'com.mykynk.kumbara' }) }, devices: {}, deviceApps: hub().deviceApps });
    expect(t.deviceApp?.name).toBe('Kumbara');
    expect(t.app?.id).toBe('app:7');
    expect(t.bundleId).toBe('com.mykynk.kumbara');
  });
});

describe('groupApps joins sessions with device apps', () => {
  it('joins by device + bundle id, keeps SDK-less apps, orders running first then recent', () => {
    const sessions = [app('app:1', { connected: false, connectedAt: 10 }), app('app:2', { connectedAt: 20 })];
    const deviceApps = [
      da(PIXEL, 'com.mykynk.pati', { pids: [16000], running: true }),
      da(PIXEL, 'com.mykynk.kumbara', { name: 'Kumbara', running: true, pids: [1], lastActivity: 50 }),
      da(PIXEL, 'com.mykynk.mahalle', { name: 'Mahalle', running: false, lastActivity: 900 }),
      da(PIXEL, 'com.mykynk.eski', { name: 'Eski', running: false, lastActivity: 100 }),
      da(IPHONE, 'com.mykynk.pati', { running: false }),
    ];
    const groups = groupApps(sessions, deviceApps);
    const pixel = groups.get(PIXEL)!;
    expect(pixel.map((g) => g.bundleId)).toEqual(['com.mykynk.pati', 'com.mykynk.kumbara', 'com.mykynk.mahalle', 'com.mykynk.eski']);
    const pati = pixel[0]!;
    expect(pati.sessions.map((s) => s.id)).toEqual(['app:2', 'app:1']);
    expect(pati.deviceApp?.pids).toEqual([16000]);
    expect(pati.latest?.id).toBe('app:2');
    expect(pati.connected).toBe(true);
    const kumbara = pixel[1]!;
    expect(kumbara.latest).toBeUndefined();
    expect(kumbara.running).toBe(true);
    expect(kumbara.connected).toBe(false);
    expect(groups.get(IPHONE)).toHaveLength(1);
  });

  it('running apps are ordered by name so rows do not jump while logs stream', () => {
    const a = groupApps([], [da(PIXEL, 'b.app', { name: 'Zeplin', running: true, lastActivity: 10 }), da(PIXEL, 'a.app', { name: 'Atlas', running: true, lastActivity: 1 })]);
    expect(a.get(PIXEL)!.map((g) => g.bundleId)).toEqual(['a.app', 'b.app']);
  });
});

describe('hub store: device apps', () => {
  beforeEach(() => hubActions.reset());

  it('snapshot + batch upserts, coalesced activity bumps, removals', () => {
    hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [KUMBARA] });
    expect(useHub.getState().deviceApps[KUMBARA.key]?.name).toBe('Kumbara');
    const before = useHub.getState().deviceApps;
    hubActions.upsertDeviceApps([{ ...KUMBARA, lastActivity: KUMBARA.lastActivity + 2000 }]);
    expect(useHub.getState().deviceApps).toBe(before); // activity-only bump within 10 s: no re-render
    hubActions.upsertDeviceApps([{ ...KUMBARA, lastActivity: KUMBARA.lastActivity + 60_000 }]);
    expect(useHub.getState().deviceApps[KUMBARA.key]?.lastActivity).toBe(KUMBARA.lastActivity + 60_000);
    hubActions.upsertDeviceApps([{ ...KUMBARA, running: false, pids: [] }]);
    expect(useHub.getState().deviceApps[KUMBARA.key]?.running).toBe(false);
    hubActions.removeDeviceApps([KUMBARA.key]);
    expect(useHub.getState().deviceApps[KUMBARA.key]).toBeUndefined();
  });

  it('tolerates odd wire objects (older servers, missing arrays)', () => {
    hubActions.upsertDeviceApps([{ deviceId: PIXEL, id: 'com.x', running: true } as unknown as DeviceApp, { deviceId: PIXEL } as unknown as DeviceApp]);
    const d = useHub.getState().deviceApps[`${PIXEL}|com.x`]!;
    expect(d.pids).toEqual([]);
    expect(d.install.source).toBe('unknown');
    expect(d.buildType).toBe('unknown');
    expect(Object.keys(useHub.getState().deviceApps)).toHaveLength(1);
  });

  it('removing a device drops its device apps', () => {
    hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [KUMBARA, RUNNER_A] });
    hubActions.removeDevices([PIXEL]);
    expect(Object.keys(useHub.getState().deviceApps)).toEqual([RUNNER_A.key]);
  });
});

describe('dispatch + scope validation with device apps', () => {
  const dev = (id: string): DeviceInfo =>
    ({ id, platform: 'android', kind: 'physical', name: 'Pixel 8', connection: 'usb', state: 'online', logs: { status: 'streaming' }, actions: [], firstSeen: 0, lastSeen: 0 }) as DeviceInfo;
  const snapshot = (p: { devices?: DeviceInfo[]; apps?: AppSession[]; deviceApps?: DeviceApp[] }) =>
    handleServerMessage({ type: 'snapshot', devices: p.devices ?? [], apps: p.apps ?? [], network: [], mocks: [], drivers: [], processes: [], metrics: [], logCount: 0, deviceApps: p.deviceApps });

  beforeEach(() => {
    hubActions.reset();
    setScope({ kind: 'all' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('applies snapshot.deviceApps and batch deviceApps / removedDeviceApps', () => {
    snapshot({ devices: [dev(PIXEL)], deviceApps: [KUMBARA] });
    expect(useHub.getState().deviceApps[KUMBARA.key]).toBeDefined();
    handleServerMessage({ type: 'batch', deviceApps: [da(PIXEL, 'com.mykynk.mahalle')] });
    expect(Object.keys(useHub.getState().deviceApps).sort()).toEqual([`${PIXEL}|com.mykynk.kumbara`, `${PIXEL}|com.mykynk.mahalle`]);
    handleServerMessage({ type: 'batch', removedDeviceApps: [KUMBARA.key] });
    expect(useHub.getState().deviceApps[KUMBARA.key]).toBeUndefined();
    // an older server without the field
    snapshot({ devices: [dev(PIXEL)] });
    expect(useHub.getState().deviceApps).toEqual({});
  });

  it('a device-app scope survives a resync while the device reports the app, else falls back to the device', () => {
    setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }, { deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    snapshot({ devices: [dev(PIXEL)], deviceApps: [KUMBARA] });
    expect(useScopeStore.getState().scope).toEqual({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    snapshot({ devices: [dev(PIXEL)], deviceApps: [] });
    expect(useScopeStore.getState().scope).toEqual({ kind: 'device', deviceId: PIXEL });
    setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    snapshot({ devices: [], deviceApps: [] });
    expect(useScopeStore.getState().scope).toEqual({ kind: 'all' });
  });

  it('an app scope whose session is gone falls back to the device app (server restarted)', () => {
    setScope({ kind: 'app', appId: 'app:3' }, { deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    snapshot({ devices: [dev(PIXEL)], deviceApps: [KUMBARA] });
    expect(useScopeStore.getState().scope).toEqual({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    validateScope();
    expect(useScopeStore.getState().scope.kind).toBe('deviceApp');
  });

  it('the scope (with its hint) is persisted for reloads', () => {
    setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }, { deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    const raw = JSON.parse(localStorage.getItem('durbun.scope.v1') ?? 'null');
    expect(raw.scope).toEqual({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
  });
});

describe('scope persistence across a reload', () => {
  it('a stored device-app scope is restored; a malformed one falls back to "all"', async () => {
    localStorage.setItem('durbun.scope.v1', JSON.stringify({ scope: { kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }, hint: {} }));
    vi.resetModules();
    const fresh = await import('../data/stores/scope');
    expect(fresh.useScopeStore.getState().scope).toEqual({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    expect(fresh.useScopeStore.getState().hint).toEqual({ deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    localStorage.setItem('durbun.scope.v1', JSON.stringify({ scope: { kind: 'deviceApp', deviceId: PIXEL } }));
    vi.resetModules();
    const broken = await import('../data/stores/scope');
    expect(broken.useScopeStore.getState().scope).toEqual({ kind: 'all' });
  });
});
