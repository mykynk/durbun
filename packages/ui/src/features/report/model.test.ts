import { describe, expect, it } from 'vitest';
import type { AppSession, DeviceApp, DeviceInfo, LogEntry, NetworkEntry } from '@durbun/protocol';
import { BUG_REPORT_MAX_LOG_LINES } from '@durbun/protocol';
import { messageKeys } from '../../i18n/core';
import { compileScope } from '../../data/scope';
import { bugReportLabels } from './i18n';
import { bugFileName, bugScope, bugWindow, buildBugReport, collectLogs, collectRequests, logsText, windowCrashReport, type BugReportInput } from './model';

const PHONE = 'android:R5CT20XK9QM';
const T = Date.UTC(2026, 10, 15, 11, 3, 12, 345);
const device: DeviceInfo = { id: PHONE, platform: 'android', kind: 'physical', name: 'Pixel 8', model: 'Pixel 8', osVersion: '15', connection: 'usb', state: 'online', logs: { status: 'streaming' }, actions: ['screenshot'], firstSeen: 1, lastSeen: 2 };
const shop: AppSession = {
  id: 'app:1',
  sessionKey: 's1',
  deviceId: PHONE,
  sdk: { name: 'durbun', version: '0.3.0', platform: 'flutter' },
  app: { name: 'Shop', id: 'com.example.shop', version: '2.4.1', build: '812', pid: 4211 },
  transport: 'adb-reverse',
  connected: true,
  connectedAt: 1,
  capabilities: ['logs', 'network'],
  actions: [],
  stats: { logs: 0, requests: 0, errors: 0 },
};
const legacy: DeviceApp = { deviceId: PHONE, id: 'com.example.legacy', name: 'Legacy', install: { source: 'play' }, pids: [7100], running: true } as DeviceApp;
const hub = { apps: { [shop.id]: shop }, devices: { [PHONE]: device }, deviceApps: { [`${PHONE}|${legacy.id}`]: legacy }, processes: {} };

let id = 1;
const line = (ts: number, p: Partial<LogEntry> = {}): LogEntry => ({ id: id++, ts, deviceId: PHONE, appId: shop.id, source: 'app', level: 'info', tag: 'app', message: `line ${ts}`, ...p });
const req = (rid: string, startTs: number, p: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: rid,
  appId: shop.id,
  deviceId: PHONE,
  source: 'dart:io',
  method: 'POST',
  url: `https://api.example.com/${rid}?token=abc123`,
  host: 'api.example.com',
  path: `/${rid}`,
  startTs,
  state: 'complete',
  status: 200,
  requestHeaders: [],
  hasRequestBody: false,
  hasResponseBody: false,
  ...p,
});

describe('window', () => {
  it('spans the moment; a window over 10 minutes keeps its end (the moment) and says it was cut', () => {
    expect(bugWindow(T, 30, 30)).toEqual({ fromTs: T - 30_000, toTs: T + 30_000, cut: false });
    expect(bugWindow(T, 600, 60)).toEqual({ fromTs: T + 60_000 - 600_000, toTs: T + 60_000, cut: true });
    expect(bugWindow(T, 600, 0).cut).toBe(false);
  });
});

describe('scope of a report', () => {
  it('a line or request names its app; an SDK-less line the app the device reports; else the device; "now" keeps the view', () => {
    expect(bugScope({ entry: line(T) }, { kind: 'all' }, hub)).toEqual({ kind: 'app', appId: shop.id });
    expect(bugScope({ entry: line(T, { appId: undefined, source: 'device', process: 'com.example.legacy', pid: 7100 }) }, { kind: 'all' }, hub)).toEqual({ kind: 'deviceApp', deviceId: PHONE, bundleId: legacy.id });
    expect(bugScope({ entry: line(T, { appId: undefined, source: 'device', process: 'system_server', pid: 1 }) }, { kind: 'all' }, hub)).toEqual({ kind: 'device', deviceId: PHONE });
    expect(bugScope({ request: req('a', T) }, { kind: 'all' }, hub)).toEqual({ kind: 'app', appId: shop.id });
    expect(bugScope({ request: req('d', T, { appId: undefined as unknown as string, deviceId: 'desktop' }) }, { kind: 'device', deviceId: PHONE }, hub)).toEqual({ kind: 'device', deviceId: PHONE });
    expect(bugScope({}, { kind: 'all' }, hub)).toEqual({ kind: 'all' });
  });
});

describe('what goes in', () => {
  const compiled = compileScope({ kind: 'app', appId: shop.id }, hub);
  const win = bugWindow(T, 30, 30);

  it('log lines of the scope in the window, without request rows, markers and (when hidden) noise', () => {
    const entries = [
      line(T - 31_000),
      line(T - 10_000),
      line(T, { level: 'error', message: 'payment failed' }),
      line(T + 1, { kind: 'network', netId: 'x', message: '→ POST https://api.example.com/x' }),
      line(T + 2, { appId: 'app:other' }),
      line(T + 3, { appId: undefined, source: 'device', tag: 'chatty', process: 'com.example.shop', pid: 4211, message: 'noise' }),
      line(T + 31_000),
    ];
    const all = collectLogs({ entries }, compiled, win);
    expect(all.lines.map((e) => e.message)).toEqual([`line ${T - 10_000}`, 'payment failed', 'noise']);
    const quiet = collectLogs({ entries }, compiled, win, (e) => e.tag === 'chatty');
    expect(quiet.total).toBe(2);
  });

  it('keeps the newest lines of a very large window and counts them all', () => {
    const entries = Array.from({ length: BUG_REPORT_MAX_LOG_LINES + 20 }, (_, i) => line(T - 20_000 + i));
    const r = collectLogs({ entries }, compiled, win);
    expect(r.total).toBe(BUG_REPORT_MAX_LOG_LINES + 20);
    expect(r.lines).toHaveLength(BUG_REPORT_MAX_LOG_LINES);
    expect(r.lines[r.lines.length - 1]).toBe(entries[entries.length - 1]);
  });

  it('crash records the memory limit moved aside still count, in id order', () => {
    const kept = [line(T - 5000, { kind: 'crash', message: 'kept crash' })];
    const entries = [line(T - 1000)];
    // A kept record is older than the ring by id.
    kept[0]!.id = 0;
    expect(collectLogs({ entries, kept }, compiled, win).lines.map((e) => e.message)).toEqual(['kept crash', `line ${T - 1000}`]);
  });

  it('failed requests (failure, 4xx, 5xx) that started in the window, and every request of it', () => {
    const list = [req('ok', T - 5000), req('pay', T - 2000, { status: 500 }), req('net', T - 1000, { state: 'failed', status: undefined, error: 'SocketException' }), req('old', T - 60_000, { status: 404 })];
    const r = collectRequests(list, compiled, win);
    expect(r.failed.map((n) => n.id)).toEqual(['pay', 'net']);
    expect(r.all.map((n) => n.id)).toEqual(['ok', 'pay', 'net']);
  });

  it('the crash report of the window’s newest crash record', () => {
    const lines = [line(T, { data: { reportUrl: '/api/files/crash/A/old.ips' } }), line(T + 1), line(T + 2, { data: { reportUrl: '/api/files/crash/A/new.ips' } })];
    const of = (e: LogEntry) => ((e.data as { reportUrl?: string } | undefined)?.reportUrl ? { url: (e.data as { reportUrl: string }).reportUrl } : undefined);
    expect(windowCrashReport(lines, of)).toEqual({ url: '/api/files/crash/A/new.ips' });
  });
});

describe('the report text', () => {
  const lines = [line(T - 1000, { level: 'error', tag: 'pay', message: 'payment failed' }), line(T, { kind: 'network', message: '→ GET https://api.example.com/me?token=abc123' })];
  const input = (p: Partial<BugReportInput> = {}): BugReportInput => ({
    note: 'Tapped Pay twice.\nNothing happened.',
    moment: T,
    window: bugWindow(T, 30, 30),
    device: 'Pixel 8 · Android 15',
    app: 'Shop 2.4.1 (812) · com.example.shop · Play',
    sdk: 'durbun 0.3.0 · flutter',
    durbun: '0.3.0',
    requests: [req('pay', T - 2000, { status: 500, duration: 120 })],
    logs: { lines, total: lines.length, text: (e) => e.message },
    mask: true,
    ...p,
  });

  it('title, quoted note, environment, failed requests and the last lines; secrets in URLs masked', () => {
    const md = buildBugReport(input(), bugReportLabels('en'));
    expect(md).toMatch(/^# Bug report: Shop 2\.4\.1 \(812\) · Pixel 8\n/);
    expect(md).toContain('> Tapped Pay twice.\n> Nothing happened.');
    expect(md).toContain('- App: Shop 2.4.1 (812) · com.example.shop · Play');
    expect(md).toContain('- SDK: durbun 0.3.0 · flutter');
    expect(md).toContain('## 1 failed request');
    expect(md).toMatch(/POST https:\/\/api\.example\.com\/pay\?token=•••• → 500 · 120 ms/);
    expect(md).toContain('## Log lines (2)');
    expect(md).toContain('E/pay: payment failed');
    expect(md).not.toContain('abc123');
    expect(md.trimEnd().endsWith('_Secret values are masked._')).toBe(true);
    expect(md).not.toContain('## Attachments');
  });

  it('raw on request; the zip version lists its attachments; the cut window is said', () => {
    const md = buildBugReport(input({ mask: false, window: bugWindow(T, 600, 60), attachments: { screenshot: 'screenshot.png', crash: 'Runner-2026.ips', recording: true } }), bugReportLabels('en'), { forZip: true });
    expect(md).toContain('abc123');
    expect(md).toContain('(cut to 10 minutes)');
    expect(md).toContain('- logs.txt: 2 lines');
    expect(md).toContain('- requests.har: 1 requests (HAR)');
    expect(md).toContain('- screenshot.png: screenshot');
    expect(md).toContain('- crash/Runner-2026.ips: iOS crash report');
    expect(md).toContain('- recording.durbun.json:');
    expect(md.trimEnd().endsWith('_Unmasked: secret values as they are._')).toBe(true);
  });

  it('an empty window says so; parts left out are not mentioned; Turkish words when the UI is Turkish', () => {
    const md = buildBugReport(input({ note: '', requests: [], logs: { lines: [], total: 0, text: (e) => e.message } }), bugReportLabels('tr'));
    expect(md).toContain('Aralıkta başarısız istek yok.');
    expect(md).toContain('Aralıkta log satırı yok.');
    expect(md).not.toContain('Not:');
    const bare = buildBugReport(input({ requests: undefined, logs: undefined, device: undefined, app: undefined, sdk: undefined }), bugReportLabels('en'));
    expect(bare).not.toContain('failed request');
    expect(bare).not.toContain('Log lines');
    expect(bare).toMatch(/^# Bug report\n/);
  });

  it('logs.txt: logcat-like lines with secret-looking values masked', () => {
    const text = logsText([line(T, { message: 'token=abc123 in a message' }), lines[1]!], (e) => e.message, true, ['Shop']);
    expect(text.startsWith('# Shop\n\n')).toBe(true);
    expect(text).toContain('token=•••• in a message');
    expect(logsText([line(T, { message: 'token=abc123' })], (e) => e.message, false)).toContain('token=abc123');
    expect(text).toContain('https://api.example.com/me?token=••••');
  });

  it('file name: a readable slug and the time', () => {
    expect(bugFileName('Kumbara Çocuk ı Pixel 8', new Date(2026, 10, 15, 14, 3, 12).getTime())).toBe('durbun-bug-kumbara-cocuk-i-pixel-8-20261115-140312');
    expect(bugFileName(undefined, new Date(2026, 10, 15, 14, 3, 12).getTime())).toBe('durbun-bug-20261115-140312');
  });
});

describe('report dictionary', () => {
  it('Turkish and English define the same keys', () => {
    const tr = new Set(messageKeys('tr').filter((k) => k.startsWith('report.')));
    const en = new Set(messageKeys('en').filter((k) => k.startsWith('report.')));
    expect(tr.size).toBeGreaterThan(60);
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
  });
});
