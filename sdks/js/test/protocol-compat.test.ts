/**
 * The SDK ships its own copy of the protocol types/helpers (no runtime or .d.ts dependency on the private
 * @durbun/protocol package). This file fails the typecheck when a copied type drifts from the source of
 * truth, and fails at runtime when a copied helper behaves differently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as P from '@durbun/protocol';
import * as W from '../src/protocol.js';
import { findMockRule, mockRuleMatches } from '../src/mocks.js';
import { SDK_VERSION } from '../src/version.js';

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
