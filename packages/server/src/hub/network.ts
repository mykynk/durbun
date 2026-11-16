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
  SdkNetSse,
  SdkNetWs,
  StreamInfo,
  StreamKind,
  StreamMessage,
  WireBody,
} from '@durbun/protocol';
import { isTextContentType } from '@durbun/protocol';
import { detectGraphql } from './graphql';
import { capBody, StreamStore } from './streams';

/** Error of the open streams of an app that disconnected (they cannot go on without it). */
export const STREAM_APP_GONE = 'The app disconnected';
/** Open streams the entry limit passes over (the connection the user watches stays) before it takes one anyway. */
const MAX_PROTECTED_OPEN_STREAMS = 100;

function newStream(kind: StreamKind, openTs: number | undefined): StreamInfo {
  const info: StreamInfo = { kind, state: 'open', count: 0, in: 0, out: 0, control: 0, bytesIn: 0, bytesOut: 0, dropped: 0, lastSeq: 0 };
  if (openTs !== undefined) info.openTs = openTs;
  return info;
}

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
  /** Total budget of stream messages in bytes (hub/streams.ts). Absent: a quarter of the body budget. */
  maxStreamBytes?: number;
}

const streamBudget = (l: NetworkLimits): number => l.maxStreamBytes ?? Math.floor(l.maxBodyBytes / 4);

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

/** Body text to search: utf8 bodies as stored, base64 ones only when their content type is text. */
function bodyText(body: WireBody | undefined, contentType: string | undefined): string | undefined {
  if (!body || body.data.length === 0) return undefined;
  if (body.encoding === 'utf8') return body.data;
  if (!isTextContentType(contentType)) return undefined;
  try {
    return Buffer.from(body.data, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Does a text contain `needle`? Case-insensitive search runs a native regex over the text as it is: no
 * lowercased copy of every body on every keystroke.
 */
export function textMatcher(needle: string, caseSensitive: boolean): (text: string | undefined) => boolean {
  if (caseSensitive) return (text) => !!text && text.includes(needle);
  try {
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    return (text) => !!text && re.test(text);
  } catch {
    const lower = needle.toLowerCase();
    return (text) => !!text && text.toLowerCase().includes(lower);
  }
}

/** Entries scanned / body characters read between two yields of searchAsync. */
const SEARCH_SLICE_ENTRIES = 200;
const SEARCH_SLICE_CHARS = 4 * 1024 * 1024;

function abortError(): Error {
  const err = new Error('Search aborted');
  err.name = 'AbortError';
  return err;
}

/** What the limits deleted (NetworkStore `onEvict`). */
export type NetworkEviction = { kind: 'entry'; entry: NetworkEntry } | { kind: 'body'; entry: NetworkEntry | undefined };

export class NetworkStore {
  private readonly entries = new Map<string, NetworkEntry>();
  /** Insertion-ordered: the first record is the oldest body owner (eviction order). */
  private readonly bodies = new Map<string, StoredBodies>();
  private storedBytes = 0;
  /** Change counter: bumped on every notified change; `revisions` holds each entry's latest (resume). */
  private changeSeq = 0;
  private readonly revisions = new Map<string, number>();
  /** Messages of stream entries (created in the constructor: it reports drops into the entries). */
  private readonly streams: StreamStore;

  constructor(
    private limits: NetworkLimits,
    /** Called for every entry state change that subscribers must see. */
    private readonly notify: (entry: NetworkEntry) => void,
    /** Called for every entry or body the limits delete (not for clears and removals). */
    private readonly onEvict?: (eviction: NetworkEviction) => void,
    /** Called once per request a mock rule answered (its response or failure arrived with `mockRuleId`). */
    private readonly onMockHit?: (entry: NetworkEntry) => void,
  ) {
    this.streams = new StreamStore({ maxBytes: streamBudget(limits) }, (id, count) => {
      const entry = this.entries.get(id);
      if (!entry?.stream) return;
      entry.stream = { ...entry.stream, dropped: entry.stream.dropped + count };
      this.onChange(entry);
    });
  }

  /** Bytes held by stream messages. */
  get streamBytes(): number {
    return this.streams.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Change counter after the latest notified change. */
  get seq(): number {
    return this.changeSeq;
  }

  /** Entries changed after `seq` (insertion order). */
  changedSince(seq: number): NetworkEntry[] {
    const out: NetworkEntry[] = [];
    for (const entry of this.entries.values()) if ((this.revisions.get(entry.id) ?? 0) > seq) out.push(entry);
    return out;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  private onChange(entry: NetworkEntry): void {
    this.changeSeq++;
    if (this.entries.get(entry.id) === entry) this.revisions.set(entry.id, this.changeSeq);
    this.notify(entry);
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

  /** The entry with its bodies; `withMessages`: also its stream messages (export, HAR). */
  detail(id: string, withMessages = false): NetworkDetail | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const stored = this.bodies.get(id);
    const detail: NetworkDetail = { ...entry };
    if (stored?.request) detail.requestBody = stored.request;
    if (stored?.response) detail.responseBody = stored.response;
    if (withMessages && this.streams.has(id)) detail.streamMessages = this.streams.all(id);
    return detail;
  }

  /** Stream messages of an entry with seq > `after` (undefined: no such entry). */
  streamPage(id: string, after = 0, limit = 500): { messages: StreamMessage[]; more: boolean; stream?: StreamInfo } | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const page = this.streams.page(id, after, limit);
    return entry.stream ? { ...page, stream: entry.stream } : page;
  }

  setLimits(limits: NetworkLimits): void {
    this.limits = limits;
    this.enforceEntryLimit();
    this.enforceBodyBudget();
    this.streams.setLimits({ maxBytes: streamBudget(limits) });
  }

  /**
   * Applies a `net.ws` / `net.sse` of entry `id` (the handshake request). Undefined when the entry is unknown
   * (never seen, or already deleted): the message is ignored.
   */
  streamMessage(id: string, msg: SdkNetWs | SdkNetSse): NetworkEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const kind: StreamKind = msg.type === 'net.ws' ? 'websocket' : 'sse';
    const info: StreamInfo = entry.stream ? { ...entry.stream } : newStream(kind, entry.state === 'complete' ? entry.endTs : undefined);
    if (msg.type === 'net.sse' && msg.end) {
      if (info.state === 'open') {
        info.state = 'closed';
        info.closedTs = msg.ts;
      }
      entry.stream = info;
      this.onChange(entry);
      return entry;
    }
    const message: StreamMessage =
      msg.type === 'net.ws'
        ? { seq: info.lastSeq + 1, ts: msg.ts, dir: msg.dir, type: msg.opcode, size: msg.size }
        : { seq: info.lastSeq + 1, ts: msg.ts, dir: 'in', type: 'event', size: msg.size ?? msg.body?.size ?? 0 };
    if (msg.body) message.body = capBody(msg.body);
    if (msg.type === 'net.ws') {
      if (msg.closeCode !== undefined) message.closeCode = msg.closeCode;
      if (msg.closeReason) message.closeReason = msg.closeReason;
    } else {
      if (msg.event) message.event = msg.event;
      if (msg.eventId !== undefined) message.eventId = msg.eventId;
      if (msg.retry !== undefined) message.retry = msg.retry;
    }
    info.lastSeq = message.seq;
    info.lastTs = message.ts;
    info.count++;
    if (message.dir === 'in') {
      info.in++;
      info.bytesIn += message.size;
    } else {
      info.out++;
      info.bytesOut += message.size;
    }
    if (message.type === 'ping' || message.type === 'pong') info.control++;
    if (message.type === 'close' && info.state === 'open') {
      info.state = 'closed';
      info.closedTs = message.ts;
      info.closedBy = message.dir;
      if (message.closeCode !== undefined) info.closeCode = message.closeCode;
      if (message.closeReason) info.closeReason = message.closeReason;
    }
    entry.stream = info;
    this.streams.add(id, message);
    this.onChange(entry);
    return entry;
  }

  /** The app is gone: its open streams end (`failed`, STREAM_APP_GONE). */
  endStreams(appId: string, ts: number): NetworkEntry[] {
    const ended: NetworkEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.appId !== appId || entry.stream?.state !== 'open') continue;
      entry.stream = { ...entry.stream, state: 'failed', closedTs: Math.max(ts, entry.stream.lastTs ?? 0), error: STREAM_APP_GONE };
      ended.push(entry);
      this.onChange(entry);
    }
    return ended;
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

  /**
   * `opensStream` false: the sender reports no stream messages (an SDK without the capability, or one that was not
   * asked), so a 101 or a bodiless SSE response is a plain response; a stream still appears with its first message.
   */
  response(id: string, appId: string | undefined, deviceId: string, msg: SdkNetResponse, opensStream = true): NetworkEntry {
    const entry = this.entries.get(id) ?? this.placeholder(id, appId, deviceId, msg.ts);
    const hit = isNewMockHit(entry, msg);
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
    // A 101 is a WebSocket; SSE response headers without a body are a stream that has just opened (an SDK that
    // reports the whole SSE body at the end is a plain response).
    if (!entry.stream) {
      if (!opensStream) {
        // Nothing will follow the handshake: without this the entry would read "open" until the app goes away.
      } else if (msg.status === 101) entry.stream = newStream('websocket', msg.ts);
      else if (!msg.body && entry.responseContentType?.toLowerCase().startsWith('text/event-stream')) entry.stream = newStream('sse', msg.ts);
    } else if (entry.stream.openTs === undefined) {
      entry.stream = { ...entry.stream, openTs: msg.ts };
    }
    cleanUndefined(entry);
    if (msg.body) this.storeBody(id, 'response', msg.body);
    this.onChange(entry);
    if (hit) this.onMockHit?.(entry);
    return entry;
  }

  error(id: string, appId: string | undefined, deviceId: string, msg: SdkNetError): NetworkEntry {
    const existing = this.entries.get(id);
    // An opened stream that broke: the handshake stays complete, the stream failed.
    if (existing?.stream && existing.state === 'complete') {
      const stream = existing.stream;
      if (stream.state === 'open') {
        // Cancelled: the app closed it without a close frame (an SSE reader stopped); else the connection broke.
        existing.stream = msg.cancelled
          ? { ...stream, state: 'closed', closedTs: msg.ts, closedBy: 'out' }
          : { ...stream, state: 'failed', closedTs: msg.ts, error: msg.error };
        this.onChange(existing);
      }
      return existing;
    }
    const entry = existing ?? this.placeholder(id, appId, deviceId, msg.ts);
    const hit = isNewMockHit(entry, msg);
    entry.state = msg.cancelled ? 'cancelled' : 'failed';
    entry.error = msg.error;
    entry.endTs = msg.ts;
    entry.duration = Math.max(0, msg.ts - entry.startTs);
    if (msg.mocked) entry.mocked = true;
    if (msg.mockRuleId) entry.mockRuleId = msg.mockRuleId;
    this.onChange(entry);
    if (hit) this.onMockHit?.(entry);
    return entry;
  }

  /** Notes that a part of the exchange arrived in a message too large to accept (NetworkEntry.tooLarge). */
  markTooLarge(id: string, info: NonNullable<NetworkEntry['tooLarge']>, status?: number): NetworkEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.tooLarge = { ...info };
    if (status !== undefined && entry.status === undefined) entry.status = status;
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
    const { requestBody, responseBody, streamMessages, ...rest } = detail;
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
    if (entry.stream && streamMessages?.length) {
      // Recorded messages keep their seq (gaps = what the recording had dropped); the store's limits apply as
      // they arrive (what does not fit counts as dropped).
      const sorted = [...streamMessages].sort((a, b) => a.seq - b.seq);
      for (const m of sorted) this.streams.add(entry.id, m);
      entry.stream = { ...entry.stream, lastSeq: Math.max(entry.stream.lastSeq, sorted.at(-1)!.seq) };
    }
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
    this.revisions.clear();
    this.bodies.clear();
    this.storedBytes = 0;
    this.streams.clear();
  }

  /** Ids whose URL, headers or text bodies contain `text`. */
  search(text: string, opts: { ids?: string[]; caseSensitive?: boolean } = {}): string[] {
    const candidates = this.searchCandidates(opts.ids);
    if (text.length === 0) return candidates.map((e) => e.id);
    const has = textMatcher(text, !!opts.caseSensitive);
    return candidates.filter((e) => this.entryMatches(e, has)).map((e) => e.id);
  }

  /**
   * search() in slices: yields to the event loop every SEARCH_SLICE_ENTRIES entries or SEARCH_SLICE_CHARS of
   * body text, and rejects with an AbortError once `signal` aborts.
   */
  async searchAsync(text: string, opts: { ids?: string[]; caseSensitive?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
    const { signal } = opts;
    if (signal?.aborted) throw abortError();
    const candidates = this.searchCandidates(opts.ids);
    if (text.length === 0) return candidates.map((e) => e.id);
    const has = textMatcher(text, !!opts.caseSensitive);
    const out: string[] = [];
    let entries = 0;
    let chars = 0;
    for (const e of candidates) {
      if (entries >= SEARCH_SLICE_ENTRIES || chars >= SEARCH_SLICE_CHARS) {
        entries = 0;
        chars = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) throw abortError();
      }
      if (this.entries.get(e.id) !== e) continue; // removed while we yielded
      entries++;
      chars += this.bodies.get(e.id)?.bytes ?? 0;
      if (this.entryMatches(e, has)) out.push(e.id);
    }
    return out;
  }

  private searchCandidates(ids: string[] | undefined): NetworkEntry[] {
    return ids ? ids.map((id) => this.entries.get(id)).filter((e): e is NetworkEntry => !!e) : [...this.entries.values()];
  }

  private entryMatches(e: NetworkEntry, has: (text: string | undefined) => boolean): boolean {
    const headersHave = (headers: Header[] | undefined) => !!headers && headers.some(([k, v]) => has(`${k}: ${v}`));
    if (has(e.url) || has(e.error) || headersHave(e.requestHeaders) || headersHave(e.responseHeaders)) return true;
    const stored = this.bodies.get(e.id);
    if (has(bodyText(stored?.request, e.requestContentType)) || has(bodyText(stored?.response, e.responseContentType))) return true;
    return e.stream !== undefined && this.streams.matches(e.id, has);
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
    this.revisions.delete(id);
    this.streams.forget(id);
    const stored = this.bodies.get(id);
    if (stored) {
      this.storedBytes -= stored.bytes;
      this.bodies.delete(id);
    }
  }

  private enforceEntryLimit(): void {
    const max = Math.max(1, Math.floor(this.limits.maxEntries));
    while (this.entries.size > max) {
      // The oldest entry, passing over open streams (a chat socket opened an hour ago is the one being watched).
      let victim: NetworkEntry | undefined;
      let passed = 0;
      for (const e of this.entries.values()) {
        if (e.stream?.state === 'open' && passed < MAX_PROTECTED_OPEN_STREAMS) {
          passed++;
          continue;
        }
        victim = e;
        break;
      }
      victim ??= this.entries.values().next().value;
      if (!victim) break;
      this.remove(victim.id);
      this.evicted({ kind: 'entry', entry: victim });
    }
  }

  private evicted(eviction: NetworkEviction): void {
    try {
      this.onEvict?.(eviction);
    } catch {
      /* counting must never break the store */
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
      this.evicted({ kind: 'body', entry });
    }
    if (this.bodies.size === 0) this.storedBytes = 0;
  }
}

/** Drops keys whose value is `undefined` (keeps snapshots and JSON compact). */
export function cleanUndefined<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] === undefined) delete obj[key];
  return obj;
}

/** A response / failure marked as answered by a rule the entry was not already counted for. */
function isNewMockHit(entry: NetworkEntry, msg: { mocked?: boolean; mockRuleId?: string }): boolean {
  return msg.mocked === true && typeof msg.mockRuleId === 'string' && msg.mockRuleId !== '' && !(entry.mocked && entry.mockRuleId === msg.mockRuleId);
}
