/** Device actions for Android devices/emulators (SPEC §5.5 "Actions"). */
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceActionId, DeviceActionResult, InstalledApp } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { failureText, killProcess } from '../exec';
import { bool, done, ensureDir, fail, isPng, num, saveScreenshot, str, tempFileName, validAppId } from '../shared/files';
import type { RecordingProcess, ScreenRecorder } from '../shared/screenRecord';
import { shellQuote } from '../shared/text';
import { sleep } from '../shared/timing';
import type { Adb } from './adb';
import { parseCurrentScreenSize, parsePackageDump, parsePackageList } from './parsers';

export interface AndroidActionTarget {
  adb: Adb;
  serial: string;
  deviceId: string;
  /** Human label used in file names. */
  label: string;
  isEmulator: boolean;
  apiLevel?: number;
  ctx: DriverContext;
  restartLogs(): Promise<void>;
  recorder: ScreenRecorder;
}

export const ANDROID_KEY_CODES: Record<string, number> = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  'volume-up': 24,
  'volume-down': 25,
  enter: 66,
  delete: 67,
  menu: 82,
};

/** Actions that work for an Android device in its current state. */
export function androidActionsFor(opts: { online: boolean; isEmulator: boolean; apiLevel?: number }): DeviceActionId[] {
  if (!opts.online) return [];
  const api = opts.apiLevel;
  const actions: DeviceActionId[] = [
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
  ];
  // System-wide dark theme exists since Android 10 (API 29).
  if (api === undefined || api >= 29) actions.push('appearance');
  actions.push('font-scale', 'animations', 'input-text', 'key-event');
  if (opts.isEmulator) actions.push('location');
  if (api === undefined || api >= 19) actions.push('screen-record', 'screen-record-stop');
  return actions;
}

function textOf(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}\n${r.stderr}`.trim();
}

/** Escape text for `input text` (spaces → %s, shell-quoted). ASCII only. */
export function escapeInputText(text: string): string {
  return shellQuote(text.replace(/ /g, '%s'));
}

export async function runAndroidAction(
  t: AndroidActionTarget,
  action: DeviceActionId,
  params: Record<string, unknown>,
): Promise<DeviceActionResult> {
  const { adb, serial } = t;
  const shell = (cmd: string, timeoutMs?: number) => adb.shell(serial, cmd, timeoutMs ? { timeoutMs } : undefined);
  const needApp = (): string | DeviceActionResult => {
    const appId = str(params, 'appId');
    if (!validAppId(appId)) return fail('A valid package name (appId) is required', 'action.invalidParams');
    return appId;
  };

  switch (action) {
    case 'screenshot': {
      const r = await adb.runBuffer(['-s', serial, 'exec-out', 'screencap', '-p'], {
        timeoutMs: 30_000,
        maxBuffer: 96 * 1024 * 1024,
      });
      if (!r.ok || !isPng(r.stdout)) {
        return fail(`Screenshot failed: ${failureText(r, 'screencap failed')}`);
      }
      return saveScreenshot(t.ctx, t.label, r.stdout);
    }

    case 'open-url': {
      const url = str(params, 'url');
      if (!url || url.length > 4096) return fail('A URL is required', 'action.invalidParams');
      const r = await shell(`am start -a android.intent.action.VIEW -d ${shellQuote(url)}`);
      const out = textOf(r);
      if (!r.ok || /^Error:/m.test(out)) {
        return fail(`Could not open the URL: ${/^Error:.*$/m.exec(out)?.[0] ?? failureText(r)}`, 'action.openUrlFailed');
      }
      return done(`Opened ${url}`);
    }

    case 'list-apps': {
      const includeSystem = bool(params, 'includeSystem') === true;
      const dumpCmd =
        "dumpsys package packages | grep -E '^ +Package \\[|^ +versionName=|^ +(pkg)?[Ff]lags=\\['";
      const [third, all, dump] = await Promise.all([
        shell('pm list packages -3'),
        includeSystem ? shell('pm list packages') : Promise.resolve(undefined),
        shell(dumpCmd, 30_000),
      ]);
      if (!third.ok) return fail(`Could not list packages: ${failureText(third)}`);
      const meta = dump.ok ? parsePackageDump(dump.stdout) : new Map();
      const thirdIds = parsePackageList(third.stdout);
      const thirdSet = new Set(thirdIds);
      const ids = all?.ok ? parsePackageList(all.stdout) : thirdIds;
      const apps: InstalledApp[] = [...new Set([...thirdIds, ...ids])]
        .sort((a, b) => a.localeCompare(b))
        .map((id) => {
          const m = meta.get(id);
          const app: InstalledApp = { id, system: !thirdSet.has(id) };
          if (m?.version) app.version = m.version;
          if (m?.debuggable !== undefined) app.debuggable = m.debuggable;
          return app;
        });
      return done(`${apps.length} apps`, 'action.listApps', apps);
    }

    case 'app-launch': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      return launch(t, appId);
    }

    case 'app-stop': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const r = await shell(`am force-stop ${shellQuote(appId)}`);
      if (!r.ok) return fail(`Could not stop ${appId}: ${failureText(r)}`);
      return done(`Stopped ${appId}`);
    }

    case 'app-restart': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const r = await shell(`am force-stop ${shellQuote(appId)}`);
      if (!r.ok) return fail(`Could not stop ${appId}: ${failureText(r)}`);
      return launch(t, appId, `Restarted ${appId}`);
    }

    case 'app-clear-data': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const r = await shell(`pm clear ${shellQuote(appId)}`, 60_000);
      if (!r.ok || !/Success/.test(r.stdout)) {
        return fail(`Could not clear data of ${appId}: ${failureText(r)}`);
      }
      return done(`Cleared data of ${appId}`);
    }

    case 'app-uninstall': {
      const appId = needApp();
      if (typeof appId !== 'string') return appId;
      const r = await adb.run(['-s', serial, 'uninstall', appId], { timeoutMs: 120_000 });
      const out = textOf(r);
      if (!/^Success/m.test(out)) {
        const reason = /Failure \[([^\]]+)\]/.exec(out)?.[1] ?? failureText(r);
        return fail(`Could not uninstall ${appId}: ${reason}`, 'action.uninstallFailed');
      }
      return done(`Uninstalled ${appId}`);
    }

    case 'app-install': {
      const file = str(params, 'file');
      if (!file || !path.isAbsolute(file)) return fail('An absolute APK file path is required', 'action.invalidParams');
      const st = await fs.promises.stat(file).catch(() => undefined);
      if (!st?.isFile()) return fail(`File not found: ${file}`, 'action.fileNotFound');
      if (!/\.apk$/i.test(file)) return fail('Only .apk files can be installed on Android', 'action.unsupportedFile');
      const r = await adb.run(['-s', serial, 'install', '-r', '-t', '-d', file], { timeoutMs: 10 * 60_000 });
      const out = textOf(r);
      if (!/^Success/m.test(out)) {
        const reason = /Failure \[([^\]]+)\]/.exec(out)?.[1] ?? failureText(r);
        return fail(`Install failed: ${reason}`, 'action.installFailed');
      }
      return done(`Installed ${path.basename(file)}`);
    }

    case 'logs-clear-buffer': {
      const r = await adb.run(['-s', serial, 'logcat', '-c'], { timeoutMs: 15_000 });
      if (!r.ok) return fail(`Could not clear the log buffer: ${failureText(r)}`);
      return done('Device log buffer cleared');
    }

    case 'logs-restart': {
      await t.restartLogs();
      return done('Log stream restarted');
    }

    case 'appearance': {
      const mode = str(params, 'mode');
      if (mode !== 'dark' && mode !== 'light') return fail('mode must be "dark" or "light"', 'action.invalidParams');
      const r = await shell(`cmd uimode night ${mode === 'dark' ? 'yes' : 'no'}`);
      if (!r.ok || /Error|Unknown command/i.test(r.stderr)) {
        return fail(`Could not switch appearance: ${failureText(r)}`);
      }
      return done(mode === 'dark' ? 'Dark mode on' : 'Light mode on');
    }

    case 'font-scale': {
      const scale = num(params, 'scale');
      if (scale === undefined || scale < 0.5 || scale > 2.0) {
        return fail('scale must be a number between 0.5 and 2.0', 'action.invalidParams');
      }
      const value = String(Math.round(scale * 100) / 100);
      const r = await shell(`settings put system font_scale ${value}`);
      if (!r.ok) return fail(`Could not set the font scale: ${failureText(r)}`);
      return done(`Font scale set to ${value}`);
    }

    case 'animations': {
      const enabled = bool(params, 'enabled');
      if (enabled === undefined) return fail('enabled (boolean) is required', 'action.invalidParams');
      const v = enabled ? '1' : '0';
      const r = await shell(
        ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']
          .map((k) => `settings put global ${k} ${v}`)
          .join('; '),
      );
      if (!r.ok) return fail(`Could not change animation scales: ${failureText(r)}`);
      return done(enabled ? 'Animations enabled' : 'Animations disabled');
    }

    case 'input-text': {
      const text = typeof params.text === 'string' ? params.text : '';
      if (!text) return fail('text is required', 'action.invalidParams');
      if (!/^[\x20-\x7E\n]*$/.test(text)) {
        return fail('Android "input text" only supports printable ASCII characters', 'action.inputTextAscii');
      }
      const parts = text.split('\n');
      const cmds: string[] = [];
      parts.forEach((part, i) => {
        if (part) cmds.push(`input text ${escapeInputText(part)}`);
        if (i < parts.length - 1) cmds.push('input keyevent 66');
      });
      const r = await shell(cmds.join(' && '), 60_000);
      if (!r.ok) return fail(`Could not type the text: ${failureText(r)}`);
      return done('Text sent');
    }

    case 'key-event': {
      const key = str(params, 'key');
      const code = key ? ANDROID_KEY_CODES[key] : undefined;
      if (code === undefined) return fail(`Unknown key "${key ?? ''}"`, 'action.invalidParams');
      const r = await shell(`input keyevent ${code}`);
      if (!r.ok) return fail(`Could not send the key: ${failureText(r)}`);
      return done(`Sent ${key}`);
    }

    case 'location': {
      if (!t.isEmulator) return fail('Setting the location only works on emulators', 'action.unsupported');
      const lat = num(params, 'lat');
      const lon = num(params, 'lon');
      if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return fail('lat (−90…90) and lon (−180…180) are required', 'action.invalidParams');
      }
      // Note the argument order of the emulator console: longitude first.
      const r = await adb.run(['-s', serial, 'emu', 'geo', 'fix', String(lon), String(lat)], { timeoutMs: 10_000 });
      if (!r.ok || /KO|error/i.test(textOf(r))) return fail(`Could not set the location: ${failureText(r)}`);
      return done(`Location set to ${lat}, ${lon}`);
    }

    case 'screen-record':
      return t.recorder.record(params, ANDROID_RECORD_MAX_SEC, () => startRecording(t));

    case 'screen-record-stop':
      return t.recorder.stop();

    default:
      return fail(`"${action}" is not supported on Android devices`, 'action.unsupported');
  }
}

async function launch(t: AndroidActionTarget, appId: string, okMessage?: string): Promise<DeviceActionResult> {
  const r = await t.adb.shell(
    t.serial,
    `monkey -p ${shellQuote(appId)} -c android.intent.category.LAUNCHER 1`,
    { timeoutMs: 30_000 },
  );
  const out = textOf(r);
  if (/No activities found|monkey aborted/i.test(out) || !/Events injected: 1/.test(out)) {
    const reason = /No activities found/i.test(out)
      ? `${appId} has no launcher activity or is not installed`
      : failureText(r);
    return fail(`Could not launch ${appId}: ${reason}`, 'action.launchFailed');
  }
  return done(okMessage ?? `Launched ${appId}`);
}

/** `screenrecord` stops by itself at 180 s, its largest `--time-limit`. */
export const ANDROID_RECORD_MAX_SEC = 180;

/**
 * `screenrecord --size` for a screen whose long side is over 1920 px: hardware encoders refuse much more than
 * 1080p (a 1080×2400 Galaxy A73 fails at once with "Encoder failed (err=-38)"). Keeps the aspect ratio, sides
 * are multiples of 16; undefined = record at the screen's own size.
 */
export function recordSize(width: number, height: number): string | undefined {
  const scale = 1920 / Math.max(width, height);
  if (scale >= 1) return undefined;
  const fit = (n: number) => Math.max(16, Math.floor((n * scale) / 16) * 16);
  return `${fit(width)}x${fit(height)}`;
}

/**
 * `screenrecord` runs in a long `adb shell`; `exec` keeps the shell's pid, so the `$$` printed first is
 * screenrecord's. Stopping sends it SIGINT on the device, which finishes the mp4 (closing adb would only hang
 * it up and leave an unplayable file); then the file is pulled.
 */
async function startRecording(t: AndroidActionTarget): Promise<RecordingProcess> {
  const { adb, serial } = t;
  const remote = `/sdcard/durbun-rec-${Date.now()}.mp4`;
  const screen = await adb.shell(serial, "dumpsys display | grep -o 'real [0-9]* x [0-9]*'; wm size", { timeoutMs: 10_000 });
  const current = parseCurrentScreenSize(screen.stdout);
  const size = current ? recordSize(current.width, current.height) : undefined;
  const child = adb.spawnShell(
    serial,
    `echo durbun-pid:$$; exec screenrecord ${size ? `--size ${size} ` : ''}--time-limit ${ANDROID_RECORD_MAX_SEC} ${remote}`,
  );
  let out = '';
  let resolvePid: (pid: number | undefined) => void = () => {};
  const pid = new Promise<number | undefined>((resolve) => (resolvePid = resolve));
  const collect = (d: string) => {
    if (out.length < 8000) out += d;
    const m = /durbun-pid:(\d+)/.exec(out);
    if (m) resolvePid(Number(m[1]));
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', collect);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', collect);
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(code));
  });
  void exited.then(() => resolvePid(undefined));
  const output = () => out.replace(/durbun-pid:\d+\s*/, '').trim();
  return {
    stop() {
      // screenrecord finishes the file within a second or two; an adb that does not return is killed.
      const hung = setTimeout(() => void killProcess(child), 30_000);
      hung.unref?.();
      void exited.then(() => clearTimeout(hung));
      void Promise.race([pid, sleep(5000).then(() => undefined)])
        .then((p) => adb.shell(serial, p ? `kill -2 ${p}` : 'kill -2 $(pidof screenrecord)', { timeoutMs: 10_000 }))
        .catch(() => undefined);
    },
    async result(stopped) {
      const code = await exited;
      // adb without the shell protocol (old devices) always exits 0; a missing file then fails the pull.
      if (!stopped() && code !== 0) {
        await adb.shell(serial, `rm -f ${remote}`);
        return fail(`Screen recording failed: ${output() || `adb exited with code ${code ?? '?'}`}`);
      }
      await ensureDir(t.ctx.tempDir);
      const name = tempFileName('recording', t.label, 'mp4');
      const local = path.join(t.ctx.tempDir, name);
      const pull = await adb.run(['-s', serial, 'pull', remote, local], { timeoutMs: 120_000 });
      await adb.shell(serial, `rm -f ${remote}`);
      if (!pull.ok) return fail(`Could not copy the recording: ${output() || failureText(pull)}`);
      // e.g. "Encoder failed" leaves an empty file behind.
      const st = await fs.promises.stat(local).catch(() => undefined);
      if (!st || st.size === 0) {
        await fs.promises.rm(local, { force: true });
        return fail(`Screen recording failed: ${output() || 'no video was written'}`);
      }
      return done('Recording saved', 'action.recording.saved', { url: t.ctx.fileUrl(name), file: local });
    },
  };
}
