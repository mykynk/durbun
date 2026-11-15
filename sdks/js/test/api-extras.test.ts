/** Manual network reports, navigation events, the appearance action and the no-op entry. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WsClient from 'ws';
import { builtInActions } from '../src/actions.js';
import { __setReactNativeModuleForTests } from '../src/env.js';
import { Durbun } from '../src/index.js';
import { Durbun as Noop } from '../src/noop.js';
import { trackNavigation } from '../src/navigation.js';
import type { MockRule } from '../src/protocol.js';
import { FakeDesktop, waitFor } from './helpers/fakeDesktop.js';

let desktop: FakeDesktop | undefined;

afterEach(async () => {
  Durbun.stop();
  await desktop?.close();
  desktop = undefined;
  __setReactNativeModuleForTests(undefined);
});

async function start(mocks: MockRule[] = []) {
  desktop = await FakeDesktop.start({ mocks });
  Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, captureNetwork: false, WebSocket: WsClient });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

describe('Durbun.network (clients the SDK does not capture)', () => {
  it('reports a request and its response, with JSON bodies, headers and a source', async () => {
    const d = await start();
    const call = Durbun.network.begin({ method: 'post', url: 'https://api.example.com/upload', headers: { Authorization: 'Bearer x' }, body: { file: 'a.png' }, source: 'blob-util' });
    call.response({ status: 201, headers: [['Content-Type', 'application/json']], body: '{"ok":true}' });
    call.response({ status: 500 }); // only the first report counts
    const req = await d.waitForMessage((m) => m.type === 'net.request');
    expect(req).toMatchObject({ method: 'POST', url: 'https://api.example.com/upload', source: 'blob-util', headers: [['Authorization', 'Bearer x']] });
    expect(req.body).toMatchObject({ encoding: 'utf8', data: '{"file":"a.png"}' });
    const res = await d.waitForMessage((m) => m.type === 'net.response');
    expect(res).toMatchObject({ id: req.id, status: 201, statusText: 'Created', body: { data: '{"ok":true}' } });
    await d.barrier();
    expect(d.messages('net.response')).toHaveLength(1);
  });

  it('a file download reports only its size; errors and cancellations are reported too', async () => {
    const d = await start();
    Durbun.network.begin({ url: 'https://cdn.example.com/video.mp4', source: 'expo-file-system' }).response({ status: 200, bodySize: 52_428_800 });
    Durbun.network.begin({ url: 'https://api.example.com/a' }).error(new TypeError('Network request failed'));
    Durbun.network.begin({ url: 'https://api.example.com/b' }).error('cancelled by user', { cancelled: true });
    const res = await d.waitForMessage((m) => m.type === 'net.response');
    expect(res.body).toMatchObject({ size: 52_428_800, data: '' });
    await waitFor(() => d.messages('net.error').length === 2);
    expect(d.messages('net.error')).toEqual([
      expect.objectContaining({ error: 'TypeError: Network request failed' }),
      expect.objectContaining({ error: 'cancelled by user', cancelled: true }),
    ]);
  });

  it('findMock hands the rule to your own client; the answer is marked as mocked', async () => {
    const rule: MockRule = { id: 'r1', enabled: true, method: 'GET', url: '/flags', match: 'contains', createdAt: 0, action: { type: 'respond', status: 200, body: '{"beta":true}' } };
    const d = await start([rule]);
    const found = Durbun.network.findMock('get', 'https://api.example.com/flags');
    expect(found?.id).toBe('r1');
    expect(Durbun.network.findMock('GET', 'https://api.example.com/other')).toBeUndefined();
    Durbun.network.begin({ url: 'https://api.example.com/flags' }).response({ status: 200, body: '{"beta":true}', mockRuleId: found!.id });
    expect(await d.waitForMessage((m) => m.type === 'net.response')).toMatchObject({ mocked: true, mockRuleId: 'r1' });
  });

  it('before start (or with the SDK off) calls are harmless', () => {
    const call = Durbun.network.begin({ url: 'https://x.test' });
    expect(() => call.response({ status: 200 })).not.toThrow();
    expect(Durbun.network.findMock('GET', 'https://x.test')).toBeUndefined();
  });
});

describe('navigation events', () => {
  function fakeNavigation(initial?: string) {
    let route: { name: string; key: string } | undefined = initial ? { name: initial, key: `${initial}-1` } : undefined;
    const listeners: Array<() => void> = [];
    return {
      ref: {
        addListener: (_: 'state', cb: () => void) => {
          listeners.push(cb);
          return () => listeners.splice(listeners.indexOf(cb), 1);
        },
        getCurrentRoute: () => (route ? { ...route, params: { token: 'secret' } } : undefined),
        isReady: () => route !== undefined,
      },
      go(name: string, key = `${name}-1`) {
        route = { name, key };
        for (const l of listeners.slice()) l();
      },
      listeners,
    };
  }

  it('sends from/to on each screen change, never the params; the same screen pushed again counts', () => {
    const nav = fakeNavigation('Home');
    const emit = vi.fn();
    const stop = trackNavigation(nav.ref, emit);
    nav.go('Product');
    nav.go('Product'); // same key: a re-render, not a navigation
    nav.go('Product', 'Product-2');
    expect(emit.mock.calls).toEqual([
      ['navigation', { to: 'Home' }],
      ['navigation', { from: 'Home', to: 'Product' }],
      ['navigation', { from: 'Product', to: 'Product' }],
    ]);
    stop();
    expect(nav.listeners).toHaveLength(0);
  });

  it('a container that is not ready yet reports its first screen when it becomes ready; a useRef holder works', () => {
    const nav = fakeNavigation();
    const emit = vi.fn();
    trackNavigation({ current: nav.ref }, emit);
    expect(emit).not.toHaveBeenCalled();
    nav.go('Login');
    expect(emit).toHaveBeenCalledWith('navigation', { to: 'Login' });
  });

  it('reaches the desktop as an event through Durbun.trackNavigation; junk refs are ignored', async () => {
    const d = await start();
    const nav = fakeNavigation('Home');
    Durbun.trackNavigation(nav.ref);
    expect(await d.waitForMessage((m) => m.type === 'event')).toMatchObject({ name: 'navigation', props: { to: 'Home' } });
    expect(() => Durbun.trackNavigation(null as never)()).not.toThrow();
    expect(() => Durbun.trackNavigation({ current: null })()).not.toThrow();
  });
});

describe('appearance action (React Native)', () => {
  it('switches light / dark / back to the system setting', async () => {
    const calls: unknown[] = [];
    // RN 0.72: only 'dark', 'light' or null.
    const setColorScheme = (s: unknown) => {
      if (s !== 'dark' && s !== 'light' && s !== null) throw new Error("Unrecognized color scheme. Did you mean 'dark', 'light' or null?");
      calls.push(s);
    };
    __setReactNativeModuleForTests({ Appearance: { setColorScheme }, Platform: { OS: 'ios' } });
    const action = builtInActions('react-native').find((a) => a.descriptor.id === 'rn.appearance');
    expect(action?.descriptor).toMatchObject({ kind: 'select', value: 'system', options: [{ value: 'system' }, { value: 'light' }, { value: 'dark' }] });
    await action!.handler({ value: 'dark' });
    await action!.handler({ value: 'system' });
    expect(calls).toEqual(['dark', null]);
    expect(() => action!.handler({ value: 'sepia' })).toThrow(/Unknown appearance/);
  });
});

describe('no-op entry', () => {
  it('has the whole API, does nothing, and pulls in no SDK code', () => {
    expect(Object.keys(Noop).sort()).toEqual(Object.keys(Durbun).sort());
    expect(Object.keys(Noop.network).sort()).toEqual(Object.keys(Durbun.network).sort());
    Noop.start({ enabled: true });
    expect(Noop.isStarted).toBe(false);
    expect(() => Noop.network.begin({ url: 'x' }).response({ status: 200 })).not.toThrow();
    expect(Noop.trackNavigation({})).toBeTypeOf('function');
    const source = readFileSync(new URL('../src/noop.ts', import.meta.url), 'utf8');
    const runtimeImports = [...source.matchAll(/^(?:import|export) (?!type )[^;]*from '([^']+)'/gm)].map((m) => m[1]);
    expect(runtimeImports).toEqual(['./version.js']);
  });

  it('is exported as @durbun/react-native/noop', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./noop'].require.default).toBe('./dist/cjs/noop.js');
    expect(pkg.exports['./noop'].import.default).toBe('./dist/noop.js');
  });
});
