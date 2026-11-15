/** Frame counting: every frame in the foreground, exact per interval; nothing while the app is in the background. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setReactNativeModuleForTests } from '../src/env.js';
import { MetricsSampler } from '../src/metrics.js';
import type { SdkMetric } from '../src/protocol.js';

const g = globalThis as Record<string, unknown>;

/** A display that refreshes every `frameMs` and runs the requestAnimationFrame callbacks queued for it. */
class FakeDisplay {
  queue: Array<(t: number) => void> = [];
  requests = 0;
  /** Extra time the next frame takes (a long JS task). */
  stallMs = 0;
  private clock = 0;

  constructor(private readonly frameMs: number) {
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      this.requests++;
      this.queue.push(cb);
      return this.requests;
    };
    g.cancelAnimationFrame = () => {
      this.queue = [];
    };
  }

  /** Advances the clock by `ms`, one refresh at a time; returns the number of frames shown. */
  run(ms: number): number {
    let left = ms;
    let shown = 0;
    while (left > 1e-6) {
      const step = Math.min(left, this.frameMs + this.stallMs);
      this.stallMs = 0;
      // Whole milliseconds for the fake clock, without drifting from the display's own time.
      vi.advanceTimersByTime(Math.round(this.clock + step) - Math.round(this.clock));
      this.clock += step;
      left -= step;
      const due = this.queue;
      this.queue = [];
      for (const cb of due) cb(Date.now());
      shown++;
    }
    return shown;
  }
}

let samples: SdkMetric[];

beforeEach(() => {
  vi.useFakeTimers();
  samples = [];
});

afterEach(() => {
  delete g.requestAnimationFrame;
  delete g.cancelAnimationFrame;
  __setReactNativeModuleForTests(undefined);
  vi.useRealTimers();
});

function sampler(): MetricsSampler {
  return new MetricsSampler((s) => samples.push(s));
}

describe('frame counting in the foreground', () => {
  it('counts every frame: exact fps and janky frames per interval', () => {
    const display = new FakeDisplay(20); // 50 Hz, whole milliseconds
    const s = sampler();
    s.start(1000);
    display.run(3000);
    s.stop();
    expect(samples).toHaveLength(3);
    // Frames at 20, 40 … 980 ms (the one at 1000 ms runs after that sample); the first only sets the baseline.
    expect(samples[0].fps).toBe(48);
    expect(samples[1].fps).toBe(50);
    expect(samples[2].fps).toBe(50);
    for (const m of samples) expect(m.jankyFrames).toBe(0);
    // One callback per frame, the whole time.
    expect(display.requests).toBeGreaterThanOrEqual(150);
  });

  it('a stall is counted once, also when it crosses the sample boundary', () => {
    const display = new FakeDisplay(20);
    const s = sampler();
    s.start(1000);
    display.run(1000); // sample 1
    display.run(980); // last frame of interval 2 at 1980 ms
    display.stallMs = 80; // next frame at 2080 ms: spans the 2000 ms sample
    display.run(1020);
    s.stop();
    expect(samples).toHaveLength(3);
    expect(samples[1].jankyFrames).toBe(0);
    expect(samples[2].jankyFrames).toBe(1);
    // 2000–3000 ms: the stalled frame (1980→2080) plus the frames at 2100 … 2980 ms.
    expect(samples[2].fps).toBe(46);
  });

  it('several hitches in one interval are all counted', () => {
    const display = new FakeDisplay(20);
    const s = sampler();
    s.start(1000);
    display.run(1000);
    for (let i = 0; i < 3; i++) {
      display.run(100);
      display.stallMs = 60;
      display.run(80);
    }
    display.run(1000);
    s.stop();
    expect(samples[1].jankyFrames).toBe(3);
  });

  it('a gap over a second starts a fresh measurement instead of counting as jank', () => {
    const display = new FakeDisplay(20);
    const s = sampler();
    s.start(5000);
    display.run(100);
    display.stallMs = 1500;
    display.run(3000);
    const m = s.sample();
    s.stop();
    expect(m?.jankyFrames).toBe(0);
  });

  it('stops asking for frames once stopped', () => {
    const display = new FakeDisplay(20);
    const s = sampler();
    s.start(1000);
    display.run(100);
    s.stop();
    const before = display.requests;
    display.run(3000);
    expect(display.requests).toBe(before);
    expect(s.countingFrames).toBe(false);
    expect(samples).toHaveLength(0);
  });
});

describe('background', () => {
  function fakeAppState(initial: string) {
    const listeners: Array<(state: string) => void> = [];
    const appState = {
      currentState: initial,
      addEventListener(_type: string, fn: (state: string) => void) {
        listeners.push(fn);
        return { remove: () => listeners.splice(listeners.indexOf(fn), 1) };
      },
      set(state: string) {
        this.currentState = state;
        for (const l of listeners.slice()) l(state);
      },
      listeners,
    };
    __setReactNativeModuleForTests({ AppState: appState });
    return appState;
  }

  it('React Native: no frame callbacks in the background; back in the foreground without a jank spike', () => {
    const appState = fakeAppState('active');
    const display = new FakeDisplay(20);
    const s = sampler();
    s.start(1000);
    display.run(1000);
    appState.set('background');
    const before = display.requests;
    display.run(5000);
    expect(display.requests).toBe(before);
    for (const m of samples.slice(1)) expect(m.fps).toBeUndefined();
    appState.set('active');
    display.run(2000);
    expect(display.requests).toBeGreaterThan(before);
    const after = samples.slice(-2);
    for (const m of after) expect(m.jankyFrames).toBe(0);
    expect(after[1].fps).toBe(50);
    s.stop();
    expect(appState.listeners).toHaveLength(0);
    expect(s.countingFrames).toBe(false);
  });

  it('React Native: inactive counts as background; an app started in the background waits', () => {
    const appState = fakeAppState('background');
    const display = new FakeDisplay(20);
    const s = sampler();
    s.start(1000);
    display.run(3000);
    expect(display.requests).toBe(0);
    appState.set('active');
    display.run(1000);
    expect(display.requests).toBeGreaterThan(0);
    appState.set('inactive');
    const before = display.requests;
    display.run(1000);
    expect(display.requests).toBe(before);
    s.stop();
  });

  it('web: no frame callbacks while the page is hidden; listener removed on stop', () => {
    const listeners: Array<() => void> = [];
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
    };
    g.document = doc;
    try {
      const display = new FakeDisplay(20);
      const s = sampler();
      s.start(1000);
      display.run(500);
      doc.visibilityState = 'hidden';
      listeners.forEach((l) => l());
      const before = display.requests;
      display.run(3000);
      expect(display.requests).toBe(before);
      doc.visibilityState = 'visible';
      listeners.forEach((l) => l());
      display.run(1000);
      expect(display.requests).toBeGreaterThan(before);
      s.stop();
      expect(listeners).toHaveLength(0);
    } finally {
      delete g.document;
    }
  });
});
