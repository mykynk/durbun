/** /api/android/wireless against the real HTTP app, with a fake adb behind the Android driver. */
import { afterEach, describe, expect, it } from 'vitest';
import type { AdbWirelessResult, AdbWirelessState, DeviceInfo } from '@durbun/protocol';
import type { RunResult } from '../../src/platform/exec';
import { AdbWireless } from '../../src/platform/android/wireless';
import { isServiceConnected } from '../../src/http/androidWireless';
import { FakeDriver, sampleDevice, startTestApp, type TestApp } from './fakes';

const res = (stdout: string, stderr = '', ok = true): RunResult<string> => ({ ok, code: ok ? 0 : 1, signal: null, timedOut: false, stdout, stderr });

const MDNS = 'List of discovered mdns services\nadb-R5CT20XK9QM-x7Kp2a\t_adb-tls-pairing._tcp\t192.168.1.20:37099\nadb-R5CT20XK9QM-x7Kp2a\t_adb-tls-connect._tcp\t192.168.1.20:41235\n';

function wirelessDriver(reply: (args: string[]) => RunResult<string>, calls: string[][] = []) {
  const d = new FakeDriver('android', 'android:') as FakeDriver & { wireless(): AdbWireless | undefined; adbMissing?: boolean };
  d.wireless = () => (d.adbMissing ? undefined : new AdbWireless({ run: async (args: string[]) => (calls.push(args), reply(args)) }));
  return d;
}

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const post = (path: string, body: unknown) => fetch(`${app!.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/android/wireless', () => {
  it('lists phones advertising wireless debugging; marks one adb already has over Wi-Fi', async () => {
    app = await startTestApp({ drivers: [wirelessDriver(() => res(MDNS))] });
    app.hub.devices.set('android:R5CT20XK9QM', { ...sampleDevice('android:R5CT20XK9QM'), hardwareSerial: 'R5CT20XK9QM', connection: 'wifi', connections: ['wifi'] } as DeviceInfo);
    const r = await fetch(`${app.base}/api/android/wireless`);
    expect(r.status).toBe(200);
    const state = (await r.json()) as AdbWirelessState;
    expect(state).toEqual({
      adb: true,
      discovery: 'ok',
      services: [
        { name: 'adb-R5CT20XK9QM-x7Kp2a', kind: 'pairing', host: '192.168.1.20', port: 37099, serial: 'R5CT20XK9QM' },
        { name: 'adb-R5CT20XK9QM-x7Kp2a', kind: 'connect', host: '192.168.1.20', port: 41235, serial: 'R5CT20XK9QM', connected: true },
      ],
    });
  });

  it('pair: pairs, finds the connect service on the same address and connects', async () => {
    const calls: string[][] = [];
    const d = wirelessDriver((args) => {
      if (args[0] === 'pair') return res('Successfully paired to 192.168.1.20:37099 [guid=adb-R5CT20XK9QM-x7Kp2a]\n');
      if (args[0] === 'connect') return res('connected to 192.168.1.20:41235\n');
      return res(MDNS);
    }, calls);
    app = await startTestApp({ drivers: [d] });
    const r = await post('/api/android/wireless/pair', { host: '192.168.1.20', port: '37099', code: '123 456' });
    expect(r.status).toBe(200);
    expect((await r.json()) as AdbWirelessResult).toEqual({
      ok: true,
      code: 'adb.wireless.paired',
      message: 'Paired with 192.168.1.20:37099',
      address: '192.168.1.20:37099',
      serial: '192.168.1.20:41235',
      connected: { ok: true, address: '192.168.1.20:41235', code: 'adb.wireless.connected', message: 'Connected to 192.168.1.20:41235' },
    });
    expect(calls).toEqual([['pair', '192.168.1.20:37099', '123456'], ['mdns', 'services'], ['connect', '192.168.1.20:41235']]);
  }, 10_000);

  it('a wrong code is a 200 with the code; bad input is a 400; no adb is a 503', async () => {
    const d = wirelessDriver(() => res('', 'Failed: Wrong password or connection was dropped.\n', false));
    app = await startTestApp({ drivers: [d] });
    expect(await (await post('/api/android/wireless/pair', { host: '192.168.1.20', port: 37099, code: '000000' })).json()).toMatchObject({ ok: false, code: 'adb.wireless.wrongCode' });
    for (const [body, param] of [
      [{ host: '-k', port: 1, code: '123456' }, 'host'],
      [{ host: '192.168.1.20', port: 0, code: '123456' }, 'port'],
      [{ host: '192.168.1.20', port: 37099, code: '12345' }, 'code'],
      [{ host: '192.168.1.20; rm -rf /', port: 37099, code: '123456' }, 'host'],
    ] as const) {
      const r = await post('/api/android/wireless/pair', body);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'action.invalidParams', params: { param } });
    }
    expect((await post('/api/android/wireless/pair', [1])).status).toBe(400);
    expect((await fetch(`${app.base}/api/android/wireless/pair`)).status).toBe(405);
    expect((await fetch(`${app.base}/api/android/wireless/other`, { method: 'POST' })).status).toBe(404);
    d.adbMissing = true;
    const none = await post('/api/android/wireless/connect', { host: '192.168.1.20', port: 41235 });
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ code: 'action.toolMissing', params: { tool: 'adb' } });
    expect(await (await fetch(`${app.base}/api/android/wireless`)).json()).toEqual({ adb: false, discovery: 'unavailable', services: [] });
  });

  it('connect', async () => {
    app = await startTestApp({ drivers: [wirelessDriver(() => res('failed to authenticate to 192.168.1.20:41235\n'))] });
    expect(await (await post('/api/android/wireless/connect', { host: '[192.168.1.20]', port: 41235 })).json()).toMatchObject({
      ok: false,
      code: 'adb.wireless.notPaired',
      address: '192.168.1.20:41235',
    });
  });

  it('isServiceConnected: by address, by mDNS serial, by hardware serial over Wi-Fi only', () => {
    const svc = { name: 'adb-R5CT-x7Kp2a', kind: 'connect' as const, host: '192.168.1.20', port: 41235, serial: 'R5CT' };
    const dev = (patch: Partial<DeviceInfo>) => ({ ...sampleDevice('android:R5CT'), ...patch }) as DeviceInfo;
    expect(isServiceConnected(svc, [dev({ serial: '192.168.1.20:41235' })])).toBe(true);
    expect(isServiceConnected(svc, [dev({ serial: 'adb-R5CT-x7Kp2a._adb-tls-connect._tcp' })])).toBe(true);
    expect(isServiceConnected(svc, [dev({ serial: 'R5CT', hardwareSerial: 'R5CT', connection: 'usb', connections: ['usb'] })])).toBe(false);
    expect(isServiceConnected({ ...svc, kind: 'pairing' }, [dev({ serial: '192.168.1.20:41235' })])).toBe(false);
  });
});
