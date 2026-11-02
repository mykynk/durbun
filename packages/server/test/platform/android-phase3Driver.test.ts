/**
 * End to end through the real AndroidDriver with a fake `adb` (android-fixtures/fake-adb.cjs):
 * DeviceApps from ps + `dumpsys package`, logcat origin, dropbox crash de-duplicated against the live
 * logcat crash, SurfaceFlinger frame stats for a watched Flutter app, removal on unplug.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { createPlatform } from '../../src/platform';
import { DROPBOX_TIMING } from '../../src/platform/android/dropbox';
import { liveChildCount } from '../../src/platform/exec';
import { createCtx, waitFor, type FakeCtx } from './helpers';

const SERIAL = '1A2B3C4D5E6F';
const ID = `android:${SERIAL}`;
const FAKE = fileURLToPath(new URL('./android-fixtures/fake-adb.cjs', import.meta.url));

describe('AndroidDriver phase 3 (DeviceApps, dropbox, frame stats) with a fake adb', () => {
  let dir: string;
  let ctx: FakeCtx;
  let driver: ReturnType<typeof createPlatform>['drivers'][number];
  const logs: LogEntry[] = [];
  const savedDelay = DROPBOX_TIMING.initialDelayMs;

  beforeAll(async () => {
    DROPBOX_TIMING.initialDelayMs = 600;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-adb-p3-'));
    const crashMs = Math.floor((Date.now() - 60_000) / 1000) * 1000 + 400;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ devices: [{ serial: SERIAL, state: 'device' }], crashMs }));
    const adb = path.join(dir, 'adb');
    fs.writeFileSync(adb, `#!/bin/sh\nDURBUN_FAKE_ADB_DIR=${JSON.stringify(dir)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
    fs.chmodSync(adb, 0o755);
    ctx = createCtx({ settings: { adbPath: adb, logcatTail: 100 } });
    // Like the real hub: ids + the synchronous onLogs tap.
    const listeners = new Set<(entries: LogEntry[]) => void>();
    ctx.onLogs = (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    };
    let nextId = 1;
    const push = ctx.hub.pushDeviceLogs;
    ctx.hub.pushDeviceLogs = (deviceId, entries) => {
      push(deviceId, entries);
      const full = entries.map((e) => ({ ...e, id: nextId++, deviceId, source: 'device' }) as LogEntry);
      logs.push(...full);
      for (const l of listeners) l(full);
    };
    driver = createPlatform().drivers.find((d) => d.id === 'android')!;
    await driver.start(ctx);
  });

  afterAll(async () => {
    await driver.stop();
    DROPBOX_TIMING.initialDelayMs = savedDelay;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const calls = () =>
    fs
      .readFileSync(path.join(dir, 'calls.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as string[]).join(' '));

  it('marks every logcat line with origin "logcat"', async () => {
    await waitFor(() => logs.some((e) => e.kind === 'crash'), 10_000);
    const logcat = logs.filter((e) => e.origin !== 'dropbox');
    expect(logcat.length).toBeGreaterThan(3);
    expect(logcat.every((e) => e.origin === 'logcat')).toBe(true);
  });

  it('publishes the running third-party apps with build / installer details', async () => {
    await waitFor(() => ctx.hub.deviceApps.size >= 2, 10_000);
    const pati = ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`)!;
    expect(pati).toMatchObject({ buildType: 'debug', version: '1.4.0-dev', build: '1', install: { source: 'adb' }, running: true });
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`)?.pids.join() === '4500', 5000);
    expect(ctx.hub.deviceApps.get(`${ID}|com.mykynk.mahalle`)).toMatchObject({
      buildType: 'release',
      install: { source: 'play', installer: 'com.android.vending' },
      pids: [5100],
    });
    expect([...ctx.hub.deviceApps.keys()].some((k) => k.includes('gms'))).toBe(false);
    // The device clock (UTC) converts install times.
    expect(pati.install.lastUpdate).toBe(Date.UTC(2026, 10, 2, 11, 41, 9));
    // One `pm list` and one batched `dumpsys package` for both apps.
    expect(calls().filter((c) => c.includes('pm list packages -3'))).toHaveLength(1);
    expect(calls().filter((c) => c.includes('dumpsys package com.'))).toHaveLength(1);
  });

  it('reads the dropbox crash and links it to the live logcat crash instead of showing it twice', async () => {
    const box = await waitFor(() => logs.find((e) => e.origin === 'dropbox'), 10_000);
    const live = logs.find((e) => e.kind === 'crash' && e.origin === 'logcat')!;
    expect(box).toMatchObject({
      kind: 'crash',
      level: 'fatal',
      tag: 'data_app_crash',
      process: 'com.mykynk.pati',
      error: { type: 'java.lang.IllegalStateException', message: 'Boom' },
      data: { origin: 'dropbox', package: 'com.mykynk.pati', pid: 4321, previousLaunch: true, duplicateOf: live.id },
    });
    await waitFor(() => ctx.hub.deviceApps.get(`${ID}|com.mykynk.pati`)?.crashReports === 1, 5000);
    // Listing for the four tags in one call; --print only for the new record's second.
    const box1 = calls().filter((c) => c.includes('dumpsys dropbox'));
    expect(box1[0]).toContain('dumpsys dropbox data_app_crash; echo ___DURBUN_DROPBOX___; dumpsys dropbox data_app_anr');
    expect(box1.filter((c) => c.includes('--print'))).toHaveLength(1);
  });

  it('adds SurfaceFlinger fps for a watched Flutter app (no SDK)', async () => {
    driver.watchMetrics!(ID, { processName: 'com.mykynk.pati' }, true);
    const m = await waitFor(() => ctx.hub.metrics.find((s) => s.fps !== undefined), 15_000);
    driver.watchMetrics!(ID, { processName: 'com.mykynk.pati' }, false);
    expect(m).toMatchObject({ deviceId: ID, pid: 4500, source: 'adb', memoryMB: 200, jankyFrames: 0 });
    expect(m.fps).toBeGreaterThan(50);
    expect(m.fps).toBeLessThanOrEqual(60);
    expect(calls().some((c) => c.includes("--latency 'SurfaceView[com.mykynk.pati/com.mykynk.pati.MainActivity]@0(BLAST)#1422'"))).toBe(true);
  }, 20_000);

  it('removes the device apps when the phone is unplugged, without leaking processes', async () => {
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { devices: unknown[] };
    st.devices = [];
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    await waitFor(() => ctx.hub.disconnected.find((d) => d.id === ID), 8000);
    expect(ctx.hub.removedDeviceApps).toContainEqual({ deviceId: ID });
    expect(ctx.hub.deviceApps.size).toBe(0);
    await waitFor(() => liveChildCount() === 0, 5000);
  });
}, 60_000);
