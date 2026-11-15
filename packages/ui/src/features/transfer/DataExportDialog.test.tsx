import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSession, DeviceInfo, LogEntry, NetworkEntry } from '@durbun/protocol';
import '../../i18n';
import { setLanguage } from '../../i18n/core';
import { harExport } from '../../data/api';
import { hubActions, logStore, networkStore, setScope } from '../../data';
import { DataExportDialog } from './DataExportDialog';
import { harFileStamp, isMaskedSessionFile, scopeExportParams, sessionExportUrl } from './dataExport';

const PIXEL = 'android:R5CT20XK9QM';
const IPHONE = 'ios:00008130-0001A2B3C4D5E6F7';
const device = (id: string): DeviceInfo => ({
  id,
  platform: id.startsWith('ios') ? 'ios' : 'android',
  kind: 'physical',
  name: id.startsWith('ios') ? 'iPhone' : 'Pixel 8',
  connection: 'usb',
  state: 'online',
  logs: { status: 'streaming' },
  actions: [],
  firstSeen: 1,
  lastSeen: 2,
});
const session = (id: string, deviceId: string): AppSession => ({
  id,
  sessionKey: `s-${id}`,
  deviceId,
  sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter' },
  app: { name: 'Kumbara', id: 'com.mykynk.kumbara' },
  transport: 'adb-reverse',
  connected: true,
  connectedAt: 1,
  capabilities: ['logs', 'network'],
  actions: [],
  stats: { logs: 0, requests: 0, errors: 0 },
});
let n = 1;
const line = (deviceId: string, appId?: string): LogEntry => ({ id: n++, ts: 1, deviceId, appId, source: appId ? 'app' : 'device', level: 'info', tag: 't', message: 'm' });
const request = (id: string, deviceId: string, appId: string): NetworkEntry => ({
  id,
  appId,
  deviceId,
  source: 'dart:io',
  method: 'GET',
  url: `https://api.example.com/${id}`,
  host: 'api.example.com',
  path: `/${id}`,
  startTs: 1,
  state: 'complete',
  status: 200,
  requestHeaders: [],
  hasRequestBody: false,
  hasResponseBody: false,
});

let calls: { url: string; body?: unknown }[] = [];
let clicked: string[] = [];

beforeEach(() => {
  setLanguage('en');
  calls = [];
  clicked = [];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute('href') ?? '');
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{"log":{}}');
  });
  act(() => {
    hubActions.replaceAll({ devices: [device(PIXEL), device(IPHONE)], apps: [session('app:1', PIXEL), session('app:9', IPHONE)], drivers: [], processes: [], deviceApps: [] });
    logStore.append([line(PIXEL, 'app:1'), line(PIXEL, 'app:1'), line(IPHONE, 'app:9')]);
    networkStore.upsert([request('a', PIXEL, 'app:1'), request('b', IPHONE, 'app:9')]);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  act(() => {
    logStore.reset();
    networkStore.reset();
    setScope({ kind: 'all' });
    hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] });
  });
});

describe('export URLs and bodies (the masking contract)', () => {
  it('a session export is masked unless mask=0 is asked for', () => {
    expect(sessionExportUrl({ kind: 'all' }, true)).toBe('/api/export');
    expect(sessionExportUrl({ kind: 'all' }, false)).toBe('/api/export?mask=0');
    expect(sessionExportUrl({ kind: 'device', deviceId: PIXEL }, false)).toBe(`/api/export?deviceId=${encodeURIComponent(PIXEL)}&mask=0`);
  });

  it('an app scope exports what it shows: every session of the app on its device (device + bundle id); one session when exact', () => {
    const hub = { apps: { 'app:1': session('app:1', PIXEL) } };
    expect(scopeExportParams({ kind: 'app', appId: 'app:1' }, hub)).toEqual({ deviceId: PIXEL, bundleId: 'com.mykynk.kumbara' });
    expect(scopeExportParams({ kind: 'app', appId: 'app:1', exact: true }, hub)).toEqual({ deviceId: PIXEL, appId: 'app:1' });
  });

  it('a HAR body carries mask:false only when the raw file was chosen', async () => {
    await harExport(['a']);
    await harExport(['a'], { mask: false });
    expect(calls.map((c) => c.body)).toEqual([{ ids: ['a'] }, { ids: ['a'], mask: false }]);
    expect(harFileStamp(new Date('2026-11-15T10:20:30Z'))).toBe('durbun-2026-11-15-10-20-30.har');
  });

  it('tells a masked recording by its last member (or a top-level one before the lists)', async () => {
    const file = (text: string) => new Blob([text]);
    expect(await isMaskedSessionFile(file('{"format":"durbun-session","logs":[],"network":[],"masked":true}\n'))).toBe(true);
    expect(await isMaskedSessionFile(file('{"format":"durbun-session","masked":true,"devices":[]}'))).toBe(true);
    expect(await isMaskedSessionFile(file('{"format":"durbun-session","devices":[],"logs":[{"data":{"masked":true}}]}'))).toBe(false);
    expect(await isMaskedSessionFile(file('{"format":"durbun-session","logs":[]}'))).toBe(false);
  });
});

describe('export dialog', () => {
  it('says what goes in for the focused scope, masks by default and saves that scope', () => {
    act(() => setScope({ kind: 'device', deviceId: PIXEL }));
    render(<DataExportDialog open format="session" onClose={() => {}} />);
    expect(screen.getByText('2 log lines · 1 request')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Mask secret values' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'All devices' }));
    expect(screen.getByText('3 log lines · 2 requests · 2 devices')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Pixel 8/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save the file' }));
    expect(clicked).toEqual([`/api/export?deviceId=${encodeURIComponent(PIXEL)}`]);
  });

  it('a raw file is a deliberate choice that says what the file then holds', () => {
    render(<DataExportDialog open format="session" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mask secret values' }));
    expect(screen.getByText(/holds session tokens, cookies and passwords/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save unmasked' }));
    expect(clicked).toEqual(['/api/export?mask=0']);
  });

  it('a HAR of the focused scope sends that scope’s request ids, not every request', async () => {
    act(() => setScope({ kind: 'app', appId: 'app:9' }));
    render(<DataExportDialog open format="session" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'HAR (network only)' }));
    expect(screen.getByText('1 request')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save the file' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: '/api/har', body: { ids: ['b'] } });
  });

  it('fixed requests (the Network tab) are named and cannot change scope', async () => {
    render(<DataExportDialog open format="har" ids={['a']} label="GET https://api.example.com/a" fileName="x.har" onClose={() => {}} />);
    expect(screen.getByText('GET https://api.example.com/a')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'All devices' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mask secret values' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save unmasked' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ ids: ['a'], mask: false });
  });
});
