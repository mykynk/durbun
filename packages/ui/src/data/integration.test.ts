import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSession, type DeviceInfo, type LogEntry, type MetricSample, type ServerToUi, type UiToServer } from '@durbun/protocol';
import { handleServerMessage } from './dispatch';
import { logStore } from './logStore';
import { networkStore } from './networkStore';
import { metricsStore } from './metricsStore';
import { useHub } from './stores/hub';
import { setScope, useScopeStore } from './stores/scope';
import { __resetCommandsForTests, handleReply, sendCommand, sendCommandDetailed, setCommandTransport } from './commands';
import { ApiError, importSession, importUrl, upload } from './api';

const PIXEL = 'android:R5CT20XK9QM';
const IMPORTED = 'import:1';

function device(id: string, p: Partial<DeviceInfo> = {}): DeviceInfo {
  return { id, platform: 'android', kind: 'physical', name: id, connection: 'usb', state: 'online', logs: { status: 'streaming' }, actions: [], firstSeen: 1, lastSeen: 1, ...p };
}

function app(id: string, deviceId: string, p: Partial<AppSession> = {}): AppSession {
  return {
    id,
    sessionKey: `s-${id}`,
    deviceId,
    sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter' },
    app: { name: 'Pati', id: 'com.mykynk.pati', pid: 4242 },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: 1,
    capabilities: [],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
    ...p,
  };
}

let nextId = 1;
const log = (p: Partial<LogEntry> = {}): LogEntry => ({ id: nextId++, ts: 1, deviceId: PIXEL, source: 'device', level: 'info', tag: 't', message: 'm', ...p });
const sample = (deviceId: string, appId?: string): MetricSample => ({ ts: Date.now(), deviceId, ...(appId ? { appId } : { pid: 7 }), source: 'sdk', cpu: 12 });

function connect(devices: DeviceInfo[], apps: AppSession[], metrics: MetricSample[] = []): void {
  nextId = 1;
  const hello: ServerToUi = {
    type: 'hello',
    server: { name: 'durbun', version: '0.1.0', protocol: 1, ports: { http: 9750, sdk: 9751 }, startedAt: 1, demo: false, lan: false, hostAddresses: [], dataDir: '/tmp', platform: 'darwin' },
    settings: DEFAULT_SETTINGS,
  };
  handleServerMessage(hello);
  handleServerMessage({
    type: 'snapshot',
    devices,
    apps,
    network: [],
    mocks: [],
    drivers: [],
    processes: [
      { deviceId: PIXEL, pid: 4242, name: 'com.mykynk.pati', event: 'seen', ts: 1 },
      { deviceId: IMPORTED, pid: 9, name: 'Runner', event: 'seen', ts: 1 },
    ],
    metrics,
    logCount: 0,
  });
}

describe('device removal (batch.removedDevices)', () => {
  it('drops the removed devices’ app sessions, processes and metric series, then re-validates the scope', () => {
    connect([device(PIXEL), device(IMPORTED, { state: 'disconnected', stateCode: 'device.imported', name: '📁 Pixel 8' })], [app('app:1', PIXEL), app('app:2', IMPORTED, { connected: false })], [
      sample(PIXEL, 'app:1'),
      sample(IMPORTED, 'app:2'),
      sample(IMPORTED),
    ]);
    setScope({ kind: 'app', appId: 'app:2' }, { deviceId: IMPORTED, bundleId: 'com.mykynk.pati' });
    expect(metricsStore.series.size).toBe(3);

    handleServerMessage({ type: 'batch', removedDevices: [IMPORTED] });

    const hub = useHub.getState();
    expect(Object.keys(hub.devices)).toEqual([PIXEL]);
    expect(Object.keys(hub.apps)).toEqual(['app:1']);
    expect(hub.processes[IMPORTED]).toBeUndefined();
    expect(hub.processes[PIXEL]?.[4242]?.name).toBe('com.mykynk.pati');
    expect([...metricsStore.series.values()].map((s) => s.deviceId)).toEqual([PIXEL]);
    // The app scope pointed at a session of the removed device → back to "all devices".
    expect(useScopeStore.getState().scope).toEqual({ kind: 'all' });
  });

  it('follows the hub’s clear("all") sequence: `cleared` first, then the removable devices in a batch', () => {
    connect([device(PIXEL), device(IMPORTED, { state: 'disconnected' }), device('desktop', { platform: 'other', kind: 'virtual', name: 'Desktop', connection: 'local' })], [app('app:1', PIXEL)]);
    handleServerMessage({ type: 'batch', logs: [log(), log({ deviceId: IMPORTED }), log({ kind: 'marker', deviceId: '' })] });
    expect(logStore.size).toBe(3);
    setScope({ kind: 'device', deviceId: 'desktop' });

    handleServerMessage({ type: 'cleared', target: 'all' });
    expect(logStore.size).toBe(0);
    expect(networkStore.size).toBe(0);
    // Devices are still there until the server's next batch removes them.
    expect(Object.keys(useHub.getState().devices)).toHaveLength(3);

    handleServerMessage({ type: 'batch', removedDevices: [IMPORTED, 'desktop'], apps: [app('app:1', PIXEL)] });
    expect(Object.keys(useHub.getState().devices)).toEqual([PIXEL]);
    expect(useScopeStore.getState().scope).toEqual({ kind: 'all' });
  });

  it('a scoped clear keeps other devices’ rows and global markers (same predicate as the hub)', () => {
    connect([device(PIXEL), device(IMPORTED, { state: 'disconnected' })], [app('app:1', PIXEL)]);
    handleServerMessage({ type: 'batch', logs: [log(), log({ deviceId: IMPORTED }), log({ kind: 'marker', deviceId: '' }), log({ appId: 'app:1' })] });
    handleServerMessage({ type: 'cleared', target: 'logs', deviceId: PIXEL });
    expect(logStore.entries.map((e) => e.deviceId)).toEqual([IMPORTED, '']);
  });

  // Same lines and expectations as the hub's (packages/server/test/hub/hub.scopedClear.test.ts).
  const PATI = 'com.mykynk.pati';
  const crashRecord = (message: string) =>
    log({ message, level: 'fatal', kind: 'crash', origin: 'dropbox', process: PATI, data: { origin: 'dropbox', package: PATI, previousLaunch: true, pid: 7001 } });

  it('an app’s clear (device + bundle id) removes the device lines its scope shows, not other apps’ or global markers', () => {
    connect([device(PIXEL), device(IMPORTED, { state: 'disconnected' })], [app('app:1', PIXEL)]);
    handleServerMessage({
      type: 'batch',
      logs: [
        log({ message: 'startup', pid: 4242, process: PATI }),
        crashRecord('crashed earlier'),
        log({ message: 'sdk', appId: 'app:1' }),
        log({ message: 'push', pid: 9100, process: `${PATI}:push` }),
        log({ message: 'kumbara', pid: 5000, process: 'com.mykynk.kumbara' }),
        log({ message: 'restarted', source: 'system', code: 'logs.restarted' }),
        log({ message: 'pixel marker', source: 'system', kind: 'marker' }),
        log({ message: 'global marker', source: 'system', kind: 'marker', deviceId: '' }),
        log({ message: 'imported marker', source: 'system', kind: 'marker', deviceId: IMPORTED }),
        log({ message: 'imported', deviceId: IMPORTED, pid: 4242, process: PATI }),
      ],
    });
    handleServerMessage({ type: 'cleared', target: 'logs', deviceId: PIXEL, bundleId: PATI });
    expect(logStore.entries.map((e) => e.message)).toEqual(['kumbara', 'global marker', 'imported marker', 'imported']);
  });

  it('a session’s clear (exact scope) removes the lines of its own process, not an earlier run’s', () => {
    connect([device(PIXEL)], [app('app:1', PIXEL)]);
    handleServerMessage({
      type: 'batch',
      logs: [log({ message: 'earlier run', pid: 7001, process: PATI }), crashRecord('crashed earlier'), log({ message: 'this run', pid: 4242, process: PATI }), log({ message: 'sdk', appId: 'app:1' })],
    });
    handleServerMessage({ type: 'cleared', target: 'logs', deviceId: PIXEL, appId: 'app:1' });
    expect(logStore.entries.map((e) => e.message)).toEqual(['earlier run', 'crashed earlier']);
  });
});

describe('sendCommandDetailed', () => {
  beforeEach(() => __resetCommandsForTests());
  afterEach(() => __resetCommandsForTests());

  it('resolves with the reply data and the success code', async () => {
    const sent: UiToServer[] = [];
    setCommandTransport({ isOpen: () => true, send: (m) => (sent.push(m), true) });
    const detailed = sendCommandDetailed({ name: 'device.action', deviceId: PIXEL, action: 'screenshot' });
    const plain = sendCommand({ name: 'device.action', deviceId: PIXEL, action: 'screenshot' });
    const data = { url: '/api/files/s.png', file: '/tmp/s.png', width: 1080, height: 2400 };
    handleReply({ type: 'reply', requestId: sent[0]!.requestId, ok: true, data, code: 'action.screenshot.saved' });
    handleReply({ type: 'reply', requestId: sent[1]!.requestId, ok: true, data });
    await expect(detailed).resolves.toEqual({ data, code: 'action.screenshot.saved' });
    await expect(plain).resolves.toEqual(data);
  });
});

describe('REST helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('importSession labels the import with the file name (?name=)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ deviceIds: ['import:3'] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['{"format":"durbun-session"}'], 'pati ödeme 2026-11-02.durbun.json', { type: 'application/json' });
    await expect(importSession(file)).resolves.toEqual({ deviceIds: ['import:3'] });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/import?name=pati%20%C3%B6deme%202026-11-02.durbun.json');
    await importSession('{}', { name: 'kayıt.json' });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/import?name=kay%C4%B1t.json');
    const ac = new AbortController();
    await importSession({ format: 'durbun-session' } as never, ac.signal);
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/import');
    expect(fetchMock.mock.calls[2]![1]?.signal).toBe(ac.signal);
    expect(importUrl('  ')).toBe('/api/import');
  });

  it('importSession rejects with the server’s code', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Not a Dürbün session file (format is not "durbun-session")', code: 'import.invalid' }), { status: 400 }));
    const err = (await importSession('{}', { name: 'x.json' }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('import.invalid');
    expect(err.status).toBe(400);
  });

  it('upload keeps the server error code', async () => {
    class FakeXhr {
      status = 413;
      statusText = 'Payload Too Large';
      responseText = JSON.stringify({ error: 'File is too large (limit 2 GB)', code: 'upload.tooLarge' });
      upload = { onprogress: null as unknown };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(): void {}
      setRequestHeader(): void {}
      send(): void {
        queueMicrotask(() => this.onload?.());
      }
      abort(): void {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const err = (await upload(new Blob(['x']), { name: 'app.apk' }).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 413, code: 'upload.tooLarge', message: 'File is too large (limit 2 GB)' });
  });
});
