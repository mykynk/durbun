import { afterEach, describe, expect, it } from 'vitest';
import {
  __setReactNativeModuleForTests,
  describeEnvironment,
  detectRuntime,
  discoverHosts,
  devServerOrigin,
  isLoopbackHost,
  isPrivateHost,
} from '../src/env.js';
import { resolveOptions, resolveUrls } from '../src/options.js';
import { RingBuffer } from '../src/ringBuffer.js';
import { normalizeRules } from '../src/mocks.js';
import { hostOfUrl, originOfUrl, queryParam } from '../src/util.js';

function fakeRN(os: 'android' | 'ios', extra: Record<string, unknown> = {}) {
  const android = {
    OS: 'android',
    Version: 34,
    constants: {
      Model: 'Pixel 8',
      Manufacturer: 'Google',
      Release: '14',
      Fingerprint: 'google/shiba/shiba:14/AP2A.240805.005/12025142:user/release-keys',
      ServerHost: '10.0.2.2:8081',
    },
  };
  const ios = { OS: 'ios', Version: '17.5', constants: { osVersion: '17.5', systemName: 'iOS', interfaceIdiom: 'phone' } };
  return {
    Platform: os === 'android' ? android : ios,
    NativeModules: {
      SourceCode: {
        scriptURL:
          os === 'android'
            ? 'http://10.0.2.2:8081/index.bundle?platform=android&dev=true&lazy=true&minify=false&app=com.mykynk.pati&modulesOnly=false&runModule=true'
            : 'http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false&app=com.mykynk.pati&runModule=true',
      },
    },
    AppRegistry: { getAppKeys: () => ['LogBox', 'Pati'] },
    ...extra,
  };
}

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function pretendReactNative(rn: Record<string, unknown>) {
  Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true, writable: true });
  __setReactNativeModuleForTests(rn);
}

afterEach(() => {
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  __setReactNativeModuleForTests(undefined);
  delete (globalThis as Record<string, unknown>).expo;
});

describe('runtime detection', () => {
  it('detects Node by default and React Native through navigator.product', () => {
    expect(detectRuntime()).toBe('node');
    pretendReactNative(fakeRN('android'));
    expect(detectRuntime()).toBe('react-native');
  });
});

describe('describeEnvironment', () => {
  it('describes a Node process', () => {
    const env = describeEnvironment({}, 'node');
    expect(env.sdkPlatform).toBe('js');
    expect(env.app.pid).toBe(process.pid);
    expect(env.device.platform).toBe('other');
    expect(env.device.name).toBe(`Node.js ${process.version}`);
  });

  it('describes a React Native Android app (bundle URL app id, AppRegistry name, Platform constants)', () => {
    pretendReactNative(fakeRN('android'));
    const env = describeEnvironment({}, 'react-native');
    expect(env.sdkPlatform).toBe('react-native');
    expect(env.app).toMatchObject({ id: 'com.mykynk.pati', name: 'Pati', processName: 'com.mykynk.pati' });
    expect(env.device).toEqual({ platform: 'android', model: 'Pixel 8', manufacturer: 'Google', osVersion: '14', apiLevel: 34, isPhysical: true });
  });

  it('marks Android emulators as not physical', () => {
    const rn = fakeRN('android');
    (rn.Platform as any).constants.Fingerprint = 'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/10763863:userdebug/dev-keys';
    (rn.Platform as any).constants.Model = 'sdk_gphone64_arm64';
    pretendReactNative(rn);
    expect(describeEnvironment({}, 'react-native').device.isPhysical).toBe(false);
  });

  it('describes an iOS simulator app (bundle served from localhost) and applies overrides', () => {
    pretendReactNative(fakeRN('ios'));
    const env = describeEnvironment({ appName: 'Pati Dev', appVersion: '2.1.0', device: { name: 'iPhone 16 Pro' } }, 'react-native');
    expect(env.app).toMatchObject({ id: 'com.mykynk.pati', name: 'Pati Dev', version: '2.1.0' });
    expect(env.app.processName).toBeUndefined();
    expect(env.device).toEqual({ platform: 'ios', osVersion: '17.5', isPhysical: false, name: 'iPhone 16 Pro' });
  });

  it('prefers expo-application constants when present', () => {
    pretendReactNative(fakeRN('ios'));
    (globalThis as Record<string, unknown>).expo = {
      modules: { ExpoApplication: { applicationId: 'com.expo.app', applicationName: 'Expo App', nativeApplicationVersion: '1.2.3', nativeBuildVersion: '45' } },
    };
    const env = describeEnvironment({}, 'react-native');
    expect(env.app).toMatchObject({ id: 'com.expo.app', name: 'Expo App', version: '1.2.3', build: '45' });
  });

  it('falls back to the app key and lets appId override (name derived when unknown)', () => {
    const rn = fakeRN('android', { NativeModules: {}, AppRegistry: { getAppKeys: () => [] } });
    pretendReactNative(rn);
    let env = describeEnvironment({}, 'react-native');
    expect(env.app.id).toBe('react-native-app');
    env = describeEnvironment({ appId: 'com.acme.shop' }, 'react-native');
    expect(env.app).toMatchObject({ id: 'com.acme.shop', name: 'shop', processName: 'com.acme.shop' });
  });
});

describe('hosts and URLs', () => {
  it('classifies hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isPrivateHost('192.168.1.20')).toBe(true);
    expect(isPrivateHost('10.0.2.2')).toBe(true);
    expect(isPrivateHost('172.20.10.3')).toBe(true);
    expect(isPrivateHost('yusuf-mbp.local')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('api.example.com')).toBe(false);
    expect(isPrivateHost('localhost')).toBe(false);
  });

  it('discovers the Metro host (LAN / emulator alias only) and the dev-server origin', () => {
    pretendReactNative(fakeRN('android'));
    expect(discoverHosts('react-native')).toEqual(['10.0.2.2']);
    expect(devServerOrigin('react-native')).toBe('http://10.0.2.2:8081');
    pretendReactNative(fakeRN('ios'));
    expect(discoverHosts('react-native')).toEqual([]);
    expect(discoverHosts('node')).toEqual([]);
  });

  it('builds candidate URLs', () => {
    expect(resolveUrls({}, 'node')).toEqual(['ws://localhost:9750/sdk', 'ws://127.0.0.1:9750/sdk']);
    expect(resolveUrls({ host: '192.168.1.20' }, 'node')).toEqual(['ws://192.168.1.20:9750/sdk']);
    expect(resolveUrls({ host: '192.168.1.20:9999' }, 'node')).toEqual(['ws://192.168.1.20:9999/sdk']);
    expect(resolveUrls({ host: 'http://mac.local:9750/' }, 'node')).toEqual(['ws://mac.local:9750/sdk']);
    expect(resolveUrls({ host: '::1', port: 1234, path: 'x' }, 'node')).toEqual(['ws://[::1]:1234/x']);
    expect(resolveUrls({ url: 'ws://10.0.0.5:9750/sdk' }, 'node')).toEqual(['ws://10.0.0.5:9750/sdk']);
    expect(resolveUrls({ host: 'ws://10.0.0.5:9750/sdk' }, 'node')).toEqual(['ws://10.0.0.5:9750/sdk']);
    pretendReactNative(fakeRN('android'));
    expect(resolveUrls({}, 'react-native')).toEqual(['ws://localhost:9750/sdk', 'ws://127.0.0.1:9750/sdk', 'ws://10.0.2.2:9750/sdk']);
  });

  it('resolves option defaults', () => {
    const o = resolveOptions({}, 'node');
    expect(o).toMatchObject({ captureConsole: 'auto', captureNetwork: true, captureErrors: true, captureMetrics: true, maxBufferedMessages: 5000, debug: false });
    expect(resolveOptions({ captureConsole: true, maxBufferedMessages: -3, ignoreUrls: ['x', /y/, 5 as never] }, 'node')).toMatchObject({
      captureConsole: true,
      maxBufferedMessages: 0,
      ignoreUrls: ['x', /y/],
    });
  });

  it('URL helpers work without the URL class', () => {
    const u = 'http://user:pw@10.0.2.2:8081/index.bundle?platform=android&app=com.x.y&q=a+b%20c#frag';
    expect(hostOfUrl(u)).toBe('10.0.2.2');
    expect(originOfUrl(u)).toBe('http://10.0.2.2:8081');
    expect(queryParam(u, 'app')).toBe('com.x.y');
    expect(queryParam(u, 'q')).toBe('a b c');
    expect(queryParam(u, 'missing')).toBeUndefined();
    expect(hostOfUrl('https://[fe80::1]:443/x')).toBe('[fe80::1]');
  });
});

describe('RingBuffer', () => {
  it('keeps the newest items by count and by weight', () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) rb.push(i);
    expect(rb.toArray()).toEqual([3, 4, 5]);
    expect(rb.takeDropped()).toBe(2);
    expect(rb.shift()).toBe(3);
    rb.push(6);
    rb.push(7);
    expect(rb.toArray()).toEqual([5, 6, 7]);
    const byWeight = new RingBuffer<string>(100, 10);
    byWeight.push('a', 4);
    byWeight.push('b', 4);
    byWeight.push('c', 4);
    expect(byWeight.toArray()).toEqual(['b', 'c']);
    expect(byWeight.totalWeight).toBe(8);
    expect(byWeight.push('huge', 11)).toBe(1);
    expect(byWeight.toArray()).toEqual(['b', 'c']);
    const none = new RingBuffer<number>(0);
    none.push(1);
    expect(none.size).toBe(0);
    expect(none.dropped).toBe(1);
  });
});

describe('mock rule normalization', () => {
  it('drops malformed rules and clamps values', () => {
    const rules = normalizeRules([
      null,
      { id: 'x' },
      { id: 'a', enabled: true, method: 'GET', url: '/users', match: 'contains', action: { type: 'respond', status: 201, headers: [['A', 1], ['bad']], body: '{}' }, createdAt: 1 },
      { id: 'b', enabled: 'yes', url: '/x', match: 'glob', action: { type: 'delay', delayMs: -5 } },
      { id: 'c', enabled: true, url: '/y', action: { type: 'fail', error: 'weird' } },
      { id: 'd', enabled: true, url: '/z', match: 'regex', action: { type: 'nope' } },
    ]);
    expect(rules.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rules[0].action).toEqual({ type: 'respond', status: 201, headers: [['A', '1']], body: '{}' });
    expect(rules[1]).toMatchObject({ enabled: false, method: '*', action: { type: 'delay', delayMs: 0 } });
    expect(rules[2].action).toEqual({ type: 'fail', error: 'connection' });
    expect(rules[2].match).toBe('');
    expect(normalizeRules('nope')).toEqual([]);
  });
});
