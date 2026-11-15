/**
 * The adb server's pushed device list (`host:track-devices-l`) instead of `adb devices -l` every 2 s: a fake
 * adb server socket answers `host:version` and streams lists; the fake adb (android-fixtures/
 * fake-adb-transports.cjs) records every command, so the test sees that no polling runs while the stream is
 * live and that polling comes back when the stream ends.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADB_SERVER_PROBE } from '../../src/platform/android/adbServer';
import { AndroidDriver } from '../../src/platform/android/driver';
import { AdbDeviceTracker, parseTrackFrames } from '../../src/platform/android/deviceTracker';
import { createCtx, waitFor } from './helpers';

const FAKE = fileURLToPath(new URL('./android-fixtures/fake-adb-transports.cjs', import.meta.url));
const HW = 'R5CW80ABCDE';
const ID = `android:${HW}`;
const frame = (text: string) => `${Buffer.byteLength(text).toString(16).padStart(4, '0')}${text}`;
/** One `adb devices -l` row as the server sends it (no header). */
const ROW = `${HW}               device usb:1-1 product:a73xqxx model:SM_A736B device:a73xq transport_id:3\n`;

/** A fake adb server: `host:version` → 41; `host:track-devices-l` → OKAY, then the lists pushed by the test. */
async function fakeAdbServer(opts: { refuseTracking?: boolean; first?: string } = {}) {
  const trackers = new Set<net.Socket>();
  let trackRequests = 0;
  const server = net.createServer((socket) => {
    socket.on('data', (d) => {
      const req = d.toString('latin1');
      if (req.includes('host:version')) socket.end('OKAY00040029');
      else if (req.includes('host:track-devices-l')) {
        trackRequests += 1;
        if (opts.refuseTracking) {
          socket.end(`FAIL${frame('unknown host service')}`);
          return;
        }
        trackers.add(socket);
        socket.once('close', () => trackers.delete(socket));
        socket.write(`OKAY${frame(opts.first ?? ROW)}`);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    get trackRequests() {
      return trackRequests;
    },
    get streams() {
      return trackers.size;
    },
    push(list: string) {
      for (const s of trackers) s.write(frame(list));
    },
    dropStreams() {
      for (const s of trackers) s.destroy();
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of trackers) s.destroy();
        server.close(() => r());
      }),
  };
}

describe('device stream frames', () => {
  it('reads OKAY, then length-prefixed lists, also split across chunks', () => {
    const whole = Buffer.from(`OKAY${frame(ROW)}${frame('')}`);
    const r = parseTrackFrames(whole, false);
    expect(r).toMatchObject({ acked: true, lists: [ROW, ''] });
    expect(r.rest.length).toBe(0);
    const part = parseTrackFrames(whole.subarray(0, 10), false);
    expect(part).toMatchObject({ acked: true, lists: [] });
    expect(parseTrackFrames(Buffer.concat([part.rest, whole.subarray(10)]), true).lists).toEqual([ROW, '']);
  });

  it('a refusal or a garbled reply ends the stream', () => {
    expect(parseTrackFrames(Buffer.from(`FAIL${frame('unknown host service')}`), false).failure).toBe('unknown host service');
    expect(parseTrackFrames(Buffer.from('HELLO'), false).failure).toMatch(/unexpected/);
    expect(parseTrackFrames(Buffer.from('zzzz'), true).failure).toBe('bad length');
  });
});

describe('AdbDeviceTracker', () => {
  it('delivers every list, says when it goes down and retries after a wait', async () => {
    const server = await fakeAdbServer();
    const lists: string[] = [];
    const downs: string[] = [];
    const t = new AdbDeviceTracker({ port: () => server.port, onList: (l) => lists.push(l), onDown: (r) => downs.push(r), retryMs: { initial: 50, max: 100 } });
    t.ensure();
    await waitFor(() => t.live);
    expect(t.list).toBe(ROW);
    server.push('');
    await waitFor(() => lists.length === 2);
    expect(t.list).toBe('');
    server.dropStreams();
    await waitFor(() => downs.length === 1);
    expect(t.live).toBe(false);
    t.ensure(); // within the wait: no new connection
    expect(server.trackRequests).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    t.ensure();
    await waitFor(() => t.live);
    expect(server.trackRequests).toBe(2);
    t.stop();
    await server.close();
  });

  it('a server that does not know the request (old adb) is reported down', async () => {
    const server = await fakeAdbServer({ refuseTracking: true });
    const downs: string[] = [];
    const t = new AdbDeviceTracker({ port: () => server.port, onList: () => undefined, onDown: (r) => downs.push(r) });
    t.ensure();
    await waitFor(() => downs.length > 0);
    expect(downs[0]).toContain('unknown host service');
    t.stop();
    await server.close();
  });
});

describe('AndroidDriver on the pushed device list', () => {
  let dir: string;
  const savedPort = ADB_SERVER_PROBE.port;
  let driver: AndroidDriver | undefined;
  let server: Awaited<ReturnType<typeof fakeAdbServer>> | undefined;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-adb-track-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ devices: [{ serial: HW, state: 'device', hw: HW }] }));
    const adb = path.join(dir, 'adb');
    fs.writeFileSync(
      adb,
      `#!/bin/sh\nDURBUN_FAKE_ADB_DIR=${JSON.stringify(dir)} DURBUN_FAKE_ADB_LABEL=adb DURBUN_FAKE_ADB_VERSION=41 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`,
    );
    fs.chmodSync(adb, 0o755);
  });

  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
    await server?.close();
    server = undefined;
    ADB_SERVER_PROBE.port = savedPort;
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const devicesCalls = () =>
    fs
      .readFileSync(path.join(dir, 'calls.txt'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"devices"')).length;

  it('stops polling while the stream is live, follows its changes and polls again when it ends', async () => {
    server = await fakeAdbServer();
    ADB_SERVER_PROBE.port = server.port;
    const ctx = createCtx({ settings: { adbPath: path.join(dir, 'adb') } });
    driver = new AndroidDriver({ resolveEnv: { env: { PATH: '' }, home: dir, prefixes: [] }, trackRetryMs: { initial: 100, max: 200 } });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'online', 10_000);
    await waitFor(() => driver!.tracking, 5000);
    const polled = devicesCalls();
    await new Promise((r) => setTimeout(r, 2600));
    expect(devicesCalls()).toBe(polled); // no `adb devices` while the server pushes the list

    server.push(''); // unplugged
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'disconnected', 5000);
    server.push(ROW); // back
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'online', 10_000);

    server.dropStreams(); // the server restarted: poll until the stream is back
    await waitFor(() => devicesCalls() > polled, 5000);
    await waitFor(() => driver!.tracking, 5000);
    expect(server.trackRequests).toBeGreaterThanOrEqual(2);
  });

  it('keeps polling (as before) when the server refuses the stream', async () => {
    server = await fakeAdbServer({ refuseTracking: true });
    ADB_SERVER_PROBE.port = server.port;
    const ctx = createCtx({ settings: { adbPath: path.join(dir, 'adb') } });
    driver = new AndroidDriver({ resolveEnv: { env: { PATH: '' }, home: dir, prefixes: [] }, trackRetryMs: { initial: 60_000, max: 60_000 } });
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'online', 10_000);
    const before = devicesCalls();
    await waitFor(() => devicesCalls() > before, 5000);
    expect(driver.tracking).toBe(false);
  });

  it('resume() reads the list again at once and never throws', async () => {
    server = await fakeAdbServer();
    ADB_SERVER_PROBE.port = server.port;
    const ctx = createCtx({ settings: { adbPath: path.join(dir, 'adb') } });
    driver = new AndroidDriver({ resolveEnv: { env: { PATH: '' }, home: dir, prefixes: [] } });
    await expect(driver.resume()).resolves.toBeUndefined(); // not started: nothing to do
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'online', 10_000);
    await expect(driver.resume()).resolves.toBeUndefined();
    expect(ctx.hub.devices.get(ID)?.state).toBe('online');
  });
});
