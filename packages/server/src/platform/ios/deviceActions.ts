/** Physical iOS device actions via `xcrun devicectl` (+ idevicescreenshot fallback). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceActionId, DeviceActionResult, DeviceUnavailableAction, InstallRefusalData } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { failureText, run } from '../exec';
import { bool, done, ensureDir, fail, isPng, num, screenshotResult, str, tempFileName, validAppId } from '../shared/files';
import { sigintRecording, type RecordingProcess, type ScreenRecorder } from '../shared/screenRecord';
import type { ResolvedTool } from '../tools';
import {
  devicectl as xcrunDevicectl,
  devicectlError,
  parseDevicectlApps,
  parseDevicectlProcesses,
  pidsForApp,
  toInstalledApps,
  type DevicectlCaps,
  type DevicectlRunner,
} from './devicectl';
import { appBundleId, iosInstallRefusalCode } from './bundleInfo';
import { beforeDevicectl, DEVICECTL_MIN_IOS } from './readerStates';
import { XCRUN } from './simctl';

export interface IosDeviceActionTarget {
  udid: string;
  deviceId: string;
  label: string;
  ctx: DriverContext;
  caps: DevicectlCaps;
  screenshotTool: ResolvedTool | null;
  syslogAvailable: boolean;
  restartLogs(): Promise<void>;
  /** Tests: a fake devicectl (default: `xcrun devicectl`). */
  devicectl?: DevicectlRunner;
  /** Live pids Dürbün already knows for an app (the app tracker's process listing). */
  pidsOf?(bundleId: string): number[];
  recorder: ScreenRecorder;
}

export interface IosDeviceActionState {
  trusted: boolean;
  caps: DevicectlCaps;
  screenshotTool: boolean;
  syslog: boolean;
  /** `devicectl list devices` reports Developer Mode off. */
  developerModeOff?: boolean;
  /** The iPhone's iOS version (devicectl works from iOS DEVICECTL_MIN_IOS on). */
  osVersion?: string;
}

/** Actions that need Developer Mode (developer disk image services). */
export const DEVELOPER_MODE_ACTIONS: ReadonlySet<DeviceActionId> = new Set<DeviceActionId>([
  'app-launch',
  'app-stop',
  'app-restart',
  'app-install',
  'open-url',
  'screenshot',
  'screen-record',
  'screen-record-stop',
]);

/** devicectl comes with Xcode 15; `detail` is the English text older UIs show, the rest is for the UI's own words. */
const MIN_XCODE = '15';
const DEVICECTL_TOOL = { tool: 'devicectl', detail: `Xcode ${MIN_XCODE} or newer (xcrun devicectl)`, minXcode: MIN_XCODE };
const LIBIMOBILEDEVICE_INSTALL = 'brew install libimobiledevice';
const SCREENSHOT_TOOL = {
  tool: 'idevicescreenshot',
  detail: `idevicescreenshot (${LIBIMOBILEDEVICE_INSTALL}) or Xcode ${MIN_XCODE} or newer`,
  minXcode: MIN_XCODE,
  install: LIBIMOBILEDEVICE_INSTALL,
};
const RECORDER_TOO_OLD = { tool: 'devicectl', detail: 'a newer Xcode (devicectl screen recording)', from: 'Xcode' };

/**
 * Actions that work for a trusted physical device with the given tooling, and those that do not with why
 * (a tool missing on the Mac, an iOS too old for devicectl, Developer Mode off). An untrusted device lists
 * neither (its state says why).
 */
export function iosDeviceActionAvailability(o: IosDeviceActionState): { actions: DeviceActionId[]; unavailable: DeviceUnavailableAction[] } {
  const actions: DeviceActionId[] = [];
  const unavailable: DeviceUnavailableAction[] = [];
  if (!o.trusted) return { actions, unavailable };
  const tooOld = beforeDevicectl(o.osVersion);
  const osParams = { osVersion: o.osVersion ?? '', minVersion: String(DEVICECTL_MIN_IOS) };
  const add = (action: DeviceActionId, missing?: DeviceUnavailableAction | false, viaDevicectl = true) => {
    if (missing) unavailable.push(missing);
    else if (viaDevicectl && tooOld) unavailable.push({ action, code: 'action.osTooOld', params: osParams });
    else if (o.developerModeOff && DEVELOPER_MODE_ACTIONS.has(action)) unavailable.push({ action, code: 'action.developerModeOff' });
    else actions.push(action);
  };
  const noDevicectl = (action: DeviceActionId): DeviceUnavailableAction | false =>
    !o.caps.available && { action, code: 'action.toolMissing', params: DEVICECTL_TOOL };
  for (const action of ['list-apps', 'app-launch', 'app-stop', 'app-restart', 'app-install', 'app-uninstall', 'open-url'] as const) {
    add(action, noDevicectl(action));
  }
  // idevicescreenshot works without devicectl (and on iOS before 17); devicectl's capture is the other way.
  const shotMissing: DeviceUnavailableAction | false = !o.caps.screenshot &&
    !o.screenshotTool && {
      action: 'screenshot',
      code: 'action.toolMissing',
      params: SCREENSHOT_TOOL,
    };
  add('screenshot', shotMissing, !o.screenshotTool);
  for (const action of ['screen-record', 'screen-record-stop'] as const) {
    const missing: DeviceUnavailableAction | false = !o.caps.available
      ? { action, code: 'action.toolMissing', params: DEVICECTL_TOOL }
      : !o.caps.screenRecord && { action, code: 'action.toolTooOld', params: RECORDER_TOO_OLD };
    add(action, missing);
  }
  if (o.syslog) actions.push('logs-restart');
  else unavailable.push({ action: 'logs-restart', code: 'logs.idevicesyslogMissing', params: { tool: 'idevicesyslog' } });
  // An app's data container on a physical iPhone: no command-line tool of Xcode copies it; Xcode's own window does.
  unavailable.push({ action: 'app-data', code: 'action.appData.iphoneUnsupported' });
  return { actions, unavailable };
}

/** Actions that work for a trusted physical device with the given tooling. */
export function iosDeviceActions(o: IosDeviceActionState): DeviceActionId[] {
  return iosDeviceActionAvailability(o).actions;
}

const SAFARI = 'com.apple.mobilesafari';

export async function runIosDeviceAction(
  t: IosDeviceActionTarget,
  action: DeviceActionId,
  params: Record<string, unknown>,
): Promise<DeviceActionResult> {
  const devicectl = t.devicectl ?? xcrunDevicectl;
  const dev = ['--device', t.udid];
  const needApp = (): string | DeviceActionResult => {
    const appId = str(params, 'appId');
    if (!validAppId(appId)) return fail('A valid bundle identifier (appId) is required', 'action.invalidParams', undefined, { param: 'appId', expected: 'appId' });
    return appId;
  };
  const needDevicectl = (): DeviceActionResult | undefined =>
    t.caps.available ? undefined : fail(`This action needs Xcode ${MIN_XCODE}+ (xcrun devicectl)`, 'action.toolMissing', undefined, DEVICECTL_TOOL);

  switch (action) {
    case 'list-apps': {
      const missing = needDevicectl();
      if (missing) return missing;
      const args = ['device', 'info', 'apps', ...dev];
      if (bool(params, 'includeSystem')) args.push('--include-all-apps');
      const r = await devicectl(args, 90_000);
      if (!r.ok) return fail(`Could not list apps: ${r.error}`);
      const apps = toInstalledApps(parseDevicectlApps(r.json));
      return done(`${apps.length} apps`, 'action.listApps', apps);
    }

    case 'app-launch':
    case 'app-restart': {
      const missing = needDevicectl();
      if (missing) return missing;
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const args = ['device', 'process', 'launch', ...dev];
      if (action === 'app-restart') args.push('--terminate-existing');
      args.push(appId);
      const r = await devicectl(args, 90_000);
      if (!r.ok) return fail(`Could not launch ${appId}: ${r.error}`, 'action.launchFailed');
      return done(action === 'app-restart' ? `Restarted ${appId}` : `Launched ${appId}`);
    }

    case 'app-stop': {
      const missing = needDevicectl();
      if (missing) return missing;
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      return stopApp(t, appId);
    }

    case 'app-uninstall': {
      const missing = needDevicectl();
      if (missing) return missing;
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const r = await devicectl(['device', 'uninstall', 'app', ...dev, appId], 120_000);
      if (!r.ok) return fail(`Could not uninstall ${appId}: ${r.error}`, 'action.uninstallFailed');
      return done(`Uninstalled ${appId}`);
    }

    case 'app-install': {
      const missing = needDevicectl();
      if (missing) return missing;
      return installApp(t, str(params, 'file'), params.replace === true);
    }

    case 'open-url': {
      const missing = needDevicectl();
      if (missing) return missing;
      const url = str(params, 'url');
      if (!url || url.length > 4096) return fail('A URL is required', 'action.invalidParams', undefined, { param: 'url', expected: 'url' });
      const appId = str(params, 'appId');
      let r;
      if (appId && validAppId(appId)) {
        r = await devicectl(['device', 'process', 'launch', ...dev, '--payload-url', url, appId], 60_000);
      } else if (t.caps.openURL) {
        r = await devicectl(['device', 'process', 'openURL', ...dev, url], 60_000);
      } else {
        r = await devicectl(['device', 'process', 'launch', ...dev, '--payload-url', url, SAFARI], 60_000);
      }
      if (!r.ok) return fail(`Could not open the URL: ${r.error}`, 'action.openUrlFailed');
      return done(`Opened ${url}`);
    }

    case 'screenshot':
      return screenshot(t);

    case 'screen-record':
      if (!t.caps.available) return fail(`Screen recording needs Xcode ${MIN_XCODE}+ (xcrun devicectl)`, 'action.toolMissing', undefined, DEVICECTL_TOOL);
      if (!t.caps.screenRecord) return fail('Screen recording needs a newer Xcode (devicectl capture)', 'action.toolTooOld', undefined, RECORDER_TOO_OLD);
      return t.recorder.record(params, DEVICE_RECORD_MAX_SEC, () => startRecording(t));

    case 'screen-record-stop':
      return t.recorder.stop();

    case 'logs-restart':
      if (!t.syslogAvailable) return fail('idevicesyslog is not available', 'logs.idevicesyslogMissing', undefined, { tool: 'idevicesyslog' });
      await t.restartLogs();
      return done('Log stream restarted');

    default:
      return fail(`"${action}" is not supported on physical iOS devices`, 'action.unsupported');
  }
}

async function stopApp(t: IosDeviceActionTarget, appId: string): Promise<DeviceActionResult> {
  const devicectl = t.devicectl ?? xcrunDevicectl;
  const dev = ['--device', t.udid];
  // --include-all-apps: TestFlight / App Store / ad-hoc apps are not "developer apps" and are missing otherwise.
  const appsR = await devicectl(['device', 'info', 'apps', ...dev, '--include-all-apps', '--bundle-id', appId], 60_000);
  const app = appsR.ok ? parseDevicectlApps(appsR.json).find((a) => a.bundleIdentifier === appId) : undefined;
  const known = t.pidsOf?.(appId) ?? [];
  let pids: number[];
  if (app?.url) {
    const procR = await devicectl(['device', 'info', 'processes', ...dev], 60_000);
    if (!procR.ok) return fail(`Could not list processes: ${procR.error}`);
    const processes = parseDevicectlProcesses(procR.json);
    if (!processes.some((p) => p.executable)) {
      if (known.length === 0) return fail(`Could not find the process of ${appId}: devicectl did not report executable paths`, 'action.processUnknown', undefined, { app: appId, tool: 'devicectl' });
      pids = known;
    } else pids = pidsForApp(processes, app.url);
  } else if (known.length > 0) {
    pids = known; // the running app Dürbün already follows
  } else if (!appsR.ok) {
    return fail(`Could not look up ${appId}: ${appsR.error}`);
  } else {
    return fail(`${appId} is not installed`, 'action.appNotFound');
  }
  if (pids.length === 0) return done(`${appId} is not running`);
  for (const pid of pids) {
    const r = await devicectl(['device', 'process', 'terminate', ...dev, '--pid', String(pid)], 30_000);
    if (r.ok) continue;
    if (/no such process|not found|does not exist|ESRCH/i.test(r.error ?? '')) continue; // it ended meanwhile
    if (app && app.builtByDeveloper !== true) {
      return fail(
        `iOS does not let this Mac stop ${appId} (only apps installed from Xcode can be stopped); close it from the app switcher on the device (${r.error})`,
        'action.stopNotAllowed',
      );
    }
    return fail(`Could not stop ${appId} (pid ${pid}): ${r.error}`);
  }
  return done(`Stopped ${appId}`);
}

async function installApp(t: IosDeviceActionTarget, file: string | undefined, replace = false): Promise<DeviceActionResult> {
  const devicectl = t.devicectl ?? xcrunDevicectl;
  if (!file || !path.isAbsolute(file)) return fail('An absolute .app / .ipa path is required', 'action.invalidParams', undefined, { param: 'file', expected: 'absolutePath', kinds: '.app, .ipa' });
  const st = await fs.promises.stat(file).catch(() => undefined);
  if (!st) return fail(`File not found: ${file}`, 'action.fileNotFound');
  let appPath = file;
  let tmp: string | undefined;
  try {
    if (st.isFile()) {
      if (!/\.(ipa|zip)$/i.test(file)) return fail('Install a .app folder or an .ipa', 'action.unsupportedFile');
      tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'durbun-ipa-'));
      const unzip = await run('/usr/bin/ditto', ['-x', '-k', file, tmp], { timeoutMs: 5 * 60_000 });
      if (!unzip.ok) return fail(`Could not unpack ${path.basename(file)}: ${failureText(unzip)}`);
      const payload = path.join(tmp, 'Payload');
      const dir = fs.existsSync(payload) ? payload : tmp;
      const app = (await fs.promises.readdir(dir)).find((n) => n.endsWith('.app'));
      if (!app) return fail(`${path.basename(file)} does not contain a .app bundle`, 'action.unsupportedFile');
      appPath = path.join(dir, app);
    } else if (!file.endsWith('.app')) {
      return fail('Install a .app folder or an .ipa', 'action.unsupportedFile');
    }
    let replaced: string | undefined;
    if (replace) {
      const bundleId = await appBundleId(appPath);
      if (!bundleId) {
        return fail(
          `The bundle id of ${path.basename(appPath)} could not be read, so Dürbün cannot tell which app to uninstall; delete it on the iPhone, then install again`,
          'action.install.packageUnknown',
        );
      }
      const u = await devicectl(['device', 'uninstall', 'app', '--device', t.udid, bundleId], 120_000);
      if (!u.ok && !/not installed|could not be found|no such app|not found/i.test(u.error ?? '')) {
        return fail(`Could not uninstall ${bundleId} (nothing was changed): ${u.error}`, 'action.install.replaceUninstallFailed', { packageId: bundleId });
      }
      replaced = bundleId;
    }
    const r = await devicectl(['device', 'install', 'app', '--device', t.udid, appPath], 10 * 60_000);
    if (!r.ok) {
      if (replaced) {
        return fail(`${replaced} was uninstalled, but installing ${path.basename(appPath)} failed: ${r.error}`, 'action.install.replaceInstallFailed', { packageId: replaced });
      }
      const code = iosInstallRefusalCode(r.error ?? '');
      if (code) {
        const packageId = await appBundleId(appPath);
        const data: InstallRefusalData = { ...(packageId ? { packageId } : {}), replaceable: !!packageId };
        return fail(`Install failed: ${r.error}. Deleting the installed copy first lets it install; that deletes its data.`, code, data);
      }
      return fail(`Install failed: ${r.error}`, 'action.installFailed');
    }
    if (replaced) return done(`Uninstalled ${replaced} and installed ${path.basename(appPath)}`, 'action.install.replaced', { packageId: replaced });
    return done(`Installed ${path.basename(appPath)}`);
  } finally {
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

async function screenshot(t: IosDeviceActionTarget): Promise<DeviceActionResult> {
  const devicectl = t.devicectl ?? xcrunDevicectl;
  await ensureDir(t.ctx.tempDir);
  const name = tempFileName('screenshot', t.label, 'png');
  const file = path.join(t.ctx.tempDir, name);
  const errors: string[] = [];
  if (t.caps.screenshot) {
    const r = await devicectl(['device', 'capture', 'screenshot', '--device', t.udid, '--destination', file], 60_000);
    const png = await fs.promises.readFile(file).catch(() => undefined);
    if (r.ok && png && isPng(png)) return screenshotResult(t.ctx, name, file, png);
    errors.push(`devicectl: ${r.error ?? 'no image'}`);
  }
  if (t.screenshotTool) {
    const r = await run(t.screenshotTool.path, ['-u', t.udid, file], { timeoutMs: 30_000, env: t.screenshotTool.env });
    const png = await fs.promises.readFile(file).catch(() => undefined);
    if (r.ok && png && isPng(png)) return screenshotResult(t.ctx, name, file, png);
    errors.push(`idevicescreenshot: ${failureText(r)}`);
  }
  await fs.promises.rm(file, { force: true });
  if (errors.length === 0) return fail('No screenshot tool is available (needs Xcode devicectl or idevicescreenshot)', 'action.toolMissing', undefined, SCREENSHOT_TOOL);
  return fail(
    `The device refused the screenshot (Developer Mode / developer disk image may be required): ${errors.join(' · ')}`,
    'action.screenshotRefused',
    undefined,
    { detail: errors.join(' · ') },
  );
}

/** devicectl records until SIGINT without a limit of its own; Dürbün stops a recording after 10 minutes. */
const DEVICE_RECORD_MAX_SEC = 600;

async function startRecording(t: IosDeviceActionTarget): Promise<RecordingProcess> {
  await ensureDir(t.ctx.tempDir);
  const name = tempFileName('recording', t.label, 'mp4');
  const file = path.join(t.ctx.tempDir, name);
  const jsonFile = path.join(os.tmpdir(), `durbun-devicectl-rec-${process.pid}-${Date.now()}.json`);
  // Without --duration devicectl records until it gets SIGINT (Ctrl+C) and then writes the file.
  const args = ['devicectl', 'device', 'capture', 'screen-record', '--device', t.udid, '--destination', file, '--json-output', jsonFile];
  return sigintRecording(XCRUN, args, 60_000, async (exit) => {
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(await fs.promises.readFile(jsonFile, 'utf8')) as Record<string, unknown>;
    } catch {
      json = undefined;
    } finally {
      await fs.promises.rm(jsonFile, { force: true });
    }
    const st = await fs.promises.stat(file).catch(() => undefined);
    if (st && st.size > 0 && (exit.stopped || exit.code === 0)) {
      return done('Recording saved', 'action.recording.saved', { url: t.ctx.fileUrl(name), file });
    }
    if (exit.stopped && !json && !exit.stderr.trim()) return fail('Screen recording failed: no video was written', 'action.recording.noVideo');
    const why = devicectlError(json, exit.stderr);
    return fail(`Screen recording failed: ${why}`, 'action.recording.failed', undefined, { detail: why });
  });
}
