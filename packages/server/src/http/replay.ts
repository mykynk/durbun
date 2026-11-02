/**
 * `net.replay`: re-send a captured request from the desktop with fetch (30 s timeout, redirects followed)
 * and record the result on the virtual 'desktop' device (source 'replay'). Network failures are recorded
 * as failed entries (the UI shows them like any other failed request); only unusable input is an error.
 */
import { isTextContentType, type Header, type NetworkDetail, type NetworkEntry, type ReplayOverrides, type WireBody } from '@durbun/protocol';
import type { Hub } from '../types';
import { headerValue } from './har';

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
}

let replayCounter = 0;

export async function replayRequest(
  opts: ReplayOptions,
  id: string,
  overrides?: ReplayOverrides,
): Promise<{ entry: NetworkEntry; warnings: ReplayWarning[] }> {
  const original = opts.hub.getNetworkDetail(id);
  if (!original) throw new ReplayError(`Request ${id} is no longer available`, 'net.unknown');
  const prepared = prepareReplay(original, overrides);
  const timeoutMs = opts.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const { host, path } = splitUrl(prepared.url);
  const requestContentType = headerValue(prepared.headers, 'content-type');

  const detail: NetworkDetail = {
    id: `replay:${++replayCounter}`,
    deviceId: DESKTOP_DEVICE_ID,
    source: 'replay',
    method: prepared.method,
    url: prepared.url,
    host,
    path,
    startTs: Date.now(),
    state: 'pending',
    requestHeaders: prepared.headers,
    hasRequestBody: prepared.body !== undefined && prepared.body.length > 0,
    hasResponseBody: false,
  };
  if (requestContentType) detail.requestContentType = requestContentType;
  if (prepared.body && prepared.body.length > 0) {
    detail.requestBodySize = prepared.body.length;
    const cap = Math.max(opts.maxBodyBytes, 0);
    detail.requestBody = toWireBody(prepared.body.subarray(0, cap), prepared.body.length, requestContentType);
  }

  const t0 = performance.now();
  try {
    const res = await doFetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const tHeaders = performance.now();
    const { data, size } = await readCapped(res, Math.max(opts.maxBodyBytes, 0));
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
    if (size > 0) detail.responseBody = toWireBody(data, size, responseContentType);
  } catch (err) {
    const tEnd = performance.now();
    detail.state = 'failed';
    detail.error = describeFetchError(err, timeoutMs);
    detail.endTs = detail.startTs + (tEnd - t0);
    detail.duration = Math.round((tEnd - t0) * 1000) / 1000;
  }
  const entry = opts.hub.recordDesktopRequest(detail);
  return { entry, warnings: prepared.warnings };
}
