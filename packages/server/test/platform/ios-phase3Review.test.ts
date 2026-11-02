/**
 * Phase-3 review of the iOS stream: devicectl shapes captured from a real iPhone (devicectl 651.32, iOS 27.2,
 * redacted into ios-devicectl-real-*.json / ios-device-runningboard-kill.ips), reader states
 * (`DeviceInfo.readers`), crash report download links and the iOS crash de-duplication.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSession, DeviceInfo, LogEntry } from '@durbun/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveChildCount } from '../../src/platform/exec';
import type { AppSource } from '../../src/platform/ios/appTracker';
import { IosCrashIndex } from '../../src/platform/ios/crashDedupe';
import { crashReportEntry, parseIps, type IpsReport } from '../../src/platform/ios/crashReport';
import { parseDevicectlApps, parseDevicectlDevices, parseDevicectlFiles, type DevicectlResult } from '../../src/platform/ios/devicectl';
import { classifyDevicectlApps, devicectlAppSource } from '../../src/platform/ios/deviceApps';
import { crashCopyDir, crashReportUrl, DeviceCrashWatcher, localCrashName } from '../../src/platform/ios/deviceCrashes';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import { SimCrashWatcher, type SimCrashStatus } from '../../src/platform/ios/simCrashes';
import { SimulatorSession } from '../../src/platform/ios/simDriver';
import { ReaderReporter } from '../../src/platform/shared/readers';
import { silentLogger } from '../../src/util/logger';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { createCtx, fixture, waitFor, type FakeCtx } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const ID = `ios:${UDID}`;
const json = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>;
const ok = (j: Record<string, unknown>): DevicectlResult => ({ ok: true, json: j, stdout: '', stderr: '' });
const failed = (error: string): DevicectlResult => ({ ok: false, error, stdout: '', stderr: '' });

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-p3-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Merged reader state of a device as the hub keeps it (per reader id). */
function readersOf(ctx: FakeCtx, id: string): DeviceInfo['readers'] {
  let readers: DeviceInfo['readers'];
  for (const u of ctx.hub.upserts) if (u.id === id && u.readers) readers = { ...readers, ...u.readers };
  for (const p of ctx.hub.patches) if (p.id === id && p.patch.readers) readers = { ...readers, ...p.patch.readers };
  return readers;
}

describe('devicectl JSON from a real iPhone (devicectl 651.32, iOS 27.2)', () => {
  it('list devices: physical and simulated devices, Developer Mode from both layouts', () => {
    const devices = parseDevicectlDevices(json('ios-devicectl-real-list-devices.json'));
    const phone = devices.find((d) => d.reality === 'physical');
    expect(phone).toMatchObject({
      udid: UDID,
      identifier: '1F4C0B9E-2A7D-4E61-9C35-8B0D6F2A1E47',
      name: 'Test iPhone’u',
      marketingName: 'iPhone 15 Pro Max',
      productType: 'iPhone16,2',
      osVersion: '27.2',
      connectionState: 'connected',
      developerMode: 'enabled',
    });
    // `list devices` also lists simulators; they never reach the physical-device driver (usbmux ids only).
    expect(devices.some((d) => d.reality === 'simulated')).toBe(true);

    const off = json('ios-devicectl-real-list-devices.json') as { result: { devices: Array<Record<string, any>> } };
    const dev = off.result.devices.find((d) => d.hardwareProperties.reality === 'physical')!;
    dev.properties.state.developerModeStatus = { disabled: {} };
    expect(parseDevicectlDevices(off).find((d) => d.udid === UDID)?.developerMode).toBe('disabled');
    delete dev.properties.state.developerModeStatus;
    dev.deviceProperties.developerModeStatus = 'disabled';
    expect(parseDevicectlDevices(off).find((d) => d.udid === UDID)?.developerMode).toBe('disabled');
  });

  it('info files systemCrashLogs: names are paths ("Retired/…"), folders, dates and the bug_type attribute', () => {
    const files = parseDevicectlFiles(json('ios-devicectl-real-files.json'));
    expect(files.find((f) => f.name === 'Retired')).toMatchObject({ isDirectory: true, relativePath: 'Retired' });
    expect(files.find((f) => f.name === 'Retired/Runner-2026-11-02-095019.ips')).toEqual({
      name: 'Retired/Runner-2026-11-02-095019.ips',
      relativePath: 'Retired/Runner-2026-11-02-095019.ips',
      isDirectory: false,
      size: 75715,
      modified: Date.parse('2026-11-02T06:50:19.000Z'),
      bugType: '309',
    });
    expect(files.find((f) => f.name === 'JetsamEvent-2026-11-02-220501.ips')?.bugType).toBe('298');
    expect(files.find((f) => f.name.endsWith('deviceMetadata.proxy'))?.bugType).toBeUndefined();
  });

  it('info apps: many apps share the executable "Runner"; encoded bundle URLs; Apple apps stay out', () => {
    const apps = classifyDevicectlApps(
      parseDevicectlApps(json('ios-devicectl-real-apps-developer.json')),
      parseDevicectlApps(json('ios-devicectl-real-apps-all.json')),
    );
    expect(apps.map((a) => a.id)).toEqual([
      'com.example.authenticator',
      'com.mykynk.kumbara',
      'com.mykynk.mahalle',
      'com.mykynk.pati',
      'com.mykynk.sugarsquare',
    ]);
    expect(apps.filter((a) => a.executable === 'Runner').map((a) => [a.id, a.source])).toEqual([
      ['com.mykynk.kumbara', 'store-or-testflight'],
      ['com.mykynk.pati', 'xcode'],
      ['com.mykynk.sugarsquare', 'xcode'],
    ]);
    expect(apps.find((a) => a.id === 'com.example.authenticator')?.executable).toBe('Microsoft Authenticator');
  });

  it('info processes: executable file URLs map pids to apps (extensions too, percent-encoded paths)', async () => {
    const source = devicectlAppSource(UDID, async (args) => {
      if (args[2] === 'apps') return ok(json(args.includes('--include-all-apps') ? 'ios-devicectl-real-apps-all.json' : 'ios-devicectl-real-apps-developer.json'));
      if (args[2] === 'processes') return ok(json('ios-devicectl-real-processes.json'));
      return failed('unexpected');
    });
    const installed = (await source.listInstalled())!;
    const running = (await source.listRunning(installed))!;
    expect(Object.fromEntries(running)).toEqual({
      'com.example.authenticator': [14939],
      'com.mykynk.kumbara': [14871],
      'com.mykynk.mahalle': [14807, 14889],
      'com.mykynk.pati': [14812],
    });
  });
});

describe('DeviceCrashWatcher on the real systemCrashLogs listing', () => {
  const NOW = Date.parse('2026-11-02T19:10:00.000Z');

  function realDevicectl(opts: { copyText?: string; listing?: () => DevicectlResult } = {}) {
    const copies: string[] = [];
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'files') return opts.listing?.() ?? ok(json('ios-devicectl-real-files.json'));
      if (args[1] === 'copy') {
        copies.push(args[args.indexOf('--source') + 1]!);
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, opts.copyText ?? fixture('ios-device-runningboard-kill.ips'));
        return ok({ info: { outcome: 'success' } });
      }
      return failed(`unexpected ${args.join(' ')}`);
    };
    return { run, copies };
  }

  it('copies only the third-party crash (bug_type 309), never a paired Watch report, even while apps are unknown', async () => {
    const dctl = realDevicectl();
    const reports: Array<{ report: IpsReport; file: string }> = [];
    const statuses: unknown[] = [];
    const destDir = crashCopyDir(tmp(), UDID);
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: dctl.run,
      destDir,
      logger: silentLogger,
      isInteresting: () => true, // the app list is not known yet: every name passes
      onReport: (report, file) => reports.push({ report, file }),
      onStatus: (s) => statuses.push(s),
      now: () => NOW,
    });
    await w.scan();
    expect(dctl.copies).toEqual(['Retired/Runner-2026-11-02-095019.ips']);
    expect(statuses).toEqual([{ ok: true }]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.file).toBe(path.join(destDir, 'Runner-2026-11-02-095019.ips'));
    expect(reports[0]!.report).toMatchObject({ bundleId: 'com.mykynk.kumbara', procName: 'Runner', pid: 11384 });
    await w.stop();
  });

  it('reports listing failures, and deletes copies that are not third-party crash reports', async () => {
    let fail = true;
    const dctl = realDevicectl({
      copyText: fixture('ios-jetsam.ips'),
      listing: () => (fail ? failed('The device is locked.') : ok(json('ios-devicectl-real-files.json'))),
    });
    const statuses: unknown[] = [];
    const reports: IpsReport[] = [];
    const destDir = crashCopyDir(tmp(), UDID);
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: dctl.run,
      destDir,
      logger: silentLogger,
      isInteresting: () => true,
      onReport: (r) => reports.push(r),
      onStatus: (s) => statuses.push(s),
      now: () => NOW,
    });
    await w.scan();
    fail = false;
    await w.scan();
    expect(statuses).toEqual([{ ok: false, error: 'The device is locked.' }, { ok: true }]);
    expect(dctl.copies).toHaveLength(1);
    expect(reports).toHaveLength(0);
    expect(fs.existsSync(destDir) ? fs.readdirSync(destDir) : []).toEqual([]);
    await w.stop();
  });
});

describe('a real device report (RUNNINGBOARD 0xdead10cc kill of a store build)', () => {
  it('parses termination, unsymbolicated app frame and builds the entry with its download link', () => {
    const r = parseIps(fixture('ios-device-runningboard-kill.ips'))!;
    expect(r).toMatchObject({
      bugType: '309',
      bundleId: 'com.mykynk.kumbara',
      version: '3.1.0',
      build: '310',
      procName: 'Runner',
      pid: 11384,
      exceptionType: 'EXC_CRASH',
      signal: 'SIGKILL',
      termination: 'RUNNINGBOARD 0xdead10cc',
      crashedThread: 0,
      crashedQueue: 'com.apple.main-thread',
      symbolicated: false,
      incomplete: false,
    });
    const e = crashReportEntry(r, {
      watchStart: Date.parse('2026-11-02T12:00:00Z'),
      file: '/tmp/x/crash/U/Runner-2026-11-02-095019.ips',
      reportUrl: crashReportUrl(UDID, 'Runner-2026-11-02-095019.ips'),
      duplicateOf: 42,
    });
    expect(e.message).toBe('Kumbara 3.1.0 (310) crashed: EXC_CRASH (SIGKILL) · RUNNINGBOARD 0xdead10cc');
    // The stripped app binary's frame: image + offset (what atos needs with the dSYM).
    expect(e.error?.stack).toMatch(/^9 +Runner +0x00000001045781cc Runner \+ 0x1901cc$/m);
    expect(e.data).toMatchObject({
      origin: 'crash-report',
      bundleId: 'com.mykynk.kumbara',
      previousLaunch: true,
      symbolicated: false,
      file: '/tmp/x/crash/U/Runner-2026-11-02-095019.ips',
      reportUrl: `/api/files/crash/${UDID}/Runner-2026-11-02-095019.ips`,
      duplicateOf: 42,
    });
  });
});

describe('crash copy names and links', () => {
  it('local names are always safe to serve by name', () => {
    const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,155}\.ips$/;
    for (const raw of ['Retired/Runner-2026-11-02-095019.ips', '..', '.hidden.ips', 'Dürbün-2026-11-02-172552.IPS', 'a/../../b.ips', 'Runner..ips', `${'x'.repeat(300)}.ips`, '-_.ips']) {
      const name = localCrashName(raw);
      expect(name, raw).toMatch(SAFE);
      expect(name.includes('..'), raw).toBe(false);
    }
    expect(localCrashName('Dürbün-2026-11-02-172552.IPS')).toBe('D_rb_n-2026-11-02-172552.ips');
    expect(localCrashName('.hidden.ips')).toBe('hidden.ips');
  });

  it('links follow /api/files/crash/<udid>/<name>', () => {
    expect(crashReportUrl('7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D', 'Runner-2026.ips')).toBe('/api/files/crash/7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D/Runner-2026.ips');
    expect(crashCopyDir('/t', 'a/../b')).toBe(path.join('/t', 'crash', 'ab'));
    expect(crashCopyDir('/t', '../')).toBe(path.join('/t', 'crash', 'device'));
  });
});

describe('ReaderReporter', () => {
  it('emits changes only, refreshes lastOk every 10 min and keeps the last success on failure', () => {
    let now = 1_000_000;
    const out: unknown[] = [];
    const r = new ReaderReporter((s) => out.push(s), { now: () => now });
    r.ok();
    now += 60_000;
    r.ok();
    now += 10 * 60_000;
    r.ok();
    const lastOk = now;
    now += 5000;
    r.unavailable('reader.crashReports.failed', 'The device is locked.');
    r.unavailable('reader.crashReports.failed', 'The device is locked.');
    now += 5000;
    r.ok();
    expect(out).toEqual([
      { status: 'ok', lastOk: 1_000_000 },
      { status: 'ok', lastOk },
      { status: 'unavailable', code: 'reader.crashReports.failed', detail: 'The device is locked.', lastOk },
      { status: 'ok', lastOk: now },
    ]);
  });
});

describe('IosCrashIndex (iOS crash de-duplication)', () => {
  const report = (over: Partial<IpsReport>): IpsReport => ({ ...parseIps(fixture('ios-objc-exception.ips'))!, ...over });
  const session = (id: string, bundleId: string, pid?: number): AppSession =>
    ({ id, deviceId: ID, app: { id: bundleId, name: 'App', ...(pid !== undefined ? { pid } : {}) } }) as AppSession;
  let seq = 100;
  const entry = (over: Partial<LogEntry>): LogEntry => ({ id: seq++, ts: 0, deviceId: ID, source: 'device', level: 'fatal', kind: 'crash', tag: 'x', message: '', ...over });

  it('matches the live SDK row by its session pid and the device line by pid; closest first, one report per row', () => {
    const r = report({});
    const apps = [session('app:1', 'com.mykynk.mahalle', r.pid)];
    const idx = new IosCrashIndex({ owns: (id) => id === ID, getApps: () => apps });
    const sdk = entry({ source: 'app', appId: 'app:1', tag: 'crash', ts: r.ts! - 500, message: 'Uncaught exception NSInvalidArgumentException: boom' });
    const line = entry({ pid: r.pid, ts: r.ts! - 1400, message: "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: 'boom'" });
    idx.add([sdk, line]);
    expect(idx.claim(ID, r)).toBe(sdk.id);
    expect(idx.claim(ID, r)).toBe(line.id);
    expect(idx.claim(ID, r)).toBeUndefined();
  });

  it('never matches Dart / Flutter errors, other devices, other pids or rows too far away', () => {
    const r = report({});
    const apps = [session('app:1', 'com.mykynk.mahalle', r.pid)];
    const idx = new IosCrashIndex({ owns: (id) => id.startsWith('ios:'), getApps: () => apps });
    idx.add([
      entry({ source: 'app', appId: 'app:1', tag: 'flutter', ts: r.ts!, message: 'Unhandled exception: FormatException' }),
      entry({ pid: r.pid, ts: r.ts!, level: 'error', message: '[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: x' }),
      entry({ deviceId: 'ios:OTHER', pid: r.pid, ts: r.ts!, message: '*** Terminating app due to uncaught exception' }),
      entry({ pid: (r.pid ?? 0) + 1, ts: r.ts!, message: '*** Terminating app due to uncaught exception' }),
      entry({ pid: r.pid, ts: r.ts! - 61_000, message: '*** Terminating app due to uncaught exception' }),
      entry({ deviceId: 'android:x', pid: r.pid, ts: r.ts!, message: '*** Terminating app due to uncaught exception' }),
    ]);
    expect(idx.size).toBe(3);
    expect(idx.claim(ID, r)).toBeUndefined();
  });

  it('matches "Crash in previous launch" rows by bundle id and time only (their session pid is the next launch)', () => {
    const r = report({});
    const apps = [session('app:2', 'com.mykynk.mahalle', (r.pid ?? 0) + 500)];
    const idx = new IosCrashIndex({ owns: () => true, getApps: () => apps });
    const far = entry({ source: 'app', appId: 'app:2', tag: 'crash', ts: r.ts! + 11_000, message: 'Crash in previous launch: Uncaught exception X: y', data: { previousLaunch: true } });
    idx.add([far]);
    expect(idx.claim(ID, r)).toBeUndefined();
    const near = entry({ source: 'app', appId: 'app:2', tag: 'crash', ts: r.ts! + 800, message: 'Crash in previous launch: Uncaught exception X: y', data: { previousLaunch: true } });
    idx.add([near]);
    expect(idx.claim(ID, r)).toBe(near.id);
  });
});

/* ───────────── drivers ───────────── */

function writeFakeSyslog(dir: string): string {
  const file = path.join(dir, 'idevicesyslog');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const udid = process.argv[process.argv.indexOf('-u') + 1];
process.stdout.write('[connected:' + udid + ']\\n');
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe('IosDeviceDriver · readers, report links and de-duplication', () => {
  let mux: FakeUsbmuxd;
  let dir: string;
  let ctx: FakeCtx;
  let logTaps: Array<(entries: LogEntry[]) => void>;

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    dir = tmp();
    ctx = createCtx({ settings: { idevicesyslogPath: writeFakeSyslog(dir) } });
    logTaps = [];
    ctx.onLogs = (l) => {
      logTaps.push(l);
      return () => {
        logTaps = logTaps.filter((x) => x !== l);
      };
    };
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
  });

  afterEach(async () => {
    await mux.close();
  });

  function devicectlFake(opts: { developerMode?: string } = {}) {
    let listing: 'ok' | 'fail' = 'ok';
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[0] === 'list') {
        const j = json('ios-devicectl-real-list-devices.json') as { result: { devices: Array<Record<string, any>> } };
        if (opts.developerMode) {
          for (const d of j.result.devices) d.properties.state.developerModeStatus = { [opts.developerMode]: {} };
        }
        return ok(j);
      }
      if (args[2] === 'apps') return ok(json(args.includes('--include-all-apps') ? 'ios-devicectl-real-apps-all.json' : 'ios-devicectl-real-apps-developer.json'));
      if (args[2] === 'processes') return ok(json('ios-devicectl-real-processes.json'));
      if (args[2] === 'files') {
        if (listing === 'fail') return failed('The device is locked.\nUnlock it and try again.');
        const name = 'Retired/Mahalle-2026-11-02-100514.ips';
        return ok({ result: { files: [{ name, relativePath: name, metadata: { lastModDate: hourAgo, size: 9000, extendedAttributes: { bug_type: '309' } }, resources: { isDirectory: false } }] } });
      }
      if (args[1] === 'copy') {
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, fixture('ios-objc-exception.ips'));
        return ok({ info: { outcome: 'success' } });
      }
      return failed(`unexpected ${args.join(' ')}`);
    };
    return { run, setListing: (v: 'ok' | 'fail') => (listing = v) };
  }

  const timing = { appsEveryMs: 60_000, processesEveryMs: 1000, crashesEveryMs: 300, crashStartDelayMs: 50 };

  it('frame stats unsupported; crash reports ok → unavailable (failed) → ok, patched one reader at a time', async () => {
    const dctl = devicectlFake();
    const driver = new IosDeviceDriver({ socketPath: mux.socketPath, devicectl: dctl.run, timing });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => readersOf(ctx, ID)?.crashReports?.status === 'ok');
    expect(readersOf(ctx, ID)?.frameStats).toEqual({
      status: 'unsupported',
      code: 'reader.frameStats.unsupported',
      detail: expect.any(String),
    });
    dctl.setListing('fail');
    await waitFor(() => readersOf(ctx, ID)?.crashReports?.status === 'unavailable');
    expect(readersOf(ctx, ID)?.crashReports).toEqual({
      status: 'unavailable',
      code: 'reader.crashReports.failed',
      detail: 'The device is locked.',
      lastOk: expect.any(Number),
    });
    dctl.setListing('ok');
    await waitFor(() => readersOf(ctx, ID)?.crashReports?.status === 'ok');
    // The hub merges per reader id: patches carry only the reader that changed.
    for (const p of ctx.hub.patches.filter((x) => x.patch.readers)) expect(Object.keys(p.patch.readers!)).toEqual(['crashReports']);
    // Report link + kept bundle id on the crash entry.
    const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'));
    expect(crash.entry.data).toMatchObject({
      bundleId: 'com.mykynk.mahalle',
      file: path.join(ctx.tempDir, 'crash', UDID, 'Mahalle-2026-11-02-100514.ips'),
      reportUrl: `/api/files/crash/${UDID}/Mahalle-2026-11-02-100514.ips`,
    });
    await driver.stop();
    expect(logTaps).toHaveLength(0);
    await waitFor(() => liveChildCount() === 0, 5000);
  });

  it('says Developer Mode is off when listing fails on such a device', async () => {
    const dctl = devicectlFake({ developerMode: 'disabled' });
    dctl.setListing('fail');
    const driver = new IosDeviceDriver({ socketPath: mux.socketPath, devicectl: dctl.run, timing });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => readersOf(ctx, ID)?.crashReports?.status === 'unavailable');
    expect(readersOf(ctx, ID)?.crashReports).toMatchObject({ code: 'reader.crashReports.developerModeOff', detail: 'The device is locked.' });
    await driver.stop();
    await waitFor(() => liveChildCount() === 0, 5000);
  });

  it('without devicectl the device says crash reports need Xcode', async () => {
    const driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID));
    expect(readersOf(ctx, ID)).toEqual({
      frameStats: expect.objectContaining({ status: 'unsupported' }),
      crashReports: { status: 'unavailable', code: 'reader.crashReports.devicectlMissing', detail: expect.stringContaining('devicectl') },
    });
    await driver.stop();
    await waitFor(() => liveChildCount() === 0, 5000);
  });

  it('marks a report the live "*** Terminating app" line already showed as duplicateOf', async () => {
    const dctl = devicectlFake();
    const driver = new IosDeviceDriver({ socketPath: mux.socketPath, devicectl: dctl.run, timing: { ...timing, crashStartDelayMs: 400 } });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID));
    const r = parseIps(fixture('ios-objc-exception.ips'))!;
    const live: LogEntry = {
      id: 4711,
      ts: r.ts! - 300,
      deviceId: ID,
      source: 'device',
      origin: 'idevicesyslog',
      level: 'fatal',
      kind: 'crash',
      tag: 'Mahalle',
      process: 'Mahalle',
      pid: r.pid!,
      message: "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: 'boom'",
    };
    for (const tap of logTaps) tap([live]);
    const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'));
    expect((crash.entry.data as { duplicateOf?: number }).duplicateOf).toBe(4711);
    await driver.stop();
    await waitFor(() => liveChildCount() === 0, 5000);
  });
});

describe('simulator crash reports · folder status, copy and link', () => {
  it('SimCrashWatcher says whether the report folders can be read (a missing folder is fine)', async () => {
    const root = tmp();
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked);
    fs.chmodSync(blocked, 0o000);
    try {
      const statuses: SimCrashStatus[] = [];
      const w = new SimCrashWatcher({ dirs: [path.join(root, 'missing'), blocked], logger: silentLogger, intervalMs: 60_000 });
      const off = w.register('7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D', () => {}, (s) => statuses.push(s));
      await waitFor(() => statuses.length > 0);
      if (process.getuid?.() === 0) expect(statuses[0]).toEqual({ ok: true });
      else expect(statuses[0]).toEqual({ ok: false, error: `Cannot read ${blocked}: EACCES` });
      fs.chmodSync(blocked, 0o755);
      await w.scan();
      expect(statuses.at(-1)).toEqual({ ok: true });
      // A simulator registering later hears the last status at once.
      const late: SimCrashStatus[] = [];
      const off2 = w.register('3408DC26-4E7B-492A-9886-016CA9DB2BB1', () => {}, (s) => late.push(s));
      expect(late).toEqual([{ ok: true }]);
      off();
      off2();
      await w.stop();
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
  });

  it('a matched report is copied to <tempDir>/crash/<udid>/ and its entry links the copy; readers are reported', async () => {
    const udid = '7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D';
    const reports = tmp();
    const ctx = createCtx();
    const text = fixture('ios-sim-crash.ips');
    const r = parseIps(text)!;
    const simUdid = (r.coalition ?? '').split('.').pop()!;
    fs.writeFileSync(path.join(reports, 'Runner-2026-11-02-114301.ips'), text);
    const crashes = new SimCrashWatcher({ dirs: [reports], logger: silentLogger, intervalMs: 60_000, lookbackMs: 100 * 365 * 86400_000 });
    const index = new IosCrashIndex({ owns: () => true, getApps: () => [] });
    const appSource: AppSource = { listInstalled: async () => [], listRunning: async () => new Map() };
    const session = new SimulatorSession(
      {
        ctx,
        logger: silentLogger,
        isBooted: () => false, // the (fake) log stream is not restarted
        checkBooted: async () => false,
        crashes,
        crashIndex: index,
        appSource: () => appSource,
        timing: { appsEveryMs: 60_000, processesEveryMs: 60_000 },
      },
      { udid: simUdid || udid, name: 'iPhone 17 Pro Max', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', platform: 'ios' },
    );
    session.start();
    const id = `ios-sim:${simUdid || udid}`;
    const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'));
    const copy = path.join(ctx.tempDir, 'crash', simUdid, 'Runner-2026-11-02-114301.ips');
    expect(fs.readFileSync(copy, 'utf8')).toBe(text);
    expect(crash.deviceId).toBe(id);
    expect(crash.entry.data).toMatchObject({ bundleId: r.bundleId, file: copy, reportUrl: `/api/files/crash/${simUdid}/Runner-2026-11-02-114301.ips` });
    expect(readersOf(ctx, id)).toEqual({
      frameStats: expect.objectContaining({ status: 'unsupported', code: 'reader.frameStats.unsupported' }),
      crashReports: { status: 'ok', lastOk: expect.any(Number) },
    });
    await session.dispose('stopped');
    await crashes.stop();
    await waitFor(() => liveChildCount() === 0, 5000);
  });
});
