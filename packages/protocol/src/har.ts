/**
 * HAR 1.2 → Dürbün recording: a `.har` file (browser developer tools, proxies, Dürbün's own HAR export) opens as an
 * imported recording through the same import as a session file. A HAR carries requests only: no log lines, no device,
 * no app, no metrics. The recording gets one virtual device named after the file, so the requests have a place.
 *
 * Pure: no I/O. The importer calls `harToSession` and posts the result like any session file.
 */
import type { DeviceInfo, Header, NetworkDetail, NetworkState, SessionExport, Timings, WireBody } from './index';

/** Device id of the requests inside the converted recording (the import gives it a fresh `import:` id). */
export const HAR_DEVICE_ID = 'har';

export type HarImportErrorCode = 'har.notHar' | 'har.empty';

/** A file that is not a HAR (`har.notHar`) or a HAR without a usable request (`har.empty`). */
export class HarImportError extends Error {
  readonly code: HarImportErrorCode;
  constructor(code: HarImportErrorCode, message: string) {
    super(message);
    this.name = 'HarImportError';
    this.code = code;
  }
}

export interface HarImport {
  session: SessionExport;
  /** Requests in the recording. */
  requests: number;
  /** Entries left out (no URL). */
  skipped: number;
  /** Requests with a captured request or response body. */
  withBodies: number;
  /** The tool that wrote the file (`log.creator.name`), e.g. "WebInspector", "Charles Proxy", "Dürbün". */
  creator?: string;
  /** The file says its secrets were masked (Dürbün's masked HAR). */
  masked: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const nonNeg = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

/** Whether the first bytes of a file look like a HAR (`{"log": {… "entries"`), for picking the importer. */
export function looksLikeHar(head: string): boolean {
  return /^\s*\{\s*"log"\s*:/.test(head) || (/"log"\s*:\s*\{/.test(head) && /"(entries|creator)"\s*:/.test(head));
}

function headersOf(v: unknown): Header[] {
  if (!Array.isArray(v)) return [];
  const out: Header[] = [];
  for (const h of v) {
    if (!isObj(h)) continue;
    const name = str(h.name);
    // HTTP/2 pseudo-headers (":authority", ":path") are not headers of the request a developer replays.
    if (!name || name.startsWith(':')) continue;
    out.push([name, str(h.value) ?? '']);
  }
  return out;
}

function headerOf(headers: Header[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([n]) => n.toLowerCase() === lower)?.[1];
}

function utf8Size(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function bodyOf(text: unknown, encoding: unknown, size?: number): WireBody | undefined {
  const data = str(text);
  if (data === undefined || data === '') return undefined;
  if (encoding === 'base64') return { encoding: 'base64', data, size: size ?? Math.floor((data.replace(/=+$/, '').length * 3) / 4) };
  return { encoding: 'utf8', data, size: size ?? utf8Size(data) };
}

/** Host and path + query of a URL (no `URL` global here: the package also builds for the SDKs' environments). */
function urlParts(url: string): { host: string; path: string } {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#]*)([^#]*)/i.exec(url);
  if (!m) return { host: '', path: url };
  const rest = m[2] ?? '';
  return { host: (m[1] ?? '').toLowerCase(), path: rest.startsWith('/') ? rest : `/${rest}` };
}

function timingsOf(v: unknown): Timings | undefined {
  if (!isObj(v)) return undefined;
  const t: Timings = {};
  const set = (key: keyof Timings, from: unknown) => {
    const n = nonNeg(from);
    if (n !== undefined) t[key] = n;
  };
  set('dns', v.dns);
  set('connect', v.connect);
  set('tls', v.ssl);
  set('send', v.send);
  set('wait', v.wait);
  set('receive', v.receive);
  return Object.keys(t).length ? t : undefined;
}

const STATES: ReadonlySet<string> = new Set(['complete', 'failed', 'cancelled']);

/** One HAR entry as a captured request, or undefined when it has no URL. */
function entryOf(e: Obj, index: number, now: number): NetworkDetail | undefined {
  const req = isObj(e.request) ? e.request : undefined;
  const res = isObj(e.response) ? e.response : {};
  const url = str(req?.url);
  if (!req || !url) return undefined;
  const meta = isObj(e._durbun) ? e._durbun : {};
  const started = Date.parse(str(e.startedDateTime) ?? '');
  const startTs = Number.isFinite(started) ? started : now;
  const duration = nonNeg(e.time);
  const requestHeaders = headersOf(req.headers);
  const responseHeaders = headersOf(res.headers);
  const status = num(res.status);
  const error = str(res._error) ?? str(res._failureText) ?? str(e._error);
  const metaState = str(meta.state);
  const state: NetworkState = error || !status ? (metaState === 'cancelled' ? 'cancelled' : 'failed') : metaState && STATES.has(metaState) ? (metaState as NetworkState) : 'complete';
  const post = isObj(req.postData) ? req.postData : undefined;
  const content = isObj(res.content) ? res.content : undefined;
  const requestBody = post ? bodyOf(post.text, post.encoding, nonNeg(req.bodySize)) : undefined;
  const contentSize = nonNeg(content?.size);
  const responseBody = content ? bodyOf(content.text, content.encoding, contentSize) : undefined;
  const { host, path } = urlParts(url);
  const d: NetworkDetail = {
    id: str(meta.id) ?? `har-${index + 1}`,
    deviceId: HAR_DEVICE_ID,
    source: str(meta.source) ?? 'har',
    method: (str(req.method) || 'GET').toUpperCase(),
    url,
    host,
    path,
    startTs,
    state,
    requestHeaders,
    hasRequestBody: !!requestBody,
    hasResponseBody: !!responseBody,
  };
  if (duration !== undefined) {
    d.duration = duration;
    d.endTs = startTs + duration;
  }
  if (status) d.status = status;
  const statusText = str(res.statusText);
  if (statusText) d.statusText = statusText;
  if (responseHeaders.length || status) d.responseHeaders = responseHeaders;
  if (state !== 'complete') d.error = error ?? (state === 'cancelled' ? 'Cancelled' : 'No response');
  const requestType = str(post?.mimeType) || headerOf(requestHeaders, 'content-type');
  if (requestType) d.requestContentType = requestType;
  const responseType = str(content?.mimeType) || headerOf(responseHeaders, 'content-type');
  if (responseType) d.responseContentType = responseType;
  const reqSize = nonNeg(req.bodySize) ?? requestBody?.size;
  if (reqSize !== undefined) d.requestBodySize = reqSize;
  const resSize = contentSize ?? responseBody?.size;
  if (resSize !== undefined) d.responseBodySize = resSize;
  if (requestBody) d.requestBody = requestBody;
  if (responseBody) d.responseBody = responseBody;
  const timings = timingsOf(e.timings);
  if (timings) d.timings = timings;
  const version = str(res.httpVersion) || str(req.httpVersion);
  if (version && version !== 'unknown') d.protocol = version.toLowerCase();
  const ip = str(e.serverIPAddress);
  if (ip) d.remoteAddress = ip;
  if (meta.mocked === true) {
    d.mocked = true;
    const rule = str(meta.mockRuleId);
    if (rule) d.mockRuleId = rule;
  }
  if (isObj(meta.graphql)) d.graphql = meta.graphql as NetworkDetail['graphql'];
  return d;
}

/**
 * The HAR as a Dürbün recording: its requests on one virtual device named [name] (the file name). Request ids stay
 * unique; entries without a URL are counted in `skipped`. Throws HarImportError for a file that is not a HAR or
 * holds no request.
 */
export function harToSession(har: unknown, opts: { name: string; now?: number }): HarImport {
  const now = opts.now ?? Date.now();
  const log = isObj(har) && isObj(har.log) ? har.log : undefined;
  if (!log || !Array.isArray(log.entries)) throw new HarImportError('har.notHar', 'Not a HAR file (expected log.entries)');
  const network: NetworkDetail[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  log.entries.forEach((raw, i) => {
    const d = isObj(raw) ? entryOf(raw, i, now) : undefined;
    if (!d) {
      skipped++;
      return;
    }
    if (ids.has(d.id)) d.id = `${d.id}-${i + 1}`;
    ids.add(d.id);
    network.push(d);
  });
  if (network.length === 0) throw new HarImportError('har.empty', 'The HAR file holds no request');
  network.sort((a, b) => a.startTs - b.startTs);
  const first = network[0]!.startTs;
  const last = network.reduce((m, d) => Math.max(m, d.endTs ?? d.startTs), first);
  const device: DeviceInfo = {
    id: HAR_DEVICE_ID,
    platform: 'other',
    kind: 'virtual',
    name: opts.name || 'HAR',
    connection: 'unknown',
    state: 'disconnected',
    logs: { status: 'stopped' },
    actions: [],
    firstSeen: first,
    lastSeen: last,
  };
  const creator = isObj(log.creator) ? str(log.creator.name) : undefined;
  const masked = isObj(log._durbun) && log._durbun.masked === true;
  const session: SessionExport = {
    format: 'durbun-session',
    version: 1,
    exportedAt: now,
    server: { version: creator ? `${creator}${isObj(log.creator) && str(log.creator.version) ? ` ${str(log.creator.version)}` : ''}` : 'har' },
    devices: [device],
    apps: [],
    logs: [],
    network,
    ...(masked ? { masked: true } : {}),
  };
  return {
    session,
    requests: network.length,
    skipped,
    withBodies: network.filter((d) => d.hasRequestBody || d.hasResponseBody).length,
    ...(creator ? { creator } : {}),
    masked,
  };
}
