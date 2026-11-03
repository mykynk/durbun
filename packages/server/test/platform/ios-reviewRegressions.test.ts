/**
 * Regression tests for defects found in the phase-3 iOS review (DeviceApps + crash reports):
 * - a crash of an app installed after the app listing was dropped for good,
 * - re-plugging a device / rebooting a simulator reported the same crash reports again,
 * - DeviceApps left from an earlier connection were never pruned or refreshed,
 * - unplugging waited for in-flight devicectl calls before the device showed as disconnected,
 * - the simulator "relist on unknown process" flag ignored later log-scope changes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceApp } from '@durbun/protocol';
import { IosAppTracker, RECENT_ACTIVITY_MS, type AppSource, type InstalledIosApp } from '../../src/platform/ios/appTracker';
import { isCrashFileName, type IpsReport } from '../../src/platform/ios/crashReport';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { DeviceCrashWatcher, localCrashName } from '../../src/platform/ios/deviceCrashes';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import { SimCrashWatcher } from '../../src/platform/ios/simCrashes';
import { silentLogger } from '../../src/util/logger';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { createCtx, createFakeHub, fixture, waitFor } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const DEV = `ios:${UDID}`;
const SIM = '7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D';
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-review-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ok = (json: Record<string, unknown>): DevicectlResult => ({ ok: true, json, stdout: '', stderr: '' });

/** systemCrashLogs with one Runner crash; `copy from` writes the Swift crash fixture. */
function crashDevicectl() {
  const calls: string[][] = [];
  const name = 'Runner-2026-11-02-114258.ips';
  const run = async (args: string[]): Promise<DevicectlResult> => {
    calls.push(args);
    if (args[2] === 'files') {
      return ok({ result: { files: [{ name, relativePath: name, metadata: { lastModDate: '2026-11-02T08:42:59.000Z', size: 100 } }] } });
    }
    if (args[1] === 'copy') {
      fs.writeFileSync(args[args.indexOf('--destination') + 1]!, fixture('ios-swift-crash.ips'));
      return ok({ info: { outcome: 'success' } });
    }
    return { ok: false, error: 'unexpected', stdout: '', stderr: '' };
  };
  return { run, calls, copies: () => calls.filter((c) => c[1] === 'copy').length };
}

describe('DeviceCrashWatcher (review regressions)', () => {
  it('still reads a crash of an app that was not installed yet at the previous scan', async () => {
    const fake = crashDevicectl();
    let installed = new Set<string>(['Mahalle']);
    const reports: IpsReport[] = [];
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: fake.run,
      destDir: path.join(tmp(), 'crash', UDID),
      logger: silentLogger,
      isInteresting: (n) => !!n && installed.has(n),
      onReport: (r) => reports.push(r),
      now: () => NOW,
    });
    await w.scan();
    expect(fake.copies()).toBe(0);
    // `flutter run` installs the app and it crashes before the next app listing… then the listing catches up.
    installed = new Set(['Mahalle', 'Runner']);
    await w.scan();
    expect(fake.copies()).toBe(1);
    expect(reports.map((r) => r.bundleId)).toEqual(['com.mykynk.pati']);
    await w.stop();
  });

  it('does not copy or report the same file again after a reconnect (shared seen set)', async () => {
    const fake = crashDevicectl();
    const seen = new Set<string>();
    const dest = path.join(tmp(), 'crash', UDID);
    const reports: IpsReport[] = [];
    const make = () =>
      new DeviceCrashWatcher({
        udid: UDID,
        devicectl: fake.run,
        destDir: dest,
        logger: silentLogger,
        isInteresting: () => true,
        onReport: (r) => reports.push(r),
        now: () => NOW,
        seen,
      });
    const first = make();
    await first.scan();
    await first.stop();
    const second = make();
    await second.scan();
    await second.stop();
    expect(fake.copies()).toBe(1);
    expect(reports).toHaveLength(1);
  });

  it('a copy that finishes after stop() is read again by the next session', async () => {
    const seen = new Set<string>();
    const dest = path.join(tmp(), 'crash', UDID);
    const base = crashDevicectl();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    const run = async (args: string[]) => {
      if (args[1] === 'copy' && gated) {
        gated = false;
        await gate;
      }
      return base.run(args);
    };
    const reports: IpsReport[] = [];
    const first = new DeviceCrashWatcher({ udid: UDID, devicectl: run, destDir: dest, logger: silentLogger, isInteresting: () => true, onReport: (r) => reports.push(r), now: () => NOW, seen });
    const scanning = first.scan();
    await waitFor(() => !gated);
    const stopping = first.stop();
    release();
    await Promise.all([scanning, stopping]);
    expect(reports).toHaveLength(0);
    const second = new DeviceCrashWatcher({ udid: UDID, devicectl: run, destDir: dest, logger: silentLogger, isInteresting: () => true, onReport: (r) => reports.push(r), now: () => NOW, seen });
    await second.scan();
    await second.stop();
    expect(reports).toHaveLength(1);
  });
});

describe('crash file names (review regressions)', () => {
  it('keeps crash reports of apps whose name starts with a system report family word', () => {
    for (const name of ['WiFiMan-2026-11-02-114258.ips', 'PanicButton-2026-11-02-114258.ips', 'Stacks-2026-11-02-114258.ips', 'SandboxDemo-2026-11-02-114258.ips', 'AnalyticsPro-2026-11-02-114258.ips']) {
      expect(isCrashFileName(name), name).toBe(true);
    }
    for (const name of ['stacks+com.apple.mediaserverd-2026-11-02-114258.ips', 'panic-full-2026-11-02-114258.ips', 'JetsamEvent-2026-11-02-114258.ips', 'SFA-ckks.json_2026-11-02-121843_Mac.ips', 'xp_amp_app_usage_dnu-2026-11-02-114258.ips']) {
      expect(isCrashFileName(name), name).toBe(false);
    }
  });

  it('local copy names never point at the crash folder itself', () => {
    expect(localCrashName('..')).toBe('crash.ips');
    expect(localCrashName('Retired/.')).toBe('crash.ips');
    expect(localCrashName('Retired/Runner-2026-11-02-114258.ips')).toBe('Runner-2026-11-02-114258.ips');
  });

  it('a report that iOS moves into Retired/ is not copied or reported twice', async () => {
    const fake = crashDevicectl();
    const reports: IpsReport[] = [];
    const name = 'Runner-2026-11-02-114258.ips';
    let rel = name;
    const run = async (args: string[]): Promise<DevicectlResult> => {
      if (args[2] === 'files') {
        fake.calls.push(args);
        return ok({ result: { files: [{ name, relativePath: rel, metadata: { lastModDate: '2026-11-02T08:42:59.000Z', size: 100 } }] } });
      }
      return fake.run(args);
    };
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: run,
      destDir: path.join(tmp(), 'crash', UDID),
      logger: silentLogger,
      isInteresting: () => true,
      onReport: (r) => reports.push(r),
      now: () => NOW,
    });
    await w.scan();
    rel = `Retired/${name}`;
    await w.scan();
    expect(fake.copies()).toBe(1);
    expect(reports).toHaveLength(1);
    await w.stop();
  });
});

describe('SimCrashWatcher (review regressions)', () => {
  it('does not replay reports a simulator already got when it boots again', async () => {
    const root = tmp();
    const nowMs = Date.UTC(2026, 10, 2, 15, 0, 0);
    fs.writeFileSync(path.join(root, 'Runner-2026-11-02-143109.ips'), fixture('ios-sim-crash.ips'));
    const w = new SimCrashWatcher({ dirs: [root], logger: silentLogger, intervalMs: 60_000, now: () => nowMs });
    const got: string[] = [];
    const off1 = w.register(SIM, (_r, f) => got.push(`boot1:${path.basename(f)}`));
    await w.scan();
    expect(got).toEqual(['boot1:Runner-2026-11-02-143109.ips']);
    off1();
    // A crash while the simulator is shut down / before it registers again is still delivered once.
    fs.writeFileSync(
      path.join(root, 'Runner-2026-11-02-145000.ips'),
      fixture('ios-sim-crash.ips').replace('2026-11-02 14:31:09.5520', '2026-11-02 14:50:00.1000'),
    );
    await w.scan();
    const off2 = w.register(SIM, (_r, f) => got.push(`boot2:${path.basename(f)}`));
    expect(got).toEqual(['boot1:Runner-2026-11-02-143109.ips', 'boot2:Runner-2026-11-02-145000.ips']);
    off2();
    await w.stop();
  });
});

/* ───────────── IosAppTracker ───────────── */

const PATI: InstalledIosApp = {
  id: 'com.mykynk.pati',
  name: 'Pati',
  version: '2.4.0',
  build: '60',
  buildType: 'release',
  source: 'store-or-testflight',
  executable: 'Runner',
  bundle: 'file:///A/Runner.app/',
};

describe('IosAppTracker (review regressions)', () => {
  function staleApp(lastActivity: number, extra: Partial<DeviceApp> = {}): DeviceApp {
    return {
      key: `${DEV}|${PATI.id}`,
      deviceId: DEV,
      id: PATI.id,
      name: 'Pati',
      version: '2.3.0',
      build: '57',
      buildType: 'debug',
      install: { source: 'xcode' },
      processName: 'Runner',
      pids: [],
      running: false,
      lastActivity,
      ...extra,
    };
  }

  it('refreshes and prunes DeviceApps left from an earlier connection of the same device', async () => {
    let clock = NOW;
    const hub = createFakeHub();
    // Previous connection: app 2.3.0 (57) was active; the device was unplugged, a new build installed.
    hub.deviceApps.set(`${DEV}|${PATI.id}`, staleApp(NOW - 60_000));
    const source: AppSource = { listInstalled: async () => [PATI], listRunning: async () => new Map() };
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
    tracker.start();
    await waitFor(() => hub.deviceApps.get(`${DEV}|${PATI.id}`)?.version === '2.4.0');
    expect(hub.deviceApps.get(`${DEV}|${PATI.id}`)).toMatchObject({ build: '60', buildType: 'release', install: { source: 'store-or-testflight' } });
    clock += RECENT_ACTIVITY_MS + 1000;
    await tracker.tick();
    expect(hub.deviceApps.has(`${DEV}|${PATI.id}`)).toBe(false);
    await tracker.stop();
  });

  it('keeps earlier DeviceApps with crash reports and ignores other devices', async () => {
    const hub = createFakeHub();
    hub.deviceApps.set(`${DEV}|${PATI.id}`, staleApp(NOW - 2 * RECENT_ACTIVITY_MS, { crashReports: 2 }));
    hub.deviceApps.set(`ios:OTHER|${PATI.id}`, { ...staleApp(NOW - 2 * RECENT_ACTIVITY_MS), key: `ios:OTHER|${PATI.id}`, deviceId: 'ios:OTHER' });
    const tracker = new IosAppTracker({
      deviceId: DEV,
      hub,
      getDeviceApps: () => [...hub.deviceApps.values()],
      source: { listInstalled: async () => [PATI], listRunning: async () => new Map() },
      logger: silentLogger,
      installedEveryMs: 300_000,
      runningEveryMs: 30_000,
      now: () => NOW,
    });
    tracker.start();
    await waitFor(() => hub.deviceApps.get(`${DEV}|${PATI.id}`)?.version === '2.4.0');
    await tracker.tick();
    expect(hub.deviceApps.get(`${DEV}|${PATI.id}`)?.crashReports).toBe(2);
    expect(hub.deviceApps.get(`ios:OTHER|${PATI.id}`)?.version).toBe('2.3.0');
    expect(hub.removedDeviceApps).toEqual([]);
    await tracker.stop();
  });

  it('pushes nothing after stop() (late log lines of a disconnected device)', async () => {
    const hub = createFakeHub();
    const tracker = new IosAppTracker({
      deviceId: DEV,
      hub,
      getDeviceApps: () => [...hub.deviceApps.values()],
      source: { listInstalled: async () => [PATI], listRunning: async () => new Map() },
      logger: silentLogger,
      installedEveryMs: 300_000,
      runningEveryMs: 30_000,
      now: () => NOW,
    });
    await tracker.tick();
    await tracker.stop();
    tracker.onLog({ ts: NOW, level: 'info', tag: 'flutter', message: 'late', pid: 4321, process: 'Runner' });
    expect(hub.deviceApps.size).toBe(0);
  });

  it('follows the current log scope when deciding to re-list apps on unknown process names', async () => {
    let scopeApps = true;
    let listings = 0;
    let clock = NOW;
    const hub = createFakeHub();
    const tracker = new IosAppTracker({
      deviceId: 'ios-sim:X',
      hub,
      getDeviceApps: () => [...hub.deviceApps.values()],
      source: {
        listInstalled: async () => {
          listings += 1;
          return [PATI];
        },
        listRunning: async () => new Map(),
      },
      logger: silentLogger,
      installedEveryMs: 300_000,
      runningEveryMs: 5000,
      relistOnUnknownProcess: () => scopeApps,
      now: () => clock,
    });
    await tracker.tick();
    expect(listings).toBe(1);
    // Scope switched to 'all': system process names must not trigger app listings.
    scopeApps = false;
    tracker.onLog({ ts: clock, level: 'info', tag: 'x', message: 'x', pid: 77, process: 'SpringBoard' });
    clock += 1000;
    await tracker.tick();
    expect(listings).toBe(1);
    // Back to 'apps': an unknown name means a new install.
    scopeApps = true;
    clock += 31_000;
    tracker.onLog({ ts: clock, level: 'info', tag: 'x', message: 'x', pid: 78, process: 'NewApp' });
    await tracker.tick();
    expect(listings).toBe(2);
  });
});

/* ───────────── device driver ───────────── */

describe('IosDeviceDriver (review regressions)', () => {
  it('shows an unplugged device as disconnected without waiting for devicectl, and does not repeat crash reports on re-plug', async () => {
    const mux = new FakeUsbmuxd();
    await mux.start();
    const dir = tmp();
    const ctx = createCtx({ settings: { idevicesyslogPath: '/nonexistent/idevicesyslog' } });
    const hourAgo = new Date(Date.now() - 3600_000);
    const crashName = 'Runner-2026-11-02-114258.ips';
    let hang: Promise<void> | undefined;
    let release: () => void = () => {};
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<DevicectlResult> => {
      calls.push(args);
      if (args[2] === 'apps') return ok(JSON.parse(fixture(args.includes('--include-all-apps') ? 'ios-devicectl-apps-all.json' : 'ios-devicectl-apps-developer.json')));
      if (args[2] === 'processes') {
        if (hang) await hang;
        return ok(JSON.parse(fixture('ios-devicectl-processes.json')));
      }
      if (args[2] === 'files') return ok({ result: { files: [{ name: crashName, relativePath: crashName, metadata: { lastModDate: hourAgo.toISOString(), size: 100 } }] } });
      if (args[1] === 'copy') {
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, fixture('ios-swift-crash.ips'));
        return ok({ info: { outcome: 'success' } });
      }
      return { ok: false, error: 'not in tests', stdout: '', stderr: '' };
    };
    const driver = new IosDeviceDriver({
      socketPath: mux.socketPath,
      devicectl: run,
      // No detach grace: this test is about devicectl not holding the disconnect back.
      timing: { appsEveryMs: 60_000, processesEveryMs: 200, crashesEveryMs: 200, crashStartDelayMs: 50, detachGraceMs: 0 },
    });
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    try {
      await driver.start(ctx);
      const crashes = () => ctx.hub.logs.filter((l) => l.entry.origin === 'crash-report');
      await waitFor(() => crashes().length === 1, 8000);
      // The next process check hangs (device unplugged mid-call).
      hang = new Promise<void>((r) => (release = r));
      const before = calls.filter((c) => c[2] === 'processes').length;
      await waitFor(() => calls.filter((c) => c[2] === 'processes').length > before);
      mux.detach(5);
      await waitFor(() => ctx.hub.disconnected.some((d) => d.id === DEV), 1500);
      release();
      hang = undefined;
      // Re-plug: the crash report from before is not reported (or copied) again.
      mux.onPort(6, 62078, fakeLockdown({ DeviceName: 'Test iPhone', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
      mux.attach({ deviceId: 6, udid: UDID });
      const scansBefore = calls.filter((c) => c[2] === 'files').length;
      await waitFor(() => calls.filter((c) => c[2] === 'files').length >= scansBefore + 2, 8000);
      expect(crashes()).toHaveLength(1);
      expect(calls.filter((c) => c[1] === 'copy')).toHaveLength(1);
      expect(ctx.hub.deviceApps.get(`${DEV}|com.mykynk.pati`)?.crashReports).toBe(1);
    } finally {
      release();
      await driver.stop();
      await mux.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
