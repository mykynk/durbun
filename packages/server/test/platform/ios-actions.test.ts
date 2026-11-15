/**
 * Simulator and iPhone device actions with fake `simctl` / `devicectl` runners: the commands they run, how
 * failures read, and that clearing a simulator app's data only ever touches that app's data container.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/platform/exec';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { runIosDeviceAction, type IosDeviceActionTarget } from '../../src/platform/ios/deviceActions';
import { runSimAction, type SimActionTarget } from '../../src/platform/ios/simActions';
import { ScreenRecorder } from '../../src/platform/shared/screenRecord';
import { createCtx } from './helpers';

const SIM = '5B0C9A3E-7F41-4D2B-9E6A-1C8D3F5A7B20';
const UDID = '00008130-000A1B2C3D4E001F';

const ok = (stdout = ''): RunResult<string> => ({ ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false });
const bad = (stderr: string, code = 1): RunResult<string> => ({ ok: false, code, signal: null, stdout: '', stderr, timedOut: false });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeSimctl(handler: (args: string[]) => RunResult<string> | undefined = () => undefined) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return handler(args) ?? ok();
  };
  return { run, calls };
}

function simTarget(simctl: SimActionTarget['simctl']): SimActionTarget {
  return { udid: SIM, deviceId: `ios-sim:${SIM}`, label: 'iPhone 17 Pro', ctx: createCtx(), restartLogs: async () => undefined, recorder: new ScreenRecorder(() => undefined), simctl };
}

/** A data container laid out like CoreSimulator's (…/Devices/<udid>/data/Containers/Data/Application/<uuid>). */
function dataContainer(udid = SIM): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-simdata-'));
  dirs.push(root);
  const dir = path.join(root, 'Devices', udid, 'data', 'Containers', 'Data', 'Application', '8E2F1A6C-3B9D-4C70-A5E4-2D7B9C1F0E36');
  fs.mkdirSync(path.join(dir, 'Documents', 'hive'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Library', 'Preferences'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Documents', 'hive', 'cart.hive'), 'sepet');
  fs.writeFileSync(path.join(dir, 'Library', 'Preferences', 'com.mykynk.pati.plist'), 'prefs');
  fs.writeFileSync(path.join(dir, '.com.apple.mobile_container_manager.metadata.plist'), 'metadata');
  return dir;
}

describe('simulator actions', () => {
  it('clears an app’s data: terminate, empty the container, keep its metadata, restart cfprefsd', async () => {
    const dir = dataContainer();
    const sim = fakeSimctl((args) => (args[0] === 'get_app_container' ? ok(`${dir}\n`) : undefined));
    const r = await runSimAction(simTarget(sim.run), 'app-clear-data', { appId: 'com.mykynk.pati' });
    expect(r).toMatchObject({ ok: true, message: 'Cleared data of com.mykynk.pati' });
    expect(sim.calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['get_app_container ' + SIM, 'terminate ' + SIM, 'spawn ' + SIM]);
    expect(sim.calls[0]).toEqual(['get_app_container', SIM, 'com.mykynk.pati', 'data']);
    expect(fs.existsSync(path.join(dir, 'Documents', 'hive'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'Library', 'Preferences'))).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.com.apple.mobile_container_manager.metadata.plist'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tmp'))).toBe(true);
  });

  it('refuses a container outside this simulator’s data folder and an app that is not installed', async () => {
    const other = dataContainer('11111111-2222-3333-4444-555555555555');
    const sim = fakeSimctl((args) => (args[0] === 'get_app_container' ? ok(other) : undefined));
    const r = await runSimAction(simTarget(sim.run), 'app-clear-data', { appId: 'com.mykynk.pati' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Refusing to clear an unexpected container path/);
    expect(fs.existsSync(path.join(other, 'Documents', 'hive', 'cart.hive'))).toBe(true);
    const missing = fakeSimctl((args) => (args[0] === 'get_app_container' ? bad('An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\nNo such file or directory') : undefined));
    expect(await runSimAction(simTarget(missing.run), 'app-clear-data', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: false, code: 'action.appNotFound' });
    expect(await runSimAction(simTarget(missing.run), 'app-uninstall', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: false, code: 'action.appNotFound' });
    expect(await runSimAction(simTarget(missing.run), 'app-clear-data', { appId: '../etc' })).toMatchObject({ ok: false, code: 'action.invalidParams' });
  });

  it('launches, stops (also when nothing runs), opens URLs and reads simctl errors', async () => {
    const sim = fakeSimctl((args) => {
      if (args[0] === 'terminate') return bad('An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=164):\nfound nothing to terminate');
      if (args[0] === 'launch' && args[2] === 'com.mykynk.yok') return bad('An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4):\nThe request to open "com.mykynk.yok" failed.');
      return undefined;
    });
    const t = simTarget(sim.run);
    expect(await runSimAction(t, 'app-stop', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: true });
    expect(await runSimAction(t, 'app-restart', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: true, message: 'Restarted com.mykynk.pati' });
    const failed = await runSimAction(t, 'app-launch', { appId: 'com.mykynk.yok' });
    expect(failed).toMatchObject({ ok: false, code: 'action.launchFailed', message: 'Could not launch com.mykynk.yok: The request to open "com.mykynk.yok" failed.' });
    expect(await runSimAction(t, 'open-url', { url: 'pati://sepet?id=42' })).toMatchObject({ ok: true });
    expect(sim.calls).toContainEqual(['openurl', SIM, 'pati://sepet?id=42']);
    expect(await runSimAction(t, 'appearance', { mode: 'dark' })).toMatchObject({ ok: true });
    expect(sim.calls).toContainEqual(['ui', SIM, 'appearance', 'dark']);
  });
});

describe('iPhone actions (devicectl)', () => {
  function deviceTarget(openURL: boolean) {
    const calls: string[][] = [];
    const devicectl = async (args: string[]): Promise<DevicectlResult> => {
      calls.push(args);
      return { ok: true, json: { info: { outcome: 'success' } }, stdout: '', stderr: '' };
    };
    const t: IosDeviceActionTarget = {
      udid: UDID,
      deviceId: `ios:${UDID}`,
      label: 'Test iPhone',
      ctx: createCtx(),
      caps: { available: true, screenshot: false, screenRecord: false, openURL },
      screenshotTool: null,
      syslogAvailable: true,
      restartLogs: async () => undefined,
      devicectl,
      recorder: new ScreenRecorder(() => undefined),
    };
    return { t, calls };
  }

  it('opens a URL in the given app, with openURL, or through Safari on an older devicectl', async () => {
    const withApp = deviceTarget(true);
    await runIosDeviceAction(withApp.t, 'open-url', { url: 'pati://sepet', appId: 'com.mykynk.pati' });
    expect(withApp.calls[0]).toEqual(['device', 'process', 'launch', '--device', UDID, '--payload-url', 'pati://sepet', 'com.mykynk.pati']);
    const modern = deviceTarget(true);
    await runIosDeviceAction(modern.t, 'open-url', { url: 'https://example.com' });
    expect(modern.calls[0]).toEqual(['device', 'process', 'openURL', '--device', UDID, 'https://example.com']);
    const older = deviceTarget(false);
    await runIosDeviceAction(older.t, 'open-url', { url: 'https://example.com' });
    expect(older.calls[0]!.slice(0, 7)).toEqual(['device', 'process', 'launch', '--device', UDID, '--payload-url', 'https://example.com']);
    expect(await runIosDeviceAction(older.t, 'open-url', {})).toMatchObject({ ok: false, code: 'action.invalidParams' });
  });

  it('falls back to idevicescreenshot when devicectl cannot capture, and says both errors when neither can', async () => {
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-shot-'));
    dirs.push(tools);
    const tool = path.join(tools, 'idevicescreenshot');
    // 1×1 PNG written to the path given last, like idevicescreenshot -u <udid> <file>.
    fs.writeFileSync(
      tool,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv[process.argv.length - 1], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));\n`,
    );
    fs.chmodSync(tool, 0o755);
    const { t, calls } = deviceTarget(true);
    const failing: IosDeviceActionTarget = {
      ...t,
      caps: { ...t.caps, screenshot: true },
      devicectl: async (args) => {
        calls.push(args);
        return { ok: false, error: 'The developer disk image could not be mounted.', stdout: '', stderr: '' };
      },
    };
    const r = await runIosDeviceAction({ ...failing, screenshotTool: { path: tool, source: 'path' } }, 'screenshot', {});
    expect(r).toMatchObject({ ok: true, code: 'action.screenshot.saved' });
    expect(calls[0]!.slice(0, 3)).toEqual(['device', 'capture', 'screenshot']);
    const none = await runIosDeviceAction(failing, 'screenshot', {});
    expect(none.ok).toBe(false);
    expect(none.message).toContain('The developer disk image could not be mounted.');
  });
});

describe('Xcode set-up problems in the doctor', () => {
  it('names the command that fixes a known simctl failure', async () => {
    const { xcodeFix } = await import('../../src/platform/ios/simDriver');
    expect(
      xcodeFix('simctl list failed: xcrun: error: Agreeing to the Xcode/iOS license requires admin privileges, please run “sudo xcodebuild -license” and then retry this command.'),
    ).toBe('sudo xcodebuild -license accept');
    expect(xcodeFix('simctl list failed: CoreSimulator is out of date. Current version (1010.10) is older than build version (1051.9).')).toBe('xcodebuild -runFirstLaunch');
    expect(xcodeFix('simctl list failed: exit 1')).toBeUndefined();
  });
});
