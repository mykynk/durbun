/** Device actions for Android devices/emulators (SPEC §5.5 "Actions"). */
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceActionId, DeviceActionResult, InstalledApp } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { failureText } from '../exec';
import { bool, done, ensureDir, fail, isPng, num, saveScreenshot, str, tempFileName, validAppId } from '../shared/files';
import { shellQuote } from '../shared/text';
import type { Adb } from './adb';
import { parsePackageDump, parsePackageList } from './parsers';

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
  if (api === undefined || api >= 19) actions.push('screen-record');
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

    case 'screen-record': {
      const secs = Math.round(num(params, 'durationSec') ?? 0);
      if (secs < 1 || secs > 180) return fail('durationSec must be between 1 and 180', 'action.invalidParams');
      const remote = `/sdcard/durbun-rec-${Date.now()}.mp4`;
      const rec = await shell(`screenrecord --time-limit ${secs} ${remote}`, (secs + 20) * 1000);
      if (!rec.ok) {
        void shell(`rm -f ${remote}`);
        return fail(`Screen recording failed: ${failureText(rec)}`);
      }
      await ensureDir(t.ctx.tempDir);
      const name = tempFileName('recording', t.label, 'mp4');
      const local = path.join(t.ctx.tempDir, name);
      const pull = await adb.run(['-s', serial, 'pull', remote, local], { timeoutMs: 120_000 });
      void shell(`rm -f ${remote}`);
      if (!pull.ok) return fail(`Could not copy the recording: ${failureText(pull)}`);
      return done('Recording saved', 'action.recording.saved', { url: t.ctx.fileUrl(name), file: local });
    }

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
