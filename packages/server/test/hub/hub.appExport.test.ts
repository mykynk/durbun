/**
 * Export of one device app (audit-seams #10): `exportSession({ deviceId, bundleId })` keeps what the UI's
 * device-app scope shows — the app's lines (pids, process names, crash records by package), its sessions,
 * requests, metrics and its DeviceApp — and nothing of the other apps on the phone.
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { appScope } from '../../src/hub/appScope';
import type { DeviceLogInput, Hub } from '../../src/types';
import { appInput, device, makeHub } from './helpers';

const PIXEL = 'android:R5CT1234';
const IPHONE = 'ios:00008110-001A2B3C4D5E6F70';
const KUMBARA = 'com.mykynk.kumbara';
const PATI = 'com.mykynk.pati';

const dl = (patch: Partial<DeviceLogInput> & { message: string }): DeviceLogInput => ({ ts: Date.now(), level: 'info', tag: 'x', ...patch });
const texts = (logs: LogEntry[]) => logs.filter((l) => l.source !== 'system' || l.code?.startsWith('process.')).map((l) => l.message);

function setup(): { hub: Hub; patiAppId: string } {
  const hub = makeHub();
  hub.upsertDevice(device(PIXEL));
  hub.upsertDevice(device(IPHONE, { platform: 'ios', name: 'iPhone 13' }));
  hub.setProcess({ deviceId: PIXEL, pid: 1043, name: 'system_server', event: 'seen' });
  hub.setProcess({ deviceId: PIXEL, pid: 9312, name: `${KUMBARA}:widget`, event: 'died' }); // an earlier run
  hub.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, name: 'Kumbara', pids: [12_045, 12_070], running: true, install: { source: 'play' }, crashReportsDelta: 2 });
  hub.upsertDeviceApp({ deviceId: PIXEL, id: PATI, pids: [8421], running: true, install: { source: 'adb' } });
  hub.upsertDeviceApp({ deviceId: PIXEL, id: 'com.other.app', pids: [7000], running: true, install: { source: 'play' } });
  const pati = hub.registerApp(appInput(PIXEL, { app: { name: 'Pati', id: PATI, version: '2.4.1', pid: 8421 } }));
  hub.pushDeviceLogs(PIXEL, [
    dl({ pid: 12_045, process: KUMBARA, tag: 'flutter', message: 'Kumbara: hedef güncellendi' }),
    dl({ pid: 12_070, process: `${KUMBARA}:widget`, tag: 'GoalWidget', message: 'widget onUpdate' }),
    dl({ pid: 12_045, tag: 'TrafficStats', message: 'line without a process name' }),
    dl({ pid: 12_070, process: 'com.android.vending', message: 'an old Play Store line under a pid Kumbara has now' }),
    dl({ pid: 12_070, process: 'com.mykynk.kumbara.sync', message: 'global-named process of Kumbara' }),
    dl({ pid: 9312, message: 'line of the earlier widget run' }),
    dl({ ts: 1, level: 'fatal', tag: 'data_app_crash', kind: 'crash', origin: 'dropbox', message: 'widget crashed this morning', pid: 9999, process: `${KUMBARA}:widget`, data: { origin: 'dropbox', package: KUMBARA, previousLaunch: true } }),
    dl({ level: 'error', tag: 'ActivityManager', kind: 'anr', message: `ANR in ${KUMBARA}`, pid: 12_045, process: KUMBARA, data: { reporterPid: 1043, package: KUMBARA } }),
    dl({ pid: 1043, tag: 'ActivityManager', message: `Start proc 12045:${KUMBARA}/u0a241` }),
    dl({ pid: 7000, process: 'com.other.app', message: 'another app' }),
    dl({ pid: 8421, process: PATI, tag: 'flutter', message: 'Pati stdout' }),
  ]);
  hub.setProcess({ deviceId: PIXEL, pid: 12_045, name: KUMBARA, event: 'died' });
  hub.pushAppLog(pati.id, { ts: Date.now(), level: 'info', tag: 'app', message: 'Pati SDK line' });
  hub.netRequest(pati.id, { type: 'net.request', id: 'r1', ts: Date.now(), method: 'GET', url: 'https://api.pati.app/v1/pets', headers: [], source: 'dart:io' });
  hub.pushMetrics([
    { ts: Date.now(), deviceId: PIXEL, pid: 12_045, source: 'adb', cpu: 12, memoryMB: 200 },
    { ts: Date.now(), deviceId: PIXEL, pid: 7000, source: 'adb', cpu: 3 },
  ]);
  hub.pushAppMetrics(pati.id, { ts: Date.now(), source: 'sdk', heapMB: 40 });

  // Two Flutter apps named "Runner" on the iPhone: the pid decides.
  hub.upsertDeviceApp({ deviceId: IPHONE, id: KUMBARA, processName: 'Runner', pids: [2841], running: true, install: { source: 'store-or-testflight' } });
  hub.upsertDeviceApp({ deviceId: IPHONE, id: PATI, processName: 'Runner', pids: [3120], running: true, install: { source: 'xcode' } });
  hub.pushDeviceLogs(IPHONE, [
    dl({ pid: 2841, process: 'Runner', message: 'Kumbara on the iPhone' }),
    dl({ pid: 3120, process: 'Runner', message: 'Pati on the iPhone' }),
    dl({ pid: 5555, process: 'Runner', message: 'some Runner nobody knows' }),
    dl({ pid: 2841, process: 'KumbaraWidgetExtension', message: 'Kumbara widget extension' }),
    dl({ level: 'fatal', tag: 'crash-report', kind: 'crash', origin: 'crash-report', message: 'Kumbara 3.1.0 (310) crashed', pid: 1977, process: 'Runner', data: { origin: 'crash-report', bundleId: KUMBARA } }),
  ]);
  return { hub, patiAppId: pati.id };
}

describe('device-app export', () => {
  it('an SDK-less build: its lines, crash records, process lines, metrics and DeviceApp only', () => {
    const { hub } = setup();
    const out = hub.exportSession({ deviceId: PIXEL, bundleId: KUMBARA });
    expect(texts(out.logs)).toEqual([
      'Kumbara: hedef güncellendi',
      'widget onUpdate',
      'line without a process name',
      'global-named process of Kumbara',
      'line of the earlier widget run',
      'widget crashed this morning',
      `ANR in ${KUMBARA}`,
    ]);
    expect(out.logs.some((l) => l.message.includes('Play Store') || l.message === 'another app' || l.message.startsWith('Pati') || l.message.startsWith('Start proc'))).toBe(false);
    expect(out.logs.every((l) => l.deviceId === PIXEL || l.deviceId === '')).toBe(true);
    expect(out.logs.some((l) => l.code === 'device.connected')).toBe(true); // the device's own lines stay
    expect(out.apps).toEqual([]);
    expect(out.network).toEqual([]);
    expect(out.devices.map((d) => d.id)).toEqual([PIXEL]);
    expect(out.deviceApps?.map((a) => a.key)).toEqual([`${PIXEL}|${KUMBARA}`]);
    expect(out.deviceApps?.[0]).toMatchObject({ crashReports: 2 });
    expect(out.metrics?.map((m) => m.pid)).toEqual([12_045]);
  });

  it('an app with an SDK session: its session, SDK lines, device lines, requests and metrics', () => {
    const { hub, patiAppId } = setup();
    const out = hub.exportSession({ deviceId: PIXEL, bundleId: PATI });
    expect(out.apps.map((a) => a.id)).toEqual([patiAppId]);
    expect(texts(out.logs)).toEqual(['Pati stdout', 'Pati SDK line', 'GET https://api.pati.app/v1/pets']);
    expect(out.network.map((n) => n.url)).toEqual(['https://api.pati.app/v1/pets']);
    expect(out.metrics?.map((m) => m.appId)).toEqual([patiAppId]);
    expect(out.deviceApps?.map((a) => a.id)).toEqual([PATI]);
  });

  it('two "Runner" apps on an iPhone: the pid decides; extensions by live pid; .ips by bundle id', () => {
    const { hub } = setup();
    expect(texts(hub.exportSession({ deviceId: IPHONE, bundleId: KUMBARA }).logs)).toEqual([
      'Kumbara on the iPhone',
      'Kumbara widget extension',
      'Kumbara 3.1.0 (310) crashed',
    ]);
    expect(texts(hub.exportSession({ deviceId: IPHONE, bundleId: PATI }).logs)).toEqual(['Pati on the iPhone']);
    // an app nobody reports any more still exports its crash records and nothing else
    hub.removeDeviceApps(IPHONE, [KUMBARA]);
    expect(texts(hub.exportSession({ deviceId: IPHONE, bundleId: KUMBARA }).logs)).toEqual(['Kumbara 3.1.0 (310) crashed']);
  });

  it('without deviceId, or with appId, bundleId is not used (device / session scopes as before)', () => {
    const { hub, patiAppId } = setup();
    expect(hub.exportSession({ bundleId: KUMBARA }).logs.length).toBe(hub.exportSession().logs.length);
    expect(hub.exportSession({ deviceId: PIXEL, appId: patiAppId, bundleId: KUMBARA })).toMatchObject({ apps: [{ id: patiAppId }] });
    expect(appScope({ deviceId: PIXEL, bundleId: KUMBARA, apps: [], deviceApps: [], processes: [] }).pids.size).toBe(0);
  });
});
