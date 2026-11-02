/**
 * Phase-3 wiring of the physical iOS driver: syslog origin, DeviceApps from devicectl + syslog, crash
 * reports from systemCrashLogs → LogEntry + crashReports, cleanup on detach. usbmuxd, idevicesyslog and
 * devicectl are fakes (no device needed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveChildCount } from '../../src/platform/exec';
import type { DevicectlResult } from '../../src/platform/ios/devicectl';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { createCtx, fixture, waitFor, type FakeCtx } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const ID = `ios:${UDID}`;

function writeFakeSyslog(dir: string): string {
  const file = path.join(dir, 'idevicesyslog');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const udid = process.argv[process.argv.indexOf('-u') + 1];
process.stdout.write([
  '[connected:' + udid + ']',
  'Nov  2 11:43:01 Test-iPhoneu Mahalle(CFNetwork)[2210] <Notice>: Task <1A2B>.<1> finished',
  'Nov  2 11:43:01.123456 Test iPhone’u Runner(Flutter)[1234] <Notice>: flutter: sepet yüklendi',
].join('\\n') + '\\n');
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function fakeDevicectl() {
  const calls: string[][] = [];
  const hourAgo = new Date(Date.now() - 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const crashName = `Runner-${hourAgo.getFullYear()}-${p(hourAgo.getMonth() + 1)}-${p(hourAgo.getDate())}-${p(hourAgo.getHours())}${p(
    hourAgo.getMinutes(),
  )}${p(hourAgo.getSeconds())}.ips`;
  const run = async (args: string[]): Promise<DevicectlResult> => {
    calls.push(args);
    const ok = (json: Record<string, unknown>): DevicectlResult => ({ ok: true, json, stdout: '', stderr: '' });
    if (args[0] === 'list') return { ok: false, error: 'not in tests', stdout: '', stderr: '' };
    if (args[2] === 'apps') {
      return ok(JSON.parse(fixture(args.includes('--include-all-apps') ? 'ios-devicectl-apps-all.json' : 'ios-devicectl-apps-developer.json')));
    }
    if (args[2] === 'processes') return ok(JSON.parse(fixture('ios-devicectl-processes.json')));
    if (args[2] === 'files') {
      return ok({
        result: {
          files: [{ name: crashName, relativePath: crashName, metadata: { lastModDate: hourAgo.toISOString(), size: 7548 } }],
        },
      });
    }
    if (args[1] === 'copy') {
      fs.writeFileSync(args[args.indexOf('--destination') + 1]!, fixture('ios-swift-crash.ips'));
      return ok({ info: { outcome: 'success' } });
    }
    return { ok: false, error: `unexpected ${args.join(' ')}`, stdout: '', stderr: '' };
  };
  return { run, calls, crashName };
}

describe('IosDeviceDriver · device apps and crash reports', () => {
  let mux: FakeUsbmuxd;
  let dir: string;
  let ctx: FakeCtx;
  let driver: IosDeviceDriver;
  let dctl: ReturnType<typeof fakeDevicectl>;

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-apps-'));
    ctx = createCtx({ settings: { idevicesyslogPath: writeFakeSyslog(dir) } });
    dctl = fakeDevicectl();
    driver = new IosDeviceDriver({
      socketPath: mux.socketPath,
      devicectl: dctl.run,
      timing: { appsEveryMs: 60_000, processesEveryMs: 1000, crashesEveryMs: 1000, crashStartDelayMs: 100 },
    });
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
  });

  afterEach(async () => {
    await driver.stop();
    await mux.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports running apps, tags syslog lines and turns crash reports into log entries', async () => {
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);

    // Syslog lines carry their origin.
    await waitFor(() => ctx.hub.logs.some((l) => l.entry.tag === 'flutter'));
    const syslogLines = ctx.hub.logs.filter((l) => l.entry.origin === 'idevicesyslog');
    expect(syslogLines.length).toBeGreaterThanOrEqual(2);

    // DeviceApps from devicectl (developer list → xcode/debug, others → store-or-testflight/release).
    const pati = await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`));
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`)?.pids.length === 2);
    expect(ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`)).toMatchObject({
      name: 'Pati',
      version: '2.3.0',
      build: '57',
      buildType: 'debug',
      install: { source: 'xcode' },
      processName: 'Runner',
      pids: [1234, 1290],
      running: true,
    });
    expect(pati.deviceId).toBe(ID);
    const mahalle = await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`));
    expect(mahalle).toMatchObject({ buildType: 'release', install: { source: 'store-or-testflight' }, running: true });
    expect(mahalle.pids).toContain(2210);
    // Installed but not running / not seen: not listed.
    expect(ctx.hub.deviceApps.has(`${ID}|com.burbn.instagram`)).toBe(false);
    expect([...ctx.hub.deviceApps.keys()].some((k) => k.includes('com.apple.'))).toBe(false);

    // Crash report copied into <tempDir>/crash/<udid>/ and emitted as a crash entry.
    const crash = await waitFor(() => ctx.hub.logs.find((l) => l.entry.origin === 'crash-report'), 8000);
    expect(crash.deviceId).toBe(ID);
    expect(crash.entry).toMatchObject({ kind: 'crash', level: 'fatal', tag: 'crash-report', process: 'Runner', pid: 1234 });
    expect(crash.entry.message.startsWith('Pati 2.3.0 (57) crashed:')).toBe(true);
    expect(crash.entry.data).toMatchObject({ origin: 'crash-report', bundleId: 'com.mykynk.pati', symbolicated: false });
    const copied = path.join(ctx.tempDir, 'crash', UDID, dctl.crashName);
    expect(fs.existsSync(copied)).toBe(true);
    expect((crash.entry.data as { file: string }).file).toBe(copied);
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`)?.crashReports === 1);
    // Copied once even though the listing is polled every second.
    await new Promise((r) => setTimeout(r, 1500));
    expect(dctl.calls.filter((c) => c[1] === 'copy')).toHaveLength(1);
    expect(ctx.hub.logs.filter((l) => l.entry.origin === 'crash-report')).toHaveLength(1);
    // Commands are the documented ones.
    expect(dctl.calls).toContainEqual(['device', 'info', 'apps', '--device', UDID]);
    expect(dctl.calls).toContainEqual(['device', 'info', 'apps', '--device', UDID, '--include-all-apps']);
    expect(dctl.calls).toContainEqual(['device', 'info', 'processes', '--device', UDID]);
    expect(dctl.calls).toContainEqual(['device', 'info', 'files', '--device', UDID, '--domain-type', 'systemCrashLogs']);

    // Detach: apps are no longer running.
    mux.detach(5);
    await waitFor(() => ctx.hub.disconnected.find((d) => d.id === ID));
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)?.running === false);
    await waitFor(() => liveChildCount() === 0, 5000);
  });

  it('stays quiet without devicectl (no apps, no crash scans)', async () => {
    const plain = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false });
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await plain.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.hub.deviceApps.size).toBe(0);
    expect(ctx.hub.logs.every((l) => l.entry.origin === 'idevicesyslog')).toBe(true);
    await plain.stop();
  });
});
