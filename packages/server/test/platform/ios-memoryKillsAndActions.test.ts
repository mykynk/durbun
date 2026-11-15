/**
 * iOS without an SDK: memory kills from Jetsam reports, stopping TestFlight / App Store apps, iPhones older
 * than devicectl supports, and the Doctor's devicectl fix.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isCrashFileName, isJetsamFileName, jetsamEntries, parseJetsam, type JetsamReport } from '../../src/platform/ios/crashReport';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { runIosDeviceAction, type IosDeviceActionTarget } from '../../src/platform/ios/deviceActions';
import { DeviceCrashWatcher } from '../../src/platform/ios/deviceCrashes';
import { devicectlFix } from '../../src/platform/ios/deviceDriver';
import { beforeDevicectl, iosMajor } from '../../src/platform/ios/readerStates';
import { latestVmAnnouncements, simVmHistoryArgs } from '../../src/platform/ios/simlog';
import { ScreenRecorder } from '../../src/platform/shared/screenRecord';
import { silentLogger } from '../../src/util/logger';
import { createCtx, fixture } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-mk-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('Jetsam reports (iOS memory kills)', () => {
  it('reads the killed processes, the app on screen and the reason', () => {
    const r = parseJetsam(fixture('ios-jetsam.ips'))!;
    expect(r).toMatchObject({ largestProcess: 'Runner', incident: 'ABCDEF01-2345-6789-ABCD-EF0123456789' });
    expect(r.ts).toBe(Date.parse('2026-11-02T08:40:12+03:00'));
    expect(r.kills).toEqual([{ name: 'Runner', pid: 1240, reason: 'per-process-limit', frontmost: true, largest: true }]);
    expect(parseJetsam(fixture('ios-swift-crash.ips'))).toBeNull();
    expect(isJetsamFileName('Retired/JetsamEvent-2026-11-02-084012.ips')).toBe(true);
    expect(isCrashFileName('JetsamEvent-2026-11-02-084012.ips')).toBe(false);
  });

  it('turns a kill of the app on screen into an error row of that app, others stay quiet', () => {
    const r: JetsamReport = {
      ts: NOW,
      largestProcess: 'Runner',
      kills: [
        { name: 'Runner', pid: 1240, reason: 'per-process-limit', frontmost: true, largest: true },
        { name: 'Mahalle', pid: 1300, reason: 'vm-pageshortage', frontmost: false, largest: false },
        { name: 'backboardd', pid: 80, reason: 'vm-pageshortage', frontmost: false, largest: false },
      ],
    };
    const bundles: Record<string, string> = { Runner: 'com.mykynk.pati', Mahalle: 'com.mykynk.mahalle' };
    const rows = jetsamEntries(r, { bundleOf: (exe) => bundles[exe], appName: (id) => (id === 'com.mykynk.pati' ? 'Pati' : undefined), watchStart: NOW - 1000 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      level: 'error',
      tag: 'jetsam',
      origin: 'crash-report',
      process: 'Runner',
      pid: 1240,
      message: 'Pati was closed by iOS to free memory while on screen: it went over its own memory limit (Jetsam, per-process-limit)',
      data: { termination: 'jetsam', reason: 'per-process-limit', frontmost: true, bundleId: 'com.mykynk.pati', previousLaunch: false },
    });
    expect(rows[1]).toMatchObject({ level: 'info', process: 'Mahalle', data: { frontmost: false, bundleId: 'com.mykynk.mahalle' } });
    // Before Dürbün watched: the pid may belong to someone else now.
    expect(jetsamEntries(r, { bundleOf: (exe) => bundles[exe], watchStart: NOW + 1000 })[0]!.pid).toBeUndefined();
  });

  it('copies Jetsam reports from the device when the session reads them, and drops the ones about no app', async () => {
    const dest = path.join(tmp(), 'crash', UDID);
    const listing = JSON.parse(fixture('ios-devicectl-crashlogs.json')) as Record<string, unknown>;
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<DevicectlResult> => {
      calls.push(args);
      if (args[2] === 'files') return { ok: true, json: listing, stdout: '', stderr: '' };
      if (args[1] === 'copy') {
        const src = args[args.indexOf('--source') + 1]!;
        fs.writeFileSync(args[args.indexOf('--destination') + 1]!, fixture(src.includes('Jetsam') ? 'ios-jetsam.ips' : 'ios-system-crash.ips'));
        return { ok: true, json: { info: { outcome: 'success' } }, stdout: '', stderr: '' };
      }
      return { ok: false, error: 'unexpected', stdout: '', stderr: '' };
    };
    const got: JetsamReport[] = [];
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: run,
      destDir: dest,
      logger: silentLogger,
      isInteresting: () => false,
      onReport: () => undefined,
      onJetsam: (report) => {
        got.push(report);
        return true;
      },
      now: () => NOW,
    });
    await w.scan();
    expect(got).toHaveLength(1);
    expect(got[0]!.kills[0]!.name).toBe('Runner');
    expect(fs.readdirSync(dest)).toEqual(['JetsamEvent-2026-11-02-084012.ips']);
    // Read once.
    await w.scan();
    expect(calls.filter((c) => c[1] === 'copy' && c.join(' ').includes('Jetsam'))).toHaveLength(1);
  });
});

/** devicectl for actions: the real all-apps / processes listings; `terminate` answers per pid. */
function actionTarget(terminate: (pid: number) => DevicectlResult, pidsOf?: (id: string) => number[]): {
  target: IosDeviceActionTarget;
  calls: string[][];
} {
  const calls: string[][] = [];
  const apps = JSON.parse(fixture('ios-devicectl-real-apps-all.json')) as { result: { apps: Array<{ bundleIdentifier: string }> } };
  const processes = JSON.parse(fixture('ios-devicectl-real-processes.json')) as Record<string, unknown>;
  const devicectl = async (args: string[]): Promise<DevicectlResult> => {
    calls.push(args);
    if (args[1] === 'info' && args[2] === 'apps') {
      const id = args[args.indexOf('--bundle-id') + 1];
      // Without --include-all-apps devicectl lists developer apps only.
      const all = args.includes('--include-all-apps');
      const list = apps.result.apps.filter((a) => a.bundleIdentifier === id && (all || (a as { builtByDeveloper?: boolean }).builtByDeveloper));
      return { ok: true, json: { result: { apps: list } }, stdout: '', stderr: '' };
    }
    if (args[1] === 'info' && args[2] === 'processes') return { ok: true, json: processes, stdout: '', stderr: '' };
    if (args[1] === 'process' && args[2] === 'terminate') return terminate(Number(args[args.indexOf('--pid') + 1]));
    return { ok: false, error: 'unexpected', stdout: '', stderr: '' };
  };
  const target: IosDeviceActionTarget = {
    udid: UDID,
    deviceId: `ios:${UDID}`,
    label: 'iPhone',
    ctx: createCtx(),
    caps: { available: true, screenshot: true, screenRecord: true, openURL: true },
    screenshotTool: null,
    syslogAvailable: true,
    restartLogs: async () => undefined,
    devicectl,
    recorder: new ScreenRecorder(() => undefined),
    ...(pidsOf ? { pidsOf } : {}),
  };
  return { target, calls };
}

const ok: DevicectlResult = { ok: true, json: { info: { outcome: 'success' } }, stdout: '', stderr: '' };

describe('app-stop on a physical iPhone', () => {
  it('finds a TestFlight / App Store app (not a developer app) and stops its processes', async () => {
    const { target, calls } = actionTarget(() => ok);
    const r = await runIosDeviceAction(target, 'app-stop', { appId: 'com.mykynk.mahalle' });
    expect(r).toMatchObject({ ok: true, message: 'Stopped com.mykynk.mahalle' });
    expect(calls[0]).toContain('--include-all-apps');
    expect(calls.filter((c) => c[2] === 'terminate').map((c) => c[c.length - 1])).toEqual(['14807', '14889']);
  });

  it('says plainly when iOS refuses to stop an app that is not from Xcode', async () => {
    const { target } = actionTarget(() => ({ ok: false, error: 'The operation couldn’t be completed. (Operation not permitted)', stdout: '', stderr: '' }));
    const r = await runIosDeviceAction(target, 'app-stop', { appId: 'com.mykynk.mahalle' });
    expect(r).toMatchObject({ ok: false, code: 'action.stopNotAllowed' });
    expect(r.error ?? r.message).toContain('app switcher');
  });

  it('uses the pids Dürbün already follows when the app is not in the listing', async () => {
    const { target, calls } = actionTarget(() => ok, (id) => (id === 'com.example.sideloaded' ? [4242] : []));
    const r = await runIosDeviceAction(target, 'app-stop', { appId: 'com.example.sideloaded' });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c[2] === 'terminate')).toContain('4242');
    const none = await runIosDeviceAction(actionTarget(() => ok).target, 'app-stop', { appId: 'com.example.missing' });
    expect(none).toMatchObject({ ok: false, code: 'action.appNotFound' });
  });
});

describe('devicectl reach', () => {
  it('knows the iOS versions devicectl does not serve', () => {
    expect(iosMajor('16.7.10')).toBe(16);
    expect(beforeDevicectl('16.7.10')).toBe(true);
    expect(beforeDevicectl('17.0')).toBe(false);
    expect(beforeDevicectl(undefined)).toBe(false);
  });

  it('points xcode-select at Xcode when only the Command Line Tools are selected', () => {
    const dir = tmp();
    const xcode = path.join(dir, 'Xcode.app');
    fs.mkdirSync(xcode);
    expect(devicectlFix('/Library/Developer/CommandLineTools', xcode)).toBe(`sudo xcode-select -s ${xcode}`);
    expect(devicectlFix('/Library/Developer/CommandLineTools', path.join(dir, 'none.app'))).toBe('Install Xcode from the App Store');
    expect(devicectlFix(undefined, xcode)).toBe('Install Xcode from the App Store');
  });
});

describe('simulator: VM service announcements from before Dürbün', () => {
  const ev = (ts: string, pid: number, msg: string) =>
    JSON.stringify({
      eventType: 'logEvent',
      messageType: 'Default',
      timestamp: ts,
      processID: pid,
      threadID: 1,
      processImagePath: '/Users/x/Library/Developer/CoreSimulator/Devices/7B1E/data/Containers/Bundle/Application/AB/Runner.app/Runner',
      senderImagePath: '/Users/x/Library/Developer/CoreSimulator/Devices/7B1E/data/Containers/Bundle/Application/AB/Runner.app/Frameworks/Flutter.framework/Flutter',
      subsystem: '',
      category: '',
      eventMessage: msg,
    });

  it('keeps the newest announcement per process, oldest first', () => {
    const text = [
      'Filtering the log data using "eventMessage CONTAINS \\"Dart VM service is listening on\\""',
      ev('2026-11-15 10:01:00.100000+0300', 5100, 'flutter: The Dart VM service is listening on http://127.0.0.1:50100/old=/'),
      ev('2026-11-15 10:20:00.200000+0300', 5300, 'flutter: The Dart VM service is listening on http://127.0.0.1:50300/new=/'),
      ev('2026-11-15 10:05:00.000000+0300', 5200, 'Runner started'),
      '',
    ].join('\n');
    const found = latestVmAnnouncements(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('50300/new=/');
    expect(simVmHistoryArgs(30).slice(0, 6)).toEqual(['log', 'show', '--last', '30m', '--style', 'ndjson']);
  });
});
