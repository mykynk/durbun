/**
 * REST body endpoints over the REAL hub with the body shapes real SDKs send: size-only placeholders
 * (capture off / too large) and partial bodies of a broken stream.
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SessionExport } from '@durbun/protocol';
import type { Har } from '../../src/http/har';
import { createHub } from '../../src/hub/index';
import type { Hub } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { startTestApp, type TestApp } from './fakes';

let t: TestApp | undefined;
let hub: Hub | undefined;
afterEach(async () => {
  await t?.close();
  hub?.dispose();
  t = undefined;
  hub = undefined;
});

async function start(): Promise<{ base: string; appId: string; hub: Hub }> {
  hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
  t = await startTestApp({ hub });
  hub.upsertDevice({
    id: 'net:other-mac16-7-yusufs-mac',
    platform: 'other',
    kind: 'physical',
    name: 'Yusufs-Mac',
    connection: 'local',
    state: 'online',
    logs: { status: 'unavailable', code: 'logs.networkOnly' },
    actions: [],
    firstSeen: 1,
    lastSeen: 1,
  });
  const app = hub.registerApp({
    sessionKey: 's1',
    deviceId: 'net:other-mac16-7-yusufs-mac',
    sdk: { name: 'durbun-flutter', version: '0.1.0', platform: 'flutter' },
    app: { id: 'dev.durbun.smoke', name: 'Dürbün Smoke', pid: 4242 },
    transport: 'tcp',
    connected: true,
    connectedAt: Date.now(),
    capabilities: ['logs', 'network'],
    actions: [],
  });
  return { base: t.base, appId: app.id, hub };
}

describe('body endpoints with real SDK body shapes', () => {
  it('size-only bodies: sizes in the entry, empty raw body flagged as truncated', async () => {
    const s = await start();
    s.hub.netRequest(s.appId, {
      type: 'net.request',
      id: '11',
      ts: 1,
      method: 'POST',
      url: 'http://127.0.0.1:61000/api/users',
      headers: [['content-type', 'application/json; charset=utf-8']],
      body: { encoding: 'utf8', data: '', size: 17, truncated: true },
      source: 'dart:io',
    });
    s.hub.netResponse(s.appId, {
      type: 'net.response',
      id: '11',
      ts: 5,
      status: 200,
      headers: [['content-type', 'application/json; charset=utf-8']],
      body: { encoding: 'utf8', data: '', size: 101, truncated: true },
    });
    const id = `${s.appId}:11`;
    const detail = await (await fetch(`${s.base}/api/network/${id}`)).json();
    expect(detail).toMatchObject({ requestBodySize: 17, responseBodySize: 101, responseBody: { data: '', size: 101, truncated: true } });
    const raw = await fetch(`${s.base}/api/network/${id}/body/response`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('x-durbun-truncated')).toBe('1');
    expect(raw.headers.get('x-durbun-body-size')).toBe('101');
    expect(raw.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await raw.text()).toBe('');
    const reqRaw = await fetch(`${s.base}/api/network/${id}/body/request`);
    expect(reqRaw.headers.get('x-durbun-body-size')).toBe('17');
  });

  it('a broken body stream: failed entry with status, partial body served as-is', async () => {
    const s = await start();
    s.hub.netRequest(s.appId, { type: 'net.request', id: '12', ts: 1, method: 'GET', url: 'http://127.0.0.1:61000/api/broken', headers: [], source: 'dart:io' });
    s.hub.netResponse(s.appId, {
      type: 'net.response',
      id: '12',
      ts: 60,
      status: 200,
      headers: [['content-type', 'application/json'], ['content-length', '5000']],
      body: { encoding: 'utf8', data: '{"items":[1,2,3', size: 15, truncated: true },
    });
    s.hub.netError(s.appId, { type: 'net.error', id: '12', ts: 61, error: 'HttpException: Connection closed while receiving data' });
    const id = `${s.appId}:12`;
    const detail = await (await fetch(`${s.base}/api/network/${id}`)).json();
    expect(detail).toMatchObject({ state: 'failed', status: 200, error: 'HttpException: Connection closed while receiving data' });
    const raw = await fetch(`${s.base}/api/network/${id}/body/response`);
    expect(raw.headers.get('x-durbun-truncated')).toBe('1');
    expect(await raw.text()).toBe('{"items":[1,2,3');
  });
});

describe('export → import and HAR over the real hub', () => {
  const PIXEL = 'android:R5CT1234';
  const BUNDLE = 'com.mykynk.kumbara';
  const crashFile = path.join(os.homedir(), '.durbun', 'tmp', 'crash', 'R5CT1234', 'Kumbara-2026-11-14.ips');

  async function seeded(): Promise<{ base: string; hub: Hub; netId: string }> {
    hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
    t = await startTestApp({ hub });
    hub.upsertDevice({
      id: PIXEL,
      platform: 'android',
      kind: 'physical',
      name: 'Pixel 7',
      connection: 'usb',
      state: 'online',
      logs: { status: 'streaming' },
      actions: [],
      firstSeen: 1,
      lastSeen: 1,
    });
    hub.upsertDeviceApp({ deviceId: PIXEL, id: BUNDLE, name: 'Kumbara', version: '3.1.0', buildType: 'release', install: { source: 'play', installer: 'com.android.vending' } });
    const app = hub.registerApp({
      sessionKey: 's1',
      deviceId: PIXEL,
      sdk: { name: 'durbun-flutter', version: '0.2.0', platform: 'flutter' },
      app: { id: BUNDLE, name: 'Kumbara', pid: 4242 },
      transport: 'tcp',
      connected: true,
      connectedAt: Date.now(),
      capabilities: ['logs', 'network'],
      actions: [],
    });
    hub.netRequest(app.id, {
      type: 'net.request',
      id: '1',
      ts: Date.now(),
      method: 'POST',
      url: 'https://api.example.com/login?lang=tr&access_token=abc123',
      headers: [
        ['Authorization', 'Bearer eyJhbGciOi.secret'],
        ['Cookie', 'sid=s3ss10n; theme=dark'],
        ['Content-Type', 'application/json'],
      ],
      body: { encoding: 'utf8', data: '{"email":"qa@example.com","password":"hunter2","pin":1234}', size: 58 },
      source: 'dart:io',
    });
    hub.netResponse(app.id, {
      type: 'net.response',
      id: '1',
      ts: Date.now(),
      status: 200,
      headers: [
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'sid=n3w; Path=/; HttpOnly'],
      ],
      body: { encoding: 'utf8', data: '{"token":"t0k3n","user":{"id":7}}', size: 33 },
    });
    hub.pushDeviceLogs(PIXEL, [
      {
        ts: Date.now(),
        level: 'fatal',
        tag: 'crash',
        message: 'Kumbara crashed',
        kind: 'crash',
        origin: 'crash-report',
        data: { origin: 'crash-report', bundleId: BUNDLE, file: crashFile, frames: [{ sourceFile: path.join(os.homedir(), 'dev', 'kumbara', 'lib', 'main.dart') }] },
      },
    ]);
    return { base: t.base, hub, netId: `${app.id}:1` };
  }

  it('masks the session export by default, keeps file names only, and imports it back with its device apps', async () => {
    const s = await seeded();
    const res = await fetch(`${s.base}/api/export`);
    expect(res.status).toBe(200);
    const file = (await res.json()) as SessionExport;
    expect(file.masked).toBe(true);
    const net = file.network.find((n) => n.url.startsWith('https://api.example.com/login'))!;
    expect(net.url).toBe('https://api.example.com/login?lang=tr&access_token=••••');
    expect(net.requestHeaders).toEqual([
      ['Authorization', 'Bearer ••••'],
      ['Cookie', 'sid=••••; theme=••••'],
      ['Content-Type', 'application/json'],
    ]);
    expect(net.requestBody?.data).toBe('{"email":"qa@example.com","password":"••••","pin":"••••"}');
    expect(net.responseBody?.data).toBe('{"token":"••••","user":{"id":7}}');
    expect(net.responseHeaders).toContainEqual(['Set-Cookie', 'sid=••••; Path=/; HttpOnly']);
    const netRow = file.logs.find((l) => l.kind === 'network')!;
    expect(netRow.message).toBe('POST https://api.example.com/login?lang=tr&access_token=••••');
    const crash = file.logs.find((l) => l.kind === 'crash')!;
    expect(crash.data).toMatchObject({ file: 'Kumbara-2026-11-14.ips', frames: [{ sourceFile: 'main.dart' }] });
    expect(JSON.stringify(file)).not.toContain(os.homedir());
    expect(file.deviceApps?.map((a) => a.id)).toEqual([BUNDLE]);

    // The masked file imports like any other; the device apps come along.
    const before = s.hub.getDevices().length;
    const imported = await fetch(`${s.base}/api/import?name=tester-bug.durbun.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file) });
    expect(imported.status).toBe(200);
    const { deviceIds } = (await imported.json()) as { deviceIds: string[] };
    expect(deviceIds).toHaveLength(1);
    expect(s.hub.getDevices()).toHaveLength(before + 1);
    expect(s.hub.getDeviceApps().find((a) => a.deviceId === deviceIds[0])).toMatchObject({
      id: BUNDLE,
      version: '3.1.0',
      buildType: 'release',
      install: { source: 'play', installer: 'com.android.vending' },
      running: false,
    });
  });

  it('mask=0 exports raw values (paths still cut) and an app-scoped export by bundle id keeps its device app', async () => {
    const s = await seeded();
    const raw = (await (await fetch(`${s.base}/api/export?mask=0`)).json()) as SessionExport;
    expect(raw.masked).toBeUndefined();
    const net = raw.network.find((n) => n.url.includes('/login'))!;
    expect(net.requestHeaders[0]).toEqual(['Authorization', 'Bearer eyJhbGciOi.secret']);
    expect(net.requestBody?.data).toContain('hunter2');
    expect(raw.logs.find((l) => l.kind === 'crash')!.data).toMatchObject({ file: 'Kumbara-2026-11-14.ips' });

    const scoped = (await (await fetch(`${s.base}/api/export?deviceId=${encodeURIComponent(PIXEL)}&bundleId=${BUNDLE}&mask=1`)).json()) as SessionExport;
    expect(scoped.masked).toBe(true);
    expect(scoped.deviceApps?.map((a) => a.id)).toEqual([BUNDLE]);
  });

  it('one version rule for session files: newer versions import, invalid ones are refused', async () => {
    const s = await seeded();
    const file = (await (await fetch(`${s.base}/api/export`)).json()) as SessionExport;
    const post = (body: unknown) => fetch(`${s.base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ ...file, version: 2, futureField: { x: 1 } })).status).toBe(200);
    for (const version of [0, '1', 1.5, undefined]) {
      const res = await post({ ...file, version });
      expect(res.status, String(version)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('import.version');
    }
    expect(((await (await post({ ...file, deviceApps: 'nope' })).json()) as { code: string }).code).toBe('import.invalid');
  });

  it('HAR: masked by default with log._durbun.masked, raw with mask: false', async () => {
    const s = await seeded();
    const har = async (body: unknown) => {
      const res = await fetch(`${s.base}/api/har`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(200);
      return (await res.json()) as Har;
    };
    const masked = await har({ ids: [s.netId] });
    expect(masked.log.version).toBe('1.2');
    expect(masked.log._durbun).toEqual({ masked: true });
    const e = masked.log.entries[0]!;
    expect(e.request.url).toBe('https://api.example.com/login?lang=tr&access_token=••••');
    expect(e.request.queryString).toContainEqual({ name: 'access_token', value: '••••' });
    expect(e.request.headers).toContainEqual({ name: 'Authorization', value: 'Bearer ••••' });
    expect(e.request.cookies).toEqual([
      { name: 'sid', value: '••••' },
      { name: 'theme', value: '••••' },
    ]);
    expect(e.request.postData?.text).toContain('"password":"••••"');
    expect(e.response.cookies[0]).toMatchObject({ name: 'sid', value: '••••', path: '/', httpOnly: true });
    expect(e.response.content.text).toBe('{"token":"••••","user":{"id":7}}');
    expect(JSON.stringify(masked)).not.toMatch(/hunter2|eyJhbGciOi|s3ss10n|abc123|t0k3n/);

    const raw = await har({ mask: false });
    expect(raw.log._durbun).toBeUndefined();
    expect(JSON.stringify(raw)).toContain('hunter2');
    const bad = await fetch(`${s.base}/api/har`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mask: 'no' }) });
    expect(bad.status).toBe(400);
  });
});
