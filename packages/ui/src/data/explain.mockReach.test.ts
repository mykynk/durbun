import { describe, expect, it } from 'vitest';
import type { AppSession, MockRule } from '@durbun/protocol';
import { mockRuleReach, mockRuleUnsupportedSessions } from './explain';

function session(id: string, p: { device?: string; app?: string; matchers?: string[]; connected?: boolean; at?: number; caps?: string[] } = {}): AppSession {
  return {
    id,
    sessionKey: id,
    deviceId: p.device ?? 'android:1',
    sdk: { name: 'durbun', version: '0.3.0', platform: 'flutter', ...(p.matchers ? { mockMatchers: p.matchers as never } : {}) },
    app: { name: p.app === 'com.kasa' ? 'Kasa' : 'Pati', id: p.app ?? 'com.pati' },
    transport: 'tcp',
    connected: p.connected ?? true,
    connectedAt: p.at ?? 1,
    capabilities: (p.caps ?? ['logs', 'network', 'mocks']) as AppSession['capabilities'],
    stats: { logs: 0, requests: 0, errors: 0 },
  } as AppSession;
}

const gql: Pick<MockRule, 'when' | 'apps'> = { when: { graphql: { operationName: 'GetUser' } } };

describe('mockRuleReach', () => {
  it('says nothing for a rule without conditions', () => {
    expect(mockRuleReach({}, [session('a')]).state).toBe('plain');
    expect(mockRuleReach({ when: {} }, [session('a')]).state).toBe('plain');
  });

  it('noApps when no connected app with mocks is in the rule scope', () => {
    expect(mockRuleReach(gql, []).state).toBe('noApps');
    expect(mockRuleReach(gql, [session('a', { connected: false }), session('b', { caps: ['logs'] })]).state).toBe('noApps');
    expect(mockRuleReach({ ...gql, apps: ['com.kasa'] }, [session('a', { matchers: [] })]).state).toBe('noApps');
  });

  it('all / some / nowhere by what each connected SDK declared', () => {
    expect(mockRuleReach(gql, [session('a', { matchers: ['graphql'] })])).toMatchObject({ state: 'all', missing: [] });
    const some = mockRuleReach(gql, [session('a', { matchers: ['graphql'] }), session('b', { device: 'ios:1', app: 'com.kasa' })]);
    expect(some).toMatchObject({ state: 'some', missingSessions: ['b'] });
    expect(some.missing.map((a) => a.name)).toEqual(['Kasa']);
    expect(mockRuleReach(gql, [session('a'), session('b', { matchers: ['somethingElse'] })]).state).toBe('nowhere');
  });

  it('only the newest session of an app on a device counts', () => {
    const old = session('old', { at: 1 });
    const fresh = session('new', { at: 2, matchers: ['graphql'] });
    expect(mockRuleReach(gql, [old, fresh]).state).toBe('all');
    expect(mockRuleReach(gql, [fresh, old]).state).toBe('all');
  });

  it('unsupported sessions include disconnected ones (their requests were never mocked by the rule)', () => {
    const sessions = [session('a', { matchers: ['graphql'] }), session('b', { connected: false }), session('c', { app: 'com.kasa' })];
    expect([...mockRuleUnsupportedSessions(gql, sessions)]).toEqual(['b', 'c']);
    expect([...mockRuleUnsupportedSessions({ ...gql, apps: ['com.pati'] }, sessions)]).toEqual(['b']);
    expect(mockRuleUnsupportedSessions({}, sessions).size).toBe(0);
  });
});
