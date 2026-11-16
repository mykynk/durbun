/**
 * iOS: why an iPhone action is missing (DeviceInfo.unavailableActions), "uninstall and install" on iPhones and
 * simulators, the simulator's permission and keychain actions, and cheap simulator polling (no simctl call
 * while nothing is booted). Fake runners only: no simctl, devicectl or ps of this Mac is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DevicectlCaps, DevicectlResult } from '../../src/platform/ios/devicectl';
import { BUNDLE_INFO, iosInstallRefusalCode } from '../../src/platform/ios/bundleInfo';
import { iosDeviceActionAvailability, runIosDeviceAction, type IosDeviceActionTarget } from '../../src/platform/ios/deviceActions';
import { runSimAction, SIM_ACTIONS, type SimActionTarget } from '../../src/platform/ios/simActions';
import { IosSimDriver, simulatorProcesses, type BootedProbe } from '../../src/platform/ios/simDriver';
import type { RunResult } from '../../src/platform/exec';
import { ScreenRecorder } from '../../src/platform/shared/screenRecord';
import { createCtx, waitFor } from './helpers';

const ok = (stdout = ''): RunResult<string> => ({ ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false });
const bad = (stderr: string): RunResult<string> => ({ ok: false, code: 1, signal: null, stdout: '', stderr, timedOut: false });
const ALL: DevicectlCaps = { available: true, screenshot: true, screenRecord: true, openURL: true };
const NONE: DevicectlCaps = { available: false, screenshot: false, screenRecord: false, openURL: false };

describe('why an iPhone action is missing', () => {
  it('untrusted: nothing either way (the device state says why)', () => {
    expect(iosDeviceActionAvailability({ trusted: false, caps: ALL, screenshotTool: true, syslog: true })).toEqual({ actions: [], unavailable: [] });
  });

  it('no Xcode and no libimobiledevice tools: each action names the missing tool', () => {
    const { actions, unavailable } = iosDeviceActionAvailability({ trusted: true, caps: NONE, screenshotTool: false, syslog: false });
    expect(actions).toEqual([]);
    expect(unavailable).toContainEqual({
      action: 'app-launch',
      code: 'action.toolMissing',
      params: { tool: 'devicectl', detail: 'Xcode 15 or newer (xcrun devicectl)', minXcode: '15' },
    });
    expect(unavailable).toContainEqual(
      expect.objectContaining({
        action: 'screenshot',
        code: 'action.toolMissing',
        params: expect.objectContaining({ tool: 'idevicescreenshot', minXcode: '15', install: 'brew install libimobiledevice' }),
      }),
    );
    expect(unavailable).toContainEqual({ action: 'logs-restart', code: 'logs.idevicesyslogMissing', params: { tool: 'idevicesyslog' } });
  });

  it('Developer Mode off: the actions that need it, not the app list', () => {
    const { actions, unavailable } = iosDeviceActionAvailability({ trusted: true, caps: ALL, screenshotTool: true, syslog: true, developerModeOff: true, osVersion: '18.2' });
    expect(actions).toEqual(['list-apps', 'app-uninstall', 'logs-restart']);
    expect(unavailable.map((u) => [u.action, u.code])).toEqual([
      ['app-launch', 'action.developerModeOff'],
      ['app-stop', 'action.developerModeOff'],
      ['app-restart', 'action.developerModeOff'],
      ['app-install', 'action.developerModeOff'],
      ['open-url', 'action.developerModeOff'],
      ['screenshot', 'action.developerModeOff'],
      ['screen-record', 'action.developerModeOff'],
      ['screen-record-stop', 'action.developerModeOff'],
    ]);
  });

  it('iOS 16: devicectl actions say the iOS is too old; idevicescreenshot still takes screenshots', () => {
    const { actions, unavailable } = iosDeviceActionAvailability({ trusted: true, caps: ALL, screenshotTool: true, syslog: true, osVersion: '16.7.10' });
    expect(actions).toEqual(['screenshot', 'logs-restart']);
    expect(unavailable).toContainEqual({ action: 'list-apps', code: 'action.osTooOld', params: { osVersion: '16.7.10', minVersion: '17' } });
  });

  it('an Xcode without devicectl screen recording', () => {
    const { unavailable } = iosDeviceActionAvailability({ trusted: true, caps: { ...ALL, screenRecord: false }, screenshotTool: false, syslog: true, osVersion: '18.1' });
    expect(unavailable).toEqual([
      { action: 'screen-record', code: 'action.toolTooOld', params: { tool: 'devicectl', detail: 'a newer Xcode (devicectl screen recording)', from: 'Xcode' } },
      { action: 'screen-record-stop', code: 'action.toolTooOld', params: { tool: 'devicectl', detail: 'a newer Xcode (devicectl screen recording)', from: 'Xcode' } },
    ]);
  });
});

describe('"uninstall and install"', () => {
  let dir: string;
  let app: string;
  const savedPlutil = BUNDLE_INFO.plutil;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-replace-'));
    app = path.join(dir, 'Runner.app');
    fs.mkdirSync(app);
    BUNDLE_INFO.plutil = async (args) => (args.includes('CFBundleIdentifier') && args[args.length - 1] === path.join(app, 'Info.plist') ? ok('com.mykynk.pati\n') : bad('no such file'));
  });
  afterAll(() => {
    BUNDLE_INFO.plutil = savedPlutil;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function iphone(reply: (args: string[]) => DevicectlResult) {
    const calls: string[] = [];
    const t: IosDeviceActionTarget = {
      udid: '00008120-001A2B3C4D5E6F70',
      deviceId: 'ios:00008120-001A2B3C4D5E6F70',
      label: 'iPhone 15',
      ctx: createCtx(),
      caps: ALL,
      screenshotTool: null,
      syslogAvailable: true,
      restartLogs: async () => undefined,
      recorder: new ScreenRecorder(() => undefined),
      devicectl: async (args) => {
        calls.push(args.slice(0, 3).join(' '));
        return reply(args);
      },
    };
    return { t, calls };
  }
  const MISMATCH =
    "Failed to install the app on the device. (com.apple.dt.CoreDeviceError error 3002.) Upgrade's application-identifier entitlement string (ABCDE12345.com.mykynk.pati) does not match installed application's application-identifier string (ZYXWV98765.com.mykynk.pati); rejecting upgrade. (MIInstallerErrorDomain error 13: MismatchedApplicationIdentifierEntitlement)";

  it('iPhone: a build of another team over the installed copy names the bundle id', async () => {
    const { t } = iphone((args) => (args[1] === 'install' ? { ok: false, error: MISMATCH, stdout: '', stderr: '' } : { ok: true, stdout: '', stderr: '' }));
    expect(await runIosDeviceAction(t, 'app-install', { file: app })).toMatchObject({
      ok: false,
      code: 'action.install.signatureMismatch',
      data: { packageId: 'com.mykynk.pati', replaceable: true },
    });
    expect(iosInstallRefusalCode('Device is locked')).toBeUndefined();
  });

  it('iPhone: replace uninstalls first, then installs; a failed uninstall changes nothing', async () => {
    const good = iphone(() => ({ ok: true, stdout: '', stderr: '' }));
    expect(await runIosDeviceAction(good.t, 'app-install', { file: app, replace: true })).toMatchObject({
      ok: true,
      code: 'action.install.replaced',
      data: { packageId: 'com.mykynk.pati' },
    });
    expect(good.calls).toEqual(['device uninstall app', 'device install app']);
    const stuck = iphone((args) => (args[1] === 'uninstall' ? { ok: false, error: 'The device is locked.', stdout: '', stderr: '' } : { ok: true, stdout: '', stderr: '' }));
    expect(await runIosDeviceAction(stuck.t, 'app-install', { file: app, replace: true })).toMatchObject({ ok: false, code: 'action.install.replaceUninstallFailed' });
    expect(stuck.calls).toEqual(['device uninstall app']);
  });

  it('simulator: replace, and the bundle id must be readable', async () => {
    const calls: string[][] = [];
    const t: SimActionTarget = {
      udid: '133A4688-E13E-4080-A1E2-0F6CF49FD4C5',
      deviceId: 'ios-sim:133A4688-E13E-4080-A1E2-0F6CF49FD4C5',
      label: 'iPhone 17 Pro',
      ctx: createCtx(),
      restartLogs: async () => undefined,
      recorder: new ScreenRecorder(() => undefined),
      simctl: async (args) => {
        calls.push(args);
        return ok();
      },
    };
    expect(await runSimAction(t, 'app-install', { file: app, replace: true })).toMatchObject({ ok: true, code: 'action.install.replaced' });
    expect(calls.map((c) => c[0])).toEqual(['uninstall', 'install']);
    const other = path.join(dir, 'Other.app');
    fs.mkdirSync(other);
    expect(await runSimAction(t, 'app-install', { file: other, replace: true })).toMatchObject({ ok: false, code: 'action.install.packageUnknown' });
  });
});

describe('simulator permissions and keychain', () => {
  function sim() {
    const calls: string[][] = [];
    const t: SimActionTarget = {
      udid: 'SIM-1',
      deviceId: 'ios-sim:SIM-1',
      label: 'iPhone 17',
      ctx: createCtx(),
      restartLogs: async () => undefined,
      recorder: new ScreenRecorder(() => undefined),
      simctl: async (args) => {
        calls.push(args);
        return ok();
      },
    };
    return { t, calls };
  }

  it('grants, revokes and resets (simctl privacy) and refuses unknown services', async () => {
    const { t, calls } = sim();
    expect(SIM_ACTIONS).toEqual(expect.arrayContaining(['app-permission', 'keychain-reset']));
    await runSimAction(t, 'app-permission', { appId: 'com.mykynk.pati', permission: 'location', grant: true });
    await runSimAction(t, 'app-permission', { appId: 'com.mykynk.pati', permission: 'photos', grant: false });
    expect(await runSimAction(t, 'app-permission', { appId: 'com.mykynk.pati', permission: 'camera', grant: true })).toMatchObject({ code: 'action.invalidParams' });
    expect(await runSimAction(t, 'app-permission', { appId: 'com.mykynk.pati', permission: 'photos', restore: true })).toMatchObject({ ok: true, code: 'action.permissionReset' });
    await runSimAction(t, 'keychain-reset', {});
    expect(calls).toEqual([
      ['privacy', 'SIM-1', 'grant', 'location', 'com.mykynk.pati'],
      ['privacy', 'SIM-1', 'revoke', 'photos', 'com.mykynk.pati'],
      ['privacy', 'SIM-1', 'reset', 'photos', 'com.mykynk.pati'],
      ['keychain', 'SIM-1', 'reset'],
    ]);
  });
});

describe('simulator polling', () => {
  let dir: string;
  let driver: IosSimDriver | undefined;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-sim-poll-'));
  });
  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function makeDriver(probe: BootedProbe) {
    const lists: string[][] = [];
    driver = new IosSimDriver({
      // Nothing is ever booted here, so no simulator session (and no real `log stream`) starts.
      simctl: async (args) => {
        lists.push(args);
        return ok('{"devices":{}}');
      },
      bootedProbe: probe,
      xcodeTools: async () => ({ available: true, xcrun: '/usr/bin/xcrun', simctl: true, devicectl: false }),
      pollMs: { active: 30, idle: 120 },
      diagnosticReportDirs: [dir],
      appSource: () => ({ listInstalled: async () => null, listRunning: async () => null }),
    });
    return { driver, lists };
  }

  it('reads process names: a booted simulator, Simulator.app open, or nothing', () => {
    expect(simulatorProcesses('launchd\nlaunchd_sim\nSpringBoard\n')).toBe('booted');
    expect(simulatorProcesses('launchd\nSimulator\n')).toBe('app');
    expect(simulatorProcesses('launchd\nCoreSimulatorService\n')).toBe('none');
  });

  it('lists once at start, then not while nothing runs; recheck() lists at once', async () => {
    let probes = 0;
    const { driver: d, lists } = makeDriver(async () => {
      probes += 1;
      return 'none';
    });
    await d.start(createCtx());
    await waitFor(() => probes >= 3, 3000);
    expect(lists.length).toBe(1);
    d.recheck();
    await waitFor(() => lists.length === 2, 3000);
    d.resume();
    await waitFor(() => lists.length === 3, 3000);
  });

  it('lists as soon as a simulator boots; Simulator.app alone keeps checking often without simctl', async () => {
    let state: 'none' | 'app' | 'booted' = 'app';
    let probes = 0;
    const { driver: d, lists } = makeDriver(async () => {
      probes += 1;
      return state;
    });
    await d.start(createCtx());
    await waitFor(() => probes >= 4, 3000);
    expect(lists.length).toBe(1);
    state = 'booted';
    await waitFor(() => lists.length >= 2, 3000);
  });

  it('cannot tell (no ps): lists with simctl as before', async () => {
    const { driver: d, lists } = makeDriver(async () => undefined);
    await d.start(createCtx());
    await waitFor(() => lists.length >= 3, 3000);
  });
});
