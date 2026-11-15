/**
 * React Native on Android: a console line arrives from the SDK and again from logcat (tag ReactNativeJS).
 * The logcat copy is hidden while the SDK session of that process is live and sends console lines, in
 * either order of arrival; nothing is lost when the SDK is not connected or disconnects.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HOLD_MS } from '../../src/hub/consoleEcho';
import type { Hub } from '../../src/types';
import { appInput, device, makeHub, sleep, waitFor } from './helpers';

const PHONE = 'android:R5CT';
const PID = 9131;
let hub: Hub;
afterEach(() => hub?.dispose());

function setup(opts: { sdkPid?: boolean } = {}) {
  hub = makeHub();
  hub.upsertDevice(device(PHONE, { name: 'Galaxy A73', model: 'SM-A736B' }));
  // The RN SDK knows no pid: the process is known from the driver's device app.
  hub.upsertDeviceApp({ deviceId: PHONE, id: 'com.mykynk.mahalle', running: true, pids: [PID], lastActivity: Date.now() });
  const app = hub.registerApp(
    appInput(PHONE, {
      sdk: { name: '@durbun/react-native', version: '0.3.0', platform: 'react-native' },
      app: { name: 'Mahalle', id: 'com.mykynk.mahalle', ...(opts.sdkPid ? { pid: PID } : {}) },
      transport: 'websocket',
    }),
  );
  return app.id;
}

const logcat = (message: string, patch: { tag?: string; pid?: number } = {}) =>
  hub.pushDeviceLogs(PHONE, [{ ts: Date.now(), level: 'info', tag: patch.tag ?? 'ReactNativeJS', message, pid: patch.pid ?? PID, origin: 'logcat' }]);
const sdkLine = (appId: string, message: string, tag = 'console') => hub.pushAppLog(appId, { ts: Date.now(), level: 'info', tag, message });
const deviceLines = (text: string) => hub.getLogs().filter((l) => l.source === 'device' && l.message === text);
const appLines = (text: string) => hub.getLogs().filter((l) => l.source === 'app' && l.message === text);

describe('React Native console lines are shown once', () => {
  it('SDK first, then logcat: the logcat copy is hidden', () => {
    const appId = setup();
    sdkLine(appId, 'Sepet yüklendi: 3 ürün');
    logcat('Sepet yüklendi: 3 ürün');
    expect(appLines('Sepet yüklendi: 3 ürün')).toHaveLength(1);
    expect(deviceLines('Sepet yüklendi: 3 ürün')).toHaveLength(0);
  });

  it('logcat first, then the SDK: the held logcat copy is dropped', async () => {
    const appId = setup();
    sdkLine(appId, 'first line makes the session active');
    logcat('first line makes the session active');
    logcat('fetch /v1/feed done');
    expect(deviceLines('fetch /v1/feed done')).toHaveLength(0); // held
    sdkLine(appId, 'fetch   /v1/feed done'); // whitespace differences do not matter
    await sleep(HOLD_MS + 100);
    expect(deviceLines('fetch /v1/feed done')).toHaveLength(0);
    expect(appLines('fetch   /v1/feed done')).toHaveLength(1);
  });

  it('a logcat line the SDK never sends is kept (after a short wait), in order', async () => {
    const appId = setup();
    sdkLine(appId, 'active');
    logcat('only in logcat 1');
    logcat('only in logcat 2');
    logcat('some other tag', { tag: 'OkHttp' });
    expect(deviceLines('some other tag')).toHaveLength(1); // other tags never wait
    await waitFor(() => deviceLines('only in logcat 2').length, HOLD_MS + 1_000);
    const [a, b] = [deviceLines('only in logcat 1')[0]!, deviceLines('only in logcat 2')[0]!];
    expect(a.id).toBeLessThan(b.id);
  });

  it('the SDK prefix tag "[Auth] …" matches the logcat text', () => {
    const appId = setup();
    sdkLine(appId, 'token refreshed', 'Auth');
    logcat('[Auth] token refreshed');
    expect(deviceLines('[Auth] token refreshed')).toHaveLength(0);
  });

  it('repeated identical lines are matched one for one', () => {
    const appId = setup({ sdkPid: true });
    sdkLine(appId, 'tick');
    sdkLine(appId, 'tick');
    logcat('tick');
    logcat('tick');
    logcat('tick'); // a third copy has no SDK twin yet: held, not dropped
    expect(deviceLines('tick')).toHaveLength(0);
    sdkLine(appId, 'tick');
    expect(appLines('tick')).toHaveLength(3);
  });

  it('nothing is hidden without a live SDK session that sends console lines', () => {
    setup();
    logcat('SDK quiet: logcat is the only copy');
    expect(deviceLines('SDK quiet: logcat is the only copy')).toHaveLength(1);
    hub.dispose();
    hub = makeHub();
    hub.upsertDevice(device(PHONE));
    logcat('no session at all');
    expect(deviceLines('no session at all')).toHaveLength(1);
  });

  it('another process is not affected', () => {
    const appId = setup();
    sdkLine(appId, 'same text');
    logcat('same text', { pid: PID + 1 });
    expect(deviceLines('same text')).toHaveLength(1);
  });

  it('lines waiting when the SDK disconnects are kept at once; later ones pass straight through', () => {
    const appId = setup();
    sdkLine(appId, 'active');
    logcat('waiting for its twin');
    expect(deviceLines('waiting for its twin')).toHaveLength(0);
    hub.markAppDisconnected(appId);
    expect(deviceLines('waiting for its twin')).toHaveLength(1);
    logcat('after the disconnect');
    expect(deviceLines('after the disconnect')).toHaveLength(1);
  });
});
