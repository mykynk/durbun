// @vitest-environment node
/**
 * Reconnecting and store limits against the REAL server (real hub, HTTP app on an ephemeral port, fake drivers):
 * the window continues its copy instead of loading everything again, holds exactly what the server holds, and
 * shows the server's counts of what the limits deleted. A server that does not answer the resume query (the dev
 * mock, older servers) still gets a full sync.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MockRule, type ServerToUi } from '@durbun/protocol';
import { handleServerMessage } from './dispatch';
import { logStore } from './logStore';
import { networkStore } from './networkStore';
import { forgetResume, resumeEpoch, resumeQuery, withResumeQuery } from './resume';
import { compileScope, scopeEvictions } from './scope';
import { useConnection } from './stores/connection';
import { hubActions, useHub } from './stores/hub';
import { useStoreLimits } from './stores/limits';
import { resolveMocksConflict, saveMocks, setMocksFromServer, useMocks } from './stores/server';
import { __resetCommandsForTests, setCommandTransport, handleReply } from './commands';

interface Hub {
  dispose(): void;
  upsertDevice(d: unknown): void;
  registerApp(a: unknown): { id: string };
  pushDeviceLogs(deviceId: string, logs: unknown[]): void;
  netRequest(appId: string, msg: unknown): void;
  netResponse(appId: string, msg: unknown): void;
  getLogs(): { id: number }[];
  setSettings(s: unknown): void;
}
interface UiClient {
  messages: ServerToUi[];
  synced(): Promise<void>;
  close(): void;
}
interface TestApp {
  port: number;
  close(): Promise<void>;
}
const SERVER = new URL('../../../server/', import.meta.url).pathname;
const load = <T>(file: string): Promise<T> => import(/* @vite-ignore */ `${SERVER}${file}`) as Promise<T>;
const { createHub } = await load<{ createHub(o: unknown): Hub }>('src/hub/index.ts');
const { silentLogger } = await load<{ silentLogger: unknown }>('src/util/logger.ts');
const { startTestApp, connectUi } = await load<{
  startTestApp(o: unknown): Promise<TestApp>;
  connectUi(port: number, headers?: Record<string, string>, query?: string): Promise<UiClient>;
}>('test/http/fakes.ts');

const PHONE = 'android:RESUME1';
let t: TestApp | undefined;
let hub: Hub | undefined;
const clients: UiClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.close();
  hub?.dispose();
  t = hub = undefined;
  logStore.reset();
  networkStore.reset();
  forgetResume();
  useStoreLimits.setState({ limits: null, evictions: null });
  hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] });
  __resetCommandsForTests();
});

const line = (message: string) => ({ ts: Date.now(), level: 'info', tag: 't', process: 'com.example.shop', message });

async function start(settings: Record<string, unknown> = {}) {
  hub = createHub({ settings: { ...DEFAULT_SETTINGS, ...settings }, logger: silentLogger });
  t = await startTestApp({ hub });
  hub.upsertDevice({ id: PHONE, platform: 'android', kind: 'physical', name: 'Pixel 8', connection: 'usb', state: 'online', logs: { status: 'streaming', via: 'logcat' }, actions: [], firstSeen: 1, lastSeen: 1 });
  const app = hub.registerApp({ sessionKey: 's1', deviceId: PHONE, sdk: { name: 'durbun', version: '0.3.0', platform: 'flutter' }, app: { id: 'com.example.shop', name: 'Shop', pid: 4001 }, transport: 'adb-reverse', connected: true, connectedAt: Date.now(), capabilities: ['logs', 'network'], actions: [] });
  hub.pushDeviceLogs(PHONE, [line('first'), line('second')]);
  hub.netRequest(app.id, { type: 'net.request', id: 'r1', ts: Date.now(), method: 'GET', url: 'https://api.example.com/one', headers: [], source: 'dart:io' });
  await settle();
  return app.id;
}

const settle = () => new Promise((r) => setTimeout(r, 150));

/** Connect as the window would (with its resume query), apply every message of the sync, keep applying live ones. */
async function connect(): Promise<UiClient> {
  const c = await connectUi(t!.port, undefined, resumeQuery());
  clients.push(c);
  await c.synced();
  for (const m of c.messages) handleServerMessage(m);
  return c;
}

function apply(c: UiClient, from: number): void {
  for (const m of c.messages.slice(from)) handleServerMessage(m);
}

const messages = () => logStore.entries.map((e) => e.message);

describe('real server: resuming /ui', () => {
  it('a reconnect continues the copy: only newer lines and changed requests arrive, nothing twice', async () => {
    const appId = await start();
    const first = await connect();
    expect(useConnection.getState().resumed).toBe(false);
    expect(resumeEpoch()).toEqual(expect.any(String));
    expect(messages()).toEqual(expect.arrayContaining(['first', 'second']));
    const before = logStore.entries.length;
    first.close();

    // While away: new lines, the pending request ended, a new request.
    hub!.pushDeviceLogs(PHONE, [line('while away')]);
    hub!.netResponse(appId, { type: 'net.response', id: 'r1', ts: Date.now(), status: 503, headers: [] });
    hub!.netRequest(appId, { type: 'net.request', id: 'r2', ts: Date.now(), method: 'GET', url: 'https://api.example.com/two', headers: [], source: 'dart:io' });
    await settle();

    expect(withResumeQuery('ws://x/ui')).toMatch(/^ws:\/\/x\/ui\?epoch=.+&afterLogId=\d+&netSeq=\d+$/);
    const second = await connect();
    const snapshot = second.messages.find((m) => m.type === 'snapshot') as Extract<ServerToUi, { type: 'snapshot' }>;
    expect(snapshot.resumed).toBeDefined();
    expect(useConnection.getState().resumed).toBe(true);
    // Only the changed requests travelled; the window still holds both, with the outcome.
    expect(snapshot.network.map((n) => n.url)).toEqual(['https://api.example.com/one', 'https://api.example.com/two']);
    expect(networkStore.size).toBe(2);
    expect(networkStore.list()[0]!.status).toBe(503);
    // Lines: the old ones stayed, the new one arrived once; the request rows of r1 took the error level.
    expect(logStore.entries.length).toBeGreaterThan(before);
    expect(messages().filter((m) => m === 'while away')).toHaveLength(1);
    expect(messages().filter((m) => m === 'first')).toHaveLength(1);
    expect(logStore.entries.map((e) => e.id)).toEqual(hub!.getLogs().map((e) => e.id));
    expect(useConnection.getState().expectedLogCount).toBeLessThan(logStore.entries.length);
  });

  it('a restarted server (another epoch) replaces everything', async () => {
    await start();
    const first = await connect();
    first.close();
    // A server that never heard of this epoch.
    handleServerMessage({ type: 'snapshot', epoch: 'other.0', devices: [], apps: [], network: [], mocks: [], drivers: [], processes: [], metrics: [], logCount: 0 });
    expect(logStore.size).toBe(0);
    expect(resumeEpoch()).toBe('other.0');
  });

  it('a server without resume support (the dev mock) gets no query and a full sync resets the stores', async () => {
    await start();
    const first = await connect();
    first.close();
    expect(resumeQuery()).not.toBe('');
    handleServerMessage({ type: 'snapshot', devices: [], apps: [], network: [], mocks: [], drivers: [], processes: [], metrics: [], logCount: 0, resumed: { afterLogId: 1, networkIds: [] } });
    // `resumed` without our epoch is not trusted: everything was replaced.
    expect(logStore.size).toBe(0);
    expect(resumeQuery()).toBe('');
  });
});

describe('real server: limits and evictions', () => {
  it('the window learns the limits, holds exactly what the server holds and shows its counts per scope', async () => {
    await start({ maxLogEntries: 1_000 });
    const c = await connect();
    expect(useStoreLimits.getState().limits).toMatchObject({ maxLogEntries: 1_000, maxNetworkEntries: DEFAULT_SETTINGS.maxNetworkEntries });
    expect(logStore.maxEntries).toBe(1_000);

    const from = c.messages.length;
    hub!.pushDeviceLogs(PHONE, Array.from({ length: 1_500 }, (_, i) => line(`flood ${i}`)));
    await settle();
    apply(c, from);
    const ev = useStoreLimits.getState().evictions!;
    expect(ev.logs).toBeGreaterThan(0);
    expect(logStore.dropped).toBe(ev.logs);
    expect(logStore.entries.map((e) => e.id)).toEqual(hub!.getLogs().map((e) => e.id));

    const device = scopeEvictions(compileScope({ kind: 'device', deviceId: PHONE }, useHub.getState()), ev);
    expect(device).toMatchObject({ logs: ev.logs, approximate: false, logsByMemory: false });
    const other = scopeEvictions(compileScope({ kind: 'device', deviceId: 'android:OTHER' }, useHub.getState()), ev);
    expect(other.logs).toBe(0);
    // The device lines of the app's process count for the app scope.
    const app = Object.values(useHub.getState().apps)[0]!;
    expect(scopeEvictions(compileScope({ kind: 'app', appId: app.id }, useHub.getState()), ev).logs).toBe(ev.logs);
  });

  it('a smaller limit set elsewhere trims this window to what the server keeps', async () => {
    await start();
    const c = await connect();
    hub!.pushDeviceLogs(PHONE, Array.from({ length: 1_200 }, (_, i) => line(`more ${i}`)));
    await settle();
    apply(c, 0);
    const from = c.messages.length;
    hub!.setSettings({ ...DEFAULT_SETTINGS, maxLogEntries: 1_000 });
    await settle();
    apply(c, from);
    expect(logStore.entries.map((e) => e.id)).toEqual(hub!.getLogs().map((e) => e.id));
  });

  it('without server counts the scope note falls back to the window’s own trims', () => {
    const local = scopeEvictions(compileScope({ kind: 'all' }, useHub.getState()), null, { logs: 7, requests: 2 });
    expect(local).toEqual({ logs: 7, requests: 2, logsByMemory: false, approximate: true });
  });
});

describe('mock rules changed elsewhere', () => {
  const rule = (id: string): MockRule => ({ id, enabled: true, method: '*', url: '/x', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 1 });

  it('a refused save shows the server’s list, keeps mine for "save anyway" and sends the base revision', async () => {
    const sent: Record<string, unknown>[] = [];
    let answer: (requestId: string, cmd: Record<string, unknown>) => Extract<ServerToUi, { type: 'reply' }>;
    setCommandTransport({
      isOpen: () => true,
      send: (msg) => {
        sent.push(msg.command as unknown as Record<string, unknown>);
        queueMicrotask(() => handleReply(answer(msg.requestId, msg.command as unknown as Record<string, unknown>)));
        return true;
      },
    });
    setMocksFromServer([rule('a')], 4);
    answer = (requestId) => ({ type: 'reply', requestId, ok: false, code: 'mocks.conflict', error: 'changed', data: { rules: [rule('theirs')], revision: 5 } });
    await expect(saveMocks([rule('a'), rule('mine')])).rejects.toMatchObject({ code: 'mocks.conflict' });
    expect(sent[0]).toMatchObject({ name: 'mocks.set', baseRevision: 4 });
    expect(useMocks.getState()).toMatchObject({ rules: [rule('theirs')], revision: 5, conflict: { attempted: [rule('a'), rule('mine')] } });

    answer = (requestId, cmd) => ({ type: 'reply', requestId, ok: true, data: cmd.rules });
    await resolveMocksConflict('overwrite');
    expect(sent[1]).not.toHaveProperty('baseRevision');
    expect(useMocks.getState()).toMatchObject({ rules: [rule('a'), rule('mine')], conflict: null });
  });
});
