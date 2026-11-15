/**
 * `net.replay`: re-send a captured request from the desktop with fetch (30 s timeout, redirects followed)
 * and record the result on the virtual 'desktop' device (source 'replay'). Network failures are recorded
 * as failed entries (the UI shows them like any other failed request); only unusable input is an error.
 */
import { isTextContentType, type Header, type NetworkDetail, type NetworkEntry, type ReplayOverrides, type WireBody } from '@durbun/protocol';
import type { Hub } from '../types';
import { headerValue } from './har';
import { createTlsFetch, fetchErrorCode, isTlsCertError, type TlsSettings } from './tlsFetch';
import { assertNotOwnServer, DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_HEADER_VALUE, isThisMacHostname, OwnServerRequestError, type OwnTargetGuard } from './ownTargets';

export const REPLAY_TIMEOUT_MS = 30_000;
export const DESKTOP_DEVICE_ID = 'desktop';

/** Hop-by-hop and computed headers fetch must set itself. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'proxy-connection',
  'http2-settings',
]);
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
/** Redirects followed per request (the fetch standard's limit). */
export const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Headers that describe the body: dropped when a redirect turns the request into a GET (fetch standard). */
const BODY_HEADERS = new Set(['content-type', 'content-encoding', 'content-language', 'content-location']);
/** Credentials that never follow a redirect to another origin (as undici does). */
const CROSS_ORIGIN_DROPPED = new Set(['authorization', 'proxy-authorization', 'cookie']);

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

export interface ReplayWarning {
  code: string;
  message: string;
}

export interface PreparedReplay {
  method: string;
  url: string;
  headers: Header[];
  body?: Buffer;
  warnings: ReplayWarning[];
}

function decodeBody(data: string, encoding: 'utf8' | 'base64' | undefined): Buffer {
  return Buffer.from(data, encoding === 'base64' ? 'base64' : 'utf8');
}

/** Merge overrides into the captured request and validate the result. */
export function prepareReplay(original: NetworkDetail, overrides: ReplayOverrides = {}): PreparedReplay {
  const warnings: ReplayWarning[] = [];
  const method = (overrides.method ?? original.method).trim().toUpperCase();
  if (!TOKEN_RE.test(method) || method === '?') {
    throw new ReplayError(
      method === '?' ? 'The original request was never seen (only its response), so it cannot be replayed' : `Invalid HTTP method "${method}"`,
      'replay.invalidMethod',
    );
  }
  const url = (overrides.url ?? original.url).trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReplayError(`Invalid URL "${url}"`, 'replay.invalidUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ReplayError(`Only http and https requests can be replayed (got ${parsed.protocol})`, 'replay.unsupportedUrl');
  }

  const headers: Header[] = [];
  for (const h of overrides.headers ?? original.requestHeaders ?? []) {
    if (!Array.isArray(h) || h.length < 2) continue;
    const name = String(h[0]).trim();
    const value = String(h[1]);
    if (!name || name.startsWith(':') || !TOKEN_RE.test(name)) continue;
    if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    if (/[\r\n\0]/.test(value)) continue;
    headers.push([name, value]);
  }

  let body: Buffer | undefined;
  if (overrides.body !== undefined) {
    body = decodeBody(overrides.body, overrides.bodyEncoding);
  } else if (original.requestBody) {
    body = decodeBody(original.requestBody.data, original.requestBody.encoding);
    if (original.requestBody.truncated) {
      warnings.push({
        code: 'replay.bodyTruncated',
        message: `The captured request body was truncated (${body.length} of ${original.requestBody.size} bytes); the replay sends the truncated body`,
      });
    }
  } else if (original.hasRequestBody) {
    warnings.push({
      code: 'replay.bodyMissing',
      message: original.bodyEvicted
        ? 'The request body was evicted from memory; the replay is sent without a body'
        : 'The request body was not captured; the replay is sent without a body',
    });
  }
  if (body && BODYLESS_METHODS.has(method)) {
    if (body.length > 0) warnings.push({ code: 'replay.bodyDropped', message: `${method} requests cannot carry a body; it was dropped` });
    body = undefined;
  }
  return { method, url: parsed.toString(), headers, body, warnings };
}

function splitUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + u.search };
  } catch {
    return { host: '', path: url };
  }
}

export function toWireBody(buf: Buffer, size: number, contentType: string | undefined): WireBody {
  const text = isTextContentType(contentType);
  const body: WireBody = { encoding: text ? 'utf8' : 'base64', data: text ? buf.toString('utf8') : buf.toString('base64'), size };
  if (size > buf.length) body.truncated = true;
  return body;
}

async function readCapped(res: Response, cap: number): Promise<{ data: Buffer; size: number }> {
  if (!res.body) return { data: Buffer.alloc(0), size: 0 };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let kept = 0;
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (kept < cap) {
      const take = Math.min(cap - kept, value.byteLength);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, take));
      kept += take;
    }
  }
  return { data: Buffer.concat(chunks, kept), size };
}

/** Human-readable reason for a fetch failure (undici wraps the system error in `cause`). */
export function describeFetchError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `Timed out after ${Math.round(timeoutMs / 1000)} s`;
  const cause = e?.cause;
  if (cause && (cause.code || cause.message)) {
    if (cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN') return `DNS lookup failed: ${cause.message ?? cause.code}`;
    if (cause.code === 'ECONNREFUSED') return `Connection refused: ${cause.message ?? ''}`.trim();
    return cause.code && cause.message && !cause.message.includes(cause.code) ? `${cause.code}: ${cause.message}` : (cause.message ?? cause.code ?? 'fetch failed');
  }
  return e?.message ?? String(err);
}

function responseHeaders(res: Response): Header[] {
  const out: Header[] = [];
  res.headers.forEach((value, name) => {
    if (name !== 'set-cookie') out.push([name, value]);
  });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of cookies) out.push(['set-cookie', c]);
  return out;
}

export interface ReplayOptions {
  hub: Pick<Hub, 'getNetworkDetail' | 'recordDesktopRequest'>;
  /** Response bodies are captured up to this many bytes (settings.maxBodyBytes). */
  maxBodyBytes: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Refuses requests to Dürbün's own ports on this Mac (ownTargets.ts). */
  guard?: OwnTargetGuard;
  /** Certificate settings for HTTPS targets (default: the normal checks). */
  tls?: TlsSettings;
}

/** A request the Mac sends itself (replay, flows). */
export interface DesktopRequest {
  method: string;
  url: string;
  headers: Header[];
  body?: Buffer;
}

export interface DesktopSendOptions {
  hub: Pick<Hub, 'recordDesktopRequest'>;
  /** Bodies are recorded up to this many bytes (settings.maxBodyBytes). */
  maxBodyBytes: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** NetworkEntry.source of the recorded entry. */
  source: string;
  /** Id prefix of the recorded entry ('replay', 'flow'). */
  idPrefix: string;
  redirect?: 'follow' | 'manual';
  /** The caller reads the response body up to this many bytes (default maxBodyBytes); the record keeps maxBodyBytes. */
  readLimitBytes?: number;
  /** Aborts the request (a stopped flow run). */
  signal?: AbortSignal;
  /** false = do not add the request to the network list. */
  record?: boolean;
  /** Rewrites the texts of the recorded copy (URL, headers, text bodies, error): a flow masks its secrets. */
  redact?: (text: string) => string;
  /**
   * Refuses requests to Dürbün's own ports on this Mac, before the first hop and every redirect
   * (OwnServerRequestError, nothing recorded).
   */
  guard?: OwnTargetGuard;
  /** Certificate settings for HTTPS targets: extra trusted CAs, or no verification (default: the normal checks). */
  tls?: TlsSettings;
}

export interface DesktopResponse {
  detail: NetworkDetail;
  /** Recorded entry (absent when `record` is false). */
  entry?: NetworkEntry;
  /** Response body read up to `readLimitBytes`. */
  body: Buffer;
  /** Full response size in bytes. */
  size: number;
  /** URL of the response, after redirects (the request URL when there was none or it failed). */
  finalUrl: string;
  /** Error code of a failed request (ECONNREFUSED, DEPTH_ZERO_SELF_SIGNED_CERT…). */
  errorCode?: string;
}

/** A copy of a detail with every text the user typed or the server sent passed through `redact`. */
function redactDetail(detail: NetworkDetail, redact: (text: string) => string): NetworkDetail {
  const out: NetworkDetail = { ...detail, url: redact(detail.url) };
  const { host, path } = splitUrl(out.url);
  out.host = host;
  out.path = path;
  const headers = (list: Header[]) => list.map(([k, v]) => [k, redact(v)] as Header);
  if (detail.requestHeaders) out.requestHeaders = headers(detail.requestHeaders);
  if (detail.responseHeaders) out.responseHeaders = headers(detail.responseHeaders);
  const body = (b: WireBody | undefined) => (b && b.encoding === 'utf8' ? { ...b, data: redact(b.data) } : b);
  if (detail.requestBody) out.requestBody = body(detail.requestBody);
  if (detail.responseBody) out.responseBody = body(detail.responseBody);
  if (detail.error) out.error = redact(detail.error);
  return out;
}

let replayCounter = 0;

const MARKER = DESKTOP_REQUEST_HEADER.toLowerCase();

/** The headers without any desktop marker (one the caller passed, e.g. from a recorded request, is dropped). */
function withoutMarker(headers: Header[]): Header[] {
  return headers.some(([k]) => k.toLowerCase() === MARKER) ? headers.filter(([k]) => k.toLowerCase() !== MARKER) : headers;
}

/**
 * The headers one hop sends: the desktop marker only when the hop's host is this Mac (a local proxy could forward
 * to Dürbün's port; checkLocalAccess refuses marked requests). Remote targets never see it: the replay stays as
 * close to the original as possible, and their Host header already defeats DNS rebinding.
 */
function hopHeaders(headers: Header[], url: URL): Header[] {
  return isThisMacHostname(url.hostname) ? [...headers, [DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_HEADER_VALUE]] : headers;
}

/**
 * fetch with redirects followed here instead of by undici, so each hop's target is checked (ownTargets.ts) and
 * carries the desktop marker only when it is this Mac (hopHeaders).
 * Follows the fetch standard: at most MAX_REDIRECTS hops; 303 (and 301/302 after a POST) turn into a GET
 * without a body; credentials are dropped when the origin changes.
 */
async function fetchFollowing(
  doFetch: typeof fetch,
  first: URL,
  init: { method: string; headers: Header[]; body?: Buffer; signal: AbortSignal },
  redirect: 'follow' | 'manual',
  guard: OwnTargetGuard | undefined,
): Promise<{ res: Response; url: string }> {
  let url = first;
  let { method, headers, body } = init;
  await assertNotOwnServer(url, guard);
  for (let hop = 0; ; hop++) {
    const res = await doFetch(url.toString(), { method, headers: hopHeaders(headers, url), body, redirect: 'manual', signal: init.signal });
    const location = res.headers.get('location');
    if (redirect === 'manual' || !REDIRECT_STATUSES.has(res.status) || location === null) return { res, url: url.toString() };
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`Invalid redirect location "${location}"`);
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`Redirect to an unsupported URL (${next.protocol})`);
    await assertNotOwnServer(next, guard, 'redirect');
    if (((res.status === 301 || res.status === 302) && method === 'POST') || (res.status === 303 && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      headers = headers.filter(([k]) => !BODY_HEADERS.has(k.toLowerCase()));
    }
    if (next.origin !== url.origin) headers = headers.filter(([k]) => !CROSS_ORIGIN_DROPPED.has(k.toLowerCase()));
    url = next;
  }
}

/**
 * Send a request from the Mac and record it on the virtual 'desktop' device. Network failures come back as a
 * failed detail; a target that is Dürbün's own server throws OwnServerRequestError (nothing sent or recorded).
 */
export async function sendDesktopRequest(opts: DesktopSendOptions, input: DesktopRequest): Promise<DesktopResponse> {
  // The recorded copy shows what the user sent: the marker is added per hop (fetchFollowing), never recorded.
  const req: DesktopRequest = { ...input, headers: withoutMarker(input.headers) };
  const timeoutMs = opts.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const doFetch = opts.tls && (opts.tls.ca || opts.tls.skipVerify) ? createTlsFetch(opts.tls, opts.fetchImpl ?? fetch) : (opts.fetchImpl ?? fetch);
  const { host, path } = splitUrl(req.url);
  const requestContentType = headerValue(req.headers, 'content-type');
  const recordCap = Math.max(opts.maxBodyBytes, 0);
  const readCap = Math.max(opts.readLimitBytes ?? recordCap, recordCap);

  const detail: NetworkDetail = {
    id: `${opts.idPrefix}:${++replayCounter}`,
    deviceId: DESKTOP_DEVICE_ID,
    source: opts.source,
    method: req.method,
    url: req.url,
    host,
    path,
    startTs: Date.now(),
    state: 'pending',
    requestHeaders: req.headers,
    hasRequestBody: req.body !== undefined && req.body.length > 0,
    hasResponseBody: false,
  };
  if (requestContentType) detail.requestContentType = requestContentType;
  if (req.body && req.body.length > 0) {
    detail.requestBodySize = req.body.length;
    detail.requestBody = toWireBody(req.body.subarray(0, recordCap), req.body.length, requestContentType);
  }

  let body: Buffer = Buffer.alloc(0);
  let size = 0;
  let finalUrl = req.url;
  let errorCode: string | undefined;
  const t0 = performance.now();
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const { res, url: reached } = await fetchFollowing(
      doFetch,
      new URL(req.url),
      { method: req.method, headers: req.headers, body: req.body, signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout },
      opts.redirect ?? 'follow',
      opts.guard,
    );
    const tHeaders = performance.now();
    finalUrl = reached;
    const read = await readCapped(res, readCap);
    body = read.data;
    size = read.size;
    const tEnd = performance.now();
    const headers = responseHeaders(res);
    const responseContentType = headerValue(headers, 'content-type');
    detail.state = 'complete';
    detail.status = res.status;
    if (res.statusText) detail.statusText = res.statusText;
    detail.responseHeaders = headers;
    detail.endTs = detail.startTs + (tEnd - t0);
    detail.duration = Math.round((tEnd - t0) * 1000) / 1000;
    detail.timings = { wait: Math.round((tHeaders - t0) * 1000) / 1000, receive: Math.round((tEnd - tHeaders) * 1000) / 1000 };
    if (responseContentType) detail.responseContentType = responseContentType;
    detail.responseBodySize = size;
    detail.hasResponseBody = size > 0;
    if (size > 0) detail.responseBody = toWireBody(body.subarray(0, recordCap), size, responseContentType);
  } catch (err) {
    if (err instanceof OwnServerRequestError) throw err;
    const tEnd = performance.now();
    detail.state = 'failed';
    errorCode = fetchErrorCode(err);
    detail.error = opts.signal?.aborted ? 'Cancelled' : describeFetchError(err, timeoutMs);
    if (opts.signal?.aborted) detail.state = 'cancelled';
    detail.endTs = detail.startTs + (tEnd - t0);
    detail.duration = Math.round((tEnd - t0) * 1000) / 1000;
  }
  const entry = opts.record === false ? undefined : opts.hub.recordDesktopRequest(opts.redact ? redactDetail(detail, opts.redact) : detail);
  const out: DesktopResponse = entry ? { detail, entry, body, size, finalUrl } : { detail, body, size, finalUrl };
  if (errorCode) out.errorCode = errorCode;
  return out;
}

export async function replayRequest(
  opts: ReplayOptions,
  id: string,
  overrides?: ReplayOverrides,
): Promise<{ entry: NetworkEntry; warnings: ReplayWarning[] }> {
  const original = opts.hub.getNetworkDetail(id);
  if (!original) throw new ReplayError(`Request ${id} is no longer available`, 'net.unknown');
  const prepared = prepareReplay(original, overrides);
  // Only on request, per resend: a test server with a self-signed certificate.
  const skipVerify = overrides?.skipTlsVerify === true && prepared.url.startsWith('https:');
  const tls: TlsSettings | undefined = skipVerify ? { ...opts.tls, skipVerify: true } : opts.tls;
  const res = await sendDesktopRequest(
    { hub: opts.hub, maxBodyBytes: opts.maxBodyBytes, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, guard: opts.guard, tls, source: 'replay', idPrefix: 'replay' },
    { method: prepared.method, url: prepared.url, headers: prepared.headers, body: prepared.body },
  );
  const warnings = [...prepared.warnings];
  if (skipVerify) warnings.push({ code: 'replay.tlsUnverified', message: 'Sent without verifying the server certificate' });
  else if (isTlsCertError(res.errorCode)) {
    warnings.push({ code: 'replay.tlsRejected', message: `The server certificate was not accepted (${res.errorCode}); resend without verifying only to a test server you trust` });
  }
  return { entry: res.entry!, warnings };
}
