import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Adb } from '../../src/platform/android/adb';
import {
  findSurfaceViewLayers,
  FRAME_GFX_MARK,
  FRAME_LIST_MARK,
  FRAME_SF_MARK,
  FrameStatsReader,
  jankCount,
  parseGfxInfo,
  parseSfLatency,
  sfFrameWindow,
} from '../../src/platform/android/frameStats';
import type { RunResult } from '../../src/platform/exec';
import { silentLogger } from '../../src/util/logger';

const fx = (name: string): string => fs.readFileSync(new URL(`./android-fixtures/${name}`, import.meta.url), 'utf8');

/** `dumpsys SurfaceFlinger --latency` text: 127 rows, oldest first, empty slots as "0 0 0". */
function latency(presents: number[], refreshNs = 16_666_666): string {
  const last = presents.slice(-127);
  const rows: string[] = [];
  for (let i = last.length; i < 127; i++) rows.push('0\t0\t0');
  for (const p of last) rows.push(`${p - 2 * refreshNs}\t${p}\t${p - refreshNs}`);
  return `${refreshNs}\n${rows.join('\n')}\n\n`;
}

/** `count` presents every `stepNs` after `start` (exclusive), with optional extra delays at indexes. */
function frames(start: number, count: number, stepNs: number, delays: Record<number, number> = {}): number[] {
  const out: number[] = [];
  let t = start;
  for (let i = 0; i < count; i++) {
    t += stepNs + (delays[i] ?? 0);
    out.push(t);
  }
  return out;
}

const V60 = 16_666_667;
const T0 = 245_120_000_000_000;

describe('dumpsys gfxinfo', () => {
  it('native app: frames, janky frames and the window since the last reset', () => {
    expect(parseGfxInfo(fx('gfxinfo-native-api34.txt'))).toEqual({ frames: 118, janky: 7, windowMs: 2000, processes: 1 });
  });

  it('Flutter app: HWUI renders (almost) nothing', () => {
    expect(parseGfxInfo(fx('gfxinfo-flutter-api34.txt'))).toMatchObject({ frames: 0, janky: 0, processes: 1 });
  });

  it('sums the processes of a package (window of the busiest one)', () => {
    expect(parseGfxInfo(fx('gfxinfo-two-processes-api29.txt'))).toEqual({ frames: 124, janky: 13, windowMs: 2000, processes: 2 });
  });

  it('no process / no stats → undefined', () => {
    expect(parseGfxInfo('Applications Graphics Acceleration Info:\nUptime: 1 Realtime: 1\nNo process found for: com.foo\n')).toBeUndefined();
    expect(parseGfxInfo('')).toBeUndefined();
  });
});

describe('dumpsys SurfaceFlinger', () => {
  it('finds the SurfaceView buffer layer of the package (Android 14 "@0(BLAST)", Android 10 "SurfaceView - ")', () => {
    expect(findSurfaceViewLayers(fx('sf-list-api34.txt'), 'com.mykynk.pati')).toEqual([
      'SurfaceView[com.mykynk.pati/com.mykynk.pati.MainActivity]@0(BLAST)#1422',
    ]);
    expect(findSurfaceViewLayers(fx('sf-list-api29.txt'), 'com.mykynk.pati')).toEqual([
      'SurfaceView - com.mykynk.pati/com.mykynk.pati.MainActivity#0',
    ]);
    const android12 = [
      'SurfaceView[com.mykynk.pati/com.mykynk.pati.MainActivity]#211',
      'SurfaceView[com.mykynk.pati/com.mykynk.pati.MainActivity](BLAST)#212',
      'Background for SurfaceView[com.mykynk.pati/com.mykynk.pati.MainActivity]#213',
    ].join('\n');
    expect(findSurfaceViewLayers(android12, 'com.mykynk.pati')).toEqual([
      'SurfaceView[com.mykynk.pati/com.mykynk.pati.MainActivity](BLAST)#212',
    ]);
    // A native app without SurfaceView, and a package whose name is a prefix of another.
    expect(findSurfaceViewLayers(fx('sf-list-api34.txt'), 'com.mykynk.mahalle')).toEqual([]);
    expect(findSurfaceViewLayers(fx('sf-list-api34.txt'), 'com.mykynk.patisserie')).toEqual([
      'SurfaceView[com.mykynk.patisserie/com.mykynk.patisserie.MainActivity](BLAST)#1501',
    ]);
  });

  it('parses --latency: refresh period, valid present times (skips empty slots and pending fences)', () => {
    const lat = parseSfLatency(fx('sf-latency-60hz.txt'))!;
    expect(lat.refreshNs).toBe(16_666_666);
    expect(lat.rows).toBe(127);
    expect(lat.presents).toHaveLength(86); // 87 frames, the newest one's fence still pending
    expect(lat.presents[0]).toBe(245120628812344);
    expect(parseSfLatency('16666666\n')).toEqual({ refreshNs: 16_666_666, presents: [], rows: 0 });
    expect(parseSfLatency("Permission Denial: can't dump SurfaceFlinger")).toBeUndefined();
  });

  it('jank = intervals over 1.5 × median (idle gaps excluded)', () => {
    expect(jankCount([16.7, 16.6, 16.7, 50, 16.7, 33.4])).toBe(2);
    expect(jankCount([16.7, 16.7])).toBe(0); // too few to judge
    expect(jankCount([16.7, 16.7, 16.7, 1500])).toBe(0); // 1.5 s gap = idle
  });

  it('fps / jank from the frames presented since the previous read', () => {
    // First read: baseline only.
    const base = frames(T0, 60, V60);
    const w0 = sfFrameWindow(parseSfLatency(latency(base))!, undefined, 0);
    expect(w0).toEqual({ primed: false, newMax: base.at(-1) });
    // Steady 60 fps for 2 s.
    const next = frames(base.at(-1)!, 120, V60);
    const w1 = sfFrameWindow(parseSfLatency(latency([...base, ...next]))!, w0.newMax, 2000);
    expect(w1).toMatchObject({ primed: true, frames: 120, fps: 60, janky: 0, newMax: next.at(-1) });
    // One 3-vsync hitch.
    const hitch = frames(next.at(-1)!, 118, V60, { 40: 2 * V60 });
    const w2 = sfFrameWindow(parseSfLatency(latency([...next, ...hitch]))!, w1.newMax, 2000);
    expect(w2).toMatchObject({ frames: 118, fps: 59, janky: 1 });
    // Idle: nothing new.
    expect(sfFrameWindow(parseSfLatency(latency([...next, ...hitch]))!, w2.newMax, 2000)).toMatchObject({ frames: 0, fps: 0, janky: 0 });
  });

  it('Flutter paints only on change: a short burst after idle is not jank; timer jitter is clamped', () => {
    const before = frames(T0, 30, V60);
    const burst = frames(before.at(-1)! + 1_200_000_000, 30, V60);
    const w = sfFrameWindow(parseSfLatency(latency([...before, ...burst]))!, before.at(-1)!, 2000);
    expect(w).toMatchObject({ frames: 30, fps: 15, janky: 0 });
    const steady = frames(before.at(-1)!, 121, V60);
    expect(sfFrameWindow(parseSfLatency(latency([...before, ...steady]))!, before.at(-1)!, 2000).fps).toBe(60);
  });

  it('120 Hz: when the 127-frame ring wrapped between reads, fps comes from the presented span', () => {
    const v120 = 8_333_333;
    const before = frames(T0, 127, v120);
    const after = frames(before.at(-1)!, 240, v120);
    const w = sfFrameWindow(parseSfLatency(latency(after, v120))!, before.at(-1)!, 2000);
    expect(w.frames).toBe(127);
    expect(w.fps).toBe(120);
  });
});

/* ───────────── reader ───────────── */

function ok(stdout: string): RunResult<string> {
  return { ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false };
}

interface Script {
  gfx: () => string;
  latency: (layer: string) => string;
  list: () => string;
}

function fakeAdb(script: Script) {
  const calls: string[] = [];
  const adb = {
    path: '/fake/adb',
    tool: { path: '/fake/adb', source: 'path' },
    async shell(_serial: string, cmd: string) {
      calls.push(cmd);
      const out: string[] = [];
      for (const part of cmd.split('; ')) {
        if (part.startsWith('echo ')) out.push(part.slice(5));
        else if (part.startsWith('dumpsys gfxinfo ')) out.push(script.gfx());
        else if (part === 'dumpsys SurfaceFlinger --list') out.push(script.list());
        else if (part.startsWith('dumpsys SurfaceFlinger --latency ')) {
          const quoted = part.slice('dumpsys SurfaceFlinger --latency '.length);
          out.push(script.latency(quoted.slice(1, -1).replace(/'\\''/g, "'")));
        }
      }
      return ok(out.join('\n'));
    },
  } as unknown as Adb;
  return { adb, calls };
}

describe('FrameStatsReader', () => {
  it('Flutter (SurfaceView): finds the layer, primes, then reports SurfaceFlinger fps', async () => {
    let presents = frames(T0, 90, V60);
    const { adb, calls } = fakeAdb({
      gfx: () => fx('gfxinfo-flutter-api34.txt'),
      list: () => fx('sf-list-api34.txt'),
      latency: (layer) => (layer.includes('(BLAST)#1422') ? latency(presents) : '16666666\n'),
    });
    const r = new FrameStatsReader({ serial: 'S', logger: silentLogger, packageName: () => 'com.mykynk.pati' });
    expect(await r.read(adb, 1000)).toBeUndefined(); // gfxinfo baseline + layer lookup
    expect(calls[0]).toBe(`echo ${FRAME_GFX_MARK}; dumpsys gfxinfo com.mykynk.pati reset; echo ${FRAME_LIST_MARK}; dumpsys SurfaceFlinger --list`);
    // gfxinfo says 0 frames but the app has a SurfaceView whose stats are not primed yet: no fake "0 fps".
    expect(await r.read(adb, 3000)).toBeUndefined();
    expect(calls[1]).toBe(
      `echo ${FRAME_GFX_MARK}; dumpsys gfxinfo com.mykynk.pati reset; echo ${FRAME_SF_MARK} 0; dumpsys SurfaceFlinger --latency 'SurfaceView[com.mykynk.pati/com.mykynk.pati.MainActivity]@0(BLAST)#1422'`,
    );
    presents = [...presents, ...frames(presents.at(-1)!, 120, V60, { 10: V60 })];
    expect(await r.read(adb, 5000)).toEqual({ fps: 60, jankyFrames: 1, source: 'surfaceflinger' });
    // Idle Flutter app: 0 fps from SurfaceFlinger (not "unknown").
    expect(await r.read(adb, 7000)).toEqual({ fps: 0, jankyFrames: 0, source: 'surfaceflinger' });
  });

  it('native UI: gfxinfo counters; no SurfaceView → re-list only every 10 s', async () => {
    const { adb, calls } = fakeAdb({
      gfx: () => fx('gfxinfo-native-api34.txt'),
      list: () => fx('sf-list-api34.txt'),
      latency: () => '16666666\n',
    });
    const r = new FrameStatsReader({ serial: 'S', logger: silentLogger, packageName: () => 'com.mykynk.mahalle' });
    expect(await r.read(adb, 1000)).toBeUndefined();
    expect(await r.read(adb, 3000)).toEqual({ fps: 59, jankyFrames: 7, source: 'gfxinfo' });
    expect(calls[1]).not.toContain('--list');
    await r.read(adb, 11_500);
    expect(calls[2]).toContain('--list');
  });

  it('re-lists when the layer disappears (activity recreated) and handles a new package', async () => {
    let list = fx('sf-list-api34.txt');
    const { adb, calls } = fakeAdb({
      gfx: () => fx('gfxinfo-flutter-api34.txt'),
      list: () => list,
      latency: (layer) => (list.includes(layer) ? latency(frames(T0, 50, V60)) : '16666666\n'),
    });
    let pkg = 'com.mykynk.pati';
    const r = new FrameStatsReader({ serial: 'S', logger: silentLogger, packageName: () => pkg });
    await r.read(adb, 1000);
    await r.read(adb, 3000);
    list = list.replace(/#1422/g, '#1600');
    await r.read(adb, 5000); // latency of the old name: empty → forget it
    await r.read(adb, 7000);
    expect(calls[3]).toContain('--list');
    await r.read(adb, 9000);
    expect(calls[4]).toContain("@0(BLAST)#1600'");
    pkg = 'com.mykynk.mahalle';
    await r.read(adb, 11_000);
    expect(calls[5]).toContain('dumpsys gfxinfo com.mykynk.mahalle reset');
    expect(calls[5]).toContain('--list');
  });

  it('gfxinfo stats that were reset right before printing are not reported as 0 fps', async () => {
    const justReset = fx('gfxinfo-native-api34.txt')
      .replace('Stats since: 245118587000000ns', 'Stats since: 245120586990000ns')
      .replace('Total frames rendered: 118', 'Total frames rendered: 0')
      .replace('Janky frames: 7 (5.93%)', 'Janky frames: 0 (0.00%)');
    const { adb } = fakeAdb({ gfx: () => justReset, list: () => '', latency: () => '' });
    const r = new FrameStatsReader({ serial: 'S', logger: silentLogger, packageName: () => 'com.mykynk.mahalle' });
    await r.read(adb, 1000);
    expect(await r.read(adb, 3000)).toBeUndefined();
  });

  it('nothing readable → nothing reported; invalid package names are never sent to the shell', async () => {
    const { adb, calls } = fakeAdb({ gfx: () => 'No process found for: com.x.y\n', list: () => '', latency: () => '' });
    const r = new FrameStatsReader({ serial: 'S', logger: silentLogger, packageName: () => 'com.x.y' });
    expect(await r.read(adb, 1000)).toBeUndefined();
    expect(await r.read(adb, 3000)).toBeUndefined();
    const bad = new FrameStatsReader({ serial: 'S', logger: silentLogger, packageName: () => "com.x; rm -rf '/'" });
    expect(await bad.read(adb, 1000)).toBeUndefined();
    expect(calls.every((c) => !c.includes('rm -rf'))).toBe(true);
  });
});
