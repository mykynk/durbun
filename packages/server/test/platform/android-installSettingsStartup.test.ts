/**
 * Android: split-APK installs (.apks from bundletool, .xapk) and what install refusals mean; settings Dürbün
 * changes keep their old value and can be put back; activity start times from system_server's log lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceActionId, DeviceSettingOverride } from '@durbun/protocol';
import { parseNightMode, runAndroidAction, type AndroidActionTarget, type SettingOverrides } from '../../src/platform/android/actions';
import type { Adb } from '../../src/platform/android/adb';
import { androidPackageKind, chooseSplits, installFailure, parseDeviceSpec } from '../../src/platform/android/install';
import { AndroidLogPipeline, parseAppStartup, parseDuration, selectBackfill } from '../../src/platform/android/logcat';
import type { RunResult } from '../../src/platform/exec';
import { ScreenRecorder } from '../../src/platform/shared/screenRecord';
import type { DeviceLogInput } from '../../src/types';
import { createZip } from '../../src/util/zip';
import { createCtx } from './helpers';

const ok = (stdout = '', stderr = ''): RunResult<string> => ({ ok: true, code: 0, signal: null, stdout, stderr, timedOut: false });
const bad = (stdout: string, stderr = ''): RunResult<string> => ({ ok: false, code: 1, signal: null, stdout, stderr, timedOut: false });

/** Galaxy A73 (arm64, 400 dpi by default with a 450 dpi override set in developer options). */
const A73_SPEC = 'arm64-v8a,armeabi-v7a,armeabi\nPhysical density: 400\nOverride density: 450\n';

function fakeAdb(handlers: { shell?: (cmd: string) => RunResult<string>; run?: (args: string[]) => RunResult<string> }) {
  const calls: string[] = [];
  const adb = {
    async shell(_serial: string, cmd: string) {
      calls.push(`shell ${cmd}`);
      return handlers.shell?.(cmd) ?? ok();
    },
    async run(args: string[]) {
      calls.push(args.slice(2).join(' '));
      return handlers.run?.(args) ?? ok('Success\n');
    },
  } as unknown as Adb;
  return { adb, calls };
}

function target(adb: Adb, extra: Partial<AndroidActionTarget> = {}): AndroidActionTarget {
  return {
    adb,
    serial: 'R58T30ABCDE',
    deviceId: 'android:R58T30ABCDE',
    label: 'Galaxy A73',
    isEmulator: false,
    apiLevel: 34,
    ctx: createCtx(),
    restartLogs: async () => undefined,
    recorder: new ScreenRecorder(() => undefined),
    ...extra,
  };
}

describe('split APK choice', () => {
  // bundletool build-apks (default mode): splits/<module>-<config>.apk, standalones/ for Android 4.x, toc.pb.
  const apks = [
    'toc.pb',
    'splits/base-master.apk',
    'splits/base-arm64_v8a.apk',
    'splits/base-armeabi_v7a.apk',
    'splits/base-x86_64.apk',
    'splits/base-hdpi.apk',
    'splits/base-xhdpi.apk',
    'splits/base-xxhdpi.apk',
    'splits/base-xxxhdpi.apk',
    'splits/base-tr.apk',
    'splits/base-en.apk',
    'splits/camera-master.apk',
    'standalones/standalone-armeabi_v7a_hdpi.apk',
    'standalones/standalone-arm64_v8a_xxhdpi.apk',
  ];

  it('reads the phone spec and picks master, the preferred ABI, the next density up and every language', () => {
    const spec = parseDeviceSpec(A73_SPEC);
    expect(spec).toEqual({ abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'], density: 450 });
    expect(chooseSplits(apks, 'apks', spec, 34)).toEqual({
      apks: ['splits/base-master.apk', 'splits/camera-master.apk', 'splits/base-arm64_v8a.apk', 'splits/base-xxhdpi.apk', 'splits/base-tr.apk', 'splits/base-en.apk'],
      obb: [],
    });
    // Android 4.4: one standalone APK.
    expect(chooseSplits(apks, 'apks', { abis: ['armeabi-v7a'], density: 240 }, 19)).toEqual({ apks: ['standalones/standalone-armeabi_v7a_hdpi.apk'], obb: [] });
    // --mode=universal
    expect(chooseSplits(['toc.pb', 'universal.apk'], 'apks', spec, 34)).toEqual({ apks: ['universal.apk'], obb: [] });
    expect(chooseSplits(['splits/base-master.apk', 'splits/base-x86_64.apk'], 'apks', spec, 34)).toEqual({ error: 'noMatchingAbis', available: ['x86-64'] });
    expect(chooseSplits(['toc.pb'], 'apks', spec, 34)).toEqual({ error: 'empty' });
  });

  it('reads .xapk layouts and their OBB data', () => {
    const xapk = [
      'manifest.json',
      'icon.png',
      'com.mykynk.oyun.apk',
      'config.arm64_v8a.apk',
      'config.armeabi_v7a.apk',
      'config.xxhdpi.apk',
      'config.tr.apk',
      'Android/obb/com.mykynk.oyun/main.42.com.mykynk.oyun.obb',
    ];
    expect(chooseSplits(xapk, 'xapk', parseDeviceSpec(A73_SPEC), 34)).toEqual({
      apks: ['com.mykynk.oyun.apk', 'config.arm64_v8a.apk', 'config.xxhdpi.apk', 'config.tr.apk'],
      obb: ['Android/obb/com.mykynk.oyun/main.42.com.mykynk.oyun.obb'],
    });
    expect(androidPackageKind('/x/Oyun.XAPK')).toBe('xapk');
    expect(androidPackageKind('/x/app.aab')).toBeUndefined();
  });

  it('names the common install refusals', () => {
    const cases: Array<[string, string]> = [
      ['adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.mykynk.pati signatures do not match newer version; ignoring!]', 'action.install.signatureMismatch'],
      ['Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 56 is older than current 57]', 'action.install.downgrade'],
      ['adb: failed to install app.apk: Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]', 'action.install.userRestricted'],
      ['Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]', 'action.install.noSpace'],
      ['Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]', 'action.install.noMatchingAbis'],
      ['Failure [INSTALL_FAILED_OLDER_SDK: Failed parse during installPackageLI: /data/app/vmdl1.tmp/base.apk (at Binary XML file line #7): Requires newer sdk version #35 (current version is #33)]', 'action.install.olderSdk'],
      ['Failure [INSTALL_FAILED_MISSING_SPLIT: Missing split for com.mykynk.pati]', 'action.install.missingSplit'],
      ['Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES: Failed collecting certificates for /data/app/vmdl2.tmp/base.apk]', 'action.install.notSigned'],
      ['Failure [INSTALL_FAILED_VERIFICATION_FAILURE]', 'action.install.verificationFailed'],
      ['Failure [INSTALL_FAILED_DUPLICATE_PERMISSION: Package com.x attempting to redeclare permission]', 'action.installFailed'],
      ['adb: device offline', 'action.installFailed'],
    ];
    for (const [out, code] of cases) expect(installFailure(out).code, out).toBe(code);
    expect(installFailure(cases[0]![0]).reason).toMatch(/^INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package/);
  });
});

describe('app-install', () => {
  it('installs the fitting splits of an .apks together and maps a refusal to its code', async () => {
    const ctx = createCtx();
    const file = path.join(ctx.tempDir, 'pati.apks');
    fs.mkdirSync(ctx.tempDir, { recursive: true });
    const apk = (name: string) => ({ name, data: Buffer.from(`PK-${name}`) });
    fs.writeFileSync(
      file,
      createZip([apk('splits/base-master.apk'), apk('splits/base-arm64_v8a.apk'), apk('splits/base-x86.apk'), apk('splits/base-xxhdpi.apk'), apk('splits/base-mdpi.apk'), { name: 'toc.pb', data: Buffer.from([8, 1]) }]),
    );
    let refuse = false;
    const { adb, calls } = fakeAdb({
      shell: (cmd) => (cmd.startsWith('getprop') ? ok(A73_SPEC) : ok()),
      run: () => (refuse ? bad('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.mykynk.pati signatures do not match newer version; ignoring!]') : ok('Success\n')),
    });
    const r = await runAndroidAction(target(adb, { ctx }), 'app-install', { file });
    expect(r).toMatchObject({ ok: true, message: 'Installed pati.apks (3 APKs)' });
    const install = calls.find((c) => c.startsWith('install-multiple'))!;
    expect(install.split(' ').slice(0, 4)).toEqual(['install-multiple', '-r', '-t', '-d']);
    expect(install.split(' ').slice(4).map((p) => path.basename(p))).toEqual(['base-master.apk', 'base-arm64_v8a.apk', 'base-xxhdpi.apk']);
    // The unpacked copy is gone afterwards.
    expect(fs.readdirSync(ctx.tempDir).filter((n) => n.startsWith('install-'))).toEqual([]);
    refuse = true;
    const refused = await runAndroidAction(target(adb, { ctx }), 'app-install', { file });
    expect(refused).toMatchObject({ ok: false, code: 'action.install.signatureMismatch' });
    expect(refused.message).toMatch(/^Install failed: INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
    const aab = path.join(ctx.tempDir, 'pati.aab');
    fs.writeFileSync(aab, 'PK');
    expect(await runAndroidAction(target(adb, { ctx }), 'app-install', { file: aab })).toMatchObject({ ok: false, code: 'action.unsupportedFile' });
  });
});

/** The device's settings as `settings get` / `cmd uimode night` print them. */
function settingsPhone(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const shell = (cmd: string): RunResult<string> => {
    const out: string[] = [];
    for (const part of cmd.split('; ')) {
      const words = part.trim().split(' ');
      if (words[0] === 'settings' && words[1] === 'get') out.push(values.get(words[3]!) ?? 'null');
      else if (words[0] === 'settings' && words[1] === 'put') values.set(words[3]!, words[4]!);
      else if (words[0] === 'settings' && words[1] === 'delete') values.delete(words[3]!);
      else if (part === 'cmd uimode night') out.push(`Night mode: ${values.get('night') ?? 'no'}`);
      else if (words[0] === 'cmd' && words[1] === 'uimode') values.set('night', words[3]!);
    }
    return ok(out.length ? `${out.join('\n')}\n` : '');
  };
  return { values, shell };
}

function overrideStore() {
  const map = new Map<DeviceActionId, DeviceSettingOverride>();
  const store: SettingOverrides = { get: (a) => map.get(a), set: (o) => void map.set(o.action, o), delete: (a) => void map.delete(a) };
  return { map, store };
}

describe('settings Dürbün changes', () => {
  it('keeps the value from before the first change and puts it back', async () => {
    const phone = settingsPhone({ window_animation_scale: '0.5', transition_animation_scale: '0.5', animator_duration_scale: '0.5', font_scale: '1.15' });
    const { adb } = fakeAdb({ shell: phone.shell });
    const { map, store } = overrideStore();
    const t = target(adb, { overrides: store });
    expect(await runAndroidAction(t, 'animations', { enabled: false })).toMatchObject({ ok: true, message: 'Animations disabled' });
    expect(phone.values.get('window_animation_scale')).toBe('0');
    await runAndroidAction(t, 'animations', { enabled: true });
    // The second change keeps the first "before" value.
    expect(map.get('animations')).toMatchObject({ previous: '0.5', current: '1' });
    const restored = await runAndroidAction(t, 'animations', { restore: true });
    expect(restored).toMatchObject({ ok: true, code: 'action.settingRestored', data: { previous: '1', current: '0.5' } });
    expect(phone.values.get('animator_duration_scale')).toBe('0.5');
    expect(map.has('animations')).toBe(false);
    expect(await runAndroidAction(t, 'animations', { restore: true })).toMatchObject({ ok: true, code: 'action.nothingToRestore' });

    // An unset key (the platform default) is deleted again rather than written.
    await runAndroidAction(t, 'appearance', { mode: 'dark' });
    expect(map.get('appearance')).toMatchObject({ previous: 'no', current: 'yes' });
    await runAndroidAction(t, 'appearance', { mode: 'light' });
    expect(map.has('appearance')).toBe(false); // back where it was: nothing to undo
    phone.values.delete('font_scale');
    await runAndroidAction(t, 'font-scale', { scale: 1.3 });
    expect(map.get('font-scale')).toMatchObject({ previous: 'default', current: '1.3' });
    await runAndroidAction(t, 'font-scale', { restore: true });
    expect(phone.values.has('font_scale')).toBe(false);
  });

  it('writes blind without an override store (as before) and reads every night mode form', async () => {
    const { adb, calls } = fakeAdb({});
    await runAndroidAction(target(adb), 'font-scale', { scale: 1.3 });
    expect(calls).toEqual(['shell settings put system font_scale 1.3']);
    expect(parseNightMode('Night mode: auto')).toBe('auto');
    expect(parseNightMode('Night mode: custom_schedule')).toBeUndefined();
  });
});

const T0 = 1793608981000;
const epoch = (ms: number) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
const line = (ms: number, pid: number, tid: number, lvl: string, tag: string, msg: string) =>
  `${epoch(ms).padStart(20)} ${String(pid).padStart(5)} ${String(tid).padStart(5)} ${lvl} ${tag.padEnd(8)}: ${msg}`;

describe('activity start times', () => {
  it('reads the "Displayed" and "Fully drawn" lines of every Android version', () => {
    expect(parseAppStartup('ActivityTaskManager', 'Displayed com.mykynk.pati/.MainActivity: +612ms')).toEqual({
      app: 'com.mykynk.pati',
      activity: '.MainActivity',
      kind: 'displayed',
      ms: 612,
    });
    expect(parseAppStartup('ActivityTaskManager', 'Displayed com.mykynk.pati/com.mykynk.pati.MainActivity for user 0: +1s34ms (total +1s502ms)')).toEqual({
      app: 'com.mykynk.pati',
      activity: 'com.mykynk.pati.MainActivity',
      kind: 'displayed',
      ms: 1034,
      totalMs: 1502,
    });
    expect(parseAppStartup('ActivityManager', 'Fully drawn com.mykynk.pati/.MainActivity: +2s110ms')).toMatchObject({ kind: 'fully-drawn', ms: 2110 });
    expect(parseAppStartup('Pati', 'Displayed com.mykynk.pati/.MainActivity: +612ms')).toBeNull();
    expect(parseDuration('+1m2s3ms')).toBe(62003);
    expect(parseDuration('+')).toBeUndefined();
  });

  it('shows the line with the app (its pid when known) and keeps it from the history', () => {
    const out: DeviceLogInput[] = [];
    const p = new AndroidLogPipeline({ emit: (e) => out.push(e), pidOf: (name) => (name === 'com.mykynk.pati' ? 4321 : undefined) });
    p.pushLine(line(T0, 1630, 1702, 'I', 'ActivityTaskManager', 'Displayed com.mykynk.pati/.MainActivity: +612ms'));
    p.flush();
    expect(out[0]).toMatchObject({ pid: 4321, process: 'com.mykynk.pati', data: { startup: { app: 'com.mykynk.pati', ms: 612 }, reporterPid: 1630 } });
    const dump = [
      line(T0, 1630, 1702, 'I', 'ActivityTaskManager', 'Displayed com.mykynk.pati/.MainActivity: +612ms'),
      line(T0 + 5, 1630, 1702, 'I', 'ActivityTaskManager', 'Displayed com.android.settings/.Settings: +301ms'),
      line(T0 + 10, 900, 920, 'I', 'wpa_supplicant', 'tail'),
    ];
    const plan = selectBackfill(dump, { tail: 1, isAppProcess: (n) => n === 'com.mykynk.pati' });
    expect(plan.lines).toEqual([dump[0], dump[2]]);
  });
});

describe('app-stop in the background (process death)', () => {
  it('goes Home, lets the system kill the app and checks that it is gone', async () => {
    let alive = true;
    const { adb, calls } = fakeAdb({
      shell: (cmd) => {
        if (cmd.startsWith('pidof')) return alive ? ok('4321\n') : bad('');
        if (cmd.startsWith('am kill')) alive = false;
        return ok();
      },
    });
    const r = await runAndroidAction(target(adb), 'app-stop', { appId: 'com.mykynk.pati', background: true });
    expect(r).toMatchObject({ ok: true, code: 'action.backgroundKilled' });
    expect(calls).toEqual(['shell pidof com.mykynk.pati', 'shell input keyevent 3', 'shell am kill com.mykynk.pati', 'shell pidof com.mykynk.pati']);
    // Not running at all, and kept alive by a foreground service.
    expect(await runAndroidAction(target(adb), 'app-stop', { appId: 'com.mykynk.pati', background: true })).toMatchObject({ ok: false, code: 'action.appNotRunning' });
    const service = fakeAdb({ shell: (cmd) => (cmd.startsWith('pidof') ? ok('4321\n') : ok()) });
    expect(await runAndroidAction(target(service.adb), 'app-stop', { appId: 'com.mykynk.pati', background: true })).toMatchObject({
      ok: false,
      code: 'action.backgroundKillRefused',
    });
  });
});
