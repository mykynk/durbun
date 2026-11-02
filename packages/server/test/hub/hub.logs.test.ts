import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import type { DeviceLogInput, Hub } from '../../src/types';
import { appInput, device, makeHub, makeSettings } from './helpers';

const logcat = (pid: number, tag: string, message: string, level: LogEntry['level'] = 'info'): DeviceLogInput => ({
  ts: 1_762_078_123_456.789,
  level,
  tag,
  message,
  pid,
  tid: pid + 12,
});

let hub: Hub;
afterEach(() => hub?.dispose());

const systemLines = (h: Hub) => h.getLogs().filter((l) => l.source === 'system');

describe('hub logs', () => {
  it('assigns global increasing ids, deviceId and source', () => {
    hub = makeHub();
    hub.upsertDevice(device('android:R5CT'));
    hub.pushDeviceLogs('android:R5CT', [
      logcat(1043, 'ActivityManager', 'Start proc 8421:com.mykynk.pati/u0a234 for next-top-activity'),
      logcat(1043, 'chatty', 'uid=1000(system) Binder:1043_3 identical 2 lines'),
    ]);
    const logs = hub.getLogs().filter((l) => l.source === 'device');
    expect(logs.map((l) => l.deviceId)).toEqual(['android:R5CT', 'android:R5CT']);
    expect(logs[1]!.id).toBe(logs[0]!.id + 1);
    expect(logs[0]!.ts).toBe(1_762_078_123_456.789);
    const all = hub.getLogs();
    for (let i = 1; i < all.length; i++) expect(all[i]!.id).toBeGreaterThan(all[i - 1]!.id);
  });

  it('keeps at most maxLogEntries and supports afterId/limit paging', () => {
    hub = makeHub({ maxLogEntries: 1000 });
    const batch: DeviceLogInput[] = [];
    for (let i = 0; i < 2500; i++) batch.push(logcat(100, 'spam', `line ${i}`));
    hub.pushDeviceLogs('android:X', batch);
    expect(hub.getLogCount()).toBe(1000);
    const logs = hub.getLogs();
    expect(logs[0]!.message).toBe('line 1500');
    expect(logs[999]!.message).toBe('line 2499');
    const afterId = logs[10]!.id;
    const page = hub.getLogs({ afterId, limit: 5 });
    expect(page.map((l) => l.message)).toEqual(['line 1511', 'line 1512', 'line 1513', 'line 1514', 'line 1515']);
    expect(hub.getLogs({ afterId: logs[999]!.id })).toEqual([]);
    expect(hub.getLogs({ limit: 0 })).toEqual([]);
  });

  it('re-trims when maxLogEntries shrinks and keeps growing when it is raised', () => {
    hub = makeHub({ maxLogEntries: 500 });
    hub.pushDeviceLogs('d', Array.from({ length: 500 }, (_, i) => logcat(1, 't', `m${i}`)));
    hub.setSettings(makeSettings({ maxLogEntries: 100 }));
    expect(hub.getLogCount()).toBe(100);
    expect(hub.getLogs()[0]!.message).toBe('m400');
    hub.setSettings(makeSettings({ maxLogEntries: 300 }));
    hub.pushDeviceLogs('d', Array.from({ length: 150 }, (_, i) => logcat(1, 't', `n${i}`)));
    expect(hub.getLogCount()).toBe(250);
  });

  it('fills process names from the pid map and attributes app pids to the app session', () => {
    hub = makeHub();
    hub.upsertDevice(device('android:R5CT'));
    hub.setProcess({ deviceId: 'android:R5CT', pid: 1043, name: 'system_server', event: 'seen' });
    hub.setProcess({ deviceId: 'android:R5CT', pid: 8421, name: 'com.mykynk.pati', event: 'seen' });
    const app = hub.registerApp(appInput('android:R5CT'));
    hub.pushDeviceLogs('android:R5CT', [
      logcat(1043, 'ActivityTaskManager', 'Displayed com.mykynk.pati/.MainActivity for user 0: +742ms'),
      logcat(8421, 'flutter', '🐾 PetRepository: 20 dost yüklendi'),
      logcat(8421, 'OpenGLRenderer', 'Davey! duration=812ms', 'debug'),
      { ...logcat(9999, 'unknown', 'no process known') },
    ]);
    const lines = hub.getLogs().filter((l) => l.source === 'device');
    expect(lines[0]).toMatchObject({ process: 'system_server' });
    expect(lines[0]!.appId).toBeUndefined();
    expect(lines[1]).toMatchObject({ process: 'com.mykynk.pati', appId: app.id });
    expect(lines[2]!.appId).toBe(app.id);
    expect(lines[3]!.process).toBeUndefined();
    expect(hub.getApp(app.id)!.stats.logs).toBe(2);
  });

  it('keeps an explicit process name from the driver', () => {
    hub = makeHub();
    hub.setProcess({ deviceId: 'ios-sim:A', pid: 5, name: 'Runner', event: 'seen' });
    hub.pushDeviceLogs('ios-sim:A', [{ ...logcat(5, 'com.apple.network', 'nw_connection start'), process: 'Runner-explicit' }]);
    expect(hub.getLogs()[0]!.process).toBe('Runner-explicit');
  });

  it('turns SDK logs into app log entries with stats and level normalization', () => {
    hub = makeHub();
    hub.upsertDevice(device('android:R5CT'));
    const app = hub.registerApp(appInput('android:R5CT'));
    const entry = hub.pushAppLog(app.id, {
      ts: 1000,
      level: 'error',
      tag: 'payment',
      message: 'Ödeme başarısız',
      data: { orderId: 'PT-1', amount: 249.9 },
      error: { type: 'PaymentException', message: 'Kart reddedildi', stack: '#0 PaymentService.charge (package:pati/payment.dart:88:7)' },
    });
    expect(entry).toMatchObject({ source: 'app', appId: app.id, deviceId: 'android:R5CT', pid: 8421, kind: 'text', tag: 'payment' });
    const crash = hub.pushAppLog(app.id, { ts: 1001, level: 'info', message: 'Unhandled exception', kind: 'crash' });
    expect(crash!.level).toBe('fatal');
    const untagged = hub.pushAppLog(app.id, { ts: 1002, level: 'nonsense' as 'info', message: { a: 1 } as unknown as string });
    expect(untagged).toMatchObject({ tag: 'app', level: 'info', message: '{"a":1}' });
    expect(hub.pushAppLog('app:404', { ts: 1, level: 'info', message: 'x' })).toBeUndefined();
    expect(hub.getApp(app.id)!.stats).toEqual({ logs: 3, requests: 0, errors: 2 });
  });
});

describe('hub lifecycle lines', () => {
  it('announces device connect/disconnect with i18n codes', () => {
    hub = makeHub();
    hub.upsertDevice(device('android:R5CT', { state: 'unauthorized', stateCode: 'device.unauthorized', stateDetail: 'Accept the prompt' }));
    expect(systemLines(hub)).toHaveLength(0);
    hub.upsertDevice(device('android:R5CT'));
    expect(hub.getDevice('android:R5CT')!.stateCode).toBeUndefined();
    hub.upsertDevice(device('android:R5CT', { battery: { level: 80, charging: true } })); // still online: no line
    hub.markDeviceDisconnected('android:R5CT', 'USB cable unplugged');
    hub.markDeviceDisconnected('android:R5CT', 'USB cable unplugged'); // duplicate: ignored
    const lines = systemLines(hub);
    expect(lines.map((l) => l.code)).toEqual(['device.connected', 'device.disconnected']);
    expect(lines[0]).toMatchObject({ kind: 'lifecycle', tag: 'durbun', level: 'info', params: { device: 'Pixel 8', deviceId: 'android:R5CT' } });
    expect(lines[1]).toMatchObject({ level: 'warn', message: 'Device disconnected: Pixel 8 — USB cable unplugged' });
    const d = hub.getDevice('android:R5CT')!;
    expect(d.state).toBe('disconnected');
    expect(d.logs.status).toBe('stopped');
    expect(d.battery).toEqual({ level: 80, charging: true });
  });

  it('keeps firstSeen across upserts and ignores patches for unknown devices', () => {
    hub = makeHub();
    hub.upsertDevice(device('ios:0001', { firstSeen: 1000, lastSeen: 1000 }));
    hub.upsertDevice(device('ios:0001', { firstSeen: 5000, lastSeen: 6000 }));
    expect(hub.getDevice('ios:0001')).toMatchObject({ firstSeen: 1000, lastSeen: 6000 });
    hub.patchDevice('ios:nope', { name: 'x' });
    expect(hub.getDevice('ios:nope')).toBeUndefined();
    hub.patchDevice('ios:0001', { logs: { status: 'error', detail: 'idevicesyslog exited' } });
    expect(hub.getDevice('ios:0001')!.logs).toEqual({ status: 'error', detail: 'idevicesyslog exited' });
  });

  it('announces app connect, reconnect (same session key) and disconnect', () => {
    hub = makeHub();
    hub.upsertDevice(device('android:R5CT'));
    const a = hub.registerApp(appInput('android:R5CT'));
    hub.markAppDisconnected(a.id);
    hub.markAppDisconnected(a.id); // idempotent
    const b = hub.registerApp(appInput('android:R5CT'));
    expect(b.id).toBe(a.id);
    const c = hub.registerApp(appInput('android:R5CT', { sessionKey: 'session-2', app: { name: 'Pati', id: 'com.mykynk.pati', pid: 9000 } }));
    expect(c.id).not.toBe(a.id);
    const codes = systemLines(hub).map((l) => l.code);
    expect(codes).toEqual(['device.connected', 'app.connected', 'app.disconnected', 'app.reconnected', 'app.connected']);
    const connected = systemLines(hub).find((l) => l.code === 'app.connected')!;
    expect(connected).toMatchObject({ appId: a.id, params: { app: 'Pati', bundleId: 'com.mykynk.pati', sdk: 'flutter' } });
    expect(hub.getApp(a.id)!.connected).toBe(true);
  });

  it('announces process start/death only for SDK apps seen on the device or watched apps', () => {
    hub = makeHub({ watchedApps: ['com.mykynk.mahalle'] });
    hub.upsertDevice(device('android:R5CT'));
    const dev = 'android:R5CT';
    hub.setProcess({ deviceId: dev, pid: 3021, name: 'com.google.android.apps.photos', event: 'started' });
    hub.setProcess({ deviceId: dev, pid: 6612, name: 'com.mykynk.mahalle', event: 'started' });
    hub.setProcess({ deviceId: dev, pid: 6612, name: 'com.mykynk.mahalle', event: 'started' }); // duplicate
    hub.setProcess({ deviceId: dev, pid: 8421, name: 'com.mykynk.pati', event: 'started' }); // not seen yet
    const app = hub.registerApp(appInput(dev));
    hub.setProcess({ deviceId: dev, pid: 8421, name: 'com.mykynk.pati', event: 'died' });
    hub.setProcess({ deviceId: dev, pid: 8502, name: 'com.mykynk.pati', event: 'started' });
    hub.setProcess({ deviceId: 'android:OTHER', pid: 1, name: 'com.mykynk.pati', event: 'started' }); // other device
    const lines = systemLines(hub).filter((l) => l.code?.startsWith('process.'));
    expect(lines.map((l) => `${l.code} ${l.params?.process} ${l.params?.pid}`)).toEqual([
      'process.started com.mykynk.mahalle 6612',
      'process.died com.mykynk.pati 8421',
      'process.started com.mykynk.pati 8502',
    ]);
    expect(lines[1]!.appId).toBe(app.id);
    // pid 8421 is no longer the app's after its death
    hub.pushDeviceLogs(dev, [logcat(8421, 'x', 'reused pid')]);
    expect(hub.getLogs().at(-1)!.appId).toBeUndefined();
    const procs = hub.getProcesses().filter((p) => p.deviceId === dev);
    expect(procs.find((p) => p.pid === 8421)).toMatchObject({ event: 'died', name: 'com.mykynk.pati' });
  });

  it('does not re-announce periodic "seen" refreshes', () => {
    hub = makeHub();
    hub.setProcess({ deviceId: 'd', pid: 1, name: 'init', event: 'seen' });
    const before = hub.getProcesses()[0]!;
    hub.setProcess({ deviceId: 'd', pid: 1, name: 'init', event: 'seen' });
    expect(hub.getProcesses()).toEqual([before]);
  });

  it('adds numbered markers (global when no device is given)', () => {
    hub = makeHub();
    const m1 = hub.addMarker();
    const m2 = hub.addMarker('  Login denemesi  ', 'android:R5CT');
    expect(m1).toMatchObject({ kind: 'marker', code: 'marker', deviceId: '', message: 'Marker 1', source: 'system' });
    expect(m2).toMatchObject({ deviceId: 'android:R5CT', message: 'Login denemesi', params: { label: 'Login denemesi', n: 2 } });
  });

  it('lets drivers push their own system lines and notices', () => {
    hub = makeHub();
    const notices: unknown[] = [];
    hub.onNotice((n) => notices.push(n));
    const line = hub.pushSystemLog('android:R5CT', {
      message: 'Log stream started (logcat)',
      code: 'logs.streamStarted',
      params: { via: 'logcat' },
    });
    expect(line).toMatchObject({ kind: 'lifecycle', level: 'info', code: 'logs.streamStarted', tag: 'durbun' });
    hub.notice({ level: 'warn', message: 'adb not found', code: 'adb.missing' });
    expect(notices).toEqual([{ level: 'warn', message: 'adb not found', code: 'adb.missing' }]);
  });

  it('taps every appended batch synchronously through onLogs', () => {
    hub = makeHub();
    const seen: number[] = [];
    const off = hub.onLogs((entries) => seen.push(...entries.map((e) => e.id)));
    hub.pushDeviceLogs('d', [logcat(1, 'flutter', 'The Dart VM service is listening on http://127.0.0.1:53147/aBcD1234=/')]);
    expect(seen).toHaveLength(1);
    off();
    hub.pushDeviceLogs('d', [logcat(1, 'flutter', 'x')]);
    expect(seen).toHaveLength(1);
  });
});

describe('hub ingestion speed', () => {
  it('ingests 20 000 device lines quickly (well above 2 000 lines/s)', () => {
    hub = makeHub({ maxLogEntries: 10_000 });
    hub.subscribe(() => {});
    hub.setProcess({ deviceId: 'd', pid: 8421, name: 'com.mykynk.pati', event: 'seen' });
    hub.registerApp(appInput('d'));
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      const batch: DeviceLogInput[] = [];
      for (let j = 0; j < 100; j++) batch.push(logcat(j % 2 ? 8421 : 1043, 'tag', `message ${i}/${j} with some text payload`));
      hub.pushDeviceLogs('d', batch);
    }
    const ms = performance.now() - start;
    expect(hub.getLogCount()).toBe(10_000);
    // 20k lines must take far less than the 10 s they would represent at 2 000 lines/s.
    expect(ms).toBeLessThan(1000);
  });
});
