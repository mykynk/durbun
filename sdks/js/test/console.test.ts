/** console.* capture: formatting, originals preserved, re-entrancy, and the 'auto' duplicate policy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Durbun } from '../src/index.js';
import { __setReactNativeModuleForTests } from '../src/env.js';
import { FakeDesktop, sleep, waitFor, type FakeDesktopOptions } from './helpers/fakeDesktop.js';
import { closedPort } from './helpers/httpServer.js';

const METHODS = ['debug', 'log', 'info', 'warn', 'error', 'trace', 'assert', 'dir', 'table'] as const;
type Method = (typeof METHODS)[number];

let desktop: FakeDesktop | undefined;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let originals: Record<Method, unknown>;
let sink: Record<Method, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  // Replace the real console methods with silent spies (the SDK wraps whatever is installed at start).
  originals = {} as Record<Method, unknown>;
  sink = {} as Record<Method, ReturnType<typeof vi.fn>>;
  for (const m of METHODS) {
    originals[m] = console[m];
    sink[m] = vi.fn();
    (console as any)[m] = sink[m];
  }
});

afterEach(async () => {
  Durbun.stop();
  for (const m of METHODS) (console as any)[m] = originals[m];
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  __setReactNativeModuleForTests(undefined);
  await desktop?.close();
  desktop = undefined;
});

async function start(opts: Parameters<typeof Durbun.start>[0] = {}, desktopOpts: FakeDesktopOptions = {}) {
  desktop = await FakeDesktop.start(desktopOpts);
  Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureNetwork: false, captureMetrics: false, captureErrors: false, ...opts });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

describe('console capture', () => {
  it('captures every method with readable messages and still calls the originals', async () => {
    const d = await start();
    const user = { id: 1, name: 'Ali' };
    console.log('Kullanıcı %s yüklendi', 'Ali', user);
    console.info('[Auth] token yenilendi');
    console.debug('debug line');
    console.warn('Uyarı:', 42);
    console.error(new RangeError('out of range'));
    console.trace('where am I');
    console.assert(1 + 1 === 2, 'not logged');
    console.assert(false, 'invariant %s', 'broken');
    console.dir({ deep: { a: 1 } });
    console.table([{ a: 1 }, { a: 2 }]);
    await waitFor(() => d.logs().length >= 9, 5_000, 'console logs');
    const logs = d.logs();
    expect(logs[0]).toMatchObject({ level: 'info', tag: 'console', message: 'Kullanıcı Ali yüklendi {"id":1,"name":"Ali"}', data: user });
    expect(logs[1]).toMatchObject({ level: 'info', tag: 'Auth', message: 'token yenilendi' });
    expect(logs[2]).toMatchObject({ level: 'debug', message: 'debug line' });
    expect(logs[3]).toMatchObject({ level: 'warn', message: 'Uyarı: 42' });
    expect(logs[4]).toMatchObject({ level: 'error', message: 'RangeError: out of range', error: { type: 'RangeError', message: 'out of range' } });
    expect(logs[5]).toMatchObject({ level: 'debug', message: 'where am I', error: { type: 'Trace' } });
    expect(logs[5].error.stack).toMatch(/^Trace: where am I\n/);
    expect(logs[6]).toMatchObject({ level: 'error', message: 'Assertion failed: invariant broken' });
    expect(logs[7]).toMatchObject({ level: 'info', data: { deep: { a: 1 } } });
    expect(logs[8]).toMatchObject({ level: 'info', data: [{ a: 1 }, { a: 2 }] });
    expect(logs).toHaveLength(9);
    // Originals got the untouched arguments.
    expect(sink.log).toHaveBeenCalledWith('Kullanıcı %s yüklendi', 'Ali', user);
    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(sink.assert).toHaveBeenCalledTimes(2);
  });

  it('does not loop when serializing a logged value logs again', async () => {
    const d = await start();
    const sneaky = {
      get value() {
        console.log('getter side effect');
        return 1;
      },
    };
    console.log('outer', sneaky);
    await d.waitForMessage((m) => m.type === 'log' && m.message.startsWith('outer'));
    await sleep(100);
    expect(d.logs().map((m) => m.message)).toEqual(['outer {"value":1}']);
    expect(sink.log).toHaveBeenCalledWith('getter side effect');
  });

  it('restores the original console methods on stop', async () => {
    await start();
    expect(console.log).not.toBe(sink.log);
    Durbun.stop();
    for (const m of METHODS) expect(console[m]).toBe(sink[m]);
  });

  it('captureConsole: false leaves console untouched', async () => {
    await start({ captureConsole: false });
    expect(console.log).toBe(sink.log);
  });

  describe("'auto' policy (no duplicates of device logs)", () => {
    function pretendRN(os: 'android' | 'ios', scriptHost = 'localhost') {
      Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true, writable: true });
      __setReactNativeModuleForTests({
        Platform: { OS: os, Version: os === 'android' ? 34 : '17.5', constants: os === 'android' ? { Model: 'Pixel 8', Fingerprint: 'google/shiba' } : { osVersion: '17.5' } },
        NativeModules: { SourceCode: { scriptURL: `http://${scriptHost}:8081/index.bundle?platform=${os}&app=com.x.app` } },
        AppRegistry: { getAppKeys: () => ['App'] },
      });
    }

    it('Android with streaming logcat: console lines come from device logs only (also when buffered)', async () => {
      pretendRN('android');
      const port = await closedPort();
      Durbun.start({ host: '127.0.0.1', port, enabled: true, captureNetwork: false, captureMetrics: false, captureErrors: false });
      console.log('buffered before welcome');
      Durbun.info('explicit SDK log');
      desktop = await FakeDesktop.start({ port, config: { deviceLogsAvailable: true } });
      await waitFor(() => Durbun.isConnected, 8_000, 'connection');
      console.log('after welcome');
      console.error('also skipped');
      Durbun.info('second explicit');
      await desktop.waitForMessage((m) => m.message === 'second explicit');
      expect(desktop.logs().map((m) => m.message)).toEqual(['explicit SDK log', 'second explicit']);
      expect(desktop.messages('hello')[0].sdk.platform).toBe('react-native');
      expect(sink.log).toHaveBeenCalledWith('after welcome');
    });

    it('iOS simulator: only console.debug (not in the info-level log stream) is captured', async () => {
      pretendRN('ios', 'localhost');
      const d = await start({}, { config: { deviceLogsAvailable: true } });
      console.log('dup');
      console.debug('only via sdk');
      Durbun.info('marker');
      await d.waitForMessage((m) => m.message === 'marker');
      expect(d.logs().map((m) => m.message)).toEqual(['only via sdk', 'marker']);
    });

    it('iOS device (bundle from the Mac LAN IP): everything is captured', async () => {
      pretendRN('ios', '192.168.1.20');
      const d = await start({}, { config: { deviceLogsAvailable: true } });
      console.log('device line');
      await d.waitForMessage((m) => m.message === 'device line');
    });

    it('without device logs, or with captureConsole: true, everything is captured', async () => {
      pretendRN('android');
      const d = await start({ captureConsole: true }, { config: { deviceLogsAvailable: true } });
      console.log('forced');
      await d.waitForMessage((m) => m.message === 'forced');
    });
  });
});
