import { mockRuleMatchesRequest, type GraphqlOperationRef, type GraphqlOperationType, type MockRule, type NetworkEntry } from '@durbun/protocol';

/**
 * Live tester: which recent requests a rule being edited would catch, using the protocol's reference
 * matcher (`mockRuleMatchesRequest`) so the answer is what the SDKs do. The GraphQL operation of a captured request
 * is the one the server read from it (`NetworkEntry.graphql`); an SDK reads it from the body it holds, so the two can
 * differ for bodies an SDK cannot read (streams, files, very large bodies: the SDK sends those to the network).
 */

export interface TesterCandidate {
  key: string;
  method: string;
  url: string;
  /** Session (`AppSession.id`) that sent it: two devices running the same app can get different rules. */
  appId?: string;
  /** Bundle id of the app that sent it (undefined for desktop replays). */
  bundleId?: string;
  /** GraphQL operation the server read from the request (absent: none / not GraphQL). */
  operation?: GraphqlOperationRef;
  /** Number of captured requests with this method + URL + session + operation. */
  count: number;
  lastTs: number;
  /** Most recent entry id (to open it in the network view). */
  sampleId: string;
}

function operationOf(e: NetworkEntry): GraphqlOperationRef | undefined {
  const g = e.graphql;
  if (!g || (!g.operationName && !g.operationType)) return undefined;
  const op: GraphqlOperationRef = {};
  if (g.operationName) op.name = g.operationName;
  if (g.operationType) op.type = g.operationType;
  return op;
}

/** Distinct (method, URL, session, operation) of the most recent requests, newest first. `entries` are in arrival order. */
export function collectCandidates(entries: readonly NetworkEntry[], bundleOf: (appId: string | undefined) => string | undefined, limit = 400): TesterCandidate[] {
  const map = new Map<string, TesterCandidate>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!e.url || e.method === '?') continue;
    const bundleId = bundleOf(e.appId);
    const operation = operationOf(e);
    const key = `${e.method.toUpperCase()} ${e.url} ${e.appId ?? ''} ${operation ? `${operation.type ?? ''}:${operation.name ?? ''}` : ''}`;
    const cur = map.get(key);
    if (cur) {
      cur.count++;
      continue;
    }
    if (map.size >= limit) continue;
    const c: TesterCandidate = { key, method: e.method.toUpperCase(), url: e.url, appId: e.appId, bundleId, count: 1, lastTs: e.startTs, sampleId: e.id };
    if (operation) c.operation = operation;
    map.set(key, c);
  }
  return [...map.values()];
}

export type TesterVerdict = 'applies' | 'notSent' | 'shadowed' | 'operationMismatch' | 'operationUnknown' | 'appMismatch' | 'methodMismatch' | 'noMatch';

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

/** "query GetUser" / "GetUser" typed in the tester → an operation (undefined when empty, null when not a name). */
export function parseOperationInput(text: string): GraphqlOperationRef | null | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const m = /^(?:(query|mutation|subscription)\s+)?([_A-Za-z][_0-9A-Za-z]*)$/.exec(t);
  if (!m) return null;
  return m[1] ? { name: m[2], type: m[1] as GraphqlOperationType } : { name: m[2] };
}

/**
 * Verdict for one request. The draft is evaluated as enabled (the tester explains "would match"). `operation`: the
 * request's GraphQL operation (undefined = none known: a rule with an operation condition does not match it).
 */
export function testRequest(draft: MockRule, list: readonly MockRule[], method: string, url: string, bundleId: string | undefined, operation?: GraphqlOperationRef): TesterResult {
  const live: MockRule = { ...draft, enabled: true };
  const req = { method, url, appId: bundleId };
  const ops = operation ? [operation] : null;
  if (mockRuleMatchesRequest(live, req, ops)) {
    const rules = list.map((r) => (r.id === draft.id ? live : r));
    const winner = rules.find((r) => mockRuleMatchesRequest(r, req, ops));
    if (winner && winner.id !== draft.id) return { verdict: 'shadowed', winner };
    return { verdict: 'applies' };
  }
  const { when: _when, ...noConditions } = live;
  if (live.when && mockRuleMatchesRequest(noConditions, req, ops)) return { verdict: operation ? 'operationMismatch' : 'operationUnknown' };
  const urlOnly: MockRule = { ...noConditions, method: '*', apps: undefined };
  if (mockRuleMatchesRequest(urlOnly, req, ops)) {
    const methodOk = mockRuleMatchesRequest({ ...noConditions, apps: undefined }, req, ops);
    return { verdict: methodOk ? 'appMismatch' : 'methodMismatch' };
  }
  return { verdict: 'noMatch' };
}

export interface TesterRow extends TesterCandidate, TesterResult {}

/**
 * Evaluate the candidates; rows that match (applies / shadowed) first, then near misses. `notSentTo`: sessions (`AppSession.id`) whose
 * connected SDK did not declare a condition the draft uses (the server does not send it the rule): a request of such
 * an app that would match is 'notSent', never 'applies'.
 */
export function evaluateTester(
  draft: MockRule,
  list: readonly MockRule[],
  candidates: readonly TesterCandidate[],
  notSentTo?: ReadonlySet<string>,
): { rows: TesterRow[]; applies: number; shadowed: number; notSent: number; requests: number } {
  const rows: TesterRow[] = [];
  let applies = 0;
  let shadowed = 0;
  let notSent = 0;
  let requests = 0;
  for (const c of candidates) {
    let r = testRequest(draft, list, c.method, c.url, c.bundleId, c.operation);
    if (r.verdict === 'noMatch') continue;
    if (r.verdict === 'applies' && c.appId && notSentTo?.has(c.appId)) r = { verdict: 'notSent' };
    if (r.verdict === 'applies') {
      applies++;
      requests += c.count;
    } else if (r.verdict === 'shadowed') shadowed++;
    else if (r.verdict === 'notSent') notSent++;
    rows.push({ ...c, ...r });
  }
  const rank: Record<TesterVerdict, number> = { applies: 0, notSent: 1, shadowed: 2, operationMismatch: 3, operationUnknown: 4, methodMismatch: 5, appMismatch: 6, noMatch: 7 };
  rows.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  return { rows, applies, shadowed, notSent, requests };
}
