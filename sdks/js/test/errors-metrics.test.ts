/** Global error capture (RN ErrorUtils, browser events, Node monitor) and metric samples. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Durbun } from '../src/index.js';
import { installErrorHandlers, type ErrorReport } from '../src/errors.js';
import { MetricsSampler, readHeapMB } from '../src/metrics.js';
import { FakeDesktop, waitFor } from './helpers/fakeDesktop.js';

let desktop: FakeDesktop | undefined;

afterEach(async () => {
  Durbun.stop();
  delete (globalThis as Record<string, unknown>).ErrorUtils;
  delete (globalThis as Record<string, unknown>).HermesInternal;
  await desktop?.close();
  desktop = undefined;
});

async function start(opts: Parameters<typeof Durbun.start>[0] = {}, config = {}) {
  desktop = await FakeDesktop.start({ config });
  Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureNetwork: false, captureMetrics: false, ...opts });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

function fakeErrorUtils() {
  const previous = vi.fn();
  const eu = {
    handler: previous as unknown as (e: unknown, fatal?: boolean) => void,
    setGlobalHandler(h: (e: unknown, fatal?: boolean) => void) {
      this.handler = h;
    },
    getGlobalHandler() {
      return this.handler;
    },
  };
  (globalThis as Record<string, unknown>).ErrorUtils = eu;
  return { eu, previous };
}

describe('React Native ErrorUtils', () => {
  it('reports fatal errors as crashes and always chains to the previous handler', async () => {
    const { eu, previous } = fakeErrorUtils();
    const d = await start();
    const err = new TypeError("undefined is not an object (evaluating 'user.name')");
    eu.getGlobalHandler()(err, true);
    eu.getGlobalHandler()(new Error('soft'), false);
    eu.getGlobalHandler()('thrown string', false);
    expect(previous).toHaveBeenCalledTimes(3);
    expect(previous).toHaveBeenNthCalledWith(1, err, true);
    await waitFor(() => d.logs().length >= 3, 5_000, 'error logs');
    const [crash, soft, str] = d.logs();
    expect(crash).toMatchObject({
      level: 'fatal',
      kind: 'crash',
      tag: 'uncaught',
      message: "Uncaught TypeError: undefined is not an object (evaluating 'user.name')",
      error: { type: 'TypeError', message: "undefined is not an object (evaluating 'user.name')" },
    });
    expect(crash.error.stack).toContain('TypeError');
    expect(soft).toMatchObject({ level: 'error', kind: 'text', message: 'Uncaught Error: soft' });
    expect(str).toMatchObject({ level: 'error', message: 'Uncaught: thrown string' });
  });

  it('restores the previous handler on stop (unless someone replaced ours)', async () => {
    const { eu, previous } = fakeErrorUtils();
    await start();
    expect(eu.getGlobalHandler()).not.toBe(previous);
    Durbun.stop();
    expect(eu.getGlobalHandler()).toBe(previous);
  });
});

describe('error hooks per runtime', () => {
  it('browser: listens to error + unhandledrejection without touching other listeners', () => {
    const target = new EventTarget() as EventTarget & Record<string, unknown>;
    const reports: Array<[unknown, ErrorReport]> = [];
    const patches = installErrorHandlers({ reportError: (e, r) => reports.push([e, r]) }, 'web', target);
    const err = new Error('boom');
    const errorEvent = Object.assign(new Event('error'), { error: err, message: 'boom', filename: 'https://app.test/main.js', lineno: 10, colno: 5 });
    target.dispatchEvent(errorEvent);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('nope') }));
    target.dispatchEvent(Object.assign(new Event('error'), { error: null, message: undefined })); // resource error: ignored
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual([err, { fatal: false, origin: 'uncaught', location: 'https://app.test/main.js:10:5' }]);
    expect(reports[1][1]).toEqual({ fatal: false, origin: 'unhandled-rejection' });
    for (const p of patches) p.restore();
    target.dispatchEvent(errorEvent);
    expect(reports).toHaveLength(2);
  });

  it('Node: observes uncaught exceptions through uncaughtExceptionMonitor', async () => {
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const d = await start();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
    emit('uncaughtExceptionMonitor', new RangeError('bad index'), 'uncaughtException');
    emit('uncaughtExceptionMonitor', new Error('rejected'), 'unhandledRejection');
    await waitFor(() => d.logs().length >= 2, 5_000, 'logs');
    const [a, b] = d.logs();
    expect(a).toMatchObject({ tag: 'uncaught', message: 'Uncaught RangeError: bad index' });
    expect(b).toMatchObject({ tag: 'unhandled-rejection', message: 'Unhandled promise rejection Error: rejected' });
    Durbun.stop();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before);
  });

  it('captureErrors: false installs nothing', async () => {
    const { eu, previous } = fakeErrorUtils();
    await start({ captureErrors: false });
    expect(eu.getGlobalHandler()).toBe(previous);
    expect(desktop!.messages('hello')[0].capabilities).not.toContain('crash');
  });
});

describe('metrics', () => {
  it('reads the Hermes heap when available', () => {
    (globalThis as Record<string, unknown>).HermesInternal = { getInstrumentedStats: () => ({ js_allocatedBytes: 52_428_800, js_heapSize: 67_108_864 }) };
    expect(readHeapMB()).toBe(50);
  });

  it('samples heap, RSS and CPU in Node', () => {
    const samples: unknown[] = [];
    const sampler = new MetricsSampler((s) => samples.push(s));
    sampler.start(10_000);
    let x = 0;
    for (let i = 0; i < 2e6; i++) x += Math.sqrt(i);
    const sample = sampler.sample();
    sampler.stop();
    expect(x).toBeGreaterThan(0);
    expect(sample).toMatchObject({ type: 'metric' });
    expect(sample!.heapMB).toBeGreaterThan(0);
    expect(sample!.memoryMB).toBeGreaterThan(0);
    expect(sample!.cpu).toBeGreaterThanOrEqual(0);
  });

  it('counts frames and janky frames with requestAnimationFrame', () => {
    vi.useFakeTimers();
    const g = globalThis as Record<string, unknown>;
    let now = 0;
    const callbacks: Array<(t: number) => void> = [];
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      callbacks.push(cb);
      return callbacks.length;
    };
    g.cancelAnimationFrame = () => undefined;
    try {
      const sampler = new MetricsSampler(() => undefined);
      sampler.start(1000);
      const frame = (dt: number) => {
        now += dt;
        vi.advanceTimersByTime(dt);
        const cb = callbacks.shift();
        cb?.(now);
      };
      frame(16); // first frame only sets the baseline
      for (let i = 0; i < 50; i++) frame(16.7);
      frame(100); // a long frame = jank
      frame(16.7);
      const sample = sampler.sample();
      sampler.stop();
      expect(sample!.jankyFrames).toBe(1);
      expect(sample!.fps).toBeGreaterThan(30);
    } finally {
      delete g.requestAnimationFrame;
      delete g.cancelAnimationFrame;
      vi.useRealTimers();
    }
  });

  it('streams metric messages at the configured interval while connected', async () => {
    const d = await start({ captureMetrics: true }, { metricsIntervalMs: 250 });
    expect(d.messages('hello')[0].capabilities).toContain('metrics');
    await waitFor(() => d.messages('metric').length >= 2, 5_000, 'metrics');
    const m = d.messages('metric')[0];
    expect(m.heapMB).toBeGreaterThan(0);
    expect(typeof m.ts).toBe('number');
  });
});
