/** iOS simulator actions via `xcrun simctl` (SPEC §5.5 "iOS simulator"). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceActionId, DeviceActionResult } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { failureText, run } from '../exec';
import {
  bool,
  done,
  ensureDir,
  fail,
  isPng,
  num,
  screenshotResult,
  str,
  tempFileName,
  validAppId,
} from '../shared/files';
import { sigintRecording, type RecordingProcess, type ScreenRecorder } from '../shared/screenRecord';
import { tailLines } from '../shared/text';
import { contentSizeForScale, CONTENT_SIZES, parseListApps, simctl, XCRUN } from './simctl';

export const SIM_ACTIONS: DeviceActionId[] = [
  'screenshot',
  'open-url',
  'list-apps',
  'app-launch',
  'app-stop',
  'app-restart',
  'app-clear-data',
  'app-uninstall',
  'app-install',
  'appearance',
  'font-scale',
  'push-notification',
  'location',
  'status-bar',
  'logs-restart',
  'screen-record',
  'screen-record-stop',
];

export interface SimActionTarget {
  udid: string;
  deviceId: string;
  label: string;
  ctx: DriverContext;
  restartLogs(): Promise<void>;
  recorder: ScreenRecorder;
}

function simError(r: { stdout: string; stderr: string; error?: string; code: number | null }): string {
  // simctl prints "An error was encountered processing the command (domain=…, code=…):\n<reason>"
  const text = `${r.stderr}\n${r.stdout}`;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('An error was encountered') && !/^Underlying error/.test(l));
  return r.error ?? (lines.slice(0, 2).join(' · ') || `simctl failed (exit ${r.code ?? '?'})`);
}

export async function runSimAction(
  t: SimActionTarget,
  action: DeviceActionId,
  params: Record<string, unknown>,
): Promise<DeviceActionResult> {
  const { udid } = t;
  const needApp = (): string | DeviceActionResult => {
    const appId = str(params, 'appId');
    if (!validAppId(appId)) return fail('A valid bundle identifier (appId) is required', 'action.invalidParams');
    return appId;
  };

  switch (action) {
    case 'screenshot': {
      await ensureDir(t.ctx.tempDir);
      const name = tempFileName('screenshot', t.label, 'png');
      const file = path.join(t.ctx.tempDir, name);
      const r = await simctl(['io', udid, 'screenshot', '--type=png', file], { timeoutMs: 30_000 });
      const png = await fs.promises.readFile(file).catch(() => undefined);
      if (!r.ok || !png || !isPng(png)) {
        await fs.promises.rm(file, { force: true });
        return fail(`Screenshot failed: ${simError(r)}`);
      }
      return screenshotResult(t.ctx, name, file, png);
    }

    case 'open-url': {
      const url = str(params, 'url');
      if (!url || url.length > 4096) return fail('A URL is required', 'action.invalidParams');
      const r = await simctl(['openurl', udid, url]);
      if (!r.ok) return fail(`Could not open the URL: ${simError(r)}`, 'action.openUrlFailed');
      return done(`Opened ${url}`);
    }

    case 'list-apps': {
      const r = await simctl(['listapps', udid]);
      if (!r.ok) return fail(`Could not list apps: ${simError(r)}`);
      const apps = parseListApps(r.stdout, bool(params, 'includeSystem') === true);
      return done(`${apps.length} apps`, 'action.listApps', apps);
    }

    case 'app-launch': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const r = await simctl(['launch', udid, appId]);
      if (!r.ok) return fail(`Could not launch ${appId}: ${simError(r)}`, 'action.launchFailed');
      return done(`Launched ${appId}`);
    }

    case 'app-stop': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const r = await simctl(['terminate', udid, appId]);
      if (!r.ok && !/found nothing to terminate|not running/i.test(`${r.stderr}${r.stdout}`)) {
        return fail(`Could not stop ${appId}: ${simError(r)}`);
      }
      return done(`Stopped ${appId}`);
    }

    case 'app-restart': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      await simctl(['terminate', udid, appId]);
      const r = await simctl(['launch', udid, appId]);
      if (!r.ok) return fail(`Could not launch ${appId}: ${simError(r)}`, 'action.launchFailed');
      return done(`Restarted ${appId}`);
    }

    case 'app-clear-data': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      return clearAppData(t, appId);
    }

    case 'app-uninstall': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      // simctl reports success for bundle ids that are not installed; check first.
      const c = await simctl(['get_app_container', udid, appId]);
      if (!c.ok) return fail(`${appId} is not installed on this simulator`, 'action.appNotFound');
      const r = await simctl(['uninstall', udid, appId], { timeoutMs: 60_000 });
      if (!r.ok) return fail(`Could not uninstall ${appId}: ${simError(r)}`, 'action.uninstallFailed');
      return done(`Uninstalled ${appId}`);
    }

    case 'app-install':
      return installApp(t, str(params, 'file'));

    case 'appearance': {
      const mode = str(params, 'mode');
      if (mode !== 'dark' && mode !== 'light') return fail('mode must be "dark" or "light"', 'action.invalidParams');
      const r = await simctl(['ui', udid, 'appearance', mode]);
      if (!r.ok) return fail(`Could not switch appearance: ${simError(r)}`);
      return done(mode === 'dark' ? 'Dark mode on' : 'Light mode on');
    }

    case 'font-scale': {
      const explicit = str(params, 'contentSize');
      const scale = num(params, 'scale');
      let size: string;
      if (explicit && CONTENT_SIZES.some(([n]) => n === explicit)) size = explicit;
      else if (scale !== undefined && scale > 0 && scale <= 4) size = contentSizeForScale(scale);
      else return fail('scale must be a positive number (1 = default size)', 'action.invalidParams');
      const r = await simctl(['ui', udid, 'content_size', size]);
      if (!r.ok) return fail(`Could not set the content size: ${simError(r)}`);
      return done(`Text size set to ${size}`, 'action.done', { contentSize: size });
    }

    case 'push-notification': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const payload = params.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return fail('payload must be a JSON object', 'action.invalidParams');
      }
      if (!('aps' in payload)) return fail('payload must contain an "aps" object', 'action.invalidParams');
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json) > 4096) return fail('payload must be 4096 bytes or less', 'action.invalidParams');
      await ensureDir(t.ctx.tempDir);
      const file = path.join(t.ctx.tempDir, tempFileName('push', t.label, 'json'));
      await fs.promises.writeFile(file, json);
      try {
        const r = await simctl(['push', udid, appId, file]);
        if (!r.ok) return fail(`Could not send the notification: ${simError(r)}`);
        return done(`Notification sent to ${appId}`);
      } finally {
        await fs.promises.rm(file, { force: true });
      }
    }

    case 'location': {
      const lat = num(params, 'lat');
      const lon = num(params, 'lon');
      if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return fail('lat (−90…90) and lon (−180…180) are required', 'action.invalidParams');
      }
      const r = await simctl(['location', udid, 'set', `${lat},${lon}`]);
      if (!r.ok) return fail(`Could not set the location: ${simError(r)}`);
      return done(`Location set to ${lat}, ${lon}`);
    }

    case 'status-bar': {
      const mode = str(params, 'mode');
      if (mode !== 'clean' && mode !== 'reset') return fail('mode must be "clean" or "reset"', 'action.invalidParams');
      const args =
        mode === 'clean'
          ? [
              'status_bar',
              udid,
              'override',
              '--time',
              '9:41',
              '--batteryState',
              'charged',
              '--batteryLevel',
              '100',
              '--cellularBars',
              '4',
              '--wifiBars',
              '3',
            ]
          : ['status_bar', udid, 'clear'];
      const r = await simctl(args);
      if (!r.ok) return fail(`Could not change the status bar: ${simError(r)}`);
      return done(mode === 'clean' ? 'Status bar set to 9:41, full battery' : 'Status bar restored');
    }

    case 'logs-restart':
      await t.restartLogs();
      return done('Log stream restarted');

    case 'screen-record':
      return t.recorder.record(params, SIM_RECORD_MAX_SEC, () => startRecording(t));

    case 'screen-record-stop':
      return t.recorder.stop();

    default:
      return fail(`"${action}" is not supported on iOS simulators`, 'action.unsupported');
  }
}

/** Terminate, then wipe the app's data container (top-level folders are kept and recreated). */
async function clearAppData(t: SimActionTarget, appId: string): Promise<DeviceActionResult> {
  const c = await simctl(['get_app_container', t.udid, appId, 'data']);
  const dir = c.stdout.trim();
  if (!c.ok || !dir || !path.isAbsolute(dir)) {
    return fail(`Could not find the data container of ${appId}: ${simError(c)}`, 'action.appNotFound');
  }
  // Safety: only ever wipe inside a CoreSimulator data container of this simulator.
  if (!dir.includes(`/Devices/${t.udid}/data/Containers/Data/`)) {
    return fail(`Refusing to clear an unexpected container path: ${dir}`);
  }
  await simctl(['terminate', t.udid, appId]);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) {
      const children = await fs.promises.readdir(p).catch(() => []);
      await Promise.all(children.map((c2) => fs.promises.rm(path.join(p, c2), { recursive: true, force: true })));
    } else if (e.name !== '.com.apple.mobile_container_manager.metadata.plist') {
      await fs.promises.rm(p, { force: true });
    }
  }
  for (const sub of ['Documents', 'Library/Caches', 'Library/Preferences', 'tmp']) {
    await fs.promises.mkdir(path.join(dir, sub), { recursive: true }).catch(() => undefined);
  }
  // cfprefsd caches NSUserDefaults; kill it so the wiped preferences are not written back.
  await simctl(['spawn', t.udid, 'launchctl', 'kill', 'SIGKILL', 'system/com.apple.cfprefsd.xpc.daemon'], {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  return done(`Cleared data of ${appId}`);
}

async function findAppBundle(root: string, depth = 3): Promise<string | undefined> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith('.app')) return path.join(root, e.name);
  }
  if (depth <= 0) return undefined;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('__MACOSX')) {
      const found = await findAppBundle(path.join(root, e.name), depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function installApp(t: SimActionTarget, file: string | undefined): Promise<DeviceActionResult> {
  if (!file || !path.isAbsolute(file)) return fail('An absolute .app / .zip path is required', 'action.invalidParams');
  const st = await fs.promises.stat(file).catch(() => undefined);
  if (!st) return fail(`File not found: ${file}`, 'action.fileNotFound');
  let appPath = file;
  let tmp: string | undefined;
  try {
    if (st.isFile()) {
      if (!/\.(zip|ipa)$/i.test(file)) return fail('Install a .app folder or a .zip/.ipa containing one', 'action.unsupportedFile');
      tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'durbun-install-'));
      const unzip = await run('/usr/bin/ditto', ['-x', '-k', file, tmp], { timeoutMs: 5 * 60_000 });
      if (!unzip.ok) return fail(`Could not unzip ${path.basename(file)}: ${failureText(unzip)}`);
      const found = await findAppBundle(tmp);
      if (!found) return fail(`${path.basename(file)} does not contain a .app bundle`, 'action.unsupportedFile');
      appPath = found;
    } else if (!st.isDirectory() || !file.endsWith('.app')) {
      return fail('Install a .app folder or a .zip/.ipa containing one', 'action.unsupportedFile');
    }
    const r = await simctl(['install', t.udid, appPath], { timeoutMs: 5 * 60_000 });
    if (!r.ok) return fail(`Install failed: ${simError(r)}`, 'action.installFailed');
    return done(`Installed ${path.basename(appPath)}`);
  } finally {
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** simctl has no limit of its own; Dürbün stops a recording after 10 minutes. */
const SIM_RECORD_MAX_SEC = 600;

async function startRecording(t: SimActionTarget): Promise<RecordingProcess> {
  await ensureDir(t.ctx.tempDir);
  // simctl writes a QuickTime movie (H.264 when --codec=h264) and finishes it on SIGINT.
  const name = tempFileName('recording', t.label, 'mov');
  const file = path.join(t.ctx.tempDir, name);
  return sigintRecording(XCRUN, ['simctl', 'io', t.udid, 'recordVideo', '--codec=h264', '--force', file], 20_000, async (exit) => {
    if (!exit.stopped) return fail(`Screen recording failed: ${tailLines(exit.stderr) || `simctl exited with code ${exit.code ?? '?'}`}`);
    const st = await fs.promises.stat(file).catch(() => undefined);
    if (!st || st.size === 0) return fail(`Screen recording failed: ${tailLines(exit.stderr) || 'no video was written'}`);
    return done('Recording saved', 'action.recording.saved', { url: t.ctx.fileUrl(name), file });
  });
}
