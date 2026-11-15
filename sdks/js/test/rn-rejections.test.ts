/**
 * React Native unhandled promise rejections, fed by replicas of each version's tracker (see
 * helpers/rnRejectionTracker.ts for the versions read and their message shapes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Durbun } from '../src/index.js';
import { __setReactNativeModuleForTests } from '../src/env.js';
import { installErrorHandlers, isRejectionWarning, rejectionFromLogBoxLog, rejectionFromUncaught, type ErrorReport } from '../src/errors.js';
import { FakeDesktop, waitFor } from './helpers/fakeDesktop.js';
import {
  hermesError,
  jscError,
  trackerV070,
  trackerV071to081,
  trackerV082plus,
  type Console,
  type LogBoxLike,
  type Pipeline,
} from './helpers/rnRejectionTracker.js';

function fakeRN() {
  const warn = vi.fn();
  const error = vi.fn();
  const addLog = vi.fn();
  const addException = vi.fn();
  const target: Record<string, unknown> = { console: { warn, error } };
  const logBox: LogBoxLike = { addLog, addException };
  const reports: Array<[unknown, ErrorReport]> = [];
  const patches = installErrorHandlers({ reportError: (e, r) => reports.push([e, r]) }, 'react-native', target, { LogBox: logBox });
  return { target, console: target.console as Console, logBox, warn, error, addLog, addException, reports, patches };
}

const REJECTION: ErrorReport = { fatal: false, origin: 'unhandled-rejection' };

describe('React Native 0.71–0.81: LogBox.addLog', () => {
  it('reports Errors with their stack, and LogBox still gets the identical log', () => {
    const rn = fakeRN();
    const track = trackerV071to081(rn.logBox);
    const hermes = hermesError(TypeError, "undefined is not a function (near '...load...')");
    track(0, hermes);
    expect(rn.addLog).toHaveBeenCalledTimes(1);
    const log = rn.addLog.mock.calls[0][0];
    expect(log).toMatchObject({ category: 'possible_unhandled_promise_rejection', level: 'warn' });
    expect(rn.reports).toEqual([[{ name: 'TypeError', message: "undefined is not a function (near '...load...')", stack: hermes.stack }, REJECTION]]);

    const jsc = jscError(RangeError, 'bad index');
    track(1, jsc);
    expect(rn.reports[1]).toEqual([{ name: 'RangeError', message: 'bad index', stack: jsc.stack }, REJECTION]);
  });

  it('reports strings, objects and undefined by their pretty-format text', () => {
    const rn = fakeRN();
    const track = trackerV071to081(rn.logBox);
    track(2, 'plain string');
    track(3, { code: 42 });
    track(4, undefined); // default parameter `rejection = {}`
    expect(rn.reports.map((r) => r[0])).toEqual([
      { name: 'Error', message: '"plain string"' },
      { name: 'Error', message: 'Object {\n  "code": 42,\n}' },
      { name: 'Error', message: 'Object {}' },
    ]);
    expect(rn.addLog).toHaveBeenCalledTimes(3);
  });

  it('keeps a multi-line Error message whole (the stack comes separately)', () => {
    const rn = fakeRN();
    const e = hermesError(Error, 'first line\nsecond line');
    trackerV071to081(rn.logBox)(5, e);
    expect(rn.reports[0][0]).toEqual({ name: 'Error', message: 'first line\nsecond line', stack: e.stack });
  });

  it('ignores every other LogBox log', () => {
    const rn = fakeRN();
    rn.logBox.addLog({ level: 'warn', message: { content: 'Require cycle: a.js -> b.js', substitutions: [] }, category: 'Require cycle' });
    rn.logBox.addLog({ level: 'warn', message: { content: 'Possible unhandled promise rejection (id: 9):\nx' }, category: 'other' });
    rn.logBox.addLog(undefined);
    expect(rn.reports).toHaveLength(0);
    expect(rn.addLog).toHaveBeenCalledTimes(3);
    expect(rejectionFromLogBoxLog({ category: 'possible_unhandled_promise_rejection', message: { content: 'unexpected' } })).toBeUndefined();
  });

  it('restores LogBox.addLog on stop', () => {
    const rn = fakeRN();
    expect(rn.logBox.addLog).not.toBe(rn.addLog);
    rn.patches.forEach((p) => p.restore());
    expect(rn.logBox.addLog).toBe(rn.addLog);
  });
});

describe('React Native 0.82+: ExceptionsManager.handleException', () => {
  it('JS pipeline: reports the original rejection from `cause`, and console.error + LogBox still get it', () => {
    const rn = fakeRN();
    const track = trackerV082plus(rn.console, rn.logBox, 'js');
    const original = hermesError(TypeError, 'Network request failed');
    track(0, original);
    expect(rn.error).toHaveBeenCalledTimes(1);
    const logged = rn.error.mock.calls[0][0] as Error;
    expect(logged.message).toBe('Uncaught (in promise, id: 0): "TypeError: Network request failed"');
    expect(rn.addException).toHaveBeenCalledTimes(1);
    expect(rn.reports).toEqual([[original, REJECTION]]);

    track(1, 'nope');
    track(2, undefined);
    track(3, null);
    expect(rn.reports.slice(1).map((r) => r[0])).toEqual(['nope', undefined, null]);
  });

  it.each<Pipeline>(['native', 'native-not-ready'])('%s pipeline: rebuilds the rejection from the text', (pipeline) => {
    const rn = fakeRN();
    const track = trackerV082plus(rn.console, rn.logBox, pipeline);
    track(7, hermesError(TypeError, 'boom'));
    track(8, 'plain string');
    track(9, undefined);
    track(10, { code: 42 });
    expect(rn.error).toHaveBeenCalledTimes(4);
    const prefix = pipeline === 'native' ? '' : '[runtime not ready]: ';
    expect(rn.error.mock.calls[0][0]).toBe(`${prefix}Error: Uncaught (in promise, id: 7): "TypeError: boom"`);
    expect(rn.reports.map((r) => r[0])).toEqual([
      { name: 'TypeError', message: 'boom' },
      { name: 'Error', message: '"plain string"' },
      undefined,
      { name: 'Error', message: 'Object {\n  "code": 42,\n}' },
    ]);
  });

  it('falls back to the text when the engine drops Error `cause`', () => {
    const e = new Error('Uncaught (in promise, id: 4): "Error: no cause"');
    expect(rejectionFromUncaught(e)).toEqual({ id: '4', value: { name: 'Error', message: 'no cause' } });
    expect(rejectionFromUncaught(new Error('Uncaught (in promise, id: 4)'))).toEqual({ id: '4', value: undefined });
  });

  it('does not touch other console.error calls', () => {
    const rn = fakeRN();
    rn.console.error(new Error('Uncaught TypeError: x'));
    rn.console.error('Uncaught (in promise) without id');
    rn.console.error('prefix Uncaught (in promise, id: 1): "x"');
    rn.console.error();
    rn.console.warn(new Error('Uncaught (in promise, id: 1): "x"'));
    expect(rn.reports).toHaveLength(0);
    expect(rn.error).toHaveBeenCalledTimes(4);
  });
});

describe('React Native 0.70 and older: console.warn', () => {
  it('reports from the warning text and still warns', () => {
    const rn = fakeRN();
    const track = trackerV070(rn.console);
    const e = hermesError(TypeError, 'undefined is not a function');
    track(0, e);
    track(1, 'plain string');
    expect(rn.warn).toHaveBeenCalledTimes(2);
    expect(rn.reports.map((r) => r[0])).toEqual([
      { name: 'TypeError', message: 'undefined is not a function', stack: e.stack },
      { name: 'Error', message: '"plain string"' },
    ]);
  });
});

describe('one report per rejection id', () => {
  it('a rejection seen on two paths is reported once', () => {
    const rn = fakeRN();
    trackerV071to081(rn.logBox)(3, new Error('twice'));
    trackerV082plus(rn.console, rn.logBox, 'native')(3, new Error('twice'));
    trackerV082plus(rn.console, rn.logBox, 'js')(4, new Error('other'));
    expect(rn.reports).toHaveLength(2);
  });

  it('a missing LogBox, console or method installs what it can and never throws', () => {
    const reports: unknown[] = [];
    const host = { reportError: (e: unknown) => reports.push(e) };
    expect(() => installErrorHandlers(host, 'react-native', {}, undefined)).not.toThrow();
    expect(() => installErrorHandlers(host, 'react-native', { console: {} }, { LogBox: {} })).not.toThrow();
    const throwing = Object.defineProperty({}, 'LogBox', {
      get() {
        throw new Error('module failed');
      },
    });
    const error = vi.fn();
    const target = { console: { error } };
    const patches = installErrorHandlers(host, 'react-native', target, throwing);
    expect(patches).toHaveLength(1);
    target.console.error(new Error('Uncaught (in promise, id: 1)'));
    expect(reports).toEqual([undefined]);
  });

  it('a failing host never breaks LogBox or the console', () => {
    const addLog = vi.fn();
    const error = vi.fn();
    const target = { console: { error } };
    const logBox = { addLog, addException: vi.fn() };
    installErrorHandlers({ reportError: () => { throw new Error('host down'); } }, 'react-native', target, { LogBox: logBox });
    expect(() => trackerV071to081(logBox)(0, new Error('x'))).not.toThrow();
    expect(() => trackerV082plus(target.console as unknown as Console, logBox, 'js')(1, new Error('y'))).not.toThrow();
    expect(addLog).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('isRejectionWarning', () => {
  it('matches the tracker lines only, the 0.82+ error only on console.error', () => {
    expect(isRejectionWarning(['Possible Unhandled Promise Rejection (id: 1):\nx'])).toBe(true);
    expect(isRejectionWarning([new Error('Uncaught (in promise, id: 1)')], 'error')).toBe(true);
    expect(isRejectionWarning(['Error: Uncaught (in promise, id: 1): "x"'], 'error')).toBe(true);
    expect(isRejectionWarning([new Error('Uncaught (in promise, id: 1)')], 'warn')).toBe(false);
    expect(isRejectionWarning(['Promise rejection handled (id: 1)'], 'warn')).toBe(false);
    expect(isRejectionWarning([], 'error')).toBe(false);
  });
});

describe('end to end in a React Native app', () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const realWarn = console.warn;
  const realError = console.error;
  let desktop: FakeDesktop | undefined;

  afterEach(async () => {
    Durbun.stop();
    console.warn = realWarn;
    console.error = realError;
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    __setReactNativeModuleForTests(undefined);
    await desktop?.close();
    desktop = undefined;
  });

  it.each(['0.81 LogBox', '0.88 JS pipeline', '0.88 native pipeline'] as const)('%s: one error row, no duplicate console row', async (kind) => {
    const warn = vi.fn();
    const error = vi.fn();
    console.warn = warn;
    console.error = error;
    const addLog = vi.fn();
    const addException = vi.fn();
    const logBox = { addLog, addException };
    Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true, writable: true });
    __setReactNativeModuleForTests({
      Platform: { OS: 'ios', Version: '18.0', constants: { osVersion: '18.0' } },
      NativeModules: { SourceCode: { scriptURL: 'http://192.168.1.20:8081/index.bundle?platform=ios&app=com.x.app' } },
      AppRegistry: { getAppKeys: () => ['App'] },
      LogBox: logBox,
    });
    desktop = await FakeDesktop.start();
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureNetwork: false, captureMetrics: false });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');

    const reason = hermesError(TypeError, 'Network request failed');
    if (kind === '0.81 LogBox') trackerV071to081(logBox)(0, reason);
    else trackerV082plus(console as unknown as Console, logBox, kind === '0.88 JS pipeline' ? 'js' : 'native')(0, reason);
    Durbun.info('marker');
    await desktop.waitForMessage((m) => m.message === 'marker');

    const rows = desktop.logs().filter((m) => m.message !== 'marker');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: 'error',
      tag: 'unhandled-rejection',
      message: 'Unhandled promise rejection TypeError: Network request failed',
      error: { type: 'TypeError', message: 'Network request failed' },
    });
    if (kind !== '0.88 native pipeline') expect(rows[0].error.stack).toContain('at load');
    // React Native's own output is untouched.
    if (kind === '0.81 LogBox') expect(addLog).toHaveBeenCalledTimes(1);
    else expect(error).toHaveBeenCalledTimes(1);
    if (kind === '0.88 JS pipeline') expect(addException).toHaveBeenCalledTimes(1);
  });
});
