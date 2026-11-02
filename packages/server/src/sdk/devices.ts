/**
 * Which device does a new SDK session belong to? (SPEC §5.3)
 *   1. the transport knows (adb reverse per-device port, usbmux): meta.deviceId
 *   2. iOS simulator: hello.device.simulatorUdid → ios-sim:<udid>
 *   3. an online device the hints identify without ambiguity (see `findUniqueDevice`)
 *   4. otherwise a `net:<platform>-<model>-<name>` device (LAN SDK without a known device)
 * A wrong attachment is worse than none: when in doubt the session gets its own `net:` device.
 */
import type { DeviceHints, DeviceInfo, Transport } from '@durbun/protocol';
import type { HubSink, SdkAttachMeta } from '../types';

export const NET_DEVICE_PREFIX = 'net:';

export interface DeviceLookup {
  getDevice(id: string): DeviceInfo | undefined;
  getDevices(): DeviceInfo[];
}

export interface ResolvedDevice {
  deviceId: string;
  /** A `net:` device whose online state follows its SDK sessions. */
  network: boolean;
}

/** Lower-case ASCII slug ("Yusuf'un iPhone'u" → "yusuf-un-iphone-u"). */
export function slug(value: string | undefined): string {
  if (!value) return 'unknown';
  const s = value
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'unknown';
}

export function isLoopback(remote: string | undefined): boolean {
  if (!remote) return false;
  const host = remote.replace(/^\[/, '').replace(/\](:\d+)?$/, '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1' || host === 'localhost' || host.startsWith('127.');
}

function platformFromId(id: string, hints: DeviceHints): DeviceInfo['platform'] {
  if (id.startsWith('android:')) return 'android';
  if (id.startsWith('ios:') || id.startsWith('ios-sim:')) return 'ios';
  return hints.platform;
}

function kindFromId(id: string, hints: DeviceHints): DeviceInfo['kind'] {
  if (id.startsWith('ios-sim:')) return 'simulator';
  if (id.startsWith('android:emulator-')) return 'emulator';
  if (id.startsWith('demo:') || id.startsWith('import:') || id === 'desktop') return 'virtual';
  if (hints.isPhysical === false) return hints.platform === 'ios' ? 'simulator' : 'emulator';
  return 'physical';
}

/** Placeholder for a device the platform driver has not reported yet (the driver's upsert replaces it). */
function placeholderDevice(id: string, hints: DeviceHints, meta: SdkAttachMeta, now: number): DeviceInfo {
  const kind = kindFromId(id, hints);
  const device: DeviceInfo = {
    id,
    platform: platformFromId(id, hints),
    kind,
    name: hints.name || hints.model || id,
    connection: kind === 'simulator' || kind === 'emulator' ? 'local' : meta.transport === 'adb-reverse' || meta.transport === 'usbmux' ? 'usb' : 'unknown',
    state: 'online',
    logs: { status: 'stopped' },
    actions: [],
    firstSeen: now,
    lastSeen: now,
  };
  if (hints.model) device.model = hints.model;
  if (hints.manufacturer) device.manufacturer = hints.manufacturer;
  if (hints.osVersion) device.osVersion = hints.osVersion;
  if (hints.apiLevel !== undefined) device.apiLevel = hints.apiLevel;
  return device;
}

/** Model identifiers compare without case or separators: adb's `sdk_gphone64_arm64` (humanized to
 * "sdk gphone64 arm64" until getprop arrives) is the SDK's `Build.MODEL` "sdk_gphone64_arm64". */
export function modelKey(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Device names compare without case, spacing or apostrophe style ("Yusuf’s iPhone" = "yusuf's iphone"). */
export function nameKey(s: string | undefined): string {
  return (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Names that do not tell devices apart: iOS 16+ reports plain "iPhone"/"iPad" to every app. */
const GENERIC_NAMES = new Set(['iphone', 'ipad', 'ipod', 'ipodtouch', 'android', 'phone', 'tablet', 'localhost', 'unknown']);

function excludedFromMatching(device: DeviceInfo, transport: Transport): boolean {
  if (device.id.startsWith(NET_DEVICE_PREFIX) || device.id.startsWith('import:') || device.id === 'desktop') return true;
  if (device.id.startsWith('demo:')) return transport !== 'demo';
  return device.kind === 'virtual' && !device.id.startsWith('demo:');
}

const only = (list: DeviceInfo[]): DeviceInfo | undefined => (list.length === 1 ? list[0] : undefined);

/**
 * The online device a hello without a transport-known device belongs to, or undefined when the hints do
 * not single one out:
 *  - Android (adb reverse not set up yet, emulator via 10.0.2.2, React Native over WS through
 *    `adb reverse tcp:9750`): `Build.MODEL` = `ro.product.model` = DeviceInfo.model, unique among the
 *    online Android devices (same physical/emulator kind when the SDK says); several of that model → the
 *    one whose name also matches, else none.
 *  - iOS simulator without SIMULATOR_UDID (React Native): the only booted simulator (a simulator shares
 *    this Mac's loopback, so a LAN connection never is one); a non-generic name must not contradict it.
 *  - iOS device over Wi-Fi: only a user-given device name identifies it (the SDK's model identifier
 *    "iPhone16,2" is not the driver's marketing name, and iOS 16+ reports the generic "iPhone").
 */
export function findUniqueDevice(
  devices: DeviceInfo[],
  hints: DeviceHints,
  transport: Transport,
  remote?: string,
): DeviceInfo | undefined {
  let pool = devices.filter((d) => d.state === 'online' && d.platform === hints.platform && !excludedFromMatching(d, transport));
  if (hints.isPhysical !== undefined) pool = pool.filter((d) => (d.kind === 'physical') === hints.isPhysical);
  if (pool.length === 0) return undefined;
  const model = modelKey(hints.model);
  const name = nameKey(hints.name);
  const specificName = name && !GENERIC_NAMES.has(name) ? name : '';
  const named = (list: DeviceInfo[]) => list.filter((d) => nameKey(d.name) === specificName);

  if (hints.platform === 'android') {
    if (!model) return undefined;
    const byModel = pool.filter((d) => modelKey(d.model) === model);
    if (byModel.length <= 1) return byModel[0];
    return specificName ? only(named(byModel)) : undefined;
  }
  if (hints.platform === 'ios') {
    if (hints.isPhysical === false) {
      if (remote && !isLoopback(remote)) return undefined;
      return only(specificName ? named(pool) : pool);
    }
    return specificName ? only(named(pool)) : undefined;
  }
  return undefined;
}

function netDeviceKind(hints: DeviceHints): DeviceInfo['kind'] {
  if (hints.isPhysical !== false) return 'physical';
  return hints.platform === 'ios' ? 'simulator' : hints.platform === 'android' ? 'emulator' : 'physical';
}

export function resolveDevice(hub: HubSink & DeviceLookup, hints: DeviceHints, meta: SdkAttachMeta): ResolvedDevice {
  const now = Date.now();
  if (meta.deviceId) {
    if (!hub.getDevice(meta.deviceId)) hub.upsertDevice(placeholderDevice(meta.deviceId, hints, meta, now));
    return { deviceId: meta.deviceId, network: meta.deviceId.startsWith(NET_DEVICE_PREFIX) };
  }
  if (hints.simulatorUdid) {
    const id = `ios-sim:${hints.simulatorUdid}`;
    if (!hub.getDevice(id)) hub.upsertDevice(placeholderDevice(id, { ...hints, platform: 'ios', isPhysical: false }, meta, now));
    return { deviceId: id, network: false };
  }
  const match = findUniqueDevice(hub.getDevices(), hints, meta.transport, meta.remote);
  if (match) return { deviceId: match.id, network: false };

  const id = `${NET_DEVICE_PREFIX}${slug(hints.platform)}-${slug(hints.model)}-${slug(hints.name)}`;
  const existing = hub.getDevice(id);
  const device: DeviceInfo = {
    id,
    platform: hints.platform,
    kind: netDeviceKind(hints),
    name: hints.name || hints.model || 'Network device',
    connection: isLoopback(meta.remote) ? 'local' : 'wifi',
    state: 'online',
    logs: {
      status: 'unavailable',
      detail: 'Connected over the network: only the SDK data of this app is available',
      code: 'logs.networkOnly',
    },
    actions: [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  if (hints.model) device.model = hints.model;
  if (hints.manufacturer) device.manufacturer = hints.manufacturer;
  if (hints.osVersion) device.osVersion = hints.osVersion;
  if (hints.apiLevel !== undefined) device.apiLevel = hints.apiLevel;
  if (!existing || existing.state !== 'online') hub.upsertDevice(device);
  return { deviceId: id, network: true };
}
