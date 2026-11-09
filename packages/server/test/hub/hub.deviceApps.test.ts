/**
 * Device apps in the real hub (SPEC §10.2): merge semantics, lastActivity from device log lines and
 * process events (throttled to one change per app per second under a log flood), removal, device
 * disconnect / removal, clear('all'), export / import — and LogEntry.origin for every line the hub makes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceApp, LogEntry, ServerToUi } from '@durbun/protocol';
import { DEVICE_APP_ACTIVITY_THROTTLE_MS } from '../../src/hub/deviceApps';
import type { Hub } from '../../src/types';
import { connectUi, startTestApp, type TestApp, type UiTestClient } from '../http/fakes';
import { appInput, collectChanges, device, makeHub } from './helpers';

const PIXEL = 'android:R5CT1234';
const KUMBARA = 'com.mykynk.kumbara';

let hub: Hub | undefined;
let t: TestApp | undefined;
const clients: UiTestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.close();
  t = undefined;
  hub?.dispose();
  hub = undefined;
  vi.useRealTimers();
});

function newHub(): Hub {
  hub = makeHub();
  hub.upsertDevice(device(PIXEL));
  return hub;
}

const line = (patch: Partial<LogEntry> = {}) => ({ ts: Date.now(), level: 'info' as const, tag: 'KumbaraApp', message: 'tick', ...patch });

describe('upsertDeviceApp merge semantics', () => {
  it('creates with defaults, merges defined fields, replaces pids/running, adds crash reports', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    const t0 = Date.now();
    const created = h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA });
    expect(created).toEqual({
      key: `${PIXEL}|${KUMBARA}`,
      deviceId: PIXEL,
      id: KUMBARA,
      buildType: 'unknown',
      install: { source: 'unknown' },
      pids: [],
      running: false,
      lastActivity: t0,
    });

    vi.advanceTimersByTime(5000);
    const merged = h.upsertDeviceApp({
      deviceId: PIXEL,
      id: KUMBARA,
      name: 'Kumbara',
      version: '3.1.0',
      build: '310',
      buildType: 'release',
      install: { source: 'play', installer: 'com.android.vending', firstInstall: 1_760_000_000_000 },
      pids: [12001, 12044],
      running: true,
    });
    expect(merged).toMatchObject({ name: 'Kumbara', version: '3.1.0', build: '310', buildType: 'release', running: true, pids: [12001, 12044], lastActivity: t0 + 5000 });
    expect(merged.install).toEqual({ source: 'play', installer: 'com.android.vending', firstInstall: 1_760_000_000_000 });
    expect(merged.crashReports).toBeUndefined();

    // undefined fields keep the stored value; pids replace; lastActivity never goes back
    const next = h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, version: undefined, pids: [12001], lastActivity: t0 - 60_000, crashReportsDelta: 1 });
    expect(next).toMatchObject({ version: '3.1.0', pids: [12001], running: true, lastActivity: t0 + 5000, crashReports: 1 });
    expect(h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, crashReportsDelta: 2 }).crashReports).toBe(3);
    vi.advanceTimersByTime(10_000);
    expect(h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, lastActivity: t0 + 9_000 }).lastActivity).toBe(t0 + 9_000);

    // garbage never throws and is not stored
    const bad = [{}, { deviceId: PIXEL }, { deviceId: '', id: 'x' }, null] as unknown as Parameters<Hub['upsertDeviceApp']>[0][];
    for (const input of bad) expect(() => h.upsertDeviceApp(input)).not.toThrow();
    const odd = h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.x', pids: [1.5, -3, 77, 77] as number[], buildType: 'weird' as never, install: { source: 'nope' as never } });
    expect(odd).toMatchObject({ pids: [77], buildType: 'unknown', install: { source: 'unknown' } });
    expect(h.getDeviceApps().map((a) => a.id).sort()).toEqual([KUMBARA, 'com.x']);

    // returned objects and getDeviceApps() are copies
    odd.pids.push(1);
    h.getDeviceApps()[0]!.pids.push(2);
    expect(h.getDeviceApps().find((a) => a.id === 'com.x')!.pids).toEqual([77]);
  });

  it('emits a batched deviceApps change only when something changed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    const c = collectChanges(h);
    const input = { deviceId: PIXEL, id: KUMBARA, version: '3.1.0', pids: [12001], running: true } as const;
    h.upsertDeviceApp({ ...input, pids: [...input.pids] });
    h.upsertDeviceApp({ ...input, pids: [...input.pids] }); // same data within the same ms: no change at all
    await vi.advanceTimersByTimeAsync(150);
    expect(c.all().deviceApps).toHaveLength(1);
    expect(c.all().deviceApps[0]).toMatchObject({ key: `${PIXEL}|${KUMBARA}`, version: '3.1.0', running: true });

    // a periodic re-report with unchanged data only bumps lastActivity → throttled, not per call
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(100);
      h.upsertDeviceApp({ ...input, pids: [...input.pids] });
    }
    await vi.advanceTimersByTimeAsync(1200);
    const activityChanges = c.all().deviceApps.length - 1;
    expect(activityChanges).toBeGreaterThanOrEqual(2);
    expect(activityChanges).toBeLessThanOrEqual(3);

    // a real change goes out right away (next batch)
    const before = c.all().deviceApps.length;
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, running: false, pids: [] });
    await vi.advanceTimersByTimeAsync(150);
    expect(c.all().deviceApps.length).toBe(before + 1);
    expect(c.all().deviceApps.at(-1)).toMatchObject({ running: false, pids: [] });
  });
});

describe('lastActivity from device log lines', () => {
  it('matches pid ∈ pids, process == id and process == id + ":service"; ignores other lines', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    const t0 = Date.now();
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [12001], running: true });
    h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.other', pids: [13000], running: true });
    const activity = (id: string) => h.getDeviceApps().find((a) => a.id === id)!.lastActivity;

    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(PIXEL, [line({ pid: 12001 })]);
    expect(activity(KUMBARA)).toBe(t0 + 1000);
    expect(activity('com.other')).toBe(t0);

    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(PIXEL, [line({ pid: 999, process: `${KUMBARA}:widget` })]);
    expect(activity(KUMBARA)).toBe(t0 + 2000);

    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(PIXEL, [line({ process: KUMBARA })]);
    expect(activity(KUMBARA)).toBe(t0 + 3000);

    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(PIXEL, [line({ pid: 1043, process: 'system_server' }), line({ process: 'com.mykynk.kumbaraX' })]);
    h.pushDeviceLogs('android:other', [line({ pid: 12001 })]); // same pid, other device
    expect(activity(KUMBARA)).toBe(t0 + 3000);

    // process name learned from setProcess (pid → name) also counts; started/died are process events
    vi.advanceTimersByTime(1000);
    h.setProcess({ deviceId: PIXEL, pid: 14000, name: `${KUMBARA}:sync`, event: 'started' });
    expect(activity(KUMBARA)).toBe(t0 + 5000);
    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(PIXEL, [line({ pid: 14000 })]);
    expect(activity(KUMBARA)).toBe(t0 + 6000);

    // iOS: the executable name ("Runner") maps when it is unambiguous on the device
    const IPHONE = 'ios:00008110-001A2B3C4D5E6F70';
    h.upsertDevice(device(IPHONE, { platform: 'ios' }));
    h.upsertDeviceApp({ deviceId: IPHONE, id: 'com.mykynk.pati', processName: 'Runner' });
    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(IPHONE, [line({ process: 'Runner', pid: 811 })]);
    expect(h.getDeviceApps().find((a) => a.deviceId === IPHONE)!.lastActivity).toBe(t0 + 7000);
    h.upsertDeviceApp({ deviceId: IPHONE, id: 'com.mykynk.kasa', processName: 'Runner' });
    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(IPHONE, [line({ process: 'Runner', pid: 812 })]); // two "Runner"s: ambiguous → no bump
    expect(h.getDeviceApps().find((a) => a.deviceId === IPHONE && a.id === 'com.mykynk.pati')!.lastActivity).toBe(t0 + 7000);
  });

  it('crash / ANR records count at their own time: a crash from this morning does not make the app "last seen just now"', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T13:00:00Z') });
    const h = newHub();
    const now = Date.now();
    const morning = now - 3 * 3_600_000;
    // the Android tracker reports the app with the record's time (not running, one crash report)
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, lastActivity: morning, crashReportsDelta: 1 });
    // …and the dropbox row of that crash arrives (process = package; no pid for an old record)
    h.pushDeviceLogs(PIXEL, [line({ ts: morning, origin: 'dropbox', kind: 'crash', level: 'fatal', tag: 'data_app_crash', process: `${KUMBARA}:widget` })]);
    const kumbara = () => h.getDeviceApps().find((a) => a.id === KUMBARA)!;
    expect(kumbara().lastActivity).toBe(morning);
    // an .ips / dropbox record of a crash a moment ago moves it to that moment (never past now)
    vi.advanceTimersByTime(5000);
    h.pushDeviceLogs(PIXEL, [line({ ts: Date.now() - 4000, origin: 'dropbox', kind: 'crash', process: KUMBARA })]);
    expect(kumbara().lastActivity).toBe(Date.now() - 4000);
    h.pushDeviceLogs(PIXEL, [line({ ts: Date.now() + 60_000, origin: 'crash-report', kind: 'crash', process: KUMBARA })]);
    expect(kumbara().lastActivity).toBe(Date.now());
    // ordinary live lines still count at arrival time
    vi.advanceTimersByTime(1000);
    h.pushDeviceLogs(PIXEL, [line({ ts: morning, process: KUMBARA })]);
    expect(kumbara().lastActivity).toBe(Date.now());
  });

  it('records of a previous launch bump no app: the driver reports their time, their pid / process may be another app by now', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T13:00:00Z') });
    const h = newHub();
    const now = Date.now();
    const lastNight = now - 10 * 3_600_000;
    const morning = now - 5 * 3_600_000;
    const previous = { previousLaunch: true, reportTs: morning };
    // Android: an old dropbox record names the package (no top-level pid)
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, lastActivity: lastNight });
    h.pushDeviceLogs(PIXEL, [line({ ts: morning, origin: 'dropbox', kind: 'crash', tag: 'data_app_crash', process: KUMBARA, data: { origin: 'dropbox', package: KUMBARA, ...previous } })]);
    expect(h.getDeviceApps().find((a) => a.id === KUMBARA)!.lastActivity).toBe(lastNight);
    // iOS: an old .ips keeps the pid of the crashed process, which another app now runs under
    const IPHONE = 'ios:00008110-001A2B3C4D5E6F70';
    h.upsertDevice(device(IPHONE, { platform: 'ios' }));
    h.upsertDeviceApp({ deviceId: IPHONE, id: 'com.mykynk.kasa', pids: [1977], running: true, lastActivity: lastNight });
    h.pushDeviceLogs(IPHONE, [
      line({ ts: morning, origin: 'crash-report', kind: 'crash', tag: 'crash-report', pid: 1977, process: 'Runner', data: { origin: 'crash-report', bundleId: KUMBARA, ...previous } }),
    ]);
    expect(h.getDeviceApps().find((a) => a.id === 'com.mykynk.kasa')!.lastActivity).toBe(lastNight);
    // a record of this launch still counts at its own time
    h.pushDeviceLogs(PIXEL, [line({ ts: now - 2000, origin: 'dropbox', kind: 'crash', process: KUMBARA, data: { origin: 'dropbox', previousLaunch: false } })]);
    expect(h.getDeviceApps().find((a) => a.id === KUMBARA)!.lastActivity).toBe(now - 2000);
  });

  it('a lastActivity in the future (device clock ahead, wrong time zone) is capped at now and does not block later bumps', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    const t0 = Date.now();
    const created = h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [12001], running: true, lastActivity: t0 + 2 * 3_600_000 });
    expect(created.lastActivity).toBe(t0);
    vi.advanceTimersByTime(3000);
    h.pushDeviceLogs(PIXEL, [line({ pid: 12001 })]);
    expect(h.getDeviceApps()[0]!.lastActivity).toBe(t0 + 3000);
  });

  it('a log flood produces at most one deviceApps change per app per second (leading + trailing)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [12001], running: true });
    h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.other', pids: [13000], running: true });
    await vi.advanceTimersByTimeAsync(1100);
    const c = collectChanges(h);

    // 5 s of 2 000 lines/s for both apps, delivered every 10 ms
    for (let ms = 0; ms < 5000; ms += 10) {
      const batch = [];
      for (let i = 0; i < 10; i++) batch.push(line({ pid: 12001 }), line({ pid: 13000 }));
      h.pushDeviceLogs(PIXEL, batch);
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(DEVICE_APP_ACTIVITY_THROTTLE_MS + 200);
    const all = c.all();
    expect(all.logs).toHaveLength(10_000);
    for (const id of [KUMBARA, 'com.other']) {
      const changes = all.deviceApps.filter((a) => a.id === id);
      expect(changes.length).toBeGreaterThanOrEqual(5);
      expect(changes.length).toBeLessThanOrEqual(7);
      // timestamps of consecutive emitted states are ≥ 1 s apart (allow one batch interval of slack)
      for (let i = 1; i < changes.length; i++) expect(changes[i]!.lastActivity - changes[i - 1]!.lastActivity).toBeGreaterThanOrEqual(900);
      // the trailing change carries the latest activity
      expect(changes.at(-1)!.lastActivity).toBe(h.getDeviceApps().find((a) => a.id === id)!.lastActivity);
    }
  });
});

describe('removal, disconnect, clear and export / import', () => {
  it('removeDeviceApps(ids) and removeDeviceApps(device) go out as removedDeviceApps', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    for (const id of ['a.one', 'a.two', 'a.three']) h.upsertDeviceApp({ deviceId: PIXEL, id });
    h.upsertDeviceApp({ deviceId: 'android:other', id: 'a.one' });
    await vi.advanceTimersByTimeAsync(150);
    const c = collectChanges(h);
    h.removeDeviceApps(PIXEL, ['a.two', 'not.there']);
    await vi.advanceTimersByTimeAsync(150);
    expect(c.all().removedDeviceApps).toEqual([`${PIXEL}|a.two`]);
    h.removeDeviceApps(PIXEL);
    await vi.advanceTimersByTimeAsync(150);
    expect(c.all().removedDeviceApps.sort()).toEqual([`${PIXEL}|a.one`, `${PIXEL}|a.three`, `${PIXEL}|a.two`]);
    expect(h.getDeviceApps().map((a) => a.key)).toEqual(['android:other|a.one']);
    // an upsert after a removal in the same batch window resurrects it (removed list is cleaned)
    h.removeDeviceApps('android:other');
    h.upsertDeviceApp({ deviceId: 'android:other', id: 'a.one' });
    const n = c.changes.length;
    await vi.advanceTimersByTimeAsync(150);
    const last = c.changes.slice(n);
    expect(last.flatMap((x) => x.removedDeviceApps)).toEqual([]);
    expect(last.flatMap((x) => x.deviceApps).map((a) => a.key)).toEqual(['android:other|a.one']);
  });

  it('a disconnected device keeps its apps but none is running; clear(all) keeps apps of online devices and drops removed devices', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    h.upsertDevice(device('android:gone'));
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [12001], running: true, crashReportsDelta: 1 });
    h.upsertDeviceApp({ deviceId: 'android:gone', id: KUMBARA, pids: [5000], running: true });
    h.markDeviceDisconnected('android:gone', 'USB cable unplugged');
    expect(h.getDeviceApps().find((a) => a.deviceId === 'android:gone')).toMatchObject({ running: false, pids: [] });
    // pid index is gone too: lines with the old pid no longer count
    const before = h.getDeviceApps().find((a) => a.deviceId === 'android:gone')!.lastActivity;
    vi.advanceTimersByTime(2000);
    h.pushDeviceLogs('android:gone', [line({ pid: 5000 })]);
    expect(h.getDeviceApps().find((a) => a.deviceId === 'android:gone')!.lastActivity).toBe(before);

    await vi.advanceTimersByTimeAsync(150);
    const c = collectChanges(h);
    h.clear('all');
    await vi.advanceTimersByTimeAsync(150);
    expect(h.getDevices().map((d) => d.id)).toEqual([PIXEL]);
    expect(h.getDeviceApps()).toEqual([expect.objectContaining({ deviceId: PIXEL, id: KUMBARA, running: true })]);
    expect(h.getDeviceApps()[0]).not.toHaveProperty('crashReports'); // its crash rows were cleared with the logs
    expect(c.all().removedDevices).toEqual(['android:gone']);
    expect(c.all().removedDeviceApps).toEqual([`android:gone|${KUMBARA}`]);
  });

  it('a device that leaves "online" through upsertDevice (offline, unauthorized) stops its apps too; the driver report wins when it is back', () => {
    const h = newHub();
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [12001], running: true });
    h.upsertDevice(device(PIXEL, { state: 'offline' }));
    expect(h.getDeviceApps()[0]).toMatchObject({ running: false, pids: [] });
    // the driver reported while the device was away (Android's tracker clears its pids itself)
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [], running: false });
    h.upsertDevice(device(PIXEL));
    expect(h.getDeviceApps()[0]).toMatchObject({ running: false, pids: [] });
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [12500], running: true });
    expect(h.getDeviceApps()[0]).toMatchObject({ running: true, pids: [12500] });
  });

  it('back online without a new driver report: the last reported pids return (iOS re-trust keeps its tracker, which only reports changes)', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const IPHONE = 'ios:00008110-001A2B3C4D5E6F70';
    const h = newHub();
    h.upsertDevice(device(IPHONE, { platform: 'ios' }));
    h.upsertDeviceApp({ deviceId: IPHONE, id: 'com.mykynk.pati', processName: 'Runner', pids: [1234], running: true });
    h.upsertDeviceApp({ deviceId: IPHONE, id: 'com.mykynk.kasa', processName: 'Runner', pids: [1290], running: true });
    const pati = () => h.getDeviceApps().find((a) => a.id === 'com.mykynk.pati')!;

    // trust lost (syslog pairing error → 'unauthorized'): nothing can be confirmed running
    h.patchDevice(IPHONE, { state: 'unauthorized' });
    expect(pati()).toMatchObject({ running: false, pids: [] });
    // only an info refresh from the driver meanwhile (no pids / running)
    h.upsertDeviceApp({ deviceId: IPHONE, id: 'com.mykynk.pati', version: '2.4.2' });
    // trusted again: the tracker's pid list did not change, so it sends nothing — the hub restores it
    h.patchDevice(IPHONE, { state: 'online' });
    expect(pati()).toMatchObject({ running: true, pids: [1234], version: '2.4.2' });
    // and the pid index works again ("Runner" is ambiguous here, so only the pid can attribute the line)
    const before = pati().lastActivity;
    vi.advanceTimersByTime(2000);
    h.pushDeviceLogs(IPHONE, [line({ pid: 1234, process: 'Runner' })]);
    expect(pati().lastActivity).toBe(before + 2000);

    // a device that went away for good (disconnected) never gets stale pids back on a later reconnect
    h.patchDevice(IPHONE, { state: 'unauthorized' });
    h.markDeviceDisconnected(IPHONE, 'USB cable unplugged');
    h.upsertDevice(device(IPHONE, { platform: 'ios' }));
    expect(pati()).toMatchObject({ running: false, pids: [] });
  });

  it('clearing logs resets the crash counts of the device apps in the cleared scope', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    h.upsertDevice(device('ios:A', { platform: 'ios' }));
    const counts = () => Object.fromEntries(h.getDeviceApps().map((a) => [a.key, a.crashReports ?? 0]));
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, crashReportsDelta: 2 });
    h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.mykynk.pati', crashReportsDelta: 1 });
    h.upsertDeviceApp({ deviceId: 'ios:A', id: KUMBARA, crashReportsDelta: 3 });
    h.upsertDeviceApp({ deviceId: 'ios:A', id: 'com.mykynk.pati' }); // never crashed: untouched
    const pati = h.registerApp(appInput(PIXEL, { app: { name: 'Pati', id: 'com.mykynk.pati', version: '2.4.1', pid: 8421 } }));
    await vi.advanceTimersByTimeAsync(150);

    h.clear('network', { deviceId: PIXEL });
    h.clear('metrics');
    h.clear('logs', { appId: 'app:unknown' });
    expect(counts()).toEqual({ [`${PIXEL}|${KUMBARA}`]: 2, [`${PIXEL}|com.mykynk.pati`]: 1, [`ios:A|${KUMBARA}`]: 3, 'ios:A|com.mykynk.pati': 0 });

    // an SDK session's scope removes only that session's rows; none of them is a crash record, so the
    // counts stay (the records they stand for are still there; see the next tests)
    const c = collectChanges(h);
    h.clear('logs', { deviceId: PIXEL, appId: pati.id });
    expect(counts()).toEqual({ [`${PIXEL}|${KUMBARA}`]: 2, [`${PIXEL}|com.mykynk.pati`]: 1, [`ios:A|${KUMBARA}`]: 3, 'ios:A|com.mykynk.pati': 0 });
    await vi.advanceTimersByTimeAsync(150);
    expect(c.all().deviceApps).toEqual([]);

    // a device scope: every app of that device; then everything
    h.clear('logs', { deviceId: PIXEL });
    expect(counts()).toEqual({ [`${PIXEL}|${KUMBARA}`]: 0, [`${PIXEL}|com.mykynk.pati`]: 0, [`ios:A|${KUMBARA}`]: 3, 'ios:A|com.mykynk.pati': 0 });
    h.clear('logs');
    expect(Object.values(counts())).toEqual([0, 0, 0, 0]);
    // new records count from zero again
    h.upsertDeviceApp({ deviceId: 'ios:A', id: KUMBARA, crashReportsDelta: 1 });
    expect(counts()[`ios:A|${KUMBARA}`]).toBe(1);
  });

  it("a session's clear keeps the device crash records it does not remove, and their count with them (Android)", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    const PATI = 'com.mykynk.pati';
    const pati = h.registerApp(appInput(PIXEL, { app: { name: 'Pati', id: PATI, version: '2.4.1', pid: 8421 } }));
    // What the Android driver reports (dropbox.ts): a record of a launch before Dürbün watched (pid in data
    // only), an ANR record of this launch read while the process still ran (its pid: the session's row) and
    // the dropbox copy of that ANR in a second record (duplicateOf the first: one crash, one count).
    const record = (patch: Partial<LogEntry>, data: Record<string, unknown>) =>
      line({ level: 'fatal', tag: 'dropbox', origin: 'dropbox', process: PATI, ...patch, data: { origin: 'dropbox', package: PATI, ...data } });
    h.pushDeviceLogs(PIXEL, [record({ kind: 'crash', message: 'Pati crashed this morning' }, { previousLaunch: true, pid: 7001 })]);
    h.pushDeviceLogs(PIXEL, [record({ kind: 'anr', pid: 8421, message: 'Pati is not responding' }, { previousLaunch: false })]);
    const anr = h.getLogs().at(-1)!;
    h.pushDeviceLogs(PIXEL, [record({ kind: 'anr', pid: 8421, message: 'Pati ANR traces' }, { duplicateOf: anr.id })]);
    h.upsertDeviceApp({ deviceId: PIXEL, id: PATI, install: { source: 'adb' }, crashReportsDelta: 2 });
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, crashReportsDelta: 1 });
    h.pushDeviceLogs(PIXEL, [line({ level: 'fatal', origin: 'dropbox', kind: 'crash', data: { origin: 'dropbox', package: KUMBARA } })]);
    h.pushAppLog(pati.id, { ts: Date.now(), level: 'info', tag: 'app', message: 'Pati SDK line' });
    expect(anr.appId).toBe(pati.id);
    await vi.advanceTimersByTimeAsync(150);

    const c = collectChanges(h);
    h.clear('logs', { deviceId: PIXEL, appId: pati.id });
    const left = h.getLogs().filter((e) => e.origin === 'dropbox');
    expect(left.map((e) => e.message)).toEqual(['Pati crashed this morning', 'tick']);
    // "1 çökme/ANR kaydı" stays next to the record that stays; Kumbara's count is not Pati's business
    expect(h.getDeviceApps().map((a) => [a.id, a.crashReports])).toEqual([[PATI, 1], [KUMBARA, 1]]);
    await vi.advanceTimersByTimeAsync(150);
    expect(c.all().deviceApps.map((a) => [a.id, a.crashReports])).toEqual([[PATI, 1]]);

    // the device's clear removes the rest, and the counts with them
    h.clear('logs', { deviceId: PIXEL });
    expect(h.getDeviceApps().map((a) => a.crashReports)).toEqual([undefined, undefined]);
  });

  it("a session's clear keeps an earlier launch's .ips and its count (iPhone, Xcode build)", () => {
    const h = newHub();
    const IPHONE = 'ios:00008130-0001A2B3C4D5E6F7';
    const PATI = 'com.mykynk.pati';
    h.upsertDevice(device(IPHONE, { platform: 'ios', name: 'Yusuf iPhone’u' }));
    h.upsertDeviceApp({ deviceId: IPHONE, id: PATI, processName: 'Runner', pids: [4321], running: true, install: { source: 'xcode' }, crashReportsDelta: 1 });
    const pati = h.registerApp(appInput(IPHONE, { transport: 'usbmux', app: { name: 'Pati', id: PATI, version: '2.4.1', pid: 4321, processName: 'Runner' } }));
    h.pushDeviceLogs(IPHONE, [
      line({ level: 'fatal', tag: 'crash-report', kind: 'crash', origin: 'crash-report', process: 'Runner', message: 'Pati 2.4.1 (241) crashed: EXC_BAD_ACCESS', data: { origin: 'crash-report', bundleId: PATI, previousLaunch: true, pid: 1977 } }),
    ]);
    h.pushAppLog(pati.id, { ts: Date.now(), level: 'info', tag: 'app', message: 'Pati SDK line' });
    h.clear('logs', { deviceId: IPHONE, appId: pati.id });
    expect(h.getLogs().filter((e) => e.origin === 'crash-report')).toHaveLength(1);
    expect(h.getDeviceApps().find((a) => a.deviceId === IPHONE)?.crashReports).toBe(1);
  });

  it('processName: null clears the process name (Android ":remote" until the main process runs); undefined keeps it', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const h = newHub();
    h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.foo', processName: 'com.foo:remote', running: true, pids: [700] });
    h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.foo', running: true });
    expect(h.getDeviceApps()[0]!.processName).toBe('com.foo:remote');
    await vi.advanceTimersByTimeAsync(1500);
    const c = collectChanges(h);
    h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.foo', processName: null, pids: [700, 701] });
    expect(h.getDeviceApps()[0]).not.toHaveProperty('processName');
    await vi.advanceTimersByTimeAsync(150);
    expect(c.all().deviceApps).toHaveLength(1);
    expect(c.all().deviceApps[0]).not.toHaveProperty('processName');

    // the old name no longer identifies the app; a shared name ("Runner") is released the same way
    h.upsertDevice(device('ios:A', { platform: 'ios' }));
    h.upsertDeviceApp({ deviceId: 'ios:A', id: 'com.a', processName: 'Runner' });
    const before = h.getDeviceApps().find((a) => a.id === 'com.a')!.lastActivity;
    h.upsertDeviceApp({ deviceId: 'ios:A', id: 'com.a', processName: null });
    vi.advanceTimersByTime(5000);
    h.pushDeviceLogs('ios:A', [line({ process: 'Runner' })]);
    expect(h.getDeviceApps().find((a) => a.id === 'com.a')!.lastActivity).toBe(before);
    h.upsertDeviceApp({ deviceId: 'ios:A', id: 'com.a', processName: 'Runner' });
    vi.advanceTimersByTime(5000);
    h.pushDeviceLogs('ios:A', [line({ process: 'Runner' })]);
    expect(h.getDeviceApps().find((a) => a.id === 'com.a')!.lastActivity).toBe(Date.now());
  });

  it('exports device apps with the session and imports them onto the imported device (not running)', () => {
    const h = newHub();
    h.upsertDeviceApp({
      deviceId: PIXEL,
      id: KUMBARA,
      name: 'Kumbara',
      version: '3.1.0',
      build: '310',
      buildType: 'release',
      install: { source: 'play', installer: 'com.android.vending' },
      pids: [12001],
      running: true,
      crashReportsDelta: 2,
    });
    h.upsertDeviceApp({ deviceId: PIXEL, id: 'com.mykynk.pati', buildType: 'debug', install: { source: 'adb' } });
    const app = h.registerApp(appInput(PIXEL));
    const all = h.exportSession() as ReturnType<Hub['exportSession']> & { deviceApps?: DeviceApp[] };
    expect(all.deviceApps?.map((a) => a.id).sort()).toEqual([KUMBARA, 'com.mykynk.pati']);
    const scoped = h.exportSession({ appId: app.id }) as typeof all;
    expect(scoped.deviceApps?.map((a) => a.id)).toEqual(['com.mykynk.pati']);

    const target = makeHub();
    try {
      const { deviceIds } = target.importSession(JSON.parse(JSON.stringify(all)), 'tester-bug.durbun.json');
      expect(deviceIds).toHaveLength(1);
      const imported = target.getDeviceApps().find((a) => a.id === KUMBARA)!;
      expect(imported).toMatchObject({
        key: `${deviceIds[0]}|${KUMBARA}`,
        deviceId: deviceIds[0],
        version: '3.1.0',
        buildType: 'release',
        install: { source: 'play', installer: 'com.android.vending' },
        pids: [],
        running: false,
        crashReports: 2,
      });
      // device apps of devices that are not in the file are ignored; old files without the field import fine
      const legacy = { ...all, deviceApps: [{ deviceId: 'nowhere', id: 'x' }, 'junk'] };
      expect(() => target.importSession(legacy as never, 'old')).not.toThrow();
      const { deviceApps: _omit, ...noApps } = all;
      expect(target.importSession(noApps, 'older').deviceIds).toHaveLength(1);
    } finally {
      target.dispose();
    }
  });
});

describe('LogEntry.origin', () => {
  it('system → durbun, SDK → sdk, VM service → vm-service, device lines keep a valid driver origin, imports keep theirs else import', () => {
    const h = newHub();
    const sdkApp = h.registerApp(appInput(PIXEL));
    const vmApp = h.registerApp(appInput(PIXEL, { sessionKey: 'vm-1', transport: 'vm-service', sdk: { name: 'durbun-vm-service', version: '0.1.0', platform: 'dart-vm' } }));
    h.pushAppLog(sdkApp.id, { ts: Date.now(), level: 'info', tag: 'app', message: 'from sdk' });
    h.pushAppLog(vmApp.id, { ts: Date.now(), level: 'info', tag: 'log', message: 'from vm' });
    h.netRequest(sdkApp.id, { type: 'net.request', id: '1', ts: Date.now(), method: 'GET', url: 'https://api.example.com/x', headers: [], source: 'dart:io' });
    h.pushDeviceLogs(PIXEL, [line({ origin: 'logcat', message: 'logcat line' }), line({ origin: 'bogus' as never, message: 'bad origin' }), line({ message: 'no origin' })]);
    h.addMarker('here');
    h.recordDesktopRequest({ id: '', deviceId: '', source: 'replay', method: 'GET', url: 'https://api.example.com/y', host: 'api.example.com', path: '/y', startTs: Date.now(), state: 'complete', requestHeaders: [], hasRequestBody: false, hasResponseBody: false });

    const byMessage = (m: string) => h.getLogs().find((l) => l.message === m)!;
    expect(byMessage('from sdk').origin).toBe('sdk');
    expect(byMessage('from vm').origin).toBe('vm-service');
    expect(byMessage('GET https://api.example.com/x').origin).toBe('sdk');
    expect(byMessage('logcat line').origin).toBe('logcat');
    expect(byMessage('bad origin').origin).toBeUndefined();
    expect('origin' in byMessage('no origin')).toBe(false);
    expect(h.getLogs().filter((l) => l.source === 'system').every((l) => l.origin === 'durbun')).toBe(true);
    expect(h.getLogs().some((l) => l.code === 'device.connected' && l.origin === 'durbun')).toBe(true);

    const target = makeHub();
    try {
      const exported = h.exportSession();
      target.importSession(JSON.parse(JSON.stringify(exported)), 'file');
      const imported = target.getLogs();
      expect(imported.find((l) => l.message === 'logcat line')!.origin).toBe('logcat');
      expect(imported.find((l) => l.message === 'from vm')!.origin).toBe('vm-service');
      expect(imported.find((l) => l.message === 'no origin')!.origin).toBe('import');
    } finally {
      target.dispose();
    }
  });
});

describe('WS /ui with the real hub', () => {
  it('snapshot carries deviceApps; batches carry deviceApps and removedDeviceApps', async () => {
    hub = makeHub();
    t = await startTestApp({ hub });
    hub.upsertDevice(device(PIXEL));
    hub.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, name: 'Kumbara', buildType: 'release', install: { source: 'play' }, pids: [12001], running: true });
    const c = await connectUi(t.port);
    clients.push(c);
    await c.synced();
    const snapshot = c.messages.find((m) => m.type === 'snapshot') as Extract<ServerToUi, { type: 'snapshot' }>;
    expect(snapshot.deviceApps).toEqual([expect.objectContaining({ key: `${PIXEL}|${KUMBARA}`, running: true, install: { source: 'play' } })]);

    const from = c.messages.length;
    hub.upsertDeviceApp({ deviceId: PIXEL, id: 'com.mykynk.pati.staging', buildType: 'release', install: { source: 'firebase', installer: 'dev.firebase.appdistribution' } });
    const added = await c.waitFor<Extract<ServerToUi, { type: 'batch' }>>(
      (m) => m.type === 'batch' && !!m.deviceApps?.some((a) => a.id === 'com.mykynk.pati.staging'),
      3000,
      from,
    );
    expect(added.deviceApps!.find((a) => a.id === 'com.mykynk.pati.staging')).toMatchObject({ install: { source: 'firebase', installer: 'dev.firebase.appdistribution' } });
    const from2 = c.messages.length;
    hub.removeDeviceApps(PIXEL, [KUMBARA]);
    const removed = await c.waitFor<Extract<ServerToUi, { type: 'batch' }>>((m) => m.type === 'batch' && !!m.removedDeviceApps, 3000, from2);
    expect(removed.removedDeviceApps).toEqual([`${PIXEL}|${KUMBARA}`]);
  });
});
