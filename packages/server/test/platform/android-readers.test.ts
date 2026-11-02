/**
 * DeviceInfo.readers for Android (SPEC §10.3 / §10.4): change-only reporting, and frame stats from a metrics
 * watch ('ok' with samples, 'unavailable' / noData when a live app never yields frames).
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceReaderId, DeviceReaderState } from '@durbun/protocol';
import type { Adb } from '../../src/platform/android/adb';
import { FRAME_TIMING } from '../../src/platform/android/frameStats';
import { AndroidMetricsWatcher } from '../../src/platform/android/metrics';
import { DeviceReaders, READER_REFRESH_MS, type ReaderReport } from '../../src/platform/android/readers';
import type { RunResult } from '../../src/platform/exec';
import { silentLogger } from '../../src/util/logger';
import { createFakeHub } from './helpers';

const fx = (name: string): string => fs.readFileSync(new URL(`./android-fixtures/${name}`, import.meta.url), 'utf8');

describe('DeviceReaders', () => {
  it('sends changes only, refreshes a steady state every 5 min and keeps lastOk when reading stops working', () => {
    let now = 1_000_000;
    const sent: Array<[DeviceReaderId, DeviceReaderState]> = [];
    const r = new DeviceReaders((id, s) => sent.push([id, s]), () => now);
    r.report('crashReports', { status: 'ok' });
    now += 30_000;
    r.report('crashReports', { status: 'ok' });
    expect(sent).toEqual([['crashReports', { status: 'ok', lastOk: 1_000_000 }]]);
    now += 30_000;
    r.report('crashReports', { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'Permission Denial (pid=1)' });
    now += 30_000;
    r.report('crashReports', { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'Permission Denial (pid=2)' });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([
      'crashReports',
      { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'Permission Denial (pid=1)', lastOk: 1_030_000 },
    ]);
    now += READER_REFRESH_MS;
    r.report('crashReports', { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'Permission Denial (pid=3)' });
    expect(sent).toHaveLength(3);
    r.report('frameStats', { status: 'unavailable', code: 'reader.frameStats.noData' });
    expect(sent.at(-1)).toEqual(['frameStats', { status: 'unavailable', code: 'reader.frameStats.noData' }]);
    expect(r.get('crashReports')?.detail).toBe('Permission Denial (pid=3)');
  });
});

/* ───────────── frame stats through the metrics watcher ───────────── */

function ok(stdout: string): RunResult<string> {
  return { ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false };
}

const STAT = '4500 (mykynk.pati) S 612 612 0 0 -1 1077952832 92536 0 1 0 1000 412 0 0 10 -10 57 0 4021 1 1\nVmRSS:\t  204800 kB\nThreads:\t57\n';

function fakeAdb(opts: { gfx: () => string; list: string; latency: string; alive?: () => boolean }) {
  return {
    path: '/fake/adb',
    tool: { path: '/fake/adb', source: 'path' },
    async shell(_serial: string, cmd: string) {
      if (cmd.startsWith('cat /proc/')) return opts.alive?.() === false ? ok('') : ok(STAT);
      const out: string[] = [];
      for (const part of cmd.split('; ')) {
        if (part.startsWith('echo ')) out.push(part.slice(5));
        else if (part.startsWith('dumpsys gfxinfo ')) out.push(opts.gfx());
        else if (part === 'dumpsys SurfaceFlinger --list') out.push(opts.list);
        else if (part.startsWith('dumpsys SurfaceFlinger --latency ')) out.push(opts.latency);
      }
      return ok(out.join('\n'));
    },
  } as unknown as Adb;
}

function watch(adb: Adb, pkg = 'com.mykynk.pati') {
  const reports: ReaderReport[] = [];
  const hub = createFakeHub();
  const w = new AndroidMetricsWatcher(
    {
      adb: () => adb,
      serial: 'S',
      deviceId: 'android:S',
      hub,
      logger: silentLogger,
      packageOf: () => pkg,
      onFrameReader: (r) => reports.push(r),
    },
    { pid: 4500 },
  );
  return { w, reports, hub };
}

describe('frame stats reader state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(2000);
  };

  it('a Flutter app whose SurfaceView frame times are unreadable → noData once, with what was seen', async () => {
    const adb = fakeAdb({ gfx: () => fx('gfxinfo-flutter-api34.txt'), list: fx('sf-list-api34.txt'), latency: '16666666\n' });
    const { w, reports, hub } = watch(adb);
    w.start();
    await ticks(FRAME_TIMING.noDataReads + 3);
    w.stop();
    expect(reports).toEqual([
      {
        status: 'unavailable',
        code: 'reader.frameStats.noData',
        detail:
          'SurfaceFlinger lists a SurfaceView of com.mykynk.pati but gives no frame times for it; gfxinfo does not see what a SurfaceView draws',
      },
    ]);
    // CPU / memory still flow.
    expect(hub.metrics.length).toBeGreaterThan(3);
    expect(hub.metrics.every((m) => m.fps === undefined)).toBe(true);
  });

  it('a native app → ok with each sample; a later quiet spell is not reported as unreadable', async () => {
    let live = true;
    const adb = fakeAdb({ gfx: () => (live ? fx('gfxinfo-native-api34.txt') : 'No process found for: com.mykynk.mahalle\n'), list: '', latency: '' });
    const { w, reports } = watch(adb, 'com.mykynk.mahalle');
    w.start();
    await ticks(2);
    expect(reports.at(-1)).toEqual({ status: 'ok' });
    live = false;
    await ticks(FRAME_TIMING.noDataReads + 2);
    w.stop();
    expect(reports.every((r) => r.status === 'ok')).toBe(true);
  });

  it('a dead process says nothing about the device', async () => {
    const adb = fakeAdb({ gfx: () => 'No process found for: com.mykynk.pati\n', list: '', latency: '', alive: () => false });
    const { w, reports } = watch(adb);
    w.start();
    await ticks(FRAME_TIMING.noDataReads + 2);
    w.stop();
    expect(reports).toEqual([]);
  });
});
