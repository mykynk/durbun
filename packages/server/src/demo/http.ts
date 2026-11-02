/**
 * Simulated HTTP exchanges for the demo apps: emits net.request / net.response / net.error exactly like
 * an SDK would (headers, bodies, timings), honoring the mock rules the session received.
 */
import type { Header, MockRule, SdkNetError, SdkNetRequest, SdkNetResponse, SdkToServer, Timings, WireBody } from '@durbun/protocol';
import { findMockRule, isTextContentType } from '@durbun/protocol';
import type { Rng } from './rng';

export interface SimBody {
  contentType: string;
  text?: string;
  base64?: string;
  /** Real size when the captured data is truncated. */
  size?: number;
  truncated?: boolean;
}

export interface SimResponse {
  status: number;
  statusText?: string;
  headers?: Header[];
  body?: SimBody;
}

export type FailureKind = 'timeout' | 'connection' | 'dns' | 'tls' | 'reset';

export interface HttpPlan {
  method: string;
  url: string;
  headers?: Header[];
  body?: SimBody;
  response?: SimResponse;
  /** Time until the response is complete. */
  latencyMs: number;
  /** Network failure instead of a response. */
  failure?: { kind: FailureKind; afterMs?: number; message?: string };
  /** The client gives up (cancels) after this long when no response arrived yet. */
  cancelAfterMs?: number;
  then?(outcome: HttpOutcome): void;
}

export interface HttpOutcome {
  id: string;
  method: string;
  url: string;
  status?: number;
  error?: string;
  cancelled?: boolean;
  mocked: boolean;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
}

export interface HttpHost {
  readonly bundleId: string;
  /** NetworkEntry.source, e.g. 'dart:io' or 'okhttp'. */
  readonly source: string;
  send(message: SdkToServer): void;
  /** Schedules work tied to the current app process (dropped if it dies). */
  after(ms: number, fn: () => void): void;
  /** Device clock (virtual scheduler time). */
  now(): number;
  mocks(): MockRule[];
  baseHeaders(url: URL): Header[];
  errorText(kind: FailureKind, host: string, url: string): string;
  onStart?(info: { id: string; method: string; url: string }): void;
  onFinish?(outcome: HttpOutcome): void;
}

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function json(value: unknown, contentType = 'application/json; charset=utf-8'): SimBody {
  return { contentType, text: JSON.stringify(value) };
}

export function bodySize(body: SimBody): number {
  if (body.size !== undefined) return body.size;
  if (body.text !== undefined) return Buffer.byteLength(body.text);
  if (body.base64 !== undefined) return Buffer.from(body.base64, 'base64').length;
  return 0;
}

function toWire(body: SimBody): WireBody {
  const size = bodySize(body);
  let wire: WireBody;
  if (body.base64 !== undefined) wire = { encoding: 'base64', data: body.base64, size };
  else if (isTextContentType(body.contentType)) wire = { encoding: 'utf8', data: body.text ?? '', size };
  else wire = { encoding: 'base64', data: Buffer.from(body.text ?? '', 'utf8').toString('base64'), size };
  if (body.truncated) wire.truncated = true;
  return wire;
}

export class HttpSim {
  private seq = 0;
  private readonly warmHosts = new Set<string>();

  constructor(
    private readonly host: HttpHost,
    private readonly rng: Rng,
  ) {}

  /** Starts an exchange; returns the SDK request id. */
  request(plan: HttpPlan): string {
    const id = `${++this.seq}`;
    const start = this.host.now();
    let parsed: URL | undefined;
    try {
      parsed = new URL(plan.url);
    } catch {
      parsed = undefined;
    }
    const headers: Header[] = [...(parsed ? this.host.baseHeaders(parsed) : []), ...(plan.headers ?? [])];
    if (plan.body) {
      if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['content-type', plan.body.contentType]);
      headers.push(['content-length', String(bodySize(plan.body))]);
    }
    const msg: SdkNetRequest = { type: 'net.request', id, ts: start, method: plan.method, url: plan.url, headers, source: this.host.source };
    if (plan.body) msg.body = toWire(plan.body);
    this.host.send(msg);
    this.host.onStart?.({ id, method: plan.method, url: plan.url });

    const rule = findMockRule(this.host.mocks(), plan.method, plan.url, this.host.bundleId);
    if (rule) {
      this.applyMock(id, start, plan, rule);
      return id;
    }
    if (plan.failure) {
      const failure = plan.failure;
      this.host.after(failure.afterMs ?? plan.latencyMs, () =>
        this.fail(id, start, plan, failure.message ?? this.host.errorText(failure.kind, parsed?.hostname ?? '', plan.url), false),
      );
      return id;
    }
    if (plan.cancelAfterMs !== undefined && plan.cancelAfterMs < plan.latencyMs) {
      this.host.after(plan.cancelAfterMs, () => this.fail(id, start, plan, 'Request cancelled by the app (screen closed)', true));
      return id;
    }
    this.host.after(plan.latencyMs, () => this.respond(id, start, plan, plan.response ?? { status: 200 }));
    return id;
  }

  private applyMock(id: string, start: number, plan: HttpPlan, rule: MockRule): void {
    const action = rule.action;
    const mock = { mocked: true as const, mockRuleId: rule.id };
    switch (action.type) {
      case 'respond': {
        const contentType = action.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'application/json; charset=utf-8';
        const body: SimBody | undefined =
          action.body === undefined || action.body === ''
            ? undefined
            : action.bodyEncoding === 'base64'
              ? { contentType, base64: action.body }
              : { contentType, text: action.body };
        const response: SimResponse = { status: action.status, headers: action.headers ?? [], body };
        this.host.after((action.delayMs ?? 0) + this.rng.int(2, 12), () => this.respond(id, start, plan, response, mock));
        return;
      }
      case 'delay':
        this.host.after(Math.max(0, action.delayMs) + plan.latencyMs, () => {
          if (plan.failure) this.fail(id, start, plan, this.host.errorText(plan.failure.kind, hostOf(plan.url), plan.url), false, mock);
          else this.respond(id, start, plan, plan.response ?? { status: 200 }, mock);
        });
        return;
      case 'fail': {
        const message =
          action.error === 'custom'
            ? action.message || 'Request failed (mocked)'
            : action.message || this.host.errorText(action.error, hostOf(plan.url), plan.url);
        this.host.after((action.delayMs ?? 0) + this.rng.int(2, 12), () => this.fail(id, start, plan, message, false, mock));
        return;
      }
    }
  }

  private timings(url: string, total: number): Timings {
    const host = hostOf(url);
    const cold = !this.warmHosts.has(host);
    this.warmHosts.add(host);
    const t: Timings = {};
    let used = 0;
    if (cold) {
      t.dns = this.rng.int(3, 38);
      t.connect = this.rng.int(10, 45);
      if (url.startsWith('https:')) t.tls = this.rng.int(18, 75);
      used = (t.dns ?? 0) + (t.connect ?? 0) + (t.tls ?? 0);
    }
    t.send = Math.round(this.rng.float(0.2, 2.5) * 10) / 10;
    const remaining = Math.max(2, total - used - t.send);
    t.receive = Math.max(1, Math.round(remaining * this.rng.float(0.05, 0.25)));
    t.wait = Math.max(1, Math.round(remaining - t.receive));
    return t;
  }

  private respond(id: string, start: number, plan: HttpPlan, response: SimResponse, mock?: { mocked: true; mockRuleId: string }): void {
    const now = this.host.now();
    const status = response.status;
    const body = response.body;
    const size = body ? bodySize(body) : 0;
    const headers: Header[] = [['date', new Date(now).toUTCString()]];
    if (body) headers.push(['content-type', body.contentType]);
    headers.push(['content-length', String(size)]);
    if (!mock) {
      headers.push(['server', hostOf(plan.url).startsWith('cdn.') ? 'cloudflare' : this.rng.pick(['cloudflare', 'nginx/1.27.2'])]);
      headers.push(['x-request-id', this.rng.uuid()]);
      if (hostOf(plan.url).startsWith('cdn.')) headers.push(['cache-control', 'public, max-age=86400, immutable'], ['cf-cache-status', this.rng.pick(['HIT', 'HIT', 'MISS'])]);
      else headers.push(['cache-control', 'private, no-cache'], ['strict-transport-security', 'max-age=31536000; includeSubDomains']);
    }
    for (const h of response.headers ?? []) {
      const idx = headers.findIndex(([k]) => k.toLowerCase() === h[0].toLowerCase());
      if (idx >= 0) headers[idx] = h;
      else headers.push(h);
    }
    const msg: SdkNetResponse = {
      type: 'net.response',
      id,
      ts: now,
      status,
      statusText: response.statusText ?? STATUS_TEXT[status] ?? '',
      headers,
      protocol: mock ? 'http/1.1' : this.rng.chance(0.85) ? 'h2' : 'http/1.1',
      timings: this.timings(plan.url, now - start),
    };
    if (!mock) msg.remoteAddress = `${this.ipFor(plan.url)}:443`;
    if (body) msg.body = toWire(body);
    if (mock) {
      msg.mocked = true;
      msg.mockRuleId = mock.mockRuleId;
    }
    this.host.send(msg);
    this.finish({ id, method: plan.method, url: plan.url, status, mocked: !!mock, durationMs: now - start, requestBytes: plan.body ? bodySize(plan.body) : 0, responseBytes: size }, plan);
  }

  private fail(id: string, start: number, plan: HttpPlan, error: string, cancelled: boolean, mock?: { mocked: true; mockRuleId: string }): void {
    const now = this.host.now();
    const msg: SdkNetError = { type: 'net.error', id, ts: now, error };
    if (cancelled) msg.cancelled = true;
    if (mock) {
      msg.mocked = true;
      msg.mockRuleId = mock.mockRuleId;
    }
    this.host.send(msg);
    this.finish(
      { id, method: plan.method, url: plan.url, error, cancelled, mocked: !!mock, durationMs: now - start, requestBytes: plan.body ? bodySize(plan.body) : 0, responseBytes: 0 },
      plan,
    );
  }

  private finish(outcome: HttpOutcome, plan: HttpPlan): void {
    this.host.onFinish?.(outcome);
    plan.then?.(outcome);
  }

  private ipFor(url: string): string {
    const host = hostOf(url);
    let h = 0;
    for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
    return host.includes('googleapis') || host.includes('app-measurement') ? `142.250.${h % 200}.${(h >> 8) % 250}` : `104.21.${h % 120}.${(h >> 8) % 250}`;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
