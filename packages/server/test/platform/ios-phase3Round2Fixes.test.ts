/**
 * Phase-3 review, round 2 verification (iOS):
 *   - 'apps' scope: processes of an app installed after the last devicectl listing (and its extensions)
 *     count as third-party at once, the tracker relists early, and Dürbün's own installs relist too;
 *   - when the scope cannot be applied (no devicectl, app list not readable) one line says so;
 *   - every USB gap is a 'logs.connectionLost' line and a 'logs.connectionRestored' line (with its length);
 *   - idevicesyslog that ended while the device was away is started again when it is back;
 *   - only an app extension's crash report goes to its host app (a com.x.app.dev flavor's is its own);
 *   - device crash reports need no wait for the first app listing (devicectl calls are queued in order).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveChildCount } from '../../src/platform/exec';
import { IosAppTracker, type AppSource, type InstalledIosApp } from '../../src/platform/ios/appTracker';
import { crashReportEntry, parseIps } from '../../src/platform/ios/crashReport';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { appContainerOf, devicectlAppSource } from '../../src/platform/ios/deviceApps';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import { silentLogger } from '../../src/util/logger';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { createCtx, createFakeHub, fixture, waitFor, type FakeCtx } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const ID = `ios:${UDID}`;
const json = (name: string) => JSON.parse(fixture(name)) as Record<string, any>;
const ok = (j: Record<string, unknown>): DevicectlResult => ({ ok: true, json: j, stdout: '', stderr: '' });
const failed = (error: string): DevicectlResult => ({ ok: false, error, stdout: '', stderr: '' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-r2v-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Cüzdan: a native app installed from Xcode after Dürbün's first listing, with a notification service. */
const CUZDAN_BUNDLE = 'file:///private/var/containers/Bundle/Application/0D2C1C55-0000-4000-8000-00000000AB12/Cuzdan.app/';
const CUZDAN_APP = {
  appClip: false,
  builtByDeveloper: true,
  bundleIdentifier: 'com.mykynk.cuzdan',
  hidden: false,
  internalApp: false,
  name: 'Cüzdan',
  removable: true,
  url: CUZDAN_BUNDLE,
  version: '0.9.0',
  bundleVersion: '9',
};
const CUZDAN_PROCESSES = [
  { executable: `${CUZDAN_BUNDLE}Cuzdan`, processIdentifier: 20001 },
  { executable: `${CUZDAN_BUNDLE}PlugIns/CuzdanNotificationService.appex/CuzdanNotificationService`, processIdentifier: 20002 },
];

/**
 * The real iPhone captures plus Cüzdan: `listsCuzdan()` decides whether app listings have it, `runsCuzdan()`
 * whether process listings show its processes.
 */
function cuzdanDevicectl(listsCuzdan: () => boolean, runsCuzdan: () => boolean = () => true) {
  const calls: string[][] = [];
  const procs = json('ios-devicectl-real-processes.json');
  const withCuzdan = json('ios-devicectl-real-processes.json');
  withCuzdan.result.runningProcesses.push(...CUZDAN_PROCESSES);
  const run = async (args: string[]): Promise<DevicectlResult> => {
    calls.push(args);
    if (args[0] === 'list') return ok(json('ios-devicectl-real-list-devices.json'));
    if (args[1] === 'install') return ok({ info: { outcome: 'success' } });
    if (args[2] === 'apps') {
      const all = args.includes('--include-all-apps');
      const j = json(all ? 'ios-devicectl-real-apps-all.json' : 'ios-devicectl-real-apps-developer.json');
      if (listsCuzdan()) j.result.apps.push(CUZDAN_APP);
      return ok(j);
    }
    if (args[2] === 'processes') return ok(runsCuzdan() ? withCuzdan : procs);
    if (args[2] === 'files') return ok({ result: { files: [] } });
    return failed(`unexpected ${args.join(' ')}`);
  };
  const appListings = () => calls.filter((a) => a[2] === 'apps' && a.includes('--include-all-apps')).length;
  return { run, calls, appListings };
}

/** idevicesyslog stand-in: "[connected:…]" at once; prints and deletes emit.txt; exits when quit appears. */
function writeSyslog(dir: string): string {
  const file = path.join(dir, 'idevicesyslog');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(dir)};
if (process.argv.includes('--version')) { console.log('idevicesyslog 1.3.0-fake'); process.exit(0); }
fs.appendFileSync(dir + '/spawns.txt', 'spawn\\n');
const udid = process.argv[process.argv.indexOf('-u') + 1];
process.stdout.write('[connected:' + udid + ']\\n');
setInterval(() => {
  if (fs.existsSync(dir + '/quit')) { fs.rmSync(dir + '/quit'); process.exit(1); }
  if (fs.existsSync(dir + '/emit.txt')) {
    const text = fs.readFileSync(dir + '/emit.txt', 'utf8');
    fs.rmSync(dir + '/emit.txt');
    process.stdout.write(text + '\\n');
  }
}, 20);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe('IosDeviceDriver · round-2 verification', () => {
  let mux: FakeUsbmuxd;
  let dir: string;
  let ctx: FakeCtx;
  let driver: IosDeviceDriver | undefined;

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    dir = tmp();
    ctx = createCtx({ settings: { idevicesyslogPath: writeSyslog(dir) } });
    for (const id of [5, 6, 7]) mux.onPort(id, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
  });

  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
    await mux.close();
    await waitFor(() => liveChildCount() === 0, 5000);
  });

  const deviceLines = () => ctx.hub.logs.filter((l) => l.deviceId === ID && l.entry.origin === 'idevicesyslog');
  const emit = (lines: string[]) => {
    fs.writeFileSync(path.join(dir, 'emit.tmp'), lines.join('\n'));
    fs.renameSync(path.join(dir, 'emit.tmp'), path.join(dir, 'emit.txt'));
  };
  const spawns = () => fs.readFileSync(path.join(dir, 'spawns.txt'), 'utf8').trim().split('\n').length;
  const system = (code: string) => ctx.hub.system.filter((s) => s.deviceId === ID && s.input.code === code);
  const start = async (opts: ConstructorParameters<typeof IosDeviceDriver>[0]) => {
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, ...opts });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
  };

  const CUZDAN_LINES = [
    'Nov  2 23:00:18 kernel(AppleSPMIPMU)[0] <Notice>: RTC upcountTicks=2e88ce7e2fe',
    'Nov  2 23:01:00 Cuzdan(Foundation)[20001] <Notice>: Cüzdan: ödeme ekranı açıldı',
    'Nov  2 23:01:00 CuzdanNotificationService(UserNotifications)[20002] <Notice>: bildirim içeriği hazırlandı',
    'Nov  2 23:01:00 FitnessWidget(WidgetKit)[14799] <Notice>: timeline reloaded',
    'Nov  2 23:01:01 Runner(Flutter)[14812] <Notice>: flutter: Sepet açıldı',
  ];

  it("apps scope: an app devicectl has not listed (yet) keeps its lines, extensions too; one early relist", async () => {
    const fake = cuzdanDevicectl(() => false);
    // Default app listing interval (5 min); processes every 100 ms.
    await start({ devicectl: fake.run, timing: { processesEveryMs: 100, crashesEveryMs: 60_000, crashStartDelayMs: 60_000 } });
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)?.running);
    // The process list showed Cüzdan's bundle, which the listing lacks: one relist, not one per listing.
    await waitFor(() => fake.appListings() === 2);
    await sleep(400);
    expect(fake.appListings()).toBe(2);
    emit(CUZDAN_LINES);
    await waitFor(() => deviceLines().some((l) => l.entry.process === 'Runner'));
    await sleep(150);
    expect(deviceLines().map((l) => l.entry.process)).toEqual(['Cuzdan', 'CuzdanNotificationService', 'Runner']);
    // Apple's removable apps (Fitness and its widget) are in the listing: still system lines.
    expect(deviceLines().some((l) => l.entry.process === 'FitnessWidget')).toBe(false);
  });

  it('apps scope: the early relist shows the new app with its name, version and pids', async () => {
    const fake = cuzdanDevicectl(() => fake.appListings() > 1);
    await start({ devicectl: fake.run, timing: { processesEveryMs: 100, crashesEveryMs: 60_000, crashStartDelayMs: 60_000 } });
    const app = await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.cuzdan`), 4000);
    expect(app).toMatchObject({ name: 'Cüzdan', version: '0.9.0', build: '9', running: true, pids: [20001, 20002] });
    expect(fake.appListings()).toBe(2);
  });

  it("app-install through Dürbün relists installed apps right away", async () => {
    let installed = false;
    // Cüzdan is installed (and started from Xcode) only now.
    const fake = cuzdanDevicectl(() => installed, () => installed);
    // Processes are listed rarely here: only the install can make the app known soon.
    await start({ devicectl: fake.run, timing: { processesEveryMs: 60_000, crashesEveryMs: 60_000, crashStartDelayMs: 60_000 } });
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)?.running);
    await sleep(100);
    const before = fake.appListings();
    const bundle = path.join(tmp(), 'Cuzdan.app');
    fs.mkdirSync(bundle);
    installed = true;
    const r = await driver!.runAction(ID, 'app-install', { file: bundle });
    expect(r).toMatchObject({ ok: true });
    expect(fake.calls.some((a) => a[1] === 'install' && a.includes(bundle))).toBe(true);
    await waitFor(() => fake.appListings() === before + 1, 3000);
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.cuzdan`)?.running, 3000);
    emit(CUZDAN_LINES);
    await waitFor(() => deviceLines().some((l) => l.entry.process === 'Runner'));
    await sleep(150);
    expect(deviceLines().map((l) => l.entry.process)).toEqual(['Cuzdan', 'CuzdanNotificationService', 'Runner']);
  });

  it("scope cannot be applied without devicectl: one line says every line is shown, and why", async () => {
    await start({ useDevicectl: false });
    await waitFor(() => system('logs.scopeNotApplied').length === 1);
    expect(system('logs.scopeNotApplied')[0]!.input).toMatchObject({
      level: 'warn',
      params: { reason: 'devicectlMissing', via: 'idevicesyslog', device: 'Test iPhone’u' },
    });
    expect(system('logs.scopeNotApplied')[0]!.input.message).toContain('Xcode 15');
    emit(CUZDAN_LINES);
    await waitFor(() => deviceLines().length === CUZDAN_LINES.length);
    ctx.setSettings({ iosDeviceLogScope: 'all' });
    ctx.setSettings({ iosDeviceLogScope: 'apps' });
    await sleep(100);
    expect(system('logs.scopeNotApplied')).toHaveLength(1);
  });

  it("scope 'all' says nothing; switching to 'apps' while it cannot be applied says it then", async () => {
    ctx.setSettings({ iosDeviceLogScope: 'all' });
    await start({ useDevicectl: false });
    await sleep(150);
    expect(system('logs.scopeNotApplied')).toHaveLength(0);
    ctx.setSettings({ iosDeviceLogScope: 'apps' });
    await waitFor(() => system('logs.scopeNotApplied').length === 1);
  });

  it('scope cannot be applied when devicectl cannot read the installed apps', async () => {
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'apps') return failed('Developer Mode is disabled on the device');
      if (args[0] === 'list') return ok(json('ios-devicectl-real-list-devices.json'));
      return failed(`unexpected ${args.join(' ')}`);
    };
    await start({ devicectl: run, timing: { crashStartDelayMs: 60_000 } });
    await waitFor(() => system('logs.scopeNotApplied').length === 1);
    expect(system('logs.scopeNotApplied')[0]!.input.params).toMatchObject({ reason: 'appListFailed' });
    expect(system('logs.scopeNotApplied')[0]!.input.message).toContain('could not be read with devicectl');
  });

  it('scope applied (apps listed): nothing is said', async () => {
    await start({ devicectl: cuzdanDevicectl(() => true).run, timing: { crashStartDelayMs: 60_000 } });
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)?.running);
    await sleep(100);
    expect(system('logs.scopeNotApplied')).toHaveLength(0);
  });

  it('a gap names the connection that dropped (USB), even when the device comes back over Wi-Fi', async () => {
    await start({ useDevicectl: false, timing: { detachGraceMs: 1000 } });
    mux.detach(5);
    await waitFor(() => system('logs.connectionLost').length === 1);
    expect(system('logs.connectionLost')[0]!.input.params).toMatchObject({ connection: 'usb', graceSeconds: 1 });
    expect(system('logs.connectionLost')[0]!.input.params?.detail).toBe(
      'the USB connection dropped; log lines are missing until the device is back; it is shown disconnected if it is not back within 1 s',
    );
    mux.attach({ deviceId: 6, udid: UDID, connectionType: 'Network' });
    await waitFor(() => system('logs.connectionRestored').length === 1);
    expect(system('logs.connectionRestored')[0]!.input.params).toMatchObject({ connection: 'wifi' });
    expect(system('logs.connectionRestored')[0]!.input.message).toMatch(/^Device connection back \(the USB connection was gone for \d\.\d s/);
    expect(ctx.hub.disconnected).toEqual([]);
  });

  it('idevicesyslog that ended while the device was away is started again when it is back', async () => {
    await start({ useDevicectl: false, timing: { detachGraceMs: 3000 } });
    expect(spawns()).toBe(1);
    mux.detach(5);
    await waitFor(() => system('logs.connectionLost').length === 1);
    fs.writeFileSync(path.join(dir, 'quit'), '');
    // It ended without a usbmux connection: no restart until the device is back.
    await waitFor(() => liveChildCount() === 0, 3000);
    await sleep(300);
    expect(spawns()).toBe(1);
    mux.attach({ deviceId: 6, udid: UDID });
    await waitFor(() => spawns() === 2, 3000);
    emit(['Nov  2 23:01:01 Runner(Flutter)[14812] <Notice>: flutter: geri geldi']);
    await waitFor(() => deviceLines().some((l) => l.entry.message.includes('geri geldi')), 3000);
    expect(ctx.hub.disconnected).toEqual([]);
  });

  it("device crash reports: a flavor's own report (com.x.app.dev, no .appex) is not the store app's", async () => {
    const name = 'Retired/Runner-2026-11-02-114258.ips';
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const base = cuzdanDevicectl(() => false, () => false).run;
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'files') {
        return ok({ result: { files: [{ name, relativePath: name, metadata: { lastModDate: hourAgo, size: 9000, extendedAttributes: { bug_type: '309' } }, resources: { isDirectory: false } }] } });
      }
      if (args[1] === 'copy') {
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, fixture('ios-swift-crash.ips').replaceAll('com.mykynk.pati', 'com.mykynk.pati.dev'));
        return ok({ info: { outcome: 'success' } });
      }
      return base(args);
    };
    await start({ devicectl: run, timing: { appsEveryMs: 60_000, processesEveryMs: 60_000, crashesEveryMs: 60_000, crashStartDelayMs: 0 } });
    const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'));
    expect(crash.entry.message.startsWith('Runner 2.3.0 (57) crashed:')).toBe(true);
    expect(crash.entry.data).toMatchObject({ bundleId: 'com.mykynk.pati.dev' });
    expect(crash.entry.data).not.toHaveProperty('extensionBundleId');
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati.dev`)?.crashReports === 1);
    expect(ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`)?.crashReports ?? 0).toBe(0);
  });

  it('device crash reports: a slow first app listing still comes before the first report (one devicectl queue)', async () => {
    const NS = 'com.mykynk.mahalle.MahalleNotificationService';
    const name = 'Retired/MahalleNotificationService-2026-11-02-230022.ips';
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const base = cuzdanDevicectl(() => false, () => false).run;
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'apps') await sleep(300); // devicectl is slow on a busy phone
      if (args[2] === 'files') {
        return ok({ result: { files: [{ name, relativePath: name, metadata: { lastModDate: hourAgo, size: 9000, extendedAttributes: { bug_type: '309' } }, resources: { isDirectory: false } }] } });
      }
      if (args[1] === 'copy') {
        const text = fixture('ios-objc-exception.ips');
        const nl = text.indexOf('\n');
        const header = JSON.parse(text.slice(0, nl));
        const body = JSON.parse(text.slice(nl + 1));
        header.bundleID = NS;
        header.app_name = header.name = body.procName = 'MahalleNotificationService';
        body.procPath = `${String(body.procPath).replace(/\/[^/]+$/, '')}/PlugIns/MahalleNotificationService.appex/MahalleNotificationService`;
        body.bundleInfo = { ...body.bundleInfo, CFBundleIdentifier: NS };
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, `${JSON.stringify(header)}\n${JSON.stringify(body)}`);
        return ok({ info: { outcome: 'success' } });
      }
      return base(args);
    };
    await start({ devicectl: run, timing: { appsEveryMs: 60_000, processesEveryMs: 60_000, crashesEveryMs: 60_000, crashStartDelayMs: 0 } });
    const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'), 5000);
    expect(crash.entry.message.startsWith('Mahalle 4.1.0 (412) · MahalleNotificationService crashed:')).toBe(true);
    expect(crash.entry.data).toMatchObject({ bundleId: 'com.mykynk.mahalle', extensionBundleId: NS });
  });
});

describe('unlisted app bundles (devicectl app source + tracker)', () => {
  const tracker = (source: AppSource) =>
    new IosAppTracker({ deviceId: ID, hub: createFakeHub(), getDeviceApps: () => [], source, logger: silentLogger, installedEveryMs: 60_000, runningEveryMs: 60_000 });

  it('app containers', () => {
    expect(appContainerOf(`${CUZDAN_BUNDLE}PlugIns/CuzdanNotificationService.appex/CuzdanNotificationService`)).toBe(
      '/var/containers/Bundle/Application/0D2C1C55-0000-4000-8000-00000000AB12/Cuzdan.app',
    );
    expect(appContainerOf('file:///private/var/containers/Bundle/Application/CA14/Microsoft%20Authenticator.app/')).toBe(
      '/var/containers/Bundle/Application/CA14/Microsoft Authenticator.app',
    );
    expect(appContainerOf('file:///Applications/MobileSafari.app/MobileSafari')).toBeUndefined();
    expect(appContainerOf('file:///usr/libexec/locationd')).toBeUndefined();
  });

  it('count as third-party until a relist decides; an Apple app reinstalled since is a system app again after it', async () => {
    const fake = cuzdanDevicectl(() => false);
    let fitnessReinstalled = false;
    const run = async (args: string[]): Promise<DevicectlResult> => {
      const r = await fake.run(args);
      // Fitness was reinstalled (new container) after the first listing; the relist has its new URL.
      const moved = 'file:///private/var/containers/Bundle/Application/B4CF6DA8-0000-0000-0000-000000000001/Fitness.app/';
      const json = r.json as any;
      if (args[2] === 'processes') {
        for (const p of json.result.runningProcesses) if (/Fitness\.app/.test(p.executable ?? '')) p.executable = p.executable.replace(/^.*Fitness\.app\//, moved);
      }
      if (args[2] === 'apps' && fitnessReinstalled) {
        for (const a of json.result.apps) if (a.bundleIdentifier === 'com.apple.Fitness') a.url = moved;
      }
      return r;
    };
    const t = tracker(devicectlAppSource(UDID, run));
    expect(await t.refreshInstalled()).toBe(true);
    expect(await t.refreshRunning()).toBe(true);
    expect(t.isAppPid(20001) && t.isAppPid(20002) && t.isAppPid(14799)).toBe(true);
    expect(t.isAppProcess('Cuzdan') && t.isAppProcess('CuzdanNotificationService') && t.isAppProcess('FitnessWidget')).toBe(true);
    fitnessReinstalled = true;
    expect(await t.refreshInstalled()).toBe(true);
    expect(await t.refreshRunning()).toBe(true);
    expect(t.isAppPid(14799) || t.isAppProcess('FitnessWidget')).toBe(false);
    // Cüzdan is still not listed: its processes stay third-party.
    expect(t.isAppPid(20001) && t.isAppProcess('Cuzdan')).toBe(true);
  });

  it('without the all-apps list nothing is guessed (Apple apps live in app containers too)', async () => {
    const fake = cuzdanDevicectl(() => false);
    const run = async (args: string[]) => (args.includes('--include-all-apps') ? failed('timed out') : fake.run(args));
    const t = tracker(devicectlAppSource(UDID, run));
    expect(await t.refreshInstalled()).toBe(true);
    expect(await t.refreshRunning()).toBe(true);
    expect(t.isAppPid(20001) || t.isAppProcess('Cuzdan') || t.isAppProcess('FitnessWidget')).toBe(false);
  });
});

describe('crash report → app (extension vs flavor)', () => {
  const pati: InstalledIosApp = { id: 'com.mykynk.pati', name: 'Pati', version: '2.3.0', build: '57', buildType: 'release', source: 'store-or-testflight', executable: 'Runner' };

  it("only a .appex report goes to the host app; a flavor's report and one without a procPath are their own", async () => {
    const hub = createFakeHub();
    const t = new IosAppTracker({
      deviceId: ID,
      hub,
      getDeviceApps: () => [...hub.deviceApps.values()],
      source: { listInstalled: async () => [pati], listRunning: async () => new Map() },
      logger: silentLogger,
      installedEveryMs: 60_000,
      runningEveryMs: 60_000,
    });
    expect(await t.refreshInstalled()).toBe(true);
    const flavor = parseIps(fixture('ios-swift-crash.ips').replaceAll('com.mykynk.pati', 'com.mykynk.pati.dev'))!;
    expect(flavor.procPath).toMatch(/Runner\.app\/Runner$/);
    expect(t.reportApp(flavor)).toBeUndefined();
    expect(t.reportApp(parseIps(fixture('ios-swift-crash.ips'))!)).toBe('com.mykynk.pati');
    const ext = { bundleId: 'com.mykynk.pati.PatiWidget', procPath: '/private/var/containers/Bundle/Application/X/Runner.app/PlugIns/PatiWidget.appex/PatiWidget' };
    expect(t.reportApp(ext)).toBe('com.mykynk.pati');
    // Without a procPath nothing says it is an extension: it keeps its own bundle id.
    expect(t.reportApp({ bundleId: 'com.mykynk.pati.PatiWidget' })).toBeUndefined();
    expect(t.reportApp({ bundleId: 'com.apple.Fitness.FitnessWidget', procPath: '/x/Fitness.app/PlugIns/FitnessWidget.appex/FitnessWidget' })).toBeUndefined();

    const e = crashReportEntry(flavor, { watchStart: 0 });
    expect(e.data).toMatchObject({ bundleId: 'com.mykynk.pati.dev' });
    t.onCrash(flavor);
    expect(hub.deviceApps.get(`${ID}|com.mykynk.pati.dev`)).toMatchObject({ crashReports: 1 });
    expect(hub.deviceApps.get(`${ID}|com.mykynk.pati`)).toBeUndefined();
  });
});
