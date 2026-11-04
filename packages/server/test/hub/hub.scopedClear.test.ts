/**
 * Scoped log clears remove what the UI scope shows (hub/appScope.ts). An app's clear used to send only its
 * session ids, so the device lines the scope attributes to the app (lines from before the SDK connected, a
 * sub-process, an earlier launch's crash record, log-stream lines) stayed on screen after "Logları temizle".
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry, ServerToUi } from '@durbun/protocol';
import type { ClearEvent, Hub } from '../../src/types';
import { connectUi, startTestApp, type TestApp, type UiTestClient } from '../http/fakes';
import { appInput, device, makeHub } from './helpers';

const PIXEL = 'android:R5CT1234';
const OTHER = 'android:R5CT9999';
const PATI = 'com.mykynk.pati';
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
});

function newHub(): Hub {
  hub = makeHub();
  hub.upsertDevice(device(PIXEL));
  hub.upsertDevice(device(OTHER, { name: 'Pixel 7' }));
  return hub;
}

const line = (message: string, patch: Partial<LogEntry> = {}) => ({ ts: Date.now(), level: 'info' as const, tag: 'App', message, ...patch });
const record = (message: string, pkg: string, data: Record<string, unknown> = {}) =>
  line(message, { level: 'fatal', tag: 'dropbox', kind: 'crash', origin: 'dropbox', process: pkg, data: { origin: 'dropbox', package: pkg, ...data } });

/** The test's own lines (not the hub's lifecycle lines) that are still there, oldest first. */
function left(h: Hub, mine: string[]): string[] {
  return h.getLogs().filter((e) => mine.includes(e.message)).map((e) => e.message);
}

describe('scoped log clears', () => {
  it("an app's clear (device + bundle id) takes the device lines its scope shows, and nothing of other apps", () => {
    const h = newHub();
    const events: ClearEvent[] = [];
    h.onCleared((e) => events.push(e));
    h.upsertDeviceApp({ deviceId: PIXEL, id: PATI, pids: [8421], running: true, crashReportsDelta: 1 });
    h.upsertDeviceApp({ deviceId: PIXEL, id: KUMBARA, pids: [5000], running: true, crashReportsDelta: 1 });
    h.pushDeviceLogs(PIXEL, [
      line('pati startup', { pid: 8421, process: PATI }), // before the SDK connected: no appId
      record('pati crashed this morning', PATI, { previousLaunch: true, pid: 7001 }),
      record('kumbara crashed', KUMBARA),
    ]);
    const pati = h.registerApp(appInput(PIXEL, { app: { name: 'Pati', id: PATI, version: '2.4.1', pid: 8421 } }));
    h.pushAppLog(pati.id, { ts: Date.now(), level: 'info', tag: 'app', message: 'pati sdk line' });
    h.pushDeviceLogs(PIXEL, [
      line('pati push process', { pid: 9100, process: `${PATI}:push` }),
      line('kumbara line', { pid: 5000, process: KUMBARA }),
      line('android line', { pid: 1043, process: 'system_server' }),
    ]);
    h.pushDeviceLogs(OTHER, [line('pati on the other phone', { pid: 8421, process: PATI })]);
    h.pushSystemLog(PIXEL, { message: 'log stream restarted', code: 'logs.restarted' });
    h.addMarker('pixel marker', PIXEL);
    h.addMarker('global marker');
    h.addMarker('other phone marker', OTHER);
    const mine = [
      'pati startup', 'pati crashed this morning', 'kumbara crashed', 'pati sdk line', 'pati push process', 'kumbara line',
      'android line', 'pati on the other phone', 'log stream restarted', 'pixel marker', 'global marker', 'other phone marker',
    ];
    expect(left(h, mine)).toEqual(mine);

    h.clear('logs', { deviceId: PIXEL, bundleId: PATI });

    expect(left(h, mine)).toEqual(['kumbara crashed', 'kumbara line', 'android line', 'pati on the other phone', 'global marker', 'other phone marker']);
    // Only the removed record comes off the count; Kumbara's record and count stay.
    expect(h.getDeviceApps().map((a) => [a.id, a.crashReports ?? 0])).toEqual([[PATI, 0], [KUMBARA, 1]]);
    expect(h.getApp(pati.id)!.stats.logs).toBe(0);
    expect(events).toEqual([{ target: 'logs', deviceId: PIXEL, bundleId: PATI }]);
  });

  it('an app without an SDK session no longer wipes the whole device; clear("all") keeps the device', () => {
    const h = newHub();
    h.upsertDeviceApp({ deviceId: PIXEL, id: PATI, pids: [8421], running: true });
    h.pushDeviceLogs(PIXEL, [line('pati line', { pid: 8421, process: PATI }), line('pati by pid only', { pid: 8421 }), line('kumbara line', { pid: 5000, process: KUMBARA })]);
    const mine = ['pati line', 'pati by pid only', 'kumbara line'];

    h.clear('logs', { deviceId: PIXEL, bundleId: PATI });
    expect(left(h, mine)).toEqual(['kumbara line']);

    h.markDeviceDisconnected(PIXEL, 'USB cable unplugged');
    h.clear('all', { deviceId: PIXEL, bundleId: PATI });
    expect(h.getDevice(PIXEL)).toBeDefined();
    expect(left(h, mine)).toEqual(['kumbara line']);
  });

  it("a session's clear (exact scope) takes the lines of its own process, not an earlier run's", () => {
    const h = newHub();
    h.pushDeviceLogs(PIXEL, [
      line('earlier run', { pid: 7001, process: PATI }),
      record('pati crashed this morning', PATI, { previousLaunch: true, pid: 7001 }),
      line('this run startup', { pid: 8421, process: PATI }),
    ]);
    const pati = h.registerApp(appInput(PIXEL, { sessionKey: 'run-2', app: { name: 'Pati', id: PATI, version: '2.4.1', pid: 8421 } }));
    h.pushAppLog(pati.id, { ts: Date.now(), level: 'info', tag: 'app', message: 'this run sdk line' });
    const mine = ['earlier run', 'pati crashed this morning', 'this run startup', 'this run sdk line'];

    h.clear('logs', { deviceId: PIXEL, appId: pati.id });

    expect(left(h, mine)).toEqual(['earlier run', 'pati crashed this morning']);
  });

  it('the clear command carries the bundle id to the hub and back to every UI in `cleared`', async () => {
    const h = newHub();
    t = await startTestApp({ hub: h });
    h.upsertDeviceApp({ deviceId: PIXEL, id: PATI, pids: [8421], running: true });
    h.pushDeviceLogs(PIXEL, [line('pati line', { pid: 8421, process: PATI }), line('kumbara line', { pid: 5000, process: KUMBARA })]);
    const a = await connectUi(t.port);
    const b = await connectUi(t.port);
    clients.push(a, b);
    await a.synced();
    await b.synced();
    const from = b.messages.length;

    expect(await a.command({ name: 'clear', target: 'logs', deviceId: PIXEL, bundleId: PATI })).toMatchObject({ ok: true });
    const cleared = await b.waitFor<Extract<ServerToUi, { type: 'cleared' }>>((m) => m.type === 'cleared', 3000, from);
    expect(cleared).toEqual({ type: 'cleared', target: 'logs', deviceId: PIXEL, bundleId: PATI });
    expect(left(h, ['pati line', 'kumbara line'])).toEqual(['kumbara line']);
  });

  it("an unknown session's clear removes only its own rows", () => {
    const h = newHub();
    h.pushDeviceLogs(PIXEL, [line('pati line', { pid: 8421, process: PATI })]);
    h.addMarker('pixel marker', PIXEL);
    h.clear('logs', { deviceId: PIXEL, appId: 'app:unknown' });
    expect(left(h, ['pati line', 'pixel marker'])).toEqual(['pati line', 'pixel marker']);
  });
});
