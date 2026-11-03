import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AppSession, DeviceApp, DeviceInfo } from '@durbun/protocol';
import '../../i18n';
import { setLanguage } from '../../i18n/core';
import { hubActions, setScope, useMocks } from '../../data';
import MocksView from './index';

const PIXEL = 'android:R5CT20XK9QM';

const device: DeviceInfo = {
  id: PIXEL,
  platform: 'android',
  kind: 'physical',
  name: 'Pixel 8',
  connection: 'usb',
  state: 'online',
  logs: { status: 'streaming', via: 'logcat' },
  actions: ['app-launch'],
  firstSeen: 1,
  lastSeen: 2,
};

/** Kumbara from Play: no SDK inside, so mocks cannot apply to it. */
const kumbara: DeviceApp = {
  key: `${PIXEL}|com.mykynk.kumbara`,
  deviceId: PIXEL,
  id: 'com.mykynk.kumbara',
  name: 'Kumbara',
  version: '3.1.0',
  build: '310',
  buildType: 'release',
  install: { source: 'play', installer: 'com.android.vending' },
  pids: [12873],
  running: true,
  lastActivity: Date.now(),
};

const pati: AppSession = {
  id: 'app:2',
  sessionKey: 's2',
  deviceId: PIXEL,
  sdk: { name: 'durbun-flutter', version: '0.3.0', platform: 'flutter' },
  app: { name: 'Pati', id: 'com.mykynk.pati', version: '2.4.1', build: '241', pid: 15000, debug: true },
  transport: 'adb-reverse',
  connected: true,
  connectedAt: 10,
  capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'],
  actions: [],
  stats: { logs: 0, requests: 0, errors: 0 },
};

function load() {
  act(() => {
    hubActions.replaceAll({ devices: [device], apps: [pati], drivers: [], processes: [], deviceApps: [kumbara] });
    useMocks.setState({ rules: [], loaded: true });
  });
}

afterEach(() => {
  cleanup();
  act(() => {
    setScope({ kind: 'all' });
    useMocks.setState({ rules: [], loaded: false });
  });
  setLanguage('en');
  localStorage.clear();
});

describe('Mocks tab of an app without the SDK', () => {
  it('leads with why mocks do not work there; creating a rule stays possible but secondary', () => {
    setLanguage('tr');
    load();
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }));
    render(<MocksView />);
    expect(screen.getByText('Mock’lar Kumbara üzerinde çalışmaz')).toBeTruthy();
    expect(screen.getByText(/Kurallar, Dürbün SDK’sıyla bağlı uygulamalara uygulanır/)).toBeTruthy();
    const create = screen.getByRole('button', { name: 'İlk kuralı oluştur' });
    expect(create.className).not.toMatch(/btn--primary/);
    expect(screen.getByRole('button', { name: 'Yeni kural' }).className).not.toMatch(/btn--primary/);
    // The explanation is said once (no callout repeating the empty state).
    expect(screen.getAllByText('Mock’lar Kumbara üzerinde çalışmaz')).toHaveLength(1);
  });

  it('an SDK app keeps “create the first rule” as the main action', () => {
    setLanguage('tr');
    load();
    act(() => setScope({ kind: 'app', appId: 'app:2' }));
    render(<MocksView />);
    expect(screen.getByRole('button', { name: 'İlk kuralı oluştur' }).className).toMatch(/btn--primary/);
    expect(screen.queryByText(/Mock’lar .* üzerinde çalışmaz/)).toBeNull();
  });
});
