import type { Header, MockAction, MockRule, UrlMatchType } from './protocol.js';
import { hostOfUrl } from './util.js';

/**
 * Copy of the protocol's reference matcher (`packages/protocol/src/index.ts`). Every SDK implements
 * identical semantics; `test/protocol-compat.test.ts` checks this copy against the reference.
 *  - method: '*' matches anything, otherwise case-insensitive equality;
 *  - contains / exact / glob: case-insensitive; glob '*' = any run of chars (incl. '/'), '?' = one char,
 *    and must match the WHOLE url;
 *  - regex: pattern used as-is (case-sensitive), searched anywhere in the url; invalid regex never matches;
 *  - apps: empty/undefined = all apps, otherwise must contain the app id.
 */
export function mockRuleMatches(rule: MockRule, method: string, url: string, appId?: string): boolean {
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

/** First enabled matching rule (rules are ordered; first match wins). */
export function findMockRule(rules: MockRule[], method: string, url: string, appId?: string): MockRule | undefined {
  for (const rule of rules) {
    try {
      if (mockRuleMatches(rule, method, url, appId)) return rule;
    } catch {
      // A malformed rule must never break the app's request.
    }
  }
  return undefined;
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
