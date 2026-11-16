import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { AppSession, DeviceInfo, ProcessUpdate, UiToServer } from '@durbun/protocol';
import { hubActions, setScope } from '../../data';
import { __resetCommandsForTests, handleReply, setCommandTransport } from '../../data/commands';
import { FeatureContext } from '../../components';
import { setLanguage } from '../../i18n';
import DeviceView from './index';
import { useRecorder } from './stores';
import { useMediaLibrary } from './media/store';
import { useStickyDefault } from './useAction';

const PIXEL: DeviceInfo = {
  id: 'demo:1',
  platform: 'android',
  kind: 'emulator',
  name: 'Pixel 8 · Demo',
  model: 'Pixel 8',
  manufacturer: 'Google',
  osVersion: '15',
  apiLevel: 35,
  serial: 'emulator-5554',
  connection: 'local',
  state: 'online',
  battery: { level: 87, charging: true },
  screen: { width: 1080, height: 2400, density: 420 },
  logs: { status: 'streaming', via: 'demo' },
  actions: ['screenshot', 'open-url', 'app-launch', 'app-stop', 'appearance', 'font-scale', 'animations', 'input-text', 'key-event', 'location', 'logs-restart'],
  firstSeen: Date.now() - 60_000,
  lastSeen: Date.now(),
};

const IPHONE: DeviceInfo = { ...PIXEL, id: 'demo:2', platform: 'ios', kind: 'simulator', name: 'iPhone 16 Pro · Demo', actions: ['push-notification', 'status-bar'] };

const PATI: AppSession = {
  id: 'app:1',
  sessionKey: 's1',
  deviceId: 'demo:1',
  sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter' },
  app: { name: 'Pati', id: 'com.mykynk.pati', version: '2.4.1', pid: 8421 },
  transport: 'demo',
  connected: true,
  connectedAt: Date.now() - 30_000,
  capabilities: ['logs', 'metrics', 'commands'],
  actions: [
    { id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', labelKey: 'flutter.debugPaint', group: 'flutter', value: false },
    {
      id: 'flutter.brightness',
      kind: 'select',
      label: 'Brightness',
      labelKey: 'flutter.brightness',
      group: 'flutter',
      options: [
        { value: 'system', label: 'System' },
        { value: 'dark', label: 'Dark' },
      ],
      value: 'system',
    },
    { id: 'flutter.dumpWidgetTree', kind: 'button', label: 'Dump widget tree', labelKey: 'flutter.dumpWidgetTree', group: 'flutter' },
    { id: 'mahalle.clearCache', kind: 'button', label: 'Clear image cache', group: 'app' },
  ],
  stats: { logs: 0, requests: 0, errors: 0 },
};

const proc = (pid: number, name: string): ProcessUpdate => ({ deviceId: 'demo:1', pid, name, event: 'seen', ts: 0 });

function renderView(active = false) {
  return render(
    <FeatureContext.Provider value={{ tab: 'device', active }}>
      <DeviceView />
    </FeatureContext.Provider>,
  );
}

beforeEach(() => {
  setLanguage('tr');
  hubActions.replaceAll({ devices: [PIXEL, IPHONE], apps: [PATI], drivers: [], processes: [proc(1043, 'system_server'), proc(8421, 'com.mykynk.pati')] });
});

afterEach(() => {
  cleanup();
  setCommandTransport(null);
  __resetCommandsForTests();
  useMediaLibrary.setState({ status: 'idle', items: [], usedBytes: 0, total: 0, pendingDelete: {}, error: undefined });
  useRecorder.setState({ runs: {}, errors: {} });
  hubActions.reset();
  setScope({ kind: 'all' });
  setLanguage('en');
});

describe('DeviceView', () => {
  it('shows the device picker on the "all devices" scope with several devices', () => {
    setScope({ kind: 'all' });
    renderView();
    expect(screen.getByText('Bir cihaz seçin')).toBeTruthy();
    expect(screen.getByText('Pixel 8 · Demo')).toBeTruthy();
    expect(screen.getByText('iPhone 16 Pro · Demo')).toBeTruthy();
  });

  it('renders info, app tools and only the action cards the device supports', () => {
    act(() => setScope({ kind: 'device', deviceId: 'demo:1' }));
    renderView();
    expect(screen.getByText('Cihaz bilgileri')).toBeTruthy();
    expect(screen.getByText('emulator-5554')).toBeTruthy();
    expect(screen.getByText('@2.6x')).toBeTruthy();
    // App tools: localized built-in labels, descriptor label for custom ones.
    expect(screen.getByText('Yerleşim çizgileri (debug paint)')).toBeTruthy();
    expect(screen.getByText('Widget ağacı dökümü')).toBeTruthy();
    expect(screen.getByText('Clear image cache')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Koyu' })).toBeTruthy();
    // Action cards present for listed actions…
    for (const title of ['Ekran görüntüsü', 'Bağlantı / deep link aç', 'Görünüm', 'Girdi', 'Konum', 'Cihaz logları', 'Uygulamalar', 'Süreçler']) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    // …and absent for simulator-only ones.
    expect(screen.queryByText('Bildirim gönder')).toBeNull();
    expect(screen.queryByText('Durum çubuğu')).toBeNull();
    // Processes: the SDK app's process first, with a watch button.
    const procs = screen.getByRole('list', { name: 'Cihaz süreçleri' });
    expect(within(procs).getAllByRole('listitem')[0]!.textContent).toContain('com.mykynk.pati');
    expect(within(procs).getAllByRole('button', { name: /Performansı izle|için performansı izle/ }).length).toBe(2);
  });

  it('simulator cards: push editor with a valid template, status bar, screen recording', () => {
    hubActions.upsertDevices([{ ...IPHONE, actions: ['push-notification', 'status-bar', 'screen-record'] }]);
    act(() => setScope({ kind: 'device', deviceId: 'demo:2' }));
    renderView();
    expect(screen.getByText('Bildirim gönder')).toBeTruthy();
    expect(screen.getByText(/Geçerli · \d+ \/ 4096 bayt/)).toBeTruthy();
    expect(screen.getByText('Temiz durum çubuğu')).toBeTruthy();
    expect(screen.getByText('Ekran kaydı')).toBeTruthy();
    expect(screen.getByText('En fazla 10 dk')).toBeTruthy();
    expect(screen.getByText('Kaydı başlat')).toBeTruthy();
    // Android-only cards are absent on the simulator.
    expect(screen.queryByText('Girdi')).toBeNull();
  });

  it('screen recording runs until Stop; the file comes from either reply, once', async () => {
    const sent: Array<Extract<UiToServer, { type: 'command' }>> = [];
    setCommandTransport({ isOpen: () => true, send: (m) => (m.type === 'command' && sent.push(m), true) });
    const sim: DeviceInfo = { ...IPHONE, actions: ['screen-record', 'screen-record-stop'] };
    hubActions.upsertDevices([sim]);
    act(() => setScope({ kind: 'device', deviceId: 'demo:2' }));
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Kaydı başlat' }));
    expect(sent[0]!.command).toMatchObject({ name: 'device.action', action: 'screen-record', params: {} });
    expect(screen.getByRole('status').textContent).toBe('Kaydediliyor');
    // The server reports the running recording (a reload would see only this).
    act(() => hubActions.upsertDevices([{ ...sim, recording: { startedAt: Date.now(), limitSec: 600 } }]));
    expect(screen.getByRole('timer').textContent).toMatch(/^0:0\d \/ 10:00$/);
    expect(screen.queryByRole('button', { name: 'Kaydı başlat' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Durdur' }));
    expect(sent[1]!.command).toMatchObject({ name: 'device.action', action: 'screen-record-stop' });
    expect(screen.getByRole('status').textContent).toBe('Kayıt cihazdan aktarılıyor…');

    const data = { url: '/api/files/rec.mov', file: '/tmp/rec.mov', durationSec: 12, endedBy: 'stop' };
    await act(async () => {
      handleReply({ type: 'reply', requestId: sent[1]!.requestId, ok: true, data });
      handleReply({ type: 'reply', requestId: sent[0]!.requestId, ok: true, data });
    });
    act(() => hubActions.upsertDevices([sim]));
    const list = screen.getByRole('list', { name: 'Bu cihazın kayıtları' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('0:12')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kaydı başlat' })).toBeTruthy();
  });

  it('a recording started elsewhere (before a reload) can be stopped here', async () => {
    const sent: Array<Extract<UiToServer, { type: 'command' }>> = [];
    setCommandTransport({ isOpen: () => true, send: (m) => (m.type === 'command' && sent.push(m), true) });
    const sim: DeviceInfo = { ...IPHONE, actions: ['screen-record', 'screen-record-stop'] };
    hubActions.upsertDevices([{ ...sim, recording: { startedAt: Date.now() - 65_000, limitSec: 600 } }]);
    act(() => setScope({ kind: 'device', deviceId: 'demo:2' }));
    renderView();
    expect(screen.getByRole('timer').textContent).toMatch(/^1:0\d \/ 10:00$/);
    fireEvent.click(screen.getByRole('button', { name: 'Durdur' }));
    await act(async () => {
      handleReply({ type: 'reply', requestId: sent[0]!.requestId, ok: true, data: { url: '/api/files/old.mov', durationSec: 66 } });
    });
    act(() => hubActions.upsertDevices([sim]));
    expect(within(screen.getByRole('list', { name: 'Bu cihazın kayıtları' })).getByText('1:06')).toBeTruthy();
    expect(useRecorder.getState().runs).toEqual({});
  });

  it('a disconnected device is read-only (info only, no actions)', () => {
    hubActions.upsertDevices([{ ...PIXEL, state: 'disconnected', stateCode: 'demo.stopped' }]);
    act(() => setScope({ kind: 'device', deviceId: 'demo:1' }));
    renderView();
    expect(screen.getAllByText('Demo kapatıldı').length).toBeGreaterThan(0);
    expect(screen.getByText('Bilgiler son bağlantıdan. Cihaz işlemleri cihaz yeniden bağlandığında kullanılabilir.')).toBeTruthy();
    expect(screen.queryByText('Ekran görüntüsü al')).toBeNull();
    expect(screen.queryByText('Uygulama araçları')).toBeNull();
    // Two cards do not need a jump strip.
    expect(screen.queryByRole('navigation', { name: 'Bu sayfadaki kartlar' })).toBeNull();
  });

  it('jump strip: one chip per shown card in reading order; a chip scrolls to its card and focuses the heading', async () => {
    const scrolled = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = scrolled;
    try {
      act(() => setScope({ kind: 'device', deviceId: 'demo:1' }));
      renderView(true);
      const nav = screen.getByRole('navigation', { name: 'Bu sayfadaki kartlar' });
      const chips = within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(chips).toEqual(['Bilgiler', 'Araçlar', 'Uygulamalar', 'Dart VM', 'Süreçler', 'Loglar', 'Ekran görüntüsü', 'Deep link', 'Görünüm', 'Girdi', 'Konum']);
      // Every chip has its card, and the other way round.
      const cards = [...document.querySelectorAll('[data-section]')].map((c) => c.getAttribute('data-section'));
      expect(cards).toEqual(['info', 'tools', 'apps', 'vm', 'processes', 'logs', 'screenshot', 'open-url', 'appearance', 'input', 'location']);

      fireEvent.click(within(nav).getByRole('button', { name: 'Konum' }));
      const heading = screen.getByRole('heading', { name: 'Konum' });
      await waitFor(() => expect(document.activeElement).toBe(heading));
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(heading.closest('[data-section]')!.getAttribute('data-flash')).toBe('true');
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it('the device\'s own data (logs, report) sits in the left column, tester actions in the right', () => {
    hubActions.upsertDevices([{ ...PIXEL, actions: [...PIXEL.actions, 'bug-report', 'bug-report-cancel', 'rotation'] }]);
    act(() => setScope({ kind: 'device', deviceId: 'demo:1' }));
    renderView();
    const left = screen.getByRole('region', { name: 'Cihaz ve uygulamalar' });
    const right = screen.getByRole('region', { name: 'Cihaz işlemleri' });
    const sections = (el: HTMLElement) => [...el.querySelectorAll('[data-section]')].map((c) => c.getAttribute('data-section'));
    expect(sections(left)).toEqual(['info', 'tools', 'apps', 'vm', 'processes', 'logs', 'bug-report']);
    expect(sections(right)).toEqual(['screenshot', 'open-url', 'appearance', 'screen', 'input', 'location']);
  });

  it('a default app stays put when the list re-sorts, and moves on only when it is gone', () => {
    let list = ['pati', 'kasa'];
    const hook = renderHook(() => useStickyDefault(list[0], (id) => list.includes(id)));
    expect(hook.result.current).toBe('pati');
    // Pati's SDK disconnects (its permission was revoked): it drops below Kasa, the choice does not follow the order.
    list = ['kasa', 'pati'];
    hook.rerender();
    expect(hook.result.current).toBe('pati');
    list = ['kasa'];
    hook.rerender();
    expect(hook.result.current).toBe('kasa');
  });

  it('changed settings name the permission and the app; the package and full id stay in the tooltip', () => {
    hubActions.upsertDevices([
      {
        ...PIXEL,
        actions: [...PIXEL.actions, 'app-permission', 'app-locale'],
        settingOverrides: [
          { action: 'app-permission', appId: 'com.mykynk.pati', key: 'android.permission.CAMERA', previous: 'granted', current: 'revoked', since: 1 },
          { action: 'app-permission', appId: 'com.example.other', key: 'android.permission.BODY_SENSORS', previous: 'revoked', current: 'granted', since: 2 },
          { action: 'app-locale', appId: 'com.mykynk.pati', previous: 'system', current: 'de-DE', since: 3 },
        ],
      },
    ]);
    act(() => setScope({ kind: 'device', deviceId: 'demo:1' }));
    renderView();
    const card = document.querySelector<HTMLElement>('[data-section="overrides"]')!;
    const camera = within(card).getByText('Kamera izni · Pati: reddedildi');
    expect(camera.getAttribute('title')).toBe('com.mykynk.pati · android.permission.CAMERA');
    // A permission the UI does not name keeps its id; an app it does not know keeps its package.
    expect(within(card).getByText('BODY_SENSORS izni · com.example.other: verildi')).toBeTruthy();
    expect(within(card).getByText('Uygulama dili · Pati: de-DE')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Kamera izni · Pati ayarını geri al' })).toBeTruthy();
  });
});
