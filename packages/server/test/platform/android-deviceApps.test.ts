import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adb } from '../../src/platform/android/adb';
import { deviceLocalToEpoch, parseTzName, parseUtcOffset, type DeviceClock } from '../../src/platform/android/deviceClock';
import {
  basePackage,
  buildTypeOf,
  DEVICE_APP_TIMING,
  DeviceAppTracker,
  installSourceOf,
  packageInfoCommand,
  packageListCommand,
  parseDumpsysPackage,
  parseLauncherLabel,
  parsePackageLists,
  PKG_DUMP_SEP,
  PKG_LABEL_SEP,
  splitPackageDumps,
} from '../../src/platform/android/deviceApps';
import type { RunResult } from '../../src/platform/exec';
import { silentLogger } from '../../src/util/logger';
import { createFakeHub, waitFor } from './helpers';

const fx = (name: string): string => fs.readFileSync(new URL(`./android-fixtures/${name}`, import.meta.url), 'utf8');
const IST: DeviceClock = { tzName: 'Europe/Istanbul', offsetMinutes: 180 };

describe('device clock', () => {
  it('parses offsets and zone names', () => {
    expect(parseUtcOffset('+0300')).toBe(180);
    expect(parseUtcOffset('-0430\n')).toBe(-270);
    expect(parseUtcOffset('+05:45')).toBe(345);
    expect(parseUtcOffset('Europe/Istanbul')).toBeUndefined();
    expect(parseTzName('Europe/Istanbul')).toBe('Europe/Istanbul');
    expect(parseTzName('Not/AZone')).toBeUndefined();
    expect(parseTzName('')).toBeUndefined();
  });

  it('converts device-local "yyyy-MM-dd HH:mm:ss" with the device zone (DST aware)', () => {
    expect(deviceLocalToEpoch('2026-11-02 11:43:03', IST)).toBe(Date.UTC(2026, 10, 2, 8, 43, 3));
    // Berlin: summer (+2) vs winter (+1) from the zone name, regardless of the current offset.
    const berlin: DeviceClock = { tzName: 'Europe/Berlin', offsetMinutes: 60 };
    expect(deviceLocalToEpoch('2026-07-01 12:00:00', berlin)).toBe(Date.UTC(2026, 6, 1, 10, 0, 0));
    expect(deviceLocalToEpoch('2026-12-01 12:00:00', berlin)).toBe(Date.UTC(2026, 11, 1, 11, 0, 0));
    // Offset only (unknown zone name).
    expect(deviceLocalToEpoch('2026-11-02 11:43:03', { offsetMinutes: -300 })).toBe(Date.UTC(2026, 10, 2, 16, 43, 3));
    expect(deviceLocalToEpoch('1970-01-01 03:00:00', IST)).toBeUndefined();
    expect(deviceLocalToEpoch('garbage', IST)).toBeUndefined();
  });
});

describe('dumpsys package parsing', () => {
  it('API 34, Play Store, release: version, build, installer, per-user firstInstallTime', () => {
    const d = parseDumpsysPackage(fx('dumpsys-package-api34-play.txt'), 'com.mykynk.mahalle')!;
    expect(d).toEqual({
      id: 'com.mykynk.mahalle',
      versionCode: '3104',
      versionName: '3.1.0',
      debuggable: false,
      installer: 'com.android.vending',
      initiator: 'com.android.vending',
      firstInstallTime: '2026-09-14 10:02:31',
      lastUpdateTime: '2026-10-28 21:14:55',
    });
    expect(installSourceOf(d)).toEqual({ source: 'play', installer: 'com.android.vending' });
    expect(buildTypeOf(d.debuggable)).toBe('release');
  });

  it('API 34, flutter run / adb install, debuggable: no installer line → adb', () => {
    const d = parseDumpsysPackage(fx('dumpsys-package-api34-debug-adb.txt'), 'com.mykynk.pati')!;
    expect(d).toMatchObject({ versionName: '1.4.0-dev', versionCode: '1', debuggable: true, firstInstallTime: '2026-10-20 09:30:12' });
    expect(d.installer).toBeUndefined();
    expect(installSourceOf(d)).toEqual({ source: 'adb' });
    expect(buildTypeOf(d.debuggable)).toBe('debug');
  });

  it('API 30 (Android 11) layout, Firebase App Distribution, package-level firstInstallTime', () => {
    const d = parseDumpsysPackage(fx('dumpsys-package-api30-firebase.txt'), 'com.mykynk.pati')!;
    expect(d).toEqual({
      id: 'com.mykynk.pati',
      versionCode: '41',
      versionName: '1.3.2',
      debuggable: false,
      installer: 'dev.firebase.appdistribution',
      firstInstallTime: '2026-08-03 13:05:44',
      lastUpdateTime: '2026-10-29 16:47:21',
    });
    expect(installSourceOf(d)).toEqual({ source: 'firebase', installer: 'dev.firebase.appdistribution' });
  });

  it('other stores keep the raw installer; the first user wins', () => {
    const d = parseDumpsysPackage(fx('dumpsys-package-api33-galaxy.txt'), 'com.example.native')!;
    expect(d).toMatchObject({ versionName: '2.0.26', versionCode: '20026', firstInstallTime: '2026-05-30 19:44:02' });
    expect(installSourceOf(d)).toEqual({ source: 'other-store', installer: 'com.sec.android.app.samsungapps' });
  });

  it('tolerates InstallSource{…} / installInitiatingPackageName variants, null values and shell installs', () => {
    const text = [
      'Packages:',
      '  Package [com.acme.app] (1a2b3c):',
      '    versionCode=7 targetSdk=29',
      '    versionName=null',
      '    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]',
      '    installSource=InstallSource{installerPackageName=null, installInitiatingPackageName=com.android.shell, isOrphaned=false}',
      '    lastUpdateTime=2026-11-01 08:00:00',
    ].join('\n');
    const d = parseDumpsysPackage(text, 'com.acme.app')!;
    expect(d).toEqual({ id: 'com.acme.app', versionCode: '7', debuggable: false, initiator: 'com.android.shell', lastUpdateTime: '2026-11-01 08:00:00' });
    expect(installSourceOf(d)).toEqual({ source: 'adb', installer: 'com.android.shell' });
    // Capitalized key (SPEC §10.2 "InstallerPackageName").
    const capital = parseDumpsysPackage(text.replace(/installSource=.*/, 'InstallerPackageName=com.android.vending'), 'com.acme.app')!;
    expect(installSourceOf(capital)).toEqual({ source: 'play', installer: 'com.android.vending' });
    expect(installSourceOf({ installer: 'com.google.android.packageinstaller' })).toEqual({
      source: 'other-store',
      installer: 'com.google.android.packageinstaller',
    });
  });

  it('returns undefined for packages that are not installed and splits batched dumps', () => {
    expect(parseDumpsysPackage('Unable to find package: com.gone.app\n', 'com.gone.app')).toBeUndefined();
    // Another package's block (prefix of the name) must not match.
    expect(parseDumpsysPackage(fx('dumpsys-package-api34-debug-adb.txt'), 'com.mykynk.pat')).toBeUndefined();
    const batch = [fx('dumpsys-package-api34-debug-adb.txt'), 'Unable to find package: com.gone.app', fx('dumpsys-package-api34-play.txt')].join(
      `\n${PKG_DUMP_SEP}\n`,
    );
    const m = splitPackageDumps(batch, ['com.mykynk.pati', 'com.gone.app', 'com.mykynk.mahalle']);
    expect(m.get('com.mykynk.pati')?.versionName).toBe('1.4.0-dev');
    expect(m.get('com.gone.app')).toBeUndefined();
    expect(m.get('com.mykynk.mahalle')?.installer).toBe('com.android.vending');
  });

  it('reads a literal launcher label (DeviceApp.name); resource labels and other packages give none', () => {
    const full = fx('resolve-activity-api34.txt');
    expect(parseLauncherLabel(full, 'com.mykynk.pati')).toBe('Pati QA');
    // The activity's own label wins over the application's (the launcher shows it).
    const own = full.replace(
      '  enabled=true exported=true',
      '  labelRes=0x0 nonLocalizedLabel=Pati Dev icon=0x0 banner=0x0\n  enabled=true exported=true',
    );
    expect(parseLauncherLabel(own, 'com.mykynk.pati')).toBe('Pati Dev');
    // android:label="@string/app_name": only a resource id (no aapt on the device to resolve it).
    expect(parseLauncherLabel(full.replace('nonLocalizedLabel=Pati QA', 'nonLocalizedLabel=null').replace('labelRes=0x0', 'labelRes=0x7f120001'), 'com.mykynk.pati')).toBeUndefined();
    // Two launcher activities → the system chooser resolves; its label is not the app's.
    const chooser = 'ActivityInfo:\n  name=com.android.internal.app.ResolverActivity\n  packageName=android\n  labelRes=0x0 nonLocalizedLabel=Android System icon=0x0 banner=0x0\n';
    expect(parseLauncherLabel(chooser, 'com.mykynk.pati')).toBeUndefined();
    expect(parseLauncherLabel('No activity found\n', 'com.mykynk.pati')).toBeUndefined();
    // Batched with dumpsys package: "<dump>\nLABEL_SEP\n<grep output>".
    const batch = [`${fx('dumpsys-package-api34-debug-adb.txt')}${PKG_LABEL_SEP}\n${full}`, `Unable to find package: com.gone.app\n${PKG_LABEL_SEP}\n`].join(`${PKG_DUMP_SEP}\n`);
    const m = splitPackageDumps(batch, ['com.mykynk.pati', 'com.gone.app']);
    expect(m.get('com.mykynk.pati')).toMatchObject({ label: 'Pati QA', versionName: '1.4.0-dev' });
    expect(m.get('com.gone.app')).toBeUndefined();
    expect(packageInfoCommand('com.foo')).toBe(
      `dumpsys package com.foo; echo ${PKG_LABEL_SEP}; cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.foo 2>/dev/null | grep -E 'packageName=|nonLocalizedLabel='`,
    );
  });

  it('parses pm list packages -3 / -s with the device clock', () => {
    const lists = parsePackageLists(fx('pm-lists.txt'))!;
    expect([...lists.thirdParty]).toEqual([
      'com.mykynk.pati',
      'com.mykynk.mahalle',
      'com.example.native',
      'com.whatsapp',
      'dev.firebase.appdistribution',
    ]);
    expect(lists.system.has('com.google.android.gms')).toBe(true);
    expect(lists.clock).toEqual({ offsetMinutes: 180, tzName: 'Europe/Istanbul' });
    expect(parsePackageLists('')).toBeUndefined();
    expect(parsePackageLists('+0000\n\n___DURBUN_PKGS___\ncmd: Can\'t find service: package\n___DURBUN_PKGS___\n')).toBeUndefined();
    // A device without third-party apps is still a valid answer.
    expect(parsePackageLists('+0000\n___DURBUN_PKGS___\n___DURBUN_PKGS___\npackage:android\n')?.thirdParty.size).toBe(0);
  });

  it('maps process names to packages', () => {
    expect(basePackage('com.mykynk.pati')).toBe('com.mykynk.pati');
    expect(basePackage('com.mykynk.pati:remote')).toBe('com.mykynk.pati');
    expect(basePackage('/system/bin/surfaceflinger')).toBeUndefined();
    expect(basePackage('system_server')).toBeUndefined();
    expect(basePackage('com.foo; reboot')).toBeUndefined();
  });
});

/* ───────────── tracker ───────────── */

function ok(stdout: string): RunResult<string> {
  return { ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false };
}

const DUMPS: Record<string, string> = {
  'com.mykynk.pati': 'dumpsys-package-api34-debug-adb.txt',
  'com.mykynk.mahalle': 'dumpsys-package-api34-play.txt',
  'com.example.native': 'dumpsys-package-api33-galaxy.txt',
};

/** `cmd package resolve-activity … | grep -E 'packageName=|nonLocalizedLabel='` as the device returns it. */
const grepLabels = (text: string) => `${text.split('\n').filter((l) => /packageName=|nonLocalizedLabel=/.test(l)).join('\n')}\n`;

function fakeDevice() {
  const state = {
    lists: fx('pm-lists.txt'),
    dumps: { ...DUMPS } as Record<string, string>,
    labels: { 'com.mykynk.pati': fx('resolve-activity-api34.txt') } as Record<string, string>,
    failLists: false,
  };
  const calls: string[] = [];
  const adb = {
    path: '/fake/adb',
    tool: { path: '/fake/adb', source: 'path' },
    async shell(_serial: string, cmd: string) {
      calls.push(cmd);
      if (cmd === packageListCommand()) return ok(state.failLists ? '' : state.lists);
      if (cmd.startsWith('dumpsys package ')) {
        const outs = cmd.split(`; echo ${PKG_DUMP_SEP}; `).map((part) => {
          const pkg = /^dumpsys package (\S+?);/.exec(part)![1]!;
          expect(part).toBe(packageInfoCommand(pkg));
          const file = state.dumps[pkg];
          const dump = file ? fx(file) : `Unable to find package: ${pkg}\n`;
          return `${dump}${PKG_LABEL_SEP}\n${state.labels[pkg] ? grepLabels(state.labels[pkg]!) : ''}`;
        });
        return ok(outs.join(`${PKG_DUMP_SEP}\n`));
      }
      return ok('');
    },
  } as unknown as Adb;
  return { adb, calls, state };
}

describe('DeviceAppTracker', () => {
  const saved = { ...DEVICE_APP_TIMING };
  beforeEach(() => {
    DEVICE_APP_TIMING.infoBatchDelayMs = 5;
    DEVICE_APP_TIMING.unknownRefreshMinMs = 30;
  });
  afterEach(() => Object.assign(DEVICE_APP_TIMING, saved));

  function setup(procs: Array<[number, string]>) {
    const dev = fakeDevice();
    const hub = createFakeHub();
    const processes = new Map<number, string>(procs);
    const clock: DeviceClock = {};
    const tracker = new DeviceAppTracker({
      adb: () => dev.adb,
      serial: 'R58M123ABC',
      deviceId: 'android:R58M123ABC',
      hub,
      logger: silentLogger,
      processes: () => processes,
      clock,
    });
    return { ...dev, hub, processes, clock, tracker };
  }

  const KEY = (id: string) => `android:R58M123ABC|${id}`;

  it('publishes running third-party apps with dumpsys package details (one batched call)', async () => {
    const t = setup([
      [1, 'init'],
      [612, 'system_server'],
      [900, 'com.google.android.gms'],
      [901, 'com.google.android.gms.persistent'],
      [1200, 'media.swcodec'],
      [4321, 'com.mykynk.pati'],
      [4400, 'com.mykynk.pati:remote'],
      [5100, 'com.mykynk.mahalle'],
    ]);
    await t.tracker.start();
    expect(t.clock).toEqual({ tzName: 'Europe/Istanbul', offsetMinutes: 180 });
    await waitFor(() => t.hub.deviceApps.size === 2);
    const pati = t.hub.deviceApps.get(KEY('com.mykynk.pati'))!;
    expect(pati).toMatchObject({
      deviceId: 'android:R58M123ABC',
      id: 'com.mykynk.pati',
      version: '1.4.0-dev',
      build: '1',
      buildType: 'debug',
      install: {
        source: 'adb',
        firstInstall: Date.UTC(2026, 9, 20, 6, 30, 12),
        lastUpdate: Date.UTC(2026, 10, 2, 8, 41, 9),
      },
      pids: [4321, 4400],
      running: true,
      name: 'Pati QA',
    });
    expect(pati.processName).toBeUndefined();
    expect(t.hub.deviceApps.get(KEY('com.mykynk.mahalle'))).toMatchObject({
      buildType: 'release',
      install: { source: 'play', installer: 'com.android.vending' },
      version: '3.1.0',
      build: '3104',
      pids: [5100],
    });
    const dumps = t.calls.filter((c) => c.startsWith('dumpsys package'));
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toContain('dumpsys package com.mykynk.pati');
    expect(dumps[0]).toContain('dumpsys package com.mykynk.mahalle');
    // No upsert before the details were known (no "unknown" flicker), one per app.
    expect(t.hub.deviceAppUpserts).toHaveLength(2);
    // gms (+ its ".persistent" process) is a system package and "media.swcodec" was already running when
    // the lists were read (so it is not a package): no extra list refresh.
    await new Promise((r) => setTimeout(r, 80));
    expect(t.calls.filter((c) => c === packageListCommand())).toHaveLength(1);
    t.tracker.dispose();
  });

  it('follows Start proc / process death and re-reads dumpsys package after a reinstall', async () => {
    const t = setup([[4321, 'com.mykynk.pati']]);
    await t.tracker.start();
    await waitFor(() => t.hub.deviceApps.get(KEY('com.mykynk.pati')));
    t.processes.delete(4321);
    t.tracker.onProcessEvent({ pid: 4321, name: 'com.mykynk.pati', event: 'died' });
    expect(t.hub.deviceApps.get(KEY('com.mykynk.pati'))).toMatchObject({ pids: [], running: false });
    // Reinstalled (Firebase build) and started again.
    DEVICE_APP_TIMING.infoRefreshMinMs = 0;
    t.state.dumps['com.mykynk.pati'] = 'dumpsys-package-api30-firebase.txt';
    await new Promise((r) => setTimeout(r, 5));
    t.processes.set(9001, 'com.mykynk.pati');
    t.tracker.onProcessEvent({ pid: 9001, name: 'com.mykynk.pati', event: 'started' });
    expect(t.hub.deviceApps.get(KEY('com.mykynk.pati'))).toMatchObject({ pids: [9001], running: true });
    await waitFor(() => t.hub.deviceApps.get(KEY('com.mykynk.pati'))?.install.source === 'firebase');
    expect(t.hub.deviceApps.get(KEY('com.mykynk.pati'))).toMatchObject({ buildType: 'release', version: '1.3.2', build: '41' });
    t.tracker.dispose();
  });

  it('only a ":service" process running → processName says which', async () => {
    const t = setup([[4400, 'com.mykynk.pati:remote']]);
    await t.tracker.start();
    await waitFor(() => t.hub.deviceApps.get(KEY('com.mykynk.pati')));
    expect(t.hub.deviceApps.get(KEY('com.mykynk.pati'))).toMatchObject({ pids: [4400], processName: 'com.mykynk.pati:remote' });
    t.tracker.dispose();
  });

  it('re-lists packages when an unknown package starts (new install), once', async () => {
    const t = setup([]);
    await t.tracker.start();
    t.state.lists = t.state.lists.replace('package:com.whatsapp', 'package:com.whatsapp\npackage:com.new.install');
    t.processes.set(7777, 'com.new.install');
    t.tracker.onProcessEvent({ pid: 7777, name: 'com.new.install', event: 'started' });
    t.processes.set(7778, 'com.vendor.daemon.thing');
    t.tracker.onProcessEvent({ pid: 7778, name: 'com.vendor.daemon.thing', event: 'started' });
    await waitFor(() => t.hub.deviceApps.get(KEY('com.new.install')));
    expect(t.hub.deviceApps.get(KEY('com.new.install'))).toMatchObject({ pids: [7777], running: true, buildType: 'unknown' });
    const lists = () => t.calls.filter((c) => c === packageListCommand()).length;
    expect(lists()).toBe(2);
    // The non-package process was checked once and is not re-listed again.
    t.tracker.onProcessEvent({ pid: 7779, name: 'com.vendor.daemon.thing', event: 'started' });
    await new Promise((r) => setTimeout(r, 80));
    expect(lists()).toBe(2);
    t.tracker.dispose();
  });

  it('crash-only apps become DeviceApps (running false) with the crash count; uninstalled ones do not', async () => {
    const t = setup([]);
    await t.tracker.start();
    const reportTs = Date.UTC(2026, 10, 2, 8, 43, 10);
    t.tracker.noteCrash('com.example.native', { reportTs, version: '2.0.26', build: '20026', debuggable: false });
    t.tracker.noteCrash('com.gone.app', { reportTs });
    await waitFor(() => t.hub.deviceApps.get(KEY('com.example.native')));
    expect(t.hub.deviceApps.get(KEY('com.example.native'))).toMatchObject({
      running: false,
      pids: [],
      crashReports: 1,
      lastActivity: reportTs,
      install: { source: 'other-store', installer: 'com.sec.android.app.samsungapps' },
    });
    t.tracker.noteCrash('com.example.native', { reportTs: reportTs + 5000 });
    expect(t.hub.deviceApps.get(KEY('com.example.native'))?.crashReports).toBe(2);
    expect(t.hub.deviceApps.has(KEY('com.gone.app'))).toBe(false);
    t.tracker.dispose();
  });

  it('drops uninstalled apps on the periodic refresh; stop() marks apps not running; dispose() keeps them', async () => {
    DEVICE_APP_TIMING.listRefreshMs = 40;
    const t = setup([
      [4321, 'com.mykynk.pati'],
      [5100, 'com.mykynk.mahalle'],
    ]);
    await t.tracker.start();
    await waitFor(() => t.hub.deviceApps.size === 2);
    t.state.lists = t.state.lists.replace('package:com.mykynk.mahalle\n', '');
    t.processes.delete(5100);
    await waitFor(() => t.hub.removedDeviceApps.length > 0, 2000);
    expect(t.hub.removedDeviceApps[0]).toEqual({ deviceId: 'android:R58M123ABC', ids: ['com.mykynk.mahalle'] });
    t.tracker.stop();
    expect(t.hub.deviceApps.get(KEY('com.mykynk.pati'))).toMatchObject({ running: false, pids: [] });
    // Unplug: the hub keeps the app (scoping a disconnected device's logs) and owns its removal.
    t.tracker.dispose();
    expect(t.hub.removedDeviceApps).toHaveLength(1);
    expect([...t.hub.deviceApps.keys()]).toEqual([KEY('com.mykynk.pati')]);
    expect(t.tracker.trackedIds).toEqual([]);
  });

  it('dispose() of a running device marks its apps not running instead of removing them', async () => {
    const t = setup([[4321, 'com.mykynk.pati']]);
    await t.tracker.start();
    await waitFor(() => t.hub.deviceApps.get(KEY('com.mykynk.pati'))?.running);
    t.tracker.dispose();
    expect(t.hub.removedDeviceApps).toEqual([]);
    expect(t.hub.deviceApps.get(KEY('com.mykynk.pati'))).toMatchObject({ running: false, pids: [] });
    const upserts = t.hub.deviceAppUpserts.length;
    t.tracker.onProcessEvent({ pid: 4400, name: 'com.mykynk.pati', event: 'started' });
    expect(t.hub.deviceAppUpserts).toHaveLength(upserts);
  });

  it('degrades quietly when pm cannot list packages', async () => {
    const t = setup([[4321, 'com.mykynk.pati']]);
    t.state.failLists = true;
    await t.tracker.start();
    expect(await t.tracker.ready()).toBe(false);
    expect(t.tracker.isThirdParty('com.mykynk.pati')).toBeUndefined();
    t.tracker.onProcessEvent({ pid: 4321, name: 'com.mykynk.pati', event: 'started' });
    expect(t.hub.deviceAppUpserts).toHaveLength(0);
    t.tracker.dispose();
  });
});
