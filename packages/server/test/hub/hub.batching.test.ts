import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionExport } from '@durbun/protocol';
import type { ClearEvent, Hub } from '../../src/types';
import { appInput, collectChanges, device, makeHub } from './helpers';

let hub: Hub;

describe('change batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    hub?.dispose();
    vi.useRealTimers();
  });

  it('flushes every 100 ms and coalesces network/devices/apps by id', () => {
    hub = makeHub();
    const { changes } = collectChanges(hub);
    hub.upsertDevice(device('android:R5CT'));
    const app = hub.registerApp(appInput('android:R5CT'));
    hub.patchDevice('android:R5CT', { battery: { level: 50, charging: false } });
    hub.patchDevice('android:R5CT', { battery: { level: 49, charging: false } });
    hub.netRequest(app.id, { type: 'net.request', id: '1', ts: 1, method: 'GET', url: 'https://a.b/c', headers: [], source: 'dart:io' });
    hub.netResponse(app.id, { type: 'net.response', id: '1', ts: 2, status: 204, headers: [] });
    hub.pushAppMetrics(app.id, { ts: 3, source: 'sdk', cpu: 12.5, fps: 59.8 });
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.devices).toHaveLength(1);
    expect(c.devices[0]!.battery).toEqual({ level: 49, charging: false });
    expect(c.network).toHaveLength(1);
    expect(c.network[0]).toMatchObject({ state: 'complete', status: 204 });
    expect(c.apps).toHaveLength(1);
    expect(c.apps[0]!.stats.requests).toBe(1);
    expect(c.metrics).toEqual([{ ts: 3, deviceId: 'android:R5CT', appId: app.id, pid: 8421, source: 'sdk', cpu: 12.5, fps: 59.8 }]);
    expect(c.logs.map((l) => l.code ?? l.kind)).toEqual(['device.connected', 'app.connected', 'network']);
    // snapshots are copies: later changes do not leak into delivered batches
    hub.netError(app.id, { type: 'net.error', id: '1', ts: 9, error: 'late failure' });
    expect(c.network[0]!.state).toBe('complete');
    vi.advanceTimersByTime(100);
    expect(changes).toHaveLength(2);
    expect(changes[1]!.network[0]!.state).toBe('failed');
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(2); // nothing queued → no empty batches
  });

  it('flushes immediately once 2 000 logs are queued', () => {
    hub = makeHub();
    const { changes } = collectChanges(hub);
    const lines = Array.from({ length: 1999 }, (_, i) => ({ ts: i, level: 'info' as const, tag: 't', message: `m${i}` }));
    hub.pushDeviceLogs('d', lines);
    expect(changes).toHaveLength(0);
    hub.pushDeviceLogs('d', [{ ts: 2000, level: 'info', tag: 't', message: 'last' }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.logs).toHaveLength(2000);
  });

  it('splits huge log batches into chunks of at most 5 000', () => {
    hub = makeHub();
    const { changes } = collectChanges(hub);
    hub.pushDeviceLogs('d', Array.from({ length: 12_000 }, (_, i) => ({ ts: i, level: 'debug' as const, tag: 't', message: String(i) })));
    expect(changes.map((c) => c.logs.length)).toEqual([5000, 5000, 2000]);
    expect(changes.flatMap((c) => c.logs).map((l) => l.message)).toEqual(Array.from({ length: 12_000 }, (_, i) => String(i)));
  });

  it('isolates failing subscribers', () => {
    hub = makeHub();
    hub.subscribe(() => {
      throw new Error('boom');
    });
    const { changes } = collectChanges(hub);
    hub.addMarker('x');
    vi.advanceTimersByTime(100);
    expect(changes).toHaveLength(1);
  });
});

describe('clear', () => {
  afterEach(() => hub?.dispose());

  function seed() {
    hub = makeHub();
    hub.upsertDevice(device('android:A'));
    hub.upsertDevice(device('ios-sim:B', { platform: 'ios', kind: 'simulator', name: 'iPhone 16 Pro' }));
    const a = hub.registerApp(appInput('android:A'));
    const b = hub.registerApp(appInput('ios-sim:B', { sessionKey: 'ios-1', app: { name: 'Pati', id: 'com.mykynk.pati', pid: 4242, processName: 'Runner' } }));
    for (const app of [a, b]) {
      hub.pushAppLog(app.id, { ts: 1, level: 'error', message: `log of ${app.id}` });
      hub.netRequest(app.id, { type: 'net.request', id: '1', ts: 1, method: 'GET', url: 'https://x.y/', headers: [], source: 'dart:io' });
      hub.pushAppMetrics(app.id, { ts: 1, source: 'sdk', cpu: 1 });
    }
    hub.pushDeviceLogs('android:A', [{ ts: 1, level: 'info', tag: 'ActivityManager', message: 'device line' }]);
    hub.pushMetrics([{ ts: 1, deviceId: 'android:A', pid: 1043, source: 'adb', cpu: 3 }]);
    return { a, b };
  }

  it('clears logs of one app only and announces it', () => {
    const { a, b } = seed();
    const events: ClearEvent[] = [];
    hub.onCleared((e) => events.push(e));
    hub.clear('logs', { appId: a.id });
    expect(hub.getLogs().some((l) => l.appId === a.id)).toBe(false);
    expect(hub.getLogs().some((l) => l.appId === b.id)).toBe(true);
    expect(hub.getLogs().some((l) => l.message === 'device line')).toBe(true);
    expect(hub.getNetwork()).toHaveLength(2);
    expect(hub.getApp(a.id)!.stats).toMatchObject({ logs: 0, errors: 0, requests: 1 });
    expect(events).toEqual([{ target: 'logs', appId: a.id }]);
  });

  it('clears network and metrics per device', () => {
    const { b } = seed();
    hub.clear('network', { deviceId: 'android:A' });
    expect(hub.getNetwork().map((e) => e.appId)).toEqual([b.id]);
    hub.clear('metrics', { deviceId: 'android:A' });
    expect(hub.getMetrics().every((m) => m.deviceId === 'ios-sim:B')).toBe(true);
    expect(hub.getMetrics()).toHaveLength(1);
  });

  it('clear all wipes data and removes devices that are gone', () => {
    seed();
    vi.useFakeTimers();
    try {
      const { changes } = collectChanges(hub);
      hub.markAppDisconnected(hub.getApps().find((x) => x.deviceId === 'ios-sim:B')!.id);
      hub.markDeviceDisconnected('ios-sim:B', 'Simulator shut down');
      const events: ClearEvent[] = [];
      const order: string[] = [];
      hub.subscribe(() => order.push('batch'));
      hub.onCleared((e) => {
        events.push(e);
        order.push('cleared');
      });
      hub.clear('all');
      expect(order).toEqual(['batch', 'cleared']); // queued changes go out before the cleared event
      expect(hub.getLogCount()).toBe(0);
      expect(hub.getNetwork()).toHaveLength(0);
      expect(hub.getMetrics()).toHaveLength(0);
      expect(hub.getDevices().map((d) => d.id)).toEqual(['android:A']);
      expect(hub.getApps().map((x) => x.deviceId)).toEqual(['android:A']);
      vi.advanceTimersByTime(100);
      expect(changes.flatMap((c) => c.removedDevices)).toEqual(['ios-sim:B']);
      expect(events).toEqual([{ target: 'all' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('export / import', () => {
  afterEach(() => hub?.dispose());

  it('round-trips a session onto new import devices with re-assigned ids', () => {
    hub = makeHub();
    hub.upsertDevice(device('android:A', { name: 'Pixel 8' }));
    const app = hub.registerApp(appInput('android:A'));
    hub.pushAppLog(app.id, { ts: 5, level: 'warn', tag: 'auth', message: 'Token süresi doluyor', data: { expiresIn: 58 } });
    hub.netRequest(app.id, {
      type: 'net.request',
      id: '9',
      ts: 6,
      method: 'POST',
      url: 'https://api.pati.app/v1/auth/refresh',
      headers: [['content-type', 'application/json']],
      body: { encoding: 'utf8', data: '{"refreshToken":"r1"}', size: 21 },
      source: 'dart:io',
    });
    hub.netResponse(app.id, { type: 'net.response', id: '9', ts: 9, status: 200, headers: [['content-type', 'application/json']], body: { encoding: 'utf8', data: '{"accessToken":"a2"}', size: 20 } });
    hub.pushAppMetrics(app.id, { ts: 7, source: 'sdk', memoryMB: 182.5 });
    hub.addMarker('before export');

    const exported: SessionExport = JSON.parse(JSON.stringify(hub.exportSession({ deviceId: 'android:A' })));
    expect(exported).toMatchObject({ format: 'durbun-session', version: 1 });
    expect(exported.devices.map((d) => d.id)).toEqual(['android:A']);
    expect(exported.network[0]!.requestBody!.data).toBe('{"refreshToken":"r1"}');
    expect(exported.logs.some((l) => l.kind === 'marker')).toBe(true);

    const before = hub.getLogs().at(-1)!.id;
    const { deviceIds } = hub.importSession(exported, 'pati-bug.durbun.json');
    expect(deviceIds).toEqual(['import:1']);
    const imported = hub.getDevice('import:1')!;
    expect(imported).toMatchObject({ name: '📁 Pixel 8', state: 'disconnected', platform: 'android', stateDetail: 'Imported from pati-bug.durbun.json' });

    const importedApp = hub.getApps().find((a) => a.deviceId === 'import:1')!;
    expect(importedApp.id).not.toBe(app.id);
    expect(importedApp).toMatchObject({ connected: false, transport: 'import', app: { id: 'com.mykynk.pati' } });

    const logs = hub.getLogs().filter((l) => l.deviceId === 'import:1');
    expect(logs.every((l) => l.id > before)).toBe(true);
    const net = hub.getNetwork().find((e) => e.deviceId === 'import:1')!;
    expect(net.id).toBe(`import:1:${app.id}:9`);
    expect(net.appId).toBe(importedApp.id);
    expect(hub.getNetworkDetail(net.id)!.responseBody!.data).toBe('{"accessToken":"a2"}');
    const row = logs.find((l) => l.kind === 'network')!;
    expect(row.netId).toBe(net.id);
    expect(logs.find((l) => l.tag === 'auth')).toMatchObject({ appId: importedApp.id, data: { expiresIn: 58 } });
    expect(hub.getMetrics().find((m) => m.deviceId === 'import:1')).toMatchObject({ appId: importedApp.id, memoryMB: 182.5 });
    expect(importedApp.stats.requests).toBe(1);
    // no lifecycle lines for imported devices/apps
    expect(hub.getLogs().filter((l) => l.id > before && l.source === 'system' && l.kind === 'lifecycle' && l.deviceId === 'import:1')).toHaveLength(
      exported.logs.filter((l) => l.kind === 'lifecycle').length,
    );

    // importing the same file again creates a second, distinct device
    const again = hub.importSession(exported, 'pati-bug.durbun.json');
    expect(again.deviceIds).toEqual(['import:2']);
    expect(hub.getDevice('import:2')!.name).toBe('📁 Pixel 8 (2)');
  });

  it('rejects files that are not session exports and tolerates missing arrays', () => {
    hub = makeHub();
    expect(() => hub.importSession({ format: 'har' } as unknown as SessionExport, 'x')).toThrow(/session/);
    const res = hub.importSession({ format: 'durbun-session', version: 1, logs: [{ id: 1, ts: 5, deviceId: '', source: 'system', level: 'info', tag: 'durbun', message: 'Marker 1', kind: 'marker' }] } as unknown as SessionExport, 'tiny');
    expect(res.deviceIds).toHaveLength(1);
    expect(hub.getDevice(res.deviceIds[0]!)!.name).toBe('📁 tiny');
    expect(hub.getLogs()).toHaveLength(1);
  });

  it('does not tap imported (historical) logs through onLogs', () => {
    hub = makeHub();
    const tapped: number[] = [];
    hub.onLogs((e) => tapped.push(e.length));
    hub.importSession(
      {
        format: 'durbun-session',
        version: 1,
        exportedAt: 1,
        server: { version: '0.1.0' },
        devices: [],
        apps: [],
        network: [],
        logs: [{ id: 1, ts: 1, deviceId: 'android:A', source: 'device', level: 'info', tag: 'flutter', message: 'The Dart VM service is listening on http://127.0.0.1:1/a=/' }],
      },
      'old',
    );
    expect(tapped).toEqual([]);
  });
});
