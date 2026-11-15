/** App and device identity in Expo (Expo Go, dev clients) and the note when the app id is only a guess. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import WsClient from 'ws';
import { DurbunClient } from '../src/client.js';
import { DEFAULT_TIMING } from '../src/connection.js';
import { __setReactNativeModuleForTests, describeEnvironment } from '../src/env.js';
import { closedPort } from './helpers/httpServer.js';

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let client: DurbunClient | undefined;

afterEach(() => {
  client?.stop();
  client = undefined;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  __setReactNativeModuleForTests(undefined);
  delete (globalThis as Record<string, unknown>).expo;
  vi.restoreAllMocks();
});

/** React Native as Expo runs it: no `app=` in the bundle URL, the root component registered as "main". */
function expoRN(os: 'ios' | 'android', extraNative: Record<string, unknown> = {}) {
  Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true, writable: true });
  __setReactNativeModuleForTests({
    Platform:
      os === 'ios'
        ? { OS: 'ios', Version: '18.1', constants: { osVersion: '18.1', interfaceIdiom: 'phone' } }
        : { OS: 'android', Version: 35, constants: { Model: 'SM-A736B', Manufacturer: 'samsung', Release: '15', Fingerprint: 'samsung/a73xq/a73xq:15/user/release-keys' } },
    NativeModules: { SourceCode: { scriptURL: `http://192.168.1.20:8081/node_modules/expo-router/entry.bundle?platform=${os}&dev=true` }, ...extraNative },
    AppRegistry: { getAppKeys: () => ['main'] },
  });
}

const appConfig = {
  name: 'Pati',
  slug: 'pati',
  version: '1.4.0',
  ios: { bundleIdentifier: 'com.mykynk.pati' },
  android: { package: 'com.mykynk.pati.app' },
};

function expoModules(modules: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).expo = { modules };
}

describe('Expo Go', () => {
  const expoGo = {
    ExpoApplication: { applicationId: 'host.exp.Exponent', applicationName: 'Expo Go', nativeApplicationVersion: '2.33.4', nativeBuildVersion: '300' },
    // The dev server's manifest: the app config sits in extra.expoClient (a JSON string on Android).
    ExponentConstants: { executionEnvironment: 'storeClient', appOwnership: 'expo', manifest: JSON.stringify({ id: 'x', extra: { expoClient: appConfig } }) },
  };

  it('iOS: the project shows by its own bundle id, name and version, not as "Expo Go"', () => {
    expoRN('ios');
    expoModules(expoGo);
    const env = describeEnvironment({}, 'react-native');
    expect(env.app).toEqual({ id: 'com.mykynk.pati', name: 'Pati', version: '1.4.0', debug: expect.any(Boolean) });
    expect(env.weakIdentity).toBeUndefined();
  });

  it("Android: the project's package, while logcat lines stay linked to Expo Go's process", () => {
    expoRN('android');
    expoModules({ ...expoGo, ExpoApplication: { ...expoGo.ExpoApplication, applicationId: 'host.exp.exponent' } });
    const env = describeEnvironment({}, 'react-native');
    expect(env.app).toMatchObject({ id: 'com.mykynk.pati.app', name: 'Pati', processName: 'host.exp.exponent' });
  });

  it('falls back to the slug, and flags a guess when no config is found', () => {
    expoRN('ios');
    expoModules({ ...expoGo, ExponentConstants: { executionEnvironment: 'storeClient', manifest: JSON.stringify({ extra: { expoClient: { name: 'Pati', slug: 'pati' } } }) } });
    expect(describeEnvironment({}, 'react-native').app).toMatchObject({ id: 'pati', name: 'Pati' });
    expoModules({ ExpoApplication: expoGo.ExpoApplication, ExponentConstants: { executionEnvironment: 'storeClient' } });
    const env = describeEnvironment({}, 'react-native');
    expect(env.app.id).toBe('main');
    expect(env.weakIdentity).toBe('expo-go');
    expect(describeEnvironment({ appId: 'com.mykynk.pati' }, 'react-native').weakIdentity).toBeUndefined();
  });
});

describe('Expo dev client and bare apps', () => {
  it('a dev client without expo-application uses the bundle id from its app config', () => {
    expoRN('ios', { EXDevLauncher: { manifestString: JSON.stringify({ extra: { expoClient: appConfig } }) } });
    expoModules({ ExponentConstants: { executionEnvironment: 'bare' } });
    const env = describeEnvironment({}, 'react-native');
    expect(env.app).toMatchObject({ id: 'com.mykynk.pati', name: 'Pati' });
    expect(env.weakIdentity).toBeUndefined();
  });

  it('expo-application wins in a dev client (the real native id)', () => {
    expoRN('android');
    expoModules({
      ExpoApplication: { applicationId: 'com.mykynk.pati.dev', applicationName: 'Pati Dev', nativeApplicationVersion: '1.4.0', nativeBuildVersion: '12' },
      ExponentConstants: { executionEnvironment: 'bare', manifest: appConfig },
    });
    expect(describeEnvironment({}, 'react-native').app).toMatchObject({ id: 'com.mykynk.pati.dev', name: 'Pati Dev', build: '12', processName: 'com.mykynk.pati.dev' });
  });

  it('only the "main" key: flagged as a guess', () => {
    expoRN('ios');
    const env = describeEnvironment({}, 'react-native');
    expect(env.app.id).toBe('main');
    expect(env.weakIdentity).toBe('app-key');
  });
});

describe('device hints', () => {
  it('iOS: "iPhone" from the interface idiom; expo-device adds the name, model id and physical flag', () => {
    expoRN('ios');
    expect(describeEnvironment({}, 'react-native').device).toMatchObject({ platform: 'ios', name: 'iPhone', isPhysical: true });
    expoModules({ ExpoDevice: { deviceName: 'Yusuf’s iPhone', modelId: 'iPhone16,2', isDevice: true } });
    expect(describeEnvironment({}, 'react-native').device).toMatchObject({ name: 'Yusuf’s iPhone', model: 'iPhone16,2', isPhysical: true });
  });

  it('Android: expo-device adds the device name', () => {
    expoRN('android');
    expoModules({ ExpoDevice: { deviceName: 'Galaxy A73', isDevice: true } });
    expect(describeEnvironment({}, 'react-native').device).toMatchObject({ platform: 'android', model: 'SM-A736B', name: 'Galaxy A73', isPhysical: true });
  });
});

describe('weak identity note', () => {
  it('is printed once at start, with the fix', async () => {
    expoRN('ios');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    client = new DurbunClient({ host: '127.0.0.1', port: await closedPort(), captureConsole: false, captureMetrics: false, captureErrors: false, captureNetwork: false, WebSocket: WsClient as never }, { ...DEFAULT_TIMING, connectHintMs: 60_000 });
    client.start();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('shows in Dürbün as "main"');
    expect(String(info.mock.calls[0][0])).toContain("Durbun.start({ appId: 'com.example.app' })");
  });
});
