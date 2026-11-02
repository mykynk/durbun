import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AppSession, DeviceInfo } from '@durbun/protocol';

// jsdom has no canvas: replace uPlot with a recorder.
const created: { series: number; data: unknown[] }[] = [];
vi.mock('uplot', () => {
  class FakePlot {
    static pxRatio = 1;
    static paths = { bars: () => () => null };
    over = document.createElement('div');
    bbox = { left: 50, top: 0, width: 400, height: 100 };
    width = 400;
    height = 100;
    scales = { x: { min: 0, max: 1 } };
    cursor = { idx: null, idxs: [] };
    data: unknown[];
    constructor(opts: { series: unknown[]; hooks?: { ready?: ((u: unknown) => void)[] } }, data: unknown[], el: HTMLElement) {
      this.data = data;
      el.appendChild(this.over);
      created.push({ series: opts.series.length, data });
      opts.hooks?.ready?.forEach((h) => h(this));
    }
    setData(d: unknown[]) {
      this.data = d;
    }
    setSize() {}
    redraw() {}
    destroy() {}
    valToPos() {
      return 0;
    }
    posToVal() {
      return 0;
    }
  }
  return { default: FakePlot };
});

const { hubActions, metricsStore, setScope } = await import('../../data');
const { FeatureContext } = await import('../../components');
const { setLanguage } = await import('../../i18n');
const { default: PerfView } = await import('./index');

const PIXEL: DeviceInfo = {
  id: 'demo:1',
  platform: 'android',
  kind: 'emulator',
  name: 'Pixel 8 · Demo',
  connection: 'local',
  state: 'online',
  logs: { status: 'streaming' },
  actions: [],
  firstSeen: 0,
  lastSeen: 0,
};

const PATI: AppSession = {
  id: 'app:1',
  sessionKey: 's1',
  deviceId: 'demo:1',
  sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter' },
  app: { name: 'Pati', id: 'com.mykynk.pati', pid: 8421 },
  transport: 'demo',
  connected: true,
  connectedAt: 1,
  capabilities: ['logs', 'metrics'],
  actions: [],
  stats: { logs: 0, requests: 0, errors: 0 },
};

function renderView() {
  return render(
    <FeatureContext.Provider value={{ tab: 'perf', active: true }}>
      <PerfView />
    </FeatureContext.Provider>,
  );
}

beforeEach(() => {
  setLanguage('tr');
  created.length = 0;
});

afterEach(() => {
  cleanup();
  hubActions.reset();
  metricsStore.reset();
  setScope({ kind: 'all' });
  setLanguage('en');
});

describe('PerfView', () => {
  it('explains how to get metrics when there is no target', () => {
    hubActions.replaceAll({ devices: [PIXEL], apps: [], drivers: [], processes: [] });
    renderView();
    expect(screen.getByText('Henüz performans verisi yok')).toBeTruthy();
    expect(screen.getByText('Bir süreci ölç')).toBeTruthy();
    expect(screen.getByText('Dart VM Service bağla')).toBeTruthy();
    expect(screen.getByText('SDK kurulumu')).toBeTruthy();
  });

  it('shows tiles and charts for an app streaming metrics', () => {
    hubActions.replaceAll({ devices: [PIXEL], apps: [PATI], drivers: [], processes: [] });
    act(() => setScope({ kind: 'app', appId: 'app:1' }));
    const now = Date.now();
    metricsStore.push(
      Array.from({ length: 30 }, (_, i) => ({
        ts: now - (30 - i) * 1000,
        deviceId: 'demo:1',
        appId: 'app:1',
        source: 'sdk' as const,
        cpu: 10 + (i % 5),
        memoryMB: 200 + i,
        heapMB: 40,
        fps: i === 29 ? 0 : 60,
        jankyFrames: i % 10 === 0 ? 2 : 0,
      })),
    );
    metricsStore.flush();
    renderView();
    expect(screen.getAllByText('Pati').length).toBeGreaterThan(0);
    for (const label of ['CPU', 'Bellek', 'Heap', 'FPS', 'Takılma', 'İstek/sn', 'Log/sn', 'Hatalar']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    // The newest sample has fps 0 on a Flutter app → idle, not frozen.
    expect(screen.getAllByText('boşta').length).toBeGreaterThan(0);
    // CPU, memory, frames, requests and logs charts.
    expect(created.length).toBe(5);
    expect(screen.getByRole('radio', { name: '5 dk' }).getAttribute('aria-checked')).toBe('true');
  });
});
