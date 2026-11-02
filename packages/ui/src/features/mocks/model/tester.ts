import { findMockRule, mockRuleMatches, type MockRule, type NetworkEntry } from '@durbun/protocol';

/**
 * Live tester: which recent requests a rule being edited would catch, using the protocol's reference
 * matcher (`mockRuleMatches` / `findMockRule`) so the answer is exactly what the SDKs do.
 */

export interface TesterCandidate {
  key: string;
  method: string;
  url: string;
  /** Bundle id of the app that sent it (undefined for desktop replays). */
  bundleId?: string;
  /** Number of captured requests with this method + URL + app. */
  count: number;
  lastTs: number;
  /** Most recent entry id (to open it in the network view). */
  sampleId: string;
}

/** Distinct (method, URL, app) of the most recent requests, newest first. `entries` are in arrival order. */
export function collectCandidates(entries: readonly NetworkEntry[], bundleOf: (appId: string | undefined) => string | undefined, limit = 400): TesterCandidate[] {
  const map = new Map<string, TesterCandidate>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!e.url || e.method === '?') continue;
    const bundleId = bundleOf(e.appId);
    const key = `${e.method.toUpperCase()} ${e.url} ${bundleId ?? ''}`;
    const cur = map.get(key);
    if (cur) {
      cur.count++;
      continue;
    }
    if (map.size >= limit) continue;
    map.set(key, { key, method: e.method.toUpperCase(), url: e.url, bundleId, count: 1, lastTs: e.startTs, sampleId: e.id });
  }
  return [...map.values()];
}

export type TesterVerdict = 'applies' | 'shadowed' | 'appMismatch' | 'methodMismatch' | 'noMatch';

export interface TesterResult {
  verdict: TesterVerdict;
  /** The rule that wins instead (shadowed). */
  winner?: MockRule;
}

/** Rules with the edited rule in place (new rules go first), all treated as they would be saved. */
export function withDraft(rules: readonly MockRule[], draft: MockRule, insertAt = 0): MockRule[] {
  const i = rules.findIndex((r) => r.id === draft.id);
  if (i >= 0) return rules.map((r) => (r.id === draft.id ? draft : r));
  const out = rules.slice();
  out.splice(Math.max(0, Math.min(out.length, insertAt)), 0, draft);
  return out;
}

/** Verdict for one request. The draft is evaluated as enabled (the tester explains "would match"). */
export function testRequest(draft: MockRule, list: readonly MockRule[], method: string, url: string, bundleId: string | undefined): TesterResult {
  const live: MockRule = { ...draft, enabled: true };
  if (mockRuleMatches(live, method, url, bundleId)) {
    const rules = list.map((r) => (r.id === draft.id ? live : r));
    const winner = findMockRule(rules, method, url, bundleId);
    if (winner && winner.id !== draft.id) return { verdict: 'shadowed', winner };
    return { verdict: 'applies' };
  }
  const urlOnly: MockRule = { ...live, method: '*', apps: undefined };
  if (mockRuleMatches(urlOnly, method, url, bundleId)) {
    const methodOk = mockRuleMatches({ ...live, apps: undefined }, method, url, bundleId);
    return { verdict: methodOk ? 'appMismatch' : 'methodMismatch' };
  }
  return { verdict: 'noMatch' };
}

export interface TesterRow extends TesterCandidate, TesterResult {}

/** Evaluate the candidates; rows that match (applies / shadowed) first, then near misses. */
export function evaluateTester(draft: MockRule, list: readonly MockRule[], candidates: readonly TesterCandidate[]): { rows: TesterRow[]; applies: number; shadowed: number; requests: number } {
  const rows: TesterRow[] = [];
  let applies = 0;
  let shadowed = 0;
  let requests = 0;
  for (const c of candidates) {
    const r = testRequest(draft, list, c.method, c.url, c.bundleId);
    if (r.verdict === 'noMatch') continue;
    if (r.verdict === 'applies') {
      applies++;
      requests += c.count;
    } else if (r.verdict === 'shadowed') shadowed++;
    rows.push({ ...c, ...r });
  }
  const rank: Record<TesterVerdict, number> = { applies: 0, shadowed: 1, methodMismatch: 2, appMismatch: 3, noMatch: 4 };
  rows.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  return { rows, applies, shadowed, requests };
}
