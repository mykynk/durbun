import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeviceApp, DeviceInfo } from '@durbun/protocol';

const sent: unknown[] = [];
vi.mock('../data/commands', async (importOriginal) => {
  const real = await importOriginal<typeof import('../data/commands')>();
  return { ...real, sendCommand: vi.fn(async (cmd: unknown) => { sent.push(cmd); return null; }) };
});

import '../i18n';
import { setLanguage } from '../i18n/core';
import { hubActions } from '../data/stores/hub';
import { setScope } from '../data/stores/scope';
import { ExplainEmpty } from './components';
import { canLaunchApp } from './actions';

const PIXEL = 'android:R5CT20XK9QM';
const pixel = (p: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: PIXEL, platform: 'android', kind: 'physical', name: 'Pixel 8', connection: 'usb', state: 'online',
  logs: { status: 'streaming', via: 'logcat' }, actions: ['app-launch', 'app-stop', 'app-clear-data', 'screenshot'], firstSeen: 1, lastSeen: 2, ...p,
});
const kumbara = (p: Partial<DeviceApp> = {}): DeviceApp => ({
  key: `${PIXEL}|com.mykynk.kumbara`, deviceId: PIXEL, id: 'com.mykynk.kumbara', name: 'Kumbara', version: '3.1.0', build: '412',
  buildType: 'release', install: { source: 'play', installer: 'com.android.vending' }, pids: [], running: false, lastActivity: 1, ...p,
});

afterEach(() => {
  cleanup();
  act(() => setScope({ kind: 'all' }));
  sent.length = 0;
  setLanguage('en');
});

describe('launching a closed app from its empty state', () => {
  it('sends app-launch for the scoped app', async () => {
    setLanguage('tr');
    hubActions.replaceAll({ devices: [pixel()], apps: [], drivers: [], processes: [], deviceApps: [kumbara()] });
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' }));
    render(<ExplainEmpty capability="logs" fallback={<p>generic</p>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Uygulamayı başlat' }));
    await act(async () => {});
    expect(sent).toEqual([{ name: 'device.action', deviceId: PIXEL, action: 'app-launch', params: { appId: 'com.mykynk.kumbara' } }]);
  });

  it('only when the device is online and can start apps, and the app is not running', () => {
    const group = { deviceId: PIXEL, bundleId: 'com.mykynk.kumbara', running: false };
    hubActions.replaceAll({ devices: [pixel()], apps: [], drivers: [], processes: [] });
    expect(canLaunchApp(group)).toBe(true);
    expect(canLaunchApp({ ...group, running: true })).toBe(false);
    hubActions.replaceAll({ devices: [pixel({ actions: ['screenshot'] })], apps: [], drivers: [], processes: [] });
    expect(canLaunchApp(group)).toBe(false);
    hubActions.replaceAll({ devices: [pixel({ state: 'disconnected' })], apps: [], drivers: [], processes: [] });
    expect(canLaunchApp(group)).toBe(false);
  });
});
