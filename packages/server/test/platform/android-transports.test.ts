/**
 * The Android driver against a fake adb (android-fixtures/fake-adb-transports.cjs) and a fake adb server
 * socket: one phone on USB + Wi-Fi is one device that moves between transports, an adb server of another
 * version is never restarted (adopt a matching adb, or wait and say why), and the device's log buffer is
 * read once at connect for the apps' older lines.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADB_SERVER_PROBE, parseVersionReply, queryAdbServerVersion } from '../../src/platform/android/adbServer';
import { AndroidDriver, pickPrimaryTransport, transportsOf } from '../../src/platform/android/driver';
import { adbProtocolVersion, parseAdbServerConflict, parseSerialProp, serialFromMdnsName } from '../../src/platform/android/parsers';
import type { ResolveEnv } from '../../src/platform/tools';
import { createCtx, waitFor, type FakeCtx } from './helpers';

const FAKE = fileURLToPath(new URL('./android-fixtures/fake-adb-transports.cjs', import.meta.url));
const HW = 'R5CW80ABCDE';
const ID = `android:${HW}`;
const WIFI = '192.168.1.40:37891';

/** A fake adb server: answers `host:version` with `version()` (a number, or 'fail' for a FAIL reply). */
async function fakeServer(version: () => number | 'fail'): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('data', (d) => {
      if (!d.toString('latin1').includes('host:version')) return;
      const v = version();
      socket.end(v === 'fail' ? 'FAIL0004nope' : `OKAY0004${v.toString(16).padStart(4, '0')}`);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = await fakeServer(() => 41);
  await s.close();
  return s.port;
}

function writeAdb(dir: string, file: string, label: string, version: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh\nDURBUN_FAKE_ADB_DIR=${JSON.stringify(dir)} DURBUN_FAKE_ADB_LABEL=${label} DURBUN_FAKE_ADB_VERSION=${version} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

interface Phone {
  serial: string;
  state: string;
  hw?: string;
}

function setState(dir: string, state: { devices: Phone[]; dump?: string[]; killServerVersion?: number }): void {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}

function calls(dir: string): string[][] {
  try {
    return fs
      .readFileSync(path.join(dir, 'calls.txt'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
}

/** Nothing on this Mac is looked at: only the fakes given here. */
function isolatedEnv(home: string, env: NodeJS.ProcessEnv = {}): ResolveEnv {
  return { env: { PATH: '', ...env }, home, prefixes: [] };
}

const epoch = (ms: number) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
const line = (ms: number, pid: number, tid: number, lvl: string, tag: string, msg: string) =>
  `${epoch(ms).padStart(20)} ${String(pid).padStart(5)} ${String(tid).padStart(5)} ${lvl} ${tag.padEnd(8)}: ${msg}`;

describe('adb version helpers', () => {
  it('reads the protocol version, the kill line and the server reply', () => {
    expect(adbProtocolVersion('Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\n')).toBe(41);
    expect(adbProtocolVersion('garbage')).toBeUndefined();
    expect(parseAdbServerConflict("adb server version (41) doesn't match this client (40); killing...\n* daemon started successfully\n")).toEqual({
      serverVersion: 41,
      clientVersion: 40,
    });
    expect(parseAdbServerConflict('adb server is out of date.  killing...')).toEqual({});
    expect(parseAdbServerConflict('* daemon not running; starting now at tcp:5037\n* daemon started successfully')).toBeUndefined();
    expect(parseVersionReply(Buffer.from('OKAY00040029'))).toBe(41);
    expect(parseVersionReply(Buffer.from('OKAY0004'))).toBe('more');
    expect(parseVersionReply(Buffer.from('FAIL0004nope'))).toBeUndefined();
  });

  it('asks a running server its version without adb, and tells "no server" apart', async () => {
    const s = await fakeServer(() => 40);
    expect(await queryAdbServerVersion(s.port, 1000)).toBe(40);
    await s.close();
    expect(await queryAdbServerVersion(s.port, 1000)).toBe('none');
  });

  it('reads the hardware serial of a transport', () => {
    expect(serialFromMdnsName('adb-R5CW80ABCDE-Xy1z2W._adb-tls-connect._tcp')).toBe('R5CW80ABCDE');
    expect(serialFromMdnsName('adb-R5CW80ABCDE-Xy1z2W._adb-tls-connect._tcp.')).toBe('R5CW80ABCDE');
    expect(serialFromMdnsName(WIFI)).toBeUndefined();
    expect(parseSerialProp('R5CW80ABCDE\n')).toBe('R5CW80ABCDE');
    expect(parseSerialProp('\n')).toBeUndefined();
    expect(parseSerialProp('[ro.serialno]: [R5CW80ABCDE]\n[ro.build.version.sdk]: [34]\n')).toBe('R5CW80ABCDE');
  });

  it('runs a phone on USB while it is there, else on Wi-Fi', () => {
    const usb = { serial: HW, state: 'device', props: {} };
    const wifi = { serial: WIFI, state: 'device', props: {} };
    expect(pickPrimaryTransport([wifi, usb], WIFI)).toBe(usb);
    expect(pickPrimaryTransport([wifi, { ...usb, state: 'unauthorized' }], WIFI).serial).toBe(WIFI);
    expect(pickPrimaryTransport([wifi], HW)).toBe(wifi);
    expect(transportsOf([wifi, usb], usb)).toEqual(['usb', 'wifi']);
  });
});

describe('one phone on USB and Wi-Fi', () => {
  let dir: string;
  let ctx: FakeCtx;
  let driver: AndroidDriver;
  const savedPort = ADB_SERVER_PROBE.port;
  const t0 = Math.floor((Date.now() - 30 * 60_000) / 1000) * 1000;
  const dump = [
    '--------- beginning of main',
    line(t0, 612, 650, 'I', 'ActivityManager', 'Start proc 4500:com.mykynk.pati/u0a190 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}'),
    line(t0 + 100, 4500, 4500, 'I', 'flutter', 'The Dart VM service is listening on http://127.0.0.1:43123/AbCdEfGh=/'),
    line(t0 + 200, 4500, 4500, 'D', 'Pati', 'sepete eklendi'),
    line(t0 + 300, 900, 920, 'I', 'Netd', 'interface wlan0 is up'),
    line(t0 + 400, 371, 371, 'I', 'lowmemorykiller', "Kill 'com.mykynk.pati' (4500), uid 10190, oom_score_adj 0 to free 182340kB rss, 0kB swap; reason: device is not responding"),
    line(t0 + 500, 900, 920, 'I', 'Netd', 'interface wlan0 is down'),
    line(t0 + 600, 612, 640, 'I', 'ActivityManager', 'Process com.mykynk.pati (pid 4500) has died: fg  TOP'),
    line(t0 + 700, 900, 920, 'I', 'Netd', 'tail line 1'),
    line(t0 + 800, 900, 920, 'I', 'Netd', 'tail line 2'),
  ];

  beforeAll(async () => {
    ADB_SERVER_PROBE.port = await closedPort();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-adb-tr-'));
    setState(dir, {
      devices: [
        { serial: HW, state: 'device', hw: HW },
        { serial: WIFI, state: 'device', hw: HW },
      ],
      dump,
    });
    const adb = writeAdb(dir, path.join(dir, 'bin', 'adb'), 'adb', 41);
    ctx = createCtx({ settings: { adbPath: adb, logcatTail: 2 } });
    driver = new AndroidDriver({ resolveEnv: isolatedEnv(dir) });
    await driver.start(ctx);
  });

  afterAll(async () => {
    await driver.stop();
    ADB_SERVER_PROBE.port = savedPort;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the phone once, on USB, with Wi-Fi waiting', async () => {
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming', 10_000);
    await waitFor(() => ctx.hub.devices.get(ID)?.connections, 5000);
    const dev = ctx.hub.devices.get(ID)!;
    expect(dev).toMatchObject({ serial: HW, hardwareSerial: HW, connection: 'usb', connections: ['usb', 'wifi'], name: 'Galaxy A73' });
    expect([...ctx.hub.devices.keys()]).toEqual([ID]);
    // The Wi-Fi transport was only asked who it is.
    const wifiCalls = calls(dir).filter((c) => c[2] === WIFI);
    expect(wifiCalls.map((c) => c.slice(3).join(' '))).toEqual(['shell getprop ro.serialno']);
  });

  it('reads the older app lines from the buffer before the stream, then resumes after the dump', async () => {
    const msgs = ctx.hub.logs.filter((l) => l.deviceId === ID).map((l) => l.entry.message);
    expect(msgs).toContain('sepete eklendi');
    expect(msgs.some((m) => m.startsWith('The Dart VM service is listening'))).toBe(true);
    expect(msgs).not.toContain('interface wlan0 is up'); // another process, older than the tail
    expect(msgs).toEqual(expect.arrayContaining(['tail line 1', 'tail line 2']));
    // Each dump line once.
    expect(msgs.filter((m) => m === 'sepete eklendi')).toHaveLength(1);
    const kill = ctx.hub.logs.find((l) => l.entry.tag === 'lowmemorykiller')!.entry;
    expect(kill).toMatchObject({ pid: 4500, process: 'com.mykynk.pati', level: 'error' });
    expect(kill.data).toMatchObject({ termination: 'low-memory', adj: 0, visible: true, reason: 'device is not responding' });
    const history = ctx.hub.system.find((s) => s.input.code === 'logs.history')!;
    expect(history.input.params).toEqual({ lines: 5, minutes: 30 });
    const stream = calls(dir).find((c) => c[2] === HW && c[3] === 'logcat' && !c.includes('-d'))!;
    expect(stream.slice(-2)).toEqual(['-T', epoch(t0 + 800)]);
  });

  it('moves to Wi-Fi when the cable is pulled: same device, logcat resumes, a line says so', async () => {
    setState(dir, { devices: [{ serial: WIFI, state: 'device', hw: HW }], dump });
    await waitFor(() => ctx.hub.devices.get(ID)?.connection === 'wifi', 10_000);
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming', 10_000);
    expect(ctx.hub.devices.get(ID)).toMatchObject({ serial: WIFI, hardwareSerial: HW, name: 'Galaxy A73', state: 'online' });
    expect(ctx.hub.devices.get(ID)?.connections).toBeUndefined();
    expect(ctx.hub.disconnected.filter((d) => d.id === ID)).toHaveLength(0);
    expect(ctx.hub.system.find((s) => s.input.code === 'device.transportChanged')?.input.params).toEqual({
      device: 'Galaxy A73',
      connection: 'Wi-Fi',
      previous: 'USB',
    });
    // No second dump: the Wi-Fi stream continues after the last line seen over USB.
    const wifiLogcat = calls(dir).filter((c) => c[2] === WIFI && c[3] === 'logcat');
    expect(wifiLogcat).toHaveLength(1);
    expect(wifiLogcat[0]!.slice(-2)).toEqual(['-T', epoch(t0 + 800)]);
  });

  it('keeps the device when wireless debugging restarts on a new port, and goes back to USB', async () => {
    const next = '192.168.1.40:41555';
    setState(dir, { devices: [{ serial: next, state: 'device', hw: HW }], dump });
    await waitFor(() => ctx.hub.devices.get(ID)?.serial === next, 10_000);
    setState(dir, {
      devices: [
        { serial: next, state: 'device', hw: HW },
        { serial: HW, state: 'device', hw: HW },
      ],
      dump,
    });
    await waitFor(() => ctx.hub.devices.get(ID)?.connection === 'usb', 10_000);
    expect([...ctx.hub.devices.keys()]).toEqual([ID]);
    expect(ctx.hub.disconnected.filter((d) => d.id === ID)).toHaveLength(0);
  });
});

describe('an adb server of another version', () => {
  let dir: string;
  const savedPort = ADB_SERVER_PROBE.port;
  let driver: AndroidDriver | undefined;
  let server: Awaited<ReturnType<typeof fakeServer>> | undefined;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-adb-cf-'));
  });

  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
    await server?.close();
    server = undefined;
    ADB_SERVER_PROBE.port = savedPort;
    fs.rmSync(path.join(dir, 'calls.txt'), { force: true });
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is left alone: Android waits, says why, and starts once the versions match', async () => {
    let version = 40;
    server = await fakeServer(() => version);
    ADB_SERVER_PROBE.port = server.port;
    setState(dir, { devices: [{ serial: HW, state: 'device', hw: HW }] });
    const adb = writeAdb(dir, path.join(dir, 'own', 'adb'), 'own', 41);
    const ctx = createCtx({ settings: { adbPath: adb } });
    driver = new AndroidDriver({ resolveEnv: isolatedEnv(dir) });
    await driver.start(ctx);
    expect(driver.status()).toMatchObject({ available: true, code: 'driver.adbVersionConflict' });
    expect(driver.status().detail).toContain('version 40');
    const checks = await driver.checks();
    expect(checks.find((c) => c.id === 'adb-server')).toMatchObject({
      status: 'error',
      code: 'driver.adbVersionConflict',
      params: { server: 40, client: 41, path: adb, match: '' },
    });
    await new Promise((r) => setTimeout(r, 2500));
    // Only `adb version`: no start-server, no devices — nothing that would restart the other server.
    expect(new Set(calls(dir).map((c) => c[1]))).toEqual(new Set(['version']));
    expect(ctx.hub.devices.size).toBe(0);
    version = 41;
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'online', 10_000);
    expect(driver.status().code).toBe('driver.android.online');
  });

  it('uses an adb of the server version found on this Mac when no adbPath is set', async () => {
    server = await fakeServer(() => 41);
    ADB_SERVER_PROBE.port = server.port;
    setState(dir, { devices: [{ serial: HW, state: 'device', hw: HW }] });
    const sdk = path.join(dir, 'sdk');
    writeAdb(dir, path.join(sdk, 'platform-tools', 'adb'), 'sdk', 40);
    const brew = writeAdb(dir, path.join(dir, 'brew', 'adb'), 'brew', 41);
    const ctx = createCtx({ settings: { adbPath: '' } });
    driver = new AndroidDriver({ resolveEnv: isolatedEnv(dir, { ANDROID_HOME: sdk, PATH: path.dirname(brew) }) });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'online', 10_000);
    expect(driver.status().code).toBe('driver.android.online');
    const used = calls(dir).filter((c) => c[1] !== 'version');
    expect(used.some((c) => c[0] === 'brew' && c[1] === 'devices')).toBe(true);
    expect(used.filter((c) => c[0] === 'sdk')).toEqual([]);
    const row = (await driver.checks()).find((c) => c.id === 'adb-server');
    expect(row).toMatchObject({ status: 'ok', code: 'doctor.adbMatchedServer', params: { server: 41, path: brew } });
  });

  it('stops at once when a command of ours restarted another server anyway', async () => {
    server = await fakeServer(() => 'fail'); // an answer the probe does not understand
    ADB_SERVER_PROBE.port = server.port;
    setState(dir, { devices: [{ serial: HW, state: 'device', hw: HW }], killServerVersion: 40 });
    const adb = writeAdb(dir, path.join(dir, 'own2', 'adb'), 'own2', 41);
    const ctx = createCtx({ settings: { adbPath: adb } });
    driver = new AndroidDriver({ resolveEnv: isolatedEnv(dir) });
    await driver.start(ctx);
    await waitFor(() => driver!.status().code === 'driver.adbVersionConflict', 5000);
    const before = calls(dir).length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(calls(dir).length).toBe(before); // waiting: no further adb runs
    expect(ctx.hub.devices.size).toBe(0);
  });
});
