/**
 * Apps that connect over Wi-Fi without naming their device (React Native on an iPhone sends only "iPhone"):
 * tied to the plugged-in device that runs the app, and otherwise one row per phone, not one for all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceHints, DeviceInfo } from '@durbun/protocol';
import { findDeviceRunningApp, lanAddress, RECENT_APP_ACTIVITY_MS, resolveDevice } from '../../src/sdk/devices';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import type { Hub, SdkAttachMeta, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { device, hello as helloMsg, makeHub, makeSettings, sleep, waitFor } from '../hub/helpers';

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

describe('a network session moves once a driver reports its phone', () => {
  const layers: SdkLayer[] = [];
  afterEach(async () => {
    for (const l of layers.splice(0)) await l.close();
  });

  function layer(h: Hub): SdkLayer {
    const l = createSdkLayerWithTimings({ hub: h, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.3.0' });
    layers.push(l);
    return l;
  }

  async function connectRn(l: SdkLayer, meta: SdkAttachMeta = lanA, session = 'launch-1') {
    const v = l.openVirtual(meta);
    v.send(helloMsg({ device: rnIphone, session, app: { name: 'Pati', id: BUNDLE } }));
    return { v, appId: await v.appId };
  }

  it('moves to the one plugged-in iPhone that later runs the app; the empty network row disappears', async () => {
    setup([iphone('D1', 'Yusuf’s iPhone')]);
    const l = layer(hub);
    const { appId } = await connectRn(l);
    const netId = hub.getApp(appId)!.deviceId;
    expect(netId).toMatch(/^net:/);

    hub.upsertDeviceApp({ deviceId: 'ios:D1', id: BUNDLE, running: true, pids: [501], lastActivity: Date.now() });
    await waitFor(() => hub.getApp(appId)?.deviceId === 'ios:D1');
    await waitFor(() => !hub.getDevice(netId));
    expect(hub.getLogs().some((e) => e.deviceId === netId)).toBe(false);
    const moved = hub.getLogs().find((e) => e.code === 'app.deviceFound');
    expect(moved).toMatchObject({ deviceId: 'ios:D1', appId, params: { app: 'Pati', device: 'Yusuf’s iPhone', from: netId } });

    // Later data goes to the phone; the session's disconnect does not resurrect the network row.
    hub.pushAppLog(appId, { ts: Date.now(), level: 'info', message: 'on the phone' });
    expect(hub.getLogs().find((e) => e.message === 'on the phone')?.deviceId).toBe('ios:D1');
  });

  it('keeps a network row that already holds the session data (offline, as history)', async () => {
    setup([iphone('D1', 'A')]);
    const l = layer(hub);
    const { v, appId } = await connectRn(l);
    const netId = hub.getApp(appId)!.deviceId;
    v.send({ type: 'log', ts: Date.now(), level: 'info', message: 'before the move' });
    hub.upsertDeviceApp({ deviceId: 'ios:D1', id: BUNDLE, running: true, pids: [501], lastActivity: Date.now() });
    await waitFor(() => hub.getApp(appId)?.deviceId === 'ios:D1');
    await waitFor(() => hub.getDevice(netId)?.state === 'disconnected');
    expect(hub.getLogs().find((e) => e.message === 'before the move')?.deviceId).toBe(netId);
  });

  it('never guesses: two phones running it, or another app, leave the session where it is', async () => {
    setup([iphone('D1', 'A'), iphone('D2', 'B')]);
    const l = layer(hub);
    const { appId } = await connectRn(l);
    const netId = hub.getApp(appId)!.deviceId;
    hub.upsertDeviceApp({ deviceId: 'ios:D1', id: 'com.other.app', running: true, pids: [7], lastActivity: Date.now() });
    await sleep(50);
    expect(hub.getApp(appId)!.deviceId).toBe(netId);
    hub.upsertDeviceApp({ deviceId: 'ios:D1', id: BUNDLE, running: true, pids: [501], lastActivity: Date.now() });
    hub.upsertDeviceApp({ deviceId: 'ios:D2', id: BUNDLE, running: true, pids: [502], lastActivity: Date.now() });
    await sleep(200);
    expect(hub.getApp(appId)!.deviceId).toBe(netId);
    expect(hub.getDevice(netId)?.state).toBe('online');
  });

  it('a second session on the same network row keeps it online after the first moves', async () => {
    setup([iphone('D1', 'A')]);
    const l = layer(hub);
    const first = await connectRn(l);
    const netId = hub.getApp(first.appId)!.deviceId;
    const v2 = l.openVirtual(lanA);
    v2.send(helloMsg({ device: rnIphone, session: 'launch-2', app: { name: 'Mahalle', id: 'com.mykynk.mahalle' } }));
    const second = await v2.appId;
    expect(hub.getApp(second)!.deviceId).toBe(netId);
    hub.upsertDeviceApp({ deviceId: 'ios:D1', id: BUNDLE, running: true, pids: [501], lastActivity: Date.now() });
    await waitFor(() => hub.getApp(first.appId)?.deviceId === 'ios:D1');
    await sleep(30);
    expect(hub.getDevice(netId)?.state).toBe('online');
    expect(hub.getApp(second)!.deviceId).toBe(netId);
  });
});
