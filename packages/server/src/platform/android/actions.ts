/** Device actions for Android devices/emulators (SPEC §5.5 "Actions"). */
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceActionId, DeviceActionResult, DeviceSettingOverride, InstalledApp, LogBufferSizeData } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { failureText, killProcess, run } from '../exec';
import { bool, done, ensureDir, fail, isPng, num, saveScreenshot, str, tempFileName, validAppId } from '../shared/files';
import type { RecordingProcess, ScreenRecorder } from '../shared/screenRecord';
import { shellQuote } from '../shared/text';
import { sleep } from '../shared/timing';
import type { Adb } from './adb';
import { androidPackageKind, chooseSplits, installFailure, listFiles, parseDeviceSpec } from './install';
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
  /**
   * Settings Dürbün changed on this phone (kept by the driver across replugs). Present: the value before the
   * first change is read and kept, and `{ restore: true }` puts it back.
   */
  overrides?: SettingOverrides;
}

export interface SettingOverrides {
  get(action: DeviceActionId): DeviceSettingOverride | undefined;
  set(override: DeviceSettingOverride): void;
  delete(action: DeviceActionId): void;
}

const ANIMATION_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const;
/** `settings get` of a key nobody set prints "null": the platform default applies. */
const DEFAULT_VALUE = 'default';

/** One `settings get` line → value ("default" for an unset key), undefined when unreadable. */
function settingValue(line: string | undefined): string | undefined {
  const v = line?.trim();
  if (!v) return undefined;
  if (v === 'null') return DEFAULT_VALUE;
  return /^-?\d+(\.\d+)?$/.test(v) ? String(Number(v)) : undefined;
}

/** "1,1,1" → "1"; differing scales stay a list (window,transition,animator). */
function joinScales(values: string[]): string {
  return values.every((v) => v === values[0]) ? values[0]! : values.join(',');
}

/** `cmd uimode night` → "yes" | "no" | "auto" (other modes, such as a custom schedule, cannot be set back). */
export function parseNightMode(text: string): string | undefined {
  const v = /Night mode:\s*(\w+)/i.exec(text)?.[1]?.toLowerCase();
  return v === 'yes' || v === 'no' || v === 'auto' ? v : undefined;
}

/** Shell command that sets a setting to `value` (unset keys are deleted, so the platform default applies again). */
function putSetting(namespace: 'global' | 'system', key: string, value: string): string {
  return value === DEFAULT_VALUE ? `settings delete ${namespace} ${key}` : `settings put ${namespace} ${key} ${value}`;
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
      if (params.background === true) return backgroundKill(t, appId);
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
      const kind = androidPackageKind(file);
      if (!kind) return fail('Only .apk, .apks and .xapk files can be installed on Android', 'action.unsupportedFile');
      if (kind !== 'apk') return installArchive(t, file, kind);
      return installApks(t, [file], path.basename(file));
    }

    case 'logs-clear-buffer': {
      const r = await adb.run(['-s', serial, 'logcat', '-c'], { timeoutMs: 15_000 });
      if (!r.ok) return fail(`Could not clear the log buffer: ${failureText(r)}`);
      return done('Device log buffer cleared');
    }

    case 'logs-restart': {
      if (params.bufferSize === undefined) {
        await t.restartLogs();
        return done('Log stream restarted');
      }
      // Bigger log buffers keep more of the past for the next time the phone is plugged in.
      if (t.apiLevel !== undefined && t.apiLevel < 21) return fail('Log buffer sizes can be changed from Android 5 on', 'action.unsupported');
      const size = (str(params, 'bufferSize') ?? DEFAULT_LOG_BUFFER).toUpperCase();
      const bytes = logBufferBytes(size);
      if (bytes === undefined || bytes < 64 * 1024 || bytes > 256 * 1024 * 1024) {
        return fail('bufferSize must be between 64K and 256M (e.g. "16M")', 'action.invalidParams');
      }
      const before = parseLogBufferSizes((await adb.run(['-s', serial, 'logcat', '-g'], { timeoutMs: 15_000 })).stdout);
      const r = await adb.run(['-s', serial, 'logcat', '-G', size], { timeoutMs: 15_000 });
      const failed = !r.ok || /failed|error|denied|not permitted/i.test(`${r.stdout}\n${r.stderr}`);
      if (failed) return fail(`Could not change the log buffer size: ${failureText(r)}`);
      const after = parseLogBufferSizes((await adb.run(['-s', serial, 'logcat', '-g'], { timeoutMs: 15_000 })).stdout);
      const data: LogBufferSizeData = { before, after, requested: size };
      await t.restartLogs();
      return done(
        `Log buffers set to ${size} each until the phone restarts (Developer options › Logger buffer sizes keeps a size across restarts)`,
        'action.done',
        data,
      );
    }

    case 'appearance':
    case 'font-scale':
    case 'animations':
      return changeSetting(t, action, params);

    case 'input-text': {
      const text = typeof params.text === 'string' ? params.text : '';
      if (!text) return fail('text is required', 'action.invalidParams');
      if (!/^[\x20-\x7E\n]*$/.test(text)) {
        // adb's `input text` types through the ASCII key map only; no shell command types other characters.
        const others = [...new Set([...text].filter((c) => !/[\x20-\x7E\n]/.test(c)))].slice(0, 8).join(' ');
        return fail(`Android "input text" only supports printable ASCII characters: ${others}`, 'action.inputTextAscii');
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

interface SettingIo {
  read(): Promise<string | undefined>;
  write(value: string): Promise<DeviceActionResult | undefined>;
  label: string;
}

function settingIo(t: AndroidActionTarget, action: 'appearance' | 'font-scale' | 'animations'): SettingIo {
  const shell = (cmd: string) => t.adb.shell(t.serial, cmd);
  switch (action) {
    case 'appearance':
      return {
        label: 'Dark mode',
        read: async () => {
          const r = await shell('cmd uimode night');
          return r.ok ? parseNightMode(textOf(r)) : undefined;
        },
        write: async (value) => {
          const r = await shell(`cmd uimode night ${value}`);
          return !r.ok || /Error|Unknown command/i.test(r.stderr) ? fail(`Could not switch appearance: ${failureText(r)}`) : undefined;
        },
      };
    case 'font-scale':
      return {
        label: 'Font scale',
        read: async () => {
          const r = await shell('settings get system font_scale');
          return r.ok ? settingValue(r.stdout.split('\n')[0]) : undefined;
        },
        write: async (value) => {
          const r = await shell(putSetting('system', 'font_scale', value));
          return r.ok ? undefined : fail(`Could not set the font scale: ${failureText(r)}`);
        },
      };
    case 'animations':
      return {
        label: 'Animation scales',
        read: async () => {
          const r = await shell(ANIMATION_KEYS.map((k) => `settings get global ${k}`).join('; '));
          if (!r.ok) return undefined;
          const values = r.stdout.split('\n').filter((l) => l.trim()).map(settingValue);
          return values.length === 3 && values.every((v): v is string => v !== undefined) ? joinScales(values) : undefined;
        },
        write: async (value) => {
          const parts = value.split(',');
          const r = await shell(ANIMATION_KEYS.map((k, i) => putSetting('global', k, parts[parts.length === 3 ? i : 0]!)).join('; '));
          return r.ok ? undefined : fail(`Could not change animation scales: ${failureText(r)}`);
        },
      };
  }
}

/** Two setting values mean the same ("1.0" and "1"). */
const sameValue = (a: string, b: string) => a === b || (Number.isFinite(Number(a)) && Number(a) === Number(b) && a !== DEFAULT_VALUE && b !== DEFAULT_VALUE);

/**
 * Dark mode, font scale and animation scales: before Dürbün's first change the current value is read and kept
 * (`target.overrides`), so `{ restore: true }` can put it back later; a change back to that value forgets it.
 */
async function changeSetting(
  t: AndroidActionTarget,
  action: 'appearance' | 'font-scale' | 'animations',
  params: Record<string, unknown>,
): Promise<DeviceActionResult> {
  const io = settingIo(t, action);
  const overrides = t.overrides;
  if (params.restore === true) {
    const o = overrides?.get(action);
    if (!o) return done(`${io.label}: Dürbün has not changed it, nothing to restore`, 'action.nothingToRestore');
    const failed = await io.write(o.previous);
    if (failed) return failed;
    overrides!.delete(action);
    return done(`${io.label} restored to ${o.previous}`, 'action.settingRestored', { previous: o.current, current: o.previous });
  }
  let value: string;
  let message: string;
  if (action === 'appearance') {
    const mode = str(params, 'mode');
    if (mode !== 'dark' && mode !== 'light') return fail('mode must be "dark" or "light"', 'action.invalidParams');
    value = mode === 'dark' ? 'yes' : 'no';
    message = mode === 'dark' ? 'Dark mode on' : 'Light mode on';
  } else if (action === 'font-scale') {
    const scale = num(params, 'scale');
    if (scale === undefined || scale < 0.5 || scale > 2.0) return fail('scale must be a number between 0.5 and 2.0', 'action.invalidParams');
    value = String(Math.round(scale * 100) / 100);
    message = `Font scale set to ${value}`;
  } else {
    const enabled = bool(params, 'enabled');
    if (enabled === undefined) return fail('enabled (boolean) is required', 'action.invalidParams');
    value = enabled ? '1' : '0';
    message = enabled ? 'Animations enabled' : 'Animations disabled';
  }
  const kept = overrides?.get(action);
  const previous = overrides && !kept ? await io.read() : undefined;
  const failed = await io.write(value);
  if (failed) return failed;
  if (overrides) {
    const before = kept?.previous ?? previous;
    if (before !== undefined && sameValue(before, value)) overrides.delete(action);
    else if (before !== undefined) overrides.set({ action, previous: before, current: value, since: kept?.since ?? Date.now() });
  }
  return done(message);
}

/**
 * The system ending an app in the background (what happens under memory pressure), unlike a force stop: Home,
 * then `am kill`, which only ends processes the system may kill (background ones). Reopened from Recents, the
 * app has to restore its saved state. A foreground service keeps the process alive: then it says so.
 */
async function backgroundKill(t: AndroidActionTarget, appId: string): Promise<DeviceActionResult> {
  const shell = (cmd: string) => t.adb.shell(t.serial, cmd, { timeoutMs: 15_000 });
  const pids = async () => (await shell(`pidof ${shellQuote(appId)}`)).stdout.trim();
  if (!(await pids())) return fail(`${appId} is not running`, 'action.appNotRunning');
  await shell('input keyevent 3');
  await sleep(BACKGROUND_SETTLE_MS);
  const r = await shell(`am kill ${shellQuote(appId)}`);
  if (!r.ok) return fail(`Could not end ${appId} in the background: ${failureText(r)}`);
  await sleep(300);
  if (await pids()) {
    return fail(`${appId} keeps running in the background (a foreground service or a visible window keeps it alive)`, 'action.backgroundKillRefused');
  }
  return done(`${appId} was ended in the background; open it from Recents to check that it restores its state`, 'action.backgroundKilled');
}

/** Time for the app to move to the background after Home (its activity stops). */
export const BACKGROUND_SETTLE_MS = 1000;

/** `adb install` (one APK) or `adb install-multiple` (split APKs of one app); refusals get their own code. */
async function installApks(t: AndroidActionTarget, files: string[], label: string): Promise<DeviceActionResult> {
  const args = files.length === 1 ? ['install', '-r', '-t', '-d', files[0]!] : ['install-multiple', '-r', '-t', '-d', ...files];
  const r = await t.adb.run(['-s', t.serial, ...args], { timeoutMs: 10 * 60_000 });
  const out = textOf(r);
  if (/^Success/m.test(out)) return done(`Installed ${label}`);
  const { reason, code } = installFailure(out);
  return fail(`Install failed: ${reason ?? failureText(r)}`, code);
}

/** .apks / .xapk: unpack, pick the splits that fit the phone, install them together (OBB data of an .xapk after). */
async function installArchive(t: AndroidActionTarget, file: string, kind: 'apks' | 'xapk'): Promise<DeviceActionResult> {
  const { adb, serial } = t;
  await ensureDir(t.ctx.tempDir);
  const dir = await fs.promises.mkdtemp(path.join(t.ctx.tempDir, 'install-'));
  try {
    const unpack =
      process.platform === 'darwin'
        ? await run('/usr/bin/ditto', ['-x', '-k', file, dir], { timeoutMs: 5 * 60_000 })
        : await run('unzip', ['-q', '-o', file, '-d', dir], { timeoutMs: 5 * 60_000 });
    if (!unpack.ok) return fail(`Could not unpack ${path.basename(file)}: ${failureText(unpack)}`, 'action.unsupportedFile');
    const spec = parseDeviceSpec((await adb.shell(serial, 'getprop ro.product.cpu.abilist; wm density', { timeoutMs: 10_000 })).stdout);
    const choice = chooseSplits(await listFiles(dir), kind, spec, t.apiLevel);
    if ('error' in choice) {
      if (choice.error === 'noMatchingAbis') {
        return fail(
          `Install failed: INSTALL_FAILED_NO_MATCHING_ABIS: the package has native code for ${choice.available.join(', ')} only; this phone runs ${spec.abis.join(', ')}`,
          'action.install.noMatchingAbis',
        );
      }
      return fail(`${path.basename(file)} has no APK to install`, 'action.unsupportedFile');
    }
    const installed = await installApks(
      t,
      choice.apks.map((a) => path.join(dir, ...a.split('/'))),
      `${path.basename(file)} (${choice.apks.length} APK${choice.apks.length === 1 ? '' : 's'})`,
    );
    if (!installed.ok || !choice.obb.length) return installed;
    for (const obb of choice.obb) {
      const remote = `/sdcard/${obb}`;
      await adb.shell(serial, `mkdir -p ${shellQuote(path.posix.dirname(remote))}`, { timeoutMs: 15_000 });
      const push = await adb.run(['-s', serial, 'push', path.join(dir, ...obb.split('/')), remote], { timeoutMs: 15 * 60_000 });
      if (!push.ok) return fail(`The app was installed, but its data file ${path.posix.basename(obb)} could not be copied: ${failureText(push)}`, 'action.install.obbFailed');
    }
    return done(`${installed.message ?? 'Installed'} with ${choice.obb.length} OBB data file${choice.obb.length === 1 ? '' : 's'}`);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
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

const DEFAULT_LOG_BUFFER = '16M';

/** "16M" → 16777216, "256K" → 262144. */
export function logBufferBytes(size: string): number | undefined {
  const m = /^(\d+)([KM])$/.exec(size.trim().toUpperCase());
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === 'M' ? 1024 * 1024 : 1024);
}

/**
 * `logcat -g` → bytes per buffer:
 *   main: ring buffer is 256 KiB (193 KiB consumed, 193 KiB readable), max entry is 5120 B, max payload is 4068 B
 *   main: ring buffer is 256Kb (191Kb consumed), max entry is 5120b, max payload is 4076b      (Android ≤ 11)
 */
export function parseLogBufferSizes(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(\w+): ring buffer is ([\d.]+)\s*([KMG]?)(?:i?B|b)\b/.exec(line);
    if (!m) continue;
    const mult = m[3] === 'G' ? 1024 ** 3 : m[3] === 'M' ? 1024 ** 2 : m[3] === 'K' ? 1024 : 1;
    out[m[1]!] = Math.round(Number(m[2]) * mult);
  }
  return out;
}
