import { afterEach, describe, expect, it } from 'vitest';
import type { SdkNetRequest, SdkNetResponse, WireBody } from '@durbun/protocol';
import type { Hub } from '../../src/types';
import { appInput, device, makeHub, makeSettings } from './helpers';

let hub: Hub;
afterEach(() => hub?.dispose());

const utf8 = (text: string, extra: Partial<WireBody> = {}): WireBody => ({ encoding: 'utf8', data: text, size: Buffer.byteLength(text), ...extra });

function req(id: string, patch: Partial<SdkNetRequest> = {}): SdkNetRequest {
  return {
    type: 'net.request',
    id,
    ts: 10_000,
    method: 'GET',
    url: 'https://api.pati.app/v1/pets?page=2&limit=20',
    headers: [
      ['accept', 'application/json'],
      ['authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig'],
      ['user-agent', 'Dart/3.10 (dart:io)'],
    ],
    source: 'dart:io',
    ...patch,
  };
}

function res(id: string, patch: Partial<SdkNetResponse> = {}): SdkNetResponse {
  const body = utf8('{"data":[{"id":42,"name":"Pamuk","breed":"Van Kedisi"}],"meta":{"page":2,"total":163}}');
  return {
    type: 'net.response',
    id,
    ts: 10_184.5,
    status: 200,
    statusText: 'OK',
    headers: [
      ['content-type', 'application/json; charset=utf-8'],
      ['x-request-id', 'b7e3c1d2'],
    ],
    body,
    protocol: 'h2',
    timings: { dns: 12, connect: 25, tls: 40, send: 1, wait: 98, receive: 8.5 },
    ...patch,
  };
}

function setup(patch = {}) {
  hub = makeHub(patch);
  hub.upsertDevice(device('android:R5CT'));
  return hub.registerApp(appInput('android:R5CT'));
}

describe('network merge', () => {
  it('merges request + response into one entry with derived fields and a network log row', () => {
    const app = setup();
    hub.netRequest(app.id, req('1'));
    let entry = hub.getNetwork()[0]!;
    expect(entry).toMatchObject({
      id: `${app.id}:1`,
      appId: app.id,
      deviceId: 'android:R5CT',
      state: 'pending',
      method: 'GET',
      host: 'api.pati.app',
      path: '/v1/pets?page=2&limit=20',
      hasRequestBody: false,
      hasResponseBody: false,
      source: 'dart:io',
    });
    const row = hub.getLogs().find((l) => l.kind === 'network')!;
    expect(row).toMatchObject({
      tag: 'network',
      level: 'info',
      source: 'app',
      netId: `${app.id}:1`,
      message: 'GET https://api.pati.app/v1/pets?page=2&limit=20',
      appId: app.id,
      ts: 10_000,
    });
    hub.netResponse(app.id, res('1'));
    entry = hub.getNetwork()[0]!;
    expect(entry).toMatchObject({
      state: 'complete',
      status: 200,
      duration: 184.5,
      endTs: 10_184.5,
      responseContentType: 'application/json; charset=utf-8',
      hasResponseBody: true,
      protocol: 'h2',
    });
    expect(entry.responseBodySize).toBeGreaterThan(50);
    expect(hub.getNetworkDetail(entry.id)!.responseBody!.data).toContain('Pamuk');
    expect(hub.getApp(app.id)!.stats.requests).toBe(1);
  });

  it('handles a response that arrives before its request', () => {
    const app = setup();
    hub.netResponse(app.id, res('7', { ts: 20_500 }));
    expect(hub.getNetwork()[0]).toMatchObject({ method: '?', state: 'complete', status: 200, url: '' });
    expect(hub.getLogs().some((l) => l.kind === 'network')).toBe(false);
    hub.netRequest(app.id, req('7', { ts: 20_000, method: 'POST', body: utf8('{"email":"deniz@example.com"}'), headers: [['content-type', 'application/json']] }));
    const entry = hub.getNetwork()[0]!;
    expect(entry).toMatchObject({ method: 'POST', state: 'complete', duration: 500, requestContentType: 'application/json', hasRequestBody: true });
    expect(hub.getLogs().filter((l) => l.kind === 'network')).toHaveLength(1);
    expect(hub.getNetwork()).toHaveLength(1);
  });

  it('records failures, cancellations and mocked responses', () => {
    const app = setup();
    hub.netRequest(app.id, req('a'));
    hub.netError(app.id, { type: 'net.error', id: 'a', ts: 25_000, error: "SocketException: Failed host lookup: 'api.pati.app'" });
    hub.netRequest(app.id, req('b'));
    hub.netError(app.id, { type: 'net.error', id: 'b', ts: 10_050, error: 'DioException [request cancelled]', cancelled: true });
    hub.netRequest(app.id, req('c'));
    hub.netResponse(app.id, res('c', { status: 503, mocked: true, mockRuleId: 'rule-1', body: undefined, headers: [['content-length', '128']] }));
    const [a, b, c] = hub.getNetwork();
    expect(a).toMatchObject({ state: 'failed', error: "SocketException: Failed host lookup: 'api.pati.app'", duration: 15_000 });
    expect(b).toMatchObject({ state: 'cancelled' });
    expect(c).toMatchObject({ state: 'complete', status: 503, mocked: true, mockRuleId: 'rule-1', responseBodySize: 128, hasResponseBody: false });
  });

  it('fails pending requests on app disconnect, and a late response still completes them', () => {
    const app = setup();
    hub.netRequest(app.id, req('1', { ts: 1000 }));
    hub.netRequest(app.id, req('2', { ts: 1100 }));
    hub.netResponse(app.id, res('2', { ts: 1300 }));
    hub.pushAppLog(app.id, { ts: 4000, level: 'info', message: 'last thing before disconnect' });
    hub.markAppDisconnected(app.id);
    const failed = hub.getNetwork().find((e) => e.id === `${app.id}:1`)!;
    expect(failed).toMatchObject({ state: 'failed', error: 'App disconnected before the response arrived', endTs: 4000, duration: 3000 });
    expect(hub.getNetwork().find((e) => e.id === `${app.id}:2`)!.state).toBe('complete');
    const line = hub.getLogs().find((l) => l.code === 'app.disconnected')!;
    expect(line.params).toMatchObject({ failedRequests: 1 });
    // reconnect with the same session → same app id → late response upgrades the entry
    hub.registerApp(appInput('android:R5CT'));
    hub.netResponse(app.id, res('1', { ts: 6000 }));
    expect(hub.getNetwork().find((e) => e.id === `${app.id}:1`)).toMatchObject({ state: 'complete', status: 200, duration: 5000 });
    expect(hub.getNetwork().find((e) => e.id === `${app.id}:1`)!.error).toBeUndefined();
  });

  it('detects GraphQL operations on requests', () => {
    const app = setup();
    hub.netRequest(
      app.id,
      req('g', {
        method: 'POST',
        url: 'https://gql.pati.app/graphql',
        headers: [['content-type', 'application/json']],
        body: utf8(JSON.stringify({ operationName: 'LikeStory', query: 'mutation LikeStory($id: ID!) { likeStory(storyId: $id) { id } }', variables: { id: 's1' } })),
      }),
    );
    expect(hub.getNetwork()[0]!.graphql).toEqual({ operationType: 'mutation', operationName: 'LikeStory' });
  });

  it('ignores traffic of unknown apps', () => {
    setup();
    hub.netRequest('app:999', req('1'));
    hub.netResponse('app:999', res('1'));
    expect(hub.getNetwork()).toHaveLength(0);
  });
});

describe('network limits', () => {
  it('keeps at most maxNetworkEntries (oldest dropped with their bodies)', () => {
    const app = setup({ maxNetworkEntries: 3 });
    for (let i = 1; i <= 5; i++) {
      hub.netRequest(app.id, req(String(i), { method: 'POST', body: utf8(`{"n":${i}}`) }));
      hub.netResponse(app.id, res(String(i)));
    }
    expect(hub.getNetwork().map((e) => e.id)).toEqual([`${app.id}:3`, `${app.id}:4`, `${app.id}:5`]);
    expect(hub.getNetworkDetail(`${app.id}:1`)).toBeUndefined();
    hub.setSettings(makeSettings({ maxNetworkEntries: 1 }));
    expect(hub.getNetwork().map((e) => e.id)).toEqual([`${app.id}:5`]);
  });

  it('evicts the oldest bodies first when the body budget is exceeded', () => {
    const app = setup({ maxBodyStoreMB: 1 });
    const big = 'x'.repeat(400 * 1024);
    for (let i = 1; i <= 4; i++) {
      hub.netRequest(app.id, req(String(i)));
      hub.netResponse(app.id, res(String(i), { body: utf8(big) }));
    }
    const entries = hub.getNetwork();
    expect(entries.map((e) => !!e.bodyEvicted)).toEqual([true, true, false, false]);
    expect(hub.getNetworkDetail(`${app.id}:1`)!.responseBody).toBeUndefined();
    expect(hub.getNetworkDetail(`${app.id}:4`)!.responseBody!.data.length).toBe(400 * 1024);
    // entries keep their metadata
    expect(entries[0]).toMatchObject({ status: 200, hasResponseBody: true, responseBodySize: 400 * 1024 });
    // shrinking the budget evicts more
    hub.setSettings(makeSettings({ maxBodyStoreMB: 0 }));
    expect(hub.getNetwork().every((e) => e.bodyEvicted)).toBe(true);
  });
});

describe('network search', () => {
  it('searches URLs, headers and text bodies (case-insensitive by default)', () => {
    const app = setup();
    hub.netRequest(app.id, req('1', { url: 'https://api.pati.app/v1/pets/42' }));
    hub.netResponse(app.id, res('1', { body: utf8('{"name":"Fıstık","breed":"Golden Retriever"}') }));
    hub.netRequest(app.id, req('2', { url: 'https://cdn.pati.app/img/pets/42/thumb.png' }));
    hub.netResponse(app.id, res('2', { headers: [['content-type', 'image/png'], ['x-cache', 'HIT from cloudfront']], body: { encoding: 'base64', data: 'iVBORw0KGgoAAAANSUhEUg==', size: 16 } }));
    hub.netRequest(app.id, req('3', { method: 'POST', url: 'https://api.pati.app/v1/auth/login', headers: [['content-type', 'application/x-www-form-urlencoded']], body: { encoding: 'base64', data: Buffer.from('email=deniz%40example.com&remember=true').toString('base64'), size: 40 } }));
    const ids = (text: string, opts?: { ids?: string[]; caseSensitive?: boolean }) => hub.searchNetwork(text, opts).map((id) => id.split(':').pop());
    expect(ids('golden retriever')).toEqual(['1']);
    expect(ids('Golden', { caseSensitive: true })).toEqual(['1']);
    expect(ids('golden', { caseSensitive: true })).toEqual([]);
    expect(ids('fıstık')).toEqual(['1']);
    expect(ids('x-cache: hit')).toEqual(['2']);
    expect(ids('/pets/42')).toEqual(['1', '2']);
    expect(ids('remember=true')).toEqual(['3']); // base64 but text content type
    expect(ids('iVBOR')).toEqual([]); // binary bodies are not searched
    expect(ids('pets', { ids: [`${app.id}:2`, 'nope'] })).toEqual(['2']);
    expect(ids('')).toHaveLength(3);
    expect(ids('a.p')).toEqual([]); // the text is literal, not a pattern
    expect(ids('(42')).toEqual([]);
  });

  it('searches in slices: same result, the event loop runs in between, and an abort stops it', async () => {
    const app = setup();
    const body = utf8(`{"items":[${'"x",'.repeat(20_000)}"Needle"]}`);
    for (let i = 0; i < 1_000; i++) {
      hub.netRequest(app.id, req(String(i), { url: `https://api.pati.app/v1/feed?page=${i}` }));
      hub.netResponse(app.id, res(String(i), { body: i % 100 === 7 ? body : utf8('{"items":[]}') }));
    }
    const sync = hub.searchNetwork('needle');
    expect(sync).toHaveLength(10);
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 0);
    try {
      expect(await hub.searchNetworkAsync!('needle')).toEqual(sync);
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(0);

    const abort = new AbortController();
    const running = hub.searchNetworkAsync!('needle', { signal: abort.signal });
    abort.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('desktop requests', () => {
  it('records replays on the virtual desktop device without lifecycle lines', () => {
    hub = makeHub();
    const entry = hub.recordDesktopRequest({
      id: 'replay:1',
      deviceId: 'ignored',
      source: 'replay',
      method: 'GET',
      url: 'https://api.pati.app/v1/me',
      host: '',
      path: '',
      startTs: 1000,
      endTs: 1240,
      state: 'complete',
      status: 200,
      requestHeaders: [['accept', 'application/json']],
      responseHeaders: [['content-type', 'application/json']],
      hasRequestBody: false,
      hasResponseBody: true,
      responseBody: utf8('{"id":4821}'),
    });
    expect(entry).toMatchObject({ id: 'replay:1', deviceId: 'desktop', host: 'api.pati.app', path: '/v1/me', duration: 240, responseBodySize: 11 });
    expect(hub.getDevice('desktop')).toMatchObject({ kind: 'virtual', state: 'online', platform: 'other' });
    expect(hub.getLogs().filter((l) => l.source === 'system' && l.kind === 'lifecycle')).toHaveLength(0);
    expect(hub.getLogs().find((l) => l.kind === 'network')).toMatchObject({ netId: 'replay:1', deviceId: 'desktop' });
    const second = hub.recordDesktopRequest({ ...entry, id: 'replay:1' });
    expect(second.id).not.toBe('replay:1');
    expect(hub.getNetworkDetail('replay:1')!.responseBody!.data).toBe('{"id":4821}');
  });
});
