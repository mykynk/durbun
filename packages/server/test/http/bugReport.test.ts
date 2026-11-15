/**
 * POST /api/bug-report over the REAL hub: the zip holds the UI's report and lines, a masked HAR of the given
 * requests, the screenshot from the temp dir and a recording of the window only.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SessionExport } from '@durbun/protocol';
import { readBugReportZip, parseBugReportRequest, sliceSessionExport } from '../../src/http/bugReport';
import { createHub } from '../../src/hub/index';
import type { Hub } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { createZip, crc32, readZip } from '../../src/util/zip';
import { startTestApp, type TestApp } from './fakes';

let t: TestApp | undefined;
let hub: Hub | undefined;
afterEach(async () => {
  await t?.close();
  hub?.dispose();
  t = hub = undefined;
});

const PHONE = 'android:BUG1';

async function start() {
  hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
  t = await startTestApp({ hub });
  hub.upsertDevice({ id: PHONE, platform: 'android', kind: 'physical', name: 'Pixel 8', connection: 'usb', state: 'online', logs: { status: 'streaming' }, actions: [], firstSeen: 1, lastSeen: 1 });
  const app = hub.registerApp({ sessionKey: 's1', deviceId: PHONE, sdk: { name: 'durbun', version: '0.3.0', platform: 'flutter' }, app: { id: 'com.example.shop', name: 'Shop', pid: 4242 }, transport: 'adb-reverse', connected: true, connectedAt: 1, capabilities: ['logs', 'network'], actions: [] });
  const T = 1_800_000_000_000;
  hub.pushAppLog(app.id, { ts: T - 120_000, level: 'info', tag: 'app', message: 'long before' });
  hub.pushAppLog(app.id, { ts: T - 10_000, level: 'error', tag: 'app', message: 'payment failed' });
  for (const [id, ts] of [['old', T - 120_000], ['pay', T - 5_000]] as const) {
    hub.netRequest(app.id, { type: 'net.request', id, ts, method: 'POST', url: `https://api.example.com/${id}?token=abc123`, headers: [['Authorization', 'Bearer secret-value']], source: 'dart:io' });
    hub.netResponse(app.id, { type: 'net.response', id, ts: ts + 10, status: 500, headers: [] });
  }
  return { app, T };
}

const post = (body: unknown) => fetch(`${t!.base}/api/bug-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('zip writer', () => {
  it('round-trips stored and deflated entries with their CRC', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const zip = createZip([
      { name: 'report.md', data: Buffer.from('# Rapor\n'.repeat(50)) },
      { name: 'screenshot.png', data: png, store: true },
      { name: 'crash/ünicode.ips', data: Buffer.from('x') },
    ]);
    const files = readZip(zip, (b) => inflateRawSync(b));
    expect(files.map((f) => f.name)).toEqual(['report.md', 'screenshot.png', 'crash/ünicode.ips']);
    expect(files[0]!.data.toString()).toBe('# Rapor\n'.repeat(50));
    expect(files[1]!.data.equals(png)).toBe(true);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(() => createZip([{ name: '../x', data: Buffer.alloc(0) }])).toThrow();
  });
});

describe('request validation', () => {
  it('needs a report; caps the window at 10 minutes, keeping its end', () => {
    expect(() => parseBugReportRequest({})).toThrow(/report/);
    expect(() => parseBugReportRequest({ report: 'x', mask: 'no' })).toThrow(/mask/);
    expect(() => parseBugReportRequest({ report: 'x', name: '../evil' })).toThrow(/name/);
    expect(parseBugReportRequest({ report: 'x', recording: { fromTs: 0, toTs: 3_600_000 } }).recording).toEqual({ fromTs: 3_000_000, toTs: 3_600_000 });
  });

  it('a slice keeps what is inside the window', () => {
    const data = { logs: [{ ts: 1 }, { ts: 5 }, { ts: 9 }], network: [{ startTs: 4 }, { startTs: 10 }], devices: [], apps: [] } as unknown as SessionExport;
    const s = sliceSessionExport(data, 4, 9);
    expect(s.logs.map((l) => l.ts)).toEqual([5, 9]);
    expect(s.network.map((n) => n.startTs)).toEqual([4]);
  });
});

describe('POST /api/bug-report (real hub)', () => {
  it('packs the report, lines, a masked HAR, the screenshot and the window’s recording', async () => {
    const { app, T } = await start();
    const shot = path.join(t!.config.tempDir, 'shot-1.png');
    await fsp.writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await post({
      report: '# Bug\n',
      logs: '14:03:12 E app payment failed\n',
      requestIds: [`${app.id}:pay`],
      screenshot: '/api/files/shot-1.png',
      recording: { deviceId: PHONE, bundleId: 'com.example.shop', fromTs: T - 30_000, toTs: T + 30_000 },
      name: 'shop-bug',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('shop-bug.zip');
    expect(res.headers.get('x-durbun-skipped')).toBeNull();
    const files = readBugReportZip(Buffer.from(await res.arrayBuffer()));
    expect(files.map((f) => f.name)).toEqual(['report.md', 'logs.txt', 'requests.har', 'screenshot.png', 'recording.durbun.json']);
    const har = JSON.parse(files[2]!.data.toString());
    expect(har.log.entries).toHaveLength(1);
    expect(har.log._durbun).toEqual({ masked: true });
    expect(files[2]!.data.toString()).not.toContain('secret-value');
    const rec = JSON.parse(files[4]!.data.toString()) as SessionExport;
    expect(rec.masked).toBe(true);
    expect(rec.logs.map((l) => l.message)).toContain('payment failed');
    expect(rec.logs.map((l) => l.message)).not.toContain('long before');
    expect(rec.network.map((n) => n.id)).toEqual([`${app.id}:pay`]);
  });

  it('raw on request; a screenshot that is gone is left out and named', async () => {
    const { app } = await start();
    const res = await post({ report: '# Bug', requestIds: [`${app.id}:pay`], screenshot: '/api/files/gone.png', crashReport: '/api/files/crash/ABC/x.ips', mask: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-durbun-skipped')).toBe('screenshot,crashReport');
    const files = readBugReportZip(Buffer.from(await res.arrayBuffer()));
    expect(files.map((f) => f.name)).toEqual(['report.md', 'requests.har']);
    expect(files[1]!.data.toString()).toContain('secret-value');
  });

  it('refuses a bad body with a code; a file outside the temp dir is never read', async () => {
    await start();
    const bad = await post({ report: '' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code?: string }).code).toBe('bugReport.invalid');
    const escape = await post({ report: 'x', screenshot: '/api/files/..%2F..%2Fetc%2Fpasswd' });
    expect(escape.headers.get('x-durbun-skipped')).toBe('screenshot');
  });

  it('GET /api/export takes a time window too', async () => {
    const { T } = await start();
    const res = await fetch(`${t!.base}/api/export?fromTs=${T - 30_000}&toTs=${T}`);
    const data = (await res.json()) as SessionExport;
    expect(data.logs.map((l) => l.message)).toContain('payment failed');
    expect(data.logs.map((l) => l.message)).not.toContain('long before');
    expect((await fetch(`${t!.base}/api/export?fromTs=abc`)).status).toBe(400);
  });
});
