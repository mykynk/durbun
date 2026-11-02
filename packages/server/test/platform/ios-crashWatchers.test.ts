import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IpsReport } from '../../src/platform/ios/crashReport';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { DeviceCrashWatcher, localCrashName } from '../../src/platform/ios/deviceCrashes';
import { parseSimInstalledApps, simPidsFromPs } from '../../src/platform/ios/simApps';
import { SimCrashWatcher } from '../../src/platform/ios/simCrashes';
import { silentLogger } from '../../src/util/logger';
import { fixture } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const SIM = '7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D';
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-crash-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** devicectl stand-in: listing from the fixture, `copy from` writes the matching .ips fixture. */
function fakeDevicectl(opts: { failCopies?: number } = {}) {
  const calls: string[][] = [];
  let failCopies = opts.failCopies ?? 0;
  const sources: Record<string, string> = {
    'Runner-2026-11-02-114258.ips': 'ios-swift-crash.ips',
    'Mahalle-2026-11-02-100514.ips': 'ios-objc-exception.ips',
    'MobileSafari-2026-11-02-091201.ips': 'ios-system-crash.ips',
    'Retired/Instagram-2026-11-02-073001.ips': 'ios-flutter-abort.ips',
    'Runner-2026-11-02-115900.ips': 'ios-flutter-abort.ips',
  };
  let listing = JSON.parse(fixture('ios-devicectl-crashlogs.json')) as Record<string, unknown>;
  const run = async (args: string[]): Promise<DevicectlResult> => {
    calls.push(args);
    if (args[1] === 'info' && args[2] === 'files') return { ok: true, json: listing, stdout: '', stderr: '' };
    if (args[1] === 'copy') {
      const src = args[args.indexOf('--source') + 1]!;
      const dest = args[args.indexOf('--destination') + 1]!;
      if (failCopies > 0) {
        failCopies -= 1;
        return { ok: false, error: 'The operation couldn’t be completed. (Connection interrupted)', stdout: '', stderr: '' };
      }
      fs.writeFileSync(dest, fixture(sources[src] ?? 'ios-system-crash.ips'));
      return { ok: true, json: { info: { outcome: 'success' } }, stdout: '', stderr: '' };
    }
    return { ok: false, error: 'unexpected', stdout: '', stderr: '' };
  };
  return { run, calls, setListing: (l: Record<string, unknown>) => (listing = l) };
}

describe('DeviceCrashWatcher (devicectl systemCrashLogs)', () => {
  it('copies the last 24 h of crash reports of installed apps, once', async () => {
    const dest = path.join(tmp(), 'crash', UDID);
    const fake = fakeDevicectl();
    const reports: Array<{ report: IpsReport; file: string }> = [];
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: fake.run,
      destDir: dest,
      logger: silentLogger,
      isInteresting: (name) => name === 'Runner' || name === 'Mahalle' || name === 'MobileSafari',
      onReport: (report, file) => reports.push({ report, file }),
      now: () => NOW,
    });
    await w.scan();
    expect(fake.calls[0]).toEqual(['device', 'info', 'files', '--device', UDID, '--domain-type', 'systemCrashLogs']);
    const copies = fake.calls.filter((c) => c[1] === 'copy');
    // Oldest first; JetsamEvent / Analytics / folders / > 24 h / not-installed (Instagram) are skipped.
    expect(copies.map((c) => c[c.indexOf('--source') + 1])).toEqual([
      'MobileSafari-2026-11-02-091201.ips',
      'Mahalle-2026-11-02-100514.ips',
      'Runner-2026-11-02-114258.ips',
    ]);
    expect(copies[0]).toEqual([
      'device',
      'copy',
      'from',
      '--device',
      UDID,
      '--domain-type',
      'systemCrashLogs',
      '--source',
      'MobileSafari-2026-11-02-091201.ips',
      '--destination',
      path.join(dest, 'MobileSafari-2026-11-02-091201.ips'),
    ]);
    // The system app crash is copied (name filter) but never reported.
    expect(reports.map((r) => r.report.bundleId)).toEqual(['com.mykynk.mahalle', 'com.mykynk.pati']);
    expect(reports[1]!.file).toBe(path.join(dest, 'Runner-2026-11-02-114258.ips'));
    expect(fs.existsSync(reports[1]!.file)).toBe(true);
    // Second scan: nothing new.
    await w.scan();
    expect(fake.calls.filter((c) => c[1] === 'copy')).toHaveLength(3);
    // A new file appears.
    const listing = JSON.parse(fixture('ios-devicectl-crashlogs.json')) as { result: { files: unknown[] } };
    listing.result.files.push({ name: 'Runner-2026-11-02-115900.ips', relativePath: 'Runner-2026-11-02-115900.ips', metadata: { lastModDate: '2026-11-02T08:59:01.000Z', size: 100 } });
    fake.setListing(listing as unknown as Record<string, unknown>);
    await w.scan();
    expect(fake.calls.filter((c) => c[1] === 'copy').map((c) => c[c.indexOf('--source') + 1]).pop()).toBe('Runner-2026-11-02-115900.ips');
    expect(reports).toHaveLength(3);
    await w.stop();
  });

  it('retries failed copies (up to 3 times) and treats listing failures as data', async () => {
    const dest = path.join(tmp(), 'crash', UDID);
    const fake = fakeDevicectl({ failCopies: 1 });
    const reports: IpsReport[] = [];
    const w = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: fake.run,
      destDir: dest,
      logger: silentLogger,
      isInteresting: (name) => name === 'Runner',
      onReport: (r) => reports.push(r),
      now: () => NOW,
    });
    await w.scan();
    expect(reports).toHaveLength(0);
    await w.scan();
    expect(reports.map((r) => r.bundleId)).toEqual(['com.mykynk.pati']);
    const broken = new DeviceCrashWatcher({
      udid: UDID,
      devicectl: async () => ({ ok: false, error: 'Device is locked', stdout: '', stderr: '' }),
      destDir: dest,
      logger: silentLogger,
      isInteresting: () => true,
      onReport: () => {
        throw new Error('never');
      },
    });
    await expect(broken.scan()).resolves.toBeUndefined();
    expect(localCrashName('Retired/Run ner-2026.ips')).toBe('Run_ner-2026.ips');
  });
});

describe('SimCrashWatcher (~/Library/Logs/DiagnosticReports)', () => {
  it('delivers third-party crashes of the right simulator, including ones from before it registered', async () => {
    const root = tmp();
    const retired = path.join(root, 'Retired');
    fs.mkdirSync(retired);
    // Fixed clock: the fixture reports are from 2026-11-02 (the 24 h window must not depend on today's date).
    const nowMs = Date.UTC(2026, 10, 2, 13, 0, 0);
    const put = (dir: string, name: string, content: string, mtime = nowMs) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, content);
      fs.utimesSync(f, mtime / 1000, mtime / 1000);
      return f;
    };
    const simCrash = fixture('ios-sim-crash.ips');
    put(root, 'Runner-2026-11-02-143109.ips', simCrash);
    // Other simulator, system app, Mac process, too old, not a crash report:
    put(retired, 'Runner-2026-11-02-120000.ips', simCrash.replace(SIM, '11111111-2222-3333-4444-555555555555'));
    put(root, 'PosterBoard-2026-11-02-120001.ips', simCrash.replace(/com\.mykynk\.pati/g, 'com.apple.PosterBoard'));
    put(root, 'node-2026-11-02-120002.ips', simCrash.replace('"platform":7', '"platform":1').replace(/SimDevice\.[0-9A-F-]+/, 'mac'));
    put(root, 'Runner-2026-10-20-120000.ips', simCrash, nowMs - 10 * 86_400_000);
    put(root, 'SFA-ckks.json_2026-11-02-121843_Mac.diag', '{}');

    const w = new SimCrashWatcher({ dirs: [root, retired], logger: silentLogger, intervalMs: 60_000, now: () => nowMs });
    await w.scan();
    const got: Array<{ report: IpsReport; file: string }> = [];
    const unregister = w.register(SIM.toLowerCase(), (report, file) => got.push({ report, file }));
    expect(got).toHaveLength(1);
    expect(got[0]!.report.bundleId).toBe('com.mykynk.pati');
    expect(got[0]!.file).toBe(path.join(root, 'Runner-2026-11-02-143109.ips'));
    // A new report (moved to Retired later keeps the same name → not delivered twice).
    put(root, 'Runner-2026-11-02-150000.ips', simCrash.replace('2026-11-02 14:31:09.5520', '2026-11-02 15:00:00.1000'));
    await w.scan();
    expect(got).toHaveLength(2);
    fs.renameSync(path.join(root, 'Runner-2026-11-02-150000.ips'), path.join(retired, 'Runner-2026-11-02-150000.ips'));
    await w.scan();
    expect(got).toHaveLength(2);
    unregister();
    await w.stop();
  });

  it('retries a report that is still being written', async () => {
    const root = tmp();
    const name = 'Runner-2026-11-02-160000.ips';
    const header = fixture('ios-sim-crash.ips').split('\n')[0]!;
    fs.writeFileSync(path.join(root, name), `${header}\n{\n  "uptime" : 3`);
    const w = new SimCrashWatcher({ dirs: [root], logger: silentLogger, intervalMs: 60_000, now: () => Date.UTC(2026, 10, 2, 13, 0, 0) });
    const got: IpsReport[] = [];
    w.register(SIM, (r) => got.push(r));
    await w.scan();
    expect(got).toHaveLength(0);
    fs.writeFileSync(path.join(root, name), fixture('ios-sim-crash.ips'));
    await w.scan();
    expect(got).toHaveLength(1);
    await w.stop();
  });

  it('never throws on a missing folder', async () => {
    const w = new SimCrashWatcher({ dirs: ['/nonexistent/durbun'], logger: silentLogger });
    await expect(w.scan()).resolves.toBeUndefined();
  });
});

describe('simulator apps (simctl listapps + host ps)', () => {
  const SIMDIR = `/Users/dev/Library/Developer/CoreSimulator/Devices/${SIM}`;

  it('lists user apps with IsDeveloperApp → debug/release', () => {
    const apps = parseSimInstalledApps(fixture('ios-simctl-listapps-user.txt'));
    expect(apps).toEqual([
      {
        id: 'com.mykynk.mahalle',
        name: 'Mahalle',
        version: '4.1.0',
        build: '412',
        buildType: 'release',
        source: 'simulator',
        executable: 'Mahalle',
        bundle: `${SIMDIR}/data/Containers/Bundle/Application/5D0F8B52-1C3E-4A7F-9B26-D8EAF3C5A719/Mahalle.app`,
      },
      {
        id: 'com.mykynk.pati',
        name: 'Pati',
        version: '2.4.0',
        build: '60',
        buildType: 'debug',
        source: 'simulator',
        executable: 'Runner',
        bundle: `${SIMDIR}/data/Containers/Bundle/Application/3C9E7A41-0B2D-4F6E-8A15-C7D9E2B4F608/Runner.app`,
      },
    ]);
    // The existing (system-only) capture has no user apps.
    expect(parseSimInstalledApps(fixture('simctl-listapps.txt'))).toEqual([]);
    expect(parseSimInstalledApps('garbage {')).toEqual([]);
  });

  it('finds app pids in the host process table', () => {
    const apps = parseSimInstalledApps(fixture('ios-simctl-listapps-user.txt'));
    const ps = [
      `  48211 ${SIMDIR}/data/Containers/Bundle/Application/3C9E7A41-0B2D-4F6E-8A15-C7D9E2B4F608/Runner.app/Runner -FlutterDart`,
      `  48230 ${SIMDIR}/data/Containers/Bundle/Application/3C9E7A41-0B2D-4F6E-8A15-C7D9E2B4F608/Runner.app/PlugIns/Widget.appex/Widget`,
      `  50001 /Users/dev/Library/Developer/CoreSimulator/Devices/AAAA/data/Containers/Bundle/Application/X/Runner.app/Runner`,
      '  303 /bin/zsh -il',
      `  47012 /Library/Developer/CoreSimulator/Volumes/iOS_24B8117/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.2.simruntime/Contents/Resources/RuntimeRoot/sbin/launchd_sim ${SIMDIR}/data/var/run/launchd_bootstrap.plist`,
    ].join('\n');
    expect(Object.fromEntries(simPidsFromPs(ps, apps))).toEqual({ 'com.mykynk.pati': [48211, 48230] });
    expect(simPidsFromPs('', apps).size).toBe(0);
  });
});
