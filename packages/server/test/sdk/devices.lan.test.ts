/**
 * Apps that connect over Wi-Fi without naming their device (React Native on an iPhone sends only "iPhone"):
 * tied to the plugged-in device that runs the app, and otherwise one row per phone, not one for all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceHints, DeviceInfo } from '@durbun/protocol';
import { findDeviceRunningApp, lanAddress, RECENT_APP_ACTIVITY_MS, resolveDevice } from '../../src/sdk/devices';
import type { Hub, SdkAttachMeta } from '../../src/types';
import { device, makeHub } from '../hub/helpers';

const BUNDLE = 'com.mykynk.pati';
const lanA: SdkAttachMeta = { transport: 'websocket', remote: '::ffff:192.168.1.42:50125' };
const lanB: SdkAttachMeta = { transport: 'websocket', remote: '192.168.1.57:50311' };
const rnIphone: DeviceHints = { platform: 'ios', name: 'iPhone', osVersion: '18.1', isPhysical: true };

const iphone = (udid: string, name: string, patch: Partial<DeviceInfo> = {}) =>
  device(`ios:${udid}`, { platform: 'ios', kind: 'physical', model: 'iPhone 15 Pro', name, logs: { status: 'streaming', via: 'syslog' }, ...patch });

let hub: Hub;
afterEach(() => hub?.dispose());

function setup(devices: DeviceInfo[], apps: Array<{ deviceId: string; id?: string; running?: boolean; lastActivity?: number }> = []) {
  hub = makeHub();
  for (const d of devices) hub.upsertDevice(d);
  for (const a of apps) hub.upsertDeviceApp({ deviceId: a.deviceId, id: a.id ?? BUNDLE, running: a.running ?? false, pids: a.running ? [501] : [], lastActivity: a.lastActivity ?? 0 });
  return hub;
}

describe('a Wi-Fi session on a known device', () => {
  it('attaches to the one plugged-in iPhone that runs the app', () => {
    setup([iphone('D1', 'Yusuf’s iPhone'), iphone('D2', 'Test iPhone')], [{ deviceId: 'ios:D1', running: true }, { deviceId: 'ios:D2', running: false }]);
    expect(resolveDevice(hub, rnIphone, lanA, BUNDLE)).toEqual({ deviceId: 'ios:D1', network: false });
  });

  it('a launch seen in the device log counts, an old one does not', () => {
    const now = Date.now();
    setup([iphone('D1', 'A')], [{ deviceId: 'ios:D1', lastActivity: now - 5_000 }]);
    expect(resolveDevice(hub, rnIphone, lanA, BUNDLE).deviceId).toBe('ios:D1');
    hub.dispose();
    setup([iphone('D1', 'A')], [{ deviceId: 'ios:D1', lastActivity: now - RECENT_APP_ACTIVITY_MS - 1_000 }]);
    expect(resolveDevice(hub, rnIphone, lanA, BUNDLE).network).toBe(true);
  });

  it('never guesses: two devices running the app, another app, a simulator or an offline device do not match', () => {
    const devices = [iphone('D1', 'A'), iphone('D2', 'B'), iphone('D3', 'C', { state: 'offline' }), device('ios-sim:S1', { platform: 'ios', kind: 'simulator', name: 'iPhone 16' })];
    const apps = (list: Array<{ deviceId: string; id?: string; running?: boolean }>) =>
      list.map((a) => ({ key: `${a.deviceId}|${a.id ?? BUNDLE}`, deviceId: a.deviceId, id: a.id ?? BUNDLE, running: a.running ?? true, pids: [], lastActivity: 0, buildType: 'debug', install: { source: 'unknown' } }) as never);
    expect(findDeviceRunningApp(devices, apps([{ deviceId: 'ios:D1' }, { deviceId: 'ios:D2' }]), rnIphone, BUNDLE, 'websocket')).toBeUndefined();
    expect(findDeviceRunningApp(devices, apps([{ deviceId: 'ios:D1', id: 'com.other.app' }]), rnIphone, BUNDLE, 'websocket')).toBeUndefined();
    expect(findDeviceRunningApp(devices, apps([{ deviceId: 'ios-sim:S1' }]), rnIphone, BUNDLE, 'websocket')).toBeUndefined();
    expect(findDeviceRunningApp(devices, apps([{ deviceId: 'ios:D3' }]), rnIphone, BUNDLE, 'websocket')).toBeUndefined();
    expect(findDeviceRunningApp(devices, apps([{ deviceId: 'ios:D2' }]), rnIphone, undefined, 'websocket')).toBeUndefined();
    expect(findDeviceRunningApp(devices, apps([{ deviceId: 'ios:D2' }]), rnIphone, BUNDLE, 'websocket')?.id).toBe('ios:D2');
  });

  it('works for Android phones of the same model too', () => {
    const twins = [device('android:R1', { model: 'SM-A736B', name: 'Galaxy A73' }), device('android:R2', { model: 'SM-A736B', name: 'Galaxy A73' })];
    setup(twins, [{ deviceId: 'android:R2', running: true }]);
    expect(resolveDevice(hub, { platform: 'android', model: 'SM-A736B', isPhysical: true }, { transport: 'websocket', remote: '127.0.0.1:5000' }, BUNDLE).deviceId).toBe('android:R2');
  });
});

describe('Wi-Fi sessions without a known device', () => {
  it('two iPhones that only say "iPhone" are two rows, named with their address', () => {
    setup([]);
    const a = resolveDevice(hub, rnIphone, lanA, BUNDLE);
    const b = resolveDevice(hub, rnIphone, lanB, BUNDLE);
    expect(a).toEqual({ deviceId: 'net:ios-unknown-iphone-at-192-168-1-42', network: true });
    expect(b.deviceId).toBe('net:ios-unknown-iphone-at-192-168-1-57');
    expect(hub.getDevice(a.deviceId)).toMatchObject({ name: 'iPhone (192.168.1.42)', connection: 'wifi', kind: 'physical' });
    // The same phone reconnecting keeps its row.
    expect(resolveDevice(hub, rnIphone, { ...lanA, remote: '::ffff:192.168.1.42:60000' }, BUNDLE).deviceId).toBe(a.deviceId);
  });

  it('a specific device name keeps the plain key (it already tells phones apart)', () => {
    setup([]);
    expect(resolveDevice(hub, { ...rnIphone, name: 'Yusuf’s iPhone', model: 'iPhone16,2' }, lanA, BUNDLE).deviceId).toBe('net:ios-iphone16-2-yusuf-s-iphone');
  });

  it('LAN addresses', () => {
    expect(lanAddress('::ffff:192.168.1.42:50125')).toBe('192.168.1.42');
    expect(lanAddress('192.168.1.42:50125')).toBe('192.168.1.42');
    expect(lanAddress('[fe80::1c2:3]:50125')).toBe('fe80::1c2:3');
    expect(lanAddress('127.0.0.1:5000')).toBeUndefined();
    expect(lanAddress(undefined)).toBeUndefined();
  });
});
