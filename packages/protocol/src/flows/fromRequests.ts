/**
 * "Create a flow from requests": captured requests become HTTP request steps in order, and values a later request
 * reuses from an earlier response (a token, an order id, a session header) become templates, so the flow keeps
 * working with fresh data. Secrets (credential headers, password / token / key fields of bodies and queries) that
 * no earlier response explains move into secret environment variables.
 *
 * Links are made between WHOLE values only — a header value or the credential after "Bearer", a path segment, a
 * query value, a JSON or form value — and only for values that look like ids (digits, long enough). Inside longer
 * text (a text body, a cookie) only long, high-entropy tokens are linked. Common words ("orders", "active",
 * "application/json") are never linked.
 */
import type { Header } from '../index';
import { layoutFlow } from './layout';
import { FLOW_FORMAT, FLOW_VERSION, type FlowDoc, type FlowEdge, type FlowNode } from './types';

export interface CapturedRequest {
  method: string;
  url: string;
  requestHeaders: Header[];
  /** Request body as text (utf8); omit for none or binary. */
  requestBody?: string;
  requestContentType?: string;
  status?: number;
  responseHeaders?: Header[];
  /** Response body as text (utf8). */
  responseBody?: string;
  responseContentType?: string;
}

export interface FlowFromRequestsOptions {
  id: string;
  name: string;
  /** Replace the most common origin with {{env.baseUrl}} (default true). */
  baseUrl?: boolean;
  /** Bundle id / package of the app the requests came from. */
  appId?: string;
}

export interface FlowFromRequestsResult {
  flow: FlowDoc;
  /** Variables the flow reads from the environment, with the captured values (offer to save them). */
  envVars: { key: string; value: string; secret: boolean }[];
  /** Values linked to an earlier response: node, where, template. */
  links: { nodeId: string; template: string; value: string }[];
}

const DROPPED = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'expect', 'http2-settings', 'proxy-connection', 'accept-encoding']);
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token', 'x-session-token', 'x-csrf-token', 'x-xsrf-token']);
const BORING_RESPONSE_HEADERS = new Set(['date', 'content-type', 'content-length', 'server', 'connection', 'vary', 'cache-control', 'expires', 'pragma', 'age', 'via', 'accept-ranges', 'content-encoding', 'transfer-encoding', 'last-modified', 'strict-transport-security', 'access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'x-powered-by', 'alt-svc', 'cf-ray', 'cf-cache-status', 'nel', 'report-to', 'x-cache', 'x-amz-cf-id', 'x-amz-cf-pop', 'server-timing', 'x-envoy-upstream-service-time', 'etag']);

/** Words of a field / header / query name that mark its value as a secret. */
const SECRET_WORDS = new Set(['password', 'passwd', 'pass', 'pwd', 'passcode', 'passphrase', 'secret', 'token', 'otp', 'pin', 'auth', 'authorization', 'session', 'sessionid', 'sid', 'cookie', 'signature', 'sig', 'credential', 'credentials', 'jwt', 'apikey', 'appcheck']);
/** A word that is a secret only after one of these (`api_key`, `accessKey`; not `idempotency-key`). */
const KEY_PREFIXES = new Set(['api', 'access', 'private', 'secret', 'subscription', 'client', 'app', 'master']);

// The protocol package has no DOM/Node typings; both runtimes (browser, Node) have these globals.
const G = globalThis as unknown as {
  URL: new (url: string) => { origin: string; pathname: string; search: string };
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** Words of a name: `newPassword` → new, password; `X-Goog-Api-Key` → x, goog, api, key. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Does a field, header or query name hold a secret (password, token, api key, session, cookie…)? */
function isSecretName(name: string): boolean {
  if (SECRET_HEADERS.has(name.toLowerCase())) return true;
  const words = nameWords(name);
  if (words.length === 1 && words[0] === 'key') return true;
  return words.some((w, i) => SECRET_WORDS.has(w) || (w === 'key' && i > 0 && KEY_PREFIXES.has(words[i - 1]!)));
}

/** A value that is an id or a token rather than a word: worth linking when it is a whole value. */
function idLike(s: string): boolean {
  if (s.length < 6 || s.length > 4096 || /\s/.test(s) || !/\d/.test(s)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false; // dates repeat by chance
  if (/^\d+(\.\d+)+$/.test(s)) return false; // versions
  if (/^https?:\/\//i.test(s)) return false;
  return true;
}

/** A long, random-looking token: the only kind of value linked inside longer text. */
function highEntropy(s: string): boolean {
  return s.length >= 16 && s.length <= 4096 && /^[A-Za-z0-9._~+/=-]+$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s);
}

/** Path text of a JSON value for a template (`data.items[0]['x-id']`), or undefined when a key cannot be written. */
function pathText(segments: (string | number)[]): string | undefined {
  let s = '';
  for (const seg of segments) {
    if (typeof seg === 'number') s += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) s += s ? `.${seg}` : seg;
    else if (!/[\\\]]/.test(seg) && !seg.includes("'")) s += `['${seg}']`;
    else if (!/[\\\]]/.test(seg) && !seg.includes('"')) s += `["${seg}"]`;
    else return undefined;
  }
  return s;
}

function walk(value: unknown, path: (string | number)[], visit: (v: unknown, path: (string | number)[]) => void, depth = 0): void {
  if (depth > 12) return;
  if (Array.isArray(value)) value.slice(0, 200).forEach((v, i) => walk(v, [...path, i], visit, depth + 1));
  else if (isObj(value)) for (const [k, v] of Object.entries(value).slice(0, 500)) walk(v, [...path, k], visit, depth + 1);
  else visit(value, path);
}

function nodeIdFor(method: string, url: string, used: Set<string>): string {
  let segs: string[] = [];
  try {
    segs = new G.URL(url).pathname.split('/').filter(Boolean);
  } catch {
    /* keep empty */
  }
  const meaningful = [...segs].reverse().find((s) => !/^\d+$/.test(s) && !/^[0-9a-f-]{16,}$/i.test(s) && s.length < 40) ?? 'request';
  const words = meaningful.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const pascal = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'Request';
  const verb = method.toLowerCase().replace(/[^a-z]/g, '') || 'request';
  const base = `${verb}${pascal}`.slice(0, 48);
  let id = /^[A-Za-z_]/.test(base) ? base : `r${base}`;
  for (let n = 2; used.has(id); n++) id = `${base}${n}`;
  used.add(id);
  return id;
}

function camel(name: string): string {
  const words = nameWords(name);
  return words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join('') || 'secret';
}

interface Known {
  template: string;
  /** Type of the value in the response (a string id read into a JSON number needs `| number`). */
  kind: 'string' | 'number';
}

export function flowFromRequests(requests: readonly CapturedRequest[], opts: FlowFromRequestsOptions): FlowFromRequestsResult {
  const used = new Set<string>(['start']);
  const envVars: FlowFromRequestsResult['envVars'] = [];
  const links: FlowFromRequestsResult['links'] = [];
  // value → template of the most recent response that carried it
  const known = new Map<string, Known>();

  // The common origin becomes {{env.baseUrl}}.
  let origin: string | undefined;
  if (opts.baseUrl !== false) {
    const counts = new Map<string, number>();
    for (const r of requests) {
      try {
        const o = new G.URL(r.url).origin;
        counts.set(o, (counts.get(o) ?? 0) + 1);
      } catch {
        /* ignore */
      }
    }
    origin = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (origin) envVars.push({ key: 'baseUrl', value: origin, secret: false });
  }

  /** The template of a whole value an earlier response carried. `loose`: credentials link without the id check. */
  const linkWhole = (value: string, nodeId: string, loose = false): Known | undefined => {
    const k = known.get(value);
    if (!k || !(idLike(value) || highEntropy(value) || (loose && value.length >= 6))) return undefined;
    links.push({ nodeId, template: k.template, value });
    return k;
  };

  /** Long random tokens an earlier response carried, replaced inside longer text. */
  const linkInside = (text: string, nodeId: string): string => {
    let out = text;
    const entries = [...known.entries()].filter(([v]) => highEntropy(v) && out.includes(v)).sort((a, b) => b[0].length - a[0].length);
    for (const [value, k] of entries) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(`{{${k.template}}}`);
      links.push({ nodeId, template: k.template, value });
    }
    return out;
  };

  const secretVar = (name: string, value: string): string => {
    const existing = envVars.find((e) => e.value === value && e.secret);
    if (existing) return existing.key;
    const base = name.toLowerCase() === 'authorization' ? 'authToken' : camel(name.replace(/^x-/i, ''));
    let key = base;
    for (let n = 2; envVars.some((e) => e.key === key); n++) key = `${base}${n}`;
    envVars.push({ key, value, secret: true });
    return key;
  };

  /** A text value that is a whole value of its own (query value, form field): link, else secret, else as is. */
  const textValue = (name: string, value: string, nodeId: string, pipe = ''): string => {
    const k = linkWhole(value, nodeId, isSecretName(name));
    if (k) return `{{${k.template}${pipe}}}`;
    if (value && isSecretName(name)) return `{{env.${secretVar(name, value)}${pipe}}}`;
    return linkInside(value, nodeId);
  };

  const nodes: FlowNode[] = [{ id: 'start', type: 'trigger.manual' }];
  const edges: FlowEdge[] = [];
  let prev = 'start';

  for (const r of requests) {
    const method = (r.method || 'GET').toUpperCase();
    const id = nodeIdFor(method, r.url, used);

    const params: Record<string, unknown> = { method, url: urlTemplate(r.url, id) };

    const headers: [string, string][] = [];
    for (const [name, rawValue] of r.requestHeaders) {
      const lower = name.toLowerCase();
      if (DROPPED.has(lower) || name.startsWith(':')) continue;
      const secret = isSecretName(name);
      const scheme = /^(Bearer|Token|Basic)\s+(.+)$/i.exec(rawValue);
      let value: string;
      const whole = linkWhole(rawValue, id, secret);
      const credential = scheme ? linkWhole(scheme[2]!, id, true) : undefined;
      if (whole) value = `{{${whole.template}}}`;
      else if (scheme && credential) value = `${scheme[1]} {{${credential.template}}}`;
      else if (secret && rawValue) value = scheme ? `${scheme[1]} {{env.${secretVar(lower, scheme[2]!)}}}` : `{{env.${secretVar(lower, rawValue)}}}`;
      else value = linkInside(rawValue, id);
      headers.push([name, value]);
    }
    if (headers.length) params.headers = headers;

    const reqType = (r.requestContentType ?? headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? '').toLowerCase();
    if (r.requestBody !== undefined && r.requestBody !== '' && method !== 'GET' && method !== 'HEAD') {
      const json = tryJson(r.requestBody);
      if (json !== undefined) {
        params.bodyType = 'json';
        params.body = linkJson(json, id, '');
        params.headers = headers.filter(([n]) => n.toLowerCase() !== 'content-type');
        if ((params.headers as unknown[]).length === 0) delete params.headers;
      } else if (reqType.includes('x-www-form-urlencoded')) {
        params.bodyType = 'form';
        params.form = r.requestBody
          .split('&')
          .filter(Boolean)
          .map((pair) => {
            const eq = pair.indexOf('=');
            const k = decode(eq < 0 ? pair : pair.slice(0, eq));
            const v = eq < 0 ? '' : decode(pair.slice(eq + 1));
            return [k, textValue(k, v, id)];
          });
        params.headers = headers.filter(([n]) => n.toLowerCase() !== 'content-type');
        if ((params.headers as unknown[]).length === 0) delete params.headers;
      } else {
        params.bodyType = 'text';
        params.body = linkInside(r.requestBody, id);
      }
    }
    if (r.status !== undefined) params.expectStatus = r.status >= 200 && r.status < 300 ? '2xx' : String(r.status);

    nodes.push({ id, type: 'http.request', label: `${method} ${shortPath(r.url)}`, params });
    edges.push({ from: prev, to: id });
    prev = id;

    // What this response carries becomes linkable for the next requests.
    const body = tryJson(r.responseBody);
    if (body !== undefined) {
      walk(body, [], (v, path) => {
        if (path.length === 0) return;
        const text = typeof v === 'string' ? v : typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 10_000 ? String(v) : undefined;
        if (text === undefined || text.length < 6) return;
        const p = pathText(path);
        if (p !== undefined) known.set(text, { template: `${id}.body.${p}`, kind: typeof v === 'number' ? 'number' : 'string' });
      });
    }
    for (const [name, value] of r.responseHeaders ?? []) {
      const lower = name.toLowerCase();
      if (BORING_RESPONSE_HEADERS.has(lower) || lower === 'set-cookie' || lower.includes("'")) continue;
      if (value.length >= 8 && (idLike(value) || highEntropy(value))) known.set(value, { template: `${id}.headers['${lower}']`, kind: 'string' });
    }
  }

  /** The request URL with {{env.baseUrl}}, linked path segments and query values, and secret query values. */
  function urlTemplate(url: string, nodeId: string): string {
    let u: { origin: string; pathname: string; search: string };
    try {
      u = new G.URL(url);
    } catch {
      return linkInside(url, nodeId);
    }
    const path = u.pathname
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        const text = decode(seg);
        const k = linkWhole(text, nodeId);
        if (k) return `{{${k.template}${encodeURIComponent(text) !== text ? ' | urlencode' : ''}}}`;
        return linkInside(seg, nodeId);
      })
      .join('/');
    const query = u.search
      .slice(1)
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        const name = decode(pair.slice(0, eq));
        const value = decode(pair.slice(eq + 1));
        const out = textValue(name, value, nodeId, ' | urlencode');
        return `${pair.slice(0, eq)}=${out === value ? pair.slice(eq + 1) : out}`;
      })
      .join('&');
    const base = origin && u.origin === origin ? '{{env.baseUrl}}' : u.origin;
    return `${base}${path}${query ? `?${query}` : ''}`;
  }

  /** A JSON request body with linked values and secret fields; `key` is the name of the field holding `value`. */
  function linkJson(value: unknown, nodeId: string, key: string): unknown {
    if (typeof value === 'string') {
      const k = linkWhole(value, nodeId, isSecretName(key));
      if (k) return `{{${k.template}${k.kind === 'number' ? ' | string' : ''}}}`;
      if (value && key && isSecretName(key)) return `{{env.${secretVar(key, value)}}}`;
      return linkInside(value, nodeId);
    }
    if (typeof value === 'number') {
      const text = String(value);
      const k = Number.isInteger(value) && Math.abs(value) >= 10_000 ? linkWhole(text, nodeId) : undefined;
      if (k) return `{{${k.template}${k.kind === 'string' ? ' | number' : ''}}}`;
      if (key && isSecretName(key)) return `{{env.${secretVar(key, text)} | number}}`;
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => linkJson(v, nodeId, key));
    if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, linkJson(v, nodeId, k)]));
    return value;
  }

  const flow: FlowDoc = layoutFlow({
    format: FLOW_FORMAT,
    version: FLOW_VERSION,
    id: opts.id,
    name: opts.name,
    nodes,
    edges,
    ...(opts.appId ? { target: { appId: opts.appId } } : {}),
  });
  return { flow, envVars, links };
}

function shortPath(url: string): string {
  try {
    const u = new G.URL(url);
    const p = u.pathname.length > 40 ? `…${u.pathname.slice(-39)}` : u.pathname;
    return p || '/';
  } catch {
    return url.slice(0, 40);
  }
}
