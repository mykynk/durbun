import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '@durbun/protocol';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  compileFilter,
  extensionOf,
  methodChipOf,
  parseQuery,
  sanitizeFilters,
  shortTypeLabel,
  statusClassesOf,
  typeCategoryOf,
  type NetFilters,
} from './filters';

let n = 0;
function entry(p: Partial<NetworkEntry>): NetworkEntry {
  const url = p.url ?? 'https://api.pati.app/v1/pets?page=2';
  const u = new URL(url);
  return {
    id: p.id ?? `app:1:${++n}`,
    appId: 'app:1',
    deviceId: 'demo:1',
    source: 'dart:io',
    method: 'GET',
    url,
    host: u.host,
    path: u.pathname + u.search,
    startTs: 1000,
    state: 'complete',
    status: 200,
    requestHeaders: [],
    hasRequestBody: false,
    hasResponseBody: true,
    responseContentType: 'application/json; charset=utf-8',
    duration: 120,
    ...p,
  };
}

const ctx = { slowMs: 1000 };
const run = (entries: NetworkEntry[], q: string, f: Partial<NetFilters> = {}, extra: Partial<typeof ctx & { bodyMatches: Set<string> }> = {}) => {
  const pred = compileFilter({ ...DEFAULT_FILTERS, ...f }, parseQuery(q), { ...ctx, ...extra });
  return entries.filter(pred).map((e) => e.id);
};

const ok = entry({ id: 'ok' });
const notFound = entry({ id: 'nf', status: 404, url: 'https://api.pati.app/v1/pets/999' });
const serverErr = entry({ id: 'se', status: 503, method: 'POST', url: 'https://api.pati.app/v1/orders' });
const failed = entry({ id: 'fail', state: 'failed', status: undefined, error: "SocketException: Failed host lookup: 'cdn.pati.app'", url: 'https://cdn.pati.app/img/1.png', responseContentType: undefined, duration: 15 });
const brokenStream = entry({ id: 'broken', state: 'failed', status: 200, error: 'Connection closed while receiving data' });
const pending = entry({ id: 'pend', state: 'pending', status: undefined, duration: undefined, responseContentType: undefined });
const slow = entry({ id: 'slow', duration: 2400, url: 'https://api.pati.app/v1/feed' });
const gql = entry({ id: 'gql', method: 'POST', url: 'https://gql.pati.app/graphql', graphql: { operationType: 'query', operationName: 'GetPet' } });
const mocked = entry({ id: 'mock', mocked: true, mockRuleId: 'r1' });
const image = entry({ id: 'img', url: 'https://cdn.pati.app/img/2.webp', responseContentType: 'image/webp', responseBodySize: 150_000 });
const all = [ok, notFound, serverErr, failed, brokenStream, pending, slow, gql, mocked, image];

describe('classification', () => {
  it('maps methods to chips', () => {
    expect(methodChipOf('get')).toBe('GET');
    expect(methodChipOf('OPTIONS')).toBe('OTHER');
  });
  it('gives failed-with-status entries both classes', () => {
    expect(statusClassesOf(brokenStream)).toEqual(['2xx', 'fail']);
    expect(statusClassesOf(pending)).toEqual([]);
    expect(statusClassesOf(notFound)).toEqual(['4xx']);
  });
  it('derives content categories from content type, GraphQL and extension', () => {
    expect(typeCategoryOf(gql)).toBe('graphql');
    expect(typeCategoryOf(image)).toBe('image');
    expect(typeCategoryOf(failed)).toBe('image'); // .png without a response
    expect(typeCategoryOf(entry({ responseContentType: 'font/woff2' }))).toBe('font');
    expect(typeCategoryOf(entry({ responseContentType: 'text/css' }))).toBe('script');
    expect(typeCategoryOf(entry({ responseContentType: 'video/mp4' }))).toBe('media');
    expect(typeCategoryOf(entry({ responseContentType: 'text/plain' }))).toBe('other');
  });
  it('short type labels', () => {
    expect(shortTypeLabel(ok)).toBe('json');
    expect(shortTypeLabel(image)).toBe('webp');
    expect(shortTypeLabel(gql)).toBe('graphql');
    expect(shortTypeLabel(entry({ responseContentType: 'multipart/form-data; boundary=x' }))).toBe('multipart');
    expect(shortTypeLabel(entry({ responseContentType: 'application/problem+json' }))).toBe('problem');
    expect(shortTypeLabel(failed)).toBe('png');
    expect(extensionOf('/a/b.min.js?x=1')).toBe('js');
  });
});

describe('chips and toggles', () => {
  it('filters by method, status class, type and host', () => {
    expect(run(all, '', { methods: ['POST'] })).toEqual(['se', 'gql']);
    expect(run(all, '', { statuses: ['4xx', '5xx'] })).toEqual(['nf', 'se']);
    expect(run(all, '', { statuses: ['fail'] })).toEqual(['fail', 'broken']);
    expect(run(all, '', { types: ['image'] })).toEqual(['fail', 'img']);
    expect(run(all, '', { host: 'cdn.pati.app' })).toEqual(['fail', 'img']);
  });
  it('errors only / slow / mocked toggles', () => {
    expect(run(all, '', { errorsOnly: true })).toEqual(['nf', 'se', 'fail', 'broken']);
    expect(run(all, '', { slowOnly: true })).toEqual(['slow']);
    expect(run(all, '', { slowOnly: true, slowMs: 100 })).toEqual(['ok', 'nf', 'se', 'broken', 'slow', 'gql', 'mock', 'img']);
    expect(run(all, '', { mockedOnly: true })).toEqual(['mock']);
  });
  it('counts active filters and sanitizes persisted values', () => {
    expect(activeFilterCount({ ...DEFAULT_FILTERS, methods: ['GET', 'POST'], errorsOnly: true })).toBe(3);
    expect(sanitizeFilters({ methods: ['GET', 'BOGUS'], statuses: '4xx', slowMs: -5, host: 3 })).toEqual({ ...DEFAULT_FILTERS, methods: ['GET'] });
  });
});

describe('query language', () => {
  it('free words match URL, method, status, GraphQL operation and errors', () => {
    expect(run(all, 'orders')).toEqual(['se']);
    expect(run(all, '404')).toEqual(['nf']);
    expect(run(all, 'getpet')).toEqual(['gql']);
    expect(run(all, 'host lookup')).toEqual(['fail']);
    expect(run(all, '"host lookup"')).toEqual(['fail']);
  });
  it('status tokens: classes, codes, comparisons, ranges, fail/pending', () => {
    expect(run(all, 'status:4xx')).toEqual(['nf']);
    expect(run(all, 'status:503')).toEqual(['se']);
    expect(run(all, 'status:>=400')).toEqual(['nf', 'se']);
    expect(run(all, 'status:400-599')).toEqual(['nf', 'se']);
    expect(run(all, 'status:fail')).toEqual(['fail', 'broken']);
    expect(run(all, 'status:pending')).toEqual(['pend']);
  });
  it('method, host, path, type, source, op, is', () => {
    expect(run(all, 'method:post')).toEqual(['se', 'gql']);
    expect(run(all, 'method:put,post')).toEqual(['se', 'gql']);
    expect(run(all, 'host:cdn')).toEqual(['fail', 'img']);
    expect(run(all, 'path:/v1/pets')).toEqual(['ok', 'nf', 'broken', 'pend', 'mock']);
    expect(run(all, 'type:image')).toEqual(['fail', 'img']);
    expect(run(all, 'type:webp')).toEqual(['img']);
    expect(run(all, 'op:getpet')).toEqual(['gql']);
    expect(run(all, 'is:mocked')).toEqual(['mock']);
    expect(run(all, 'is:pending')).toEqual(['pend']);
    expect(run(all, 'is:graphql')).toEqual(['gql']);
    expect(run(all, 'is:error')).toEqual(['nf', 'se', 'fail', 'broken']);
    expect(run(all, 'source:dart')).toHaveLength(all.length);
  });
  it('duration and size comparisons with units', () => {
    expect(run(all, 'dur:>1s')).toEqual(['slow']);
    expect(run(all, 'dur:<20ms')).toEqual(['fail']);
    expect(run(all, 'dur:2s-3s')).toEqual(['slow']);
    expect(run(all, 'size:>100kb')).toEqual(['img']);
  });
  it('negation, combination and Turkish aliases', () => {
    expect(run(all, '-host:api')).toEqual(['fail', 'gql', 'img']);
    expect(run(all, 'host:api -status:2xx -is:pending')).toEqual(['nf', 'se']);
    expect(run(all, 'durum:4xx')).toEqual(['nf']);
    expect(run(all, 'metot:post -graphql')).toEqual(['se']);
  });
  it('reports invalid tokens and ignores half-typed ones', () => {
    expect(parseQuery('status:abc dur:>fast is:weird').invalid).toEqual(['status:abc', 'dur:>fast', 'is:weird']);
    expect(parseQuery('status:').invalid).toEqual([]);
    expect(parseQuery('https://api.pati.app/v1').clauses).toEqual([{ key: null, value: 'https://api.pati.app/v1', negate: false }]);
  });
  it('uses server body-search matches for free words, still applying tokens locally', () => {
    const bodyMatches = new Set(['ok', 'se', 'gql']);
    expect(run(all, 'pamuk', {}, { bodyMatches })).toEqual(['ok', 'se', 'gql']);
    expect(run(all, 'pamuk method:post', {}, { bodyMatches })).toEqual(['se', 'gql']);
    expect(parseQuery('pamuk method:post -cdn').freeText).toBe('pamuk');
  });
});
