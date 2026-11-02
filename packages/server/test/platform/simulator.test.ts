import { describe, expect, it } from 'vitest';
import type { DeviceLogInput } from '../../src/types';
import { parseSimLogLine, parseUnifiedTimestamp, SIM_APPS_PREDICATE, simLogStreamArgs } from '../../src/platform/ios/simlog';
import {
  contentSizeForScale,
  modelFromDeviceType,
  parseBootedDevices,
  parseListApps,
  parseRuntimeId,
  pidFromLaunchctl,
} from '../../src/platform/ios/simctl';
import { findSimProcessInPs, parsePsMetrics, parsePsTime } from '../../src/platform/ios/hostMetrics';
import {
  devicectlError,
  parseDevicectlApps,
  parseDevicectlDevices,
  parseDevicectlProcesses,
  pidsForApp,
  toInstalledApps,
} from '../../src/platform/ios/devicectl';
import { FlutterErrorGrouper } from '../../src/platform/shared/flutter';
import { fixture } from './helpers';

describe('simulator log stream (real `log stream --style ndjson` capture, iOS 27.2)', () => {
  const lines = fixture('simlog-real.ndjson').split('\n').filter(Boolean);

  it('skips the "Filtering the log data" header and activity events', () => {
    expect(lines[0]).toMatch(/^Filtering the log data using/);
    expect(parseSimLogLine(lines[0]!)).toBeNull();
    const parsed = lines.map((l) => parseSimLogLine(l));
    const activity = lines.filter((l) => l.includes('"eventType":"activityCreateEvent"'));
    expect(activity.length).toBeGreaterThan(0);
    for (const a of activity) expect(parseSimLogLine(a)).toBeNull();
    expect(parsed.filter(Boolean).length).toBe(lines.length - 1 - activity.length);
  });

  it('maps messageType, process, subsystem/category and timestamps', () => {
    const entries = lines.map((l) => parseSimLogLine(l)).filter((e): e is DeviceLogInput => !!e);
    const levels = new Set(entries.map((e) => e.level));
    expect(levels).toEqual(new Set(['info', 'error']));
    const first = entries[0]!;
    expect(first.process).toBe('PosterBoard');
    expect(first.subsystem).toBe('com.apple.FileURL');
    expect(first.category).toBe('default');
    expect(first.tag).toBe('com.apple.FileURL');
    expect(first.ts).toBeCloseTo(Date.UTC(2026, 10, 2, 9, 31, 28) + 150.149, 2);
    expect(typeof first.pid).toBe('number');
    expect(typeof first.tid).toBe('number');
    const faultLine = lines.find((l) => l.includes('"messageType":"Fault"'))!;
    const fault = parseSimLogLine(faultLine)!;
    expect(fault.level).toBe('error');
    expect(fault.message.length).toBeGreaterThan(0);
    const multi = entries.find((e) => e.message.includes('\n'));
    expect(multi).toBeDefined();
  });

  it('uses the sender image as tag when there is no subsystem', () => {
    const line = JSON.parse(lines[1]!) as Record<string, unknown>;
    const e = parseSimLogLine(JSON.stringify({ ...line, subsystem: '', category: '' }))!;
    expect(e.tag).toBe(String(line.senderImagePath).split('/').pop());
    expect(e.subsystem).toBeUndefined();
  });

  it('turns "flutter: " prints of a Runner app into tag flutter at info level and groups error boxes', () => {
    const template = JSON.parse(lines[1]!) as Record<string, unknown>;
    const runner = (message: string, messageType = 'Default') =>
      JSON.stringify({
        ...template,
        messageType,
        subsystem: '',
        category: '',
        processID: 4242,
        processImagePath:
          '/Users/dev/Library/Developer/CoreSimulator/Devices/X/data/Containers/Bundle/Application/Y/Runner.app/Runner',
        senderImagePath: '/Users/dev/Library/Developer/CoreSimulator/Devices/X/data/Containers/Bundle/Application/Y/Runner.app/Frameworks/Flutter.framework/Flutter',
        eventMessage: message,
      });
    const p = parseSimLogLine(runner('flutter: Merhaba 👋', 'Error'))!;
    expect(p).toMatchObject({ tag: 'flutter', level: 'info', process: 'Runner', message: 'Merhaba 👋' });
    const out: DeviceLogInput[] = [];
    const g = new FlutterErrorGrouper((e) => out.push(e));
    for (const m of [
      'flutter: ══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═════════════════════════════',
      'flutter: The following assertion was thrown:',
      'flutter: ═════════════════════════════════════════════════════════════════════',
    ]) {
      g.push(parseSimLogLine(runner(m))!);
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'flutter-error', level: 'error', process: 'Runner' });
    const engine = parseSimLogLine(
      runner('[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: boom'),
    )!;
    expect(engine.tag).toBe('flutter');
  });

  it('parses unified-log timestamps with zones', () => {
    expect(parseUnifiedTimestamp('2026-11-02 12:31:28.150149+0300')).toBeCloseTo(Date.UTC(2026, 10, 2, 9, 31, 28) + 150.149, 3);
    expect(parseUnifiedTimestamp('2026-11-02 09:31:28.5Z')).toBe(Date.UTC(2026, 10, 2, 9, 31, 28) + 500);
    expect(parseUnifiedTimestamp('2026-11-02 12:31:28-05:30')).toBe(Date.UTC(2026, 10, 2, 18, 1, 28));
    expect(parseUnifiedTimestamp('garbage')).toBeUndefined();
  });

  it('builds the log stream arguments from settings', () => {
    expect(simLogStreamArgs({ iosSimLogScope: 'apps', iosSimLogLevel: 'info' })).toEqual([
      'log',
      'stream',
      '--style',
      'ndjson',
      '--level',
      'info',
      '--predicate',
      SIM_APPS_PREDICATE,
    ]);
    expect(simLogStreamArgs({ iosSimLogScope: 'all', iosSimLogLevel: 'debug' })).toEqual([
      'log',
      'stream',
      '--style',
      'ndjson',
      '--level',
      'debug',
    ]);
  });

  it('rejects garbage', () => {
    expect(parseSimLogLine('{not json')).toBeNull();
    expect(parseSimLogLine('Child process terminated with signal 15: Terminated')).toBeNull();
    expect(parseSimLogLine('{"eventType":"signpostEvent"}')).toBeNull();
  });
});

describe('simctl output', () => {
  it('parses `simctl list devices booted -j` (real capture)', () => {
    const sims = parseBootedDevices(fixture('simctl-booted.json'));
    expect(sims).toEqual([
      {
        udid: '133A4688-E13E-4080-A1E2-0F6CF49FD4C5',
        name: 'durbun-test',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
        platform: 'ios',
        osVersion: '27.2',
        model: 'iPhone 17',
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
      },
    ]);
    expect(parseBootedDevices('not json')).toEqual([]);
  });

  it('parses runtime ids and device types', () => {
    expect(parseRuntimeId('com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4')).toEqual({
      platform: 'ios',
      os: 'iOS',
      osVersion: '27.2',
    });
    expect(parseRuntimeId('com.apple.CoreSimulator.SimRuntime.watchOS-11-0').platform).toBe('other');
    expect(parseRuntimeId('com.apple.CoreSimulator.SimRuntime.iOS-17-0-1').osVersion).toBe('17.0.1');
    expect(modelFromDeviceType('com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max')).toBe('iPhone 17 Pro Max');
  });

  it('parses `simctl listapps` (OpenStep plist, real capture)', () => {
    const text = fixture('simctl-listapps.txt');
    expect(parseListApps(text, false)).toEqual([]);
    const all = parseListApps(text, true);
    expect(all.map((a) => a.id)).toEqual(['com.apple.Bridge', 'com.apple.CarPlayApp', 'com.apple.DocumentsApp']);
    expect(all[0]).toEqual({ id: 'com.apple.Bridge', name: 'Watch', version: '1.0', system: true, debuggable: false });
    const user = parseListApps(
      '{ "com.mykynk.pati" = { ApplicationType = User; CFBundleDisplayName = Pati; CFBundleShortVersionString = "1.4.2"; CFBundleIdentifier = "com.mykynk.pati"; IsDeveloperApp = 1; }; }',
      false,
    );
    expect(user).toEqual([{ id: 'com.mykynk.pati', name: 'Pati', version: '1.4.2', system: false, debuggable: true }]);
  });

  it('maps font scales to Dynamic Type content sizes', () => {
    expect(contentSizeForScale(1)).toBe('large');
    expect(contentSizeForScale(0.85)).toBe('extra-small');
    expect(contentSizeForScale(1.15)).toBe('extra-large');
    expect(contentSizeForScale(1.3)).toBe('extra-extra-extra-large');
    expect(contentSizeForScale(2)).toBe('accessibility-large');
    expect(contentSizeForScale(4)).toBe('accessibility-extra-extra-extra-large');
  });

  it('finds app pids via launchctl list (real format)', () => {
    const text = [
      'PID\tStatus\tLabel',
      '-\t0\tcom.apple.progressd',
      '71737\t0\tUIKitApplication:com.apple.Spotlight[4f70][rb-legacy]',
      '73703\t0\tUIKitApplication:com.apple.Preferences[1a2b][rb-legacy]',
    ].join('\n');
    expect(pidFromLaunchctl(text, 'com.apple.Preferences')).toBe(73703);
    expect(pidFromLaunchctl(text, 'com.apple.Pref')).toBeUndefined();
  });
});

describe('host ps metrics', () => {
  it('parses ps time and metric columns', () => {
    expect(parsePsTime('111:33.59')).toBeCloseTo(6693.59, 2);
    expect(parsePsTime('0:00.01')).toBeCloseTo(0.01, 3);
    expect(parsePsTime('1-02:03:04')).toBe(86400 + 7384);
    expect(parsePsMetrics('  0.0   2688   0:00.01\n')).toEqual({ cpuPct: 0, rssKB: 2688, cpuSeconds: 0.01 });
    expect(parsePsMetrics('')).toBeUndefined();
  });

  it('finds a simulator app process of this simulator only', () => {
    const ps = [
      '  101 /Users/dev/Library/Developer/CoreSimulator/Devices/AAAA/data/Containers/Bundle/Application/X/Runner.app/Runner',
      '  202 /Users/dev/Library/Developer/CoreSimulator/Devices/BBBB/data/Containers/Bundle/Application/Y/Runner.app/Runner',
      '  303 /bin/zsh',
    ].join('\n');
    expect(findSimProcessInPs(ps, 'BBBB', 'Runner')).toBe(202);
    expect(findSimProcessInPs(ps, 'AAAA', 'Runner')).toBe(101);
    expect(findSimProcessInPs(ps, 'CCCC', 'Runner')).toBeUndefined();
  });
});

describe('devicectl JSON (real captures, Xcode 27.2 / devicectl 651.32)', () => {
  it('parses `device info apps`', () => {
    const json = JSON.parse(fixture('devicectl-apps.json')) as Record<string, unknown>;
    const apps = parseDevicectlApps(json);
    expect(apps).toHaveLength(4);
    expect(apps[0]).toMatchObject({ bundleIdentifier: 'com.apple.ActivityMessagesApp', builtByDeveloper: false, defaultApp: true });
    const installed = toInstalledApps(apps);
    expect(installed.every((a) => a.system === true && a.debuggable === false)).toBe(true);
  });

  it('parses `device info processes` and matches executables to app bundles', () => {
    const json = JSON.parse(fixture('devicectl-processes.json')) as Record<string, unknown>;
    expect(parseDevicectlProcesses(json).length).toBeGreaterThan(0);
    const procs = [
      { pid: 812, executable: 'file:///private/var/containers/Bundle/Application/AB12/Runner.app/Runner' },
      { pid: 813, executable: 'file:///var/containers/Bundle/Application/AB12/Runner.app/PlugIns/W.appex/W' },
      { pid: 900, executable: 'file:///usr/libexec/backboardd' },
    ];
    expect(pidsForApp(procs, 'file:///private/var/containers/Bundle/Application/AB12/Runner.app/')).toEqual([812, 813]);
  });

  it('parses `list devices` (real capture of a physical iPhone + simulator)', () => {
    const devices = parseDevicectlDevices(JSON.parse(fixture('devicectl-devices.json')) as Record<string, unknown>);
    const phone = devices.find((d) => d.reality === 'physical')!;
    expect(phone).toMatchObject({
      udid: '00008130-000A1B2C3D4E001F',
      name: 'Test iPhone’u',
      marketingName: 'iPhone 15 Pro Max',
      productType: 'iPhone16,2',
      osVersion: '27.2',
      connectionState: 'unavailable',
    });
    expect(devices.find((d) => d.reality === 'simulated')?.marketingName).toBe('iPhone 17 Pro Max');
  });

  it('extracts readable errors', () => {
    expect(
      devicectlError(
        { error: { userInfo: { NSLocalizedDescription: { string: 'The device is locked.' }, NSLocalizedFailureReason: { string: 'Unlock it.' } } } },
        '',
      ),
    ).toBe('The device is locked. Unlock it.');
    expect(devicectlError(undefined, 'Some log\nERROR: Failed to load provisioning paramter list\n')).toBe(
      'Failed to load provisioning paramter list',
    );
  });
});
