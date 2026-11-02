import { describe, expect, it } from 'vitest';
import type { NetworkDetail } from '@durbun/protocol';
import { buildHar, harEntry, httpVersion, parseCookieHeader, parseSetCookie, timingsOf, type HarEntry } from '../../src/http/har';
import { sampleNetwork } from './fakes';

/** Required HAR 1.2 fields and types (per the spec) — a compact structural validator. */
function assertHar12Entry(e: HarEntry): void {
  expect(typeof e.startedDateTime).toBe('string');
  expect(Number.isNaN(Date.parse(e.startedDateTime))).toBe(false);
  expect(e.time).toBeGreaterThanOrEqual(0);
  for (const part of [e.request, e.response]) {
    expect(typeof part.httpVersion).toBe('string');
    expect(Array.isArray(part.cookies)).toBe(true);
    expect(Array.isArray(part.headers)).toBe(true);
    for (const h of part.headers) expect(Object.keys(h).sort()).toEqual(['name', 'value']);
    expect(typeof part.headersSize).toBe('number');
    expect(typeof part.bodySize).toBe('number');
  }
  expect(typeof e.request.method).toBe('string');
  expect(typeof e.request.url).toBe('string');
  expect(Array.isArray(e.request.queryString)).toBe(true);
  expect(typeof e.response.status).toBe('number');
  expect(typeof e.response.statusText).toBe('string');
  expect(typeof e.response.content.size).toBe('number');
  expect(typeof e.response.content.mimeType).toBe('string');
  expect(typeof e.response.redirectURL).toBe('string');
  expect(e.cache).toEqual({});
  for (const k of ['send', 'wait', 'receive'] as const) expect(e.timings[k]).toBeGreaterThanOrEqual(0);
  for (const k of ['blocked', 'dns', 'connect', 'ssl'] as const) expect(e.timings[k] === -1 || e.timings[k] >= 0).toBe(true);
  if (e.request.postData) {
    expect(typeof e.request.postData.mimeType).toBe('string');
    expect(typeof e.request.postData.text).toBe('string');
  }
}

const loginBody = JSON.stringify({ email: 'yusuf@example.com', password: '••••' });

const samples: NetworkDetail[] = [
  sampleNetwork(),
  sampleNetwork('app:1:9', {
    method: 'POST',
    url: 'https://api.pati.app/v1/auth/login',
    path: '/v1/auth/login',
    startTs: 1_762_070_000_200,
    status: 401,
    statusText: 'Unauthorized',
    requestHeaders: [['content-type', 'application/json']],
    requestContentType: 'application/json',
    requestBody: { encoding: 'utf8', data: loginBody, size: loginBody.length },
    requestBodySize: loginBody.length,
    hasRequestBody: true,
    responseBody: { encoding: 'utf8', data: '{"error":"invalid_credentials"}', size: 31 },
    responseBodySize: 31,
    protocol: 'http/1.1',
    timings: undefined,
    duration: 342.5,
    mocked: true,
    mockRuleId: 'mock-login-401',
  }),
  sampleNetwork('app:1:10', {
    method: 'POST',
    url: 'https://api.pati.app/oauth/token',
    startTs: 1_762_070_000_300,
    requestContentType: 'application/x-www-form-urlencoded',
    requestHeaders: [['Content-Type', 'application/x-www-form-urlencoded']],
    requestBody: { encoding: 'utf8', data: 'grant_type=refresh_token&refresh_token=abc%2B123', size: 49 },
    hasRequestBody: true,
  }),
  sampleNetwork('app:1:11', {
    url: 'https://cdn.pati.app/img/karabas.webp',
    startTs: 1_762_070_000_400,
    responseContentType: 'image/webp',
    responseHeaders: [['content-type', 'image/webp'], ['content-length', '48211']],
    responseBody: { encoding: 'base64', data: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', size: 48_211, truncated: true },
    responseBodySize: 48_211,
  }),
  sampleNetwork('app:1:12', {
    url: 'https://api.pati.app.invalid/v1/feed',
    startTs: 1_762_070_000_100,
    state: 'failed',
    status: undefined,
    statusText: undefined,
    responseHeaders: undefined,
    responseBody: undefined,
    responseBodySize: undefined,
    responseContentType: undefined,
    hasResponseBody: false,
    error: "SocketException: Failed host lookup: 'api.pati.app.invalid'",
    timings: undefined,
    duration: 2_004,
    remoteAddress: undefined,
  }),
  sampleNetwork('app:1:13', {
    url: 'https://api.pati.app/v1/upload',
    method: 'PUT',
    startTs: 1_762_070_000_600,
    state: 'pending',
    status: undefined,
    endTs: undefined,
    duration: undefined,
    responseHeaders: undefined,
    responseBody: undefined,
    hasResponseBody: false,
    timings: undefined,
  }),
];

describe('HAR export', () => {
  const har = buildHar(samples, { name: 'Dürbün', version: '0.1.0' });

  it('produces a HAR 1.2 log sorted by start time', () => {
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'Dürbün', version: '0.1.0' });
    expect(har.log.pages).toEqual([]);
    expect(har.log.entries.map((e) => e._durbun.id)).toEqual(['app:1:12', 'app:1:9', 'app:1:10', 'app:1:11', 'app:1:13', 'app:1:7']);
    for (const e of har.log.entries) assertHar12Entry(e);
    // Round-trips through JSON (no undefined/NaN surprises).
    expect(JSON.parse(JSON.stringify(har))).toEqual(har);
  });

  it('maps a complete JSON GET with cookies, query string, timings and server IP', () => {
    const e = harEntry(samples[0]!);
    expect(e.startedDateTime).toBe(new Date(1_762_070_001_000).toISOString());
    expect(e.request).toMatchObject({ method: 'GET', url: 'https://api.pati.app/v1/pets?page=1&limit=20', httpVersion: 'HTTP/2', bodySize: 0, headersSize: -1 });
    expect(e.request.queryString).toEqual([
      { name: 'page', value: '1' },
      { name: 'limit', value: '20' },
    ]);
    expect(e.request.cookies).toEqual([
      { name: 'session', value: 'abc123' },
      { name: 'theme', value: 'dark' },
    ]);
    expect(e.request.postData).toBeUndefined();
    expect(e.response.cookies).toEqual([
      { name: 'session', value: 'def456', path: '/', expires: '2026-10-21T07:28:00.000Z', httpOnly: true, secure: true },
      { name: 'ab', value: '1', path: '/' },
    ]);
    expect(e.response.content).toMatchObject({ mimeType: 'application/json; charset=utf-8', size: samples[0]!.responseBodySize });
    expect(e.response.content.text).toContain('Karabaş');
    expect(e.response.content.encoding).toBeUndefined();
    expect(e.timings).toEqual({ blocked: -1, dns: 4.2, connect: 18.5, ssl: 12.1, send: 0.4, wait: 88.3, receive: 11.6 });
    expect(e.time).toBe(123);
    expect(e.serverIPAddress).toBe('104.18.32.7');
  });

  it('embeds request bodies as postData (JSON text, form params) and marks mocks', () => {
    const login = harEntry(samples[1]!);
    expect(login.request.postData).toEqual({ mimeType: 'application/json', text: loginBody });
    expect(login.request.bodySize).toBe(loginBody.length);
    expect(login.request.httpVersion).toBe('HTTP/1.1');
    expect(login.comment).toBe('Mocked by Dürbün (rule mock-login-401)');
    expect(login._durbun).toMatchObject({ mocked: true, mockRuleId: 'mock-login-401' });
    // No phase timings: the whole duration is attributed to wait.
    expect(login.timings).toMatchObject({ send: 0, wait: 342.5, receive: 0, dns: -1 });
    expect(login.time).toBe(342.5);

    const form = harEntry(samples[2]!);
    expect(form.request.postData?.params).toEqual([
      { name: 'grant_type', value: 'refresh_token' },
      { name: 'refresh_token', value: 'abc+123' },
    ]);
  });

  it('keeps binary bodies as base64 and notes truncation', () => {
    const img = harEntry(samples[3]!);
    expect(img.response.content).toMatchObject({ mimeType: 'image/webp', encoding: 'base64', size: 48_211 });
    const captured = Buffer.from(samples[3]!.responseBody!.data, 'base64').length;
    expect(img.response.content.comment).toBe(`Truncated by Dürbün: captured ${captured} of 48211 bytes`);
    expect(img.response.bodySize).toBe(48_211);
  });

  it('exports failed and pending requests with status 0 and an _error', () => {
    const failed = harEntry(samples[4]!);
    expect(failed.response.status).toBe(0);
    expect(failed.response._error).toContain('Failed host lookup');
    expect(failed.response.content).toEqual({ size: 0, mimeType: 'x-unknown' });
    expect(failed.time).toBe(2_004);
    const pending = harEntry(samples[5]!);
    expect(pending.response.status).toBe(0);
    expect(pending.response._error).toMatch(/pending/);
    expect(pending.time).toBe(0);
  });

  it('encodes binary request bodies as base64 postData', () => {
    const upload = harEntry(
      sampleNetwork('app:1:14', {
        method: 'POST',
        requestContentType: 'image/jpeg',
        requestBody: { encoding: 'base64', data: '/9j/4AAQSkZJRg==', size: 11 },
        hasRequestBody: true,
      }),
    );
    expect(upload.request.postData).toEqual({ mimeType: 'image/jpeg', text: '/9j/4AAQSkZJRg==', encoding: 'base64' });
    const evicted = harEntry(sampleNetwork('app:1:15', { method: 'POST', hasRequestBody: true, requestBody: undefined, bodyEvicted: true, requestBodySize: 1_200 }));
    expect(evicted.request.postData).toMatchObject({ text: '', comment: 'Body was evicted from Dürbün memory' });
  });
});

describe('HAR helpers', () => {
  it('normalizes protocol names', () => {
    expect(httpVersion('h2')).toBe('HTTP/2');
    expect(httpVersion('h3-29')).toBe('HTTP/3');
    expect(httpVersion('http/1.1')).toBe('HTTP/1.1');
    expect(httpVersion(undefined)).toBe('HTTP/1.1');
  });

  it('parses cookies', () => {
    expect(parseCookieHeader('a=1; b=hello world; =x; c')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'hello world' },
    ]);
    expect(parseSetCookie('id=a3fWa; Max-Age=2592000; Domain=.pati.app; SameSite=Lax')).toEqual({ name: 'id', value: 'a3fWa', domain: '.pati.app' });
    expect(parseSetCookie('garbage')).toBeUndefined();
  });

  it('derives wait from the duration when only some phases are known', () => {
    const { timings, time } = timingsOf(sampleNetwork('x', { timings: { dns: 10, connect: 20 }, duration: 100 }));
    expect(timings).toMatchObject({ dns: 10, connect: 20, send: 0, wait: 70, receive: 0 });
    expect(time).toBe(100);
  });
});
