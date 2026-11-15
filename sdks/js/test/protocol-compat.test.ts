/**
 * The SDK ships its own copy of the protocol types/helpers (no runtime or .d.ts dependency on the private
 * @durbun/protocol package). This file fails the typecheck when a copied type drifts from the source of
 * truth, and fails at runtime when a copied helper behaves differently, when the protocol gains a wire type
 * or constant the copy lacks, when the shared mock vectors disagree with the matcher, or when a message the
 * SDK sends is changed by the desktop's validator.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as P from '@durbun/protocol';
import { parseSdkMessage } from '../../../packages/server/src/sdk/validate';
import { Durbun } from '../src/index.js';
import * as W from '../src/protocol.js';
import { findMockRule, mockRuleMatches, normalizeRules } from '../src/mocks.js';
import { SDK_VERSION } from '../src/version.js';
import { FakeDesktop, waitFor } from './helpers/fakeDesktop.js';
import { startHttpServer, type TestServer } from './helpers/httpServer.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type TypeChecks = [
  Assert<Equals<W.LogLevel, P.LogLevel>>,
  Assert<Equals<W.Header, P.Header>>,
  Assert<Equals<W.WireBody, P.WireBody>>,
  Assert<Equals<W.Timings, P.Timings>>,
  Assert<Equals<W.ErrorInfo, P.ErrorInfo>>,
  Assert<Equals<W.DevicePlatform, P.DevicePlatform>>,
  Assert<Equals<W.SdkPlatform, P.SdkPlatform>>,
  Assert<Equals<W.SdkCapability, P.SdkCapability>>,
  Assert<Equals<W.SdkLayer, P.SdkLayer>>,
  Assert<Equals<W.SdkIdentity, P.SdkIdentity>>,
  Assert<Equals<W.AppInfo, P.AppInfo>>,
  Assert<Equals<W.AppActionDescriptor, P.AppActionDescriptor>>,
  Assert<Equals<W.UrlMatchType, P.UrlMatchType>>,
  Assert<Equals<W.MockAction, P.MockAction>>,
  Assert<Equals<W.MockRule, P.MockRule>>,
  Assert<Equals<W.DeviceHints, P.DeviceHints>>,
  Assert<Equals<W.SdkHello, P.SdkHello>>,
  Assert<Equals<W.SdkLog, P.SdkLog>>,
  Assert<Equals<W.SdkNetRequest, P.SdkNetRequest>>,
  Assert<Equals<W.SdkNetResponse, P.SdkNetResponse>>,
  Assert<Equals<W.SdkNetError, P.SdkNetError>>,
  Assert<Equals<W.SdkEvent, P.SdkEvent>>,
  Assert<Equals<W.SdkMetric, P.SdkMetric>>,
  Assert<Equals<W.SdkCommandResult, P.SdkCommandResult>>,
  Assert<Equals<W.SdkActionsUpdate, P.SdkActionsUpdate>>,
  Assert<Equals<W.SdkPong, P.SdkPong>>,
  Assert<Equals<W.SdkToServer, P.SdkToServer>>,
  Assert<Equals<W.SdkConfig, P.SdkConfig>>,
  Assert<Equals<W.ServerWelcome, P.ServerWelcome>>,
  Assert<Equals<W.ServerToSdk, P.ServerToSdk>>,
  Assert<Equals<typeof W.PROTOCOL_VERSION, typeof P.PROTOCOL_VERSION>>,
  Assert<Equals<typeof W.LOG_LEVELS, typeof P.LOG_LEVELS>>,
  Assert<Equals<typeof W.isTextContentType, typeof P.isTextContentType>>,
];

function rule(partial: Partial<P.MockRule>): P.MockRule {
  return {
    id: 'r1',
    enabled: true,
    method: '*',
    url: '',
    match: 'contains',
    action: { type: 'respond', status: 200 },
    createdAt: 0,
    ...partial,
  };
}

const URLS = [
  'https://api.example.com/v1/users',
  'https://api.example.com/v1/users?page=2&q=ş',
  'https://API.Example.com/V1/Users/42',
  'http://localhost:8080/graphql',
  'https://cdn.example.com/img/logo.png',
  'https://api.example.com/v1/users.json',
  'https://api.example.com/v1/userss',
];

const RULES: P.MockRule[] = [
  rule({ url: '/v1/users', match: 'contains' }),
  rule({ url: '', match: 'contains' }),
  rule({ url: 'https://api.example.com/v1/users', match: 'exact' }),
  rule({ url: 'HTTPS://API.EXAMPLE.COM/V1/USERS', match: 'exact' }),
  rule({ url: 'https://api.example.com/v1/*', match: 'glob' }),
  rule({ url: '*/users/??', match: 'glob' }),
  rule({ url: '*.png', match: 'glob' }),
  rule({ url: '*users.json', match: 'glob' }),
  rule({ url: '*(v1)*', match: 'glob' }),
  rule({ url: '/users/\\d+$', match: 'regex' }),
  rule({ url: '/Users/\\d+$', match: 'regex' }),
  rule({ url: '([invalid', match: 'regex' }),
  rule({ url: 'graphql', match: 'contains', method: 'POST' }),
  rule({ url: 'graphql', match: 'contains', method: 'post' }),
  rule({ url: 'users', match: 'contains', enabled: false }),
  rule({ url: 'users', match: 'contains', apps: ['com.mykynk.pati'] }),
  rule({ url: 'users', match: 'contains', apps: [] }),
  rule({ url: 'users', match: 'unknown' as P.UrlMatchType }),
];

describe('protocol parity', () => {
  it('mockRuleMatches is identical to the reference for every rule × url × method × app', () => {
    let checked = 0;
    for (const r of RULES) {
      for (const url of URLS) {
        for (const method of ['GET', 'post', 'DELETE']) {
          for (const appId of [undefined, 'com.mykynk.pati', 'com.other.app']) {
            expect(mockRuleMatches(r as W.MockRule, method, url, appId), `${r.match}:${r.url} ${method} ${url} ${appId}`).toBe(
              P.mockRuleMatches(r, method, url, appId),
            );
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('findMockRule returns the first matching rule like the reference', () => {
    const rules = [rule({ id: 'a', url: 'nope' }), rule({ id: 'b', url: 'users', enabled: false }), rule({ id: 'c', url: 'users' }), rule({ id: 'd', url: 'users' })];
    expect(findMockRule(rules as W.MockRule[], 'GET', URLS[0])?.id).toBe(P.findMockRule(rules, 'GET', URLS[0])?.id);
    expect(findMockRule(rules as W.MockRule[], 'GET', URLS[0])?.id).toBe('c');
  });

  it('isTextContentType is identical to the reference', () => {
    const types = [
      undefined,
      '',
      'application/json',
      'application/json; charset=utf-8',
      'application/vnd.api+json',
      'text/plain',
      'TEXT/HTML',
      'application/xml',
      'application/javascript',
      'application/x-www-form-urlencoded',
      'application/graphql',
      'application/x-yaml',
      'text/csv',
      'image/png',
      'application/octet-stream',
      'multipart/form-data; boundary=x',
      'application/pdf',
    ];
    for (const t of types) expect(W.isTextContentType(t), String(t)).toBe(P.isTextContentType(t));
  });

  it('constants match', () => {
    expect(W.PROTOCOL_VERSION).toBe(P.PROTOCOL_VERSION);
    expect(W.DEFAULT_HTTP_PORT).toBe(P.DEFAULT_PORTS.http);
    expect(W.MAX_FRAME_BYTES).toBe(P.MAX_FRAME_BYTES);
    expect(W.LOG_LEVELS).toEqual(P.LOG_LEVELS);
    expect(W.DEFAULT_SDK_CONFIG.captureBodies).toBe(P.DEFAULT_SETTINGS.captureBodies);
    expect(W.DEFAULT_SDK_CONFIG.maxBodyBytes).toBe(P.DEFAULT_SETTINGS.maxBodyBytes);
    expect(W.DEFAULT_SDK_CONFIG.metricsIntervalMs).toBe(P.DEFAULT_SETTINGS.metricsIntervalMs);
  });

  it('SDK_VERSION equals package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

/* ────────────────────────────── coverage of the copy ────────────────────────────── */

const PROTOCOL_SOURCE = readFileSync(new URL('../../../packages/protocol/src/index.ts', import.meta.url), 'utf8');
const COPY_SOURCE = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8');
const THIS_FILE = readFileSync(new URL(import.meta.url), 'utf8');

/** Top-level `export interface` / `export type` declarations: name → code (comments stripped). */
function typeDeclarations(source: string): Map<string, string> {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out = new Map<string, string>();
  const re = /^export (?:interface|type) (\w+)/gm;
  const starts: Array<[string, number]> = [];
  for (let m = re.exec(code); m; m = re.exec(code)) starts.push([m[1], m.index]);
  const next = /^(?:export |const |function |\/\*)/gm;
  for (const [name, at] of starts) {
    next.lastIndex = at + 1;
    const end = next.exec(code);
    out.set(name, code.slice(at, end ? end.index : code.length));
  }
  return out;
}

/** The protocol's types reachable from the SDK messages (both directions). */
function sdkWireTypes(): string[] {
  const decls = typeDeclarations(PROTOCOL_SOURCE);
  const seen = new Set<string>();
  const queue = ['SdkToServer', 'ServerToSdk'];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name) || !decls.has(name)) continue;
    seen.add(name);
    const body = decls.get(name)!.replace(/^export (?:interface|type) \w+/, '');
    for (const id of body.match(/\b[A-Z]\w*\b/g) || []) if (decls.has(id) && !seen.has(id)) queue.push(id);
  }
  return [...seen].sort();
}

describe('the copy covers the protocol', () => {
  it('every protocol type an SDK message uses has a copy with a compile-time equality check', () => {
    const wire = sdkWireTypes();
    expect(wire).toContain('SdkLog');
    expect(wire).toContain('MockRule');
    const copied = typeDeclarations(COPY_SOURCE);
    for (const name of wire) {
      expect(copied.has(name), `${name} is used by SDK messages but missing from src/protocol.ts`).toBe(true);
      expect(THIS_FILE.includes(`Assert<Equals<W.${name}, P.${name}>>`), `${name} has no Equals check in TypeChecks`).toBe(true);
    }
  });

  it('every type of the copy has a compile-time equality check', () => {
    for (const name of typeDeclarations(COPY_SOURCE).keys()) {
      expect(THIS_FILE.includes(`Assert<Equals<W.${name}, P.${name}>>`), `${name} has no Equals check in TypeChecks`).toBe(true);
    }
  });

  it('every runtime export of the copy is compared below', () => {
    expect(Object.keys(W).sort()).toEqual(['DEFAULT_HTTP_PORT', 'DEFAULT_SDK_CONFIG', 'LOG_LEVELS', 'MAX_FRAME_BYTES', 'PROTOCOL_VERSION', 'isTextContentType']);
    // Every config field the desktop sends is defaulted, and from the desktop's own defaults where it has one.
    expect(Object.keys(W.DEFAULT_SDK_CONFIG).sort()).toEqual(['captureBodies', 'deviceLogsAvailable', 'maxBodyBytes', 'metricsIntervalMs']);
    expect(W.DEFAULT_SDK_CONFIG.deviceLogsAvailable).toBe(false);
    expect(W.DEFAULT_HTTP_PORT).toBe(P.DEFAULT_PORTS.http);
  });
});

/* ────────────────────────────── generated cases ────────────────────────────── */

/** Small deterministic PRNG (mulberry32), so a failure can be replayed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ['a', 'A', 'users', 'USERS', '/', '.', '*', '?', '+', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '\\d', '-', '=', '&', '%20', 'ş', 'İ', 'ı', 'ü', '🔭', ' ', '\n', 'api', 'v1', '42', 'json', 'https://', 'example.com'];

function randomText(rand: () => number, maxPieces: number): string {
  let s = '';
  const n = Math.floor(rand() * (maxPieces + 1));
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)];
  return s;
}

describe('generated mock-matching cases', () => {
  it('copy, copy after normalizeRules and reference agree on 20 000 random rule × url pairs', () => {
    const rand = prng(20261116);
    const matches: P.UrlMatchType[] = ['contains', 'exact', 'glob', 'regex'];
    const methods = ['*', 'GET', 'get', 'POST', 'Delete'];
    const apps = [undefined, [], ['com.mykynk.pati'], ['com.other.app', 'com.mykynk.pati']];
    let matched = 0;
    for (let i = 0; i < 20_000; i++) {
      const url = rand() < 0.5 ? 'https://api.example.com/v1/' + randomText(rand, 4) : randomText(rand, 8);
      const pattern = rand() < 0.3 ? url.slice(Math.floor(rand() * url.length)) : randomText(rand, 5);
      const r = rule({
        url: rand() < 0.2 ? pattern.toUpperCase() : pattern,
        match: matches[Math.floor(rand() * matches.length)],
        method: methods[Math.floor(rand() * methods.length)],
        apps: apps[Math.floor(rand() * apps.length)],
        enabled: rand() < 0.95,
      });
      const method = ['GET', 'post', 'DELETE'][Math.floor(rand() * 3)];
      const appId = [undefined, 'com.mykynk.pati', 'com.other.app'][Math.floor(rand() * 3)];
      const expected = P.mockRuleMatches(r, method, url, appId);
      const why = `${JSON.stringify(r)} ${method} ${JSON.stringify(url)} ${appId}`;
      expect(mockRuleMatches(r as W.MockRule, method, url, appId), why).toBe(expected);
      const [normalized] = normalizeRules([JSON.parse(JSON.stringify(r))]);
      expect(normalized && mockRuleMatches(normalized, method, url, appId), `normalized ${why}`).toBe(expected);
      if (expected) matched++;
    }
    // Enough of both outcomes to mean something.
    expect(matched).toBeGreaterThan(1_000);
    expect(matched).toBeLessThan(19_000);
  });

  it('isTextContentType agrees with the reference on generated content types', () => {
    const rand = prng(7);
    const parts = ['text/', 'application/', 'image/', 'json', 'xml', 'html', 'javascript', 'x-www-form-urlencoded', 'graphql', 'yaml', 'csv', 'octet-stream', 'vnd.api+', 'JSON', '; charset=utf-8', ' ', 'pdf', 'plain', 'svg+xml', 'X-YAML'];
    for (let i = 0; i < 5_000; i++) {
      let ct = '';
      const n = Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) ct += parts[Math.floor(rand() * parts.length)];
      expect(W.isTextContentType(ct), ct).toBe(P.isTextContentType(ct));
    }
  });
});

/* ────────────────────────────── vectors shared with the native SDKs ────────────────────────────── */

interface VectorCase {
  rule: P.MockRule;
  method: string;
  url: string;
  appId?: string;
  expected: boolean;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

/** The iOS fixture (indexed form) and the Android fixture, as flat cases. */
function sharedVectors(): Array<{ from: string; regenerate: string; cases: VectorCase[]; finds: Array<{ rules: P.MockRule[]; method: string; url: string; appId?: string; id: string | null }> }> {
  const ios = readJson('../../ios/Tests/DurbunTests/Fixtures/mock-vectors.json');
  const android = readJson('../../android/durbun/src/test/resources/mock-parity.json');
  return [
    {
      from: 'sdks/ios/Tests/DurbunTests/Fixtures/mock-vectors.json',
      regenerate: 'node sdks/ios/scripts/generate-mock-vectors.mjs',
      cases: ios.cases.map((c: any) => ({ rule: ios.rules[c.r], method: c.m, url: ios.urls[c.u], appId: c.a ?? undefined, expected: c.e })),
      finds: ios.finds.map((f: any) => ({ rules: ios.lists[f.l].map((i: number) => ios.rules[i]), method: f.m, url: ios.urls[f.u], appId: f.a ?? undefined, id: f.id ?? null })),
    },
    {
      from: 'sdks/android/durbun/src/test/resources/mock-parity.json',
      regenerate: 'node --import tsx sdks/android/tools/gen-mock-parity.mjs',
      cases: android.cases.map((c: any) => ({ rule: c.rule, method: c.method, url: c.url, appId: c.appId ?? undefined, expected: c.expected })),
      finds: android.find.cases.map((f: any) => ({ rules: android.find.rules, method: f.method, url: f.url, appId: f.appId ?? undefined, id: f.expectedId ?? null })),
    },
  ];
}

describe('mock vectors shared with the Android and iOS SDKs', () => {
  it('the JS matcher (after normalizeRules, as rules arrive) gives every expected result', () => {
    let checked = 0;
    for (const set of sharedVectors()) {
      expect(set.cases.length, set.from).toBeGreaterThan(20);
      for (const c of set.cases) {
        const [r] = normalizeRules([c.rule]);
        expect(!!r && mockRuleMatches(r, c.method, c.url, c.appId), `${set.from}: ${JSON.stringify(c)}`).toBe(c.expected);
        checked++;
      }
      for (const f of set.finds) {
        expect(findMockRule(normalizeRules(f.rules), f.method, f.url, f.appId)?.id ?? null, `${set.from}: ${JSON.stringify(f)}`).toBe(f.id);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('the vectors are current with the reference matcher', () => {
    for (const set of sharedVectors()) {
      for (const c of set.cases) {
        expect(P.mockRuleMatches(c.rule, c.method, c.url, c.appId), `${set.from} is stale, regenerate: ${set.regenerate}`).toBe(c.expected);
      }
      for (const f of set.finds) expect(P.findMockRule(f.rules, f.method, f.url, f.appId)?.id ?? null, `${set.from} is stale, regenerate: ${set.regenerate}`).toBe(f.id);
    }
  });
});

/* ────────────────────────────── messages the SDK sends, through the desktop's validator ────────────────────────────── */

describe("the desktop's validator keeps every message the SDK sends unchanged", () => {
  let desktop: FakeDesktop | undefined;
  let api: TestServer | undefined;
  afterEach(async () => {
    Durbun.stop();
    delete (globalThis as Record<string, unknown>).ErrorUtils;
    await desktop?.close();
    await api?.close();
    desktop = undefined;
    api = undefined;
  });

  it('hello, logs, crash, event, metric, network, command result and actions', async () => {
    let handler: ((e: unknown, fatal?: boolean) => void) | undefined;
    (globalThis as Record<string, unknown>).ErrorUtils = {
      setGlobalHandler: (h: typeof handler) => (handler = h),
      getGlobalHandler: () => handler,
    };
    api = await startHttpServer();
    desktop = await FakeDesktop.start({ config: { metricsIntervalMs: 250 }, mocks: [rule({ id: 'm1', url: '/mocked', action: { type: 'fail', error: 'timeout' } })] });
    Durbun.addAction({ id: 'qa.flag', label: 'Flag', kind: 'toggle', value: false }, () => 'done');
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, captureConsole: true, appVersion: '1.2.3', device: { name: '  Test phone ' } });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');
    Durbun.info('plain');
    Durbun.warn('with data', { tag: 'Auth', data: { user: { id: 1, roles: ['a'] }, when: new Date(0) }, error: new RangeError('bad') });
    console.log('[Net] console line', { n: 1 });
    Durbun.event('checkout', { total: 12.5, items: 3 });
    handler?.(new TypeError('boom'), false);
    await fetch(`${api.url}/json`, { headers: { 'X-Test': '1' } });
    await fetch(`${api.url}/echo`, { method: 'POST', body: 'ğüş', headers: { 'Content-Type': 'text/plain' } });
    await fetch(`${api.url}/binary`);
    await fetch(`${api.url}/mocked`).catch(() => undefined);
    desktop.broadcast({ type: 'command', id: 'c1', name: 'qa.flag', params: { value: true } });
    const result = await desktop.waitForMessage((m) => m.type === 'command.result' && m.id === 'c1');
    expect(result.ok).toBe(true);
    Durbun.addAction({ id: 'qa.second', label: 'Second' }, () => undefined);
    await waitFor(() => desktop!.messages('metric').length >= 1, 5_000, 'metric');
    await waitFor(() => desktop!.messages('actions').length >= 1, 5_000, 'actions');
    await waitFor(() => desktop!.messages('net.error').length >= 1, 5_000, 'mocked failure');

    const all = desktop.received.map((r) => r.msg);
    const types = new Set(all.map((m) => m.type));
    for (const t of ['hello', 'log', 'event', 'metric', 'net.request', 'net.response', 'net.error', 'command.result', 'actions']) expect(types, t).toContain(t);
    for (const msg of all) {
      const parsed = parseSdkMessage(msg);
      if (msg.type === 'hello') {
        // The validator trims names; everything else stays.
        expect(parsed).toEqual({ ...msg, device: { ...msg.device, name: 'Test phone' } });
      } else expect(parsed, JSON.stringify(msg).slice(0, 300)).toEqual(msg);
    }
  });
});
