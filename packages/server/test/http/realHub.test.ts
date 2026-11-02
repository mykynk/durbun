/**
 * REST body endpoints over the REAL hub with the body shapes real SDKs send: size-only placeholders
 * (capture off / too large) and partial bodies of a broken stream.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@durbun/protocol';
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
