import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, DeviceInfo, LogEntry, ServerToUi, UiToServer } from '@durbun/protocol';
import { DEFAULT_SETTINGS } from '@durbun/protocol';
import { CommandError, __resetCommandsForTests, failInFlightCommands, flushPendingCommands, handleReply, sendCommand, setCommandTransport } from '../data/commands';
import { handleServerMessage } from '../data/dispatch';
import { logStore } from '../data/logStore';
import { networkStore } from '../data/networkStore';
import { useConnection } from '../data/stores/connection';
import { useHub } from '../data/stores/hub';
import { useScopeStore, setScope } from '../data/stores/scope';
import { useMocks, useServerSettings } from '../data/stores/server';
import { onNotice } from '../data/events';

function fakeTransport(open = true) {
  const sent: UiToServer[] = [];
  const t = {
    open,
    sent,
    isOpen: () => t.open,
    send: (m: UiToServer) => {
      if (!t.open) return false;
      sent.push(m);
      return true;
    },
  };
  setCommandTransport(t);
  return t;
}

describe('sendCommand', () => {
  beforeEach(() => __resetCommandsForTests());
  afterEach(() => {
    vi.useRealTimers();
    __resetCommandsForTests();
  });

  it('resolves with the reply data', async () => {
    const t = fakeTransport();
    const p = sendCommand({ name: 'demo.set', enabled: true });
    expect(t.sent).toHaveLength(1);
    const { requestId } = t.sent[0]!;
    expect(handleReply({ type: 'reply', requestId, ok: true, data: { enabled: true } })).toBe(true);
    await expect(p).resolves.toEqual({ enabled: true });
  });

  it('rejects with the server error and code', async () => {
    const t = fakeTransport();
    const p = sendCommand({ name: 'vm.attach', input: 'nothing here' });
    handleReply({ type: 'reply', requestId: t.sent[0]!.requestId, ok: false, error: 'No VM service URL found', code: 'vm.attachFailed' });
    const err = (await p.catch((e: unknown) => e)) as CommandError;
    expect(err).toBeInstanceOf(CommandError);
    expect(err.code).toBe('vm.attachFailed');
    expect(err.command).toBe('vm.attach');
    expect(err.message).toBe('No VM service URL found');
  });

  it('queues while disconnected and sends on connect', async () => {
    const t = fakeTransport(false);
    const p = sendCommand({ name: 'clear', target: 'logs' });
    expect(t.sent).toHaveLength(0);
    t.open = true;
    flushPendingCommands();
    expect(t.sent).toHaveLength(1);
    handleReply({ type: 'reply', requestId: t.sent[0]!.requestId, ok: true, data: null });
    await expect(p).resolves.toBeNull();
  });

  it('times out with a local code', async () => {
    vi.useFakeTimers();
    fakeTransport();
    const p = sendCommand({ name: 'doctor.run' }, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toMatchObject({ code: 'command.timeout' });
  });

  it('fails in-flight commands when the socket drops, keeps queued ones', async () => {
    const t = fakeTransport();
    const inflight = sendCommand({ name: 'marker.add' });
    t.open = false;
    const queued = sendCommand({ name: 'marker.add', label: 'x' });
    failInFlightCommands();
    await expect(inflight).rejects.toMatchObject({ code: 'command.disconnected' });
    t.open = true;
    flushPendingCommands();
    expect(t.sent).toHaveLength(2);
    handleReply({ type: 'reply', requestId: t.sent[1]!.requestId, ok: true, data: { id: 1 } });
    await expect(queued).resolves.toEqual({ id: 1 });
  });

  it('supports aborting', async () => {
    fakeTransport();
    const ac = new AbortController();
    const p = sendCommand({ name: 'doctor.run' }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'command.aborted' });
  });
});

const PIXEL = 'android:R5CT20XK9QM';
let nextId = 1;
const log = (p: Partial<LogEntry> = {}): LogEntry => ({ id: nextId++, ts: 1, deviceId: PIXEL, source: 'device', level: 'info', tag: 't', message: 'm', ...p });

describe('dispatcher', () => {
  const device: DeviceInfo = { id: PIXEL, platform: 'android', kind: 'physical', name: 'Pixel 8', connection: 'usb', state: 'online', logs: { status: 'streaming' }, actions: [], firstSeen: 1, lastSeen: 1 };
  const app: AppSession = {
    id: 'app:2',
    sessionKey: 's',
    deviceId: PIXEL,
    sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter' },
    app: { name: 'Pati', id: 'com.mykynk.pati', pid: 12345 },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: 1,
    capabilities: [],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  };

  const hello: ServerToUi = {
    type: 'hello',
    server: { name: 'durbun', version: '0.1.0', protocol: 1, ports: { http: 9750, sdk: 9751 }, startedAt: 1, demo: false, lan: false, hostAddresses: [], dataDir: '/tmp', platform: 'darwin' },
    settings: { ...DEFAULT_SETTINGS, maxLogEntries: 1000 },
  };

  function connect(logCount = 3) {
    nextId = 1;
    handleServerMessage(hello);
    handleServerMessage({ type: 'snapshot', devices: [{ ...device }], apps: [{ ...app, capabilities: [], actions: [] }], network: [], mocks: [], drivers: [], processes: [], metrics: [], logCount });
  }

  it('hello → syncing, snapshot resets stores, history → live', () => {
    logStore.append([log({ id: 999 })]);
    connect(3);
    const liveBefore = logStore.liveReceived;
    expect(useConnection.getState().status).toBe('syncing');
    expect(logStore.size).toBe(0);
    expect(logStore.maxEntries).toBe(1000);
    expect(useServerSettings.getState().settings.maxLogEntries).toBe(1000);
    handleServerMessage({ type: 'history', logs: [log(), log()], done: false });
    expect(useConnection.getState().status).toBe('syncing');
    handleServerMessage({ type: 'history', logs: [log()], done: true });
    expect(useConnection.getState().status).toBe('live');
    expect(logStore.size).toBe(3);
    expect(useConnection.getState().historyReceived).toBe(3);
    expect(logStore.liveReceived).toBe(liveBefore); // history is not live ingest
  });

  it('applies batches and cleared events', () => {
    connect(0);
    expect(useConnection.getState().status).toBe('live');
    handleServerMessage({
      type: 'batch',
      logs: [log({ appId: 'app:2' }), log()],
      network: [{ id: 'app:2:1', appId: 'app:2', deviceId: PIXEL, source: 'dart:io', method: 'GET', url: 'https://a/b', host: 'a', path: '/b', startTs: 1, state: 'pending', requestHeaders: [], hasRequestBody: false, hasResponseBody: false }],
      apps: [{ ...app, connected: false, capabilities: [], actions: [] }],
    });
    expect(logStore.size).toBe(2);
    expect(networkStore.size).toBe(1);
    expect(useHub.getState().apps['app:2']?.connected).toBe(false);
    handleServerMessage({ type: 'cleared', target: 'logs', appId: 'app:2' });
    expect(logStore.size).toBe(1);
    handleServerMessage({ type: 'cleared', target: 'all' });
    expect(logStore.size).toBe(0);
    expect(networkStore.size).toBe(0);
  });

  it('stores mocks/settings/drivers and emits notices', () => {
    connect(0);
    const seen: string[] = [];
    const off = onNotice((n) => seen.push(n.message));
    handleServerMessage({ type: 'mocks', rules: [{ id: 'm1', enabled: true, method: '*', url: '/x', match: 'contains', action: { type: 'delay', delayMs: 10 }, createdAt: 1 }] });
    handleServerMessage({ type: 'drivers', drivers: [{ id: 'android', available: true, active: true }] });
    handleServerMessage({ type: 'notice', level: 'warn', message: 'Accept the USB debugging prompt', code: 'device.unauthorized' });
    off();
    expect(useMocks.getState().rules).toHaveLength(1);
    expect(useHub.getState().drivers[0]?.id).toBe('android');
    expect(seen).toEqual(['Accept the USB debugging prompt']);
  });

  it('keeps the scope valid across resyncs (re-resolves app sessions by bundle id)', () => {
    connect(0);
    setScope({ kind: 'app', appId: 'app:2' }, { deviceId: PIXEL, bundleId: 'com.mykynk.pati' });
    // Server restarted: the same app now has id app:7.
    handleServerMessage(hello);
    handleServerMessage({ type: 'snapshot', devices: [{ ...device }], apps: [{ ...app, id: 'app:7', capabilities: [], actions: [] }], network: [], mocks: [], drivers: [], processes: [], metrics: [], logCount: 0 });
    expect(useScopeStore.getState().scope).toEqual({ kind: 'app', appId: 'app:7' });
    // Device removed → back to all.
    setScope({ kind: 'device', deviceId: PIXEL });
    handleServerMessage({ type: 'batch', removedDevices: [PIXEL] });
    expect(useScopeStore.getState().scope).toEqual({ kind: 'all' });
  });

  it('a live batch while syncing means history is complete', () => {
    handleServerMessage(hello);
    handleServerMessage({ type: 'snapshot', devices: [], apps: [], network: [], mocks: [], drivers: [], processes: [], metrics: [], logCount: 10 });
    expect(useConnection.getState().status).toBe('syncing');
    handleServerMessage({ type: 'batch', logs: [log()] });
    expect(useConnection.getState().status).toBe('live');
  });
});
