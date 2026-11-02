/**
 * Network entries: merging of request / response / error messages (in any order), derived fields,
 * bounded entry count and a byte budget for bodies (oldest bodies are evicted first).
 *
 * Entries are mutable inside the store, but nested objects/arrays are always replaced (never mutated in
 * place) so a shallow copy is a consistent snapshot.
 */
import type {
  Header,
  NetworkDetail,
  NetworkEntry,
  SdkNetError,
  SdkNetRequest,
  SdkNetResponse,
  WireBody,
} from '@durbun/protocol';
import { isTextContentType } from '@durbun/protocol';
import { detectGraphql } from './graphql';

export const DISCONNECTED_ERROR = 'App disconnected before the response arrived';

interface StoredBodies {
  request?: WireBody;
  response?: WireBody;
  bytes: number;
}

export interface NetworkLimits {
  maxEntries: number;
  /** Total body budget in bytes (approximated by the in-memory string length of `data`). */
  maxBodyBytes: number;
}

export function headerValue(headers: Header[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) if (h[0].toLowerCase() === lower) return h[1];
  return undefined;
}

export function splitUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}` || '/' };
  } catch {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^#]*)/i.exec(url);
    if (m) return { host: m[1] ?? '', path: m[2] || '/' };
    return { host: '', path: url };
  }
}

function contentLength(headers: Header[] | undefined): number | undefined {
  const v = headerValue(headers, 'content-length');
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function bodyBytes(body: WireBody | undefined): number {
  return body ? body.data.length : 0;
}

function hasContent(body: WireBody | undefined): boolean {
  return !!body && (body.size > 0 || body.data.length > 0);
}

function bodyMatches(body: WireBody | undefined, contentType: string | undefined, needle: string, caseSensitive: boolean): boolean {
  if (!body || body.data.length === 0) return false;
  let text: string;
  if (body.encoding === 'utf8') text = body.data;
  else if (isTextContentType(contentType)) {
    try {
      text = Buffer.from(body.data, 'base64').toString('utf8');
    } catch {
      return false;
    }
  } else return false;
  return caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle);
}

export class NetworkStore {
  private readonly entries = new Map<string, NetworkEntry>();
  /** Insertion-ordered: the first record is the oldest body owner (eviction order). */
  private readonly bodies = new Map<string, StoredBodies>();
  private storedBytes = 0;

  constructor(
    private limits: NetworkLimits,
    /** Called for every entry state change that subscribers must see. */
    private readonly onChange: (entry: NetworkEntry) => void,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get bodyBytes(): number {
    return this.storedBytes;
  }

  get(id: string): NetworkEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): NetworkEntry[] {
    return [...this.entries.values()];
  }

  values(): IterableIterator<NetworkEntry> {
    return this.entries.values();
  }

  detail(id: string): NetworkDetail | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const stored = this.bodies.get(id);
    const detail: NetworkDetail = { ...entry };
    if (stored?.request) detail.requestBody = stored.request;
    if (stored?.response) detail.responseBody = stored.response;
    return detail;
  }

  setLimits(limits: NetworkLimits): void {
    this.limits = limits;
    this.enforceEntryLimit();
    this.enforceBodyBudget();
  }

  /**
   * Applies a `net.request`. Returns the entry and whether this was the first request message for it
   * (callers emit the network log row only then).
   */
  request(id: string, appId: string | undefined, deviceId: string, msg: SdkNetRequest): { entry: NetworkEntry; first: boolean } {
    const existing = this.entries.get(id);
    const { host, path } = splitUrl(msg.url);
    const requestContentType = headerValue(msg.headers, 'content-type');
    const graphql = detectGraphql(msg.method, msg.url, requestContentType, msg.body);
    const requestBodySize = msg.body ? msg.body.size : contentLength(msg.headers);
    if (existing) {
      const first = existing.method === '?';
      existing.method = msg.method;
      existing.url = msg.url;
      existing.host = host;
      existing.path = path;
      existing.source = msg.source;
      existing.startTs = msg.ts;
      existing.requestHeaders = msg.headers;
      existing.requestContentType = requestContentType;
      existing.requestBodySize = requestBodySize;
      existing.hasRequestBody = hasContent(msg.body);
      if (graphql) existing.graphql = graphql;
      else delete existing.graphql;
      if (existing.endTs !== undefined) existing.duration = Math.max(0, existing.endTs - existing.startTs);
      cleanUndefined(existing);
      if (msg.body) this.storeBody(id, 'request', msg.body);
      this.onChange(existing);
      return { entry: existing, first };
    }
    const entry: NetworkEntry = {
      id,
      appId,
      deviceId,
      source: msg.source,
      method: msg.method,
      url: msg.url,
      host,
      path,
      startTs: msg.ts,
      state: 'pending',
      requestHeaders: msg.headers,
      requestBodySize,
      requestContentType,
      hasRequestBody: hasContent(msg.body),
      hasResponseBody: false,
      graphql,
    };
    cleanUndefined(entry);
    this.insert(entry);
    if (msg.body) this.storeBody(id, 'request', msg.body);
    this.onChange(entry);
    return { entry, first: true };
  }

  response(id: string, appId: string | undefined, deviceId: string, msg: SdkNetResponse): NetworkEntry {
    const entry = this.entries.get(id) ?? this.placeholder(id, appId, deviceId, msg.ts);
    entry.state = 'complete';
    entry.status = msg.status;
    entry.statusText = msg.statusText;
    entry.responseHeaders = msg.headers;
    entry.responseContentType = headerValue(msg.headers, 'content-type');
    entry.responseBodySize = msg.body ? msg.body.size : contentLength(msg.headers);
    entry.hasResponseBody = hasContent(msg.body);
    entry.endTs = msg.ts;
    entry.duration = Math.max(0, msg.ts - entry.startTs);
    entry.protocol = msg.protocol;
    entry.remoteAddress = msg.remoteAddress;
    entry.timings = msg.timings;
    entry.mocked = msg.mocked || undefined;
    entry.mockRuleId = msg.mockRuleId;
    delete entry.error;
    cleanUndefined(entry);
    if (msg.body) this.storeBody(id, 'response', msg.body);
    this.onChange(entry);
    return entry;
  }

  error(id: string, appId: string | undefined, deviceId: string, msg: SdkNetError): NetworkEntry {
    const entry = this.entries.get(id) ?? this.placeholder(id, appId, deviceId, msg.ts);
    entry.state = msg.cancelled ? 'cancelled' : 'failed';
    entry.error = msg.error;
    entry.endTs = msg.ts;
    entry.duration = Math.max(0, msg.ts - entry.startTs);
    if (msg.mocked) entry.mocked = true;
    if (msg.mockRuleId) entry.mockRuleId = msg.mockRuleId;
    this.onChange(entry);
    return entry;
  }

  /** Pending requests of an app become failed (a later response still upgrades them). */
  failPending(appId: string, error: string, endTs: number | undefined): NetworkEntry[] {
    const failed: NetworkEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.appId !== appId || entry.state !== 'pending') continue;
      entry.state = 'failed';
      entry.error = error;
      if (endTs !== undefined && endTs >= entry.startTs) {
        entry.endTs = endTs;
        entry.duration = endTs - entry.startTs;
      }
      failed.push(entry);
      this.onChange(entry);
    }
    return failed;
  }

  /** Inserts a fully-formed entry (desktop replay, import) with its bodies. */
  record(detail: NetworkDetail): NetworkEntry {
    const { requestBody, responseBody, ...rest } = detail;
    const entry: NetworkEntry = { ...rest, requestHeaders: Array.isArray(rest.requestHeaders) ? rest.requestHeaders : [] };
    const { host, path } = rest.host || rest.path ? { host: rest.host, path: rest.path } : splitUrl(rest.url);
    entry.host = host ?? '';
    entry.path = path ?? '';
    entry.requestContentType ??= headerValue(entry.requestHeaders, 'content-type');
    entry.responseContentType ??= headerValue(entry.responseHeaders, 'content-type');
    entry.requestBodySize ??= requestBody ? requestBody.size : contentLength(entry.requestHeaders);
    entry.responseBodySize ??= responseBody ? responseBody.size : contentLength(entry.responseHeaders);
    entry.hasRequestBody = entry.hasRequestBody || hasContent(requestBody);
    entry.hasResponseBody = entry.hasResponseBody || hasContent(responseBody);
    if (entry.endTs !== undefined && entry.duration === undefined) entry.duration = Math.max(0, entry.endTs - entry.startTs);
    entry.graphql ??= detectGraphql(entry.method, entry.url, entry.requestContentType, requestBody);
    // Keep an imported "evicted" flag only when the bodies really are missing.
    if (requestBody || responseBody || !entry.bodyEvicted) delete entry.bodyEvicted;
    cleanUndefined(entry);
    this.remove(entry.id);
    this.insert(entry);
    if (requestBody) this.storeBody(entry.id, 'request', requestBody);
    if (responseBody) this.storeBody(entry.id, 'response', responseBody);
    this.onChange(entry);
    return entry;
  }

  /** Removes entries (and their bodies) matching the predicate; returns the number removed. */
  removeWhere(pred: (entry: NetworkEntry) => boolean): number {
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (!pred(entry)) continue;
      this.remove(entry.id);
      removed++;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.bodies.clear();
    this.storedBytes = 0;
  }

  /** Ids whose URL, headers or text bodies contain `text`. */
  search(text: string, opts: { ids?: string[]; caseSensitive?: boolean } = {}): string[] {
    const caseSensitive = !!opts.caseSensitive;
    const candidates = opts.ids ? opts.ids.map((id) => this.entries.get(id)).filter((e): e is NetworkEntry => !!e) : [...this.entries.values()];
    if (text.length === 0) return candidates.map((e) => e.id);
    const needle = caseSensitive ? text : text.toLowerCase();
    const has = (s: string | undefined) => !!s && (caseSensitive ? s.includes(needle) : s.toLowerCase().includes(needle));
    const headersHave = (headers: Header[] | undefined) => !!headers && headers.some(([k, v]) => has(`${k}: ${v}`));
    const out: string[] = [];
    for (const e of candidates) {
      const stored = this.bodies.get(e.id);
      if (
        has(e.url) ||
        has(e.error) ||
        headersHave(e.requestHeaders) ||
        headersHave(e.responseHeaders) ||
        bodyMatches(stored?.request, e.requestContentType, needle, caseSensitive) ||
        bodyMatches(stored?.response, e.responseContentType, needle, caseSensitive)
      ) {
        out.push(e.id);
      }
    }
    return out;
  }

  private placeholder(id: string, appId: string | undefined, deviceId: string, ts: number): NetworkEntry {
    const entry: NetworkEntry = {
      id,
      deviceId,
      source: 'unknown',
      method: '?',
      url: '',
      host: '',
      path: '',
      startTs: ts,
      state: 'pending',
      requestHeaders: [],
      hasRequestBody: false,
      hasResponseBody: false,
    };
    if (appId !== undefined) entry.appId = appId;
    this.insert(entry);
    return entry;
  }

  private insert(entry: NetworkEntry): void {
    this.entries.set(entry.id, entry);
    this.enforceEntryLimit();
  }

  private remove(id: string): void {
    if (!this.entries.delete(id)) return;
    const stored = this.bodies.get(id);
    if (stored) {
      this.storedBytes -= stored.bytes;
      this.bodies.delete(id);
    }
  }

  private enforceEntryLimit(): void {
    const max = Math.max(1, Math.floor(this.limits.maxEntries));
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
  }

  private storeBody(id: string, which: 'request' | 'response', body: WireBody): void {
    if (!this.entries.has(id)) return;
    let stored = this.bodies.get(id);
    if (!stored) {
      stored = { bytes: 0 };
      this.bodies.set(id, stored);
    }
    const previous = stored[which];
    const delta = bodyBytes(body) - bodyBytes(previous);
    stored[which] = body;
    stored.bytes += delta;
    this.storedBytes += delta;
    this.enforceBodyBudget();
  }

  private enforceBodyBudget(): void {
    const max = Math.max(0, this.limits.maxBodyBytes);
    while (this.storedBytes > max && this.bodies.size > 0) {
      const oldest = this.bodies.entries().next();
      if (oldest.done) break;
      const [id, stored] = oldest.value;
      this.bodies.delete(id);
      this.storedBytes -= stored.bytes;
      const entry = this.entries.get(id);
      if (entry) {
        entry.bodyEvicted = true;
        this.onChange(entry);
      }
    }
    if (this.bodies.size === 0) this.storedBytes = 0;
  }
}

/** Drops keys whose value is `undefined` (keeps snapshots and JSON compact). */
export function cleanUndefined<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] === undefined) delete obj[key];
  return obj;
}
