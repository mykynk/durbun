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

const { hubActions, logStore, metricsStore, setScope } = await import('../../data');
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
  logStore.reset();
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

  const native = (platform: 'android' | 'ios'): AppSession => ({
    ...PATI,
    id: 'app:9',
    sessionKey: 's9',
    sdk: { name: `durbun-${platform}`, version: '0.3.0', platform },
    app: { name: 'Cüzdan', id: 'com.example.wallet', pid: 4242 },
  });

  function stream(appId: string, rows: (i: number) => Record<string, number | undefined>) {
    const now = Date.now();
    metricsStore.push(Array.from({ length: 30 }, (_, i) => ({ ts: now - (30 - i) * 1000, deviceId: 'demo:1', appId, source: 'sdk' as const, cpu: 12, memoryMB: 180, ...rows(i) })));
    metricsStore.flush();
  }

  const launchLine = (appId: string, data: unknown) => ({ id: 1, ts: Date.now() - 40_000, deviceId: 'demo:1', source: 'app' as const, appId, level: 'info' as const, tag: 'event', kind: 'event' as const, message: 'durbun.launch', data });

  const tile = (label: string) => screen.getByRole('group', { name: label });

  it('native Android: frame times as UI thread / RenderThread, idle screens as idle, and the cold start time', () => {
    hubActions.replaceAll({ devices: [PIXEL], apps: [native('android')], drivers: [], processes: [] });
    act(() => setScope({ kind: 'app', appId: 'app:9' }));
    logStore.append([launchLine('app:9', { kind: 'cold', ms: 1243, to: 'firstFrame', from: 'launchRequest', screen: 'MainActivity' })]);
    // Frames drawn for 20 s, then an idle screen: FrameMetrics sends no fps and no frame times.
    stream('app:9', (i) => (i < 20 ? { fps: 58, jankyFrames: 0, frameBuildMs: 4.2, frameRasterMs: 6.1 } : {}));
    renderView();
    expect(tile('FPS').textContent).toContain('boşta');
    expect(tile('FPS').textContent).not.toMatch(/\b0\b/);
    expect(screen.getByText('Kare süresi')).toBeTruthy();
    expect(screen.getAllByText('UI thread').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RenderThread').length).toBeGreaterThan(0);
    expect(screen.queryByText('Hazırlama')).toBeNull();
    expect(tile('Açılış').textContent).toMatch(/1,24\s*sn/);
    // One line (cut with an ellipsis when the tile is narrow), the whole text in its tooltip: the tile row stays even.
    const sub = tile('Açılış').querySelector('.pf-tile__sub--line');
    expect(sub?.textContent).toBe('soğuk · MainActivity');
    expect(sub?.getAttribute('title')).toBe('soğuk · MainActivity');
    expect(screen.getByRole('button', { name: 'Loglarda göster' })).toBeTruthy();
    // CPU, memory, frames, frame times, requests and logs charts.
    expect(created.length).toBe(6);
  });

  it('native Android that has drawn nothing yet: idle and no frames, never 0 FPS or "does not report"', () => {
    hubActions.replaceAll({ devices: [PIXEL], apps: [native('android')], drivers: [], processes: [] });
    act(() => setScope({ kind: 'app', appId: 'app:9' }));
    stream('app:9', () => ({}));
    renderView();
    expect(tile('FPS').textContent).toContain('boşta');
    expect(tile('FPS').textContent).toContain('kare çizilmedi');
    expect(tile('Açılış').textContent).toContain('bu açılışta gelmedi');
    expect(screen.queryByText('Kare süresi')).toBeNull();
  });

  it('iOS prewarmed launch: said in words, without a time', () => {
    hubActions.replaceAll({ devices: [PIXEL], apps: [native('ios')], drivers: [], processes: [] });
    act(() => setScope({ kind: 'app', appId: 'app:9' }));
    logStore.append([launchLine('app:9', { kind: 'prewarmed', to: 'firstFrame' })]);
    stream('app:9', () => ({ fps: 60 }));
    renderView();
    expect(tile('Açılış').textContent).toContain('önceden başlatıldı');
    expect(tile('Açılış').textContent).not.toMatch(/\d/);
  });

  it('Flutter: build / raster names and no launch tile', () => {
    hubActions.replaceAll({ devices: [PIXEL], apps: [PATI], drivers: [], processes: [] });
    act(() => setScope({ kind: 'app', appId: 'app:1' }));
    stream('app:1', () => ({ fps: 60, frameBuildMs: 3, frameRasterMs: 5 }));
    renderView();
    // Flutter's own phase names (DevTools uses them too), in both languages.
    expect(screen.getAllByText('Build').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Raster').length).toBeGreaterThan(0);
    expect(screen.queryByText('UI thread')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Açılış' })).toBeNull();
  });
});
