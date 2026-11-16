/**
 * Mock matching v2 in the JS / React Native SDK: rules limited to a GraphQL operation (`when.graphql`). The copy of
 * the reference must give the shared vectors' answers (packages/protocol/vectors/mock-graphql.json, also used by the
 * Kotlin, Swift and Dart ports); fetch and XHR read the body only when they already hold it; a body they cannot read
 * means "no match" and the request goes to the network.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WsClient from 'ws';
import * as P from '@durbun/protocol';
import { Durbun } from '../src/index.js';
import { MOCK_GRAPHQL_MAX_CHARS, findMockRuleForRequest, graphqlOperationsOf, heldBodyText, mockRuleMatches, mockRuleMatchesRequest, normalizeRules } from '../src/mocks.js';
import type { MockRule } from '../src/protocol.js';
import { FakeDesktop, waitFor, type FakeDesktopOptions } from './helpers/fakeDesktop.js';
import { startHttpServer, type TestServer } from './helpers/httpServer.js';
import { DomXHR, RnXHR } from './helpers/xhrPolyfill.js';

/* ────────────────────────────── shared vectors ────────────────────────────── */

interface VectorRequest {
  method: string;
  url: string;
  appId?: string;
  contentType?: string;
  body?: string;
  bodyPattern?: [string, number][];
}
const VECTORS = JSON.parse(readFileSync(new URL('../../../packages/protocol/vectors/mock-graphql.json', import.meta.url), 'utf8')) as {
  regenerate: string;
  maxChars: number;
  operations: { description: string; request: VectorRequest; expected: unknown }[];
  matches: { rule: P.MockRule; request: VectorRequest; expected: boolean; matchesNoBody: boolean }[];
  finds: { rules: P.MockRule[]; cases: { request: VectorRequest; expectedId: string | null }[] };
};

/** `bodyPattern` ([text, times] pairs) expanded into `body`, as every port does. */
function expand(r: VectorRequest): P.MockRequestInput {
  const { bodyPattern, ...rest } = r;
  return bodyPattern ? { ...rest, body: bodyPattern.map(([text, times]) => text.repeat(times)).join('') } : rest;
}

describe('mock matching v2: shared vectors', () => {
  it('cover enough of both outcomes', () => {
    expect(VECTORS.maxChars).toBe(MOCK_GRAPHQL_MAX_CHARS);
    expect(VECTORS.maxChars).toBe(P.MOCK_GRAPHQL_MAX_CHARS);
    expect(VECTORS.operations.length).toBeGreaterThan(40);
    expect(VECTORS.operations.filter((c) => c.expected === null).length).toBeGreaterThan(10);
    expect(VECTORS.matches.filter((c) => c.expected).length).toBeGreaterThan(8);
    expect(VECTORS.matches.filter((c) => !c.expected).length).toBeGreaterThan(8);
  });

  it('the vectors are current with the reference (else regenerate them)', () => {
    for (const c of VECTORS.operations) expect(P.graphqlOperationsOf(expand(c.request)), `${c.description} — stale, regenerate: ${VECTORS.regenerate}`).toEqual(c.expected);
    for (const c of VECTORS.matches) {
      expect(P.mockRuleMatchesRequest(c.rule, expand(c.request)), `stale, regenerate: ${VECTORS.regenerate}`).toBe(c.expected);
      expect(P.mockRuleMatches(c.rule, c.request.method, c.request.url, c.request.appId)).toBe(c.matchesNoBody);
    }
    for (const c of VECTORS.finds.cases) expect(P.findMockRuleForRequest(VECTORS.finds.rules, expand(c.request))?.id ?? null).toBe(c.expectedId);
  });

  it('the SDK copy gives every expected answer (rules as they arrive, through normalizeRules)', () => {
    for (const c of VECTORS.operations) expect(graphqlOperationsOf(expand(c.request)), c.description).toEqual(c.expected);
    for (const c of VECTORS.matches) {
      const why = JSON.stringify({ when: c.rule.when, method: c.rule.method, req: { ...c.request, body: c.request.body?.slice(0, 80) } });
      expect(mockRuleMatchesRequest(c.rule as MockRule, expand(c.request)), why).toBe(c.expected);
      expect(mockRuleMatches(c.rule as MockRule, c.request.method, c.request.url, c.request.appId), why).toBe(c.matchesNoBody);
      const [normalized] = normalizeRules([c.rule]);
      expect(!!normalized && mockRuleMatchesRequest(normalized, expand(c.request)), `normalized ${why}`).toBe(c.expected);
    }
    const rules = normalizeRules(VECTORS.finds.rules);
    expect(rules).toHaveLength(VECTORS.finds.rules.length);
    for (const c of VECTORS.finds.cases) expect(findMockRuleForRequest(rules, expand(c.request))?.id ?? null).toBe(c.expectedId);
  });

  it('normalizeRules keeps conditions as sent and drops a rule whose `when` is not an object', () => {
    const base = { id: 'a', enabled: true, method: 'POST', url: '/graphql', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 0 };
    const [kept] = normalizeRules([{ ...base, when: { graphql: { operationName: 'GetUser' }, future: { x: 1 } } }]);
    expect(kept?.when).toEqual({ graphql: { operationName: 'GetUser' }, future: { x: 1 } });
    // an unknown condition: the rule never matches here (an SDK must not widen it to every request at that URL)
    expect(mockRuleMatchesRequest(kept!, { method: 'POST', url: '/graphql', body: '{"operationName":"GetUser"}' })).toBe(false);
    expect(normalizeRules([{ ...base, when: 'graphql' }])).toEqual([]);
    expect(normalizeRules([{ ...base, when: null }])[0]).not.toHaveProperty('when');
  });

  it('the body is read at most once, and only when a rule with a condition matches the URL', () => {
    const rules = normalizeRules([
      { id: 'rest', enabled: true, method: '*', url: '/rest', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 0 },
      { id: 'a', enabled: true, method: '*', url: '/graphql', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 0, when: { graphql: { operationName: 'A' } } },
      { id: 'b', enabled: true, method: '*', url: '/graphql', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 0, when: { graphql: { operationName: 'B' } } },
    ]);
    let reads = 0;
    const req = (url: string) => ({
      method: 'POST',
      url,
      get body() {
        reads++;
        return '{"operationName":"B"}';
      },
    });
    expect(findMockRuleForRequest(rules, req('https://x/rest'))?.id).toBe('rest');
    expect(reads).toBe(0);
    expect(findMockRuleForRequest(rules, req('https://x/graphql'))?.id).toBe('b');
    expect(reads).toBe(1);
  });

  it('heldBodyText: strings and small bytes only', () => {
    expect(heldBodyText('{"a":1}')).toBe('{"a":1}');
    expect(heldBodyText(new TextEncoder().encode('{"ş":1}'))).toBe('{"ş":1}');
    expect(heldBodyText(new TextEncoder().encode('{}').buffer)).toBe('{}');
    expect(heldBodyText(new Uint8Array(3 * 64 * 1024 + 1))).toBeUndefined();
    expect(heldBodyText(new Blob(['{}']))).toBeUndefined();
    expect(heldBodyText(new URLSearchParams('a=1'))).toBeUndefined();
    expect(heldBodyText(undefined)).toBeUndefined();
  });
});

/* ────────────────────────────── the network patches ────────────────────────────── */

let server: TestServer;
let desktop: FakeDesktop | undefined;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = await startHttpServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  Durbun.stop();
  globalThis.fetch = realFetch;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  await desktop?.close();
  desktop = undefined;
  server.hits.length = 0;
});

const MOCKED = '{"data":{"me":{"id":"mocked"}}}';
const gqlRule = (id: string, operationName: string, operationType?: P.GraphqlOperationType): MockRule => ({
  id,
  enabled: true,
  method: 'POST',
  url: '/echo',
  match: 'contains',
  createdAt: 0,
  action: { type: 'respond', status: 200, headers: [['Content-Type', 'application/json']], body: MOCKED },
  when: { graphql: operationType ? { operationName, operationType } : { operationName } },
});
const op = (operationName: string, query = `query ${operationName} { me { id } }`) => JSON.stringify({ operationName, query, variables: {} });

async function start(desktopOpts: FakeDesktopOptions = {}) {
  desktop = await FakeDesktop.start(desktopOpts);
  Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: false, captureMetrics: false, captureErrors: false, WebSocket: WsClient });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

async function outcome(d: FakeDesktop, nth: number) {
  await waitFor(() => d.messages('net.request').length > nth, 5_000, `request ${nth}`);
  const req = d.messages('net.request')[nth]!;
  return d.waitForMessage((m) => (m.type === 'net.response' || m.type === 'net.error') && m.id === req.id, 5_000, `result ${nth}`);
}

describe('hello declares the matcher', () => {
  it('mockMatchers: ["graphql"] while network capture is on', async () => {
    const d = await start();
    const hello = d.messages('hello')[0] as P.SdkHello;
    expect(hello.sdk.mockMatchers).toEqual(['graphql']);
    expect(hello.capabilities).toContain('mocks');
  });
});

describe('fetch: GraphQL operation rules', () => {
  it('answers only the named operation; others at the same URL reach the server', async () => {
    const d = await start({ mocks: [gqlRule('get-user', 'GetUser', 'query')] });
    const headers = { 'Content-Type': 'application/json' };
    const user = await fetch(`${server.url}/echo`, { method: 'POST', headers, body: op('GetUser') });
    expect(await user.text()).toBe(MOCKED);
    const feed = await fetch(`${server.url}/echo`, { method: 'POST', headers, body: op('GetFeed') });
    expect(await feed.text()).toBe(op('GetFeed'));
    const mutation = await fetch(`${server.url}/echo`, { method: 'POST', headers, body: op('GetUser', 'mutation GetUser { touch }') });
    expect(mutation.status).toBe(201);
    // bytes the app already holds are read too
    const bytes = await fetch(`${server.url}/echo`, { method: 'POST', headers, body: new TextEncoder().encode(op('GetUser')) });
    expect(await bytes.text()).toBe(MOCKED);
    expect(server.hits.map((h) => JSON.parse(h.body.toString()).operationName)).toEqual(['GetFeed', 'GetUser']);
    expect(await outcome(d, 0)).toMatchObject({ type: 'net.response', mocked: true, mockRuleId: 'get-user' });
    expect((await outcome(d, 1)).mocked).toBeUndefined();
  });

  it('a body it cannot read without a stream (a Request object, a Blob) never matches: the request goes out', async () => {
    const d = await start({ mocks: [gqlRule('get-user', 'GetUser')] });
    const viaRequest = await fetch(new Request(`${server.url}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: op('GetUser') }));
    expect(viaRequest.status).toBe(201);
    const viaBlob = await fetch(`${server.url}/echo`, { method: 'POST', body: new Blob([op('GetUser')], { type: 'application/json' }) });
    expect(viaBlob.status).toBe(201);
    expect(server.hits).toHaveLength(2);
    expect((await outcome(d, 0)).mocked).toBeUndefined();
    // GET requests carry the operation in the URL
    await fetch(`${server.url}/echo?operationName=GetUser`).catch(() => undefined);
    expect(server.hits).toHaveLength(3); // method POST in the rule: a GET is not this rule's
  });

  it('a body over the size bound is "unknown": no match', async () => {
    await start({ mocks: [gqlRule('get-user', 'GetUser')] });
    const big = JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { a }', pad: 'x'.repeat(MOCK_GRAPHQL_MAX_CHARS) });
    const res = await fetch(`${server.url}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    expect(res.status).toBe(201);
    expect(server.hits).toHaveLength(1);
  });
});

describe.each([
  ['browser-like', DomXHR],
  ['react-native-like', RnXHR],
] as const)('XHR (%s): GraphQL operation rules', (_style, XHRClass) => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = XHRClass;
  });

  const send = (body: unknown, contentType = 'application/json'): Promise<{ status: number; text: string }> =>
    new Promise((resolve) => {
      const XHR = (globalThis as unknown as { XMLHttpRequest: new () => any }).XMLHttpRequest; // eslint-disable-line @typescript-eslint/no-explicit-any
      const xhr = new XHR();
      xhr.onloadend = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.open('POST', `${server.url}/echo`);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.send(body);
    });

  it('mocks the named operation only; batched bodies match when one element is it', async () => {
    const d = await start({ mocks: [gqlRule('get-user', 'GetUser')] });
    expect((await send(op('GetUser'))).text).toBe(MOCKED);
    expect((await send(op('GetFeed'))).status).toBe(201);
    const batch = JSON.stringify([JSON.parse(op('GetFeed')), JSON.parse(op('GetUser'))]);
    expect((await send(batch)).text).toBe(MOCKED);
    expect((await send('query GetUser { me { id } }', 'application/graphql')).text).toBe(MOCKED);
    expect(server.hits).toHaveLength(1);
    expect(await outcome(d, 0)).toMatchObject({ mocked: true, mockRuleId: 'get-user' });
  });

  it('no readable body (FormData-like object, none): the request goes to the network', async () => {
    await start({ mocks: [gqlRule('get-user', 'GetUser')] });
    expect((await send(null)).status).toBe(201);
    expect((await send(new Blob([op('GetUser')]))).status).toBe(201);
    expect(server.hits).toHaveLength(2);
  });
});

describe('Durbun.network.findMock', () => {
  it('matches a GraphQL rule when the caller passes the body; without it, only by URL parameters (GET)', async () => {
    await start({ mocks: [gqlRule('get-user', 'GetUser'), { ...gqlRule('any-get', 'GetUser'), method: 'GET' }] });
    await waitFor(() => !!Durbun.network.findMock('GET', `${server.url}/echo?operationName=GetUser`), 5_000, 'mocks');
    expect(Durbun.network.findMock('POST', `${server.url}/echo`, { body: op('GetUser'), contentType: 'application/json' })?.id).toBe('get-user');
    expect(Durbun.network.findMock('POST', `${server.url}/echo`, { body: op('GetFeed') })).toBeUndefined();
    expect(Durbun.network.findMock('POST', `${server.url}/echo`)).toBeUndefined();
    expect(Durbun.network.findMock('GET', `${server.url}/echo?operationName=GetUser`)?.id).toBe('any-get');
  });
});
