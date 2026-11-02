import { describe, expect, it } from 'vitest';
import { IosAppTracker, RECENT_ACTIVITY_MS, type AppSource, type InstalledIosApp } from '../../src/platform/ios/appTracker';
import { parseIps } from '../../src/platform/ios/crashReport';
import {
  devicectlDate,
  parseDevicectlApps,
  parseDevicectlFiles,
  type DevicectlResult,
} from '../../src/platform/ios/devicectl';
import { classifyDevicectlApps, devicectlAppSource, executableFromBundleUrl } from '../../src/platform/ios/deviceApps';
import { silentLogger } from '../../src/util/logger';
import { createFakeHub, fixture } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const DEV = `ios:${UDID}`;
const json = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>;
const ok = (j: Record<string, unknown>): DevicectlResult => ({ ok: true, json: j, stdout: '', stderr: '' });
const failed = (error: string): DevicectlResult => ({ ok: false, error, stdout: '', stderr: error });

describe('devicectl apps → installed third-party apps', () => {
  it('developer list = Xcode/debug, the rest of --include-all-apps = store-or-testflight/release', () => {
    const apps = classifyDevicectlApps(
      parseDevicectlApps(json('ios-devicectl-apps-developer.json')),
      parseDevicectlApps(json('ios-devicectl-apps-all.json')),
    );
    expect(apps.map((a) => a.id)).toEqual(['com.burbn.instagram', 'com.mykynk.kasa', 'com.mykynk.mahalle', 'com.mykynk.pati']);
    expect(apps.find((a) => a.id === 'com.mykynk.pati')).toEqual({
      id: 'com.mykynk.pati',
      name: 'Pati',
      version: '2.3.0',
      build: '57',
      buildType: 'debug',
      source: 'xcode',
      executable: 'Runner',
      bundle: 'file:///private/var/containers/Bundle/Application/9F1C2B7A-58D3-4E0B-A6C1-3D27E8F0B941/Runner.app/',
    });
    expect(apps.find((a) => a.id === 'com.mykynk.mahalle')).toMatchObject({
      buildType: 'release',
      source: 'store-or-testflight',
      executable: 'Mahalle',
      version: '4.1.0',
      build: '412',
    });
    // Two Flutter apps share the executable name "Runner".
    expect(apps.filter((a) => a.executable === 'Runner').map((a) => a.id)).toEqual(['com.mykynk.kasa', 'com.mykynk.pati']);
  });

  it('falls back to builtByDeveloper when only the all-apps list worked', () => {
    const apps = classifyDevicectlApps(null, parseDevicectlApps(json('ios-devicectl-apps-all.json')));
    expect(apps.find((a) => a.id === 'com.mykynk.pati')?.source).toBe('xcode');
    expect(apps.find((a) => a.id === 'com.mykynk.kasa')?.source).toBe('store-or-testflight');
  });

  it('decodes bundle URLs into executable names', () => {
    expect(executableFromBundleUrl('file:///private/var/containers/Bundle/Application/X/My%20App.app/')).toBe('My App');
    expect(executableFromBundleUrl('file:///Applications/MobileSafari.app')).toBe('MobileSafari');
    expect(executableFromBundleUrl(undefined)).toBeUndefined();
    expect(executableFromBundleUrl('file:///usr/libexec/backboardd')).toBeUndefined();
  });

  it('devicectlAppSource runs the documented commands and maps processes to apps', async () => {
    const calls: string[][] = [];
    const source = devicectlAppSource(UDID, async (args) => {
      calls.push(args);
      if (args.includes('processes')) return ok(json('ios-devicectl-processes.json'));
      return ok(json(args.includes('--include-all-apps') ? 'ios-devicectl-apps-all.json' : 'ios-devicectl-apps-developer.json'));
    });
    const installed = (await source.listInstalled())!;
    expect(calls).toEqual([
      ['device', 'info', 'apps', '--device', UDID],
      ['device', 'info', 'apps', '--device', UDID, '--include-all-apps'],
    ]);
    const running = (await source.listRunning(installed))!;
    expect(calls[2]).toEqual(['device', 'info', 'processes', '--device', UDID]);
    expect(Object.fromEntries(running)).toEqual({ 'com.mykynk.pati': [1234, 1290], 'com.mykynk.mahalle': [2210] });
    // No executable paths (e.g. simulator-style output) → cannot tell.
    const noExe = devicectlAppSource(UDID, async () => ok(json('devicectl-processes.json')));
    expect(await noExe.listRunning(installed)).toBeNull();
    const broken = devicectlAppSource(UDID, async () => failed('The device is locked.'));
    expect(await broken.listInstalled()).toBeNull();
    expect(await broken.listRunning(installed)).toBeNull();
  });
});

describe('devicectl files / dates', () => {
  it('parses the systemCrashLogs listing', () => {
    const files = parseDevicectlFiles(json('ios-devicectl-crashlogs.json'));
    expect(files).toHaveLength(8);
    expect(files[0]).toMatchObject({ name: 'Assistant', isDirectory: true });
    expect(files[1]).toEqual({
      name: 'Runner-2026-11-02-114258.ips',
      relativePath: 'Runner-2026-11-02-114258.ips',
      isDirectory: false,
      size: 18342,
      modified: Date.UTC(2026, 10, 2, 8, 42, 59),
    });
    expect(files[7]).toMatchObject({ name: 'Instagram-2026-11-02-073001.ips', relativePath: 'Retired/Instagram-2026-11-02-073001.ips' });
    expect(parseDevicectlFiles(undefined)).toEqual([]);
    // Flat layout (keys on the file object itself) is accepted too.
    expect(
      parseDevicectlFiles({ result: { files: [{ name: 'a.ips', relativePath: '/a.ips', isDirectory: false, lastModDate: 815267119 }] } })[0],
    ).toMatchObject({ relativePath: 'a.ips', modified: (815267119 + 978307200) * 1000 });
  });

  it('reads ISO and reference-date timestamps', () => {
    expect(devicectlDate('2026-11-01T23:05:19.000Z')).toBe(Date.UTC(2026, 10, 1, 23, 5, 19));
    expect(devicectlDate(815267119)).toBe(Date.UTC(2026, 10, 1, 23, 5, 19));
    expect(devicectlDate(1793574319)).toBe(1793574319000);
    expect(devicectlDate('nope')).toBeUndefined();
    expect(devicectlDate(undefined)).toBeUndefined();
  });
});

/* ───────────── tracker ───────────── */

const PATI: InstalledIosApp = {
  id: 'com.mykynk.pati',
  name: 'Pati',
  version: '2.3.0',
  build: '57',
  buildType: 'debug',
  source: 'xcode',
  executable: 'Runner',
  bundle: 'file:///A/Runner.app/',
};
const KASA: InstalledIosApp = { ...PATI, id: 'com.mykynk.kasa', name: 'Kasa', version: '1.0.4', build: '19', buildType: 'release', source: 'store-or-testflight', bundle: 'file:///B/Runner.app/' };
const MAHALLE: InstalledIosApp = { ...PATI, id: 'com.mykynk.mahalle', name: 'Mahalle', executable: 'Mahalle', buildType: 'release', source: 'store-or-testflight', bundle: 'file:///C/Mahalle.app/' };

function setup(opts: { installed?: InstalledIosApp[] | null; running?: Record<string, number[]> | null } = {}) {
  const hub = createFakeHub();
  let clock = 1_000_000;
  const state = {
    installed: opts.installed === undefined ? [PATI, KASA, MAHALLE] : opts.installed,
    running: opts.running === undefined ? {} : opts.running,
    runningCalls: 0,
  };
  const source: AppSource = {
    listInstalled: async () => state.installed,
    listRunning: async () => {
      state.runningCalls += 1;
      return state.running ? new Map(Object.entries(state.running)) : null;
    },
  };
  const tracker = new IosAppTracker({
    deviceId: DEV,
    hub,
    getDeviceApps: () => [...hub.deviceApps.values()],
    source,
    logger: silentLogger,
    installedEveryMs: 300_000,
    runningEveryMs: 30_000,
    now: () => clock,
  });
  return {
    hub,
    tracker,
    state,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    app: (id: string) => hub.deviceApps.get(`${DEV}|${id}`),
  };
}

describe('IosAppTracker', () => {
  it('lists only running apps, with version/build/install info', async () => {
    const t = setup({ running: { 'com.mykynk.pati': [1234, 1290] } });
    await t.tracker.tick();
    expect([...t.hub.deviceApps.keys()]).toEqual([`${DEV}|com.mykynk.pati`]);
    expect(t.app('com.mykynk.pati')).toMatchObject({
      deviceId: DEV,
      id: 'com.mykynk.pati',
      name: 'Pati',
      version: '2.3.0',
      build: '57',
      buildType: 'debug',
      install: { source: 'xcode' },
      processName: 'Runner',
      pids: [1234, 1290],
      running: true,
      lastActivity: t.now(),
    });
    // Nothing changes → no further upserts.
    const n = t.hub.deviceAppUpserts.length;
    t.advance(31_000);
    await t.tracker.tick();
    expect(t.hub.deviceAppUpserts.length).toBe(n);
    // App stops: running false, pid death reported, kept while recently active.
    t.state.running = {};
    t.advance(31_000);
    await t.tracker.tick();
    expect(t.app('com.mykynk.pati')).toMatchObject({ pids: [], running: false });
    expect(t.hub.processes.filter((p) => p.event === 'died').map((p) => p.pid)).toEqual([1234, 1290]);
    // …and dropped after 15 idle minutes.
    t.advance(RECENT_ACTIVITY_MS + 1000);
    await t.tracker.tick();
    expect(t.app('com.mykynk.pati')).toBeUndefined();
    expect(t.hub.removedDeviceApps).toEqual([{ deviceId: DEV, ids: ['com.mykynk.pati'] }]);
  });

  it('maps a log line (process + pid) to the app with a unique executable name', async () => {
    const t = setup();
    await t.tracker.tick();
    expect(t.hub.deviceApps.size).toBe(0);
    t.tracker.onLog({ ts: t.now(), level: 'info', tag: 'Mahalle', message: 'hello', pid: 2210, process: 'Mahalle' });
    expect(t.app('com.mykynk.mahalle')).toMatchObject({ pids: [2210], running: true, buildType: 'release', install: { source: 'store-or-testflight' } });
    // Unrelated processes are ignored.
    t.tracker.onLog({ ts: t.now(), level: 'info', tag: 'x', message: 'x', pid: 57, process: 'SpringBoard' });
    expect(t.hub.deviceApps.size).toBe(1);
  });

  it('resolves several apps named "Runner" through the process list', async () => {
    const t = setup();
    await t.tracker.tick();
    const before = t.state.runningCalls;
    t.tracker.onLog({ ts: t.now(), level: 'info', tag: 'flutter', message: 'hi', pid: 3301, process: 'Runner' });
    // Ambiguous: nothing guessed…
    expect(t.hub.deviceApps.size).toBe(0);
    // …a process check was requested and resolves it.
    t.state.running = { 'com.mykynk.kasa': [3301] };
    await t.tracker.tick();
    expect(t.state.runningCalls).toBe(before + 1);
    expect(t.app('com.mykynk.kasa')).toMatchObject({ pids: [3301], running: true, name: 'Kasa' });
    expect(t.app('com.mykynk.pati')).toBeUndefined();
  });

  it('counts crash reports and keeps crashed apps listed', async () => {
    const t = setup({ running: { 'com.mykynk.pati': [1234] } });
    await t.tracker.tick();
    const report = parseIps(fixture('ios-swift-crash.ips'))!;
    t.tracker.onCrash(report);
    expect(t.app('com.mykynk.pati')).toMatchObject({ crashReports: 1, pids: [], running: false });
    expect(t.app('com.mykynk.pati')!.lastActivity).toBe(report.ts);
    // An app that is no longer installed still shows up with the crash report's info.
    const legacy = parseIps(fixture('ios-objc-exception.ips'))!;
    const t2 = setup({ installed: [] });
    await t2.tracker.tick();
    t2.tracker.onCrash(legacy);
    expect(t2.app('com.mykynk.mahalle')).toMatchObject({
      name: 'Mahalle',
      version: '4.1.0',
      build: '412',
      crashReports: 1,
      lastActivity: legacy.ts,
    });
    t2.advance(RECENT_ACTIVITY_MS * 4);
    await t2.tracker.tick();
    expect(t2.app('com.mykynk.mahalle')).toBeDefined();
    // System apps never become DeviceApps.
    t2.tracker.onCrash(parseIps(fixture('ios-system-crash.ips'))!);
    expect(t2.hub.deviceApps.size).toBe(1);
  });

  it('keeps the last known state when listings fail and marks apps stopped on dispose', async () => {
    const t = setup({ running: { 'com.mykynk.pati': [1234] } });
    await t.tracker.tick();
    t.state.running = null;
    t.advance(31_000);
    await t.tracker.tick();
    expect(t.app('com.mykynk.pati')).toMatchObject({ pids: [1234], running: true });
    await t.tracker.stop();
    expect(t.app('com.mykynk.pati')).toMatchObject({ pids: [], running: false });
    const none = setup({ installed: null });
    await none.tracker.tick();
    expect(none.tracker.knowsApps).toBe(false);
    expect(none.tracker.isInteresting('Anything')).toBe(true);
    expect(t.tracker.isInteresting('Runner')).toBe(true);
    expect(t.tracker.isInteresting('SpringBoard')).toBe(false);
  });

  it('refreshes version info after a reinstall', async () => {
    const t = setup({ running: { 'com.mykynk.pati': [1234] } });
    await t.tracker.tick();
    t.state.installed = [{ ...PATI, version: '2.3.1', build: '58' }, KASA, MAHALLE];
    t.advance(301_000);
    await t.tracker.tick();
    expect(t.app('com.mykynk.pati')).toMatchObject({ version: '2.3.1', build: '58', pids: [1234] });
  });
});
