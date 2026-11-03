import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, type DeviceApp, type DeviceInfo, type LogEntry } from '@durbun/protocol';
import '../../i18n';
import { setLanguage } from '../../i18n/core';
import { hubActions, logStore, setScope, usePrefs, useServerSettings } from '../../data';
import LogsView from './index';

const PIXEL = 'android:R5CT20XK9QM';
/** The server sent the setting itself (an older server streams every iPhone line). */
const REPORTED: ReadonlySet<string> = new Set(['iosDeviceLogScope']);
const IPHONE = 'ios:00008130-0001A2B3C4D5E6F7';

const device = (id: string, p: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id,
  platform: id.startsWith('ios') ? 'ios' : 'android',
  kind: 'physical',
  name: id.startsWith('ios') ? 'Yusuf iPhone’u' : 'Pixel 8',
  connection: 'usb',
  state: 'online',
  logs: { status: 'streaming', via: id.startsWith('ios') ? 'idevicesyslog' : 'logcat' },
  actions: ['app-launch'],
  firstSeen: 1,
  lastSeen: 2,
  ...p,
});

const kumbara = (p: Partial<DeviceApp> = {}): DeviceApp => ({
  key: `${PIXEL}|com.mykynk.kumbara`,
  deviceId: PIXEL,
  id: 'com.mykynk.kumbara',
  name: 'Kumbara',
  version: '3.1.0',
  build: '310',
  buildType: 'release',
  install: { source: 'play', installer: 'com.android.vending' },
  pids: [],
  running: false,
  lastActivity: Date.now() - 3 * 60_000,
  ...p,
});

function load(devices: DeviceInfo[], deviceApps: DeviceApp[] = []) {
  act(() => hubActions.replaceAll({ devices, apps: [], drivers: [], processes: [], deviceApps }));
}

let nextId = 1;
/** Today 22:20:02 (whole second, like idevicesyslog / dropbox times). */
const T0 = (() => {
  const x = new Date();
  x.setHours(22, 20, 2, 0);
  return x.getTime();
})();
const entry = (p: Partial<LogEntry>): LogEntry => ({ id: nextId++, ts: T0, deviceId: PIXEL, source: 'device', origin: 'logcat', level: 'info', tag: 't', message: 'm', ...p });
/** The separators every device sends when it connects (they belong to each of its app scopes). */
const connectSeparators = (deviceId: string, name: string): LogEntry[] => [
  entry({ deviceId, source: 'system', kind: 'lifecycle', code: 'device.connected', tag: 'durbun', message: `${name} connected`, params: { device: name, deviceId } }),
  entry({ deviceId, source: 'system', kind: 'lifecycle', code: 'logs.streamStarted', tag: 'durbun', message: 'Device log stream started', params: { via: 'logcat' } }),
];
const feed = (entries: LogEntry[]) => act(() => logStore.append(entries));

beforeEach(() => {
  // jsdom has no layout: give the virtualized list a viewport so it renders rows.
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000);
});

afterEach(() => {
  cleanup();
  act(() => {
    logStore.reset();
    setScope({ kind: 'all' });
    hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] });
    useServerSettings.setState({ settings: DEFAULT_SETTINGS, loaded: false, reported: undefined });
    usePrefs.setState({ hideNoise: false });
  });
  setLanguage('en');
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Logs empty state of an app that is not running', () => {
  it('says it is closed and offers to launch it, not “connect a device / add the SDK”', () => {
    setLanguage('tr');
    load([device(PIXEL)], [kumbara()]);
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }));
    render(<LogsView />);
    expect(screen.getByText(/Kumbara şu an açık değil/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Uygulamayı başlat' })).toBeTruthy();
    expect(screen.queryByText(/cihazı USB ile bağlayın/)).toBeNull();
  });

  it('says so above the list too, when the device’s own connect separators fill it', () => {
    setLanguage('tr');
    load([device(PIXEL)], [kumbara()]);
    feed(connectSeparators(PIXEL, 'Pixel 8'));
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }));
    render(<LogsView />);
    // Regression: the two separators made the list non-empty, so nothing said the app was closed.
    expect(document.querySelectorAll('.lg-sep').length).toBeGreaterThan(0);
    expect(screen.getByText(/Kumbara şu an açık değil/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Uygulamayı başlat' })).toBeTruthy();
  });

  it('a running app with no lines yet keeps the generic empty state', () => {
    setLanguage('tr');
    load([device(PIXEL)], [kumbara({ running: true, pids: [12873] })]);
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }));
    render(<LogsView />);
    expect(screen.queryByText(/şu an açık değil/)).toBeNull();
    expect(screen.getByText('Bu kapsamda henüz log yok')).toBeTruthy();
    expect(screen.getByText(/iPhone’da “Güven”e dokunmanız yeterli/)).toBeTruthy();
  });
});

describe('iPhone log scope note', () => {
  it('says once that iPhone system lines are left out and where to turn them on', () => {
    setLanguage('tr');
    load([device(IPHONE)]);
    act(() => useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, iosDeviceLogScope: 'apps' }, loaded: true, reported: REPORTED }));
    const view = render(<LogsView />);
    const note = () => document.querySelector('.lg-note');
    expect(note()?.textContent).toMatch(/Yusuf iPhone’u/);
    expect(note()?.textContent).toMatch(/Ayarlar › Loglar/);
    fireEvent.click(screen.getByRole('button', { name: 'Anladım' }));
    expect(note()).toBeNull();
    view.unmount();
    render(<LogsView />);
    expect(note()).toBeNull();
  });

  it('is not shown with “all”, before the settings arrive or without a physical iPhone', () => {
    setLanguage('tr');
    load([device(IPHONE)]);
    render(<LogsView />);
    const note = () => document.querySelector('.lg-note');
    expect(note()).toBeNull();
    act(() => useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, iosDeviceLogScope: 'all' }, loaded: true, reported: REPORTED }));
    expect(note()).toBeNull();
    act(() => useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, iosDeviceLogScope: 'apps' }, loaded: true, reported: REPORTED }));
    expect(note()).not.toBeNull();
    load([device(PIXEL)]);
    expect(note()).toBeNull();
  });
});

describe('rows of the list', () => {
  const IPHONE_DEV = () => device(IPHONE);
  const syslog = (p: Partial<LogEntry> = {}) => entry({ deviceId: IPHONE, origin: 'idevicesyslog', process: 'Runner', tag: 'Runner', message: 'Sepet açıldı', ...p });

  it('show whole-second sources without a made-up “.000”', () => {
    load([IPHONE_DEV()]);
    feed([syslog(), entry({ ts: T0 + 345, message: 'logcat line' })]);
    render(<LogsView />);
    const times = [...document.querySelectorAll('.lg-time')].map((n) => n.textContent);
    expect(times).toEqual(['22:20:02', '22:20:02.345']);
  });

  it('carry a device chip while two devices share “All devices”, none with one device', () => {
    load([device(PIXEL), IPHONE_DEV()]);
    feed([entry({ message: 'from the Pixel' }), syslog()]);
    const view = render(<LogsView />);
    expect([...document.querySelectorAll('.lg-dev')].map((n) => n.textContent)).toEqual(['Pixel 8', 'Yusuf iPhone’u']);
    view.unmount();
    act(() => logStore.reset());
    load([device(PIXEL)]);
    feed([entry({ message: 'from the Pixel' })]);
    render(<LogsView />);
    expect(document.querySelector('.lg-row')).not.toBeNull();
    expect(document.querySelector('.lg-dev')).toBeNull();
  });

  it('keep an iPhone daemon line that says why an app died visible under the “apps” scope; its chatter stays noise', () => {
    load([IPHONE_DEV()]);
    act(() => {
      useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, iosDeviceLogScope: 'apps' }, loaded: true, reported: REPORTED });
      usePrefs.setState({ hideNoise: true, noiseRules: [{ id: 'k', field: 'process', match: 'exact', value: 'kernel', enabled: true }] });
    });
    feed([
      syslog({ process: 'kernel', tag: 'kernel', message: 'memorystatus: killing_specific_process pid 811 [Runner] (per-process-limit)' }),
      syslog({ process: 'kernel', tag: 'kernel', message: 'AppleBCMWLANCore: rssi -61' }),
    ]);
    render(<LogsView />);
    expect(screen.getByText(/killing_specific_process/)).toBeTruthy();
    expect(screen.queryByText(/AppleBCMWLANCore/)).toBeNull();
  });
});
