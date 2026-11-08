/**
 * Phase-3 review, round 3 (iOS): the independent verifier's findings on the round-2 work.
 *   1. 'apps' scope: a freshly installed app's lines (and its extensions') are kept before any listing has
 *      seen them; a process listing is asked for at once and decides (the relist follows);
 *   2. a scope that cannot be applied is carried by the streaming DeviceInfo.logs (code
 *      'logs.scopeNotApplied'), not only by one log line; a later good listing clears it ('logs.scopeApplied');
 *   3. every USB drop is its own 'logs.connectionLost' / 'logs.connectionRestored' pair with its length,
 *      also when the stream is not streaming at that moment;
 *   4. only a real app extension's crash report goes to its host app;
 *   5. the app tracker's first-listing wait (whenListed), the device-side listing hook, resume()'s restart;
 *   6. idevicesyslog alive but silent (choked syslog relay): 'logs.streamStalled', restarts with a backoff,
 *      'streaming' again when lines flow.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveChildCount } from '../../src/platform/exec';
import { IosAppTracker, type AppSource, type InstalledIosApp } from '../../src/platform/ios/appTracker';
import { crashReportEntry, parseIps } from '../../src/platform/ios/crashReport';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { devicectlAppSource } from '../../src/platform/ios/deviceApps';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import { IosDeviceLogFilter } from '../../src/platform/ios/deviceLogScope';
import type { DeviceLogInput } from '../../src/types';
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-r3-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Cüzdan: a native app installed (from Xcode) after Dürbün's first listing, with a notification service. */
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

/** The real iPhone captures; `state.lists` / `state.runs` add Cüzdan to app / process listings. */
function phone(state: { lists: boolean; runs: boolean; extraProcesses?: Array<{ executable: string; processIdentifier: number }> }) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<DevicectlResult> => {
    calls.push(args);
    if (args[0] === 'list') return ok(json('ios-devicectl-real-list-devices.json'));
    if (args[1] === 'install') return ok({ info: { outcome: 'success' } });
    if (args[2] === 'apps') {
      const j = json(args.includes('--include-all-apps') ? 'ios-devicectl-real-apps-all.json' : 'ios-devicectl-real-apps-developer.json');
      if (state.lists) j.result.apps.push(CUZDAN_APP);
      return ok(j);
    }
    if (args[2] === 'processes') {
      const j = json('ios-devicectl-real-processes.json');
      // The capture was trimmed; CommCenter runs all the time on a phone.
      j.result.runningProcesses.push({ executable: 'file:///System/Library/Frameworks/CoreTelephony.framework/Support/CommCenter', processIdentifier: 99 });
      if (state.runs) j.result.runningProcesses.push(...CUZDAN_PROCESSES);
      j.result.runningProcesses.push(...(state.extraProcesses ?? []));
      return ok(j);
    }
    if (args[2] === 'files') return ok({ result: { files: [] } });
    return failed(`unexpected ${args.join(' ')}`);
  };
  const appListings = () => calls.filter((a) => a[2] === 'apps' && a.includes('--include-all-apps')).length;
  const processListings = () => calls.filter((a) => a[2] === 'processes').length;
  return { run, calls, appListings, processListings };
}

const line = (process: string, pid: number, message = 'hello'): DeviceLogInput => ({ ts: 1, origin: 'idevicesyslog', level: 'info', tag: process, process, pid, message });

/* ───────────── 1 · unknown third-party-looking processes (tracker + filter) ───────────── */

describe('apps scope: processes no listing has explained yet', () => {
  function setup(state: Parameters<typeof phone>[0]) {
    let now = 1_800_000_000_000;
    const fake = phone(state);
    const tracker = new IosAppTracker({
      deviceId: ID,
      hub: createFakeHub(),
      getDeviceApps: () => [],
      source: devicectlAppSource(UDID, fake.run),
      logger: silentLogger,
      installedEveryMs: 5 * 60_000,
      runningEveryMs: 60_000,
      triggerGapMs: 10_000,
      now: () => now,
    });
    const filter = new IosDeviceLogFilter(() => tracker, () => 'apps');
    return { fake, tracker, filter, advance: (ms: number) => (now += ms) };
  }

  it('a third-party-looking name is kept and asks for a process listing at once; that listing decides', async () => {
    const state = { lists: false, runs: false };
    const { fake, tracker, filter, advance } = setup(state);
    await tracker.tick(); // first app + process listing
    expect(fake.processListings()).toBe(1);
    // Cüzdan was installed and started from Xcode right after the listing.
    state.runs = true;
    advance(1000);
    expect(filter.admit(line('Cuzdan', 20001))).toBe(true);
    expect(filter.admit(line('CuzdanNotificationService', 20002))).toBe(true);
    expect(filter.admit(line('Cuzdan', 20001, 'again'))).toBe(true);
    // A process listing is due now (the periodic one is a minute away), not one per line. It shows Cüzdan's
    // bundle, which the app listing lacks: the relist runs in the same step, then its processes again.
    state.lists = true;
    await tracker.tick();
    expect(fake.calls.filter((a) => a[2] === 'processes' || a.includes('--include-all-apps')).map((a) => a[2])).toEqual([
      'apps',
      'processes',
      'processes',
      'apps',
      'processes',
    ]);
    expect(tracker.app('com.mykynk.cuzdan')).toMatchObject({ name: 'Cüzdan', executable: 'Cuzdan' });
    expect(tracker.isAppPid(20001) && tracker.isAppPid(20002) && tracker.isAppProcess('CuzdanNotificationService')).toBe(true);
    expect(filter.admit(line('Cuzdan', 20001))).toBe(true);
    expect(filter.admit(line('CuzdanNotificationService', 20002))).toBe(true);
  });

  it('daemon-like and listed system names are never kept; an uppercase system process is kept only until the listing', async () => {
    const state = {
      lists: false,
      runs: false,
      extraProcesses: [] as Array<{ executable: string; processIdentifier: number }>,
    };
    const { fake, tracker, filter, advance } = setup(state);
    await tracker.tick();
    // Lowercase daemons and Apple XPC services, a listed system process, Apple's removable app's widget.
    for (const [name, pid] of [
      ['locationd', 88],
      ['spotlightknowledged.updater', 96363],
      ['com.apple.WebKit.WebContent', 4410],
      ['CommCenter', 99],
      ['FitnessWidget', 14799],
    ] as const) {
      expect(filter.admit(line(name, pid))).toBe(false);
    }
    advance(1000);
    await tracker.tick();
    expect(fake.processListings()).toBe(1); // nothing asked for a listing
    // An Apple helper with an uppercase name that started after the listing: kept until a listing says what it is.
    state.extraProcesses.push({ executable: 'file:///System/Library/Frameworks/Metal.framework/XPCServices/MTLCompilerService.xpc/MTLCompilerService', processIdentifier: 31000 });
    expect(filter.admit(line('MTLCompilerService', 31000))).toBe(true);
    await tracker.tick();
    expect(fake.processListings()).toBe(2);
    expect(filter.admit(line('MTLCompilerService', 31000))).toBe(false);
    expect(filter.admit(line('MTLCompilerService', 31002))).toBe(false);
  });

  it('a name the asked-for listing did not find (it had ended) is not kept again for 10 minutes; one listing per name', async () => {
    const state = { lists: false, runs: false };
    const { fake, tracker, filter, advance } = setup(state);
    await tracker.tick();
    advance(1000);
    expect(filter.admit(line('Ephemeral', 31001))).toBe(true);
    await tracker.tick();
    expect(fake.processListings()).toBe(2);
    advance(60_000);
    expect(filter.admit(line('Ephemeral', 31005))).toBe(false);
    await tracker.tick(); // the periodic listing only
    expect(fake.processListings()).toBe(3);
    advance(10 * 60_000);
    expect(filter.admit(line('Ephemeral', 31009))).toBe(true);
  });

  it('a listing asked for too soon after the last one is postponed, not dropped', async () => {
    const state = { lists: false, runs: false };
    const { fake, tracker, filter, advance } = setup(state);
    await tracker.tick();
    advance(1000);
    expect(filter.admit(line('First', 31001))).toBe(true);
    await tracker.tick();
    expect(fake.processListings()).toBe(2);
    advance(2000);
    expect(filter.admit(line('Second', 31002))).toBe(true);
    await tracker.tick();
    expect(fake.processListings()).toBe(2); // within the 10 s gap
    advance(8000);
    await tracker.tick();
    expect(fake.processListings()).toBe(3);
  });

  it('sources that cannot tell system processes (simulators) never keep unknown names', async () => {
    const pati: InstalledIosApp = { id: 'com.mykynk.pati', name: 'Pati', buildType: 'debug', source: 'simulator', executable: 'Runner' };
    const source: AppSource = { listInstalled: async () => [pati], listRunning: async () => new Map() };
    const tracker = new IosAppTracker({ deviceId: ID, hub: createFakeHub(), getDeviceApps: () => [], source, logger: silentLogger, installedEveryMs: 60_000, runningEveryMs: 60_000 });
    await tracker.tick();
    expect(tracker.keepsUnknownProcess('Cuzdan')).toBe(false);
  });
});

/* ───────────── 4 · crash report → host app (tracker) ───────────── */

describe('crash reports: only a real app extension maps to its host app', () => {
  const PATI_BUNDLE = 'file:///private/var/containers/Bundle/Application/E56754BF-B318-4018-8D3E-D6151646A1D3/Runner.app/';
  const pati: InstalledIosApp = { id: 'com.mykynk.pati', name: 'Pati', version: '2.3.0', build: '57', buildType: 'release', source: 'store-or-testflight', executable: 'Runner', bundle: PATI_BUNDLE };

  async function tracker() {
    const t = new IosAppTracker({
      deviceId: ID,
      hub: createFakeHub(),
      getDeviceApps: () => [],
      source: { listInstalled: async () => [pati], listRunning: async () => new Map() },
      logger: silentLogger,
      installedEveryMs: 60_000,
      runningEveryMs: 60_000,
    });
    expect(await t.refreshInstalled()).toBe(true);
    return t;
  }

  it('host by the .appex inside the installed bundle, else host id + one segment; everything else keeps its own id', async () => {
    const t = await tracker();
    const inPati = '/private/var/containers/Bundle/Application/E56754BF-B318-4018-8D3E-D6151646A1D3/Runner.app';
    // The .appex lies inside Pati's installed bundle: Pati's, whatever its bundle id says.
    expect(t.reportApp({ bundleId: 'com.vendor.sdk.Widget', procPath: `${inPati}/PlugIns/W.appex/W` })).toBe('com.mykynk.pati');
    // ExtensionKit extensions live in Extensions/.
    expect(t.reportApp({ bundleId: 'com.mykynk.pati.Ext', procPath: `/var/containers/Bundle/Application/OTHER/Runner.app/Extensions/Ext.appex/Ext` })).toBe('com.mykynk.pati');
    // Another container (an older install): the host id + one segment.
    expect(t.reportApp({ bundleId: 'com.mykynk.pati.PatiWidget', procPath: '/private/var/containers/Bundle/Application/OLD/Runner.app/PlugIns/PatiWidget.appex/PatiWidget' })).toBe('com.mykynk.pati');
    // Two segments below the host, outside its bundle: not Pati's.
    expect(t.reportApp({ bundleId: 'com.mykynk.pati.dev.Widget', procPath: '/var/containers/Bundle/Application/X/Dev.app/PlugIns/Widget.appex/Widget' })).toBeUndefined();
    // A flavor app (com.x.app.dev): its own report, with or without a procPath.
    expect(t.reportApp({ bundleId: 'com.mykynk.pati.dev', procPath: '/var/containers/Bundle/Application/X/Runner.app/Runner' })).toBeUndefined();
    expect(t.reportApp({ bundleId: 'com.mykynk.pati.dev' })).toBeUndefined();
    // An App Clip is an app, not an extension.
    expect(t.reportApp({ bundleId: 'com.mykynk.pati.Clip', procPath: `${inPati}/AppClips/Clip.app/Clip` })).toBeUndefined();
  });

  it("a flavor's report without a procPath is its own row, not «Pati … crashed»", async () => {
    const t = await tracker();
    const text = fixture('ios-swift-crash.ips').replaceAll('com.mykynk.pati', 'com.mykynk.pati.dev');
    const nl = text.indexOf('\n');
    const body = JSON.parse(text.slice(nl + 1)) as Record<string, unknown>;
    delete body.procPath;
    const r = parseIps(`${text.slice(0, nl)}\n${JSON.stringify(body)}`)!;
    expect(r.procPath).toBeUndefined();
    const host = t.reportApp(r);
    expect(host).toBeUndefined();
    const e = crashReportEntry(r, { watchStart: 0, ...(host ? { hostBundleId: host, appName: 'Pati' } : {}) });
    expect(e.message.startsWith('Runner 2.3.0 (57) crashed:')).toBe(true);
    expect(e.data).toMatchObject({ bundleId: 'com.mykynk.pati.dev' });
    expect(e.data).not.toHaveProperty('extensionBundleId');
  });
});

/* ───────────── 5 · whenListed (first-listing wait) ───────────── */

describe('IosAppTracker.whenListed (the simulator crash path waits for the first app listing)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function tracker(list: () => Promise<InstalledIosApp[] | null>, onListed?: (ok: boolean) => void) {
    return new IosAppTracker({
      deviceId: ID,
      hub: createFakeHub(),
      getDeviceApps: () => [],
      source: { listInstalled: list, listRunning: async () => new Map() },
      logger: silentLogger,
      installedEveryMs: 60_000,
      runningEveryMs: 60_000,
      ...(onListed ? { onListed } : {}),
    });
  }

  it('resolves when the first listing finishes, successfully or not, and at once afterwards; onListed tells every outcome', async () => {
    let finish!: (v: InstalledIosApp[] | null) => void;
    const outcomes: boolean[] = [];
    const t = tracker(() => new Promise((r) => (finish = r)), (okay) => outcomes.push(okay));
    let resolved = false;
    void t.whenListed(10_000).then(() => (resolved = true));
    const listing = t.refreshInstalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(resolved).toBe(false);
    finish(null); // failed listing
    await listing;
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    expect(t.listingFinished).toBe(true);
    expect(t.knowsApps).toBe(false);
    let again = false;
    void t.whenListed(10_000).then(() => (again = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe(true);
    const second = t.refreshInstalled();
    finish([]);
    await second;
    expect(outcomes).toEqual([false, true]);
  });

  it('gives up after its timeout, and resolves when the tracker stops', async () => {
    const t = tracker(() => new Promise(() => {}));
    void t.refreshInstalled();
    let timedOut = false;
    void t.whenListed(10_000).then(() => (timedOut = true));
    await vi.advanceTimersByTimeAsync(9999);
    expect(timedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut).toBe(true);
    let stopped = false;
    void t.whenListed(60_000).then(() => (stopped = true));
    await t.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
  });
});

/* ───────────── driver tests (fake usbmuxd, fake idevicesyslog) ───────────── */

/**
 * idevicesyslog stand-in: counts spawns, prints "[connected:…]" at once, prints and deletes emit.txt, prints
 * a record every 20 ms while `flow` exists, exits when `quit` appears.
 */
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
let n = 0;
setInterval(() => {
  if (fs.existsSync(dir + '/quit')) { fs.rmSync(dir + '/quit'); process.exit(1); }
  if (fs.existsSync(dir + '/emit.txt')) {
    const text = fs.readFileSync(dir + '/emit.txt', 'utf8');
    fs.rmSync(dir + '/emit.txt');
    process.stdout.write(text + '\\n');
  }
  if (fs.existsSync(dir + '/flow')) process.stdout.write('Nov  2 23:01:01 kernel(AppleSPMIPMU)[0] <Notice>: tick ' + (n++) + '\\n');
}, 20);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe('IosDeviceDriver · round-3 verification', () => {
  let mux: FakeUsbmuxd;
  let dir: string;
  let ctx: FakeCtx;
  let driver: IosDeviceDriver | undefined;

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    dir = tmp();
    ctx = createCtx({ settings: { idevicesyslogPath: writeSyslog(dir) } });
    for (let id = 5; id < 40; id++) mux.onPort(id, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
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
  const flow = (on: boolean) => (on ? fs.writeFileSync(path.join(dir, 'flow'), '') : fs.rmSync(path.join(dir, 'flow'), { force: true }));
  const spawns = () => (fs.existsSync(path.join(dir, 'spawns.txt')) ? fs.readFileSync(path.join(dir, 'spawns.txt'), 'utf8').trim().split('\n').length : 0);
  const system = (code: string) => ctx.hub.system.filter((s) => s.deviceId === ID && s.input.code === code);
  const logs = () => ctx.hub.devices.get(ID)?.logs;
  const start = async (opts: ConstructorParameters<typeof IosDeviceDriver>[0]) => {
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, ...opts });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => logs()?.status === 'streaming');
  };

  /* 1 */
  it('apps scope: a freshly installed app keeps its lines (extension too) before any listing saw it; the relist follows at once', async () => {
    const state = { lists: false, runs: false };
    const fake = phone(state);
    // Apps every 5 min (default), processes every minute: only the early listing can make Cüzdan known soon.
    await start({ devicectl: fake.run, timing: { processesEveryMs: 60_000, crashesEveryMs: 60_000, crashStartDelayMs: 60_000 } });
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)?.running);
    await sleep(100);
    expect(fake.processListings()).toBe(1);
    state.runs = true;
    state.lists = true;
    emit([
      'Nov  2 23:01:00 Cuzdan(Foundation)[20001] <Notice>: Cüzdan: ödeme ekranı açıldı',
      'Nov  2 23:01:00 CuzdanNotificationService(UserNotifications)[20002] <Notice>: bildirim içeriği hazırlandı',
      'Nov  2 23:01:00 FitnessWidget(WidgetKit)[14799] <Notice>: timeline reloaded',
      'Nov  2 23:01:00 locationd[88] <Notice>: os_transaction created',
      'Nov  2 23:01:01 Runner(Flutter)[14812] <Notice>: flutter: Sepet açıldı',
    ]);
    await waitFor(() => deviceLines().some((l) => l.entry.process === 'Runner'));
    await sleep(150);
    expect(deviceLines().map((l) => l.entry.process)).toEqual(['Cuzdan', 'CuzdanNotificationService', 'Runner']);
    // One process listing right away, then the relist (not 5 minutes later).
    const app = await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.cuzdan`), 4000);
    expect(app).toMatchObject({ name: 'Cüzdan', version: '0.9.0' });
    expect(fake.appListings()).toBe(2);
    expect(fake.processListings()).toBeLessThanOrEqual(3);
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.cuzdan`)?.pids.length === 2, 4000);
  });

  /* 2 */
  it('scope not applied (no devicectl): the streaming DeviceInfo.logs says so until the scope is all; one line', async () => {
    await start({ useDevicectl: false });
    expect(logs()).toMatchObject({
      status: 'streaming',
      via: 'idevicesyslog',
      code: 'logs.scopeNotApplied',
      detail: 'All log lines are shown: telling app lines from system lines needs Xcode 15 or newer (devicectl)',
    });
    expect(system('logs.scopeNotApplied')).toHaveLength(1);
    ctx.setSettings({ iosDeviceLogScope: 'all' });
    await waitFor(() => !logs()?.code);
    expect(logs()).toEqual({ status: 'streaming', via: 'idevicesyslog' });
    ctx.setSettings({ iosDeviceLogScope: 'apps' });
    await waitFor(() => logs()?.code === 'logs.scopeNotApplied');
    expect(system('logs.scopeNotApplied')).toHaveLength(1);
    expect(system('logs.scopeApplied')).toHaveLength(0);
    // A stream restart keeps it.
    fs.writeFileSync(path.join(dir, 'quit'), '');
    await waitFor(() => logs()?.status === 'error');
    await waitFor(() => logs()?.status === 'streaming', 5000);
    expect(logs()?.code).toBe('logs.scopeNotApplied');
  });

  /* 2 + 5 (device-side listing hook) */
  it('a slow first app listing that fails after the stream started: the code and the line follow it; a later good listing clears both', async () => {
    let listOk = false;
    const base = phone({ lists: false, runs: false });
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'apps') {
        await sleep(400); // devicectl is slow on a busy phone
        if (!listOk) return failed('The developer disk image could not be mounted');
      }
      return base.run(args);
    };
    await start({ devicectl: run, timing: { appsEveryMs: 600, processesEveryMs: 60_000, crashesEveryMs: 60_000, crashStartDelayMs: 60_000 } });
    // Streaming before the listing finished: nothing is said yet (it is not known to fail).
    expect(logs()?.code).toBeUndefined();
    expect(system('logs.scopeNotApplied')).toHaveLength(0);
    await waitFor(() => system('logs.scopeNotApplied').length === 1, 4000);
    expect(system('logs.scopeNotApplied')[0]!.input.params).toMatchObject({ reason: 'appListFailed', via: 'idevicesyslog', device: 'Test iPhone’u' });
    expect(logs()).toMatchObject({ status: 'streaming', code: 'logs.scopeNotApplied' });
    emit(['Nov  2 23:01:00 locationd[88] <Notice>: shown while the apps are unknown']);
    await waitFor(() => deviceLines().some((l) => l.entry.process === 'locationd'));
    listOk = true;
    // The retry comes at the tracker's next step (≤ 5 s).
    await waitFor(() => system('logs.scopeApplied').length === 1, 10_000);
    expect(system('logs.scopeApplied')[0]!.input).toMatchObject({ level: 'info', params: { via: 'idevicesyslog', device: 'Test iPhone’u' } });
    expect(logs()).toEqual({ status: 'streaming', via: 'idevicesyslog' });
    emit(['Nov  2 23:01:02 locationd[88] <Notice>: left out now', 'Nov  2 23:01:02 Runner(Flutter)[14812] <Notice>: flutter: kept']);
    await waitFor(() => deviceLines().some((l) => l.entry.message.includes('kept')), 4000);
    await sleep(100);
    expect(deviceLines().some((l) => l.entry.message.includes('left out now'))).toBe(false);
    expect(system('logs.scopeNotApplied')).toHaveLength(1);
  });

  /* 3 */
  it('every USB drop is its own lost / back pair with its length, also while the stream is restarting', async () => {
    await start({ useDevicectl: false, timing: { detachGraceMs: 2000, unstableDetachGraceMs: 4000 } });
    const lost = () => system('logs.connectionLost');
    const back = () => system('logs.connectionRestored');
    // Drop 1 while streaming.
    mux.detach(5);
    await waitFor(() => lost().length === 1);
    await sleep(150);
    mux.attach({ deviceId: 6, udid: UDID });
    await waitFor(() => back().length === 1);
    // Drop 2 while idevicesyslog is being restarted (logs 'error', not 'streaming').
    fs.writeFileSync(path.join(dir, 'quit'), '');
    await waitFor(() => logs()?.status === 'error' && logs()?.code === 'logs.processExited');
    mux.detach(6);
    await waitFor(() => lost().length === 2);
    await sleep(300);
    mux.attach({ deviceId: 7, udid: UDID });
    await waitFor(() => back().length === 2);
    // Drop 3, a minute later in real life: still said.
    await waitFor(() => logs()?.status === 'streaming', 5000);
    mux.detach(7);
    await waitFor(() => lost().length === 3);
    await sleep(100);
    mux.attach({ deviceId: 8, udid: UDID });
    await waitFor(() => back().length === 3);
    expect(lost().map((s) => s.input.params?.connection)).toEqual(['usb', 'usb', 'usb']);
    expect(lost().map((s) => s.input.params?.graceSeconds)).toEqual([2, 4, 4]);
    const seconds = back().map((s) => Number(s.input.params?.seconds));
    expect(seconds[0]).toBeGreaterThanOrEqual(0.1);
    expect(seconds[1]).toBeGreaterThanOrEqual(0.3);
    expect(seconds[1]).toBeGreaterThan(seconds[0]!);
    expect(back().every((s) => s.input.level === 'info' && /^the USB connection was gone for \d+\.\d s/.test(String(s.input.params?.detail)))).toBe(true);
    // Drops are not stream errors (the stream error line is the process exit's alone).
    expect(system('logs.streamError')).toHaveLength(1);
    expect(ctx.hub.disconnected).toEqual([]);
  });

  /* 5 (resume restarts idevicesyslog; a running one is not started twice) */
  it('resume(): idevicesyslog that ended during the drop starts again; one that kept running is not doubled', async () => {
    await start({ useDevicectl: false, timing: { detachGraceMs: 3000 } });
    mux.detach(5);
    await waitFor(() => system('logs.connectionLost').length === 1);
    await sleep(100);
    mux.attach({ deviceId: 6, udid: UDID });
    await waitFor(() => system('logs.connectionRestored').length === 1);
    await sleep(300);
    expect(spawns()).toBe(1);
    mux.detach(6);
    await waitFor(() => system('logs.connectionLost').length === 2);
    fs.writeFileSync(path.join(dir, 'quit'), '');
    await waitFor(() => liveChildCount() === 0, 3000);
    await sleep(200);
    expect(spawns()).toBe(1);
    mux.attach({ deviceId: 7, udid: UDID });
    await waitFor(() => spawns() === 2, 3000);
    emit(['Nov  2 23:01:01 Runner(Flutter)[14812] <Notice>: flutter: geri geldi']);
    await waitFor(() => deviceLines().some((l) => l.entry.message.includes('geri geldi')), 3000);
    expect(logs()?.status).toBe('streaming');
  });

  /* 6 */
  it('stall watchdog: silent idevicesyslog → logs.streamStalled, restarts with a backoff, streaming again when lines flow', async () => {
    flow(true);
    await start({ useDevicectl: false, timing: { stallMs: 500, stallRestartDelaysMs: [150, 400] } });
    // Lines keep coming: no stall however long.
    await sleep(1500);
    expect(system('logs.streamStalled')).toHaveLength(0);
    expect(spawns()).toBe(1);

    // The relay chokes: idevicesyslog stays alive and prints nothing.
    flow(false);
    await waitFor(() => logs()?.code === 'logs.streamStalled', 4000);
    expect(logs()?.status).toBe('error');
    expect(logs()?.detail).toMatch(/^no log line from the device for \d+ s although it is connected .*restarting idevicesyslog in 0\.2 s \(attempt 1\); several idevicesyslog clients on one iPhone .* can choke its syslog relay, so restarts slow down/);
    expect(system('logs.streamStalled')).toHaveLength(1);
    expect(system('logs.streamStalled')[0]!.input).toMatchObject({ level: 'warn', params: { via: 'idevicesyslog' } });
    expect(system('logs.streamStalled')[0]!.input.params?.seconds).toBeTypeOf('number');
    expect(String(system('logs.streamStalled')[0]!.input.params?.detail)).toContain('syslog relay');
    // Restarted after the first delay; its "[connected:…]" alone is no recovery.
    await waitFor(() => spawns() === 2, 3000);
    await sleep(200);
    expect(logs()?.status).toBe('error');
    // Still silent: restarted again after the next delay, without another stalled line.
    await waitFor(() => /attempt 2/.test(String(logs()?.detail)), 4000);
    expect(logs()?.detail).toContain('restarting idevicesyslog in 0.4 s (attempt 2)');
    await waitFor(() => spawns() === 3, 4000);
    expect(system('logs.streamStalled')).toHaveLength(1);

    // Lines flow again: streaming, with a "resumed" line.
    flow(true);
    await waitFor(() => logs()?.status === 'streaming', 4000);
    expect(logs()).toEqual({ status: 'streaming', via: 'idevicesyslog', code: 'logs.scopeNotApplied', detail: expect.any(String) });
    const resumed = system('logs.streamStarted').at(-1)!;
    expect(resumed.input.message).toMatch(/^Device log stream resumed \(idevicesyslog; lines flow again after \d+ s without any; lines from that time are missing\)$/);
    expect(resumed.input.params).toMatchObject({ via: 'idevicesyslog', detail: expect.stringContaining('lines flow again') });
    expect(system('logs.streamStarted')).toHaveLength(2);
    expect(system('logs.streamError')).toHaveLength(0);
    await sleep(800);
    expect(spawns()).toBe(3);
    expect(ctx.hub.disconnected).toEqual([]);
  });

  it('a log restart overlapping a stop starts no idevicesyslog that nobody would stop', async () => {
    flow(true);
    await start({ useDevicectl: false });
    const before = spawns();
    // The restart is waiting for the old idevicesyslog to exit when the driver stops (phone unplugged, Dürbün quits).
    const restart = driver!.runAction(ID, 'logs-restart', {});
    const stopping = driver!.stop();
    driver = undefined;
    await Promise.all([restart, stopping]);
    await sleep(400);
    expect(spawns()).toBe(before);
    await waitFor(() => liveChildCount() === 0, 3000);
  });

  /* 6 */
  it('stall watchdog: a device away within the grace is no stall; neither is the time a user restart takes', async () => {
    flow(true);
    await start({ useDevicectl: false, timing: { stallMs: 400, stallRestartDelaysMs: [100], detachGraceMs: 2000 } });
    flow(false);
    mux.detach(5);
    await sleep(1200);
    expect(system('logs.streamStalled')).toHaveLength(0);
    flow(true);
    mux.attach({ deviceId: 6, udid: UDID });
    await waitFor(() => system('logs.connectionRestored').length === 1);
    await sleep(800);
    expect(system('logs.streamStalled')).toHaveLength(0);
    expect(spawns()).toBe(1);

    // A stall, then the user restarts the stream: the episode ends there (a new silence is a new episode).
    flow(false);
    await waitFor(() => logs()?.code === 'logs.streamStalled', 4000);
    flow(true);
    expect(await driver!.runAction(ID, 'logs-restart', {})).toMatchObject({ ok: true });
    await waitFor(() => logs()?.status === 'streaming', 4000);
    expect(system('logs.streamStopped')).toHaveLength(1);
    await sleep(800);
    expect(system('logs.streamStalled')).toHaveLength(1);
    expect(logs()?.status).toBe('streaming');
  });
});
