import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DeviceClock } from '../../src/platform/flutterVm/clock';
import { FrameStats, frameEnd, parseFlutterFrame, type FlutterFrame } from '../../src/platform/flutterVm/frames';
import { mapDartLogLevel } from '../../src/platform/flutterVm/levels';
import { ReplayFilter, sameVmProcess, VmStateStore } from '../../src/platform/flutterVm/state';

const extensionEvents = JSON.parse(readFileSync(new URL('./fixtures/extension-events.json', import.meta.url), 'utf8')) as {
  event: { extensionKind?: string; extensionData?: unknown };
}[];

describe('mapDartLogLevel (dart:developer / package:logging)', () => {
  it.each([
    [0, 'info'],
    [undefined, 'info'],
    [300, 'verbose'], // FINEST
    [400, 'verbose'], // FINER
    [500, 'debug'], // FINE
    [700, 'debug'], // CONFIG
    [800, 'info'], // INFO
    [900, 'warn'], // WARNING
    [1000, 'error'], // SEVERE
    [1200, 'fatal'], // SHOUT
    [2000, 'fatal'], // OFF
    [Number.NaN, 'info'],
  ] as const)('%s → %s', (level, expected) => {
    expect(mapDartLogLevel(level)).toBe(expected);
  });

  it('a level-less log with an error is an error, never info', () => {
    expect(mapDartLogLevel(0, true)).toBe('error');
    expect(mapDartLogLevel(800, true)).toBe('info'); // an explicit level wins
  });
});

function frame(startTime: number, build = 4000, raster = 3000, extra: Partial<FlutterFrame> = {}): FlutterFrame {
  return { startTime, elapsed: build + raster + 500, build, raster, vsyncOverhead: 500, ...extra };
}

describe('Flutter.Frame parsing', () => {
  it('parses the recorded events (scheduler/binding.dart _profileFramePostEvent shape)', () => {
    const frames = extensionEvents
      .filter((e) => e.event.extensionKind === 'Flutter.Frame')
      .map((e) => parseFlutterFrame(e.event.extensionData));
    expect(frames.length).toBeGreaterThanOrEqual(12);
    const first = frames[0]!;
    expect(first).toMatchObject({ elapsed: 30000, build: 24000, raster: 5000, vsyncOverhead: 500 });
    expect(frames[1]!.startTime - first.startTime).toBe(16667);
    expect(frameEnd(first)).toBe(first.startTime - 500 + 30000);
  });

  it('rejects incomplete payloads and accepts numeric strings', () => {
    expect(parseFlutterFrame({ startTime: 1 })).toBeUndefined();
    expect(parseFlutterFrame(null)).toBeUndefined();
    expect(parseFlutterFrame({ startTime: '10', build: '2', raster: '3' })).toMatchObject({ startTime: 10, elapsed: 5 });
  });
});

describe('FrameStats', () => {
  it('reports nothing for VMs that never rendered a frame (plain Dart)', () => {
    expect(new FrameStats().sample(1000)).toBeUndefined();
  });

  it('computes 60 fps from batched 60 Hz frames on the frames’ own clock, regardless of batch timing', () => {
    const stats = new FrameStats();
    let t = 1_000_000;
    // 1.5 s of frames delivered in 100 ms batches; one janky frame (24 ms build) per batch.
    for (let batch = 0; batch < 15; batch++) {
      for (let i = 0; i < 6; i++) {
        stats.add(frame(t, i === 0 ? 24000 : 4000, i === 0 ? 5000 : 3000));
        t += 16667;
      }
    }
    const s = stats.sample(1000)!;
    expect(s.fps).toBeGreaterThanOrEqual(59);
    expect(s.fps).toBeLessThanOrEqual(61);
    expect(s.jankyFrames).toBe(15);
    expect(s.frameBuildMs).toBeCloseTo((24 + 5 * 4) / 6, 1);
    expect(s.frameRasterMs).toBeCloseTo((5 + 5 * 3) / 6, 1);
  });

  it('uses the metrics interval as the FPS window', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 60; i++) stats.add(frame(1_000_000 + i * 16667));
    expect(stats.sample(500)!.fps).toBeGreaterThanOrEqual(59);
  });

  it('reports 0 fps while idle (Flutter renders only on change) and resumes afterwards', () => {
    const stats = new FrameStats();
    stats.add(frame(1_000_000));
    stats.sample(1000);
    expect(stats.sample(1000)).toEqual({ fps: 0, jankyFrames: 0 });
    for (let i = 0; i < 30; i++) stats.add(frame(9_000_000 + i * 16667));
    expect(stats.sample(1000)!.fps).toBeGreaterThan(25);
  });

  it('honours the display refresh rate for the jank budget (120 Hz → 8.3 ms)', () => {
    const stats = new FrameStats();
    stats.setRefreshRate(120);
    expect(stats.frameBudgetMs).toBeCloseTo(8.33, 1);
    stats.add(frame(1_000_000, 10_000, 3000));
    stats.add(frame(1_008_333, 6000, 3000));
    expect(stats.sample(1000)!.jankyFrames).toBe(1);
    stats.setRefreshRate(0); // ignored
    expect(stats.frameBudgetMs).toBeCloseTo(8.33, 1);
  });

  it('only counts frames inside the window for FPS (late batches of old frames)', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 10; i++) stats.add(frame(1_000_000 + i * 16667)); // old burst
    for (let i = 0; i < 30; i++) stats.add(frame(20_000_000 + i * 16667)); // 0.5 s of new frames
    const s = stats.sample(1000)!;
    expect(s.fps).toBe(30);
    expect(s.jankyFrames).toBe(0);
  });
});

describe('DeviceClock', () => {
  it('estimates the device offset as the max of (device − arrival) over the window', () => {
    let now = 1_000_000;
    const clock = new DeviceClock(60_000, () => now);
    expect(clock.deviceNow()).toBe(now);
    clock.observe(now + 5000 - 30); // 30 ms delivery latency
    now += 100;
    clock.observe(now + 5000 - 4); // 4 ms latency
    expect(clock.offset()).toBe(4996);
    expect(clock.deviceNow()).toBe(now + 4996);
    clock.observe('bad');
    clock.observe(-1);
    expect(clock.offset()).toBe(4996);
  });

  it('keeps the last estimate while no events arrive', () => {
    let now = 1_000_000;
    const clock = new DeviceClock(1000, () => now);
    clock.observe(now - 2000);
    expect(clock.offset()).toBe(-2000);
    now += 5000;
    expect(clock.offset()).toBe(-2000);
  });
});

describe('ReplayFilter / VmStateStore', () => {
  it('drops replayed events that were delivered live, keeps new ones', () => {
    const f = new ReplayFilter();
    f.mark('Logging', 1000, 'a');
    f.mark('Logging', 1005, 'b');
    f.mark('Logging', 1005, 'c');
    expect(f.seen('Logging', 999, 'x')).toBe(true);
    expect(f.seen('Logging', 1005, 'b')).toBe(true);
    expect(f.seen('Logging', 1005, 'd')).toBe(false);
    expect(f.seen('Logging', 1006, 'b')).toBe(false);
    expect(f.seen('Stdout', 1, 'b')).toBe(false);
    expect(f.seen('Logging', undefined, 'b')).toBe(false);
  });

  it('keeps per-VM state across lookups (start time jitters) and evicts the least recently used', () => {
    const store = new VmStateStore(2);
    const a = store.resolve(100, 1_793_612_890_838);
    // The VM reports "now − uptime": the same process may answer 1 ms later.
    const again = store.resolve(100, 1_793_612_890_839);
    expect(again.state).toBe(a.state);
    expect(again.startTime).toBe(1_793_612_890_838);
    expect(store.resolve(100, 1_793_612_999_000).state).not.toBe(a.state); // restarted app, reused pid
    store.resolve(200, 1); // evicts the least recently used (pid 100, first start)
    expect(store.resolve(100, 1_793_612_890_838).state).not.toBe(a.state);
    expect(sameVmProcess({ pid: 1, startTime: 0 }, { pid: 1, startTime: 1999 })).toBe(true);
    expect(sameVmProcess({ pid: 1, startTime: 0 }, { pid: 2, startTime: 0 })).toBe(false);
  });
});
