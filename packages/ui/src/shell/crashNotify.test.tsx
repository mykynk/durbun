import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { AppSession, DeviceInfo, LogEntry } from '@durbun/protocol';
import '../i18n';
import { setLanguage } from '../i18n/core';
import { hubActions, logStore, useConnection, usePrefs } from '../data';
import { watchLiveCrashes, useCrashNotifications } from './crashNotify';

const notifyDesktop = vi.fn((_title: string, _opts?: { body?: string; tag?: string; onClick?: () => void }) => true);
vi.mock('../lib/notify', () => ({ notifyDesktop: (title: string, opts?: { body?: string; tag?: string; onClick?: () => void }) => notifyDesktop(title, opts) }));

const PIXEL = 'android:R5CT20XK9QM';
const IPHONE = 'ios:00008130-0001A2B3C4D5E6F7';
let nextId = 1;
const line = (p: Partial<LogEntry> & { message: string }): LogEntry => ({ id: nextId++, ts: 1_700_000_000_000, deviceId: PIXEL, source: 'app', level: 'info', tag: 't', ...p });
const crash = (p: Partial<LogEntry> & { message: string }) => line({ level: 'fatal', kind: 'crash', ...p });
const device = (id: string, name: string): DeviceInfo => ({
  id,
  platform: id.startsWith('ios') ? 'ios' : 'android',
  kind: 'physical',
  name,
  connection: 'usb',
  state: 'online',
  logs: { status: 'streaming' },
  actions: [],
  firstSeen: 1,
  lastSeen: 2,
});
const kumbara: AppSession = {
  id: 'app:1',
  sessionKey: 's1',
  deviceId: PIXEL,
  sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter' },
  app: { name: 'Kumbara', id: 'com.mykynk.kumbara' },
  transport: 'adb-reverse',
  connected: true,
  connectedAt: 1,
  capabilities: ['logs'],
  actions: [],
  stats: { logs: 0, requests: 0, errors: 0 },
};

/** History first, then the connection turns live: only what arrives after counts as live. */
function goLive(history: LogEntry[]) {
  act(() => {
    useConnection.setState({ status: 'syncing' });
    logStore.append(history, { history: true });
    useConnection.setState({ status: 'live' });
  });
}

beforeEach(() => {
  setLanguage('en');
  notifyDesktop.mockClear();
  act(() => {
    logStore.reset();
    hubActions.replaceAll({ devices: [device(PIXEL, 'Pixel 8'), device(IPHONE, 'iPhone 15')], apps: [kumbara], drivers: [], processes: [], deviceApps: [] });
    usePrefs.getState().setPref('notifyOnCrash', true);
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    logStore.reset();
    useConnection.setState({ status: 'syncing' });
    hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] });
  });
});

describe('live crash watch for the desktop notification (any connected device)', () => {
  it('reports new live crashes on every device, not replayed history, imported recordings or quiet records', () => {
    goLive([crash({ message: 'Unhandled exception: replayed' })]);
    const seen: LogEntry[] = [];
    const stop = watchLiveCrashes(logStore, (e) => seen.push(e));
    const onPixel = crash({ message: 'Unhandled exception: pixel' });
    const onIphone = crash({ deviceId: IPHONE, message: 'Unhandled exception: iphone' });
    const imported = crash({ deviceId: 'import:abc', message: 'Unhandled exception: from a file' });
    const matched = crash({ source: 'device', message: 'FATAL EXCEPTION: main', data: { duplicateOf: 1 } });
    const info = line({ message: 'all good' });
    logStore.append([onPixel, info, onIphone, imported, matched]);
    logStore.flush();
    expect(seen.map((e) => e.message)).toEqual(['Unhandled exception: pixel', 'Unhandled exception: iphone']);
    // Nothing new: no second report.
    logStore.append([line({ message: 'later' })]);
    logStore.flush();
    expect(seen).toHaveLength(2);
    stop();
  });

  it('the app report and the device copy of one crash notify once', () => {
    goLive([]);
    const seen: LogEntry[] = [];
    const stop = watchLiveCrashes(logStore, (e) => seen.push(e));
    logStore.append([
      crash({ source: 'device', kind: 'flutter-error', level: 'error', message: '══╡ EXCEPTION ╞══\nA RenderFlex overflowed' }),
      crash({ source: 'app', kind: 'flutter-error', level: 'error', message: '══╡ EXCEPTION ╞══\nA RenderFlex overflowed' }),
    ]);
    logStore.flush();
    expect(seen).toHaveLength(1);
    stop();
  });
});

describe('useCrashNotifications (mounted in the shell)', () => {
  function Host() {
    useCrashNotifications();
    return null;
  }

  it('names the app and the device, whatever tab is open', async () => {
    goLive([]);
    render(<Host />);
    logStore.append([crash({ appId: 'app:1', message: 'Unhandled exception: Null check operator used on a null value' })]);
    logStore.flush();
    await waitFor(() => expect(notifyDesktop).toHaveBeenCalledTimes(1));
    const [title, opts] = notifyDesktop.mock.calls[0]!;
    expect(title).toContain('Kumbara');
    expect(opts?.body).toMatch(/^Pixel 8 · /);
    expect(opts?.tag).toBe('durbun-crash');
  });

  it('stays quiet when the setting is off, and a crash loop notifies once in the gap', async () => {
    goLive([]);
    render(<Host />);
    act(() => usePrefs.getState().setPref('notifyOnCrash', false));
    logStore.append([crash({ message: 'Unhandled exception: off' })]);
    logStore.flush();
    act(() => usePrefs.getState().setPref('notifyOnCrash', true));
    logStore.append([crash({ message: 'Unhandled exception: one' })]);
    logStore.flush();
    logStore.append([crash({ message: 'Unhandled exception: two' })]);
    logStore.flush();
    await waitFor(() => expect(notifyDesktop).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyDesktop).toHaveBeenCalledTimes(1);
  });
});
