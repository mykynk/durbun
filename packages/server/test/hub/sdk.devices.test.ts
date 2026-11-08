/**
 * Device resolution for hellos without a transport-known device (generic TCP listener / WebSocket):
 * the hints of the real SDKs (Flutter, Android, iOS, React Native) must attach to the right online device
 * — and never to a wrong one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceHints, DeviceInfo } from '@durbun/protocol';
import { findUniqueDevice, modelKey, nameKey, resolveDevice } from '../../src/sdk/devices';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import type { Hub, SdkAttachMeta, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { device, freePort, hello, makeHub, makeSettings, NdjsonClient } from './helpers';

const tcp: SdkAttachMeta = { transport: 'tcp', remote: '127.0.0.1:50123' };
const ws: SdkAttachMeta = { transport: 'websocket', remote: '::ffff:127.0.0.1:50124' };
const lan: SdkAttachMeta = { transport: 'tcp', remote: '192.168.1.42:50125' };

const emulator = (id: string, patch: Partial<DeviceInfo> = {}) =>
  device(`android:${id}`, { kind: 'emulator', connection: 'local', model: 'sdk_gphone64_arm64', name: 'Pixel 8 API 35', ...patch });
const simulator = (udid: string, name: string, patch: Partial<DeviceInfo> = {}) =>
  device(`ios-sim:${udid}`, { platform: 'ios', kind: 'simulator', connection: 'local', model: 'iPhone 16 Pro', name, ...patch });
const iphone = (udid: string, name: string, patch: Partial<DeviceInfo> = {}) =>
  device(`ios:${udid}`, { platform: 'ios', kind: 'physical', model: 'iPhone 15 Pro', name, ...patch });

let hub: Hub;
afterEach(() => hub?.dispose());

function resolve(devices: DeviceInfo[], hints: DeviceHints, meta: SdkAttachMeta = tcp) {
  hub = makeHub();
  for (const d of devices) hub.upsertDevice(d);
  return resolveDevice(hub, hints, meta);
}

describe('device resolution keys', () => {
  it('compares models without case/separators and names without punctuation/apostrophe style', () => {
    expect(modelKey('sdk gphone64 arm64')).toBe(modelKey('sdk_gphone64_arm64'));
    expect(modelKey('SM-S921B')).toBe(modelKey('sm s921b'));
    expect(nameKey('Yusuf’s iPhone')).toBe(nameKey("yusuf's iphone"));
    expect(nameKey("Yusuf'un iPhone'u")).toBe('yusufuniphoneu');
  });
});

describe('Android hints (adb reverse missing, emulator 10.0.2.2, React Native over WS)', () => {
  it('attaches to the only online device with that Build.MODEL', () => {
    const r = resolve([emulator('emulator-5554'), device('android:R5CT', { model: 'SM-S921B', name: 'Galaxy S24' })], {
      platform: 'android',
      model: 'sdk_gphone64_arm64',
      name: 'sdk_gphone64_arm64',
      isPhysical: false,
    });
    expect(r).toEqual({ deviceId: 'android:emulator-5554', network: false });
  });

  it('matches the humanized model adb reports before getprop arrives', () => {
    const r = resolve([emulator('emulator-5554', { model: 'sdk gphone64 arm64' })], { platform: 'android', model: 'sdk_gphone64_arm64' });
    expect(r.deviceId).toBe('android:emulator-5554');
  });

  it('React Native hints (platform/model/osVersion/isPhysical, no name) attach by model', () => {
    const r = resolve([device('android:R5CT', { model: 'Pixel 8', name: "Yusuf's Pixel" })], { platform: 'android', model: 'Pixel 8', osVersion: '15', isPhysical: true }, ws);
    expect(r.deviceId).toBe('android:R5CT');
  });

  it('two online devices of the same model: only a matching device name decides', () => {
    const twins = [device('android:A1', { model: 'Pixel 8', name: "Yusuf's Pixel" }), device('android:B2', { model: 'Pixel 8', name: 'Test Pixel' })];
    expect(resolve(twins, { platform: 'android', model: 'Pixel 8', isPhysical: true }).deviceId).toBe('net:android-pixel-8-unknown');
    expect(resolve(twins, { platform: 'android', model: 'Pixel 8', name: 'Test Pixel', isPhysical: true }).deviceId).toBe('android:B2');
    // Default names are equal too: still ambiguous.
    const defaults = [device('android:A1', { model: 'Pixel 8', name: 'Pixel 8' }), device('android:B2', { model: 'Pixel 8', name: 'Pixel 8' })];
    expect(resolve(defaults, { platform: 'android', model: 'Pixel 8', name: 'Pixel 8' }).network).toBe(true);
  });

  it('never attaches to offline devices, other platforms, demo devices or by name alone', () => {
    expect(resolve([device('android:R5CT', { state: 'offline' })], { platform: 'android', model: 'Pixel 8' }).network).toBe(true);
    expect(resolve([simulator('S1', 'Pixel 8', { model: 'Pixel 8' })], { platform: 'android', model: 'Pixel 8' }).network).toBe(true);
    expect(resolve([device('demo:1', { kind: 'virtual', model: 'Pixel 8' })], { platform: 'android', model: 'Pixel 8' }).network).toBe(true);
    expect(resolve([device('android:R5CT', { model: 'SM-S921B', name: 'Pixel 8' })], { platform: 'android', model: 'Pixel 8', name: 'Pixel 8' }).network).toBe(true);
  });

  it('an emulator hint never lands on a physical device (and vice versa)', () => {
    expect(resolve([device('android:R5CT', { model: 'sdk_gphone64_arm64' })], { platform: 'android', model: 'sdk_gphone64_arm64', isPhysical: false }).network).toBe(true);
    expect(resolve([emulator('emulator-5554')], { platform: 'android', model: 'sdk_gphone64_arm64', isPhysical: true }).network).toBe(true);
  });
});

describe('iOS hints', () => {
  it('simulatorUdid → ios-sim:<udid> (placeholder kind simulator until the driver reports it)', () => {
    const r = resolve([], { platform: 'ios', simulatorUdid: '7F1E2D3C-AAAA-BBBB-CCCC-000011112222', isPhysical: false });
    expect(r).toEqual({ deviceId: 'ios-sim:7F1E2D3C-AAAA-BBBB-CCCC-000011112222', network: false, placeholder: true });
    expect(hub.getDevice(r.deviceId)).toMatchObject({ kind: 'simulator', platform: 'ios', connection: 'local' });
    // A simulator the driver reports is no placeholder.
    expect(resolve([simulator('S1', 'iPhone 16 Pro')], { platform: 'ios', simulatorUdid: 'S1', isPhysical: false })).toEqual({ deviceId: 'ios-sim:S1', network: false });
  });

  it('isPhysical false without a udid (React Native) → the only booted simulator', () => {
    const r = resolve([simulator('S1', 'iPhone 16 Pro'), iphone('D1', "Yusuf's iPhone")], { platform: 'ios', osVersion: '18.2', isPhysical: false }, ws);
    expect(r).toEqual({ deviceId: 'ios-sim:S1', network: false });
  });

  it('several booted simulators, a LAN connection or a contradicting name → its own net device', () => {
    const two = [simulator('S1', 'iPhone 16 Pro'), simulator('S2', 'iPad Air')];
    expect(resolve(two, { platform: 'ios', isPhysical: false }, ws).network).toBe(true);
    expect(resolve(two, { platform: 'ios', name: 'iPad Air', isPhysical: false }, ws).deviceId).toBe('ios-sim:S2');
    expect(resolve([simulator('S1', 'iPhone 16 Pro')], { platform: 'ios', isPhysical: false }, lan).network).toBe(true);
    expect(resolve([simulator('S1', 'iPhone 16 Pro')], { platform: 'ios', name: 'iPhone 15', isPhysical: false }, ws).network).toBe(true);
  });

  it('a physical iPhone over Wi-Fi attaches only by a user-given name, never by the generic "iPhone"', () => {
    const usb = [iphone('D1', 'Yusuf’s iPhone'), iphone('D2', 'iPhone')];
    expect(resolve(usb, { platform: 'ios', model: 'iPhone16,1', name: "Yusuf's iPhone", isPhysical: true }, lan).deviceId).toBe('ios:D1');
    expect(resolve(usb, { platform: 'ios', model: 'iPhone16,1', name: 'iPhone', isPhysical: true }, lan).network).toBe(true);
    expect(resolve([iphone('D1', 'Test iPhone', { model: 'iPhone16,1' })], { platform: 'ios', model: 'iPhone16,1', isPhysical: true }, lan).network).toBe(true);
    // iOS SDK on an iPhone without a name hint, RN on an iPhone (isPhysical unknown): no guess.
    expect(resolve(usb, { platform: 'ios', isPhysical: true }, lan).network).toBe(true);
    expect(resolve([iphone('D1', 'Yusuf’s iPhone')], { platform: 'ios' }, lan).network).toBe(true);
  });
});

describe('net: devices', () => {
  it('keep the kind the SDK reports and stay platform-specific', () => {
    expect(resolve([], { platform: 'ios', isPhysical: false }, ws)).toEqual({ deviceId: 'net:ios-unknown-unknown', network: true });
    expect(hub.getDevice('net:ios-unknown-unknown')).toMatchObject({ kind: 'simulator', connection: 'local', logs: { status: 'unavailable', code: 'logs.networkOnly' } });
    resolve([], { platform: 'android', model: 'sdk_gphone64_arm64', isPhysical: false });
    expect(hub.getDevice('net:android-sdk-gphone64-arm64-unknown')).toMatchObject({ kind: 'emulator' });
    resolve([], { platform: 'other', model: 'Mac16,7', name: 'Studio Mac', osVersion: 'macOS 27.2', isPhysical: true }, lan);
    expect(hub.getDevice('net:other-mac16-7-studio-mac')).toMatchObject({ kind: 'physical', connection: 'wifi' });
    // The English fallback reads naturally for desktops/other runtimes too (no "device macOS 27.2").
    expect(hub.getLogs().find((l) => l.code === 'device.connected')!.message).toBe('Device connected: Studio Mac (macOS 27.2)');
  });

  it('findUniqueDevice ignores everything but the platform pool', () => {
    const pool = [device('net:android-pixel-8-x'), device('import:1'), device('desktop', { platform: 'android' })];
    expect(findUniqueDevice(pool, { platform: 'android', model: 'Pixel 8' }, 'tcp')).toBeUndefined();
  });
});

describe('driverless simulator placeholders', () => {
  let sdk: SdkLayer | undefined;
  const clients: NdjsonClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await sdk?.close();
    sdk = undefined;
  });

  async function layer(devices: DeviceInfo[] = []) {
    hub = makeHub();
    for (const d of devices) hub.upsertDevice(d);
    sdk = createSdkLayerWithTimings({ hub, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.1.0' });
    const port = await freePort();
    await sdk.listen(port, '127.0.0.1');
    return async (session: string) => {
      const c = await NdjsonClient.connect(port);
      clients.push(c);
      c.send(hello({ session, device: { platform: 'ios', model: 'iPhone17,1', name: 'iPhone 16 Pro', isPhysical: false, simulatorUdid: 'AAAA1111-2222-3333-4444-555566667777' } }));
      await c.next('welcome');
      return c;
    };
  }
  const ID = 'ios-sim:AAAA1111-2222-3333-4444-555566667777';
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('goes offline with its last app like a net: device, and comes back with the next one', async () => {
    const open = await layer();
    const a = await open('launch-1');
    const b = await open('launch-2');
    expect(hub.getDevice(ID)?.state).toBe('online');
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.getDevice(ID)?.state).toBe('online'); // b is still there
    b.close();
    await until(() => hub.getDevice(ID)?.state === 'disconnected');
    expect(hub.getDevice(ID)).toMatchObject({ state: 'disconnected', stateCode: 'device.sdkIdle' });
    await open('launch-3');
    expect(hub.getDevice(ID)?.state).toBe('online');
  });

  it('is left to the simulator driver once it reported the simulator', async () => {
    const open = await layer();
    const a = await open('launch-1');
    hub.upsertDevice(simulator('AAAA1111-2222-3333-4444-555566667777', 'iPhone 16 Pro', { logs: { status: 'streaming', via: 'simctl log stream' }, actions: ['screenshot'] }));
    a.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(hub.getDevice(ID)?.state).toBe('online');
  });
});

describe('deviceLogsAvailable in welcome / config', () => {
  let sdk: SdkLayer | undefined;
  const clients: NdjsonClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await sdk?.close();
    sdk = undefined;
  });

  async function start(devices: DeviceInfo[]) {
    hub = makeHub();
    for (const d of devices) hub.upsertDevice(d);
    sdk = createSdkLayerWithTimings({ hub, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.1.0' });
    const port = await freePort();
    await sdk.listen(port, '127.0.0.1');
    const c = await NdjsonClient.connect(port);
    clients.push(c);
    return c;
  }

  it('is false on a net: device and true only while the attached device streams logs', async () => {
    const lanApp = await start([]);
    lanApp.send(hello({ device: { platform: 'ios', model: 'iPhone16,1', name: 'iPhone', isPhysical: true } }));
    expect((await lanApp.next('welcome')).config.deviceLogsAvailable).toBe(false);
    await sdk!.close();
    hub.dispose();

    const c = await start([emulator('emulator-5554', { logs: { status: 'error', via: 'logcat', detail: 'logcat exited' } })]);
    c.send(hello({ device: { platform: 'android', model: 'sdk_gphone64_arm64', isPhysical: false } }));
    const welcome = await c.next('welcome');
    expect(hub.getApp(welcome.appId)!.deviceId).toBe('android:emulator-5554');
    expect(welcome.config.deviceLogsAvailable).toBe(false);
    hub.patchDevice('android:emulator-5554', { logs: { status: 'streaming', via: 'logcat' } });
    expect((await c.next('config')).config.deviceLogsAvailable).toBe(true);
    hub.patchDevice('android:emulator-5554', { logs: { status: 'stopped', via: 'logcat' } });
    await new Promise((r) => setTimeout(r, 250));
    expect(c.all('config').map((m) => m.config.deviceLogsAvailable)).toEqual([true, false]);
  });
});
