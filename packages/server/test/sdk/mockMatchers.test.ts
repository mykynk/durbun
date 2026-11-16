/**
 * Mock matching v2: a rule with a condition (`when.graphql`) reaches only SDK sessions that declared that matcher in
 * `hello.sdk.mockMatchers`. An SDK that does not know the condition would ignore it and answer every request to the
 * rule's URL, so the server never sends it such a rule: not in `welcome`, not in later `mocks` messages.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MockRule, ServerToSdk, SessionExport } from '@durbun/protocol';
import { validateMockRule, validateMockRules } from '../../src/config';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import { parseHello } from '../../src/sdk/validate';
import type { Hub, SdkLayer, VirtualSdkSession } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { appInput, device, hello, makeHub, makeSettings, waitFor } from '../hub/helpers';

let hub: Hub | undefined;
let sdk: SdkLayer | undefined;

afterEach(async () => {
  await sdk?.close();
  hub?.dispose();
  sdk = undefined;
  hub = undefined;
});

const respond = { type: 'respond', status: 200 } as const;
const plain: MockRule = { id: 'plain', enabled: true, method: '*', url: '/v1/pets', match: 'contains', action: respond, createdAt: 1 };
const getUser: MockRule = {
  id: 'gql-user',
  enabled: true,
  method: 'POST',
  url: '/graphql',
  match: 'contains',
  action: respond,
  createdAt: 2,
  when: { graphql: { operationName: 'GetUser', operationType: 'query' } },
};
const getFeed: MockRule = { ...getUser, id: 'gql-feed', when: { graphql: { operationName: 'GetFeed' } } };

const rawHello = (sdkPatch: Record<string, unknown>, session = 'launch-1') =>
  ({ ...hello({ session }), sdk: { name: 'durbun-js', version: '0.3.0', platform: 'react-native', ...sdkPatch } }) as unknown as Record<string, unknown>;

/** A virtual SDK session that records every server message. */
async function connect(layer: SdkLayer, sdkPatch: Record<string, unknown>, session: string): Promise<{ s: VirtualSdkSession; got: ServerToSdk[]; appId: string }> {
  const s = layer.openVirtual({ transport: 'demo', deviceId: 'demo:1' });
  const got: ServerToSdk[] = [];
  s.onMessage((m) => got.push(m));
  s.send(rawHello(sdkPatch, session) as never);
  const appId = await s.appId;
  await waitFor(() => got.some((m) => m.type === 'welcome'));
  return { s, got, appId };
}

const ruleIds = (m: ServerToSdk | undefined): string[] =>
  !m ? [] : (m.type === 'welcome' ? m.mocks : m.type === 'mocks' ? m.rules : []).map((r) => r.id);
const lastMocks = (got: ServerToSdk[]) => [...got].reverse().find((m) => m.type === 'mocks');

describe('hello.sdk.mockMatchers', () => {
  it('keeps the known matchers once each; anything else is dropped (absent = none)', () => {
    expect(parseHello(rawHello({ mockMatchers: ['graphql'] }))?.sdk.mockMatchers).toEqual(['graphql']);
    expect(parseHello(rawHello({ mockMatchers: ['headers', 'graphql', 'graphql', 7, null] }))?.sdk.mockMatchers).toEqual(['graphql']);
    for (const v of [undefined, [], ['headers'], 'graphql', { 0: 'graphql' }]) {
      expect(parseHello(rawHello({ mockMatchers: v }))?.sdk).not.toHaveProperty('mockMatchers');
    }
  });

  it('reaches AppSession.sdk (what the UI explains from) and survives a session export / import', async () => {
    hub = makeHub();
    const h = hub;
    sdk = createSdkLayerWithTimings({ hub: h, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.3.0' }, { helloTimeoutMs: 200 });
    h.upsertDevice(device('demo:1', { kind: 'virtual' }));
    const { appId } = await connect(sdk, { mockMatchers: ['graphql', 'later'] }, 'a');
    expect(h.getApp(appId)?.sdk.mockMatchers).toEqual(['graphql']);

    const app = h.registerApp(appInput('demo:1', { sessionKey: 'old', sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter' } }));
    expect(h.getApp(app.id)?.sdk).not.toHaveProperty('mockMatchers');

    const file: SessionExport = h.exportSession({ appId });
    expect(file.apps[0]?.sdk.mockMatchers).toEqual(['graphql']);
    const broken = { ...file, apps: file.apps.map((a) => ({ ...a, sdk: { ...a.sdk, mockMatchers: ['graphql', 'x', 'graphql'] } })) };
    const { deviceIds } = h.importSession(broken as unknown as SessionExport, 'pati');
    expect(h.getApps().find((a) => a.deviceId === deviceIds[0])?.sdk.mockMatchers).toEqual(['graphql']);
  });
});

describe('rules with conditions only go to SDKs that declared the matcher', () => {
  it('welcome: an older SDK gets only the plain rules, a newer one gets all of them', async () => {
    hub = makeHub();
    const h = hub;
    let rules: MockRule[] = [plain, getUser];
    sdk = createSdkLayerWithTimings({ hub: h, logger: silentLogger, settings: () => makeSettings(), mocks: () => rules, serverVersion: '0.3.0' }, { helloTimeoutMs: 200 });
    h.upsertDevice(device('demo:1', { kind: 'virtual' }));
    const older = await connect(sdk, {}, 'older');
    const newer = await connect(sdk, { mockMatchers: ['graphql'] }, 'newer');
    const unknownOnly = await connect(sdk, { mockMatchers: ['headers'] }, 'other');
    expect(ruleIds(older.got.find((m) => m.type === 'welcome'))).toEqual(['plain']);
    expect(ruleIds(newer.got.find((m) => m.type === 'welcome'))).toEqual(['plain', 'gql-user']);
    expect(ruleIds(unknownOnly.got.find((m) => m.type === 'welcome'))).toEqual(['plain']);

    // A rule change re-sends each session its own list (also through the override path).
    rules = [getFeed, plain, getUser];
    sdk.setMocks(rules);
    await waitFor(() => lastMocks(older.got) && lastMocks(newer.got));
    expect(ruleIds(lastMocks(older.got))).toEqual(['plain']);
    expect(ruleIds(lastMocks(newer.got))).toEqual(['gql-feed', 'plain', 'gql-user']);
    // The rule reaches the SDK as stored, condition included.
    const sent = (lastMocks(newer.got) as { rules: MockRule[] }).rules.find((r) => r.id === 'gql-user');
    expect(sent?.when).toEqual({ graphql: { operationName: 'GetUser', operationType: 'query' } });

    // Only GraphQL rules: the older SDK gets an empty list (nothing of them mocks everything at /graphql).
    sdk.setMocks([getUser, getFeed]);
    await waitFor(() => older.got.filter((m) => m.type === 'mocks').length >= 2);
    expect(ruleIds(lastMocks(older.got))).toEqual([]);
    expect(ruleIds(lastMocks(newer.got))).toEqual(['gql-user', 'gql-feed']);
  });

  it('rules without conditions are untouched (same objects, app scope and enabled filter as before)', async () => {
    hub = makeHub();
    const h = hub;
    const scoped: MockRule = { ...plain, id: 'scoped', apps: ['com.other.app'] };
    const off: MockRule = { ...plain, id: 'off', enabled: false };
    const emptyWhen = { ...plain, id: 'empty-when', when: {} } as MockRule;
    sdk = createSdkLayerWithTimings(
      { hub: h, logger: silentLogger, settings: () => makeSettings(), mocks: () => [plain, scoped, off, emptyWhen], serverVersion: '0.3.0' },
      { helloTimeoutMs: 200 },
    );
    h.upsertDevice(device('demo:1', { kind: 'virtual' }));
    const older = await connect(sdk, {}, 'older');
    const welcome = older.got.find((m) => m.type === 'welcome');
    expect(ruleIds(welcome)).toEqual(['plain', 'empty-when']);
    expect(welcome?.type === 'welcome' && welcome.mocks[0]).toEqual(plain);
  });
});

describe('validateMockRule: when.graphql', () => {
  const base = { url: '/graphql', method: 'POST', action: respond };
  it('keeps a valid condition (name trimmed; type optional; empty type = any)', () => {
    const ok = validateMockRule({ ...base, when: { graphql: { operationName: ' GetUser ', operationType: 'query' } } });
    expect(ok.ok && ok.rule.when).toEqual({ graphql: { operationName: 'GetUser', operationType: 'query' } });
    const anyType = validateMockRule({ ...base, when: { graphql: { operationName: '_get_2', operationType: '' } } });
    expect(anyType.ok && anyType.rule.when).toEqual({ graphql: { operationName: '_get_2' } });
    for (const when of [undefined, null, {}, { graphql: null }]) {
      const r = validateMockRule({ ...base, when });
      expect(r.ok && 'when' in r.rule).toBe(false);
    }
  });

  it('refuses bad input with the field and what it expects', () => {
    const cases: [unknown, string, string][] = [
      ['nope', 'when', 'object'],
      [{ graphql: 'GetUser' }, 'when.graphql', 'object'],
      [{ graphql: {} }, 'when.graphql.operationName', 'required'],
      [{ graphql: { operationName: '  ' } }, 'when.graphql.operationName', 'required'],
      [{ graphql: { operationName: '2Fast' } }, 'when.graphql.operationName', 'graphqlName'],
      [{ graphql: { operationName: 'Get-User' } }, 'when.graphql.operationName', 'graphqlName'],
      [{ graphql: { operationName: 'Get User' } }, 'when.graphql.operationName', 'graphqlName'],
      [{ graphql: { operationName: 'A'.repeat(129) } }, 'when.graphql.operationName', 'maxLength'],
      [{ graphql: { operationName: 'GetUser', operationType: 'Query' } }, 'when.graphql.operationType', 'oneOf'],
      [{ headers: { name: 'x' } }, 'when.headers', 'unknownCondition'],
    ];
    for (const [when, field, expected] of cases) {
      const r = validateMockRule({ ...base, name: 'Gql', when });
      expect(r.ok, JSON.stringify(when)).toBe(false);
      if (!r.ok) {
        expect(r.field, JSON.stringify(when)).toBe(field);
        expect(r.expected, JSON.stringify(when)).toBe(expected);
        expect(r.problem).toMatch(/^rule #1 \(Gql\): /);
      }
    }
    expect(validateMockRule({ ...base, when: { graphql: { operationName: 'A'.repeat(128) } } }).ok).toBe(true);
  });

  it('a list keeps the valid rules and reports the others (mocks.json, packages)', () => {
    const { rules, issues } = validateMockRules([
      { ...base, id: 'a', when: { graphql: { operationName: 'GetUser' } } },
      { ...base, id: 'b', when: { graphql: { operationName: 'bad name' } } },
    ]);
    expect(rules.map((r) => [r.id, r.when])).toEqual([['a', { graphql: { operationName: 'GetUser' } }]]);
    expect(issues).toEqual([{ rule: 2, field: 'when.graphql.operationName', expected: 'graphqlName' }]);
  });
});

describe('the demo app applies GraphQL conditions like an SDK', () => {
  it('a GetUser rule answers GetUser only; other operations at the same URL reach the (simulated) network', async () => {
    const { HttpSim, json } = await import('../../src/demo/http');
    const { Rng } = await import('../../src/demo/rng');
    const sent: Array<{ type: string; id?: string; mocked?: boolean; mockRuleId?: string }> = [];
    const timers: Array<() => void> = [];
    const sim = new HttpSim(
      {
        bundleId: 'com.mykynk.pati',
        source: 'dart:io',
        send: (m) => sent.push(m as never),
        after: (_ms, fn) => timers.push(fn),
        now: () => 1_000,
        mocks: () => [{ ...getUser, url: 'https://gql.pati.app/graphql' }],
        baseHeaders: () => [],
        errorText: () => 'failed',
      },
      new Rng(7),
    );
    const call = (operationName: string, query: string) =>
      sim.request({ method: 'POST', url: 'https://gql.pati.app/graphql', body: json({ operationName, query }), response: { status: 200 }, latencyMs: 10 });
    const user = call('GetUser', 'query GetUser { me { id } }');
    const feed = call('GetFeed', 'query GetFeed { feed { id } }');
    const mutation = call('GetUser', 'mutation GetUser { touch }'); // same name, other type: the rule wants a query
    while (timers.length) timers.shift()!();
    const outcome = (id: string) => sent.find((m) => m.type === 'net.response' && m.id === id);
    expect(outcome(user)).toMatchObject({ mocked: true, mockRuleId: 'gql-user' });
    expect(outcome(feed)?.mocked).toBeUndefined();
    expect(outcome(mutation)?.mocked).toBeUndefined();
  });
});
