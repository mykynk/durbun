import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSession, BugReportRequest, DeviceInfo, LogEntry, NetworkEntry } from '@durbun/protocol';

const sent: { name: string; action?: string }[] = [];
let shotReply: unknown = { url: '/api/files/shot-1.png', width: 1080, height: 2400 };
vi.mock('../../data/commands', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../data/commands')>();
  return {
    ...real,
    sendCommand: vi.fn(async (cmd: { name: string; action?: string }) => {
      sent.push(cmd);
      if (shotReply instanceof Error) throw shotReply;
      return shotReply;
    }),
  };
});

import '../../i18n';
import { setLanguage } from '../../i18n/core';
import { hubActions, logStore, networkStore, setScope } from '../../data';
import { toast } from '../../components';
import { BugReportDialog } from './BugReportDialog';
import { bugReport, useBugReport } from './store';

const PIXEL = 'android:R5CT20XK9QM';
const IPHONE = 'ios:00008130-0001A2B3C4D5E6F7';
const T = Date.now() - 60_000;
const device = (id: string, p: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id,
  platform: id.startsWith('ios') ? 'ios' : 'android',
  kind: 'physical',
  name: id.startsWith('ios') ? 'iPhone' : 'Pixel 8',
  osVersion: '15',
  connection: 'usb',
  state: 'online',
  logs: { status: 'streaming' },
  actions: ['screenshot'],
  firstSeen: 1,
  lastSeen: 2,
  ...p,
});
const shop: AppSession = {
  id: 'app:1',
  sessionKey: 's1',
  deviceId: PIXEL,
  sdk: { name: 'durbun', version: '0.3.0', platform: 'flutter' },
  app: { name: 'Shop', id: 'com.example.shop', version: '2.4.1', pid: 4211 },
  transport: 'adb-reverse',
  connected: true,
  connectedAt: 1,
  capabilities: ['logs', 'network'],
  actions: [],
  stats: { logs: 0, requests: 0, errors: 0 },
};
let n = 1;
const line = (ts: number, p: Partial<LogEntry> = {}): LogEntry => ({ id: n++, ts, deviceId: PIXEL, appId: shop.id, source: 'app', level: 'info', tag: 'app', message: `line ${n}`, ...p });
const request = (id: string, startTs: number, status: number): NetworkEntry => ({
  id,
  appId: shop.id,
  deviceId: PIXEL,
  source: 'dart:io',
  method: 'POST',
  url: `https://api.example.com/${id}?token=abc123`,
  host: 'api.example.com',
  path: `/${id}`,
  startTs,
  state: 'complete',
  status,
  duration: 120,
  requestHeaders: [],
  hasRequestBody: false,
  hasResponseBody: false,
});

let calls: { url: string; body?: unknown }[] = [];
let saved: string[] = [];
let skipped = '';

beforeEach(() => {
  setLanguage('en');
  calls = [];
  saved = [];
  sent.length = 0;
  skipped = '';
  shotReply = { url: '/api/files/shot-1.png', width: 1080, height: 2400 };
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.getAttribute('download') ?? '');
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/slack') return new Response('{"configured":false}');
    if (url === '/api/bug-report') {
      const body = JSON.parse(String(init?.body)) as BugReportRequest;
      return new Response(new Uint8Array([0x50, 0x4b]), { headers: { 'Content-Disposition': `attachment; filename="${body.name}.zip"`, ...(skipped ? { 'X-Durbun-Skipped': skipped } : {}) } });
    }
    return new Response('{}');
  });
  act(() => {
    hubActions.replaceAll({ devices: [device(PIXEL)], apps: [shop], drivers: [], processes: [], deviceApps: [] });
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
    useBugReport.setState({ open: null, draft: '' });
  });
});

const bugBody = () => calls.find((c) => c.url === '/api/bug-report')?.body as BugReportRequest | undefined;

describe('report a bug: from a log line', () => {
  it('shows what goes in with counts, masks by default, takes a screenshot and saves one zip', async () => {
    const crash = line(T, { level: 'error', message: 'payment failed' });
    act(() => {
      logStore.append([line(T - 120_000), line(T - 10_000), crash, line(T + 5000, { appId: 'app:other' })]);
      networkStore.upsert([request('pay', T - 2000, 500), request('ok', T - 1000, 200)]);
    });
    render(<BugReportDialog anchor={{ kind: 'log', logId: crash.id, openedAt: Date.now() }} onClose={() => {}} />);

    expect(screen.getByText('2 log lines')).toBeTruthy();
    expect(screen.getByText('1 failed request')).toBeTruthy();
    expect(screen.getByText(/2 requests in the window in all/)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Mask secret values' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Slack gets the report text only/)).toBeTruthy();
    // The note field has the focus: the user starts typing what happened.
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/What did you do/));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Screenshot taken for the report' })).toBeTruthy());
    expect(sent).toEqual([expect.objectContaining({ name: 'device.action', action: 'screenshot', deviceId: PIXEL })]);
    expect(screen.getByText(/A screenshot is not masked/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/What did you do/), { target: { value: 'Tapped Pay, nothing happened' } });
    fireEvent.click(screen.getByRole('button', { name: /Save \.zip/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const body = bugBody()!;
    expect(body.requestIds).toEqual(['pay']);
    expect(body.screenshot).toBe('/api/files/shot-1.png');
    expect(body.recording).toEqual({ deviceId: PIXEL, bundleId: 'com.example.shop', fromTs: T - 30_000, toTs: T + 30_000 });
    expect(body.mask).toBeUndefined();
    expect(body.report).toContain('> Tapped Pay, nothing happened');
    expect(body.report).toContain('token=••••');
    expect(body.report).not.toContain('abc123');
    expect(body.report).toContain('- screenshot.png: screenshot');
    expect(body.logs).toContain('payment failed');
    expect(saved[0]).toMatch(/^durbun-bug-shop-2-4-1-pixel-8-\d{8}-\d{6}\.zip$/);
    // Saved: the next report starts with an empty note.
    expect(useBugReport.getState().draft).toBe('');
  });

  it('a raw report is a deliberate choice that says what the file then holds', async () => {
    const e = line(T);
    act(() => {
      logStore.append([e]);
      networkStore.upsert([request('pay', T - 2000, 500)]);
    });
    render(<BugReportDialog anchor={{ kind: 'log', logId: e.id, openedAt: Date.now() }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mask secret values' }));
    expect(screen.getByText(/holds session tokens, cookies and passwords/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save unmasked/ }));
    await waitFor(() => expect(bugBody()).toBeDefined());
    expect(bugBody()!.mask).toBe(false);
    expect(bugBody()!.report).toContain('abc123');
  });

  it('parts can be left out; the window can change', async () => {
    const e = line(T);
    act(() => {
      logStore.append([line(T - 50_000), e]);
      networkStore.upsert([request('pay', T - 2000, 500)]);
    });
    render(<BugReportDialog anchor={{ kind: 'log', logId: e.id, openedAt: Date.now() }} onClose={() => {}} />);
    expect(screen.getByText('1 log line')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Before' }), { target: { value: '60' } });
    expect(screen.getByText('2 log lines')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '1 failed request' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Screenshot/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Dürbün recording/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save \.zip/ }));
    await waitFor(() => expect(bugBody()).toBeDefined());
    const body = bugBody()!;
    expect(body.requestIds).toBeUndefined();
    expect(body.screenshot).toBeUndefined();
    expect(body.recording).toBeUndefined();
    expect(body.report).not.toContain('failed request');
  });

  it('a part the server could not add is named after saving', async () => {
    skipped = 'screenshot';
    const warn = vi.spyOn(toast, 'warn');
    const e = line(T);
    act(() => logStore.append([e]));
    render(<BugReportDialog anchor={{ kind: 'log', logId: e.id, openedAt: Date.now() }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Save \.zip/ }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith('Bug report saved', { description: expect.stringMatching(/^Left out: the screenshot\. Secret values are masked\.$/) }));
  });
});

describe('report a bug: states', () => {
  it('no device: the note and the Dürbün version only, no screenshot', () => {
    act(() => hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] }));
    render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    expect(screen.getByText(/No device is connected/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /log line/ })).toBeNull();
    expect(screen.getByText('Pick one device for a screenshot.')).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('nothing in the window says so; "now" starts with no time after the moment', () => {
    render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    expect(screen.getByText(/No log lines or requests in this window/)).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'After' }) as HTMLSelectElement).value).toBe('0');
  });

  it('several devices: the user picks one or keeps all; all devices take no screenshot', () => {
    act(() => hubActions.replaceAll({ devices: [device(PIXEL), device(IPHONE)], apps: [shop], drivers: [], processes: [], deviceApps: [] }));
    render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    const pick = screen.getByRole('combobox', { name: 'Report about' }) as HTMLSelectElement;
    expect(pick.value).toBe('*');
    expect(screen.getByText('Pick one device for a screenshot.')).toBeTruthy();
    fireEvent.change(pick, { target: { value: IPHONE } });
    expect(sent).toEqual([expect.objectContaining({ deviceId: IPHONE })]);
  });

  it('a device that cannot take screenshots, a failing screenshot, an imported recording', async () => {
    act(() => hubActions.replaceAll({ devices: [device(PIXEL, { actions: [] })], apps: [shop], drivers: [], processes: [], deviceApps: [] }));
    const { unmount } = render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    expect(screen.getByText('This device cannot take screenshots.')).toBeTruthy();
    unmount();

    act(() => hubActions.replaceAll({ devices: [device(PIXEL)], apps: [shop], drivers: [], processes: [], deviceApps: [] }));
    shotReply = Object.assign(new Error('The device refused the screenshot'), { code: 'action.failed' });
    const second = render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Could not take a screenshot/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    second.unmount();

    const IMPORTED = 'import:pixel-1';
    act(() => hubActions.replaceAll({ devices: [device(IMPORTED)], apps: [], drivers: [], processes: [], deviceApps: [] }));
    render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    expect(screen.getByText(/An imported recording: logs and requests come from the file/)).toBeTruthy();
    expect(screen.getByText('An imported recording cannot give a screenshot.')).toBeTruthy();
  });

  it('a line no longer in memory falls back to the time the report was opened', () => {
    render(<BugReportDialog anchor={{ kind: 'log', logId: 999_999, openedAt: Date.now() }} onClose={() => {}} />);
    expect(screen.getByText(/no longer in memory/)).toBeTruthy();
  });

  it('the note survives a close (Connect Slack, Esc) until the report leaves', () => {
    const { unmount } = render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/What did you do/), { target: { value: 'half a sentence' } });
    // Slack is not set up: the button offers to connect instead of sending.
    expect(screen.getByRole('button', { name: /Connect Slack/ })).toBeTruthy();
    unmount();
    act(() => bugReport.open());
    render(<BugReportDialog anchor={{ kind: 'now', openedAt: Date.now() }} onClose={() => {}} />);
    expect((screen.getByPlaceholderText(/What did you do/) as HTMLTextAreaElement).value).toBe('half a sentence');
  });
});
