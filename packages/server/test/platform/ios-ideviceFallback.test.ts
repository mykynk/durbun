/**
 * iPhones devicectl cannot read (no Xcode 15+, iOS before 17, Developer Mode off): installed apps through
 * ideviceinstaller and crash reports through idevicecrashreport. The tools are fakes; the app plist follows
 * installation_proxy's Browse attributes (as `ideviceinstaller -o xml` prints them) and the crash files are
 * the real-format .ips fixtures, laid out like the device's crash folder (Retired/, ProxiedDevice-…/).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/platform/exec';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import { crashCopyDir, DeviceCrashWatcher, fallbackCrashSource, type CrashSource } from '../../src/platform/ios/deviceCrashes';
import {
  crashMirrorDir,
  fallbackAppSource,
  ideviceCrashSource,
  ideviceinstallerAppSource,
  listCrashMirror,
  parseInstallerApps,
  type IdeviceFallbackTool,
} from '../../src/platform/ios/ideviceFallback';
import type { IpsReport, JetsamReport } from '../../src/platform/ios/crashReport';
import type { AppSource } from '../../src/platform/ios/appTracker';
import { silentLogger } from '../../src/util/logger';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { createCtx, fixture, waitFor, type FakeCtx } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const ID = `ios:${UDID}`;

const done = (stdout = ''): RunResult => ({ ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false });
const failed = (stderr: string): RunResult => ({ ok: false, code: 255, signal: null, stdout: '', stderr, timedOut: false });

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-idevice-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** "Runner-2026-11-15-104233.ips" for a time `agoMs` back (crash file names carry local time). */
function stamped(prefix: string, agoMs: number): string {
  const t = new Date(Date.now() - agoMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.ips`;
}

/** The device's crash folder as idevicecrashreport -k copies it. */
function crashFolder() {
  const runner = stamped('Runner', 3600_000);
  const jetsam = stamped('JetsamEvent', 1800_000);
  return {
    runner,
    jetsam,
    write(dir: string) {
      fs.mkdirSync(path.join(dir, 'Retired'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'ProxiedDevice-2A9F31'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Retired', runner), fixture('ios-swift-crash.ips'));
      fs.writeFileSync(path.join(dir, jetsam), fixture('ios-jetsam.ips'));
      fs.writeFileSync(path.join(dir, stamped('SpringBoard', 20 * 24 * 3600_000)), fixture('ios-system-crash.ips'));
      fs.writeFileSync(path.join(dir, 'ProxiedDevice-2A9F31', stamped('Runner', 600_000)), fixture('ios-swift-crash.ips'));
    },
  };
}

function fakeIdevice(opts: { installer?: (args: string[]) => RunResult; crash?: (args: string[]) => RunResult } = {}) {
  const calls: Array<{ tool: IdeviceFallbackTool; args: string[] }> = [];
  const folder = crashFolder();
  const run = async (tool: IdeviceFallbackTool, args: string[]): Promise<RunResult> => {
    calls.push({ tool, args });
    if (tool === 'ideviceinstaller') return opts.installer?.(args) ?? done(fixture('ios-ideviceinstaller-apps.xml'));
    const custom = opts.crash?.(args);
    if (custom) return custom;
    folder.write(args[args.length - 1]!);
    return done('Copy: Retired/' + folder.runner + '\nDone.\n');
  };
  return { run, calls, folder };
}

describe('ideviceinstaller app list', () => {
  it('reads third-party apps from the XML plist and tells development builds from the rest', () => {
    // A warning line before the plist does not matter.
    const apps = parseInstallerApps(`WARNING: could not set log level\n${fixture('ios-ideviceinstaller-apps.xml')}`);
    expect(apps).toEqual([
      {
        id: 'com.mykynk.mahalle',
        name: 'Mahalle',
        version: '1.8.2',
        build: '412',
        buildType: 'release',
        source: 'store-or-testflight',
        executable: 'Mahalle',
        bundle: 'file:///private/var/containers/Bundle/Application/2B7E4D90-1C3A-4F58-8E62-A0D9B5C7F311/Mahalle.app/',
      },
      {
        id: 'com.mykynk.pati',
        name: 'Pati',
        version: '2.3.0',
        build: '57',
        buildType: 'debug',
        source: 'xcode',
        executable: 'Runner',
        bundle: 'file:///private/var/containers/Bundle/Application/9F1C2B7A-58D3-4E0B-A6C1-3D27E8F0B941/Runner.app/',
      },
    ]);
    expect(parseInstallerApps('Total: 2 apps\ncom.mykynk.pati, "57", "Pati"')).toBeNull();
    expect(parseInstallerApps('<?xml version="1.0"?><plist><dict></dict></plist>')).toBeNull();
  });

  it('tries the 1.1 syntax, then the command syntax, and keeps the one that worked', async () => {
    const calls: string[][] = [];
    const source = ideviceinstallerAppSource({
      udid: UDID,
      logger: silentLogger,
      networkOnly: () => true,
      run: async (_tool, args) => {
        calls.push(args);
        return args.includes('-l') ? failed('ERROR: Unknown option -l') : done(fixture('ios-ideviceinstaller-apps.xml'));
      },
    });
    expect((await source.listInstalled())?.map((a) => a.id)).toEqual(['com.mykynk.mahalle', 'com.mykynk.pati']);
    await source.listInstalled();
    expect(calls).toEqual([
      ['-u', UDID, '-n', '-l', '-o', 'xml'],
      ['-u', UDID, '-n', 'list', '-o', 'xml'],
      ['-u', UDID, '-n', 'list', '-o', 'xml'],
    ]);
    // No developer services: running processes come from the log.
    expect(await source.listRunning([])).toBeNull();
  });

  it('falls back from devicectl only when its listing fails, and retries devicectl later', async () => {
    let primaryWorks = false;
    const primaryCalls: number[] = [];
    const primary: AppSource = {
      listInstalled: async () => {
        primaryCalls.push(1);
        return primaryWorks ? [{ id: 'com.mykynk.pati', buildType: 'debug', source: 'xcode' }] : null;
      },
      listRunning: async () => new Map([['com.mykynk.pati', [1234]]]),
      systemNames: () => new Set(['SpringBoard']),
    };
    const fallback = ideviceinstallerAppSource({
      udid: UDID,
      logger: silentLogger,
      networkOnly: () => false,
      run: async () => done(fixture('ios-ideviceinstaller-apps.xml')),
    });
    const source = fallbackAppSource(primary, fallback, 3)!;
    expect((await source.listInstalled())?.length).toBe(2);
    // On the fallback: no process listing, and no system-name knowledge either.
    expect(await source.listRunning([])).toBeNull();
    expect(source.systemNames).toBeUndefined();
    await source.listInstalled();
    await source.listInstalled();
    expect(primaryCalls).toHaveLength(1);
    primaryWorks = true;
    await source.listInstalled();
    expect(primaryCalls).toHaveLength(2);
    expect(await source.listRunning([])).toEqual(new Map([['com.mykynk.pati', [1234]]]));
    expect(source.systemNames?.()).toEqual(new Set(['SpringBoard']));
    expect(fallbackAppSource(undefined, fallback)).toBe(fallback);
  });
});

describe('idevicecrashreport crash folder', () => {
  it('copies with -k (never moving reports off the device), at most every 5 minutes, and lists it like devicectl', async () => {
    const mirror = path.join(tmp(), 'mirror');
    const idev = fakeIdevice();
    let now = 1_000_000;
    const source = ideviceCrashSource({ udid: UDID, logger: silentLogger, networkOnly: () => false, run: idev.run, mirrorDir: mirror, now: () => now });
    const r = await source.list();
    expect(idev.calls).toEqual([{ tool: 'idevicecrashreport', args: ['-u', UDID, '-k', mirror] }]);
    expect(r.ok).toBe(true);
    const files = r.ok ? r.files : [];
    const byPath = new Map(files.map((f) => [f.relativePath, f]));
    expect(byPath.get(`Retired/${idev.folder.runner}`)).toMatchObject({ name: `Retired/${idev.folder.runner}`, bugType: '309', isDirectory: false });
    expect(byPath.get(idev.folder.jetsam)?.bugType).toBe('298');
    now += 60_000;
    await source.list();
    expect(idev.calls).toHaveLength(1);
    now += 5 * 60_000;
    await source.list();
    expect(idev.calls).toHaveLength(2);
    expect(await listCrashMirror(path.join(mirror, 'missing'))).toEqual([]);
  });

  it('turns the copied reports into crash and memory-kill callbacks through the crash watcher', async () => {
    const root = tmp();
    const idev = fakeIdevice();
    const source = ideviceCrashSource({ udid: UDID, logger: silentLogger, networkOnly: () => false, run: idev.run, mirrorDir: crashMirrorDir(root, UDID) });
    const reports: IpsReport[] = [];
    const jetsams: JetsamReport[] = [];
    const statuses: unknown[] = [];
    const destDir = crashCopyDir(root, UDID);
    const w = new DeviceCrashWatcher({
      udid: UDID,
      source,
      destDir,
      logger: silentLogger,
      // App list unknown: the report type in each file's header decides.
      isInteresting: () => false,
      onReport: (r) => reports.push(r),
      onJetsam: (r) => {
        jetsams.push(r);
        return false;
      },
      onStatus: (s) => statuses.push(s),
    });
    await w.scan();
    expect(statuses).toEqual([{ ok: true, via: 'idevicecrashreport' }]);
    expect(reports.map((r) => r.bundleId)).toEqual(['com.mykynk.pati']);
    expect(jetsams).toHaveLength(1);
    // The served copy folder holds only the crash report (the Watch's and the old system report are skipped).
    expect(fs.readdirSync(destDir)).toEqual([idev.folder.runner]);
    expect(path.relative(root, crashMirrorDir(root, UDID)).startsWith('crash-mirror')).toBe(true);
    await w.scan();
    expect(reports).toHaveLength(1);
    await w.stop();
  });

  it('switches from a failing devicectl listing to the fallback and says why when both fail', async () => {
    let fallbackWorks = true;
    const primary: CrashSource = { list: async () => ({ ok: false, error: 'The device is not available (Developer Mode disabled).' }), copy: async () => ({ ok: false }) };
    const fallback: CrashSource = {
      via: 'idevicecrashreport',
      list: async () => (fallbackWorks ? { ok: true, files: [] } : { ok: false, error: 'ERROR: Could not connect to lockdownd' }),
      copy: async () => ({ ok: true }),
    };
    const source = fallbackCrashSource(primary, fallback)!;
    expect(await source.list()).toEqual({ ok: true, files: [] });
    expect(source.via).toBe('idevicecrashreport');
    fallbackWorks = false;
    // Still on the fallback (devicectl is retried every 10 listings).
    expect(await source.list()).toEqual({ ok: false, error: 'ERROR: Could not connect to lockdownd' });
    const fresh = fallbackCrashSource(primary, fallback)!;
    expect(await fresh.list()).toEqual({
      ok: false,
      error: 'The device is not available (Developer Mode disabled). · idevicecrashreport: ERROR: Could not connect to lockdownd',
    });
    expect(fresh.via).toBeUndefined();
    expect(fallbackCrashSource(undefined, undefined)).toBeUndefined();
  });
});

function writeFakeSyslog(dir: string): string {
  const file = path.join(dir, 'idevicesyslog');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
process.stdout.write([
  'Nov  2 11:43:01.123456 Test iPhone’u Runner(Flutter)[1234] <Notice>: flutter: sepet yüklendi',
  'Nov  2 11:43:01.223456 Test iPhone’u SpringBoard[58] <Notice>: Front display did change',
].join('\\n') + '\\n');
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe('IosDeviceDriver · libimobiledevice fallbacks', () => {
  let mux: FakeUsbmuxd;
  let dir: string;
  let ctx: FakeCtx;
  let driver: IosDeviceDriver | undefined;

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    dir = tmp();
    ctx = createCtx({ settings: { idevicesyslogPath: writeFakeSyslog(dir) } });
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone14,7', ProductVersion: '16.7.10' }));
  });

  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
    await mux.close();
  });

  const timing = { appsEveryMs: 60_000, processesEveryMs: 1000, crashesEveryMs: 1000, crashStartDelayMs: 100 };

  it('without devicectl: apps from ideviceinstaller, crash reports from idevicecrashreport, the log scope applies', async () => {
    const idev = fakeIdevice();
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false, idevice: idev.run, timing });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    // The developer build is running: its pid comes from the log (no process listing without devicectl).
    const pati = await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`));
    expect(pati).toMatchObject({ name: 'Pati', buildType: 'debug', install: { source: 'xcode' } });
    const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'), 8000);
    expect(crash.entry.data).toMatchObject({ bundleId: 'com.mykynk.pati' });
    await waitFor(() => ctx.hub.devices.get(ID)?.readers?.crashReports?.status === 'ok');
    expect(ctx.hub.devices.get(ID)?.readers?.crashReports).toMatchObject({ status: 'ok', code: 'reader.crashReports.viaLibimobiledevice' });
    // The app list is known: no "all lines are shown" note, and SpringBoard's line is left out.
    await waitFor(() => ctx.hub.logs.some((l) => l.entry.process === 'Runner'));
    expect(ctx.hub.system.some((s) => s.input.code === 'logs.scopeNotApplied')).toBe(false);
    expect(ctx.hub.logs.some((l) => l.entry.process === 'SpringBoard')).toBe(false);
    expect(idev.calls.find((c) => c.tool === 'idevicecrashreport')?.args).toContain('-k');
  });

  it('with devicectl failing (iOS 16): the fallbacks take over', async () => {
    const idev = fakeIdevice();
    const devicectl = async (): Promise<DevicectlResult> => ({ ok: false, error: 'The device is not supported by CoreDevice.', stdout: '', stderr: '' });
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, devicectl, idevice: idev.run, timing });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`));
    await waitFor(() => ctx.hub.devices.get(ID)?.readers?.crashReports?.code === 'reader.crashReports.viaLibimobiledevice', 8000);
  });

  it('without devicectl and without the fallbacks: the reader says what is missing', async () => {
    const idev = fakeIdevice();
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false, idevice: idev.run, ideviceTools: [], timing });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.readers?.crashReports?.status === 'unavailable');
    expect(ctx.hub.devices.get(ID)?.readers?.crashReports?.detail).toContain('idevicecrashreport');
    expect(idev.calls).toEqual([]);
  });
});
