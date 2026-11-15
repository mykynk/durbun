/**
 * Android: why an action is missing (DeviceInfo.unavailableActions), the tester's reproduction actions (airplane
 * mode, Wi-Fi, mobile data, rotation, "Don't keep activities", an app's permission and language) with their
 * "put it back" values, users / work profiles (`--user`), install refusals that offer "uninstall and install",
 * and the full device report (`adb bugreport`).
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceActionId, DeviceSettingOverride } from '@durbun/protocol';
import { androidActionAvailability, packageFromRefusal, parseResolvedComponent, runAndroidAction, type AndroidActionTarget } from '../../src/platform/android/actions';
import type { Adb } from '../../src/platform/android/adb';
import { apkPackageId, manifestPackage, readZipEntry } from '../../src/platform/android/apkManifest';
import { BugReporter, parseBugReportProgress } from '../../src/platform/android/bugReport';
import {
  overrideKey,
  parseAirplaneMode,
  parseAppLocales,
  parseRotation,
  parseRuntimePermission,
  parseWifiOn,
  type SettingOverrides,
} from '../../src/platform/android/deviceSettings';
import { parseCurrentUser, parseUserList, userParam } from '../../src/platform/android/users';
import type { RunResult } from '../../src/platform/exec';
import { ScreenRecorder } from '../../src/platform/shared/screenRecord';
import { createCtx, waitFor } from './helpers';

const ok = (stdout = '', stderr = ''): RunResult<string> => ({ ok: true, code: 0, signal: null, stdout, stderr, timedOut: false });
const bad = (stdout: string, stderr = '', code = 1): RunResult<string> => ({ ok: false, code, signal: null, stdout, stderr, timedOut: false });
const MANIFEST_APK = fileURLToPath(new URL('./android-fixtures/manifest-only.apk', import.meta.url));

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

function overrideStore() {
  const map = new Map<string, DeviceSettingOverride>();
  const store: SettingOverrides = {
    get: (a, scope) => map.get(overrideKey(a, scope)),
    set: (o) => void map.set(overrideKey(o.action, { appId: o.appId, key: o.key }), o),
    delete: (a, scope) => void map.delete(overrideKey(a, scope)),
  };
  return { map, store };
}

describe('why an Android action is missing', () => {
  it('offline: nothing either way (the device state says why)', () => {
    expect(androidActionAvailability({ online: false, isEmulator: false })).toEqual({ actions: [], unavailable: [] });
  });

  it('an Android 9 phone over USB: version gates with the Android version that has them', () => {
    const { actions, unavailable } = androidActionAvailability({ online: true, isEmulator: false, apiLevel: 28, connection: 'usb' });
    expect(actions).toEqual(expect.arrayContaining(['app-permission', 'wifi', 'rotation', 'bug-report', 'mobile-data', 'dont-keep-activities', 'app-settings']));
    expect(unavailable).toEqual([
      { action: 'appearance', code: 'action.apiTooLow', params: { apiLevel: 28, minApi: 29, minVersion: '10' } },
      { action: 'location', code: 'action.emulatorOnly' },
      { action: 'app-locale', code: 'action.apiTooLow', params: { apiLevel: 28, minApi: 33, minVersion: '13' } },
      { action: 'airplane-mode', code: 'action.apiTooLow', params: { apiLevel: 28, minApi: 30, minVersion: '11' } },
    ]);
    for (const u of unavailable) expect(actions).not.toContain(u.action);
  });

  it('over Wi-Fi adb: switching Wi-Fi or airplane mode would cut the connection', () => {
    const { actions, unavailable } = androidActionAvailability({ online: true, isEmulator: false, apiLevel: 35, connection: 'wifi' });
    expect(actions).not.toContain('wifi');
    expect(actions).toContain('mobile-data');
    expect(unavailable).toEqual(
      expect.arrayContaining([
        { action: 'wifi', code: 'action.wouldDisconnect', params: { connection: 'wifi' } },
        { action: 'airplane-mode', code: 'action.wouldDisconnect', params: { connection: 'wifi' } },
      ]),
    );
  });

  it('an emulator has location; an unknown API level offers everything', () => {
    const emu = androidActionAvailability({ online: true, isEmulator: true });
    expect(emu.actions).toContain('location');
    expect(emu.unavailable).toEqual([]);
  });

  it('runAction refuses an unavailable action with its reason code', async () => {
    const { adb } = fakeAdb({});
    // The session checks availability; the target alone runs what it is asked (the emulator check stays).
    expect(await runAndroidAction(target(adb), 'location', { lat: 1, lon: 2 })).toMatchObject({ ok: false, code: 'action.unsupported' });
  });
});

describe('reproduction settings (put back with restore)', () => {
  function phone(initial: Record<string, string>) {
    const v = new Map(Object.entries(initial));
    const shell = (cmd: string): RunResult<string> => {
      const out: string[] = [];
      for (const part of cmd.split('; ')) {
        const w = part.trim().split(' ');
        if (w[0] === 'settings' && w[1] === 'get') out.push(v.get(w[3]!) ?? 'null');
        else if (w[0] === 'settings' && w[1] === 'put') v.set(w[3]!, w[4]!);
        else if (w[0] === 'settings' && w[1] === 'delete') v.delete(w[3]!);
        else if (part === 'cmd connectivity airplane-mode') out.push(v.get('airplane') === '1' ? 'enabled' : 'disabled');
        else if (w[0] === 'cmd' && w[1] === 'connectivity') v.set('airplane', w[3] === 'enable' ? '1' : '0');
        else if (w[0] === 'cmd' && w[1] === 'wifi') v.set('wifi_on', w[3] === 'enabled' ? '1' : '0');
        else if (w[0] === 'svc' && w[1] === 'data') v.set('mobile_data', w[2] === 'enable' ? '1' : '0');
      }
      return ok(out.length ? `${out.join('\n')}\n` : '');
    };
    return { v, shell };
  }

  it('airplane mode, Wi-Fi and mobile data keep the value from before and put it back', async () => {
    const p = phone({ wifi_on: '1', mobile_data: '1', airplane: '0' });
    const { adb, calls } = fakeAdb({ shell: p.shell });
    const { map, store } = overrideStore();
    const t = target(adb, { overrides: store });
    expect(await runAndroidAction(t, 'airplane-mode', { enabled: true })).toMatchObject({ ok: true, message: 'Airplane mode on' });
    expect(calls).toContain('shell cmd connectivity airplane-mode enable');
    expect(map.get('airplane-mode')).toMatchObject({ previous: 'off', current: 'on' });
    await runAndroidAction(t, 'wifi', { enabled: false });
    expect(p.v.get('wifi_on')).toBe('0');
    await runAndroidAction(t, 'mobile-data', { enabled: false });
    expect(calls).toContain('shell svc data disable');
    expect(await runAndroidAction(t, 'wifi', { restore: true })).toMatchObject({ ok: true, code: 'action.settingRestored' });
    expect(p.v.get('wifi_on')).toBe('1');
    await runAndroidAction(t, 'airplane-mode', { restore: true });
    expect(p.v.get('airplane')).toBe('0');
    expect([...map.keys()]).toEqual(['mobile-data']);
    expect(await runAndroidAction(t, 'wifi', {})).toMatchObject({ ok: false, code: 'action.invalidParams' });
  });

  it('Wi-Fi before Android 11 goes through svc', async () => {
    const { adb, calls } = fakeAdb({});
    await runAndroidAction(target(adb, { apiLevel: 28 }), 'wifi', { enabled: false });
    expect(calls).toEqual(['shell svc wifi disable']);
  });

  it('rotation: fixed and back to auto-rotate', async () => {
    const p = phone({ accelerometer_rotation: '1', user_rotation: '0' });
    const { adb } = fakeAdb({ shell: p.shell });
    const { map, store } = overrideStore();
    const t = target(adb, { overrides: store });
    expect(await runAndroidAction(t, 'rotation', { orientation: 'landscape' })).toMatchObject({ ok: true });
    expect([p.v.get('accelerometer_rotation'), p.v.get('user_rotation')]).toEqual(['0', '1']);
    expect(map.get('rotation')).toMatchObject({ previous: 'auto', current: 'landscape' });
    await runAndroidAction(t, 'rotation', { restore: true });
    expect(p.v.get('accelerometer_rotation')).toBe('1');
    expect(await runAndroidAction(t, 'rotation', { orientation: 'sideways; reboot' })).toMatchObject({ ok: false, code: 'action.invalidParams' });
  });

  it('"Don\'t keep activities": an unset key is deleted again on restore', async () => {
    const p = phone({});
    const { adb } = fakeAdb({ shell: p.shell });
    const { map, store } = overrideStore();
    const t = target(adb, { overrides: store });
    await runAndroidAction(t, 'dont-keep-activities', { enabled: true });
    expect(p.v.get('always_finish_activities')).toBe('1');
    expect(map.get('dont-keep-activities')).toMatchObject({ previous: 'default', current: '1' });
    await runAndroidAction(t, 'dont-keep-activities', { restore: true });
    expect(p.v.has('always_finish_activities')).toBe(false);
  });

  // `dumpsys package <pkg>` runtime permission lines (documented format of PackageManagerService's dump).
  const PERMISSIONS = [
    'Packages:',
    '  Package [com.mykynk.pati] (4f1c2a3):',
    '    userId=10190',
    '    User 0: ceDataInode=0 installed=true hidden=false',
    '      runtime permissions:',
    '        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]',
    '        android.permission.CAMERA: granted=false, flags=[ USER_SET|USER_FIXED ]',
    '    User 10: ceDataInode=0 installed=true hidden=false',
    '      runtime permissions:',
    '        android.permission.CAMERA: granted=true, flags=[ ]',
  ].join('\n');

  it('reads runtime permissions per user (documented dumpsys format)', () => {
    expect(parseRuntimePermission(PERMISSIONS, 'android.permission.CAMERA')).toBe('denied');
    expect(parseRuntimePermission(PERMISSIONS, 'android.permission.CAMERA', 10)).toBe('granted');
    expect(parseRuntimePermission(PERMISSIONS, 'android.permission.RECORD_AUDIO')).toBeUndefined();
  });

  it('grants and revokes a permission per app and puts the old state back', async () => {
    let camera = false;
    const { adb, calls } = fakeAdb({
      shell: (cmd) => {
        if (cmd.startsWith('dumpsys package')) return ok(PERMISSIONS.replace('CAMERA: granted=false', `CAMERA: granted=${camera}`));
        if (cmd.startsWith('pm grant')) camera = true;
        if (cmd.startsWith('pm revoke')) camera = false;
        return ok();
      },
    });
    const { map, store } = overrideStore();
    const t = target(adb, { overrides: store });
    const r = await runAndroidAction(t, 'app-permission', { appId: 'com.mykynk.pati', permission: 'android.permission.CAMERA', grant: true });
    expect(r).toMatchObject({ ok: true, message: 'CAMERA granted to com.mykynk.pati' });
    expect(calls).toContain("shell pm grant com.mykynk.pati android.permission.CAMERA");
    expect(map.get('app-permission|com.mykynk.pati|android.permission.CAMERA')).toMatchObject({
      action: 'app-permission',
      appId: 'com.mykynk.pati',
      key: 'android.permission.CAMERA',
      previous: 'denied',
      current: 'granted',
    });
    // Restore needs the same app and permission.
    expect(await runAndroidAction(t, 'app-permission', { restore: true, appId: 'com.mykynk.pati', permission: 'android.permission.CAMERA' })).toMatchObject({
      ok: true,
      code: 'action.settingRestored',
    });
    expect(camera).toBe(false);
    expect(map.size).toBe(0);
  });

  it('says why a permission cannot be changed and refuses unsafe input', async () => {
    const reply = (stderr: string) => fakeAdb({ shell: (cmd) => (cmd.startsWith('pm ') ? bad('', stderr, 255) : ok()) }).adb;
    const run = (adb: Adb, permission: string) => runAndroidAction(target(adb), 'app-permission', { appId: 'com.mykynk.pati', permission, grant: true });
    expect(await run(reply('Exception occurred while executing \'grant\':\njava.lang.IllegalArgumentException: Unknown permission: android.permission.FOO'), 'android.permission.FOO')).toMatchObject({
      code: 'action.permissionUnknown',
    });
    expect(
      await run(reply('java.lang.SecurityException: Package com.mykynk.pati has not requested permission android.permission.CAMERA'), 'android.permission.CAMERA'),
    ).toMatchObject({ code: 'action.permissionNotRequested' });
    expect(
      await run(reply('java.lang.SecurityException: Permission android.permission.INTERNET requested by com.mykynk.pati is not a changeable permission type'), 'android.permission.INTERNET'),
    ).toMatchObject({ code: 'action.permissionNotChangeable' });
    const { adb, calls } = fakeAdb({});
    expect(await run(adb, "android.permission.CAMERA'; reboot")).toMatchObject({ ok: false, code: 'action.invalidParams' });
    expect(calls).toEqual([]);
  });

  it('sets an app language (Android 13+) and follows the phone again on restore', async () => {
    let locales = '';
    const { adb, calls } = fakeAdb({
      shell: (cmd) => {
        if (cmd.startsWith('cmd locale get-app-locales')) return ok(`Locales for com.mykynk.pati for user 0 are [${locales}]\n`);
        if (cmd.startsWith('cmd locale set-app-locales')) locales = /--locales (\S+)/.exec(cmd)?.[1] ?? '';
        return ok();
      },
    });
    const { store } = overrideStore();
    const t = target(adb, { overrides: store });
    expect(await runAndroidAction(t, 'app-locale', { appId: 'com.mykynk.pati', locale: 'tr-TR' })).toMatchObject({ ok: true, message: 'com.mykynk.pati now uses tr-TR' });
    expect(calls).toContain("shell cmd locale set-app-locales com.mykynk.pati --locales tr-TR");
    await runAndroidAction(t, 'app-locale', { restore: true, appId: 'com.mykynk.pati' });
    expect(calls[calls.length - 1]).toBe("shell cmd locale set-app-locales com.mykynk.pati");
    expect(await runAndroidAction(t, 'app-locale', { appId: 'com.mykynk.pati', locale: 'tr;id' })).toMatchObject({ code: 'action.invalidParams' });
  });

  it('parses each setting strictly', () => {
    expect(parseAirplaneMode('enabled\n')).toBe('on');
    expect(parseAirplaneMode('Unknown command')).toBeUndefined();
    expect(['0', '1', '2', '3', 'null'].map(parseWifiOn)).toEqual(['off', 'on', 'on', 'off', undefined]);
    expect(parseRotation('0\n3\n')).toBe('reverse-landscape');
    expect(parseRotation('1\n0\n')).toBe('auto');
    expect(parseRotation('0\n7\n')).toBeUndefined();
    expect(parseAppLocales('Locales for com.x for user 0 are []')).toBe('system');
    expect(parseAppLocales('Locales for com.x for user 0 are [tr-TR,en-US]')).toBe('tr-TR,en-US');
    expect(parseAppLocales('Locales for com.x for user 0 are [$(id)]')).toBeUndefined();
  });

  it('opens the app settings page', async () => {
    const { adb, calls } = fakeAdb({ shell: () => ok('Starting: Intent { act=android.settings.APPLICATION_DETAILS_SETTINGS }\n') });
    expect(await runAndroidAction(target(adb), 'app-settings', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: true });
    expect(calls).toEqual(["shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:com.mykynk.pati"]);
  });
});

describe('users and work profiles', () => {
  // `pm list users` (documented format: UserInfo.toString() per user, " running" when started).
  const USERS = 'Users:\n\tUserInfo{0:Owner:c13} running\n\tUserInfo{10:Work profile:1030} running\n\tUserInfo{150:Secure Folder:10001030}\n';

  it('reads users with their kind (documented pm list users format)', () => {
    expect(parseUserList(USERS, parseCurrentUser('0\n'))).toEqual([
      { id: 0, name: 'Owner', kind: 'main', running: true, current: true },
      { id: 10, name: 'Work profile', kind: 'work', running: true },
      { id: 150, name: 'Secure Folder', kind: 'work' },
    ]);
    expect(parseUserList('Users:\n\tUserInfo{11:Second space:410}\n')).toEqual([{ id: 11, name: 'Second space', kind: 'secondary' }]);
    expect(parseCurrentUser('Error: java.lang.SecurityException')).toBeUndefined();
  });

  it('checks userId against the phone users', () => {
    const users = parseUserList(USERS);
    expect(userParam({}, users)).toBeUndefined();
    expect(userParam({ userId: 10 }, users)).toBe(10);
    expect(userParam({ userId: '10' }, users)).toBe(10);
    expect(userParam({ userId: 11 }, users)).toBe('invalid');
    expect(userParam({ userId: '10; reboot' }, users)).toBe('invalid');
  });

  it('passes --user to app commands and launches through resolve-activity', async () => {
    const users = parseUserList(USERS);
    const { adb, calls } = fakeAdb({
      shell: (cmd) => {
        if (cmd.startsWith('cmd package resolve-activity')) return ok('priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\ncom.mykynk.pati/.MainActivity\n');
        if (cmd.startsWith('am start')) return ok('Starting: Intent { cmp=com.mykynk.pati/.MainActivity }\n');
        if (cmd.startsWith('pm clear')) return ok('Success\n');
        if (cmd.startsWith('pm list packages')) return ok('package:com.mykynk.pati\n');
        return ok();
      },
    });
    const t = target(adb, { users });
    await runAndroidAction(t, 'app-stop', { appId: 'com.mykynk.pati', userId: 10 });
    await runAndroidAction(t, 'app-clear-data', { appId: 'com.mykynk.pati', userId: 10 });
    await runAndroidAction(t, 'list-apps', { userId: 10 });
    expect(await runAndroidAction(t, 'app-launch', { appId: 'com.mykynk.pati', userId: 10 })).toMatchObject({ ok: true });
    await runAndroidAction(t, 'app-uninstall', { appId: 'com.mykynk.pati', userId: 10 });
    expect(calls).toEqual(
      expect.arrayContaining([
        "shell am force-stop --user 10 com.mykynk.pati",
        "shell pm clear --user 10 com.mykynk.pati",
        'shell pm list packages -3 --user 10',
        "shell cmd package resolve-activity --brief --user 10 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.mykynk.pati",
        "shell am start --user 10 -n com.mykynk.pati/.MainActivity",
        'uninstall --user 10 com.mykynk.pati',
      ]),
    );
    expect(await runAndroidAction(t, 'app-stop', { appId: 'com.mykynk.pati', userId: 12 })).toMatchObject({ ok: false, code: 'action.invalidParams' });
    expect(parseResolvedComponent('No activity found\n', 'com.mykynk.pati')).toBeUndefined();
    expect(parseResolvedComponent('com.other/.Main\n', 'com.mykynk.pati')).toBeUndefined();
  });
});

describe('install refusals and "uninstall and install"', () => {
  it('reads the package name of an APK from its binary manifest (no tool on the Mac)', async () => {
    expect(await apkPackageId(MANIFEST_APK)).toBe('dev.durbun.durbun_example');
    const xml = await readZipEntry(MANIFEST_APK, 'AndroidManifest.xml');
    expect(manifestPackage(xml!)).toBe('dev.durbun.durbun_example');
    expect(manifestPackage(Buffer.from('not a manifest'))).toBeUndefined();
    const notZip = path.join(os.tmpdir(), `durbun-notzip-${process.pid}.apk`);
    fs.writeFileSync(notZip, 'plain text');
    expect(await apkPackageId(notZip)).toBeUndefined();
    fs.rmSync(notZip, { force: true });
  });

  it('names the package in the refusal over the installed copy', async () => {
    const { adb } = fakeAdb({
      run: () => bad('Performing Streamed Install\nadb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package dev.durbun.durbun_example signatures do not match newer version; ignoring!]\n'),
    });
    const r = await runAndroidAction(target(adb), 'app-install', { file: MANIFEST_APK });
    expect(r).toMatchObject({ ok: false, code: 'action.install.signatureMismatch', data: { packageId: 'dev.durbun.durbun_example', replaceable: true } });
    expect(packageFromRefusal('INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.x.y signatures do not match the previously installed version; ignoring!')).toBe('com.x.y');
  });

  it('a downgrade refusal also offers it; other refusals do not', async () => {
    const { adb } = fakeAdb({ run: () => bad('Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 3 is older than current 7]\n') });
    expect(await runAndroidAction(target(adb), 'app-install', { file: MANIFEST_APK })).toMatchObject({
      code: 'action.install.downgrade',
      data: { packageId: 'dev.durbun.durbun_example', replaceable: true },
    });
    const noSpace = fakeAdb({ run: () => bad('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n') });
    const r = await runAndroidAction(target(noSpace.adb), 'app-install', { file: MANIFEST_APK });
    expect(r.code).toBe('action.install.noSpace');
    expect(r.data).toBeUndefined();
  });

  it('replace: uninstalls the installed copy, then installs', async () => {
    const { adb, calls } = fakeAdb({ shell: (cmd) => (cmd.startsWith('pm path') ? ok('package:/data/app/~~x/base.apk\n') : ok()) });
    const r = await runAndroidAction(target(adb), 'app-install', { file: MANIFEST_APK, replace: true });
    expect(r).toMatchObject({ ok: true, code: 'action.install.replaced', data: { packageId: 'dev.durbun.durbun_example' } });
    expect(calls).toEqual(["shell pm path dev.durbun.durbun_example", 'uninstall dev.durbun.durbun_example', `install -r -t -d ${MANIFEST_APK}`]);
  });

  it('replace: not installed → just installs; each failure has its own code', async () => {
    const notThere = fakeAdb({ shell: () => bad('') });
    expect(await runAndroidAction(target(notThere.adb), 'app-install', { file: MANIFEST_APK, replace: true })).toMatchObject({ ok: true, code: 'action.done' });
    expect(notThere.calls.some((c) => c.startsWith('uninstall'))).toBe(false);

    const stuck = fakeAdb({
      shell: () => ok('package:/data/app/base.apk\n'),
      run: (args) => (args[2] === 'uninstall' ? bad('Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]\n') : ok('Success\n')),
    });
    expect(await runAndroidAction(target(stuck.adb), 'app-install', { file: MANIFEST_APK, replace: true })).toMatchObject({
      ok: false,
      code: 'action.install.replaceUninstallFailed',
      data: { packageId: 'dev.durbun.durbun_example' },
    });
    expect(stuck.calls.some((c) => c.startsWith('install'))).toBe(false);

    const lost = fakeAdb({
      shell: () => ok('package:/data/app/base.apk\n'),
      run: (args) => (args[2] === 'uninstall' ? ok('Success\n') : bad('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n')),
    });
    expect(await runAndroidAction(target(lost.adb), 'app-install', { file: MANIFEST_APK, replace: true })).toMatchObject({
      ok: false,
      code: 'action.install.replaceInstallFailed',
      data: { packageId: 'dev.durbun.durbun_example', code: 'action.install.noSpace' },
    });
  });

  it('replace: a file whose package cannot be read is refused before anything runs', async () => {
    const file = path.join(os.tmpdir(), `durbun-broken-${process.pid}.apk`);
    fs.writeFileSync(file, 'not a zip');
    const { adb, calls } = fakeAdb({});
    expect(await runAndroidAction(target(adb), 'app-install', { file, replace: true })).toMatchObject({ ok: false, code: 'action.install.packageUnknown' });
    expect(calls).toEqual([]);
    fs.rmSync(file, { force: true });
  });
});

describe('full device report (adb bugreport)', () => {
  function fakeChild() {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null as number | null, signalCode: null, pid: 4242, kill: () => true });
    const exit = (code: number) => {
      child.exitCode = code;
      child.emit('exit', code);
    };
    child.kill = () => {
      setImmediate(() => exit(143));
      return true;
    };
    return { child: child as unknown as ChildProcess, stdout, exit };
  }

  it('reports progress, saves the zip and replies with its file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-bugreport-'));
    const states: unknown[] = [];
    const f = fakeChild();
    let file = '';
    const reporter = new BugReporter({
      ctx: { tempDir: dir, fileUrl: (n) => `/api/files/${n}` },
      label: 'Galaxy A73',
      spawn: (to) => {
        file = to;
        return f.child;
      },
      onState: (s) => states.push(s),
    });
    const done = reporter.collect();
    await waitFor(() => reporter.busy);
    expect(await reporter.collect()).toMatchObject({ ok: false, code: 'action.bugReport.busy' });
    f.stdout.write('[  4%] generating bugreport-a73xq-2026-11-16-10-02-11.zip\r[ 57%] generating bugreport-a73xq-2026-11-16-10-02-11.zip');
    await new Promise((r) => setImmediate(r));
    fs.writeFileSync(file, Buffer.alloc(2048));
    f.exit(0);
    const r = await done;
    expect(r).toMatchObject({ ok: true, code: 'action.bugReport.saved', data: { file, bytes: 2048 } });
    expect((r.data as { url: string }).url).toMatch(/^\/api\/files\/bugreport-Galaxy-A73-.*\.zip$/);
    expect(states[0]).toMatchObject({ startedAt: expect.any(Number) });
    expect(states).toContainEqual(expect.objectContaining({ progress: 57 }));
    expect(states[states.length - 1]).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cancel ends adb and removes the partial file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-bugreport-'));
    const f = fakeChild();
    let file = '';
    const reporter = new BugReporter({
      ctx: { tempDir: dir, fileUrl: (n) => n },
      label: 'Pixel 8',
      spawn: (to) => {
        file = to;
        fs.writeFileSync(to, 'partial');
        return f.child;
      },
      onState: () => undefined,
    });
    expect(await reporter.cancel()).toMatchObject({ ok: false, code: 'action.bugReport.notRunning' });
    const running = reporter.collect();
    await waitFor(() => reporter.busy);
    expect(await reporter.cancel()).toMatchObject({ ok: true, code: 'action.bugReport.cancelled' });
    expect(await running).toMatchObject({ ok: false, code: 'action.bugReport.cancelled' });
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed report says what adb printed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-bugreport-'));
    const f = fakeChild();
    const reporter = new BugReporter({ ctx: { tempDir: dir, fileUrl: (n) => n }, label: 'Pixel 8', spawn: () => f.child, onState: () => undefined });
    const running = reporter.collect();
    await waitFor(() => reporter.busy);
    f.stdout.write('[  2%] generating bugreport.zip\rFailed to get bugreportz version: \'bugreportz -v\' returned \'\' (code 0)\n');
    await new Promise((r) => setImmediate(r));
    f.exit(1);
    const r = await running;
    expect(r).toMatchObject({ ok: false, code: 'action.bugReport.failed' });
    expect(r.message).toContain('Failed to get bugreportz version');
    expect(parseBugReportProgress('[100%] done')).toBe(100);
    expect(parseBugReportProgress('no progress')).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is an Android action that needs the session runner', async () => {
    const { adb } = fakeAdb({});
    expect(await runAndroidAction(target(adb), 'bug-report' as DeviceActionId, {})).toMatchObject({ ok: false, code: 'action.unsupported' });
  });
});
