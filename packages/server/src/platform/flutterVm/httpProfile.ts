/**
 * dart:io HTTP profiler (`ext.dart.io.getHttpProfile` / `getHttpProfileRequest`) → wire messages.
 *
 * Shapes verified against the installed Dart SDK 3.10 (`lib/_http/http_impl.dart` `_HttpProfileData.toJson`,
 * `lib/io/network_profiling.dart`): all times are µs since epoch on the device clock; `endTime` (top level)
 * appears once the request was fully sent (or failed), `request` only then; `response` appears once the
 * response headers arrived and gets `endTime` when the body was fully read. Bodies are byte arrays and only
 * present in the full (`getHttpProfileRequest`) form. Entries recorded through `package:http_profile`
 * (ids `from_package/<n>`) use the same shape.
 */
import type { Header, SdkNetError, SdkNetRequest, SdkNetResponse, Timings, WireBody } from '@durbun/protocol';
import { isTextContentType } from '@durbun/protocol';
import type { Logger } from '../../types';

export interface HttpConnectionInfoJson {
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
}

export interface HttpProfileEventJson {
  timestamp?: number;
  event?: string;
  arguments?: unknown;
}

export type HeaderMapJson = Record<string, string[] | string | number | undefined>;

export interface HttpProfileRequestDataJson {
  headers?: HeaderMapJson;
  connectionInfo?: HttpConnectionInfoJson | null;
  contentLength?: number;
  cookies?: string[];
  followRedirects?: boolean;
  maxRedirects?: number;
  method?: string;
  persistentConnection?: boolean;
  uri?: string;
  error?: string;
}

export interface HttpProfileResponseDataJson {
  startTime?: number;
  endTime?: number;
  headers?: HeaderMapJson;
  compressionState?: string;
  connectionInfo?: HttpConnectionInfoJson | null;
  contentLength?: number;
  cookies?: string[];
  isRedirect?: boolean;
  persistentConnection?: boolean;
  reasonPhrase?: string;
  redirects?: { location?: string; method?: string; statusCode?: number }[];
  statusCode?: number;
  error?: string;
}

export interface HttpProfileRequestJson {
  type?: string;
  id: string;
  isolateId?: string;
  method?: string;
  uri?: string;
  events?: HttpProfileEventJson[];
  startTime?: number;
  endTime?: number;
  request?: HttpProfileRequestDataJson;
  response?: HttpProfileResponseDataJson;
  requestBody?: number[];
  responseBody?: number[];
}

export interface HttpProfileJson {
  type?: string;
  timestamp?: number;
  requests?: HttpProfileRequestJson[];
}

export interface BodyPolicy {
  captureBodies: boolean;
  maxBodyBytes: number;
}

export type NetMessage = SdkNetRequest | SdkNetResponse | SdkNetError;

/* ───────────────────────────── pure conversion ───────────────────────────── */

export function usToMs(us: number | undefined): number | undefined {
  return typeof us === 'number' && Number.isFinite(us) ? us / 1000 : undefined;
}

export function headerMapToList(map: HeaderMapJson | undefined): Header[] {
  const out: Header[] = [];
  if (!map || typeof map !== 'object') return out;
  for (const [name, values] of Object.entries(map)) {
    if (values === undefined || values === null) continue;
    if (Array.isArray(values)) for (const v of values) out.push([name, String(v)]);
    else out.push([name, String(values)]);
  }
  return out;
}

export function getHeader(map: HeaderMapJson | undefined, name: string): string | undefined {
  if (!map) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(map)) {
    if (key.toLowerCase() !== wanted || values === undefined || values === null) continue;
    return Array.isArray(values) ? (values.length ? String(values[0]) : undefined) : String(values);
  }
  return undefined;
}

export interface RequestPhase {
  requestDone: boolean;
  requestError?: string;
  responseStarted: boolean;
  responseDone: boolean;
  responseError?: string;
  /** Nothing more will happen to this request. */
  terminal: boolean;
}

export function classifyRequest(r: HttpProfileRequestJson): RequestPhase {
  const requestError = typeof r.request?.error === 'string' && r.request.error ? r.request.error : undefined;
  const responseStarted = !!r.response && typeof r.response.statusCode === 'number';
  const responseDone = responseStarted && typeof r.response?.endTime === 'number';
  const responseError = typeof r.response?.error === 'string' && r.response.error ? r.response.error : undefined;
  return {
    requestDone: typeof r.endTime === 'number',
    requestError,
    responseStarted,
    responseDone,
    responseError,
    terminal: !!requestError || responseDone || !!responseError,
  };
}

function declaredLength(contentLength: number | undefined, headers: HeaderMapJson | undefined): number | undefined {
  if (typeof contentLength === 'number' && contentLength >= 0) return contentLength;
  const header = getHeader(headers, 'content-length');
  if (header !== undefined && /^\d+$/.test(header.trim())) return Number(header.trim());
  return undefined;
}

/** Binary bodies (images, archives) are fetched only up to this size: the app serializes them as JSON int arrays. */
export const BINARY_FETCH_LIMIT = 512 * 1024;
const TEXT_FETCH_MIN = 256 * 1024;

export interface BodyPlan {
  fetch: boolean;
  /** Size-only body to report when the body is too large to fetch. */
  placeholder?: WireBody;
}

function bodyPlan(
  contentType: string | undefined,
  length: number | undefined,
  policy: BodyPolicy,
): BodyPlan {
  const text = isTextContentType(contentType);
  if (length === 0) return { fetch: false };
  const limit = text
    ? Math.max(policy.maxBodyBytes * 4, TEXT_FETCH_MIN)
    : Math.min(Math.max(policy.maxBodyBytes, 0), BINARY_FETCH_LIMIT);
  if (length === undefined) return { fetch: text || contentType === undefined };
  if (length <= limit) return { fetch: true };
  return { fetch: false, placeholder: { encoding: text ? 'utf8' : 'base64', data: '', size: length, truncated: true } };
}

export function requestBodyPlan(r: HttpProfileRequestJson, policy: BodyPolicy): BodyPlan {
  if (!policy.captureBodies || !r.request || typeof r.endTime !== 'number' || r.request.error) return { fetch: false };
  const method = (r.method ?? r.request.method ?? '').toUpperCase();
  const length = declaredLength(r.request.contentLength, r.request.headers);
  if ((method === 'GET' || method === 'HEAD') && !length) return { fetch: false };
  return bodyPlan(getHeader(r.request.headers, 'content-type'), length, policy);
}

export function responseBodyPlan(r: HttpProfileRequestJson, policy: BodyPolicy): BodyPlan {
  const resp = r.response;
  if (!policy.captureBodies || !resp || typeof resp.statusCode !== 'number') return { fetch: false };
  const method = (r.method ?? '').toUpperCase();
  if (method === 'HEAD' || resp.statusCode === 101 || resp.statusCode === 204 || resp.statusCode === 304) {
    return { fetch: false };
  }
  return bodyPlan(getHeader(resp.headers, 'content-type'), declaredLength(resp.contentLength, resp.headers), policy);
}

/** UTF-8 without NUL / binary control bytes in the first 2 KiB. */
export function looksLikeText(buf: Uint8Array): boolean {
  const sample = buf.subarray(0, 2048);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  if (control > sample.length / 50) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Largest prefix length ≤ `end` that does not cut a UTF-8 sequence. */
function utf8Boundary(buf: Uint8Array, end: number): number {
  let i = end;
  let continuation = 0;
  while (i > 0 && continuation < 3 && (buf[i - 1]! & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i === 0) return end;
  const lead = buf[i - 1]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return need > continuation + 1 ? i - 1 : end;
}

/** Profile byte array → wire body (text-like → utf8, else base64), truncated to `maxBytes`. */
export function bytesToWireBody(bytes: number[] | undefined, contentType: string | undefined, maxBytes: number): WireBody | undefined {
  if (!Array.isArray(bytes) || bytes.length === 0) return undefined;
  const size = bytes.length;
  const limit = Math.max(0, Math.floor(maxBytes));
  const full = Buffer.from(size > limit ? bytes.slice(0, limit) : bytes);
  const text = contentType ? isTextContentType(contentType) : looksLikeText(full);
  const truncated = size > limit;
  if (text) {
    const end = truncated ? utf8Boundary(full, full.length) : full.length;
    return { encoding: 'utf8', data: full.subarray(0, end).toString('utf8'), size, ...(truncated ? { truncated } : {}) };
  }
  return { encoding: 'base64', data: full.toString('base64'), size, ...(truncated ? { truncated } : {}) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function spanMs(fromUs: number | undefined, toUs: number | undefined): number | undefined {
  if (typeof fromUs !== 'number' || typeof toUs !== 'number' || toUs < fromUs) return undefined;
  return round3((toUs - fromUs) / 1000);
}

/** Phase durations from the profile's timestamps and events ("Connection established", …). */
export function computeTimings(r: HttpProfileRequestJson): Timings | undefined {
  const connected = r.events?.find((e) => e.event === 'Connection established')?.timestamp;
  const t: Timings = {};
  const connect = spanMs(r.startTime, connected);
  const send = spanMs(connected ?? r.startTime, r.endTime);
  const wait = spanMs(r.endTime, r.response?.startTime);
  const receive = spanMs(r.response?.startTime, r.response?.endTime);
  if (connect !== undefined) t.connect = connect;
  if (send !== undefined) t.send = send;
  if (wait !== undefined) t.wait = wait;
  if (receive !== undefined) t.receive = receive;
  return Object.keys(t).length ? t : undefined;
}

function remoteAddressOf(info: HttpConnectionInfoJson | null | undefined): string | undefined {
  if (!info || !info.remoteAddress) return undefined;
  const host = info.remoteAddress.includes(':') ? `[${info.remoteAddress}]` : info.remoteAddress;
  return typeof info.remotePort === 'number' ? `${host}:${info.remotePort}` : host;
}

function withCookieHeader(headers: Header[], cookies: string[] | undefined): Header[] {
  if (!cookies?.length || headers.some(([n]) => n.toLowerCase() === 'cookie')) return headers;
  // Request cookies are serialized by Cookie.toString(): "name=value; Path=/…" — only name=value is sent.
  const pairs = cookies.map((c) => c.split(';')[0]!.trim()).filter(Boolean);
  return pairs.length ? [...headers, ['cookie', pairs.join('; ')]] : headers;
}

export function toNetRequest(r: HttpProfileRequestJson, wireId: string, body?: WireBody): SdkNetRequest {
  const msg: SdkNetRequest = {
    type: 'net.request',
    id: wireId,
    ts: usToMs(r.startTime) ?? Date.now(),
    method: (r.method ?? r.request?.method ?? 'GET').toUpperCase(),
    url: r.uri ?? r.request?.uri ?? '',
    headers: withCookieHeader(headerMapToList(r.request?.headers), r.request?.cookies),
    source: 'vm-service',
  };
  if (body) msg.body = body;
  return msg;
}

export function toNetResponse(r: HttpProfileRequestJson, wireId: string, body?: WireBody): SdkNetResponse {
  const resp = r.response ?? {};
  const msg: SdkNetResponse = {
    type: 'net.response',
    id: wireId,
    ts: usToMs(resp.endTime ?? resp.startTime ?? r.endTime ?? r.startTime) ?? Date.now(),
    status: typeof resp.statusCode === 'number' ? resp.statusCode : 0,
    headers: headerMapToList(resp.headers),
  };
  if (resp.reasonPhrase) msg.statusText = resp.reasonPhrase;
  if (body) msg.body = body;
  // dart:io's HttpClient only speaks HTTP/1.1; package:http_profile clients (cronet, cupertino) may not.
  if (!r.id.startsWith('from_package/')) msg.protocol = 'http/1.1';
  const remote = remoteAddressOf(resp.connectionInfo ?? r.request?.connectionInfo);
  if (remote) msg.remoteAddress = remote;
  const timings = computeTimings(r);
  if (timings) msg.timings = timings;
  return msg;
}

/** dart:io reports these for upgraded (WebSocket) connections; they are not failures. */
const BENIGN_RESPONSE_ERRORS = ['Socket has been detached', 'Connection was upgraded'];

export function toNetError(r: HttpProfileRequestJson, wireId: string): SdkNetError {
  const error = r.request?.error || r.response?.error || 'Request failed';
  const msg: SdkNetError = {
    type: 'net.error',
    id: wireId,
    ts: usToMs(r.response?.endTime ?? r.endTime ?? r.startTime) ?? Date.now(),
    error,
  };
  if (/\babort|cancel/i.test(error)) msg.cancelled = true;
  return msg;
}

/** Messages that finish a request (response and/or error). */
export function terminalMessages(r: HttpProfileRequestJson, wireId: string, responseBody?: WireBody): NetMessage[] {
  const phase = classifyRequest(r);
  if (phase.responseStarted) {
    const out: NetMessage[] = [toNetResponse(r, wireId, responseBody)];
    const err = phase.responseError;
    if (err && r.response?.statusCode !== 101 && !BENIGN_RESPONSE_ERRORS.some((b) => err.includes(b))) {
      out.push(toNetError(r, wireId));
    }
    return out;
  }
  if (phase.requestError || phase.responseError) return [toNetError(r, wireId)];
  return [];
}

/** Wire id: profile ids are VM-wide for dart:io but per isolate for package:http_profile. */
export function wireIdFor(isolateId: string, requestId: string): string {
  const isolateNumber = isolateId.slice(isolateId.lastIndexOf('/') + 1) || isolateId;
  return `${isolateNumber}-${requestId}`;
}

/* ───────────────────────────── tracker ───────────────────────────── */

export interface HttpTrackerDeps {
  getProfile(isolateId: string, updatedSince?: number): Promise<HttpProfileJson>;
  getRequest(isolateId: string, id: string): Promise<HttpProfileRequestJson>;
  clearProfile(isolateId: string): Promise<void>;
  emit(message: NetMessage): void;
  policy(): BodyPolicy;
  /** Desktop clock (ms). */
  now(): number;
  logger: Logger;
}

type Stage = 'new' | 'requested' | 'done';

interface EntryState {
  isolateId: string;
  wireId: string;
  stage: Stage;
  firstSeen: number;
  busy: boolean;
}

interface IsolateHttpState {
  lastTimestamp?: number;
  initialDone: boolean;
  /** Only clear the profile when Dürbün turned profiling on (never wipe another tool's data). */
  clearingAllowed: boolean;
  finishedSinceClear: number;
  bytesSinceClear: number;
  lastClearAt: number;
}

export interface HttpTrackerOptions {
  /** Emit a request without headers when its request phase has not finished after this long. */
  requestGraceMs?: number;
  /** Max requests taken from the backlog on the first poll of an isolate. */
  initialBacklog?: number;
  maxConcurrentFetches?: number;
  maxEntries?: number;
  /** Clear the in-app profile after this many finished requests … */
  clearAfterRequests?: number;
  /** … or this many body bytes since the last clear … */
  clearAfterBytes?: number;
  /** … but not more often than this. */
  minClearIntervalMs?: number;
  /** Unfinished requests older than this do not block clearing (streams, abandoned responses). */
  staleRequestMs?: number;
}

const DEFAULTS: Required<HttpTrackerOptions> = {
  requestGraceMs: 3000,
  initialBacklog: 100,
  maxConcurrentFetches: 4,
  maxEntries: 5000,
  clearAfterRequests: 100,
  clearAfterBytes: 16 * 1024 * 1024,
  minClearIntervalMs: 10_000,
  staleRequestMs: 120_000,
};

/**
 * Turns successive `getHttpProfile(updatedSince)` polls into exactly one net.request and one terminal
 * message per request, fetching bodies of finished requests. State survives reconnects (bind/unbind),
 * so re-attaching to the same VM never duplicates requests.
 */
export class HttpProfileTracker {
  private deps?: HttpTrackerDeps;
  private readonly opts: Required<HttpTrackerOptions>;
  private readonly isolates = new Map<string, IsolateHttpState>();
  private readonly entries = new Map<string, EntryState>();
  private readonly queue: { isolateId: string; run: () => Promise<void> }[] = [];
  private running = 0;
  private readonly runningByIsolate = new Map<string, number>();

  constructor(options: HttpTrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  bind(deps: HttpTrackerDeps): void {
    this.deps = deps;
  }

  unbind(): void {
    this.deps = undefined;
    this.queue.length = 0;
  }

  setClearingAllowed(isolateId: string, allowed: boolean): void {
    this.isolateState(isolateId).clearingAllowed = allowed;
  }

  forgetIsolate(isolateId: string): void {
    this.isolates.delete(isolateId);
    for (const [key, e] of this.entries) if (e.isolateId === isolateId) this.entries.delete(key);
  }

  /** Requests seen but not finished yet (for tests/diagnostics). */
  pendingCount(isolateId?: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.stage !== 'done' && (!isolateId || e.isolateId === isolateId)) n++;
    return n;
  }

  /** Resolves when no body fetch is queued or running. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while ((this.running > 0 || this.queue.length > 0) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private isolateState(isolateId: string): IsolateHttpState {
    let s = this.isolates.get(isolateId);
    if (!s) {
      s = { initialDone: false, clearingAllowed: false, finishedSinceClear: 0, bytesSinceClear: 0, lastClearAt: 0 };
      this.isolates.set(isolateId, s);
    }
    return s;
  }

  /** One poll of an isolate's profile. Rejects when the RPC fails (the caller backs off). */
  async poll(isolateId: string): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    const iso = this.isolateState(isolateId);
    const profile = await deps.getProfile(isolateId, iso.lastTimestamp);
    if (this.deps !== deps) return;
    if (typeof profile?.timestamp === 'number') iso.lastTimestamp = profile.timestamp;
    let requests = (Array.isArray(profile?.requests) ? profile.requests : []).filter(
      (r): r is HttpProfileRequestJson => !!r && typeof r.id === 'string',
    );
    requests.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    if (!iso.initialDone) {
      iso.initialDone = true;
      if (requests.length > this.opts.initialBacklog) {
        const skipped = requests.slice(0, requests.length - this.opts.initialBacklog);
        for (const r of skipped) this.entryFor(isolateId, r).stage = 'done';
        requests = requests.slice(-this.opts.initialBacklog);
        deps.logger.debug(`http profile: skipped ${skipped.length} old requests from the backlog`);
      }
    }
    for (const r of requests) this.process(deps, isolateId, r);
    await this.maybeClear(deps, isolateId, iso);
  }

  private entryFor(isolateId: string, r: HttpProfileRequestJson): EntryState {
    const key = `${isolateId}|${r.id}`;
    let e = this.entries.get(key);
    if (!e) {
      e = { isolateId, wireId: wireIdFor(isolateId, r.id), stage: 'new', firstSeen: this.deps?.now() ?? Date.now(), busy: false };
      this.entries.set(key, e);
      if (this.entries.size > this.opts.maxEntries) this.evict();
    }
    return e;
  }

  private evict(): void {
    // Map iteration follows insertion order: drop the oldest finished entries first.
    for (const [key, e] of this.entries) {
      if (this.entries.size <= this.opts.maxEntries * 0.9) break;
      if (e.stage === 'done' && !e.busy) this.entries.delete(key);
    }
  }

  private process(deps: HttpTrackerDeps, isolateId: string, r: HttpProfileRequestJson): void {
    const e = this.entryFor(isolateId, r);
    if (e.stage === 'done' || e.busy) return;
    const phase = classifyRequest(r);
    const policy = deps.policy();
    if (e.stage === 'new') {
      const ready = phase.requestDone || phase.terminal || deps.now() - e.firstSeen >= this.opts.requestGraceMs;
      if (!ready) return;
      const reqPlan = phase.requestDone ? requestBodyPlan(r, policy) : { fetch: false };
      const respPlan = phase.terminal ? responseBodyPlan(r, policy) : { fetch: false };
      if (reqPlan.fetch || respPlan.fetch) {
        this.fetchThenEmit(isolateId, r, e);
        return;
      }
      deps.emit(toNetRequest(r, e.wireId, reqPlan.placeholder));
      e.stage = 'requested';
      if (phase.terminal) this.finish(deps, isolateId, r, e, respPlan.placeholder);
      return;
    }
    if (e.stage === 'requested' && phase.terminal) {
      const respPlan = responseBodyPlan(r, policy);
      if (respPlan.fetch) {
        this.fetchThenEmit(isolateId, r, e);
        return;
      }
      this.finish(deps, isolateId, r, e, respPlan.placeholder);
    }
  }

  private finish(
    deps: HttpTrackerDeps,
    isolateId: string,
    r: HttpProfileRequestJson,
    e: EntryState,
    body: WireBody | undefined,
  ): void {
    for (const msg of terminalMessages(r, e.wireId, body)) deps.emit(msg);
    e.stage = 'done';
    const iso = this.isolateState(isolateId);
    iso.finishedSinceClear++;
    iso.bytesSinceClear +=
      (body?.size ?? declaredLength(r.response?.contentLength, r.response?.headers) ?? 0) +
      Math.max(0, r.request?.contentLength ?? 0);
  }

  private fetchThenEmit(isolateId: string, ref: HttpProfileRequestJson, e: EntryState): void {
    e.busy = true;
    this.enqueue(isolateId, async () => {
      const deps = this.deps;
      if (!deps) {
        e.busy = false;
        return;
      }
      let full: HttpProfileRequestJson | undefined;
      try {
        full = await deps.getRequest(isolateId, ref.id);
      } catch (err) {
        deps.logger.debug(`http profile: body fetch for ${ref.id} failed: ${String(err)}`);
      }
      if (this.deps !== deps) {
        e.busy = false;
        return;
      }
      const src = full && typeof full.id === 'string' ? full : ref;
      const policy = deps.policy();
      const phase = classifyRequest(src);
      if (e.stage === 'new') {
        const plan = requestBodyPlan(src, policy);
        const body = plan.fetch && full
          ? bytesToWireBody(full.requestBody, getHeader(src.request?.headers, 'content-type'), policy.maxBodyBytes)
          : plan.placeholder;
        deps.emit(toNetRequest(src, e.wireId, body));
        e.stage = 'requested';
      }
      if (phase.terminal) {
        const plan = responseBodyPlan(src, policy);
        const body = plan.fetch && full
          ? bytesToWireBody(full.responseBody, getHeader(src.response?.headers, 'content-type'), policy.maxBodyBytes)
          : plan.placeholder;
        this.finish(deps, isolateId, src, e, body);
      }
      e.busy = false;
    });
  }

  private enqueue(isolateId: string, run: () => Promise<void>): void {
    this.queue.push({ isolateId, run });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.opts.maxConcurrentFetches && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running++;
      this.runningByIsolate.set(task.isolateId, (this.runningByIsolate.get(task.isolateId) ?? 0) + 1);
      task
        .run()
        .catch((err) => this.deps?.logger.debug(`http profile task failed: ${String(err)}`))
        .finally(() => {
          this.running--;
          this.runningByIsolate.set(task.isolateId, (this.runningByIsolate.get(task.isolateId) ?? 1) - 1);
          this.pump();
        });
    }
  }

  private hasBlockingWork(deps: HttpTrackerDeps, isolateId: string): boolean {
    if ((this.runningByIsolate.get(isolateId) ?? 0) > 0) return true;
    if (this.queue.some((t) => t.isolateId === isolateId)) return true;
    const now = deps.now();
    for (const e of this.entries.values()) {
      if (e.isolateId !== isolateId || e.stage === 'done') continue;
      if (e.busy || now - e.firstSeen < this.opts.staleRequestMs) return true;
    }
    return false;
  }

  /**
   * The in-app profiler keeps every request with its bodies forever (as List<int>), which grows the app's
   * heap without bound. Once everything seen is finished and processed, clear it.
   */
  private async maybeClear(deps: HttpTrackerDeps, isolateId: string, iso: IsolateHttpState): Promise<void> {
    if (!iso.clearingAllowed) return;
    if (iso.finishedSinceClear < this.opts.clearAfterRequests && iso.bytesSinceClear < this.opts.clearAfterBytes) return;
    if (deps.now() - iso.lastClearAt < this.opts.minClearIntervalMs) return;
    if (this.hasBlockingWork(deps, isolateId)) return;
    // Catch requests that started since the last poll before wiping the profile.
    const profile = await deps.getProfile(isolateId, iso.lastTimestamp);
    if (this.deps !== deps) return;
    if (typeof profile?.timestamp === 'number') iso.lastTimestamp = profile.timestamp;
    const fresh = Array.isArray(profile?.requests) ? profile.requests : [];
    for (const r of fresh) if (r && typeof r.id === 'string') this.process(deps, isolateId, r);
    if (this.hasBlockingWork(deps, isolateId)) return;
    await deps.clearProfile(isolateId);
    iso.lastClearAt = deps.now();
    iso.finishedSinceClear = 0;
    iso.bytesSinceClear = 0;
    // Cleared requests can never reappear or update (ids are unique), so their entries can go — including
    // stale unfinished ones (long-lived streams), which the profiler no longer reports either.
    for (const [key, e] of this.entries) if (e.isolateId === isolateId && !e.busy) this.entries.delete(key);
    deps.logger.debug(`http profile: cleared the in-app profile of ${isolateId}`);
  }
}
