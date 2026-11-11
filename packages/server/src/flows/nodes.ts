/**
 * What each node type does when a run reaches it. The engine (engine.ts) owns the graph walk, retries,
 * timeouts and the special nodes (repeat, sub-flows, end); these executors get a StepApi with resolved
 * parameters and the run's target, and return the port to leave through and the output templates read.
 */
import os from 'node:os';
import path from 'node:path';
import {
  evaluateRule,
  evaluateRules,
  getPath,
  isTextContentType,
  parsePath,
  statusMatches,
  urlMatches,
  type AppSession,
  type DeviceActionId,
  type FlowAssertion,
  type FlowConditionRule,
  type FlowEvidence,
  type FlowExtractRule,
  type FlowNode,
  type FlowNodeSpec,
  type FlowPort,
  type FlowRun,
  type Header,
  type I18nParams,
  type LogEntry,
  type LogLevel,
  type MockAction,
  type MockRule,
  type NetworkDetail,
  type NetworkEntry,
  type SdkCapability,
  type TemplateScope,
  type WireBody,
} from '@durbun/protocol';
import { appScope } from '../hub/appScope';
import { sendDesktopRequest } from '../http/replay';
import type { CommandReply } from '../http/commands';
import type { Hub } from '../types';
import { AbortedError, shortHash, shortText, sleep } from './util';

export class StepError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly params?: I18nParams,
    /** What the step produced before failing (an HTTP response with the wrong status): the error path reads it. */
    readonly output?: unknown,
    readonly netId?: string,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

export interface StepResult {
  port?: FlowPort;
  output?: unknown;
  summary?: string;
  code?: string;
  params?: I18nParams;
  netId?: string;
}

export interface FlowServices {
  hub: Hub;
  deviceAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>): Promise<CommandReply>;
  mocks: { get(): MockRule[]; set(rules: MockRule[]): MockRule[] };
  slack?: { status(): Promise<{ configured: boolean }>; send(raw: unknown): Promise<void> };
  maxBodyBytes(): number;
  fetchImpl?: typeof fetch;
  now(): number;
}

export interface StepApi {
  readonly node: FlowNode;
  readonly spec: FlowNodeSpec;
  readonly signal: AbortSignal;
  readonly services: FlowServices;
  readonly run: FlowRun;
  readonly scope: TemplateScope;
  readonly flowRecordRequests: boolean;
  /** Clock and log position of the step that led here, of this step and of the run. */
  readonly since: { previousAt: number; previousLogId: number; stepAt: number; stepLogId: number; runAt: number; runLogId: number };
  /** Raw parameter (catalog default when absent). */
  param(name: string): unknown;
  /** Parameter with its templates resolved. */
  value(name: string): unknown;
  text(name: string): string;
  num(name: string, fallback: number): number;
  bool(name: string, fallback: boolean): boolean;
  /** Resolve templates in any value. */
  resolve(value: unknown): unknown;
  setVar(name: string, value: unknown): void;
  /** The run's device (StepError when there is none). */
  deviceId(): string;
  appId(): string | undefined;
  /** A connected SDK session of the app with this capability, waiting a little for one that is starting. */
  waitSdk(cap: SdkCapability, maxWaitMs?: number): Promise<AppSession | undefined>;
  latestLogId(): number;
  /** Server time a request first arrived (0 = before the engine started). */
  netSeenAt(id: string): number;
  /** Copy a file into the run's evidence folder. */
  addEvidence(file: string, kind: FlowEvidence['kind'], name: string): Promise<FlowEvidence>;
  /** Work done when the run ends (restore mocks, stop a recording). */
  addCleanup(key: string, fn: () => Promise<void>): void;
  /** A recording this run started on the device. */
  recordings: Map<string, Promise<CommandReply>>;
  /** One-line summary of the run so far (Slack). */
  summarySoFar(): string;
  /** The value with the run's secrets masked (what leaves the run: Slack, the Network tab copy). */
  mask<T>(value: T): T;
}

type Executor = (api: StepApi) => Promise<StepResult>;

/* ────────────────────────────── helpers ────────────────────────────── */

const LEVELS: LogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];
const levelAtLeast = (level: LogLevel, min: LogLevel) => LEVELS.indexOf(level) >= LEVELS.indexOf(min);

function toPairs(v: unknown): [string, string][] {
  if (!Array.isArray(v)) return [];
  const out: [string, string][] = [];
  for (const item of v) {
    if (!Array.isArray(item)) continue;
    const name = String(item[0] ?? '').trim();
    if (!name) continue;
    const value = item[1];
    out.push([name, value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)]);
  }
  return out;
}

function headerObject(headers: readonly Header[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers ?? []) {
    const k = name.toLowerCase();
    out[k] = out[k] === undefined ? value : `${out[k]}, ${value}`;
  }
  return out;
}

function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t || !(t.startsWith('{') || t.startsWith('[') || t.startsWith('"') || /^-?\d/.test(t) || t === 'true' || t === 'false' || t === 'null')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Body bytes → text (when it is text) and the parsed JSON (when it is JSON). */
export function decodeBody(buf: Buffer, contentType: string | undefined): { text: string; body: unknown } {
  if (buf.length === 0) return { text: '', body: '' };
  const looksText = isTextContentType(contentType) || (!contentType && !buf.subarray(0, 1024).includes(0));
  if (!looksText) return { text: '', body: `[binary, ${buf.length} bytes]` };
  const text = buf.toString('utf8');
  const json = tryJson(text);
  return { text, body: json === undefined ? text : json };
}

function wireBuffer(b: WireBody | undefined): Buffer {
  if (!b) return Buffer.alloc(0);
  return Buffer.from(b.data, b.encoding === 'base64' ? 'base64' : 'utf8');
}

/** The output of a request the app sent (wait.network) — the same shape as http.request's. */
export function networkOutput(detail: NetworkDetail): Record<string, unknown> {
  const res = decodeBody(wireBuffer(detail.responseBody), detail.responseContentType);
  const req = decodeBody(wireBuffer(detail.requestBody), detail.requestContentType);
  const out: Record<string, unknown> = {
    status: detail.status ?? 0,
    statusText: detail.statusText ?? '',
    ok: detail.status !== undefined && detail.status >= 200 && detail.status < 300,
    headers: headerObject(detail.responseHeaders),
    body: res.body,
    bodyText: res.text,
    durationMs: Math.round(detail.duration ?? 0),
    url: detail.url,
    method: detail.method,
    request: { headers: headerObject(detail.requestHeaders), body: req.body, bodyText: req.text },
  };
  if (detail.error) out.error = detail.error;
  return out;
}

function ms(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

/**
 * The wait / request timeout of a step: its own `timeoutMs` param when set, else the node's `timeoutMs` (a little
 * earlier, so the step's specific error wins over the generic step timeout), else the catalog default.
 */
function ownTimeout(api: StepApi, fallback: number): number {
  const raw = api.node.params?.timeoutMs;
  if ((raw === undefined || raw === '' || raw === null) && api.node.timeoutMs) return Math.max(100, api.node.timeoutMs - 250);
  return Math.max(100, api.num('timeoutMs', fallback));
}

/**
 * Resolve when `find` returns something — now, or after one of the `subscribe` callbacks fires — or reject
 * with a timeout StepError / AbortError.
 */
function waitFor<T>(
  find: () => T | undefined,
  subscribe: (check: () => void) => () => void,
  timeoutMs: number,
  signal: AbortSignal,
  timeout: () => StepError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      fn();
    };
    const check = () => {
      if (done) return;
      try {
        const found = find();
        if (found !== undefined) finish(() => resolve(found));
      } catch (err) {
        finish(() => reject(err));
      }
    };
    const onAbort = () => finish(() => reject(new AbortedError()));
    const timer = setTimeout(() => finish(() => reject(timeout())), Math.max(0, timeoutMs));
    // Entries are updated in place (a pending request completes): a slow poll catches what no batch announced.
    const poll = setInterval(check, 1_000);
    signal.addEventListener('abort', onAbort, { once: true });
    unsubscribe = subscribe(check);
    check();
  });
}

function needSdk(api: StepApi, cap: SdkCapability): Promise<AppSession> {
  return api.waitSdk(cap).then((session) => {
    if (!session) {
      const app = api.appId();
      throw new StepError(
        app ? `${app} is not connected with the Dürbün SDK (${cap}), so this step cannot see it` : `No app with the Dürbün SDK (${cap}) is connected`,
        'flow.sdk.missing',
        { capability: cap, app: app ?? '' },
      );
    }
    return session;
  });
}

function scopeFor(api: StepApi): ReturnType<typeof appScope> | undefined {
  const appId = api.appId();
  const deviceId = api.deviceId();
  if (!appId) return undefined;
  const hub = api.services.hub;
  return appScope({ deviceId, bundleId: appId, apps: hub.getApps(), deviceApps: hub.getDeviceApps(), processes: hub.getProcesses() });
}

/** Logs after `afterId`, in id order, in pages. */
function* logsAfter(hub: Hub, afterId: number): Generator<LogEntry> {
  let cursor = afterId;
  for (;;) {
    const page = hub.getLogs({ afterId: cursor, limit: 2_000 });
    if (page.length === 0) return;
    for (const e of page) yield e;
    cursor = page[page.length - 1]!.id;
    if (page.length < 2_000) return;
  }
}

function sinceChoice(api: StepApi, fallback: string): { at: number; logId: number } {
  const since = String(api.value('since') ?? fallback);
  if (since === 'run') return { at: api.since.runAt, logId: api.since.runLogId };
  if (since === 'now') return { at: api.since.stepAt, logId: api.since.stepLogId };
  return { at: api.since.previousAt, logId: api.since.previousLogId };
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new StepError(`Invalid regular expression: ${(err as Error).message}`, 'flow.regex.invalid', { pattern });
  }
}

/** `match`: regex group 1, else the whole match (the line without a regex); `groups`: every capture group. */
function matchText(text: string, pattern: string, re: RegExp | undefined): { match: string; groups: string[] } | undefined {
  if (!pattern) return { match: text, groups: [text] };
  if (re) {
    const m = re.exec(text);
    if (!m) return undefined;
    // groups[0] is the whole match, groups[1] the first group (a group that did not take part is '').
    return { match: m[1] ?? m[0], groups: [...m].map((g) => g ?? '') };
  }
  const at = text.toLowerCase().indexOf(pattern.toLowerCase());
  return at >= 0 ? { match: text, groups: [text.slice(at, at + pattern.length)] } : undefined;
}

/* ────────────────────────────── triggers & logic ────────────────────────────── */

const triggerStep: Executor = async (api) => {
  const trigger = api.scope.trigger as Record<string, unknown> | undefined;
  return { output: trigger ?? {}, summary: api.run.trigger.detail ?? undefined };
};

const condition: Executor = async (api) => {
  const rules = (api.param('rules') ?? []) as FlowConditionRule[];
  const mode = api.text('mode') === 'any' ? 'any' : 'all';
  const { ok, results } = evaluateRules(rules, mode, api.scope);
  // Only the rules that did not hold explain themselves; a true condition needs no explanation.
  const explain = ok ? '' : results.map((r) => r.explain).filter(Boolean).join(mode === 'all' ? ' and ' : ' or ');
  return { port: ok ? 'true' : 'false', output: { result: ok }, summary: ok ? 'true' : `false: ${explain}`, code: ok ? 'flow.step.conditionTrue' : 'flow.step.conditionFalse', params: { explain } };
};

const setVariables: Executor = async (api) => {
  const list = (api.param('assignments') ?? []) as { name: string; value: unknown }[];
  const out: Record<string, unknown> = {};
  for (const a of list) {
    const v = typeof a.value === 'string' ? api.resolve(a.value) : a.value;
    api.setVar(a.name, v);
    out[a.name] = v;
  }
  const names = Object.keys(out);
  return { output: out, summary: names.map((n) => `${n} = ${shortText(out[n], 60)}`).join(', '), code: 'flow.step.vars', params: { names: names.join(', ') } };
};

const delay: Executor = async (api) => {
  const d = Math.max(0, api.num('durationMs', 1000));
  await sleep(d, api.signal);
  return { summary: `Waited ${ms(d)}`, code: 'flow.step.waited', params: { duration: ms(d) } };
};

const assert: Executor = async (api) => {
  const list = (api.param('assertions') ?? []) as FlowAssertion[];
  const failed: string[] = [];
  const lines: string[] = [];
  let passed = 0;
  for (const a of list) {
    const r = evaluateRule(a, api.scope);
    if (r.ok) passed++;
    else failed.push(a.message ? `${a.message} (${r.explain})` : r.explain);
    lines.push(`${r.ok ? '✓' : '✗'} ${a.message ?? r.explain}`);
  }
  const output = { passed, failed: failed.length, results: lines };
  if (failed.length > 0) {
    throw new StepError(failed.length === 1 ? failed[0]! : `${failed.length} checks failed: ${failed.join('; ')}`, 'flow.assert.failed', { count: failed.length, first: failed[0]! }, output);
  }
  return { output, summary: `${passed} check${passed === 1 ? '' : 's'} passed`, code: 'flow.step.checksPassed', params: { count: passed } };
};

const noErrors: Executor = async (api) => {
  const hub = api.services.hub;
  const deviceId = api.deviceId();
  const scope = scopeFor(api);
  const since = sinceChoice(api, 'run');
  const problems: string[] = [];
  const inScope = (e: LogEntry) => (scope ? scope.logs(e) : e.deviceId === deviceId);
  for (const e of logsAfter(hub, since.logId)) {
    if (!inScope(e)) continue;
    if (e.kind === 'crash' || e.kind === 'anr') problems.push(`${e.kind === 'anr' ? 'ANR' : 'Crash'}: ${shortText(e.message, 160)}`);
    else if (api.bool('errorLogs', false) && (e.level === 'error' || e.level === 'fatal') && e.kind !== 'network') problems.push(`${e.level}: ${shortText(e.message, 160)}`);
    if (problems.length >= 50) break;
  }
  if (api.bool('networkFailures', true)) {
    for (const e of hub.getNetwork()) {
      if (e.deviceId !== deviceId || api.netSeenAt(e.id) < since.at || (scope && !scope.network(e))) continue;
      if (e.mocked) continue; // a failure a mock rule made on purpose is not a problem of the app
      if (e.state === 'failed') problems.push(`${e.method} ${shortText(e.url, 100)} failed: ${e.error ?? ''}`.trim());
      else if ((e.status ?? 0) >= 500) problems.push(`${e.method} ${shortText(e.url, 100)} → ${e.status}`);
      if (problems.length >= 50) break;
    }
  }
  if (problems.length > 0) {
    throw new StepError(`${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems[0]}`, 'flow.noErrors.found', { count: problems.length, first: problems[0]! }, { problems });
  }
  return { output: { problems: [] }, summary: 'No crashes or errors', code: 'flow.step.noErrors' };
};

/* ────────────────────────────── HTTP ────────────────────────────── */

const MAX_FLOW_BODY_BYTES = 10 * 1024 * 1024;
const BODYLESS = new Set(['GET', 'HEAD']);
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function extract(rule: FlowExtractRule, output: Record<string, unknown>): unknown {
  let value: unknown;
  switch (rule.from) {
    case 'status':
      value = output.status;
      break;
    case 'header':
      value = (output.headers as Record<string, string>)[(rule.path ?? '').toLowerCase()];
      break;
    case 'bodyText':
      value = output.bodyText;
      break;
    default:
      value = rule.path ? getPath(output.body, parsePath(rule.path)) : output.body;
  }
  if (rule.regex && value !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(rule.regex);
    } catch (err) {
      throw new StepError(`Invalid regular expression in ${rule.name}: ${(err as Error).message}`, 'flow.regex.invalid', { pattern: rule.regex });
    }
    const m = re.exec(typeof value === 'string' ? value : JSON.stringify(value));
    value = m ? (m[1] ?? m[0]) : undefined;
  }
  return value;
}

const httpRequest: Executor = async (api) => {
  const method = (api.text('method') || 'GET').trim().toUpperCase();
  if (!TOKEN_RE.test(method)) throw new StepError(`Invalid HTTP method "${method}"`, 'flow.http.method', { method });
  const rawUrl = api.text('url').trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new StepError(rawUrl ? `Invalid URL "${rawUrl}"` : 'The URL is empty', 'flow.http.invalidUrl', { url: rawUrl });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new StepError(`Only http and https URLs (got ${url.protocol})`, 'flow.http.invalidUrl', { url: rawUrl });
  for (const [k, v] of toPairs(api.value('query'))) url.searchParams.append(k, v);

  const headers: Header[] = [];
  for (const [k, v] of toPairs(api.value('headers'))) {
    if (!TOKEN_RE.test(k)) throw new StepError(`Invalid header name "${k}"`, 'flow.http.header', { header: k });
    if (/[\r\n\0]/.test(v)) throw new StepError(`The value of ${k} has a line break`, 'flow.http.header', { header: k });
    headers.push([k, v]);
  }
  const hasHeader = (name: string) => headers.some(([k]) => k.toLowerCase() === name);

  let body: Buffer | undefined;
  let bodyType = api.text('bodyType') || 'none';
  // A body without a body type (an AI or a hand-written file left it out) would be dropped: send it as JSON
  // (object or list) or text, and say so on the step.
  let inferred: 'json' | 'text' | undefined;
  const typeGiven = api.node.params?.bodyType !== undefined && api.node.params.bodyType !== '';
  const rawBody = api.node.params?.body;
  if (!typeGiven && !BODYLESS.has(method) && rawBody !== undefined && rawBody !== null && rawBody !== '') {
    const v = api.value('body');
    inferred = v !== null && typeof v === 'object' ? 'json' : 'text';
    bodyType = inferred;
  }
  if (!BODYLESS.has(method)) {
    if (bodyType === 'json') {
      const v = api.value('body');
      const text = typeof v === 'string' ? v : JSON.stringify(v ?? null);
      body = Buffer.from(text, 'utf8');
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/json']);
    } else if (bodyType === 'text') {
      body = Buffer.from(api.text('body'), 'utf8');
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'text/plain; charset=utf-8']);
    } else if (bodyType === 'form') {
      body = Buffer.from(new URLSearchParams(toPairs(api.value('form'))).toString(), 'utf8');
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
  }

  const timeoutMs = ownTimeout(api, 30_000);
  const res = await sendDesktopRequest(
    {
      hub: api.services.hub,
      maxBodyBytes: api.services.maxBodyBytes(),
      timeoutMs,
      fetchImpl: api.services.fetchImpl,
      source: 'flow',
      idPrefix: 'flow',
      redirect: api.bool('followRedirects', true) ? 'follow' : 'manual',
      readLimitBytes: MAX_FLOW_BODY_BYTES,
      signal: api.signal,
      record: api.flowRecordRequests,
      // The Network tab copy can be exported or sent to Slack: it never carries the run's secrets.
      redact: (text) => api.mask(text),
    },
    { method, url: url.toString(), headers, body },
  );
  if (api.signal.aborted) throw new AbortedError();
  const d = res.detail;
  const netId = res.entry?.id;
  if (d.state !== 'complete') {
    throw new StepError(`${method} ${url} failed: ${d.error ?? 'no response'}`, 'flow.http.failed', { method, url: url.toString(), error: d.error ?? '' }, { error: d.error, url: url.toString(), method }, netId);
  }
  const decoded = decodeBody(res.body, d.responseContentType);
  const output: Record<string, unknown> = {
    status: d.status ?? 0,
    statusText: d.statusText ?? '',
    ok: (d.status ?? 0) >= 200 && (d.status ?? 0) < 300,
    headers: headerObject(d.responseHeaders),
    body: decoded.body,
    bodyText: decoded.text,
    durationMs: Math.round(d.duration ?? 0),
    url: res.finalUrl || url.toString(),
    method,
  };
  if (res.size > res.body.length) output.truncated = true;
  const params: Record<string, string | number> = { method, url: url.toString(), status: d.status ?? 0, duration: ms(d.duration ?? 0) };
  let summary = `${method} ${url} → ${d.status} · ${ms(d.duration ?? 0)}`;
  if (inferred) {
    params.bodyType = inferred;
    summary += ` (the body was sent as ${inferred}; set the body type on the step)`;
  }

  const expect = api.text('expectStatus').trim();
  if (expect && !statusMatches(d.status, expect)) {
    throw new StepError(`Expected status ${expect}, got ${d.status} (${method} ${url})`, 'flow.http.status', { ...params, expected: expect }, output, netId);
  }
  const extracted: Record<string, unknown> = {};
  for (const rule of (api.param('extract') ?? []) as FlowExtractRule[]) {
    const v = extract(rule, output);
    if (v === undefined) {
      throw new StepError(
        `Could not read ${rule.name} from the response (${rule.from}${rule.path ? ` ${rule.path}` : ''})`,
        'flow.extract.missing',
        { name: rule.name, from: rule.from, path: rule.path ?? '' },
        output,
        netId,
      );
    }
    api.setVar(rule.name, v);
    extracted[rule.name] = v;
  }
  if (Object.keys(extracted).length) output.extracted = extracted;
  return { output, summary, code: inferred ? 'flow.step.httpBodyInferred' : 'flow.step.http', params, netId };
};

/* ────────────────────────────── device ────────────────────────────── */

async function action(api: StepApi, id: DeviceActionId, params: Record<string, unknown>): Promise<unknown> {
  const reply = await api.services.deviceAction(api.deviceId(), id, params);
  if (api.signal.aborted) throw new AbortedError();
  if (!reply.ok) throw new StepError(reply.error || `${id} failed`, reply.code || 'action.failed', { action: id });
  return reply.data;
}

function appIdParam(api: StepApi): string {
  const appId = api.text('appId').trim() || api.appId();
  if (!appId) throw new StepError('No app id: set one on the step or choose the app of the run', 'flow.app.missing');
  return appId;
}

/** A device action step: its params, then the English summary with the code + params the UI words. */
function simple(
  id: DeviceActionId,
  build: (api: StepApi) => Record<string, unknown>,
  describe: (p: Record<string, unknown>) => { summary: string; code: string; params?: I18nParams },
): Executor {
  return async (api) => {
    const p = build(api);
    await action(api, id, p);
    const d = describe(p);
    return { output: p, summary: d.summary, code: d.code, ...(d.params ? { params: d.params } : {}) };
  };
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

function expandHome(file: string): string {
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

const screenshot: Executor = async (api) => {
  const data = (await action(api, 'screenshot', {})) as { file?: string; width?: number; height?: number } | undefined;
  if (!data?.file) throw new StepError('The device did not return a screenshot', 'flow.screenshot.missing');
  const name = api.text('name').trim() || api.node.label || api.node.id;
  const ev = await api.addEvidence(data.file, 'screenshot', name);
  if (data.width) ev.width = data.width;
  if (data.height) ev.height = data.height;
  return { output: { url: ev.url, name }, summary: `Screenshot "${name}"`, code: 'flow.step.screenshot', params: { name } };
};

const startRecording: Executor = async (api) => {
  const deviceId = api.deviceId();
  if (api.recordings.has(deviceId)) throw new StepError('A recording from this run is already running on the device', 'action.recording.busy');
  const seconds = Math.max(1, Math.min(600, api.num('maxSeconds', 180)));
  const pending = api.services.deviceAction(deviceId, 'screen-record', { durationSec: seconds });
  api.recordings.set(deviceId, pending);
  // Registered before anything can stop the step: a run stopped in the next moments still stops the recording.
  api.addCleanup(`recording:${deviceId}:${api.run.steps.length}`, async () => {
    if (api.recordings.get(deviceId) !== pending) return; // stopped by a step, or another recording now
    const stop = await api.services.deviceAction(deviceId, 'screen-record-stop', {}).catch(() => undefined);
    const reply = stop?.ok ? stop : await pending.catch(() => undefined);
    api.recordings.delete(deviceId);
    const file = (reply?.data as { file?: string } | undefined)?.file;
    if (reply?.ok && file) await api.addEvidence(file, 'video', `${api.node.label || 'recording'}`).catch(() => undefined);
  });
  // The reply comes when the recording ends; an immediate refusal (busy, no tool) arrives within moments.
  const early = await Promise.race([pending, sleep(2_500, api.signal).then(() => undefined)]);
  if (early && !early.ok) {
    if (api.recordings.get(deviceId) === pending) api.recordings.delete(deviceId);
    throw new StepError(early.error || 'The recording could not start', early.code || 'action.failed');
  }
  return { output: { maxSeconds: seconds }, summary: `Recording (up to ${seconds} s)`, code: 'flow.step.recording', params: { seconds } };
};

const stopRecording: Executor = async (api) => {
  const deviceId = api.deviceId();
  const pending = api.recordings.get(deviceId);
  const data = (await action(api, 'screen-record-stop', {})) as { file?: string; durationSec?: number } | undefined;
  api.recordings.delete(deviceId);
  const file = data?.file ?? ((await pending?.catch(() => undefined))?.data as { file?: string } | undefined)?.file;
  if (!file) throw new StepError('The device did not return the recording', 'flow.recording.missing');
  const name = api.text('name').trim() || api.node.label || 'recording';
  const ev = await api.addEvidence(file, 'video', name);
  return { output: { url: ev.url, name, durationSec: data?.durationSec }, summary: `Recording "${name}"${data?.durationSec ? ` · ${Math.round(data.durationSec)} s` : ''}`, code: 'flow.step.recordingSaved', params: { name } };
};

function payloadValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    throw new StepError('The notification payload is not valid JSON', 'flow.param.json', { param: 'payload' });
  }
}

/* ────────────────────────────── waits ────────────────────────────── */

const waitNetwork: Executor = async (api) => {
  await needSdk(api, 'network');
  const hub = api.services.hub;
  const deviceId = api.deviceId();
  const method = (api.text('method') || '*').toUpperCase();
  const pattern = api.text('url');
  const match = api.text('match') || 'contains';
  const status = api.text('status').trim();
  const since = sinceChoice(api, 'previous');
  const timeoutMs = ownTimeout(api, 30_000);
  const scope = scopeFor(api);
  const seen = new Set<string>();
  const ok = (e: NetworkEntry) =>
    e.deviceId === deviceId &&
    e.state !== 'pending' &&
    api.netSeenAt(e.id) >= since.at &&
    (method === '*' || e.method.toUpperCase() === method) &&
    urlMatches(e.url, pattern, match) &&
    (!status || statusMatches(e.status, status)) &&
    (!scope || scope.network(e));
  const found = await waitFor<NetworkEntry>(
    () => {
      for (const e of hub.getNetwork()) {
        // Not announced yet (its batch is on the way), or from before the engine started.
        if (seen.has(e.id) || api.netSeenAt(e.id) === 0) continue;
        if (e.state !== 'pending') seen.add(e.id);
        if (ok(e)) return e;
      }
      return undefined;
    },
    (check) => hub.subscribe((change) => (change.network.length ? check() : undefined)),
    timeoutMs,
    api.signal,
    () => new StepError(`No ${method === '*' ? '' : `${method} `}request matching "${pattern}" within ${ms(timeoutMs)}`, 'flow.wait.network', { url: pattern, timeout: ms(timeoutMs) }),
  );
  const detail = hub.getNetworkDetail(found.id);
  const output = detail ? networkOutput(detail) : { status: found.status, url: found.url, method: found.method };
  const summary = `${found.method} ${found.url} → ${found.state === 'failed' ? 'failed' : found.status}`;
  return { output, summary, netId: found.id, code: 'flow.step.sawRequest', params: { method: found.method, url: found.url, status: found.status ?? 0 } };
};

const waitLog: Executor = async (api) => {
  const hub = api.services.hub;
  const deviceId = api.deviceId();
  const pattern = api.text('text');
  const regex = api.bool('regex', false);
  const minLevel = (api.text('level') || 'verbose') as LogLevel;
  const tag = api.text('tag').trim().toLowerCase();
  const appOnly = api.bool('appOnly', true);
  const since = sinceChoice(api, 'previous');
  const timeoutMs = ownTimeout(api, 30_000);
  const re = regex && pattern ? compileRegex(pattern) : undefined; // an invalid pattern fails before waiting
  let cursor = since.logId;
  let scope = appOnly ? scopeFor(api) : undefined;
  let lastScopeAt = Date.now();
  const found = await waitFor<{ e: LogEntry; m: { match: string; groups: string[] } }>(
    () => {
      if (appOnly && Date.now() - lastScopeAt > 2_000) {
        scope = scopeFor(api); // the app's pids change when it starts
        lastScopeAt = Date.now();
      }
      for (const e of logsAfter(hub, cursor)) {
        cursor = e.id;
        if (scope ? !scope.logs(e) : e.deviceId !== deviceId) continue;
        if (!levelAtLeast(e.level, LEVELS.includes(minLevel) ? minLevel : 'verbose')) continue;
        if (tag && e.tag.toLowerCase() !== tag) continue;
        const m = matchText(e.message, pattern, re);
        if (m !== undefined) return { e, m };
      }
      return undefined;
    },
    (check) => hub.onLogs(() => queueMicrotask(check)),
    timeoutMs,
    api.signal,
    () => new StepError(`No log line matching "${pattern}" within ${ms(timeoutMs)}`, 'flow.wait.log', { text: pattern, timeout: ms(timeoutMs) }),
  );
  const { e, m } = found;
  return {
    output: { message: e.message, match: m.match, groups: m.groups, level: e.level, tag: e.tag, data: e.data },
    summary: shortText(e.message, 160),
    code: 'flow.step.sawLog',
    params: { message: shortText(e.message, 160) },
  };
};

const waitEvent: Executor = async (api) => {
  await needSdk(api, 'events');
  const hub = api.services.hub;
  const deviceId = api.deviceId();
  const name = api.text('name').trim();
  const since = sinceChoice(api, 'previous');
  const timeoutMs = ownTimeout(api, 30_000);
  const appId = api.appId();
  let cursor = since.logId;
  const found = await waitFor<LogEntry>(
    () => {
      for (const e of logsAfter(hub, cursor)) {
        cursor = e.id;
        if (e.kind !== 'event' || e.deviceId !== deviceId || e.message !== name) continue;
        if (appId && e.appId && hub.getApp(e.appId)?.app.id !== appId) continue;
        return e;
      }
      return undefined;
    },
    (check) => hub.onLogs(() => queueMicrotask(check)),
    timeoutMs,
    api.signal,
    () => new StepError(`The app did not send the event "${name}" within ${ms(timeoutMs)}`, 'flow.wait.event', { name, timeout: ms(timeoutMs) }),
  );
  return { output: { name: found.message, props: found.data ?? {} }, summary: `Event ${found.message}`, code: 'flow.step.sawEvent', params: { name: found.message } };
};

/* ────────────────────────────── mocks ────────────────────────────── */

/** Id prefix of the rules a run adds for its own duration; whatever still has it at startup was left by a cut-short run. */
export const TEMP_MOCK_PREFIX = 'flow-';

function findRule(rules: MockRule[], ref: string): MockRule | undefined {
  const r = ref.trim();
  return rules.find((x) => x.id === r) ?? rules.find((x) => (x.name ?? '').trim().toLowerCase() === r.toLowerCase());
}

const mockAdd: Executor = async (api) => {
  const services = api.services;
  const kind = api.text('action') || 'respond';
  const delayMs = Math.max(0, api.num('delayMs', 0));
  let mockAction: MockAction;
  if (kind === 'fail') mockAction = { type: 'fail', error: (api.text('error') || 'timeout') as 'timeout', ...(delayMs ? { delayMs } : {}) };
  else if (kind === 'delay') mockAction = { type: 'delay', delayMs: Math.max(1, delayMs) };
  else {
    const body = api.value('body');
    mockAction = {
      type: 'respond',
      status: Math.round(api.num('status', 200)),
      headers: toPairs(api.value('headers')),
      body: typeof body === 'string' ? body : JSON.stringify(body ?? ''),
      ...(delayMs ? { delayMs } : {}),
    };
  }
  const appId = api.appId();
  // Temporary rules start with "flow-" (removed at the end of the run, and at startup if a run was cut short);
  // kept rules get "flowkeep-" so neither the sweep nor exports treat them as temporary.
  const keep = api.bool('keep', false);
  const id = mockRuleId(keep ? 'flowkeep' : 'flow', api.run.id, api.node.id);
  const rule: MockRule = {
    id,
    enabled: true,
    name: api.text('name').trim() || `${api.run.flowName}: ${api.node.label || api.node.id}`,
    method: (api.text('method') || '*').toUpperCase(),
    url: api.text('url'),
    match: (api.text('match') || 'contains') as MockRule['match'],
    action: mockAction,
    createdAt: services.now(),
  };
  if (api.bool('appOnly', true) && appId) rule.apps = [appId];
  // Flow rules go first: the first matching rule wins and the flow means this one.
  const rules = services.mocks.get().filter((r) => r.id !== id);
  try {
    services.mocks.set([rule, ...rules]);
  } catch (err) {
    throw new StepError(`The mock rule is invalid: ${(err as Error).message}`, 'flow.mock.invalid', { error: (err as Error).message });
  }
  if (!keep) {
    api.addCleanup(`mock:${id}`, async () => {
      services.mocks.set(services.mocks.get().filter((r) => r.id !== id));
    });
  }
  const session = appId ? await api.waitSdk('mocks', 0) : undefined;
  const summary = `${rule.method === '*' ? '' : `${rule.method} `}${rule.url} → ${kind === 'respond' ? (mockAction as { status: number }).status : kind}`;
  const waiting = Boolean(appId) && !session;
  return {
    output: { ruleId: id },
    summary: waiting ? `${summary} (the app is not connected yet; the rule applies once it connects)` : summary,
    code: waiting ? 'flow.step.mockAddedWaiting' : 'flow.step.mockAdded',
    params: { url: rule.url },
  };
};

/** "flow-<run>-<node>" within the 64-character rule id limit; a long node id keeps a hash so two never collide. */
function mockRuleId(prefix: string, runId: string, nodeId: string): string {
  const full = `${prefix}-${runId}-${nodeId}`;
  if (full.length <= 64) return full;
  const hash = shortHash(full);
  return `${full.slice(0, 64 - hash.length - 1)}-${hash}`;
}

const mockToggle: Executor = async (api) => {
  const services = api.services;
  const ref = api.text('rule');
  const enabled = api.bool('enabled', true);
  const rules = services.mocks.get();
  const rule = findRule(rules, ref);
  if (!rule) throw new StepError(`No mock rule "${ref}"`, 'flow.mock.notFound', { rule: ref });
  const before = rule.enabled;
  services.mocks.set(rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
  if (!api.bool('keep', false) && before !== enabled) {
    api.addCleanup(`mockToggle:${rule.id}`, async () => {
      services.mocks.set(services.mocks.get().map((r) => (r.id === rule.id ? { ...r, enabled: before } : r)));
    });
  }
  return { output: { ruleId: rule.id, enabled }, summary: `${rule.name || rule.url}: ${enabled ? 'on' : 'off'}`, code: enabled ? 'flow.step.mockOn' : 'flow.step.mockOff', params: { rule: rule.name || rule.url } };
};

const mockRemove: Executor = async (api) => {
  const services = api.services;
  const ref = api.text('rule');
  const rules = services.mocks.get();
  const rule = findRule(rules, ref);
  if (!rule) throw new StepError(`No mock rule "${ref}"`, 'flow.mock.notFound', { rule: ref });
  services.mocks.set(rules.filter((r) => r.id !== rule.id));
  return { output: { ruleId: rule.id }, summary: `Removed ${rule.name || rule.url}`, code: 'flow.step.mockRemoved', params: { rule: rule.name || rule.url } };
};

/* ────────────────────────────── output ────────────────────────────── */

const marker: Executor = async (api) => {
  const label = api.text('label').trim() || api.run.flowName;
  const deviceId = (() => {
    try {
      return api.deviceId();
    } catch {
      return undefined;
    }
  })();
  api.services.hub.addMarker(label, deviceId);
  return { output: { label }, summary: label, code: 'flow.step.marker', params: { label } };
};

const slack: Executor = async (api) => {
  const s = api.services.slack;
  if (!s) throw new StepError('Slack is not available', 'slack.notConfigured');
  let text = api.text('text').trim();
  if (api.bool('includeSummary', true)) text = `${text}\n${api.summarySoFar()}`.trim();
  if (!text) throw new StepError('The message is empty', 'flow.slack.empty');
  // Secrets stay on the Mac: a template or the summary may have put one into the text.
  text = api.mask(text);
  try {
    await s.send({ text: text.slice(0, 39_000) });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'slack.failed';
    throw new StepError((err as Error).message, code);
  }
  return { output: { text }, summary: 'Sent to Slack', code: 'flow.step.slack' };
};

const note: Executor = async (api) => {
  const text = api.text('text');
  return { output: { text }, summary: shortText(text, 200), code: 'flow.step.note', params: { text: shortText(text, 200) } };
};

/* ────────────────────────────── table ────────────────────────────── */

export const EXECUTORS: Readonly<Record<string, Executor>> = {
  'trigger.manual': triggerStep,
  'trigger.event': triggerStep,
  'http.request': httpRequest,
  'logic.condition': condition,
  'logic.setVariables': setVariables,
  'logic.delay': delay,
  'check.assert': assert,
  'check.noErrors': noErrors,
  'device.openUrl': simple('open-url', (api) => ({ url: api.text('url') }), (p) => ({ summary: `Opened ${str(p.url)}`, code: 'flow.step.openedUrl', params: { url: str(p.url) } })),
  'device.launchApp': simple('app-launch', (api) => ({ appId: appIdParam(api) }), (p) => ({ summary: `Started ${str(p.appId)}`, code: 'flow.step.appLaunched', params: { app: str(p.appId) } })),
  'device.stopApp': simple('app-stop', (api) => ({ appId: appIdParam(api) }), (p) => ({ summary: `Stopped ${str(p.appId)}`, code: 'flow.step.appStopped', params: { app: str(p.appId) } })),
  'device.restartApp': simple('app-restart', (api) => ({ appId: appIdParam(api) }), (p) => ({ summary: `Restarted ${str(p.appId)}`, code: 'flow.step.appRestarted', params: { app: str(p.appId) } })),
  'device.clearData': simple('app-clear-data', (api) => ({ appId: appIdParam(api) }), (p) => ({ summary: `Cleared the data of ${str(p.appId)}`, code: 'flow.step.appDataCleared', params: { app: str(p.appId) } })),
  'device.installApp': simple('app-install', (api) => ({ file: expandHome(api.text('file').trim()) }), (p) => ({ summary: `Installed ${path.basename(str(p.file))}`, code: 'flow.step.appInstalled', params: { file: path.basename(str(p.file)) } })),
  'device.uninstallApp': simple('app-uninstall', (api) => ({ appId: appIdParam(api) }), (p) => ({ summary: `Uninstalled ${str(p.appId)}`, code: 'flow.step.appUninstalled', params: { app: str(p.appId) } })),
  'device.screenshot': screenshot,
  'device.startRecording': startRecording,
  'device.stopRecording': stopRecording,
  'device.appearance': simple('appearance', (api) => ({ mode: api.text('mode') || 'dark' }), (p) => ({ summary: `Appearance: ${str(p.mode)}`, code: 'flow.step.appearance', params: { mode: str(p.mode) } })),
  'device.fontScale': simple('font-scale', (api) => ({ scale: api.num('scale', 1) }), (p) => ({ summary: `Font size ×${str(p.scale)}`, code: 'flow.step.fontScale', params: { scale: str(p.scale) } })),
  'device.location': simple('location', (api) => ({ lat: api.num('lat', 0), lon: api.num('lon', 0) }), (p) => ({ summary: `Location ${str(p.lat)}, ${str(p.lon)}`, code: 'flow.step.location', params: { lat: str(p.lat), lon: str(p.lon) } })),
  'device.pushNotification': simple('push-notification', (api) => ({ appId: appIdParam(api), payload: payloadValue(api.value('payload')) }), (p) => ({ summary: 'Notification sent', code: 'flow.step.pushSent', params: { app: str(p.appId) } })),
  'device.inputText': simple('input-text', (api) => ({ text: api.text('text') }), (p) => ({ summary: `Typed "${shortText(p.text, 40)}"`, code: 'flow.step.textTyped', params: { text: shortText(p.text, 40) } })),
  'device.keyEvent': simple('key-event', (api) => ({ key: api.text('key') || 'back' }), (p) => ({ summary: `Pressed ${str(p.key)}`, code: 'flow.step.keyPressed', params: { key: str(p.key) } })),
  'device.statusBar': simple('status-bar', (api) => ({ mode: api.text('mode') || 'clean' }), (p) => ({ summary: `Status bar: ${str(p.mode)}`, code: 'flow.step.statusBar', params: { mode: str(p.mode) } })),
  'device.animations': simple('animations', (api) => ({ enabled: api.bool('enabled', false) }), (p) => ({ summary: `Animations ${p.enabled ? 'on' : 'off'}`, code: p.enabled ? 'flow.step.animationsOn' : 'flow.step.animationsOff' })),
  'wait.network': waitNetwork,
  'wait.log': waitLog,
  'wait.event': waitEvent,
  'mock.add': mockAdd,
  'mock.toggle': mockToggle,
  'mock.remove': mockRemove,
  'output.marker': marker,
  'output.slack': slack,
  'output.note': note,
};

