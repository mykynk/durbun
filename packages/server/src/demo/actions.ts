/** Device actions of the demo devices (SPEC §5.7): every DeviceActionId gets a sensible simulation. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceActionId, DeviceActionResult, InstalledApp } from '@durbun/protocol';
import type { DriverContext } from '../types';
import type { DemoApp } from './appSim';
import { ANDROID_ACTIONS, ANDROID_SYSTEM, IOS_SIM_ACTIONS, IOS_SYSTEM, IPHONE_ID, PIXEL_ID } from './devices';
import { MahalleApp } from './mahalle';
import { androidLine, iosLine } from './noise';
import { PatiApp } from './pati';
import { screenshotPng } from './png';
import type { Rng } from './rng';
import type { Scheduler } from './scheduler';

export interface DeviceUiState {
  appearance: 'light' | 'dark';
  fontScale: number;
  animations: boolean;
  statusBar: 'clean' | 'reset';
  shots: number;
}

export interface DemoRuntime {
  ctx: DriverContext;
  rng: Rng;
  sched: Scheduler;
  apps: DemoApp[];
  deviceState: Map<string, DeviceUiState>;
}

const ANDROID_INSTALLED: InstalledApp[] = [
  { id: 'com.mykynk.pati', name: 'Pati', version: '2.4.1', debuggable: true },
  { id: 'com.mykynk.mahalle', name: 'Mahalle', version: '5.12.0', debuggable: true },
  { id: 'com.android.chrome', name: 'Chrome', version: '130.0.6723.102' },
  { id: 'com.google.android.youtube', name: 'YouTube', version: '19.44.38' },
  { id: 'com.google.android.apps.maps', name: 'Maps', version: '11.150.0102' },
];
const ANDROID_SYSTEM_APPS: InstalledApp[] = [
  { id: 'com.android.settings', name: 'Settings', version: '15', system: true },
  { id: 'com.google.android.gms', name: 'Google Play services', version: '24.47.35', system: true },
  { id: 'com.android.systemui', name: 'System UI', version: '15', system: true },
  { id: 'com.google.android.apps.nexuslauncher', name: 'Pixel Launcher', version: '15', system: true },
];
const IOS_INSTALLED: InstalledApp[] = [{ id: 'com.mykynk.pati', name: 'Pati', version: '2.4.1', debuggable: true }];
const IOS_SYSTEM_APPS: InstalledApp[] = [
  { id: 'com.apple.mobilesafari', name: 'Safari', version: '18.2', system: true },
  { id: 'com.apple.Preferences', name: 'Settings', version: '18.2', system: true },
  { id: 'com.apple.Maps', name: 'Maps', version: '18.2', system: true },
  { id: 'com.apple.mobileslideshow', name: 'Photos', version: '18.2', system: true },
];

const KEYCODES: Record<string, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  'volume-up': 'KEYCODE_VOLUME_UP',
  'volume-down': 'KEYCODE_VOLUME_DOWN',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
  menu: 'KEYCODE_MENU',
};

const ok = (message: string, data?: unknown, code?: string): DeviceActionResult => {
  const r: DeviceActionResult = { ok: true, message };
  if (data !== undefined) r.data = data;
  if (code) r.code = code;
  return r;
};
const fail = (error: string, code: string): DeviceActionResult => ({ ok: false, error, message: error, code });

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export async function runDemoAction(
  rt: DemoRuntime,
  deviceId: string,
  action: DeviceActionId,
  params: Record<string, unknown>,
): Promise<DeviceActionResult> {
  const android = deviceId === PIXEL_ID;
  const ios = deviceId === IPHONE_ID;
  if (!android && !ios) return fail(`Unknown demo device: ${deviceId}`, 'device.unknown');
  const supported = android ? ANDROID_ACTIONS : IOS_SIM_ACTIONS;
  if (!supported.includes(action)) {
    return fail(
      action === 'screen-record' ? 'Screen recording is not available for demo devices' : `"${action}" is not supported on ${android ? 'Android' : 'the iOS simulator'}`,
      'demo.unsupportedAction',
    );
  }
  const state = rt.deviceState.get(deviceId) ?? { appearance: 'light', fontScale: 1, animations: true, statusBar: 'reset', shots: 0 };
  rt.deviceState.set(deviceId, state);
  const apps = rt.apps.filter((a) => a.deviceId === deviceId);
  const pati = apps.find((a): a is PatiApp => a instanceof PatiApp);
  const ss = ANDROID_SYSTEM.systemServer.pid;
  const push = (lines: Parameters<DriverContext['hub']['pushDeviceLogs']>[1]) => rt.ctx.hub.pushDeviceLogs(deviceId, lines);

  switch (action) {
    case 'screenshot': {
      const [width, height] = android ? [540, 1200] : [402, 874];
      state.shots++;
      const png = screenshotPng({ width, height, platform: android ? 'android' : 'ios', dark: state.appearance === 'dark', seed: state.shots * 3 + (android ? 0 : 1) });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `screenshot-${android ? 'pixel-8' : 'iphone-16-pro'}-demo-${stamp}-${state.shots}.png`;
      const file = path.join(rt.ctx.tempDir, fileName);
      try {
        await mkdir(rt.ctx.tempDir, { recursive: true });
        await writeFile(file, png);
      } catch (err) {
        return fail(`Could not save the screenshot: ${err instanceof Error ? err.message : String(err)}`, 'screenshot.writeFailed');
      }
      return ok('Screenshot saved', { url: rt.ctx.fileUrl(fileName), file, width, height });
    }

    case 'open-url': {
      const url = str(params, 'url');
      if (!url) return fail('Missing "url"', 'params.invalid');
      if (android) {
        push([androidLine(ss, ss + 21, 'info', 'ActivityTaskManager', `START u0 {act=android.intent.action.VIEW dat=${url} flg=0x10000000 cmp=com.mykynk.pati/.MainActivity} from uid 2000 (BAL_ALLOW_PERMISSION) result code=0`)]);
      } else {
        push([iosLine(IOS_SYSTEM.springboard.pid, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Common', `Opening URL ${url} for scene com.mykynk.pati-default`)]);
      }
      pati?.handleDeepLink(url);
      return ok(`Opened ${url}`);
    }

    case 'list-apps': {
      const includeSystem = params.includeSystem === true;
      const base = android ? ANDROID_INSTALLED : IOS_INSTALLED;
      const installed = base.filter((a) => {
        const app = apps.find((x) => x.identity.bundleId === a.id);
        return !app || app.installed;
      });
      return ok(`${installed.length} apps`, includeSystem ? [...installed, ...(android ? ANDROID_SYSTEM_APPS : IOS_SYSTEM_APPS)] : installed);
    }

    case 'app-launch':
    case 'app-stop':
    case 'app-restart':
    case 'app-clear-data':
    case 'app-uninstall': {
      const appId = str(params, 'appId');
      if (!appId) return fail('Missing "appId"', 'params.invalid');
      const app = apps.find((a) => a.identity.bundleId === appId);
      if (!app) {
        const known = [...(android ? ANDROID_INSTALLED : IOS_INSTALLED), ...(android ? ANDROID_SYSTEM_APPS : IOS_SYSTEM_APPS)].some((a) => a.id === appId);
        return known ? ok(`${action} ${appId} (simulated)`) : fail(`${appId} is not installed on this device`, 'app.notInstalled');
      }
      if (!app.installed && action !== 'app-uninstall') return fail(`${appId} is not installed (install it again first)`, 'app.notInstalled');
      switch (action) {
        case 'app-launch':
          return app.launch('user') ? ok(`Launched ${app.identity.name}`) : ok(`${app.identity.name} is already running`);
        case 'app-stop':
          app.stop('user');
          return ok(`Stopped ${app.identity.name}`);
        case 'app-restart':
          app.stop('restart');
          rt.sched.after(700, () => app.launch('restart'));
          return ok(`Restarting ${app.identity.name}`);
        case 'app-clear-data':
          app.stop('clear-data');
          if (app instanceof PatiApp || app instanceof MahalleApp) app.resetData();
          if (android) push([androidLine(ss, ss + 5, 'info', 'PackageManager', `Clearing data for ${appId}`)]);
          rt.sched.after(900, () => app.launch('user'));
          return ok(`Cleared data of ${app.identity.name}`);
        default:
          app.stop('uninstall');
          app.installed = false;
          return ok(`Uninstalled ${app.identity.name}`);
      }
    }

    case 'app-install': {
      const file = str(params, 'file');
      if (!file) return fail('Missing "file"', 'params.invalid');
      const name = path.basename(file);
      const target = apps.find((a) => !a.installed && name.toLowerCase().includes(a.identity.name.toLowerCase())) ?? apps.find((a) => !a.installed);
      if (android) push([androidLine(ss, ss + 5, 'info', 'PackageManager', `Package ${target?.identity.bundleId ?? 'com.example.app'} codePath changed from null to /data/app/~~${rt.rng.base64url(12)}==/base.apk; Retain data and using new`)]);
      if (target) {
        target.installed = true;
        rt.sched.after(800, () => target.launch('user'));
      }
      return ok(`Installed ${name}${target ? ` (${target.identity.name})` : ''}`);
    }

    case 'logs-clear-buffer':
      return ok('Device log buffer cleared (logs already shown in Dürbün are kept)');

    case 'logs-restart':
      rt.ctx.hub.pushSystemLog(deviceId, { message: 'Log stream stopped (demo)', code: 'logs.streamStopped', params: { via: 'demo' } });
      rt.sched.after(400, () => rt.ctx.hub.pushSystemLog(deviceId, { message: 'Log stream started (demo)', code: 'logs.streamStarted', params: { via: 'demo' } }));
      return ok('Log stream restarted');

    case 'appearance': {
      const mode = params.mode;
      if (mode !== 'dark' && mode !== 'light') return fail('"mode" must be "dark" or "light"', 'params.invalid');
      state.appearance = mode;
      if (android) push([androidLine(ss, ss + 7, 'info', 'UiModeManager', `Setting night mode: ${mode === 'dark' ? 2 : 1} (${mode === 'dark' ? 'yes' : 'no'}) for user 0`)]);
      else push([iosLine(IOS_SYSTEM.springboard.pid, 'SpringBoard', 'info', 'com.apple.UIKit', 'Appearance', `UIUserInterfaceStyle changed to ${mode === 'dark' ? 'Dark' : 'Light'}`)]);
      for (const app of apps) if (app instanceof PatiApp) app.handleAppearance(mode);
      return ok(`Appearance: ${mode}`);
    }

    case 'font-scale': {
      const scale = num(params, 'scale');
      if (scale === undefined || scale < 0.5 || scale > 3) return fail('"scale" must be a number between 0.5 and 3', 'params.invalid');
      state.fontScale = scale;
      if (android) push([androidLine(ss, ss + 7, 'info', 'SettingsProvider', `font_scale changed to ${scale}`)]);
      pati?.handleTextScale(scale);
      return ok(`Font scale: ${scale}`);
    }

    case 'animations': {
      if (typeof params.enabled !== 'boolean') return fail('"enabled" must be true or false', 'params.invalid');
      state.animations = params.enabled;
      return ok(`Animations ${params.enabled ? 'enabled (1x)' : 'disabled (0x)'}`);
    }

    case 'input-text': {
      const text = typeof params.text === 'string' ? params.text : undefined;
      if (text === undefined) return fail('Missing "text"', 'params.invalid');
      pati?.handleText(text);
      return ok(`Typed ${text.length} characters`);
    }

    case 'key-event': {
      const key = str(params, 'key');
      if (!key || !KEYCODES[key]) return fail(`Unknown key; use one of ${Object.keys(KEYCODES).join(', ')}`, 'params.invalid');
      push([androidLine(ss, ss + 3, 'debug', 'WindowManager', `interceptKeyBeforeQueueing: key=${KEYCODES[key]} down=true screenIsOn=true`)]);
      pati?.handleKey(key);
      return ok(`Sent ${KEYCODES[key]}`);
    }

    case 'push-notification': {
      const appId = str(params, 'appId');
      const payload = params.payload;
      if (!appId) return fail('Missing "appId"', 'params.invalid');
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return fail('"payload" must be a JSON object', 'params.invalid');
      push([
        iosLine(IOS_SYSTEM.usernotificationsd.pid, 'usernoted', 'info', 'com.apple.UserNotifications', 'Delivery', `[${appId}] Received remote notification request ${rt.rng.uuid(true).slice(0, 8)} [ hasAlertContent: 1, hasSound: 1, hasBadge: 1 ]`),
      ]);
      if (appId === 'com.mykynk.pati') pati?.handlePush(payload as Record<string, unknown>);
      return ok(`Push sent to ${appId}`);
    }

    case 'location': {
      const lat = num(params, 'lat');
      const lon = num(params, 'lon');
      if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return fail('"lat" and "lon" must be valid coordinates', 'params.invalid');
      if (ios) push([iosLine(IOS_SYSTEM.locationd.pid, 'locationd', 'info', 'com.apple.locationd.Core', 'Client', `{"msg":"simulated location", "lat":${lat}, "lon":${lon}, "source":"simctl"}`)]);
      pati?.handleLocation(lat, lon);
      return ok(`Location set to ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    }

    case 'status-bar': {
      const mode = params.mode;
      if (mode !== 'clean' && mode !== 'reset') return fail('"mode" must be "clean" or "reset"', 'params.invalid');
      state.statusBar = mode;
      return ok(mode === 'clean' ? 'Status bar overridden (9:41, full battery)' : 'Status bar restored');
    }

    default:
      return fail(`"${action}" is not supported by the demo`, 'demo.unsupportedAction');
  }
}
