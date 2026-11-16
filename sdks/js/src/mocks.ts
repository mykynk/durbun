import type { GraphqlOperationType, Header, MockAction, MockMatcher, MockRule, MockRuleConditions, UrlMatchType } from './protocol.js';
import { hostOfUrl } from './util.js';

/** Mock rule conditions this SDK evaluates (sent in `hello.sdk.mockMatchers`). */
export const MOCK_MATCHERS: MockMatcher[] = ['graphql'];

/**
 * Copy of the protocol's reference matcher (`packages/protocol/src/index.ts`). Every SDK implements
 * identical semantics; `test/protocol-compat.test.ts` checks this copy against the reference.
 *  - method: '*' matches anything, otherwise case-insensitive equality;
 *  - contains / exact / glob: case-insensitive; glob '*' = any run of chars (incl. '/'), '?' = one char,
 *    and must match the WHOLE url;
 *  - regex: pattern used as-is (case-sensitive), searched anywhere in the url; invalid regex never matches;
 *  - apps: empty/undefined = all apps, otherwise must contain the app id.
 * A rule with conditions (`when`) is checked as `mockRuleMatchesRequest` with no body.
 */
export function mockRuleMatches(rule: MockRule, method: string, url: string, appId?: string): boolean {
  if (matchersUsed(rule).length === 0) return urlRuleMatches(rule, method, url, appId);
  return mockRuleMatchesRequest(rule, { method, url, appId });
}

function urlRuleMatches(rule: MockRule, method: string, url: string, appId?: string): boolean {
  if (!rule.enabled) return false;
  if (rule.apps && rule.apps.length > 0 && (!appId || !rule.apps.includes(appId))) return false;
  if (rule.method !== '*' && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  const u = url.toLowerCase();
  const p = rule.url.toLowerCase();
  switch (rule.match) {
    case 'contains':
      return p.length > 0 && u.includes(p);
    case 'exact':
      return u === p;
    case 'glob': {
      const re = '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      return new RegExp(re).test(u);
    }
    case 'regex':
      try {
        return new RegExp(rule.url).test(url);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/* ────────────────────────────── mock matching v2 (copy of the reference) ────────────────────────────── */

/** What a rule is matched against. `body`: the request body text only when already held (never a stream). */
export interface MockRequestInput {
  method: string;
  url: string;
  appId?: string;
  contentType?: string;
  body?: string;
}

/** One GraphQL operation of a request (`name` absent = anonymous, `type` absent = not known). */
export interface GraphqlOperationRef {
  name?: string;
  type?: GraphqlOperationType;
}

/**
 * What the network patches pass for the body: its content type and a function returning the body text when the SDK
 * already holds it (a string, small bytes), else undefined. Called at most once, only when a rule needs the body.
 */
export interface MockRequestBody {
  contentType?: string;
  body?: () => string | undefined;
}

const MAX_DECODE_BYTES = 3 * 64 * 1024;

/**
 * The body text the matcher may read without touching a stream: a string as is; bytes (ArrayBuffer / typed array)
 * decoded as UTF-8 when TextDecoder exists and they are small. Anything else (Blob, FormData, streams): undefined.
 */
export function heldBodyText(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (body === null || body === undefined || typeof body !== 'object') return undefined;
  const TD = (globalThis as { TextDecoder?: new (label?: string) => { decode(input: ArrayBufferView | ArrayBuffer): string } }).TextDecoder;
  if (typeof TD !== 'function') return undefined;
  let bytes: ArrayBufferView | ArrayBuffer | undefined;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) bytes = body;
  else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) bytes = body as ArrayBufferView;
  if (!bytes || bytes.byteLength > MAX_DECODE_BYTES) return undefined;
  return new TD('utf-8').decode(bytes);
}

/** Longest text (UTF-16 code units) read for the GraphQL operation; longer = unknown (the rule does not match). */
export const MOCK_GRAPHQL_MAX_CHARS = 64 * 1024;

/** Condition keys a rule uses; 'when' itself when it is not an object (never matches). */
function matchersUsed(rule: MockRule): string[] {
  const when = (rule as { when?: unknown }).when;
  if (when === undefined || when === null) return [];
  if (typeof when !== 'object' || Array.isArray(when)) return ['when'];
  const rec = when as Record<string, unknown>;
  return Object.keys(rec).filter((k) => rec[k] !== undefined && rec[k] !== null);
}

const isNameStart = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isNameChar = (c: string | undefined): boolean => isNameStart(c) || (c !== undefined && c >= '0' && c <= '9');

/** Operation definitions of a GraphQL document, in order (fragments skipped). Same rules as the reference. */
export function graphqlDocumentOperations(doc: string): { type: GraphqlOperationType; name?: string }[] {
  const ops: { type: GraphqlOperationType; name?: string }[] = [];
  const n = doc.length;
  let i = 0;
  let depth = 0;
  let parens = 0;
  let pending: 'operation' | 'fragment' | null = null;
  while (i < n) {
    const c = doc[i];
    if (c === '#') {
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') i++;
    } else if (c === '"') {
      if (doc.startsWith('"""', i)) {
        i += 3;
        while (i < n && !doc.startsWith('"""', i)) i += doc.startsWith('\\"""', i) ? 4 : 1;
        i = Math.min(n, i + 3);
      } else {
        i++;
        while (i < n && doc[i] !== '"' && doc[i] !== '\n') i += doc[i] === '\\' ? 2 : 1;
        i = Math.min(n, i + 1);
      }
    } else if (c === '(') {
      parens++;
      i++;
    } else if (c === ')') {
      parens = Math.max(0, parens - 1);
      i++;
    } else if (c === '{') {
      if (depth === 0 && parens === 0) {
        if (pending === null) ops.push({ type: 'query' });
        pending = null;
      }
      depth++;
      i++;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (isNameStart(c)) {
      const start = i;
      while (i < n && isNameChar(doc[i])) i++;
      if (depth === 0 && parens === 0 && pending === null) {
        const word = doc.slice(start, i);
        if (word === 'query' || word === 'mutation' || word === 'subscription') {
          let j = i;
          while (j < n) {
            if (doc[j] === '#') while (j < n && doc[j] !== '\n' && doc[j] !== '\r') j++;
            else if (doc[j] === ' ' || doc[j] === '\t' || doc[j] === '\n' || doc[j] === '\r' || doc[j] === ',' || doc[j] === '\uFEFF') j++;
            else break;
          }
          if (isNameStart(doc[j])) {
            let k = j;
            while (k < n && isNameChar(doc[k])) k++;
            ops.push({ type: word, name: doc.slice(j, k) });
            i = k;
          } else {
            ops.push({ type: word });
          }
          pending = 'operation';
        } else if (word === 'fragment') {
          pending = 'fragment';
        }
      }
    } else {
      i++;
    }
  }
  return ops;
}

function payloadOperation(query: unknown, operationName: unknown): GraphqlOperationRef | null {
  const name = typeof operationName === 'string' && operationName !== '' ? operationName : undefined;
  if (typeof query === 'string') {
    if (query.length > MOCK_GRAPHQL_MAX_CHARS) return null;
    const ops = graphqlDocumentOperations(query);
    if (name !== undefined) {
      const named = ops.find((o) => o.name === name);
      return named ? { name, type: named.type } : { name };
    }
    const first = ops[0];
    if (!first) return null;
    return first.name !== undefined ? { name: first.name, type: first.type } : { type: first.type };
  }
  return name !== undefined ? { name } : null;
}

function trimAsciiWhitespace(s: string): string {
  const ws = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let a = 0;
  let b = s.length;
  while (a < b && ws(s[a])) a++;
  while (b > a && ws(s[b - 1])) b--;
  return s.slice(a, b);
}

function urlQueryParams(url: string): Map<string, string> | null {
  const q = url.indexOf('?');
  const params = new Map<string, string>();
  if (q < 0) return params;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      if (!params.has(key)) params.set(key, decodeURIComponent(rawValue.replace(/\+/g, ' ')));
    } catch {
      return null;
    }
  }
  return params;
}

/**
 * The GraphQL operation(s) of a request, or null when unknown (the reference's `graphqlOperationsOf`): JSON body
 * (`operationName`, else the first operation of `query`; batched arrays give one per element; persisted queries
 * the name only), an `application/graphql` body, or a GET request's `query` / `operationName` parameters.
 */
export function graphqlOperationsOf(req: Pick<MockRequestInput, 'method' | 'url' | 'contentType' | 'body'>): GraphqlOperationRef[] | null {
  const held = req.body; // read once (a caller may compute it lazily)
  const raw = typeof held === 'string' ? held : '';
  const body = trimAsciiWhitespace(raw);
  if (body !== '') {
    if (raw.length > MOCK_GRAPHQL_MAX_CHARS) return null;
    const ct = (req.contentType || '').toLowerCase();
    if (ct.includes('application/graphql') && !ct.includes('json')) {
      const first = graphqlDocumentOperations(body)[0];
      if (!first) return null;
      return [first.name !== undefined ? { name: first.name, type: first.type } : { type: first.type }];
    }
    if (body[0] !== '{' && body[0] !== '[') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const payloads = Array.isArray(parsed) ? parsed : [parsed];
    const ops: GraphqlOperationRef[] = [];
    for (const p of payloads) {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) continue;
      const rec = p as Record<string, unknown>;
      const op = payloadOperation(rec.query, rec.operationName);
      if (op) ops.push(op);
    }
    return ops.length > 0 ? ops : null;
  }
  if (String(req.method).toUpperCase() !== 'GET') return null;
  const params = urlQueryParams(req.url);
  if (!params) return null;
  const op = payloadOperation(params.get('query'), params.get('operationName'));
  return op ? [op] : null;
}

function graphqlConditionHolds(cond: unknown, ops: GraphqlOperationRef[] | null): boolean {
  if (!ops || typeof cond !== 'object' || cond === null) return false;
  const c = cond as Record<string, unknown>;
  if (typeof c.operationName !== 'string' || c.operationName === '') return false;
  const type = c.operationType;
  if (type !== undefined && type !== null && type !== 'query' && type !== 'mutation' && type !== 'subscription') return false;
  return ops.some((op) => op.name === c.operationName && (type === undefined || type === null || op.type === type));
}

/** Method / URL / apps, then every condition of `rule.when` (unknown condition keys never match). */
export function mockRuleMatchesRequest(rule: MockRule, req: MockRequestInput, ops?: GraphqlOperationRef[] | null): boolean {
  if (!urlRuleMatches(rule, req.method, req.url, req.appId)) return false;
  const used = matchersUsed(rule);
  if (used.length === 0) return true;
  for (const key of used) if (key !== 'graphql') return false;
  return graphqlConditionHolds((rule.when as MockRuleConditions).graphql, ops === undefined ? graphqlOperationsOf(req) : ops);
}

/**
 * First enabled matching rule for a request (first match wins). The body is read (`req.body`) at most once, and only
 * when a rule whose method / URL / apps match has a condition. A malformed rule never breaks the app's request.
 */
export function findMockRuleForRequest(rules: readonly MockRule[], req: MockRequestInput): MockRule | undefined {
  let ops: GraphqlOperationRef[] | null | undefined;
  for (const rule of rules) {
    try {
      if (!urlRuleMatches(rule, req.method, req.url, req.appId)) continue;
      if (matchersUsed(rule).length === 0) return rule;
      if (ops === undefined) {
        try {
          ops = graphqlOperationsOf(req);
        } catch {
          ops = null;
        }
      }
      if (mockRuleMatchesRequest(rule, req, ops)) return rule;
    } catch {
      // A malformed rule must never break the app's request.
    }
  }
  return undefined;
}

/** First enabled matching rule (rules are ordered; first match wins). */
export function findMockRule(rules: MockRule[], method: string, url: string, appId?: string): MockRule | undefined {
  return findMockRuleForRequest(rules, { method, url, appId });
}

const MAX_MOCK_DELAY_MS = 10 * 60 * 1000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normHeaders(v: unknown): Header[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Header[] = [];
  for (const h of v) {
    if (Array.isArray(h) && typeof h[0] === 'string' && h[1] !== undefined && h[1] !== null) out.push([h[0], String(h[1])]);
  }
  return out;
}

function normDelay(v: unknown): number | undefined {
  if (typeof v !== 'number' || !isFinite(v)) return undefined;
  return Math.min(MAX_MOCK_DELAY_MS, Math.max(0, v));
}

function normAction(v: unknown): MockAction | undefined {
  if (!isObj(v)) return undefined;
  switch (v.type) {
    case 'respond': {
      const status = typeof v.status === 'number' && isFinite(v.status) ? Math.round(v.status) : 200;
      const action: MockAction = { type: 'respond', status };
      const headers = normHeaders(v.headers);
      if (headers) action.headers = headers;
      if (typeof v.body === 'string') action.body = v.body;
      if (v.bodyEncoding === 'base64' || v.bodyEncoding === 'utf8') action.bodyEncoding = v.bodyEncoding;
      const delay = normDelay(v.delayMs);
      if (delay !== undefined) action.delayMs = delay;
      return action;
    }
    case 'delay':
      return { type: 'delay', delayMs: normDelay(v.delayMs) ?? 0 };
    case 'fail': {
      const error =
        v.error === 'timeout' || v.error === 'connection' || v.error === 'dns' || v.error === 'tls' || v.error === 'custom'
          ? v.error
          : 'connection';
      const action: MockAction = { type: 'fail', error };
      if (typeof v.message === 'string' && v.message) action.message = v.message;
      const delay = normDelay(v.delayMs);
      if (delay !== undefined) action.delayMs = delay;
      return action;
    }
    default:
      return undefined;
  }
}

/** Validates rules received from the desktop; malformed entries are dropped instead of crashing later. */
export function normalizeRules(input: unknown): MockRule[] {
  if (!Array.isArray(input)) return [];
  const out: MockRule[] = [];
  for (const r of input) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.url !== 'string') continue;
    const action = normAction(r.action);
    if (!action) continue;
    const rule: MockRule = {
      id: r.id,
      enabled: r.enabled === true,
      // Kept verbatim so matching stays identical to the reference (unknown match types never match).
      method: typeof r.method === 'string' ? r.method : '*',
      url: r.url,
      match: (typeof r.match === 'string' ? r.match : '') as UrlMatchType,
      action,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    };
    if (typeof r.name === 'string') rule.name = r.name;
    if (Array.isArray(r.apps)) rule.apps = r.apps.filter((a): a is string => typeof a === 'string');
    // Conditions are kept as sent (a key this SDK does not know makes the rule never match, never "every request").
    if (r.when !== undefined && r.when !== null) {
      if (!isObj(r.when)) continue;
      rule.when = r.when as MockRuleConditions;
    }
    out.push(rule);
  }
  return out;
}

/** How long to wait before applying the rule's action. */
export function mockDelayMs(action: MockAction): number {
  return normDelay(action.delayMs) ?? 0;
}

export type FailAction = Extract<MockAction, { type: 'fail' }>;
export type RespondAction = Extract<MockAction, { type: 'respond' }>;

/** Human-readable description of a simulated failure (reported to the desktop as `net.error`). */
export function describeMockFailure(action: FailAction, url: string): string {
  if (action.message) return action.message;
  const host = hostOfUrl(url) || 'the server';
  switch (action.error) {
    case 'timeout':
      return 'The request timed out.';
    case 'connection':
      return `Could not connect to ${host} (connection refused).`;
    case 'dns':
      return `Could not resolve host "${host}".`;
    case 'tls':
      return `TLS handshake with ${host} failed: the server certificate is not trusted.`;
    default:
      return 'The request failed.';
  }
}

const STATUS_TEXT: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  418: "I'm a teapot",
  422: 'Unprocessable Entity',
  423: 'Locked',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] || '';
}
