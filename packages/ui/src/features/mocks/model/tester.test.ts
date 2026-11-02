import { describe, expect, it } from 'vitest';
import type { MockRule, NetworkEntry } from '@durbun/protocol';
import { collectCandidates, evaluateTester, testRequest, withDraft } from './tester';

function rule(id: string, p: Partial<MockRule> = {}): MockRule {
  return { id, enabled: true, method: '*', url: '/v1/pets', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 1, ...p };
}

let n = 0;
function entry(method: string, url: string, appId = 'app:1'): NetworkEntry {
  return {
    id: `e${++n}`,
    appId,
    deviceId: 'demo:1',
    source: 'dart:io',
    method,
    url,
    host: new URL(url).host,
    path: new URL(url).pathname,
    startTs: n,
    state: 'complete',
    status: 200,
    requestHeaders: [],
    hasRequestBody: false,
    hasResponseBody: false,
  };
}

const bundles: Record<string, string> = { 'app:1': 'com.mykynk.pati', 'app:2': 'com.mykynk.mahalle' };
const bundleOf = (id: string | undefined) => (id ? bundles[id] : undefined);

describe('collectCandidates', () => {
  it('dedupes by method + URL + app, newest first, with counts', () => {
    const entries = [
      entry('GET', 'https://api.pati.app/v1/pets'),
      entry('GET', 'https://api.pati.app/v1/pets'),
      entry('POST', 'https://api.pati.app/v1/pets'),
      entry('GET', 'https://api.pati.app/v1/pets', 'app:2'),
    ];
    const c = collectCandidates(entries, bundleOf);
    expect(c.map((x) => `${x.method} ${x.bundleId} ×${x.count}`)).toEqual([
      'GET com.mykynk.mahalle ×1',
      'POST com.mykynk.pati ×1',
      'GET com.mykynk.pati ×2',
    ]);
    expect(c[2]!.sampleId).toBe(entries[1]!.id);
  });
  it('respects the limit and skips placeholders without a URL', () => {
    const entries = [entry('GET', 'https://x.dev/1'), entry('GET', 'https://x.dev/2'), { ...entry('GET', 'https://x.dev/3'), url: '', method: '?' }];
    expect(collectCandidates(entries, bundleOf, 1).map((c) => c.url)).toEqual(['https://x.dev/2']);
  });
});

describe('live tester verdicts (protocol matcher)', () => {
  const pets = 'https://api.pati.app/v1/pets';
  it('applies when the draft is the first match', () => {
    const draft = rule('d');
    expect(testRequest(draft, [draft], 'GET', pets, 'com.mykynk.pati')).toEqual({ verdict: 'applies' });
  });
  it('is shadowed by an earlier rule that also matches', () => {
    const earlier = rule('broad', { url: 'pati.app', name: 'Her şey' });
    const draft = rule('d');
    const list = [earlier, draft];
    const r = testRequest(draft, list, 'GET', pets, undefined);
    expect(r.verdict).toBe('shadowed');
    expect(r.winner?.id).toBe('broad');
    // a disabled earlier rule does not shadow
    expect(testRequest(draft, [{ ...earlier, enabled: false }, draft], 'GET', pets, undefined).verdict).toBe('applies');
  });
  it('explains near misses: app scope and method', () => {
    const scoped = rule('d', { apps: ['com.mykynk.mahalle'] });
    expect(testRequest(scoped, [scoped], 'GET', pets, 'com.mykynk.pati').verdict).toBe('appMismatch');
    const post = rule('p', { method: 'POST' });
    expect(testRequest(post, [post], 'GET', pets, undefined).verdict).toBe('methodMismatch');
    expect(testRequest(post, [post], 'GET', 'https://x.dev/other', undefined).verdict).toBe('noMatch');
  });
  it('evaluates a disabled draft as if enabled (the tester says what WOULD match)', () => {
    const draft = rule('d', { enabled: false });
    expect(testRequest(draft, [draft], 'GET', pets, undefined).verdict).toBe('applies');
  });
  it('uses glob/regex/exact semantics exactly like the SDKs', () => {
    const glob = rule('g', { url: 'https://api.*.app/v1/pets/*', match: 'glob' });
    expect(testRequest(glob, [glob], 'GET', 'https://api.pati.app/v1/pets/42', undefined).verdict).toBe('applies');
    expect(testRequest(glob, [glob], 'GET', pets, undefined).verdict).toBe('noMatch');
    const regex = rule('r', { url: '/pets/\\d+$', match: 'regex' });
    expect(testRequest(regex, [regex], 'GET', 'https://api.pati.app/v1/pets/42', undefined).verdict).toBe('applies');
    expect(testRequest(regex, [regex], 'GET', 'https://api.pati.app/v1/PETS/42', undefined).verdict).toBe('noMatch');
    const exact = rule('e', { url: 'HTTPS://API.PATI.APP/v1/pets', match: 'exact' });
    expect(testRequest(exact, [exact], 'GET', pets, undefined).verdict).toBe('applies');
  });
  it('inserts new rules at the given position and replaces edited ones in place', () => {
    const a = rule('a');
    const b = rule('b');
    expect(withDraft([a, b], rule('n'), 0).map((r) => r.id)).toEqual(['n', 'a', 'b']);
    expect(withDraft([a, b], { ...b, url: '/x' }).map((r) => r.url)).toEqual(['/v1/pets', '/x']);
  });
  it('summarizes matching candidates and sorts applies first', () => {
    const entries = [entry('GET', 'https://api.pati.app/v1/pets/1'), entry('GET', 'https://api.pati.app/v1/feed'), entry('GET', 'https://api.pati.app/v1/pets/2'), entry('GET', 'https://api.pati.app/v1/pets/2')];
    const blocker = rule('b', { url: '/pets/1', name: 'Pet 1' });
    const draft = rule('d', { url: '/pets/' });
    const res = evaluateTester(draft, withDraft([blocker], draft, 1), collectCandidates(entries, bundleOf));
    expect(res.applies).toBe(1);
    expect(res.requests).toBe(2);
    expect(res.shadowed).toBe(1);
    expect(res.rows.map((r) => `${r.verdict}:${r.url}`)).toEqual(['applies:https://api.pati.app/v1/pets/2', 'shadowed:https://api.pati.app/v1/pets/1']);
  });
});
