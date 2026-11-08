import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetricSample } from '@durbun/protocol';
import { MetricsStore, METRIC_SERIES_TTL_MS } from '../../src/hub/metrics';
import type { Hub } from '../../src/types';
import { appInput, device, makeHub } from './helpers';

/**
 * The Mac app runs for days and every Flutter hot restart is a new session (a new series): the metrics
 * store is bounded as a whole, old series of sessions nobody shows go after a few hours.
 */

const sample = (deviceId: string, appId: string | undefined, ts: number, pid?: number): MetricSample => ({
  ts,
  deviceId,
  source: 'sdk',
  cpu: 1,
  ...(appId ? { appId } : {}),
  ...(pid !== undefined ? { pid } : {}),
});

describe('MetricsStore bounds', () => {
  it('evicts whole series, least recently updated first, never the one being written', () => {
    let now = 0;
    const store = new MetricsStore({ perSeries: 10, maxSamples: 30, now: () => now });
    for (const app of ['a', 'b', 'c', 'd']) {
      for (let i = 0; i < 10; i++) {
        now++;
        store.push(sample('android:X', app, now));
      }
    }
    expect(store.sampleCount).toBeLessThanOrEqual(30);
    const apps = new Set(store.all().map((s) => s.appId));
    expect(apps.has('a')).toBe(false); // the oldest
    expect(apps.has('d')).toBe(true);
    expect(store.sampleCount).toBe(store.all().length);
  });

  it('evicts kept series only after all others', () => {
    let now = 0;
    const store = new MetricsStore({ perSeries: 10, maxSamples: 20, now: () => now, keep: () => (s) => s.appId === 'a' });
    for (const app of ['a', 'b', 'c']) {
      for (let i = 0; i < 10; i++) store.push(sample('android:X', app, ++now));
    }
    expect([...new Set(store.all().map((s) => s.appId))].sort()).toEqual(['a', 'c']);
  });

  it(`drops series without a sample for ${METRIC_SERIES_TTL_MS / 3_600_000} h unless kept, checking about once a minute`, () => {
    let now = 1_000;
    const store = new MetricsStore({ now: () => now, keep: () => (s) => s.appId === 'live' });
    store.push(sample('android:X', 'old', now));
    store.push(sample('android:X', 'live', now));
    store.push(sample('android:X', undefined, now, 4321)); // device polling of a process
    now += METRIC_SERIES_TTL_MS + 60_001;
    store.push(sample('ios:Y', 'other', now));
    expect(store.all().map((s) => s.appId ?? `pid ${s.pid}`).sort()).toEqual(['live', 'other']);
    expect(store.seriesCount).toBe(2);
    expect(store.sampleCount).toBe(2);
  });

  it('keeps its count right through removeWhere and clear', () => {
    const store = new MetricsStore();
    for (let i = 0; i < 5; i++) store.push(sample('android:X', 'a', i));
    store.push(sample('ios:Y', 'b', 9));
    store.removeWhere((s) => s.deviceId === 'android:X' && s.ts < 3);
    expect(store.sampleCount).toBe(3);
    store.clear();
    expect(store.sampleCount).toBe(0);
  });
});

describe('hub metrics over days', () => {
  let hub: Hub;
  afterEach(() => {
    hub?.dispose();
    vi.useRealTimers();
  });

  it('drops the series of older sessions after the TTL, keeps the newest session of the app and connected ones', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_762_000_000_000);
    hub = makeHub();
    hub.upsertDevice(device('android:R5CT'));
    const first = hub.registerApp(appInput('android:R5CT', { sessionKey: 'launch-1', connectedAt: Date.now() }));
    hub.pushAppMetrics(first.id, { ts: Date.now(), source: 'sdk', cpu: 10 });
    hub.markAppDisconnected(first.id);
    vi.setSystemTime(Date.now() + 1_000);
    const second = hub.registerApp(appInput('android:R5CT', { sessionKey: 'launch-2', connectedAt: Date.now() })); // hot restart
    hub.pushAppMetrics(second.id, { ts: Date.now(), source: 'sdk', cpu: 20 });
    hub.markAppDisconnected(second.id);
    const other = hub.registerApp(appInput('android:R5CT', { sessionKey: 'w', connectedAt: Date.now(), app: { name: 'Widget', id: 'com.mykynk.widget' } }));
    hub.pushAppMetrics(other.id, { ts: Date.now(), source: 'sdk', cpu: 30 });

    vi.setSystemTime(Date.now() + METRIC_SERIES_TTL_MS + 120_000);
    hub.pushMetrics([sample('ios:Y', undefined, Date.now(), 7)]); // any sample runs the pruning
    expect(new Set(hub.getMetrics().map((s) => s.appId ?? s.deviceId))).toEqual(new Set([second.id, other.id, 'ios:Y']));
  });
});
