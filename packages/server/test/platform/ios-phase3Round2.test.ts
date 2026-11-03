/**
 * Phase-3 review, round 2 (iOS):
 *   - crash report rows of previous launches keep the old pid in data only (the hub maps pids to live sessions);
 *   - `iosDeviceLogScope` for physical iPhones, on a capture in the real idevicesyslog layout of iOS 27.2
 *     (no host name, ~1,350 lines/s on a busy phone) with the real devicectl app / process captures;
 *   - a USB connection that drops and comes back within seconds keeps the device session (every drop and
 *     return is its own 'logs.connectionLost' / 'logs.connectionRestored' line);
 *   - app extensions' crash reports belong to their host app, on devices and simulators alike.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveChildCount } from '../../src/platform/exec';
import { IosAppTracker, type AppSource, type InstalledIosApp } from '../../src/platform/ios/appTracker';
import { IosCrashIndex } from '../../src/platform/ios/crashDedupe';
import { crashReportEntry, parseIps, type IpsReport } from '../../src/platform/ios/crashReport';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { devicectlAppSource, processNameFromUrl } from '../../src/platform/ios/deviceApps';
import { crashCopyDir, DeviceCrashWatcher } from '../../src/platform/ios/deviceCrashes';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import {
  IosDeviceLogFilter,
  iosDeviceLogScope,
  isAppScopedLine,
  mentionsThirdPartyApp,
  type ThirdPartyApps,
} from '../../src/platform/ios/deviceLogScope';
import { SimCrashWatcher } from '../../src/platform/ios/simCrashes';
import { SimulatorSession } from '../../src/platform/ios/simDriver';
import { parseSyslogLine, SyslogLineParser } from '../../src/platform/ios/syslog';
import type { DeviceLogInput } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { appInput, device, makeHub } from '../hub/helpers';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { createCtx, createFakeHub, fixture, waitFor, type FakeCtx, type FakeHub } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const ID = `ios:${UDID}`;
const json = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>;
const ok = (j: Record<string, unknown>): DevicectlResult => ({ ok: true, json: j, stdout: '', stderr: '' });
const failed = (error: string): DevicectlResult => ({ ok: false, error, stdout: '', stderr: '' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-r2-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * The real process capture was trimmed to 21 processes; CommCenter (in the syslog capture) runs all the time
 * on a phone, so a full listing has it.
 */
function realProcesses(): Record<string, unknown> {
  const j = json('ios-devicectl-real-processes.json') as { result: { runningProcesses: unknown[] } };
  j.result.runningProcesses.push({ executable: 'file:///System/Library/Frameworks/CoreTelephony.framework/Support/CommCenter', processIdentifier: 99 });
  return j;
}

/** devicectl answering with the real iPhone captures (apps, processes); no crash reports. */
async function realDevicectl(args: string[]): Promise<DevicectlResult> {
  if (args[0] === 'list') return ok(json('ios-devicectl-real-list-devices.json'));
  if (args[2] === 'apps') return ok(json(args.includes('--include-all-apps') ? 'ios-devicectl-real-apps-all.json' : 'ios-devicectl-real-apps-developer.json'));
  if (args[2] === 'processes') return ok(realProcesses());
  if (args[2] === 'files') return ok({ result: { files: [] } });
  return failed(`unexpected ${args.join(' ')}`);
}

/** The device's app tracker after one app listing and one process listing of the real captures. */
async function listedTracker(hub: FakeHub = createFakeHub()): Promise<IosAppTracker> {
  const tracker = new IosAppTracker({
    deviceId: ID,
    hub,
    getDeviceApps: () => [...hub.deviceApps.values()],
    source: devicectlAppSource(UDID, realDevicectl),
    logger: silentLogger,
    installedEveryMs: 60_000,
    runningEveryMs: 60_000,
  });
  expect(await tracker.refreshInstalled()).toBe(true);
  expect(await tracker.refreshRunning()).toBe(true);
  return tracker;
}

/** The capture parsed the way the device session does it. */
function parsedCapture(): DeviceLogInput[] {
  const out: DeviceLogInput[] = [];
  const parser = new SyslogLineParser((e) => out.push(e));
  parser.setDeviceName('Test iPhone’u');
  for (const line of fixture('ios-syslog-hostless.txt').split('\n')) parser.pushLine(line);
  parser.flush();
  return out;
}

const label = (e: DeviceLogInput) => `${e.process}[${e.pid}]`;

/** An app extension's report made from a real one: bundle id, names and path of the .appex. */
function asExtension(text: string, ext: { bundleId: string; name: string; pid?: number }): string {
  const nl = text.indexOf('\n');
  const header = JSON.parse(text.slice(0, nl)) as Record<string, unknown>;
  const body = JSON.parse(text.slice(nl + 1)) as Record<string, any>;
  header.bundleID = ext.bundleId;
  header.app_name = ext.name;
  header.name = ext.name;
  body.procName = ext.name;
  body.procPath = `${String(body.procPath).replace(/\/[^/]+$/, '')}/PlugIns/${ext.name}.appex/${ext.name}`;
  body.bundleInfo = { ...body.bundleInfo, CFBundleIdentifier: ext.bundleId };
  if (ext.pid !== undefined) body.pid = ext.pid;
  return `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}`;
}

describe('crash report rows of previous launches (audit-seams #7)', () => {
  it('keep the old pid in data only, so the hub never attaches them to a live session that reuses it', () => {
    const hub = makeHub();
    try {
      hub.upsertDevice(device(ID, { platform: 'ios', name: 'Test iPhone’u', logs: { status: 'streaming', via: 'idevicesyslog' } }));
      const r = parseIps(fixture('ios-swift-crash.ips'))!;
      expect(r.pid).toBe(1234);
      // A live SDK session of another launch now runs with the crashed process' old pid.
      const live = hub.registerApp(appInput(ID, { app: { name: 'Pati', id: 'com.mykynk.pati', version: '2.4.1', pid: 1234 }, transport: 'usbmux' }));
      const before = hub.getApp(live.id)!.stats;
      hub.pushDeviceLogs(ID, [crashReportEntry(r, { watchStart: r.ts! + 3600_000 })]);
      const row = hub.getLogs().find((e) => e.origin === 'crash-report')!;
      expect(row.pid).toBeUndefined();
      expect(row.appId).toBeUndefined();
      expect(row.data).toMatchObject({ pid: 1234, previousLaunch: true, bundleId: 'com.mykynk.pati' });
      expect(hub.getApp(live.id)!.stats).toEqual(before);
      // A crash while Dürbün watched keeps its pid: it is the crashed process' own session.
      hub.pushDeviceLogs(ID, [crashReportEntry(r, { watchStart: r.ts! - 1000 })]);
      const current = hub.getLogs().filter((e) => e.origin === 'crash-report')[1]!;
      expect(current).toMatchObject({ pid: 1234, appId: live.id });
    } finally {
      hub.dispose();
    }
  });
});

describe('idevicesyslog without a host name (iOS 27.2, Flutter 3.38 idevicesyslog)', () => {
  it('keeps process names with spaces whole once a kernel line shows the layout', () => {
    const line = 'Nov  2 23:00:19 Microsoft Authenticator(CFNetwork)[14939] <Error>: Task finished';
    // Unknown layout: the first word could be a host name (older idevicesyslog builds print one).
    const unknown = parseSyslogLine(line, []);
    expect(unknown.type === 'entry' && unknown.entry.process).toBe('Authenticator');
    const kernel = parseSyslogLine('Nov  2 23:00:18 kernel(AppleSPMIPMU)[0] <Notice>: RTC upcountTicks=2e88ce7e2fe', []);
    expect(kernel).toMatchObject({ type: 'entry', hostless: true, entry: { process: 'kernel', tag: 'AppleSPMIPMU', pid: 0 } });
    const known = parseSyslogLine(line, [], Date.now(), true);
    expect(known).toMatchObject({ type: 'entry', entry: { process: 'Microsoft Authenticator', tag: 'CFNetwork', pid: 14939, level: 'error' } });
    // A host name before the kernel says the opposite.
    expect(parseSyslogLine('Nov  2 11:43:01 iPhone kernel[0] <Notice>: x', [])).toMatchObject({ type: 'entry', hostless: false, entry: { process: 'kernel' } });
    expect(parseSyslogLine('Nov  2 11:43:01 iPhone SpringBoard(FrontBoard)[57] <Notice>: y', [], Date.now(), false)).toMatchObject({
      entry: { process: 'SpringBoard' },
    });
  });

  it('the line parser learns it from the stream', () => {
    const names = parsedCapture().map((e) => e.process);
    expect(names).toContain('Microsoft Authenticator');
    expect(names).not.toContain('Authenticator');
    expect(names).toContain('spotlightknowledged.updater');
  });
});

describe('iosDeviceLogScope (audit-ux #2): real idevicesyslog layout, real devicectl captures', () => {
  it('apps: keeps third-party app processes (extensions and spaces in names too) and crash-relevant system lines', async () => {
    const tracker = await listedTracker();
    const entries = parsedCapture();
    expect(entries).toHaveLength(27);
    const filter = new IosDeviceLogFilter(() => tracker, () => 'apps');
    const kept = entries.filter((e) => filter.admit(e));
    expect(kept.map(label)).toEqual([
      'Runner[14812]', // Pati (pid from the process list)
      'Runner[15240]', // a "Runner" process the process list has not seen yet (name of a third-party executable)
      'MahalleNotificationService[14807]', // Mahalle's notification service extension
      'Microsoft Authenticator[14939]',
      'kernel[0]', // memorystatus: killing_specific_process pid 14889 [Mahalle]
      'runningboardd[36]', // Mahalle: termination reported by launchd
      'SpringBoard[99549]', // Mahalle: Process exited … SIGKILL
      'runningboardd[36]', // Pati: 0x8BADF00D scene-update watchdog transgression
      'ReportCrash[15301]', // Formulating fatal 309 report for corpse[14807] MahalleNotificationService
      'osanalyticshelper[15302]', // Saved … MahalleNotificationService-….ips
      'Runner[14871]', // *** Terminating app due to uncaught exception (+ its continuation lines)
    ]);
    expect(kept[4]!.message).toContain('[Mahalle]');
    expect(kept[7]!.message).toContain('0x8BADF00D');
    expect(kept[10]!.message).toContain('First throw call stack:');
    expect(kept[10]).toMatchObject({ kind: 'crash', level: 'fatal' });
    // Dropped: daemons, Apple's own (even removable) apps and their widgets, a system process' jetsam kill,
    // a system crash report, assertion / jetsam-priority / state chatter about apps, a sandbox note.
    expect(filter).toMatchObject({ kept: 11, dropped: 16 });
    const dropped = entries.filter((e) => !kept.includes(e));
    expect(dropped.map((e) => e.process)).toEqual(
      expect.arrayContaining(['spotlightknowledged.updater', 'bluetoothd', 'FitnessWidget', 'backboardd', 'locationd', 'com.apple.WebKit.WebContent', 'CommCenter']),
    );
    expect(dropped.some((e) => e.message.includes('Set jetsam priority'))).toBe(true);
    expect(dropped.some((e) => e.message.includes('[mediaserverd]'))).toBe(true);
    expect(dropped.some((e) => e.message.includes('corpse[512] gpsd'))).toBe(true);
    expect(dropped.some((e) => e.message.includes('Sandbox: Runner(14812)'))).toBe(true);
  });

  it("all keeps every line; unknown apps (first listing pending, no devicectl) hide nothing; absent setting = 'apps'", async () => {
    const tracker = await listedTracker();
    const entries = parsedCapture();
    const all = new IosDeviceLogFilter(() => tracker, () => 'all');
    expect(entries.filter((e) => all.admit(e))).toHaveLength(27);
    const pending = new IosAppTracker({
      deviceId: ID,
      hub: createFakeHub(),
      getDeviceApps: () => [],
      source: { listInstalled: async () => null, listRunning: async () => null },
      logger: silentLogger,
      installedEveryMs: 60_000,
      runningEveryMs: 60_000,
    });
    expect(entries.filter((e) => new IosDeviceLogFilter(() => pending, () => 'apps').admit(e))).toHaveLength(27);
    expect(entries.filter((e) => new IosDeviceLogFilter(() => undefined, () => 'apps').admit(e))).toHaveLength(27);
    expect(iosDeviceLogScope({})).toBe('apps');
    expect(iosDeviceLogScope({ iosDeviceLogScope: 'all' })).toBe('all');
    expect(iosDeviceLogScope(undefined)).toBe('apps');
  });

  it('a header-less line follows the record before it', () => {
    const apps: ThirdPartyApps = { knowsApps: true, isAppPid: (p) => p === 7, isAppProcess: () => false, hostApp: () => undefined };
    const f = new IosDeviceLogFilter(() => apps, () => 'apps');
    const orphan: DeviceLogInput = { ts: 1, origin: 'idevicesyslog', level: 'info', tag: 'syslog', message: 'late continuation' };
    expect(f.admit({ ...orphan, pid: 7, process: 'App' })).toBe(true);
    expect(f.admit(orphan)).toBe(true);
    expect(f.admit({ ...orphan, pid: 9, process: 'locationd' })).toBe(false);
    expect(f.admit(orphan)).toBe(false);
  });

  it('names: bundle ids of extensions, pids and process names in the usual spots; Apple ids never count', async () => {
    const tracker = await listedTracker();
    expect(processNameFromUrl('file:///private/var/containers/Bundle/Application/X/Runner.app/PlugIns/My%20Widget.appex/My%20Widget')).toBe('My Widget');
    expect(tracker.isAppProcess('MahalleNotificationService')).toBe(true); // learned from the process list
    expect(tracker.isAppProcess('FitnessWidget')).toBe(false); // inside Apple's Fitness.app
    expect(tracker.isAppPid(14807)).toBe(true);
    expect(mentionsThirdPartyApp('Exit for app<com.mykynk.mahalle.MahalleNotificationService(UUID)>', tracker)).toBe(true);
    expect(mentionsThirdPartyApp('EXC_RESOURCE -> Microsoft Authenticator[777] exceeded mem limit: ActiveHard 2098 MB (fatal)', tracker)).toBe(true);
    expect(mentionsThirdPartyApp('process Runner(31) exited', tracker)).toBe(true);
    expect(mentionsThirdPartyApp('[app<com.apple.Fitness>:14799] exited', tracker)).toBe(false);
    expect(mentionsThirdPartyApp('killing pid 812 [mediaserverd] (14 MB)', tracker)).toBe(false);
    const line = (process: string, message: string): DeviceLogInput => ({ ts: 1, level: 'info', tag: process, process, pid: 36, message });
    // Wording decides for the chatty processes, not for the crash reporters.
    expect(isAppScopedLine(line('runningboardd', '[app<com.mykynk.kumbara>:14871] Resuming task.'), tracker)).toBe(false);
    expect(isAppScopedLine(line('runningboardd', '[app<com.mykynk.kumbara>:14871] Process exited: <RBSProcessExitContext| voluntary>.'), tracker)).toBe(true);
    expect(isAppScopedLine(line('spindump', 'Saved hang report for Runner [14871]'), tracker)).toBe(true);
    expect(isAppScopedLine(line('geod', '[app<com.mykynk.kumbara>:14871] crashed'), tracker)).toBe(false);
  });
});

/** idevicesyslog stand-in: "[connected:…]" at once, then the capture each time a go<N> file appears. */
function writeCaptureSyslog(dir: string): string {
  const file = path.join(dir, 'idevicesyslog');
  const capture = fixture('ios-syslog-hostless.txt').split('\n').slice(1).join('\n');
  fs.writeFileSync(path.join(dir, 'capture.txt'), capture);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(dir)};
if (process.argv.includes('--version')) { console.log('idevicesyslog 1.3.0-fake'); process.exit(0); }
fs.appendFileSync(dir + '/spawns.txt', 'spawn\\n');
const udid = process.argv[process.argv.indexOf('-u') + 1];
process.stdout.write('[connected:' + udid + ']\\n');
const capture = fs.readFileSync(dir + '/capture.txt', 'utf8');
let round = 0;
setInterval(() => {
  if (fs.existsSync(dir + '/go' + (round + 1))) {
    round += 1;
    process.stdout.write(capture + '\\n');
  }
}, 20);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe('IosDeviceDriver · log scope and USB flaps', () => {
  let mux: FakeUsbmuxd;
  let dir: string;
  let ctx: FakeCtx;
  let driver: IosDeviceDriver | undefined;

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    dir = tmp();
    ctx = createCtx({ settings: { idevicesyslogPath: writeCaptureSyslog(dir) } });
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
  });

  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
    await mux.close();
    await waitFor(() => liveChildCount() === 0, 5000);
  });

  const deviceLines = () => ctx.hub.logs.filter((l) => l.deviceId === ID && l.entry.origin === 'idevicesyslog');
  const go = (n: number) => fs.writeFileSync(path.join(dir, `go${n}`), '');

  it("drops system lines by default and follows a settings change without restarting idevicesyslog", async () => {
    driver = new IosDeviceDriver({
      socketPath: mux.socketPath,
      devicectl: realDevicectl,
      timing: { appsEveryMs: 60_000, processesEveryMs: 60_000, crashesEveryMs: 60_000, crashStartDelayMs: 60_000 },
    });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    // The process list is in: the device's apps are known.
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)?.running);
    go(1);
    await waitFor(() => deviceLines().some((l) => l.entry.message.includes('Terminating app due to uncaught exception')));
    await sleep(150);
    expect(deviceLines()).toHaveLength(11);
    expect(deviceLines().some((l) => l.entry.process === 'spotlightknowledged.updater')).toBe(false);

    ctx.setSettings({ iosDeviceLogScope: 'all' });
    go(2);
    await waitFor(() => deviceLines().length >= 11 + 27);
    ctx.setSettings({ iosDeviceLogScope: 'apps' });
    go(3);
    await waitFor(() => deviceLines().length >= 11 + 27 + 11);
    await sleep(150);
    expect(deviceLines()).toHaveLength(11 + 27 + 11);
    expect(fs.readFileSync(path.join(dir, 'spawns.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(ctx.hub.system.filter((s) => s.input.code === 'logs.streamStopped')).toHaveLength(0);
  });

  it('a USB drop that comes back within the grace keeps the session; a real unplug ends it', async () => {
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false, timing: { detachGraceMs: 400, unstableDetachGraceMs: 1500 } });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    const upserts = ctx.hub.upserts.length;
    const notices = () => ctx.hub.system.filter((s) => s.deviceId === ID && s.input.code === 'logs.connectionLost');
    const resumed = () => ctx.hub.system.filter((s) => s.deviceId === ID && s.input.code === 'logs.connectionRestored');

    mux.detach(5);
    await waitFor(() => notices().length === 1);
    expect(notices()[0]!.input).toMatchObject({
      level: 'warn',
      params: {
        via: 'idevicesyslog',
        connection: 'usb',
        graceSeconds: 0.4,
        detail: 'the USB connection dropped; log lines are missing until the device is back; it is shown disconnected if it is not back within 0.4 s',
      },
    });
    await sleep(120);
    mux.attach({ deviceId: 6, udid: UDID });
    await waitFor(() => resumed().length === 1);
    expect(resumed()[0]!.input).toMatchObject({ level: 'info', params: { via: 'idevicesyslog', connection: 'usb' } });
    expect(String(resumed()[0]!.input.params?.detail)).toMatch(/^the USB connection was gone for 0\.\d s; log lines from that moment are missing$/);
    expect(resumed()[0]!.input.params?.seconds).toBeGreaterThanOrEqual(0.1);
    // The stream itself never stopped: no stream error / stream started lines for a drop.
    expect(ctx.hub.system.filter((s) => s.input.code === 'logs.streamError')).toEqual([]);
    expect(ctx.hub.system.filter((s) => s.input.code === 'logs.streamStarted')).toHaveLength(1);
    await sleep(600); // past the normal grace
    expect(ctx.hub.disconnected).toEqual([]);
    expect(ctx.hub.upserts.length).toBe(upserts);
    expect(ctx.hub.devices.get(ID)?.state).toBe('online');

    // It keeps dropping: every gap is said, and the session is held longer (the second drop's grace).
    mux.detach(6);
    await sleep(120);
    mux.attach({ deviceId: 7, udid: UDID });
    await waitFor(() => resumed().length === 2);
    expect(notices()).toHaveLength(2);
    expect(notices()[1]!.input.params?.graceSeconds).toBe(1.5);
    const unpluggedAt = Date.now();
    mux.detach(7);
    await sleep(800);
    expect(ctx.hub.disconnected).toEqual([]);
    await waitFor(() => ctx.hub.disconnected.find((d) => d.id === ID), 4000);
    expect(Date.now() - unpluggedAt).toBeGreaterThanOrEqual(1400);
    expect(ctx.hub.disconnected).toHaveLength(1);
    expect(notices()).toHaveLength(3);
    expect(resumed()).toHaveLength(2);
    // Only now is idevicesyslog stopped (it was started once).
    expect(fs.readFileSync(path.join(dir, 'spawns.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('gaps longer than the grace: after one disconnect / connect, the next drop is held longer', async () => {
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false, timing: { detachGraceMs: 200, unstableDetachGraceMs: 1500 } });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    mux.detach(5);
    await waitFor(() => ctx.hub.disconnected.length === 1, 3000);
    mux.onPort(6, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
    mux.attach({ deviceId: 6, udid: UDID });
    await waitFor(() => ctx.hub.upserts.filter((u) => u.id === ID).length === 2);
    await waitFor(() => ctx.hub.patches.some((p) => p.id === ID && p.patch.logs?.status === 'streaming') || ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    mux.detach(6);
    await sleep(600); // past the normal grace: the session is still there
    mux.attach({ deviceId: 7, udid: UDID });
    await sleep(300);
    expect(ctx.hub.disconnected).toHaveLength(1);
    expect(ctx.hub.upserts.filter((u) => u.id === ID)).toHaveLength(2);
  });

  it('a Wi-Fi entry coming and going next to USB changes nothing; losing USB with Wi-Fi left is one patch', async () => {
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false, timing: { detachGraceMs: 300 } });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    await sleep(100);
    const connectionPatches = () => ctx.hub.patches.filter((p) => p.id === ID && 'connection' in p.patch);
    for (let i = 0; i < 3; i++) {
      mux.attach({ deviceId: 20 + i, udid: UDID, connectionType: 'Network' });
      await sleep(50);
      mux.detach(20 + i);
      await sleep(50);
    }
    expect(connectionPatches()).toEqual([]);
    mux.attach({ deviceId: 30, udid: UDID, connectionType: 'Network' });
    await sleep(50);
    mux.detach(5);
    await waitFor(() => connectionPatches().length === 1);
    expect(connectionPatches()[0]!.patch.connection).toBe('wifi');
    await sleep(400);
    expect(ctx.hub.disconnected).toEqual([]);
  });

  it('a device that was stable is shown disconnected after the short grace', async () => {
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false, timing: { detachGraceMs: 300, unstableDetachGraceMs: 5000 } });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    const unpluggedAt = Date.now();
    mux.detach(5);
    await waitFor(() => ctx.hub.disconnected.find((d) => d.id === ID), 3000);
    expect(Date.now() - unpluggedAt).toBeLessThan(2000);
    // The drop said at once that lines are missing; no "back" line follows a real unplug (the hub's
    // device.disconnected is the drop's outcome).
    expect(ctx.hub.system.filter((s) => s.input.code === 'logs.connectionLost')).toHaveLength(1);
    expect(ctx.hub.system.filter((s) => s.input.code === 'logs.connectionRestored')).toHaveLength(0);
    expect(ctx.hub.system.filter((s) => s.input.code === 'logs.streamStarted')).toHaveLength(1);
  });
});

describe('app extension crash reports belong to their host app (devices and simulators)', () => {
  const NS = 'com.mykynk.mahalle.MahalleNotificationService';

  it('tracker: host app by bundle id prefix; the crash counts for the host, no orphan extension app', async () => {
    const hub = createFakeHub();
    const tracker = await listedTracker(hub);
    expect(tracker.hostApp(NS)).toBe('com.mykynk.mahalle');
    expect(tracker.hostApp('com.mykynk.mahalle')).toBe('com.mykynk.mahalle');
    expect(tracker.hostApp('com.mykynk.mahallex.Widget')).toBeUndefined();
    expect(tracker.hostApp('com.apple.Fitness.FitnessWidget')).toBeUndefined();
    const r = parseIps(asExtension(fixture('ios-objc-exception.ips'), { bundleId: NS, name: 'MahalleNotificationService', pid: 14807 }))!;
    expect(r).toMatchObject({ bundleId: NS, procName: 'MahalleNotificationService', pid: 14807 });
    tracker.onCrash(r);
    expect(hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)).toMatchObject({ crashReports: 1, name: 'Mahalle' });
    expect([...hub.deviceApps.keys()].filter((k) => k.includes('NotificationService'))).toEqual([]);
    // The crashed extension pid is no longer one of Mahalle's.
    expect(hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)!.pids).not.toContain(14807);
  });

  it('entry: the row is the host app\'s and names the extension', () => {
    const r = parseIps(asExtension(fixture('ios-objc-exception.ips'), { bundleId: NS, name: 'MahalleNotificationService' }))!;
    const e = crashReportEntry(r, { watchStart: 0, appName: 'Mahalle', hostBundleId: 'com.mykynk.mahalle' });
    expect(e.message.startsWith('Mahalle 4.1.0 (412) · MahalleNotificationService crashed: NSInvalidArgumentException')).toBe(true);
    expect(e.data).toMatchObject({ bundleId: 'com.mykynk.mahalle', extensionBundleId: NS, appName: 'MahalleNotificationService' });
    expect(e.process).toBe('MahalleNotificationService');
    // The app's own report is unchanged.
    const own = crashReportEntry(parseIps(fixture('ios-objc-exception.ips'))!, { watchStart: 0, hostBundleId: 'com.mykynk.mahalle' });
    expect(own.message.startsWith('Mahalle 4.1.0 (412) crashed:')).toBe(true);
    expect(own.data).not.toHaveProperty('extensionBundleId');
  });

  it('device crash watcher: a listed crash (bug_type 309) is copied whatever the process name', async () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const entry = (name: string, bugType?: string) => ({
      name,
      relativePath: name,
      metadata: { lastModDate: hourAgo, size: 9000, ...(bugType ? { extendedAttributes: { bug_type: bugType } } : {}) },
      resources: { isDirectory: false },
    });
    const copies: string[] = [];
    const reports: IpsReport[] = [];
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'files') {
        return ok({ result: { files: [entry('Retired/MahalleNotificationService-2026-11-02-230022.ips', '309'), entry('OtherExtension-2026-11-02-230100.ips')] } });
      }
      if (args[1] === 'copy') {
        copies.push(args[args.indexOf('--source') + 1]!);
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, asExtension(fixture('ios-objc-exception.ips'), { bundleId: NS, name: 'MahalleNotificationService' }));
        return ok({ info: { outcome: 'success' } });
      }
      return failed(`unexpected ${args.join(' ')}`);
    };
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: run,
      destDir: crashCopyDir(tmp(), UDID),
      logger: silentLogger,
      isInteresting: (name) => name === 'Mahalle', // apps known; the extension never ran while we listed
      onReport: (report) => reports.push(report),
    });
    await w.scan();
    // Without a bug_type, names still decide (no copy of every .ips of the phone).
    expect(copies).toEqual(['Retired/MahalleNotificationService-2026-11-02-230022.ips']);
    expect(reports.map((r) => r.bundleId)).toEqual([NS]);
    await w.stop();
  });

  it('device crash watcher: reports named after an app go first when a scan copies only some', async () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const entry = (name: string, when: string) => ({
      name,
      relativePath: name,
      metadata: { lastModDate: when, size: 9000, extendedAttributes: { bug_type: '309' } },
      resources: { isDirectory: false },
    });
    const copies: string[] = [];
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'files') {
        return ok({ result: { files: [entry('Retired/gpsd-2026-11-02-200000.ips', at(90)), entry('Retired/Mahalle-2026-11-02-210000.ips', at(30))] } });
      }
      if (args[1] === 'copy') {
        copies.push(args[args.indexOf('--source') + 1]!);
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, fixture('ios-objc-exception.ips'));
        return ok({ info: { outcome: 'success' } });
      }
      return failed(`unexpected ${args.join(' ')}`);
    };
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: run,
      destDir: crashCopyDir(tmp(), UDID),
      logger: silentLogger,
      isInteresting: (name) => name === 'Mahalle',
      onReport: () => {},
      maxCopiesPerScan: 1,
    });
    await w.scan();
    expect(copies).toEqual(['Retired/Mahalle-2026-11-02-210000.ips']);
    await w.scan();
    expect(copies).toEqual(['Retired/Mahalle-2026-11-02-210000.ips', 'Retired/gpsd-2026-11-02-200000.ips']);
    await w.stop();
  });

  it('device driver: the extension crash row and the crash count go to the host app', async () => {
    const mux = new FakeUsbmuxd();
    await mux.start();
    const dir = tmp();
    const ctx = createCtx({ settings: { idevicesyslogPath: writeCaptureSyslog(dir) } });
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const name = 'Retired/MahalleNotificationService-2026-11-02-230022.ips';
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'files') {
        return ok({ result: { files: [{ name, relativePath: name, metadata: { lastModDate: hourAgo, size: 9000, extendedAttributes: { bug_type: '309' } }, resources: { isDirectory: false } }] } });
      }
      if (args[1] === 'copy') {
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, asExtension(fixture('ios-objc-exception.ips'), { bundleId: NS, name: 'MahalleNotificationService', pid: 14807 }));
        return ok({ info: { outcome: 'success' } });
      }
      return realDevicectl(args);
    };
    const driver = new IosDeviceDriver({
      socketPath: mux.socketPath,
      devicectl: run,
      timing: { appsEveryMs: 60_000, processesEveryMs: 60_000, crashesEveryMs: 60_000, crashStartDelayMs: 0 },
    });
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    try {
      await driver.start(ctx);
      const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'));
      expect(crash.entry.message.startsWith('Mahalle 4.1.0 (412) · MahalleNotificationService crashed:')).toBe(true);
      expect(crash.entry.data).toMatchObject({ bundleId: 'com.mykynk.mahalle', extensionBundleId: NS, previousLaunch: true, pid: 14807 });
      await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)?.crashReports === 1);
      expect([...ctx.hub.deviceApps.keys()].filter((k) => k.includes('NotificationService'))).toEqual([]);
    } finally {
      await driver.stop();
      await mux.close();
    }
  });

  it('simulator: a report that arrives before the first app listing still finds its host app', async () => {
    const reportsDir = tmp();
    const ctx = createCtx();
    const text = asExtension(fixture('ios-sim-crash.ips'), { bundleId: 'com.mykynk.pati.PatiWidget', name: 'PatiWidgetExtension' });
    const r = parseIps(text)!;
    const simUdid = (r.coalition ?? '').split('.').pop()!;
    fs.writeFileSync(path.join(reportsDir, 'PatiWidgetExtension-2026-11-02-143109.ips'), text);
    const crashes = new SimCrashWatcher({ dirs: [reportsDir], logger: silentLogger, intervalMs: 60_000, lookbackMs: 100 * 365 * 86400_000 });
    // The report is matched (and cached) before the simulator registers: it is handed over at once.
    await crashes.scan();
    const pati: InstalledIosApp = { id: 'com.mykynk.pati', name: 'Pati', version: '2.4.0', build: '60', buildType: 'debug', source: 'xcode', executable: 'Runner' };
    const appSource: AppSource = {
      listInstalled: async () => {
        await sleep(300); // simctl listapps is slow
        return [pati];
      },
      listRunning: async () => new Map(),
    };
    const session = new SimulatorSession(
      {
        ctx,
        logger: silentLogger,
        isBooted: () => false,
        checkBooted: async () => false,
        crashes,
        crashIndex: new IosCrashIndex({ owns: () => true, getApps: () => [] }),
        appSource: () => appSource,
        timing: { appsEveryMs: 60_000, processesEveryMs: 60_000 },
      },
      { udid: simUdid, name: 'iPhone 17 Pro Max', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', platform: 'ios' },
    );
    session.start();
    try {
      const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'));
      expect(crash.entry.message.startsWith('Pati 2.4.0 (60) · PatiWidgetExtension crashed:')).toBe(true);
      expect(crash.entry.data).toMatchObject({ bundleId: 'com.mykynk.pati', extensionBundleId: 'com.mykynk.pati.PatiWidget' });
      const id = `ios-sim:${simUdid}`;
      await waitFor(() => ctx.hub.deviceApps.get(`${id}|com.mykynk.pati`)?.crashReports === 1);
      expect([...ctx.hub.deviceApps.keys()].filter((k) => k.includes('PatiWidget'))).toEqual([]);
    } finally {
      await session.dispose('stopped');
      await crashes.stop();
      await waitFor(() => liveChildCount() === 0, 5000);
    }
  });
});
