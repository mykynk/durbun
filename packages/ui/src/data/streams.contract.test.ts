// @vitest-environment node
/**
 * Against the REAL server (real hub, HTTP app on an ephemeral port): a WebSocket entry's counts reach the window
 * through the normal sync, its messages are fetched after the newest seq held, dropped ones show as gaps, and a
 * new server run forgets what the window held.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, STREAM_HEAD_KEPT, type ServerToUi } from '@durbun/protocol';
import { handleServerMessage } from './dispatch';
import { logStore } from './logStore';
import { networkStore } from './networkStore';
import { forgetResume, resumeQuery } from './resume';
import { hubActions } from './stores/hub';
import { streamGaps, streamMessages } from './streamMessages';
import { getStreamMessages } from './api';
import { __resetCommandsForTests } from './commands';

interface Hub {
  dispose(): void;
  upsertDevice(d: unknown): void;
  registerApp(a: unknown): { id: string };
  netRequest(appId: string, msg: unknown): void;
  netResponse(appId: string, msg: unknown): void;
  netStream(appId: string, msg: unknown): void;
}
interface UiClient {
  messages: ServerToUi[];
  synced(): Promise<void>;
  close(): void;
}
interface TestApp {
  port: number;
  base: string;
  close(): Promise<void>;
}
const SERVER = new URL('../../../server/', import.meta.url).pathname;
const load = <T>(file: string): Promise<T> => import(/* @vite-ignore */ `${SERVER}${file}`) as Promise<T>;
const { createHub } = await load<{ createHub(o: unknown): Hub }>('src/hub/index.ts');
const { silentLogger } = await load<{ silentLogger: unknown }>('src/util/logger.ts');
const { MAX_STREAM_MESSAGES } = await load<{ MAX_STREAM_MESSAGES: number }>('src/hub/streams.ts');
const { startTestApp, connectUi } = await load<{
  startTestApp(o: unknown): Promise<TestApp>;
  connectUi(port: number, headers?: Record<string, string>, query?: string): Promise<UiClient>;
}>('test/http/fakes.ts');

const PHONE = 'android:STREAM1';
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
  streamMessages.reset();
  hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] });
  __resetCommandsForTests();
});

const settle = () => new Promise((r) => setTimeout(r, 150));

async function start(): Promise<{ appId: string; entryId: string }> {
  hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
  t = await startTestApp({ hub });
  const realFetch = globalThis.fetch;
  // The data layer fetches same-origin paths ("/api/…"): point them at the test server.
  vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? `${t!.base}${input}` : input, init)) as typeof fetch);
  hub.upsertDevice({ id: PHONE, platform: 'android', kind: 'physical', name: 'Pixel 8', connection: 'usb', state: 'online', logs: { status: 'streaming', via: 'logcat' }, actions: [], firstSeen: 1, lastSeen: 1 });
  const appId = hub.registerApp({
    sessionKey: 's1',
    deviceId: PHONE,
    sdk: { name: 'durbun', version: '0.3.0', platform: 'android' },
    app: { id: 'com.example.chat', name: 'Chat', pid: 4001 },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: Date.now(),
    capabilities: ['logs', 'network', 'streams'],
    actions: [],
  }).id;
  hub.netRequest(appId, { type: 'net.request', id: 'ws1', ts: 1_000, method: 'GET', url: 'wss://chat.example.com/socket', headers: [], source: 'okhttp' });
  hub.netResponse(appId, { type: 'net.response', id: 'ws1', ts: 1_050, status: 101, headers: [] });
  return { appId, entryId: `${appId}:ws1` };
}

function send(appId: string, n: number, from = 0): void {
  for (let i = 0; i < n; i++) {
    const data = JSON.stringify({ n: from + i });
    hub!.netStream(appId, { type: 'net.ws', id: 'ws1', ts: 2_000 + from + i, dir: i % 2 ? 'out' : 'in', opcode: 'text', size: data.length, body: { encoding: 'utf8', data, size: data.length } });
  }
}

async function connect(): Promise<UiClient> {
  const c = await connectUi(t!.port, undefined, resumeQuery());
  clients.push(c);
  await c.synced();
  for (const m of c.messages) handleServerMessage(m);
  return c;
}

describe('real server: stream messages in the window', () => {
  it('the entry row carries the counts; messages arrive after the newest seq held, live ones on the next sync', async () => {
    const { appId, entryId } = await start();
    send(appId, 3);
    await settle();
    const c = await connect();
    expect(networkStore.get(entryId)?.stream).toMatchObject({ kind: 'websocket', state: 'open', count: 3, lastSeq: 3, openTs: 1_050 });

    expect(streamMessages.get(entryId).status).toBe('idle');
    await streamMessages.sync(entryId);
    expect(streamMessages.get(entryId)).toMatchObject({ status: 'ready', refreshing: false, stream: { count: 3 } });
    expect(streamMessages.get(entryId).messages.map((m) => m.seq)).toEqual([1, 2, 3]);

    // Live: the batch moves the row's lastSeq; the next sync fetches only what is new.
    const from = c.messages.length;
    send(appId, 2, 3);
    await settle();
    for (const m of c.messages.slice(from)) handleServerMessage(m);
    expect(networkStore.get(entryId)?.stream?.lastSeq).toBe(5);
    const calls: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      return inner(input, init);
    }) as typeof fetch);
    await streamMessages.sync(entryId);
    expect(calls).toEqual([`/api/network/${encodeURIComponent(entryId)}/messages?after=3&limit=1000`]);
    expect(streamMessages.get(entryId).messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(streamMessages.get(entryId).messages[4]).toMatchObject({ dir: 'out', type: 'text', body: { data: '{"n":4}' } });
  });

  it('messages the server dropped show as one gap after the first ones; pages are followed to the end', async () => {
    const { appId, entryId } = await start();
    const total = MAX_STREAM_MESSAGES + 300;
    send(appId, total);
    await settle();
    await connect();
    expect(networkStore.get(entryId)?.stream).toMatchObject({ count: total, dropped: 300 });
    await streamMessages.sync(entryId);
    const held = streamMessages.get(entryId).messages;
    expect(held).toHaveLength(MAX_STREAM_MESSAGES);
    expect(streamGaps(held)).toEqual([{ afterSeq: STREAM_HEAD_KEPT, count: 300 }]);
    expect(held.at(-1)!.seq).toBe(total);
  });

  it('a page through the API; a new server run forgets the window’s messages', async () => {
    const { appId, entryId } = await start();
    send(appId, 4);
    await settle();
    expect(await getStreamMessages(entryId, { after: 1, limit: 2 })).toMatchObject({ messages: [{ seq: 2 }, { seq: 3 }], more: true, stream: { count: 4 } });
    await connect();
    await streamMessages.sync(entryId);
    expect(streamMessages.get(entryId).messages).toHaveLength(4);
    forgetResume();
    await connect(); // not a resume: everything is replaced
    expect(streamMessages.get(entryId).status).toBe('idle');
  });
});
