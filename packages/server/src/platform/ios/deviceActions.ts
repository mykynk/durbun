/** Physical iOS device actions via `xcrun devicectl` (+ idevicescreenshot fallback). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceActionId, DeviceActionResult } from '@durbun/protocol';
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
  recorder: ScreenRecorder;
}

/** Actions that work for a trusted physical device with the given tooling. */
export function iosDeviceActions(opts: {
  trusted: boolean;
  caps: DevicectlCaps;
  screenshotTool: boolean;
  syslog: boolean;
}): DeviceActionId[] {
  if (!opts.trusted) return [];
  const a: DeviceActionId[] = [];
  if (opts.caps.available) {
    a.push('list-apps', 'app-launch', 'app-stop', 'app-restart', 'app-install', 'app-uninstall', 'open-url');
  }
  if (opts.caps.screenshot || opts.screenshotTool) a.push('screenshot');
  if (opts.caps.screenRecord) a.push('screen-record', 'screen-record-stop');
  if (opts.syslog) a.push('logs-restart');
  return a;
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
    if (!validAppId(appId)) return fail('A valid bundle identifier (appId) is required', 'action.invalidParams');
    return appId;
  };
  const needDevicectl = (): DeviceActionResult | undefined =>
    t.caps.available ? undefined : fail('This action needs Xcode 15+ (xcrun devicectl)', 'action.toolMissing');

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
      return installApp(t, str(params, 'file'));
    }

    case 'open-url': {
      const missing = needDevicectl();
      if (missing) return missing;
      const url = str(params, 'url');
      if (!url || url.length > 4096) return fail('A URL is required', 'action.invalidParams');
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
      if (!t.caps.screenRecord) return fail('Screen recording needs a newer Xcode (devicectl capture)', 'action.toolMissing');
      return t.recorder.record(params, DEVICE_RECORD_MAX_SEC, () => startRecording(t));

    case 'screen-record-stop':
      return t.recorder.stop();

    case 'logs-restart':
      if (!t.syslogAvailable) return fail('idevicesyslog is not available', 'logs.idevicesyslogMissing');
      await t.restartLogs();
      return done('Log stream restarted');

    default:
      return fail(`"${action}" is not supported on physical iOS devices`, 'action.unsupported');
  }
}

async function stopApp(t: IosDeviceActionTarget, appId: string): Promise<DeviceActionResult> {
  const devicectl = t.devicectl ?? xcrunDevicectl;
  const dev = ['--device', t.udid];
  const appsR = await devicectl(['device', 'info', 'apps', ...dev, '--bundle-id', appId], 60_000);
  if (!appsR.ok) return fail(`Could not look up ${appId}: ${appsR.error}`);
  const app = parseDevicectlApps(appsR.json).find((a) => a.bundleIdentifier === appId);
  if (!app?.url) return fail(`${appId} is not installed (or not a developer app)`, 'action.appNotFound');
  const procR = await devicectl(['device', 'info', 'processes', ...dev], 60_000);
  if (!procR.ok) return fail(`Could not list processes: ${procR.error}`);
  const processes = parseDevicectlProcesses(procR.json);
  if (!processes.some((p) => p.executable)) {
    return fail(`Could not find the process of ${appId}: devicectl did not report executable paths`);
  }
  const pids = pidsForApp(processes, app.url);
  if (pids.length === 0) return done(`${appId} is not running`);
  for (const pid of pids) {
    const r = await devicectl(['device', 'process', 'terminate', ...dev, '--pid', String(pid)], 30_000);
    if (!r.ok) return fail(`Could not stop ${appId} (pid ${pid}): ${r.error}`);
  }
  return done(`Stopped ${appId}`);
}

async function installApp(t: IosDeviceActionTarget, file: string | undefined): Promise<DeviceActionResult> {
  const devicectl = t.devicectl ?? xcrunDevicectl;
  if (!file || !path.isAbsolute(file)) return fail('An absolute .app / .ipa path is required', 'action.invalidParams');
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
    const r = await devicectl(['device', 'install', 'app', '--device', t.udid, appPath], 10 * 60_000);
    if (!r.ok) return fail(`Install failed: ${r.error}`, 'action.installFailed');
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
  if (errors.length === 0) return fail('No screenshot tool is available (needs Xcode devicectl or idevicescreenshot)', 'action.toolMissing');
  return fail(
    `The device refused the screenshot (Developer Mode / developer disk image may be required): ${errors.join(' · ')}`,
    'action.screenshotRefused',
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
    const why = exit.stopped && !json && !exit.stderr.trim() ? 'no video was written' : devicectlError(json, exit.stderr);
    return fail(`Screen recording failed: ${why}`);
  });
}
