/** A fatal JS error is kept in a store until the desktop has it, and sent on the next launch otherwise. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import WsClient from 'ws';
import { DurbunClient } from '../src/client.js';
import { DEFAULT_TIMING } from '../src/connection.js';
import { CRASH_STORAGE_KEY, MAX_STORED_CRASHES, parseStoredCrashes, type DurbunStorage } from '../src/crashStore.js';
import { __setReactNativeModuleForTests } from '../src/env.js';
import type { DurbunOptions } from '../src/options.js';
import { FakeDesktop, sleep, waitFor } from './helpers/fakeDesktop.js';
import { closedPort } from './helpers/httpServer.js';

const g = globalThis as Record<string, unknown>;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let clients: DurbunClient[] = [];
let desktop: FakeDesktop | undefined;

afterEach(async () => {
  for (const c of clients) c.stop();
  clients = [];
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  __setReactNativeModuleForTests(undefined);
  delete g.ErrorUtils;
  await desktop?.close();
  desktop = undefined;
  vi.restoreAllMocks();
});

function pretendRN(os: 'android' | 'ios', extra: Record<string, unknown> = {}) {
  Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true, writable: true });
  __setReactNativeModuleForTests({
    Platform: { OS: os, Version: os === 'android' ? 35 : '18.1', constants: os === 'android' ? { Model: 'Pixel 8' } : { osVersion: '18.1' } },
    NativeModules: { SourceCode: { scriptURL: `http://localhost:8081/index.bundle?platform=${os}&app=com.example.app` } },
    AppRegistry: { getAppKeys: () => ['App'] },
    ...extra,
  });
}

/** React Native's global error handler; the previous one stands for RN's own (red box / crash). */
function fakeErrorUtils() {
  const previous = vi.fn();
  const eu = {
    handler: previous as unknown as (e: unknown, fatal?: boolean) => void,
    setGlobalHandler(h: (e: unknown, fatal?: boolean) => void) {
      this.handler = h;
    },
    getGlobalHandler() {
      return this.handler;
    },
  };
  g.ErrorUtils = eu;
  return { eu, previous };
}

function memoryStorage(async = false): DurbunStorage & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>();
  const wrap = <T>(v: T) => (async ? Promise.resolve(v) : v);
  const store = {
    map,
    writes: 0,
    getItem: (k: string) => wrap(map.get(k) ?? null),
    setItem: (k: string, v: string) => {
      store.writes++;
      map.set(k, v);
      return wrap(undefined);
    },
    removeItem: (k: string) => {
      map.delete(k);
      return wrap(undefined);
    },
  };
  return store as never;
}

function client(options: DurbunOptions): DurbunClient {
  const c = new DurbunClient(
    { host: '127.0.0.1', captureConsole: false, captureMetrics: false, captureNetwork: false, WebSocket: WsClient as never, ...options },
    { ...DEFAULT_TIMING, connectHintMs: 60_000, crashCheckMs: 30 },
  );
  clients.push(c);
  c.start();
  return c;
}

/** A launch that crashes before any desktop is reached; the process "dies" (stop) right after. */
async function crashingLaunch(options: DurbunOptions, error: unknown = new TypeError("undefined is not an object (evaluating 'user.name')")) {
  const { eu, previous } = fakeErrorUtils();
  const c = client({ port: await closedPort(), ...options });
  eu.getGlobalHandler()(error, true);
  expect(previous).toHaveBeenCalledWith(error, true);
  c.stop();
  delete g.ErrorUtils;
}

describe('crash of an earlier launch', () => {
  it('is stored at once and sent on the next launch like the native SDKs report it', async () => {
    pretendRN('android');
    const storage = memoryStorage();
    await crashingLaunch({ crashStorage: storage });
    const stored = parseStoredCrashes(storage.map.get(CRASH_STORAGE_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ message: "Uncaught TypeError: undefined is not an object (evaluating 'user.name')", tag: 'uncaught' });

    fakeErrorUtils();
    desktop = await FakeDesktop.start();
    client({ port: desktop.port, crashStorage: storage });
    const row = await desktop.waitForMessage((m) => m.type === 'log' && m.kind === 'crash');
    expect(row).toMatchObject({
      level: 'fatal',
      tag: 'uncaught',
      kind: 'crash',
      message: "Previous launch crashed — Uncaught TypeError: undefined is not an object (evaluating 'user.name')",
      ts: stored[0].ts,
      data: { previousLaunch: true, crashedAt: stored[0].ts },
      error: { type: 'TypeError', message: "undefined is not an object (evaluating 'user.name')" },
    });
    expect(row.error.stack).toContain('TypeError');
    // Delivered: the store is cleared, a third launch sends nothing.
    await waitFor(() => !storage.map.has(CRASH_STORAGE_KEY), 3_000, 'store cleared');
  });

  it('works with an async store (AsyncStorage)', async () => {
    pretendRN('android');
    const storage = memoryStorage(true);
    await crashingLaunch({ crashStorage: storage }, 'thrown string');
    await sleep(5);
    expect(storage.map.has(CRASH_STORAGE_KEY)).toBe(true);
    desktop = await FakeDesktop.start();
    client({ port: desktop.port, crashStorage: storage });
    const row = await desktop.waitForMessage((m) => m.type === 'log' && m.kind === 'crash');
    expect(row.message).toBe('Previous launch crashed — Uncaught: thrown string');
    await waitFor(() => !storage.map.has(CRASH_STORAGE_KEY), 3_000, 'store cleared');
  });

  it("uses React Native's Settings on iOS when no store is given", async () => {
    const values: Record<string, unknown> = {};
    const settings = {
      get: (k: string) => values[k],
      set: (v: Record<string, unknown>) => {
        for (const [k, val] of Object.entries(v)) {
          if (val === null) delete values[k];
          else values[k] = val;
        }
      },
    };
    pretendRN('ios', { Settings: settings });
    await crashingLaunch({});
    expect(typeof values[CRASH_STORAGE_KEY]).toBe('string');
    desktop = await FakeDesktop.start();
    client({ port: desktop.port });
    await desktop.waitForMessage((m) => m.type === 'log' && m.kind === 'crash' && m.data?.previousLaunch === true);
    await waitFor(() => !(CRASH_STORAGE_KEY in values), 3_000, 'settings cleared');
  });

  it('dev build: a crash sent live is not stored (the app keeps running behind the red box)', async () => {
    pretendRN('android');
    const storage = memoryStorage();
    const { eu } = fakeErrorUtils();
    desktop = await FakeDesktop.start();
    client({ port: desktop.port, crashStorage: storage });
    await waitFor(() => clients[0].isConnected, 5_000, 'connection');
    eu.getGlobalHandler()(new Error('dev red box'), true);
    await desktop.waitForMessage((m) => m.type === 'log' && m.kind === 'crash');
    expect(storage.writes).toBe(0);
  });

  it('release build: a crash sent live is stored, then dropped once the app outlived it', async () => {
    g.__DEV__ = false;
    try {
      pretendRN('android');
      const storage = memoryStorage();
      const { eu } = fakeErrorUtils();
      desktop = await FakeDesktop.start();
      client({ port: desktop.port, crashStorage: storage });
      await waitFor(() => clients[0].isConnected, 5_000, 'connection');
      eu.getGlobalHandler()(new Error('release crash'), true);
      expect(storage.map.has(CRASH_STORAGE_KEY)).toBe(true);
      await desktop.waitForMessage((m) => m.type === 'log' && m.kind === 'crash');
      await waitFor(() => !storage.map.has(CRASH_STORAGE_KEY), 3_000, 'store cleared');
      clients[0].stop();
      const before = desktop.logs().length;
      client({ port: desktop.port, crashStorage: storage });
      await waitFor(() => desktop!.messages('hello').length >= 2, 5_000, 'second hello');
      await sleep(100);
      expect(desktop.logs().length).toBe(before);
    } finally {
      delete g.__DEV__;
    }
  });

  it('non-fatal errors are not stored', async () => {
    pretendRN('android');
    const storage = memoryStorage();
    const { eu } = fakeErrorUtils();
    client({ port: await closedPort(), crashStorage: storage });
    eu.getGlobalHandler()(new Error('soft'), false);
    expect(storage.writes).toBe(0);
  });

  it('keeps the last crashes only, with long texts cut', async () => {
    pretendRN('android');
    const storage = memoryStorage();
    for (let i = 0; i < 5; i++) {
      const e = new Error(`crash ${i} ` + 'x'.repeat(5_000));
      e.stack = 'Error: crash\n' + '    at frame (index.bundle:1:1)\n'.repeat(2_000);
      await crashingLaunch({ crashStorage: storage }, e);
    }
    const stored = parseStoredCrashes(storage.map.get(CRASH_STORAGE_KEY));
    expect(stored).toHaveLength(MAX_STORED_CRASHES);
    expect(stored.map((c) => c.message.slice(0, 15))).toEqual(['Uncaught Error:', 'Uncaught Error:', 'Uncaught Error:']);
    expect(stored[2].error!.message!.startsWith('crash 4')).toBe(true);
    expect(storage.map.get(CRASH_STORAGE_KEY)!.length).toBeLessThan(80_000);
  });

  it('Android without a store, crashStorage: false, or a broken store: the crash is still reported, nothing breaks', async () => {
    pretendRN('android');
    await crashingLaunch({});
    const set = vi.fn();
    pretendRN('ios', { Settings: { get: () => undefined, set } });
    await crashingLaunch({ crashStorage: false });
    expect(set).not.toHaveBeenCalled();
    const broken: DurbunStorage = {
      getItem: () => {
        throw new Error('no disk');
      },
      setItem: () => Promise.reject(new Error('quota')),
    };
    pretendRN('android');
    const { eu, previous } = fakeErrorUtils();
    desktop = await FakeDesktop.start();
    client({ port: desktop.port, crashStorage: broken });
    await waitFor(() => clients.at(-1)!.isConnected, 5_000, 'connection');
    eu.getGlobalHandler()(new Error('boom'), true);
    expect(previous).toHaveBeenCalledTimes(1);
    await desktop.waitForMessage((m) => m.type === 'log' && m.message === 'Uncaught Error: boom');
  });

  it('a stored value that is not ours is ignored', async () => {
    pretendRN('android');
    const storage = memoryStorage();
    storage.map.set(CRASH_STORAGE_KEY, '{not json');
    fakeErrorUtils();
    desktop = await FakeDesktop.start();
    client({ port: desktop.port, crashStorage: storage });
    await waitFor(() => clients[0].isConnected, 5_000, 'connection');
    await sleep(100);
    expect(desktop.logs()).toHaveLength(0);
  });
});
