import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform } from '../../src/platform';
import type { AndroidDriver } from '../../src/platform/android/driver';
import { liveChildCount } from '../../src/platform/exec';
import { createCtx, fixturePath, waitFor, type FakeCtx } from './helpers';

const SERIAL = 'R58M123ABC';
const ID = `android:${SERIAL}`;

/**
 * A fake `adb` executable: answers the commands the driver uses from a JSON state file, records
 * every invocation and keeps `logcat` running (replaying a real capture) until killed.
 */
function writeFakeAdb(dir: string): { adb: string; state: string } {
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ devices: [{ serial: SERIAL, state: 'device', model: 'SM_G991B' }] }));
  const adb = path.join(dir, 'adb');
  fs.writeFileSync(
    adb,
    `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.txt', JSON.stringify(args) + '\\n');
const st = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
const out = (s) => process.stdout.write(s);
const revFile = (serial) => dir + '/reverse-' + serial + '.json';
const readRev = (serial) => { try { return JSON.parse(fs.readFileSync(revFile(serial), 'utf8')); } catch { return []; } };
if (args[0] === 'version') { out('Android Debug Bridge version 1.0.41\\nVersion 37.0.0-fake\\nInstalled as /fake/adb\\n'); process.exit(0); }
if (args[0] === 'start-server') process.exit(0);
if (args[0] === 'devices') {
  out('List of devices attached\\n' + st.devices.map((d) => d.serial + '\\t' + d.state + (d.state === 'device' ? ' usb:1-1 product:o1sxeea model:' + d.model + ' device:o1s transport_id:4' : ' usb:1-1 transport_id:4')).join('\\n') + '\\n\\n');
  process.exit(0);
}
if (args[0] !== '-s') { process.stderr.write('unsupported'); process.exit(1); }
const serial = args[1];
const dev = st.devices.find((d) => d.serial === serial);
if (!dev) { process.stderr.write("adb: device '" + serial + "' not found\\n"); process.exit(1); }
const cmd = args[2];
const rest = args.slice(3);
if (cmd === 'get-state') { out(dev.state + '\\n'); process.exit(0); }
if (cmd === 'reverse') {
  let list = readRev(serial);
  if (rest[0] === '--list') { out(list.map((m) => 'UsbFfs ' + m[0] + ' ' + m[1]).join('\\n') + (list.length ? '\\n' : '')); process.exit(0); }
  if (rest[0] === '--remove') { list = list.filter((m) => m[0] !== rest[1]); fs.writeFileSync(revFile(serial), JSON.stringify(list)); process.exit(0); }
  list = list.filter((m) => m[0] !== rest[0]); list.push([rest[0], rest[1]]); fs.writeFileSync(revFile(serial), JSON.stringify(list)); process.exit(0);
}
if (cmd === 'forward') { if (rest[0] === 'tcp:0') out('45678\\n'); process.exit(0); }
if (cmd === 'exec-out') {
  process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  process.exit(0);
}
if (cmd === 'logcat') {
  if (rest.includes('-c')) process.exit(0);
  process.stdout.write(fs.readFileSync(${JSON.stringify(fixturePath('logcat-epoch.txt'))}));
  setInterval(() => {}, 1000);
  return;
}
if (cmd === 'shell') {
  const c = rest.join(' ');
  if (c.startsWith('getprop')) {
    out(['[ro.build.version.release]: [14]', '[ro.build.version.sdk]: [34]', '[ro.product.manufacturer]: [samsung]', '[ro.product.model]: [SM-G991B]', '[ro.product.marketname]: [Galaxy S21 5G]'].join('\\n'));
    out('\\n___DURBUN_SECTION___\\nYusuf’s Galaxy\\n___DURBUN_SECTION___\\nPhysical size: 1080x2400\\nPhysical density: 420\\n___DURBUN_SECTION___\\nCurrent Battery Service state:\\n  USB powered: true\\n  status: 2\\n  level: 76\\n  scale: 100\\n');
    process.exit(0);
  }
  if (c.startsWith('ps')) { out('  PID NAME\\n    1 init\\n  612 system_server\\n 4321 com.mykynk.pati\\n'); process.exit(0); }
  if (c === 'dumpsys battery') { out('  level: 75\\n  scale: 100\\n  status: 3\\n'); process.exit(0); }
  if (c.startsWith('cat /proc/4321/stat')) {
    const ticks = 1000 + Math.floor((Date.now() % 100000) / 10);
    out('4321 (pati) S 612 612 0 0 -1 1077952832 92536 0 1 0 ' + ticks + ' 412 0 0 10 -10 57 0 4021 1 1\\nVmRSS:\\t  204800 kB\\nThreads:\\t57\\n');
    process.exit(0);
  }
  process.exit(0);
}
process.exit(0);
`,
  );
  fs.chmodSync(adb, 0o755);
  return { adb, state };
}

describe('AndroidDriver with a fake adb', () => {
  let dir: string;
  let ctx: FakeCtx;
  let driver: AndroidDriver;
  let state: string;
  let platform: ReturnType<typeof createPlatform>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-adb-'));
    const fake = writeFakeAdb(dir);
    state = fake.state;
    ctx = createCtx({ settings: { adbPath: fake.adb, logcatTail: 500 } });
    platform = createPlatform();
    driver = platform.drivers.find((d) => d.id === 'android') as AndroidDriver;
    await driver.start(ctx);
  });

  afterAll(async () => {
    await driver.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const calls = () =>
    fs
      .readFileSync(path.join(dir, 'calls.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);

  it('discovers the device with full info and starts streaming logcat', async () => {
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming', 10_000);
    const dev = ctx.hub.devices.get(ID)!;
    expect(dev).toMatchObject({
      platform: 'android',
      kind: 'physical',
      name: 'Yusuf’s Galaxy',
      model: 'SM-G991B',
      manufacturer: 'samsung',
      osVersion: '14',
      apiLevel: 34,
      connection: 'usb',
      state: 'online',
      battery: { level: 76, charging: true },
      screen: { width: 1080, height: 2400, density: 2.625 },
    });
    expect(dev.actions).toContain('screenshot');
    expect(dev.actions).not.toContain('location');
    const logcat = calls().find((c) => c[2] === 'logcat' && !c.includes('-c'))!;
    expect(logcat).toEqual(['-s', SERIAL, 'logcat', '-v', 'threadtime', '-v', 'epoch', '-v', 'printable', '-T', '500']);
    expect(ctx.hub.system.map((s) => s.input.code)).toContain('logs.streamStarted');
  });

  it('pushes parsed, grouped log entries in batches and tracks processes', async () => {
    await waitFor(() => ctx.hub.logs.some((l) => l.entry.tag === 'DEBUG'), 10_000);
    const entries = ctx.hub.logs.map((l) => l.entry);
    expect(entries.filter((e) => e.kind === 'crash')).toHaveLength(3);
    expect(entries.find((e) => e.kind === 'anr')).toBeDefined();
    expect(ctx.hub.batches).toBeLessThan(entries.length);
    expect(entries.find((e) => e.message.startsWith('{"event"'))?.process).toBe('com.mykynk.pati');
    expect(ctx.hub.processes.some((p) => p.pid === 612 && p.name === 'system_server' && p.event === 'seen')).toBe(true);
    expect(ctx.hub.processes.some((p) => p.pid === 4321 && p.event === 'died')).toBe(true);
  });

  it('sets up adb reverse routing and hands connections to the SDK layer', async () => {
    const rev = await waitFor(() => {
      try {
        const list = JSON.parse(fs.readFileSync(path.join(dir, `reverse-${SERIAL}.json`), 'utf8')) as string[][];
        return list.length === 2 ? list : undefined;
      } catch {
        return undefined;
      }
    });
    const sdk = rev.find((m) => m[0] === 'tcp:9751')!;
    expect(rev.find((m) => m[0] === 'tcp:9750')).toEqual(['tcp:9750', 'tcp:9750']);
    const port = Number(sdk[1]!.slice(4));
    const client = net.connect(port, '127.0.0.1');
    const att = await waitFor(() => ctx.attached[0]);
    expect(att.meta).toMatchObject({ transport: 'adb-reverse', deviceId: ID });
    let got = '';
    att.stream.on('data', (d: Buffer) => (got += d.toString()));
    client.write('{"type":"hello"}\n');
    await waitFor(() => got === '{"type":"hello"}\n');
    client.destroy();
  });

  it('runs actions and forwards ports', async () => {
    const shot = await driver.runAction(ID, 'screenshot', {});
    expect(shot.ok).toBe(true);
    expect((shot.data as { width: number }).width).toBe(1);
    const bad = await driver.runAction(ID, 'location', { lat: 1, lon: 2 });
    expect(bad).toMatchObject({ ok: false, code: 'action.unsupported' });
    const missing = await driver.runAction('android:nope', 'screenshot', {});
    expect(missing.code).toBe('action.deviceNotFound');
    const fwd = await platform.services.forwardToDevice(ID, 8181);
    expect(fwd).toMatchObject({ host: '127.0.0.1', port: 45678 });
    await fwd.dispose();
    expect(calls().some((c) => c.join(' ') === `-s ${SERIAL} forward --remove tcp:45678`)).toBe(true);
  });

  it('polls /proc metrics for a watched process', async () => {
    driver.watchMetrics!(ID, { pid: 4321 }, true);
    await waitFor(() => ctx.hub.metrics.some((m) => m.cpu !== undefined), 8000);
    driver.watchMetrics!(ID, { pid: 4321 }, false);
    const m = ctx.hub.metrics.find((x) => x.cpu !== undefined)!;
    expect(m).toMatchObject({ deviceId: ID, pid: 4321, source: 'adb', memoryMB: 200, threads: 57 });
  });

  it('reflects unauthorized state, then removal, without leaking processes', async () => {
    fs.writeFileSync(state, JSON.stringify({ devices: [{ serial: SERIAL, state: 'unauthorized' }] }));
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'unauthorized', 8000);
    const dev = ctx.hub.devices.get(ID)!;
    expect(dev).toMatchObject({ stateCode: 'device.unauthorized', actions: [] });
    expect(dev.logs).toMatchObject({ status: 'unavailable', code: 'device.unauthorized' });
    await waitFor(() => liveChildCount() === 0, 5000);
    fs.writeFileSync(state, JSON.stringify({ devices: [] }));
    await waitFor(() => ctx.hub.disconnected.find((d) => d.id === ID), 8000);
    expect(driver.status()).toMatchObject({ id: 'android', available: true, active: true });
    expect(ctx.hub.system.filter((s) => s.input.code === 'logs.streamError')).toHaveLength(0);
  });
}, 60_000);

describe('AndroidDriver shutdown', () => {
  it('removes its adb reverse mappings and forwards and kills logcat on stop()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-adb-stop-'));
    try {
      const fake = writeFakeAdb(dir);
      const ctx = createCtx({ settings: { adbPath: fake.adb } });
      const platform = createPlatform();
      const driver = platform.drivers.find((d) => d.id === 'android')!;
      await driver.start(ctx);
      const revFile = path.join(dir, `reverse-${SERIAL}.json`);
      await waitFor(() => fs.existsSync(revFile) && (JSON.parse(fs.readFileSync(revFile, 'utf8')) as unknown[]).length === 2, 8000);
      await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming', 8000);
      const fwd = await platform.services.forwardToDevice(ID, 9100);
      expect(fwd.port).toBe(45678);
      await driver.stop();
      expect(JSON.parse(fs.readFileSync(revFile, 'utf8'))).toEqual([]);
      const calls = fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8');
      expect(calls).toContain(JSON.stringify(['-s', SERIAL, 'forward', '--remove', 'tcp:45678']));
      expect(ctx.hub.disconnected).toEqual([{ id: ID, detail: 'Dürbün stopped watching Android devices', code: 'device.driverStopped' }]);
      expect(liveChildCount()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('AndroidDriver without adb', () => {
  it('degrades to unavailable with a doctor fix', async () => {
    const ctx = createCtx({ settings: { adbPath: '/nonexistent/adb' } });
    const p = createPlatform();
    const d = p.drivers.find((x) => x.id === 'android')!;
    const env = { ...process.env };
    process.env.ANDROID_HOME = '/nonexistent';
    process.env.ANDROID_SDK_ROOT = '/nonexistent';
    try {
      await d.start(ctx);
      const st = d.status();
      // On machines with adb in ~/Library/Android/sdk the fallback is found; otherwise it is missing.
      if (!st.available) expect(st.code).toBe('logs.adbMissing');
      const checks = await d.checks();
      expect(checks[0]!.id).toBe('adb');
      await d.stop();
    } finally {
      process.env.ANDROID_HOME = env.ANDROID_HOME;
      process.env.ANDROID_SDK_ROOT = env.ANDROID_SDK_ROOT;
      if (env.ANDROID_HOME === undefined) delete process.env.ANDROID_HOME;
      if (env.ANDROID_SDK_ROOT === undefined) delete process.env.ANDROID_SDK_ROOT;
    }
  });
});
