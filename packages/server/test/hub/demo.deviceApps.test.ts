/**
 * Phase-3 demo states (SPEC §10): every DeviceApp kind (SDK debug builds via adb / simulator / Xcode,
 * SDK-less Play / Firebase / TestFlight builds), origins on every line, dropbox and .ips crash records
 * (previous launch + live, with duplicateOf links), device actions on SDK-less apps — all without a device.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceApp, LogEntry } from '@durbun/protocol';
import { createDemoDriver } from '../../src/demo/index';
import { createSdkLayer } from '../../src/sdk/index';
import type { DeviceDriver, DriverContext, Hub, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { makeHub, makeSettings } from './helpers';

let hub: Hub | undefined;
let sdk: SdkLayer | undefined;
let demo: DeviceDriver | undefined;
let tempDir: string | undefined;

function setup(): { hub: Hub; ctx: DriverContext; demo: DeviceDriver } {
  const settings = makeSettings();
  hub = makeHub();
  const h = hub;
  sdk = createSdkLayer({ hub: h, logger: silentLogger, settings: () => settings, mocks: () => [], serverVersion: '0.1.0' });
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'durbun-demo-apps-'));
  const ctx: DriverContext = {
    hub: h,
    getDevices: () => h.getDevices(),
    getApps: () => h.getApps(),
    getDeviceApps: () => h.getDeviceApps(),
    onLogs: (l) => h.onLogs(l),
    sdk,
    settings: () => settings,
    onSettings: () => () => {},
    logger: silentLogger,
    tempDir,
    fileUrl: (name) => `/api/files/${encodeURIComponent(name)}`,
    ports: { http: 9750, sdk: 9751 },
  };
  demo = createDemoDriver();
  return { hub: h, ctx, demo };
}

afterEach(async () => {
  await demo?.stop();
  await sdk?.close();
  hub?.dispose();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  demo = undefined;
  sdk = undefined;
  hub = undefined;
  tempDir = undefined;
  vi.useRealTimers();
});

const START = new Date('2026-11-02T09:00:00Z');
const app = (h: Hub, deviceId: string, id: string): DeviceApp | undefined => h.getDeviceApps().find((a) => a.deviceId === deviceId && a.id === id);
const shape = (a: DeviceApp | undefined) =>
  a && `${a.deviceId} ${a.id} ${a.version} (${a.build}) ${a.buildType} ${a.install.source}${a.install.installer ? ` ${a.install.installer}` : ''} running=${a.running}`;

describe('demo device apps (virtual time)', () => {
  it('reports every build kind with pids, install source and build type within ~10 s', async () => {
    vi.useFakeTimers({ now: START });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(hub.getDeviceApps().map(shape).sort()).toEqual([
      'demo:1 com.mykynk.kumbara 3.1.0 (310) release play com.android.vending running=true',
      'demo:1 com.mykynk.mahalle 5.12.0 (5120) debug adb running=true',
      'demo:1 com.mykynk.pati 2.4.1 (241) debug adb com.android.shell running=true',
      'demo:1 com.mykynk.pati.staging 2.5.0-rc.2 (252) release firebase dev.firebase.appdistribution running=true',
      'demo:2 com.mykynk.pati 2.4.1 (241) debug simulator running=true',
      'demo:3 com.mykynk.kumbara 3.1.0 (310) release store-or-testflight running=true',
      'demo:3 com.mykynk.pati 2.4.1 (241) debug xcode running=false',
    ]);

    // pids match the processes the hub knows; Kumbara has a main and a ":widget" process
    const kumbara = app(hub, 'demo:1', 'com.mykynk.kumbara')!;
    expect(kumbara.pids).toHaveLength(2);
    const names = new Map(hub.getProcesses().filter((p) => p.deviceId === 'demo:1').map((p) => [p.pid, p.name]));
    expect(kumbara.pids.map((p) => names.get(p))).toEqual(['com.mykynk.kumbara', 'com.mykynk.kumbara:widget']);
    const sdkPati = hub.getApps().find((a) => a.deviceId === 'demo:1' && a.app.id === 'com.mykynk.pati' && a.connected)!;
    expect(app(hub, 'demo:1', 'com.mykynk.pati')!.pids).toEqual([sdkPati.app.pid]);
    expect(app(hub, 'demo:2', 'com.mykynk.pati')).toMatchObject({ processName: 'Runner', name: 'Pati' });
    expect(app(hub, 'demo:1', 'com.mykynk.pati')!.processName).toBeUndefined(); // same as the package
    expect(app(hub, 'demo:3', 'com.mykynk.kumbara')).toMatchObject({ processName: 'Runner', crashReports: 1 });
    // the Xcode build is "recently active", not running, and has no SDK session (yet)
    const xcode = app(hub, 'demo:3', 'com.mykynk.pati')!;
    expect(START.getTime() - xcode.lastActivity).toBe(9 * 60_000);
    expect(hub.getApps().some((a) => a.deviceId === 'demo:3')).toBe(false);
    // SDK-less builds have no SDK session; their device lines are attributed by pid
    expect(hub.getApps().some((a) => a.app.id === 'com.mykynk.kumbara' || a.app.id === 'com.mykynk.pati.staging')).toBe(false);
    const kumbaraLines = hub.getLogs().filter((l) => l.deviceId === 'demo:1' && l.pid !== undefined && kumbara.pids.includes(l.pid));
    expect(kumbaraLines.length).toBeGreaterThan(3);
    expect(Date.now() - kumbara.lastActivity).toBeLessThan(10_000);

    // the physical iPhone gets no host metrics (physical iOS exposes none); the SDK-less Android build gets frame stats
    demo.watchMetrics?.('demo:3', { processName: 'Runner' }, true);
    demo.watchMetrics?.('demo:1', { pid: kumbara.pids[0] }, true);
    await vi.advanceTimersByTimeAsync(4500);
    expect(hub.getMetrics().some((m) => m.deviceId === 'demo:3')).toBe(false);
    const frames = hub.getMetrics().filter((m) => m.deviceId === 'demo:1' && m.pid === kumbara.pids[0]);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((m) => typeof m.fps === 'number' && typeof m.jankyFrames === 'number')).toBe(true);

    await demo.stop();
    expect(hub.getDeviceApps().every((a) => !a.running && a.pids.length === 0)).toBe(true);
    expect(hub.getDeviceApps()).toHaveLength(7); // device facts stay listed
  });

  it('every line names its origin; crash records from before the session are previousLaunch', async () => {
    vi.useFakeTimers({ now: START });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    await vi.advanceTimersByTimeAsync(12_000);
    const logs = hub.getLogs();
    expect(logs.every((l) => l.origin !== undefined)).toBe(true);
    const originsOf = (deviceId: string, source: LogEntry['source']) => new Set(logs.filter((l) => l.deviceId === deviceId && l.source === source).map((l) => l.origin));
    expect(originsOf('demo:1', 'device')).toEqual(new Set(['logcat', 'dropbox']));
    expect(originsOf('demo:2', 'device')).toEqual(new Set(['simctl-log']));
    expect(originsOf('demo:3', 'device')).toEqual(new Set(['idevicesyslog', 'crash-report']));
    expect(originsOf('demo:1', 'app')).toEqual(new Set(['sdk']));
    expect(new Set(logs.filter((l) => l.source === 'system').map((l) => l.origin))).toEqual(new Set(['durbun']));

    const dropbox = logs.filter((l) => l.origin === 'dropbox');
    expect(dropbox).toHaveLength(1);
    expect(dropbox[0]).toMatchObject({
      kind: 'crash',
      level: 'fatal',
      tag: 'data_app_crash',
      process: 'com.mykynk.kumbara:widget',
      data: {
        origin: 'dropbox',
        dropboxTag: 'data_app_crash',
        package: 'com.mykynk.kumbara',
        process: 'com.mykynk.kumbara:widget',
        previousLaunch: true,
        version: '3.1.0',
        build: '310',
        debuggable: false,
      },
      error: { type: 'java.lang.RuntimeException' },
    });
    expect((dropbox[0]!.data as { reportTs: number }).reportTs).toBeLessThan(START.getTime() - 3 * 3_600_000);
    expect(dropbox[0]!.ts).toBe((dropbox[0]!.data as { reportTs: number }).reportTs);
    expect(dropbox[0]!.pid).toBeUndefined(); // an old record's pid may belong to another process by now
    expect(dropbox[0]!.message).toMatch(/^java\.lang\.RuntimeException: Unable to start receiver/);
    expect(dropbox[0]!.error!.stack).toContain('GoalWidgetProvider.kt:58');

    const ips = logs.filter((l) => l.origin === 'crash-report');
    expect(ips).toHaveLength(1);
    expect(ips[0]).toMatchObject({
      deviceId: 'demo:3',
      kind: 'crash',
      process: 'Runner',
      tag: 'crash-report',
      data: { origin: 'crash-report', bundleId: 'com.mykynk.kumbara', previousLaunch: true, symbolicated: false, exceptionType: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', bugType: '309' },
      error: { type: 'EXC_BAD_ACCESS', message: 'EXC_BAD_ACCESS (SIGSEGV) · KERN_INVALID_ADDRESS at 0x0000000000000010 · Termination: SIGNAL 11 Segmentation fault: 11' },
    });
    expect(ips[0]!.message).toBe('Kumbara 3.1.0 (310) crashed: EXC_BAD_ACCESS (SIGSEGV) · KERN_INVALID_ADDRESS at 0x0000000000000010');
    expect(ips[0]!.error!.stack).toMatch(/^Thread 0 Crashed:\n0   App\s+0x[0-9a-f]{16} App \+ 0x2c41a8\n/);
    expect((ips[0]!.data as { file: string }).file).toMatch(/^Runner-\d{4}-\d{2}-\d{2}-\d{6}\.ips$/);
  });

  it('over ~4 virtual minutes: live crashes and ANRs with their dropbox / .ips copies, restarts, calm rates', async () => {
    vi.useFakeTimers({ now: START });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    for (let i = 0; i < 240; i++) await vi.advanceTimersByTimeAsync(1000);
    const logs = hub.getLogs();
    const byId = new Map(logs.map((l) => [l.id, l]));

    // Android: live logcat crash of Kumbara + its dropbox copy linked by duplicateOf (UI hides the copy)
    const liveCrash = logs.find((l) => l.deviceId === 'demo:1' && l.origin === 'logcat' && l.kind === 'crash' && l.message.includes('Unknown goal currency'));
    expect(liveCrash).toBeDefined();
    const crashCopy = logs.find((l) => l.origin === 'dropbox' && l.tag === 'data_app_crash' && (l.data as { previousLaunch: boolean }).previousLaunch === false);
    expect(crashCopy).toMatchObject({ pid: liveCrash!.pid, data: { duplicateOf: liveCrash!.id } });
    expect(crashCopy!.id).toBeGreaterThan(liveCrash!.id);
    // the crashed process restarted with a new pid
    const kumbara = app(hub, 'demo:1', 'com.mykynk.kumbara')!;
    expect(kumbara.running).toBe(true);
    expect(kumbara.pids).not.toContain(liveCrash!.pid);
    expect(kumbara.crashReports).toBeGreaterThanOrEqual(2);

    // ANR: ActivityManager row (logcat) + data_app_anr copy with the main-thread traces
    const anrCopy = logs.find((l) => l.origin === 'dropbox' && l.tag === 'data_app_anr');
    expect(anrCopy).toMatchObject({ kind: 'anr', level: 'error', error: { type: 'ANR' } });
    const anrLive = byId.get((anrCopy!.data as { duplicateOf: number }).duplicateOf)!;
    expect(anrLive).toMatchObject({ origin: 'logcat', kind: 'anr', tag: 'ActivityManager' });
    expect(anrLive.message).toMatch(/^ANR in com\.mykynk\.kumbara/);
    expect(anrCopy!.error!.stack).toContain('GoalDao_Impl.updateAll');

    // iOS device: a live SIGSEGV → syslog exit lines → the copied .ips (not previousLaunch) → relaunch
    const liveIps = logs.filter((l) => l.origin === 'crash-report' && (l.data as { previousLaunch: boolean }).previousLaunch === false);
    expect(liveIps).toHaveLength(1);
    expect(logs.some((l) => l.deviceId === 'demo:3' && l.process === 'ReportCrash' && l.message.includes(`corpse[${liveIps[0]!.pid}] Runner`))).toBe(true);
    expect(app(hub, 'demo:3', 'com.mykynk.kumbara')).toMatchObject({ running: true, crashReports: 2 });

    // calm: the USB iPhone and the SDK-less Android builds add only a few lines per second
    const perSecond = (pred: (l: LogEntry) => boolean) => logs.filter(pred).length / 240;
    expect(perSecond((l) => l.deviceId === 'demo:3')).toBeLessThan(5);
    const sdkLess = new Set(hub.getDeviceApps().filter((a) => a.deviceId === 'demo:1' && a.buildType === 'release').flatMap((a) => a.pids));
    expect(perSecond((l) => l.deviceId === 'demo:1' && l.pid !== undefined && sdkLess.has(l.pid))).toBeLessThan(1);
  });

  it('device actions work on SDK-less builds and start the Xcode build with its SDK on the USB iPhone', async () => {
    vi.useFakeTimers({ now: START });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await demo.runAction('demo:1', 'app-stop', { appId: 'com.mykynk.kumbara' })).toMatchObject({ ok: true });
    expect(app(hub, 'demo:1', 'com.mykynk.kumbara')).toMatchObject({ running: false, pids: [] });
    expect(await demo.runAction('demo:1', 'app-launch', { appId: 'com.mykynk.kumbara' })).toMatchObject({ ok: true });
    expect(app(hub, 'demo:1', 'com.mykynk.kumbara')!.pids).toHaveLength(2);

    const list = await demo.runAction('demo:3', 'list-apps', {});
    expect((list.data as { id: string; debuggable?: boolean }[]).map((a) => `${a.id}${a.debuggable ? ' (dev)' : ''}`)).toEqual([
      'com.mykynk.kumbara',
      'com.mykynk.pati (dev)',
      'com.apple.TestFlight',
    ]);
    const shot = await demo.runAction('demo:3', 'screenshot', {});
    expect((shot.data as { url: string }).url).toMatch(/screenshot-iphone-13-demo-/);
    expect(await demo.runAction('demo:3', 'status-bar', { mode: 'clean' })).toMatchObject({ ok: false, code: 'demo.unsupportedAction' });
    expect(await demo.runAction('demo:3', 'app-clear-data', { appId: 'com.mykynk.kumbara' })).toMatchObject({ ok: false });

    expect(await demo.runAction('demo:3', 'app-launch', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1500);
    const session = hub.getApps().find((a) => a.deviceId === 'demo:3' && a.connected);
    expect(session).toMatchObject({ app: { id: 'com.mykynk.pati', processName: 'Runner' }, transport: 'demo' });
    expect(app(hub, 'demo:3', 'com.mykynk.pati')).toMatchObject({ running: true, pids: [session!.app.pid], install: { source: 'xcode' } });

    expect(await demo.runAction('demo:1', 'app-uninstall', { appId: 'com.mykynk.pati.staging' })).toMatchObject({ ok: true });
    expect(app(hub, 'demo:1', 'com.mykynk.pati.staging')).toBeUndefined();
    expect(await demo.runAction('demo:1', 'app-uninstall', { appId: 'com.mykynk.mahalle' })).toMatchObject({ ok: true });
    expect(app(hub, 'demo:1', 'com.mykynk.mahalle')).toBeUndefined();
  });

  it('uninstalling an app that is not running removes its DeviceApp too', async () => {
    vi.useFakeTimers({ now: START });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    await vi.advanceTimersByTimeAsync(10_000);

    // the Xcode build on the USB iPhone is installed but was never launched
    expect(app(hub, 'demo:3', 'com.mykynk.pati')).toMatchObject({ running: false });
    expect(await demo.runAction('demo:3', 'app-uninstall', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: true });
    expect(app(hub, 'demo:3', 'com.mykynk.pati')).toBeUndefined();
    const list = await demo.runAction('demo:3', 'list-apps', {});
    expect((list.data as { id: string }[]).map((a) => a.id)).not.toContain('com.mykynk.pati');

    // an SDK-less build stopped first, then uninstalled
    expect(await demo.runAction('demo:1', 'app-stop', { appId: 'com.mykynk.kumbara' })).toMatchObject({ ok: true });
    expect(await demo.runAction('demo:1', 'app-uninstall', { appId: 'com.mykynk.kumbara' })).toMatchObject({ ok: true });
    expect(app(hub, 'demo:1', 'com.mykynk.kumbara')).toBeUndefined();

    // installing it again brings it back once it runs
    expect(await demo.runAction('demo:3', 'app-install', { file: '/tmp/Pati.ipa' })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(app(hub, 'demo:3', 'com.mykynk.pati')).toMatchObject({ running: true, install: { source: 'xcode' } });
  });

  it('a system process watched by name before every app has started gets plain host metrics (no app frame stats)', async () => {
    vi.useFakeTimers({ now: START });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    await vi.advanceTimersByTimeAsync(4000); // Pati QA (SDK-less, frame stats) starts at 8 s
    demo.watchMetrics?.('demo:1', { processName: 'system_server' }, true);
    await vi.advanceTimersByTimeAsync(4500);
    const ss = hub.getProcesses().find((p) => p.deviceId === 'demo:1' && p.name === 'system_server')!;
    const samples = hub.getMetrics().filter((m) => m.deviceId === 'demo:1' && m.pid === ss.pid);
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples.some((m) => m.fps !== undefined || m.jankyFrames !== undefined)).toBe(false);
  });

  it('the USB iPhone sounds like a phone: its own daemon pids, no simulator paths', async () => {
    vi.useFakeTimers({ now: START });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    await vi.advanceTimersByTimeAsync(90_000);

    const lines = hub.getLogs().filter((l) => l.deviceId === 'demo:3');
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.filter((l) => /CoreSimulator|\/Users\//.test(l.message))).toEqual([]);
    // every daemon line carries the pid the device's process table has for that daemon
    const table = new Map(hub.getProcesses().filter((p) => p.deviceId === 'demo:3').map((p) => [p.name, p.pid]));
    const daemons = lines.filter((l) => l.process && l.process !== 'Runner' && table.has(l.process));
    expect(daemons.length).toBeGreaterThan(20);
    expect(daemons.filter((l) => l.pid !== table.get(l.process!)).map((l) => `${l.process}[${l.pid}]`)).toEqual([]);
  });
});
