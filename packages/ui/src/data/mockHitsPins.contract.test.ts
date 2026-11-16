// @vitest-environment node
/**
 * Against the REAL server (real hub, HTTP app on an ephemeral port): the server's mock rule hit counts reach the
 * window's store (snapshot + batches) and narrow to a scope; pinning a flow run through the data layer's API; the
 * cross-feature focus requests of the ui store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type FlowRun, type MockRule, type ServerToUi } from '@durbun/protocol';
import { handleServerMessage } from './dispatch';
import { logStore } from './logStore';
import { networkStore } from './networkStore';
import { forgetResume, resumeQuery } from './resume';
import { compileScope, scopeMockHits } from './scope';
import { hubActions, useHub } from './stores/hub';
import { useMockHits, setMockHitsFromSnapshot } from './stores/mockHits';
import { ui, useUi } from './stores/ui';
import { ApiError, clearFlowRunHistory, pinFlowRun } from './api';
import { __resetCommandsForTests } from './commands';

interface Hub {
  dispose(): void;
  upsertDevice(d: unknown): void;
  registerApp(a: unknown): { id: string };
  netRequest(appId: string, msg: unknown): void;
  netResponse(appId: string, msg: unknown): void;
  clear(target: string): void;
}
interface UiClient {
  messages: ServerToUi[];
  synced(): Promise<void>;
  close(): void;
}
interface TestApp {
  port: number;
  base: string;
  config: { setMocks(rules: MockRule[]): Promise<unknown> };
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

const PHONE = 'android:HITS1';
const TABLET = 'android:HITS2';
let t: TestApp | undefined;
let hub: Hub | undefined;
const clients: UiClient[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of clients.splice(0)) c.close();
  await t?.close();
  hub?.dispose();
  t = hub = undefined;
  logStore.reset();
  networkStore.reset();
  forgetResume();
  useMockHits.setState({ hits: null });
  hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] });
  __resetCommandsForTests();
});

const settle = () => new Promise((r) => setTimeout(r, 150));
const rule = (id: string): MockRule => ({ id, enabled: true, method: '*', url: '/x', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 1 });

function device(id: string, name: string) {
  return { id, platform: 'android', kind: 'physical', name, connection: 'usb', state: 'online', logs: { status: 'streaming', via: 'logcat' }, actions: [], firstSeen: 1, lastSeen: 1 };
}

function session(deviceId: string, key: string) {
  return hub!.registerApp({
    sessionKey: key,
    deviceId,
    sdk: { name: 'durbun', version: '0.3.0', platform: 'flutter' },
    app: { id: 'com.example.shop', name: 'Shop', pid: 4001 },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: Date.now(),
    capabilities: ['logs', 'network'],
    actions: [],
  }).id;
}

let n = 0;
function mocked(appId: string, ruleId: string): void {
  const id = `m${++n}`;
  hub!.netRequest(appId, { type: 'net.request', id, ts: Date.now(), method: 'GET', url: `https://api.example.com/${id}`, headers: [], source: 'dart:io' });
  hub!.netResponse(appId, { type: 'net.response', id, ts: Date.now(), status: 200, headers: [], mocked: true, mockRuleId: ruleId });
}

async function connect(): Promise<UiClient> {
  const c = await connectUi(t!.port, undefined, resumeQuery());
  clients.push(c);
  await c.synced();
  for (const m of c.messages) handleServerMessage(m);
  return c;
}

describe('real server: mock rule hit counts in the window', () => {
  it('the snapshot and later batches fill the store; a scope sums its own sessions; clearing requests keeps them', async () => {
    hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
    t = await startTestApp({ hub });
    await t.config.setMocks([rule('login'), rule('cart')]);
    hub.upsertDevice(device(PHONE, 'Pixel 8'));
    hub.upsertDevice(device(TABLET, 'Galaxy Tab'));
    const phone = session(PHONE, 's1');
    const tablet = session(TABLET, 's2');
    mocked(phone, 'login');
    mocked(phone, 'login');
    mocked(tablet, 'login');
    await settle();

    const c = await connect();
    expect(useMockHits.getState().hits).toMatchObject({ login: { count: 3 } });

    const from = c.messages.length;
    mocked(tablet, 'cart');
    await settle();
    for (const m of c.messages.slice(from)) handleServerMessage(m);
    const hits = useMockHits.getState().hits;
    expect(hits).toMatchObject({ login: { count: 3 }, cart: { count: 1 } });

    const hubState = useHub.getState();
    expect(scopeMockHits(compileScope({ kind: 'all' }, hubState), hits, hubState.apps)).toMatchObject({ login: { count: 3 }, cart: { count: 1 } });
    const onPhone = scopeMockHits(compileScope({ kind: 'device', deviceId: PHONE }, hubState), hits, hubState.apps)!;
    expect(onPhone.login!.count).toBe(2);
    expect(onPhone).not.toHaveProperty('cart');
    const onTablet = scopeMockHits(compileScope({ kind: 'app', appId: tablet }, hubState), hits, hubState.apps)!;
    expect(onTablet).toMatchObject({ login: { count: 1 }, cart: { count: 1 } });
    expect(onTablet.login!.lastTs).toBeGreaterThan(0);

    // Clearing the request list keeps the counts; a window opened afterwards gets the same numbers.
    hub.clear('network');
    await settle();
    useMockHits.setState({ hits: null });
    await connect();
    expect(networkStore.size).toBe(0);
    expect(useMockHits.getState().hits).toMatchObject({ login: { count: 3 }, cart: { count: 1 } });
  });

  it('a server that does not count leaves the store empty (the view keeps its own count)', () => {
    setMockHitsFromSnapshot({ login: { count: 2, lastTs: 5 } });
    expect(useMockHits.getState().hits).not.toBeNull();
    handleServerMessage({ type: 'snapshot', devices: [], apps: [], drivers: [], processes: [], deviceApps: [], network: [], metrics: [], mocks: [], logCount: 0 } as unknown as ServerToUi);
    expect(useMockHits.getState().hits).toBeNull();
    expect(scopeMockHits(compileScope({ kind: 'all' }, useHub.getState()), null, {})).toBeNull();
  });
});

describe('real server: pinning a flow run through the data layer', () => {
  it('pinFlowRun pins and unpins; clearFlowRunHistory says how many pinned runs stayed; errors carry code + params', async () => {
    t = await startTestApp({ flowsBackground: false });
    // The data layer fetches same-origin paths ("/api/…"): point them at the test server.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) =>
      realFetch(typeof input === 'string' && input.startsWith('/') ? `${t!.base}${input}` : input, init)) as typeof fetch);

    const flow = {
      format: 'durbun-flow',
      version: 1,
      id: 'login',
      name: 'Login',
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'note', type: 'output.note', params: { text: 'hi' } }],
      edges: [{ from: 'start', to: 'note' }],
    };
    const post = (url: string, body: unknown) => realFetch(`${t!.base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/api/flows', { flow })).status).toBe(201);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = (await (await post('/api/flows/login/run', {})).json()) as FlowRun;
      ids.push(run.id);
      for (let k = 0; k < 100; k++) {
        const r = (await (await realFetch(`${t.base}/api/flow-runs/${run.id}`)).json()) as FlowRun;
        if (r.status !== 'running') break;
        await new Promise((res) => setTimeout(res, 30));
      }
    }

    const header = await pinFlowRun(ids[0]!, true);
    expect(header).toMatchObject({ id: ids[0], pinned: true });
    expect(await clearFlowRunHistory('login')).toEqual({ removed: 1, keptPinned: 1 });
    expect((await pinFlowRun(ids[0]!, false)).pinned).toBeUndefined();

    const err = await pinFlowRun('zzz-000000', true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'flowRun.notFound' });
  });

  it('ApiError keeps the params of the error body', () => {
    const e = new ApiError(409, 'At most 50 runs can be pinned', 'flowRun.pinLimit', { error: 'x', code: 'flowRun.pinLimit', params: { max: 50, bad: { x: 1 } } });
    expect(e.params).toEqual({ max: 50 });
    expect(new ApiError(400, 'x').params).toBeUndefined();
  });
});

describe('ui focus requests', () => {
  it('focusLogTime / focusNetworkMockHits / newFlowFromRequests switch the tab and leave one request to consume', () => {
    ui.focusLogTime(1_700_000_000_000, { deviceId: PHONE, appId: 'app:1' });
    expect(useUi.getState().tab).toBe('logs');
    const log = useUi.getState().focus!;
    expect(log).toMatchObject({ kind: 'logTime', ts: 1_700_000_000_000, deviceId: PHONE, appId: 'app:1', reason: 'requestLineGone' });

    ui.focusNetworkMockHits('login');
    expect(useUi.getState().tab).toBe('network');
    const net = useUi.getState().focus!;
    expect(net).toMatchObject({ kind: 'networkMockHits', ruleId: 'login' });
    expect(net.seq).toBeGreaterThan(log.seq);
    ui.consumeFocus(log.seq); // stale: a newer request replaced it
    expect(useUi.getState().focus).toBe(net);

    ui.newFlowFromRequests(['a']);
    expect(useUi.getState().focus).toEqual({ kind: 'flowFromRequests', ids: ['a'], seq: expect.any(Number) });
    ui.newFlowFromRequests(['a', 'b'], { visibleIds: ['a', 'b', 'c'], filterLabel: 'POST · /login', from: 'network' });
    const flow = useUi.getState().focus!;
    expect(flow).toMatchObject({ kind: 'flowFromRequests', ids: ['a', 'b'], visibleIds: ['a', 'b', 'c'], filterLabel: 'POST · /login', from: 'network' });
    expect(useUi.getState().tab).toBe('flows');
    ui.consumeFocus(flow.seq);
    expect(useUi.getState().focus).toBeNull();

    ui.focusLogTime(Number.NaN);
    expect(useUi.getState().focus).toBeNull();
  });
});
