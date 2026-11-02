/**
 * HAR 1.2 export (http://www.softwareishard.com/blog/har-12-spec/) from captured NetworkDetails.
 * Text bodies are embedded as text; binary bodies as base64 (`content.encoding: 'base64'`, and the same
 * convention on postData). Unknown timing phases are -1 (optional ones) or derived so that
 * send + wait + receive matches the measured duration. Dürbün-specific fields live under `_durbun`.
 */
import type { Header, NetworkDetail, WireBody } from '@durbun/protocol';

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarParam {
  name: string;
  value?: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
  params?: HarParam[];
  /** Non-standard but widely understood: the text is base64 (binary request body). */
  encoding?: 'base64';
  comment?: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: 'base64';
  comment?: string;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarNameValue[];
    queryString: HarNameValue[];
    postData?: HarPostData;
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarNameValue[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
    _error?: string;
  };
  cache: Record<string, never>;
  timings: HarTimings;
  serverIPAddress?: string;
  comment?: string;
  _durbun: {
    id: string;
    appId?: string;
    deviceId: string;
    source: string;
    state: NetworkDetail['state'];
    mocked?: boolean;
    mockRuleId?: string;
    graphql?: NetworkDetail['graphql'];
  };
}

export interface Har {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    pages: never[];
    entries: HarEntry[];
  };
}

export function headerValue(headers: Header[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [n, v] of headers ?? []) if (n.toLowerCase() === lower) return v;
  return undefined;
}

function headerValues(headers: Header[] | undefined, name: string): string[] {
  const lower = name.toLowerCase();
  return (headers ?? []).filter(([n]) => n.toLowerCase() === lower).map(([, v]) => v);
}

export function httpVersion(protocol: string | undefined): string {
  if (!protocol) return 'HTTP/1.1';
  const p = protocol.trim().toLowerCase();
  if (p === 'h2' || p === 'h2c' || p === 'http/2' || p === 'http/2.0') return 'HTTP/2';
  if (p === 'h3' || p.startsWith('http/3') || p.startsWith('h3-')) return 'HTTP/3';
  if (p === 'http/1.0') return 'HTTP/1.0';
  if (p === 'http/1.1' || p === 'http/1') return 'HTTP/1.1';
  return protocol;
}

export function parseCookieHeader(value: string): HarCookie[] {
  const out: HarCookie[] = [];
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out.push({ name, value: part.slice(eq + 1).trim() });
  }
  return out;
}

export function parseSetCookie(value: string): HarCookie | undefined {
  const [first, ...attrs] = value.split(';');
  if (!first) return undefined;
  const eq = first.indexOf('=');
  if (eq <= 0) return undefined;
  const cookie: HarCookie = { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'path') cookie.path = val;
    else if (key === 'domain') cookie.domain = val;
    else if (key === 'expires') {
      const t = Date.parse(val);
      if (Number.isFinite(t)) cookie.expires = new Date(t).toISOString();
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
  }
  return cookie.name ? cookie : undefined;
}

function nameValues(headers: Header[] | undefined): HarNameValue[] {
  return (headers ?? []).map(([name, value]) => ({ name, value: String(value) }));
}

function queryOf(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function truncationNote(body: WireBody): string | undefined {
  if (!body.truncated) return undefined;
  const captured = Buffer.byteLength(body.data, body.encoding === 'base64' ? 'base64' : 'utf8');
  return `Truncated by Dürbün: captured ${captured} of ${body.size} bytes`;
}

function postDataOf(d: NetworkDetail): HarPostData | undefined {
  if (!d.requestBody && !d.hasRequestBody) return undefined;
  const mimeType = d.requestContentType ?? headerValue(d.requestHeaders, 'content-type') ?? 'application/octet-stream';
  const body = d.requestBody;
  if (!body) return { mimeType, text: '', comment: d.bodyEvicted ? 'Body was evicted from Dürbün memory' : 'Body was not captured' };
  const post: HarPostData = { mimeType, text: body.data };
  if (body.encoding === 'base64') post.encoding = 'base64';
  else if (mimeType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    post.params = [...new URLSearchParams(body.data)].map(([name, value]) => ({ name, value }));
  }
  const note = truncationNote(body);
  if (note) post.comment = note;
  return post;
}

function contentOf(d: NetworkDetail): HarContent {
  const mimeType = d.responseContentType ?? headerValue(d.responseHeaders, 'content-type') ?? 'x-unknown';
  const body = d.responseBody;
  const content: HarContent = { size: d.responseBodySize ?? body?.size ?? 0, mimeType };
  if (body) {
    content.text = body.data;
    if (body.encoding === 'base64') content.encoding = 'base64';
    const note = truncationNote(body);
    if (note) content.comment = note;
  } else if (d.hasResponseBody) {
    content.comment = d.bodyEvicted ? 'Body was evicted from Dürbün memory' : 'Body was not captured';
  }
  return content;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const known = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round(v) : -1);

export function timingsOf(d: NetworkDetail): { timings: HarTimings; time: number } {
  const t = d.timings ?? {};
  const total =
    typeof d.duration === 'number' && Number.isFinite(d.duration)
      ? Math.max(0, d.duration)
      : d.endTs !== undefined && Number.isFinite(d.endTs)
        ? Math.max(0, d.endTs - d.startTs)
        : undefined;
  const dns = known(t.dns);
  const connect = known(t.connect);
  const ssl = known(t.tls);
  const send = Math.max(0, known(t.send));
  const receive = Math.max(0, known(t.receive));
  let wait = known(t.wait);
  if (wait < 0) {
    const accounted = [dns, connect, send, receive].filter((v) => v > 0).reduce((a, b) => a + b, 0);
    wait = total !== undefined ? round(Math.max(0, total - accounted)) : 0;
  }
  const timings: HarTimings = { blocked: -1, dns, connect, ssl, send, wait, receive };
  // HAR: time = sum of the non-negative phases (ssl is part of connect).
  const time = round([dns, connect, send, wait, receive].filter((v) => v > 0).reduce((a, b) => a + b, 0));
  return { timings, time };
}

function ipOnly(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const a = address.trim();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (v6) return v6[1];
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(a);
  if (v4) return v4[1];
  return a;
}

function sizeFromHeader(headers: Header[] | undefined): number | undefined {
  const v = headerValue(headers, 'content-length');
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function harEntry(d: NetworkDetail): HarEntry {
  const { timings, time } = timingsOf(d);
  const start = Number.isFinite(d.startTs) ? d.startTs : Date.now();
  const failed = d.state === 'failed' || d.state === 'cancelled';
  const version = httpVersion(d.protocol);
  const requestCookies = headerValues(d.requestHeaders, 'cookie').flatMap(parseCookieHeader);
  const responseCookies = headerValues(d.responseHeaders, 'set-cookie')
    .map(parseSetCookie)
    .filter((c): c is HarCookie => c !== undefined);
  const postData = postDataOf(d);

  const entry: HarEntry = {
    startedDateTime: new Date(start).toISOString(),
    time,
    request: {
      method: d.method,
      url: d.url,
      httpVersion: version,
      cookies: requestCookies,
      headers: nameValues(d.requestHeaders),
      queryString: queryOf(d.url),
      headersSize: -1,
      bodySize: d.requestBodySize ?? (d.hasRequestBody ? -1 : 0),
    },
    response: {
      status: d.status ?? 0,
      statusText: d.statusText ?? '',
      httpVersion: version,
      cookies: responseCookies,
      headers: nameValues(d.responseHeaders),
      content: contentOf(d),
      redirectURL: headerValue(d.responseHeaders, 'location') ?? '',
      headersSize: -1,
      bodySize: sizeFromHeader(d.responseHeaders) ?? d.responseBodySize ?? -1,
    },
    cache: {},
    timings,
    _durbun: { id: d.id, deviceId: d.deviceId, source: d.source, state: d.state },
  };
  if (postData) entry.request.postData = postData;
  if (failed) entry.response._error = d.error ?? (d.state === 'cancelled' ? 'Cancelled' : 'Request failed');
  else if (d.state === 'pending') entry.response._error = 'No response yet (request still pending when exported)';
  const ip = ipOnly(d.remoteAddress);
  if (ip) entry.serverIPAddress = ip;
  if (d.appId) entry._durbun.appId = d.appId;
  if (d.mocked) {
    entry._durbun.mocked = true;
    if (d.mockRuleId) entry._durbun.mockRuleId = d.mockRuleId;
    entry.comment = `Mocked by Dürbün${d.mockRuleId ? ` (rule ${d.mockRuleId})` : ''}`;
  }
  if (d.graphql) entry._durbun.graphql = d.graphql;
  return entry;
}

export function buildHar(details: NetworkDetail[], creator: { name: string; version: string }): Har {
  const entries = [...details].sort((a, b) => a.startTs - b.startTs).map(harEntry);
  return { log: { version: '1.2', creator, pages: [], entries } };
}
