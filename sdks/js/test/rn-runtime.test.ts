/**
 * React Native paths, with React Native's globals faked: `navigator.product`, the `react-native` module (old and
 * new architecture), RN-style Blobs without `arrayBuffer()` read through `FileReader`, and the dev-only
 * built-in actions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WsClient from 'ws';
import { builtInActions } from '../src/actions.js';
import { __setReactNativeModuleForTests, describeEnvironment, rnScriptUrl } from '../src/env.js';
import { Durbun } from '../src/index.js';
import { FakeDesktop, waitFor } from './helpers/fakeDesktop.js';
import { BINARY, USERS_JSON, startHttpServer, type TestServer } from './helpers/httpServer.js';
import { RnXHR } from './helpers/xhrPolyfill.js';

const g = globalThis as Record<string, unknown>;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const realFileReader = g.FileReader;
let desktop: FakeDesktop | undefined;
let server: TestServer;

beforeAll(async () => {
  server = await startHttpServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  Durbun.stop();
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  __setReactNativeModuleForTests(undefined);
  delete g.XMLHttpRequest;
  delete g.__DEV__;
  g.FileReader = realFileReader;
  await desktop?.close();
  desktop = undefined;
});

const SCRIPT_URL = 'http://localhost:8081/index.bundle?platform=android&dev=true&app=com.example.shop';

function pretendRN(rn: Record<string, unknown>) {
  Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true, writable: true });
  __setReactNativeModuleForTests({
    Platform: { OS: 'android', Version: 35, constants: { Model: 'Pixel 8', Manufacturer: 'Google', Release: '15', Fingerprint: 'google/shiba/shiba:15/user/release-keys' } },
    AppRegistry: { getAppKeys: () => ['Shop'] },
    ...rn,
  });
}

describe('new architecture (bridgeless) module lookup', () => {
  it('reads the bundle URL from SourceCode through TurboModuleRegistry when NativeModules has no entry', () => {
    const get = vi.fn((name: string) => (name === 'SourceCode' ? { getConstants: () => ({ scriptURL: SCRIPT_URL }) } : null));
    pretendRN({ NativeModules: {}, TurboModuleRegistry: { get } });
    expect(rnScriptUrl()).toBe(SCRIPT_URL);
    expect(describeEnvironment({}, 'react-native').app.id).toBe('com.example.shop');
    expect(get).toHaveBeenCalledWith('SourceCode');
  });

  it('old architecture: NativeModules.SourceCode with scriptURL or getConstants()', () => {
    pretendRN({ NativeModules: { SourceCode: { scriptURL: SCRIPT_URL } } });
    expect(rnScriptUrl()).toBe(SCRIPT_URL);
    pretendRN({ NativeModules: { SourceCode: { getConstants: () => ({ scriptURL: SCRIPT_URL }) } } });
    expect(rnScriptUrl()).toBe(SCRIPT_URL);
  });

  it('a throwing registry is ignored', () => {
    pretendRN({ NativeModules: {}, TurboModuleRegistry: { get: () => { throw new Error('not registered'); } } });
    expect(rnScriptUrl()).toBeUndefined();
  });
});

describe('built-in React Native actions', () => {
  function devModules(where: 'legacy' | 'turbo') {
    const native = {
      DevSettings: { toggleElementInspector: vi.fn(), reload: vi.fn() },
      DevMenu: { show: vi.fn() },
    };
    const js = { DevSettings: { reload: vi.fn(), openDebugger: vi.fn() } };
    pretendRN({
      ...js,
      NativeModules: where === 'legacy' ? native : {},
      TurboModuleRegistry: { get: (name: string) => (where === 'turbo' ? (native as Record<string, unknown>)[name] ?? null : null) },
    });
    return { native, js };
  }

  it.each(['legacy', 'turbo'] as const)('%s modules: reload, dev menu, element inspector, debugger', async (where) => {
    const { native, js } = devModules(where);
    const actions = builtInActions('react-native');
    expect(actions.map((a) => a.descriptor.id)).toEqual(['rn.reload', 'rn.devMenu', 'rn.elementInspector', 'rn.openDebugger']);
    await actions.find((a) => a.descriptor.id === 'rn.elementInspector')!.handler({});
    await actions.find((a) => a.descriptor.id === 'rn.openDebugger')!.handler({});
    await actions.find((a) => a.descriptor.id === 'rn.devMenu')!.handler({});
    expect(native.DevSettings.toggleElementInspector).toHaveBeenCalledTimes(1);
    expect(js.DevSettings.openDebugger).toHaveBeenCalledTimes(1);
    expect(native.DevMenu.show).toHaveBeenCalledTimes(1);
  });

  it('only what the runtime has, and nothing in release builds', () => {
    pretendRN({ NativeModules: {} });
    expect(builtInActions('react-native')).toEqual([]);
    devModules('legacy');
    g.__DEV__ = false;
    expect(builtInActions('react-native')).toEqual([]);
  });

  it('run from the desktop', async () => {
    const { native } = devModules('turbo');
    desktop = await FakeDesktop.start();
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureNetwork: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');
    const hello = desktop.messages('hello')[0];
    expect(hello.actions.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining(['rn.elementInspector', 'rn.openDebugger']));
    desktop.broadcast({ type: 'command', id: 'c1', name: 'rn.elementInspector' });
    expect(await desktop.waitForMessage((m) => m.type === 'command.result' && m.id === 'c1')).toMatchObject({ ok: true });
    expect(native.DevSettings.toggleElementInspector).toHaveBeenCalledTimes(1);
  });
});

/* ────────────────────────────── Blob responses (what React Native's fetch asks XHR for) ────────────────────────────── */

/** React Native's Blob: holds a native blob id; no arrayBuffer(), read only through FileReader. */
class RnBlob {
  constructor(
    readonly _data: Buffer,
    readonly type: string,
  ) {}
  get size(): number {
    return this._data.length;
  }
  slice(start = 0, end = this._data.length): RnBlob {
    return new RnBlob(this._data.subarray(start, end), this.type);
  }
}

/** RN XHR whose `blob` responses are RnBlobs, as whatwg-fetch in React Native receives them. */
class RnBlobXHR extends RnXHR {
  override get response(): unknown {
    if (this._responseType === 'blob' && this.readyState === 4 && this._response instanceof Buffer) return new RnBlob(this._response, this._contentType || '');
    return super.response;
  }
}

function rnFileReader(calls: string[]) {
  return class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsText(blob: RnBlob) {
      calls.push('readAsText');
      setTimeout(() => {
        this.result = blob._data.toString('utf8');
        this.onload?.();
      }, 0);
    }
    readAsDataURL(blob: RnBlob) {
      calls.push('readAsDataURL');
      setTimeout(() => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${blob._data.toString('base64')}`;
        this.onload?.();
      }, 0);
    }
  };
}

function getBlob(url: string): Promise<RnBlobXHR> {
  return new Promise((resolve) => {
    const xhr = new (g.XMLHttpRequest as typeof RnBlobXHR)();
    xhr.onloadend = () => resolve(xhr);
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.send(null);
  });
}

describe('React Native Blob responses through the XHR patch', () => {
  it('JSON is decoded by FileReader.readAsText, binary is passed through from the data URL', async () => {
    const calls: string[] = [];
    pretendRN({ NativeModules: { SourceCode: { scriptURL: SCRIPT_URL } } });
    g.FileReader = rnFileReader(calls);
    g.XMLHttpRequest = RnBlobXHR;
    desktop = await FakeDesktop.start();
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');

    const json = await getBlob(`${server.url}/json?rn=1`);
    expect(json.response).toBeInstanceOf(RnBlob);
    const png = await getBlob(`${server.url}/binary?rn=2`);
    expect((png.response as RnBlob).size).toBe(256);

    const done = (part: string) =>
      desktop!.waitForMessage((m) => m.type === 'net.response' && desktop!.messages('net.request').some((r) => r.id === m.id && r.url.includes(part)));
    expect((await done('rn=1')).body).toEqual({ encoding: 'utf8', data: USERS_JSON, size: Buffer.byteLength(USERS_JSON) });
    expect((await done('rn=2')).body).toEqual({ encoding: 'base64', data: BINARY.toString('base64'), size: 256 });
    expect(calls).toEqual(['readAsText', 'readAsDataURL']);
  });

  it('with no desktop for a while, Blobs are not read at all (size only)', async () => {
    const calls: string[] = [];
    pretendRN({ NativeModules: { SourceCode: { scriptURL: SCRIPT_URL } } });
    g.FileReader = rnFileReader(calls);
    g.XMLHttpRequest = RnBlobXHR;
    const { DurbunClient } = await import('../src/client.js');
    const { DEFAULT_TIMING } = await import('../src/connection.js');
    const { closedPort } = await import('./helpers/httpServer.js');
    const client = new DurbunClient(
      { host: '127.0.0.1', port: await closedPort(), captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient as never },
      { ...DEFAULT_TIMING, connectHintMs: 60_000, noDesktopGraceMs: 0 },
    );
    client.start();
    try {
      await getBlob(`${server.url}/json?rn=3`);
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual([]);
    } finally {
      client.stop();
    }
  });
});
