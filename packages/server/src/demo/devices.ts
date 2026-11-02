/** The demo devices and their background processes. */
import type { DeviceActionId, DeviceInfo, LogOrigin } from '@durbun/protocol';

export const PIXEL_ID = 'demo:1';
export const IPHONE_ID = 'demo:2';
/** A tester's physical iPhone over USB (store / TestFlight build, an Xcode build, crash reports). */
export const IPHONE_DEVICE_ID = 'demo:3';
export const DEMO_DEVICE_IDS = [PIXEL_ID, IPHONE_ID, IPHONE_DEVICE_ID] as const;

/**
 * Device lines of each demo device carry the origin the real driver would set (SPEC §10.2), so the UI's
 * "where does this come from" texts show what they will show with real devices. The device ids
 * (`demo:`) and `logs.via: 'demo'` still say it is demo data.
 */
export const DEMO_LOG_ORIGIN: Record<string, LogOrigin> = {
  [PIXEL_ID]: 'logcat',
  [IPHONE_ID]: 'simctl-log',
  [IPHONE_DEVICE_ID]: 'idevicesyslog',
};

export interface DemoProcess {
  pid: number;
  name: string;
}

export const ANDROID_ACTIONS: DeviceActionId[] = [
  'screenshot',
  'open-url',
  'list-apps',
  'app-launch',
  'app-stop',
  'app-restart',
  'app-clear-data',
  'app-uninstall',
  'app-install',
  'logs-clear-buffer',
  'logs-restart',
  'appearance',
  'font-scale',
  'animations',
  'input-text',
  'key-event',
  'location',
];

export const IOS_SIM_ACTIONS: DeviceActionId[] = [
  'screenshot',
  'open-url',
  'list-apps',
  'app-launch',
  'app-stop',
  'app-restart',
  'app-clear-data',
  'app-uninstall',
  'app-install',
  'logs-restart',
  'appearance',
  'font-scale',
  'push-notification',
  'location',
  'status-bar',
];

/** What a trusted physical iPhone offers (devicectl + idevicescreenshot + idevicesyslog). */
export const IOS_DEVICE_ACTIONS: DeviceActionId[] = [
  'list-apps',
  'app-launch',
  'app-stop',
  'app-restart',
  'app-install',
  'app-uninstall',
  'open-url',
  'screenshot',
  'logs-restart',
];

export function pixelDevice(now: number): DeviceInfo {
  return {
    id: PIXEL_ID,
    platform: 'android',
    kind: 'emulator',
    name: 'Pixel 8 · Demo',
    model: 'Pixel 8',
    manufacturer: 'Google',
    osVersion: '15',
    apiLevel: 35,
    serial: 'emulator-5554',
    connection: 'local',
    state: 'online',
    battery: { level: 87, charging: true },
    screen: { width: 1080, height: 2400, density: 420 },
    logs: { status: 'streaming', via: 'demo' },
    actions: [...ANDROID_ACTIONS],
    firstSeen: now,
    lastSeen: now,
  };
}

export function iphoneDevice(now: number): DeviceInfo {
  return {
    id: IPHONE_ID,
    platform: 'ios',
    kind: 'simulator',
    name: 'iPhone 16 Pro · Demo',
    model: 'iPhone17,1',
    manufacturer: 'Apple',
    osVersion: '18.2',
    serial: '5E1D3A7B-2C4F-4B8E-9A61-0D7F3C2B1A90',
    connection: 'local',
    state: 'online',
    screen: { width: 1206, height: 2622, density: 3 },
    logs: { status: 'streaming', via: 'demo' },
    actions: [...IOS_SIM_ACTIONS],
    firstSeen: now,
    lastSeen: now,
  };
}

export function iphoneUsbDevice(now: number): DeviceInfo {
  return {
    id: IPHONE_DEVICE_ID,
    platform: 'ios',
    kind: 'physical',
    name: 'iPhone 13 · Demo',
    model: 'iPhone14,5',
    manufacturer: 'Apple',
    osVersion: '17.6.1',
    serial: '00008110-001A2B3C4D5E6F70',
    connection: 'usb',
    state: 'online',
    battery: { level: 64, charging: true },
    screen: { width: 1170, height: 2532, density: 3 },
    logs: { status: 'streaming', via: 'demo' },
    actions: [...IOS_DEVICE_ACTIONS],
    firstSeen: now,
    lastSeen: now,
  };
}

/** Long-running Android system processes (pid → name). */
export const ANDROID_SYSTEM = {
  init: { pid: 1, name: 'init' },
  logd: { pid: 312, name: 'logd' },
  lmkd: { pid: 318, name: 'lmkd' },
  healthd: { pid: 284, name: 'android.hardware.health-service.example' },
  surfaceflinger: { pid: 512, name: 'surfaceflinger' },
  composer: { pid: 590, name: 'android.hardware.graphics.composer3-service.ranchu' },
  zygote: { pid: 640, name: 'zygote64' },
  systemServer: { pid: 1043, name: 'system_server' },
  systemui: { pid: 1420, name: 'com.android.systemui' },
  phone: { pid: 1596, name: 'com.android.phone' },
  gmsPersistent: { pid: 1702, name: 'com.google.android.gms.persistent' },
  launcher: { pid: 1830, name: 'com.google.android.apps.nexuslauncher' },
  ime: { pid: 1904, name: 'com.google.android.inputmethod.latin' },
  gms: { pid: 2120, name: 'com.google.android.gms' },
  vending: { pid: 2311, name: 'com.android.vending' },
  gsa: { pid: 2480, name: 'com.google.android.googlequicksearchbox:search' },
  photos: { pid: 3021, name: 'com.google.android.apps.photos' },
} as const satisfies Record<string, DemoProcess>;

/** Long-running iOS simulator processes. */
export const IOS_SYSTEM = {
  launchd: { pid: 1, name: 'launchd_sim' },
  springboard: { pid: 231, name: 'SpringBoard' },
  backboardd: { pid: 212, name: 'backboardd' },
  runningboardd: { pid: 248, name: 'runningboardd' },
  locationd: { pid: 265, name: 'locationd' },
  mdns: { pid: 302, name: 'mDNSResponder' },
  nsurlsessiond: { pid: 318, name: 'nsurlsessiond' },
  cfprefsd: { pid: 207, name: 'cfprefsd' },
  tccd: { pid: 289, name: 'tccd' },
  usernotificationsd: { pid: 341, name: 'usernoted' },
} as const satisfies Record<string, DemoProcess>;

/** Long-running daemons of the physical iPhone (real devices have small, different pids). */
export const IOS_DEVICE_SYSTEM = {
  launchd: { pid: 1, name: 'launchd' },
  springboard: { pid: 34, name: 'SpringBoard' },
  backboardd: { pid: 63, name: 'backboardd' },
  runningboardd: { pid: 29, name: 'runningboardd' },
  locationd: { pid: 84, name: 'locationd' },
  mdns: { pid: 118, name: 'mDNSResponder' },
  nsurlsessiond: { pid: 121, name: 'nsurlsessiond' },
  tccd: { pid: 132, name: 'tccd' },
  reportCrash: { pid: 1904, name: 'ReportCrash' },
  osanalyticshelper: { pid: 1907, name: 'osanalyticshelper' },
} as const satisfies Record<string, DemoProcess>;

export const ANDROID_PROCESS_LIST: DemoProcess[] = Object.values(ANDROID_SYSTEM);
export const IOS_PROCESS_LIST: DemoProcess[] = Object.values(IOS_SYSTEM);
export const IOS_DEVICE_PROCESS_LIST: DemoProcess[] = Object.values(IOS_DEVICE_SYSTEM);
