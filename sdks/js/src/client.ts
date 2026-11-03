/**
 * The running SDK: owns the connection, the outgoing buffer, the patches and the server state
 * (config, mock rules, app id). Every public entry point swallows its own errors — the SDK must never
 * crash or noticeably slow down the host app.
 */
import { appActions, builtInActions, type ActionHandler } from './actions.js';
import { utf8Length, type BodyConfig } from './body.js';
import { Connection, DEFAULT_TIMING, type ConnectionTiming, type WebSocketConstructor } from './connection.js';
import { installConsolePatch, quietly, type ConsoleMethod } from './console.js';
import { describeEnvironment, detectRuntime, devServerOrigin, type EnvironmentInfo, type Runtime } from './env.js';
import { installErrorHandlers, type ErrorReport } from './errors.js';
import { installFetchPatch } from './fetch.js';
import { formatArgs } from './format.js';
import { errorInfo, isErrorLike, previewValue, toJsonSafe } from './jsonSafe.js';
import { MetricsSampler, metricsSupported } from './metrics.js';
import { findMockRule, normalizeRules } from './mocks.js';
import type { NetworkHost } from './network.js';
import { resolveOptions, type DurbunOptions, type ResolvedOptions } from './options.js';
import { restoreAll, type Patch } from './patch.js';
import {
  DEFAULT_SDK_CONFIG,
  LOG_LEVELS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type AppActionDescriptor,
  type LogLevel,
  type MockRule,
  type SdkCapability,
  type SdkConfig,
  type SdkHello,
  type SdkLog,
  type SdkToServer,
  type ServerToSdk,
  type ServerWelcome,
} from './protocol.js';
import { RingBuffer } from './ringBuffer.js';
import { errorMessage, g, originOfUrl, randomId, setTimer, type AnyRecord } from './util.js';
import { SDK_NAME, SDK_VERSION } from './version.js';
import { installXhrPatch } from './xhr.js';

export interface LogOptions {
  tag?: string;
  /** Structured payload shown as an expandable JSON tree on the desktop. */
  data?: unknown;
  /** An Error (or anything thrown); its stack trace is shown folded on the desktop. */
  error?: unknown;
}

interface Buffered {
  text: string;
  /** Console lines buffered before the desktop told us whether it already has device logs. */
  consoleLevel?: LogLevel;
}

/** Messages flushed per tick after a reconnect (keeps the JS thread responsive). */
const FLUSH_CHUNK = 250;
/** Pause sending while the socket has this much unsent data. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** Total size of buffered messages kept while disconnected. */
const MAX_BUFFERED_CHARS = 32 * 1024 * 1024;

function sanitizeConfig(input: unknown, previous: SdkConfig): SdkConfig {
  const next = { ...previous };
  if (!input || typeof input !== 'object') return next;
  const c = input as AnyRecord;
  if (typeof c.captureBodies === 'boolean') next.captureBodies = c.captureBodies;
  if (typeof c.maxBodyBytes === 'number' && isFinite(c.maxBodyBytes) && c.maxBodyBytes >= 0) next.maxBodyBytes = Math.floor(c.maxBodyBytes);
  if (typeof c.metricsIntervalMs === 'number' && isFinite(c.metricsIntervalMs) && c.metricsIntervalMs > 0) {
    next.metricsIntervalMs = Math.min(60_000, Math.max(250, c.metricsIntervalMs));
  }
  if (typeof c.deviceLogsAvailable === 'boolean') next.deviceLogsAvailable = c.deviceLogsAvailable;
  return next;
}

function normLevel(level: unknown): LogLevel {
  return typeof level === 'string' && (LOG_LEVELS as readonly string[]).indexOf(level) >= 0 ? (level as LogLevel) : 'info';
}

export class DurbunClient implements NetworkHost {
  readonly sessionKey = randomId(20);
  readonly runtime: Runtime;
  readonly opts: ResolvedOptions;
  private env: EnvironmentInfo;
  private conn: Connection | undefined;
  private readonly buffer: RingBuffer<Buffered>;
  private patches: Patch[] = [];
  private started = false;
  private config: SdkConfig = { ...DEFAULT_SDK_CONFIG };
  private configKnown = false;
  private mocks: MockRule[] = [];
  private serverAppId: string | undefined;
  private requestSeq = 0;
  private flushScheduled = false;
  private metrics: MetricsSampler | undefined;
  private networkCaptured = false;
  private errorsCaptured = false;
  private ignoreOrigins: string[] = [];
  private builtIns = new Map<string, { descriptor: AppActionDescriptor; handler: ActionHandler }>();
  private unsubscribeActions: (() => void) | undefined;
  private warnedNoSocket = false;

  constructor(
    options: DurbunOptions = {},
    private readonly timing: ConnectionTiming = DEFAULT_TIMING,
  ) {
    this.runtime = detectRuntime();
    this.opts = resolveOptions(options, this.runtime);
    this.buffer = new RingBuffer<Buffered>(this.opts.maxBufferedMessages, MAX_BUFFERED_CHARS);
    this.env = describeEnvironment(this.overrides(), this.runtime);
  }

  /* ────────────────────────────── lifecycle ────────────────────────────── */

  get isStarted(): boolean {
    return this.started;
  }

  get isConnected(): boolean {
    return !!this.conn && this.conn.isActive;
  }

  /** Server-assigned app session id (e.g. 'app:3') once connected. */
  get appSessionId(): string | undefined {
    return this.serverAppId;
  }

  start(): boolean {
    if (this.started) return true;
    const WS = (this.opts.WebSocket || g.WebSocket) as WebSocketConstructor | undefined;
    if (typeof WS !== 'function') {
      if (!this.warnedNoSocket) {
        this.warnedNoSocket = true;
        this.consoleOut('warn', '[Dürbün] No WebSocket implementation in this runtime; pass one via Durbun.start({ WebSocket }).');
      }
      return false;
    }
    this.started = true;
    for (const url of this.opts.urls) {
      const origin = originOfUrl(url.replace(/^ws/i, 'http'));
      if (origin) this.ignoreOrigins.push(origin);
    }
    const metro = devServerOrigin(this.runtime);
    if (metro) this.ignoreOrigins.push(metro);

    for (const action of builtInActions(this.runtime)) this.builtIns.set(action.descriptor.id, action);
    this.unsubscribeActions = appActions.onChange(() => this.sendActions());

    // Each hook is independent: one failing to install must not prevent the others.
    const install = (name: string, fn: () => Patch[]): Patch[] => {
      try {
        const installed = fn();
        this.patches.push(...installed);
        return installed;
      } catch (e) {
        this.debug(`installing ${name} capture failed`, e);
        return [];
      }
    };
    if (this.opts.captureConsole !== false) install('console', () => installConsolePatch(this));
    if (this.opts.captureNetwork) {
      const xhr = install('XMLHttpRequest', () => installXhrPatch(this));
      const fetchPatches = install('fetch', () => installFetchPatch(this, this.runtime));
      this.networkCaptured = xhr.length > 0 || fetchPatches.length > 0;
    }
    if (this.opts.captureErrors) this.errorsCaptured = install('error', () => installErrorHandlers(this, this.runtime, g)).length > 0;

    this.conn = new Connection(
      this.opts.urls,
      WS,
      {
        hello: () => this.buildHello(),
        welcome: (msg) => this.onWelcome(msg),
        message: (msg) => this.onServerMessage(msg),
        disconnected: () => this.onDisconnected(),
        debug: (m) => this.debug(m),
      },
      this.timing,
    );
    this.conn.start();
    this.debug(`started; desktop candidates: ${this.opts.urls.join(', ')}`);
    return true;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.metrics?.stop();
    } catch {
      // ignore
    }
    this.metrics = undefined;
    restoreAll(this.patches);
    this.patches = [];
    try {
      this.unsubscribeActions?.();
    } catch {
      // ignore
    }
    this.unsubscribeActions = undefined;
    try {
      this.conn?.stop();
    } catch {
      // ignore
    }
    this.conn = undefined;
    this.buffer.clear();
  }

  /* ────────────────────────────── public logging API ────────────────────────────── */

  log(level: LogLevel, message: unknown, options: LogOptions = {}): void {
    if (!this.started) return;
    try {
      let text: string;
      let data = options.data !== undefined ? toJsonSafe(options.data) : undefined;
      let error = options.error !== undefined && options.error !== null ? errorInfo(options.error) : undefined;
      if (typeof message === 'string') text = message;
      else {
        const f = formatArgs([message]);
        text = f.message;
        if (data === undefined) data = f.data;
        if (!error && f.error) error = f.error;
      }
      const msg: SdkLog = { type: 'log', ts: Date.now(), level: normLevel(level), tag: options.tag ? String(options.tag) : 'app', message: text };
      if (data !== undefined) msg.data = data;
      if (error) msg.error = error;
      this.emit(msg);
    } catch (e) {
      this.debug('log failed', e);
    }
  }

  event(name: string, props?: Record<string, unknown>): void {
    if (!this.started) return;
    try {
      let safe: unknown = props === undefined ? undefined : toJsonSafe(props);
      if (safe !== undefined && (typeof safe !== 'object' || safe === null || Array.isArray(safe))) safe = { value: safe };
      this.emit({ type: 'event', ts: Date.now(), name: String(name), ...(safe !== undefined ? { props: safe as Record<string, unknown> } : {}) });
    } catch (e) {
      this.debug('event failed', e);
    }
  }

  /* ────────────────────────────── hooks (console / errors / network) ────────────────────────────── */

  /** Should a console line at this level be sent, given what the desktop already receives? */
  consoleAllowed(level: LogLevel): boolean {
    const mode = this.opts.captureConsole;
    if (mode === true) return true;
    if (mode === false) return false;
    if (!this.config.deviceLogsAvailable || this.runtime !== 'react-native') return true;
    const device = this.env.device;
    // Android: logcat carries every console level (tag ReactNativeJS).
    if (device.platform === 'android') return false;
    // iOS simulator: `log stream` at info level shows console.log/info/warn/error but not console.debug.
    if (device.platform === 'ios' && device.isPhysical === false) return level === 'debug';
    // iOS devices: syslog relay drops info-level os_log lines, so console output is not reliably there.
    return true;
  }

  onConsole(method: ConsoleMethod, level: LogLevel, args: unknown[]): void {
    if (!this.started) return;
    let rest = args;
    if (method === 'assert') {
      if (args[0]) return;
      rest = args.slice(1);
    }
    if (this.configKnown && !this.consoleAllowed(level)) return;
    const f = formatArgs(rest, { extractTag: true });
    let message = f.message;
    let error = f.error;
    if (method === 'assert') message = message ? `Assertion failed: ${message}` : 'Assertion failed';
    if (method === 'trace') {
      // Drop the "Error" line and our two frames (onConsole + the console wrapper).
      const stack = new Error().stack || '';
      const frames = stack.split('\n').slice(3).join('\n');
      error = { type: 'Trace', message, stack: `Trace: ${message}\n${frames}` };
    }
    const msg: SdkLog = { type: 'log', ts: Date.now(), level, tag: f.tag || 'console', message };
    if (f.data !== undefined) msg.data = f.data;
    if (error) msg.error = error;
    this.emit(msg, this.configKnown ? undefined : level);
  }

  reportError(err: unknown, report: ErrorReport): void {
    if (!this.started) return;
    const prefix = report.origin === 'unhandled-rejection' ? 'Unhandled promise rejection' : 'Uncaught';
    const info = isErrorLike(err) ? errorInfo(err) : { message: previewValue(err, 2000) };
    const message = isErrorLike(err) ? `${prefix} ${info.type || 'Error'}: ${info.message || ''}`.trim() : `${prefix}: ${info.message}`;
    const msg: SdkLog = {
      type: 'log',
      ts: Date.now(),
      level: report.fatal ? 'fatal' : 'error',
      tag: report.origin,
      message,
      error: info,
      kind: report.fatal ? 'crash' : 'text',
    };
    if (report.location) msg.data = { location: report.location };
    this.emit(msg);
  }

  get bodyConfig(): BodyConfig {
    return { captureBodies: this.config.captureBodies, maxBodyBytes: this.config.maxBodyBytes };
  }

  nextRequestId(): string {
    return String(++this.requestSeq);
  }

  findMock(method: string, url: string): MockRule | undefined {
    if (!this.mocks.length) return undefined;
    return findMockRule(this.mocks, method, url, this.env.app.id);
  }

  isIgnored(url: string): boolean {
    const lower = url.toLowerCase();
    for (const origin of this.ignoreOrigins) {
      if (lower.startsWith(origin)) {
        const next = lower.charAt(origin.length);
        if (next === '' || next === '/' || next === '?' || next === '#') return true;
      }
    }
    for (const pattern of this.opts.ignoreUrls) {
      try {
        if (typeof pattern === 'string') {
          if (url.indexOf(pattern) >= 0) return true;
        } else {
          pattern.lastIndex = 0;
          if (pattern.test(url)) return true;
        }
      } catch {
        // ignore bad patterns
      }
    }
    return false;
  }

  debug(message: string, error?: unknown): void {
    if (!this.opts.debug) return;
    this.consoleOut('debug', `[Dürbün] ${message}${error !== undefined ? `: ${errorMessage(error)}` : ''}`);
  }

  /* ────────────────────────────── sending ────────────────────────────── */

  /** Serializes and sends (or buffers) one message. */
  emit(message: SdkToServer, consoleLevel?: LogLevel): void {
    if (!this.started) return;
    quietly(() => {
      let text: string;
      try {
        text = JSON.stringify(message);
      } catch (e) {
        text = JSON.stringify({
          type: 'log',
          ts: Date.now(),
          level: 'warn',
          tag: 'durbun',
          message: `Dürbün could not serialize a "${message.type}" message: ${errorMessage(e)}`,
        });
      }
      if (text.length * 3 > MAX_FRAME_BYTES && utf8Length(text) > MAX_FRAME_BYTES) text = this.shrink(message);
      const conn = this.conn;
      if (conn && conn.isActive && this.buffer.size === 0 && conn.bufferedAmount < HIGH_WATER_BYTES) {
        if (conn.send(text)) return;
      }
      this.buffer.push({ text, consoleLevel }, text.length);
      if (conn && conn.isActive) this.scheduleFlush(conn.bufferedAmount >= HIGH_WATER_BYTES ? 50 : 0);
    });
  }

  /** Oversized frame (huge body limit configured): keep the metadata, drop the payload. */
  private shrink(message: SdkToServer): string {
    const copy = { ...message } as AnyRecord;
    if (copy.body && typeof copy.body === 'object') copy.body = { encoding: 'utf8', data: '', size: copy.body.size, truncated: true };
    if ('data' in copy) copy.data = '[dropped: message larger than 16 MB]';
    if (typeof copy.message === 'string' && copy.message.length > 100_000) copy.message = copy.message.slice(0, 100_000) + '…';
    if (copy.props) copy.props = { dropped: 'props larger than 16 MB' };
    try {
      return JSON.stringify(copy);
    } catch {
      return JSON.stringify({ type: 'log', ts: Date.now(), level: 'warn', tag: 'durbun', message: 'Dürbün dropped an oversized message' });
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimer(() => {
      this.flushScheduled = false;
      this.flushStep();
    }, delayMs);
  }

  private flushStep(): void {
    const conn = this.conn;
    if (!this.started || !conn || !conn.isActive) return;
    quietly(() => {
      let sent = 0;
      while (this.buffer.size > 0) {
        if (sent >= FLUSH_CHUNK) {
          this.scheduleFlush(0);
          return;
        }
        if (conn.bufferedAmount >= HIGH_WATER_BYTES) {
          this.scheduleFlush(50);
          return;
        }
        const item = this.buffer.peek() as Buffered;
        if (item.consoleLevel && !this.consoleAllowed(item.consoleLevel)) {
          this.buffer.shift();
          continue;
        }
        if (!conn.send(item.text)) return; // connection lost: keep the rest for the next one
        this.buffer.shift();
        sent++;
      }
      const dropped = this.buffer.takeDropped();
      if (dropped > 0) {
        this.emit({
          type: 'log',
          ts: Date.now(),
          level: 'warn',
          tag: 'durbun',
          message: `Dürbün: ${dropped} message${dropped === 1 ? ' was' : 's were'} dropped while the desktop was not connected (buffer keeps the last ${this.opts.maxBufferedMessages}).`,
          data: { dropped, bufferLimit: this.opts.maxBufferedMessages },
        });
      }
    });
  }

  /* ────────────────────────────── server messages ────────────────────────────── */

  private overrides() {
    return { appId: this.opts.appId, appName: this.opts.appName, appVersion: this.opts.appVersion, device: this.opts.device };
  }

  private capabilities(): SdkCapability[] {
    const caps: SdkCapability[] = ['logs', 'events', 'commands'];
    if (this.networkCaptured) caps.push('network', 'mocks');
    if (this.errorsCaptured) caps.push('crash');
    if (this.opts.captureMetrics && metricsSupported()) caps.push('metrics');
    return caps;
  }

  private actionDescriptors(): AppActionDescriptor[] {
    const out: AppActionDescriptor[] = [];
    this.builtIns.forEach((a) => out.push({ ...a.descriptor }));
    for (const d of appActions.descriptors()) if (!this.builtIns.has(d.id)) out.push(d);
    return out;
  }

  private buildHello(): SdkHello {
    // Re-described on every connection: the RN app key is registered after Durbun.start() runs.
    this.env = describeEnvironment(this.overrides(), this.runtime);
    return {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      sdk: { name: SDK_NAME, version: SDK_VERSION, platform: this.env.sdkPlatform },
      app: this.env.app,
      device: this.env.device,
      session: this.sessionKey,
      capabilities: this.capabilities(),
      actions: this.actionDescriptors(),
      ts: Date.now(),
    };
  }

  private onWelcome(msg: ServerWelcome): void {
    this.serverAppId = msg.appId;
    this.config = sanitizeConfig(msg.config, this.config);
    this.configKnown = true;
    this.mocks = normalizeRules(msg.mocks);
    this.debug(`connected as ${msg.appId} (${this.conn ? this.conn.url : ''})`);
    this.startMetrics();
    this.flushStep();
  }

  private onServerMessage(msg: ServerToSdk): void {
    switch (msg.type) {
      case 'config': {
        const interval = this.config.metricsIntervalMs;
        this.config = sanitizeConfig(msg.config, this.config);
        this.configKnown = true;
        if (interval !== this.config.metricsIntervalMs) this.startMetrics();
        break;
      }
      case 'mocks':
        this.mocks = normalizeRules(msg.rules);
        break;
      case 'command':
        void this.handleCommand(msg.id, msg.name, msg.params);
        break;
      default:
        break;
    }
  }

  private onDisconnected(): void {
    // Mock rules hold only while the peer that pushed them is connected: whoever answered the hello is not
    // authenticated yet. The desktop sends them again in its next welcome.
    this.mocks = [];
    this.debug('desktop connection lost; buffering');
    this.metrics?.stop();
  }

  private startMetrics(): void {
    if (!this.opts.captureMetrics || !this.started) return;
    if (!this.metrics) this.metrics = new MetricsSampler((sample) => this.emit(sample));
    this.metrics.start(this.config.metricsIntervalMs);
  }

  private sendActions(): void {
    if (!this.started || !this.conn || !this.conn.isActive) return;
    quietly(() => {
      try {
        this.conn?.send(JSON.stringify({ type: 'actions', actions: this.actionDescriptors() }));
      } catch {
        // ignore
      }
    });
  }

  private async handleCommand(id: unknown, name: unknown, params: unknown): Promise<void> {
    if (typeof id !== 'string') return;
    const reply = (result: { ok: boolean; data?: unknown; error?: string }) =>
      quietly(() => {
        try {
          this.conn?.send(JSON.stringify({ type: 'command.result', id, ...result }));
        } catch {
          // ignore
        }
      });
    const commandName = typeof name === 'string' ? name : '';
    const entry = this.builtIns.get(commandName) || appActions.get(commandName);
    if (!entry) {
      reply({ ok: false, error: `Unknown command: ${commandName}` });
      return;
    }
    const input = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    try {
      const data = await entry.handler(input);
      const value = input.value;
      if (entry.descriptor.kind !== 'button' && (typeof value === 'boolean' || typeof value === 'string')) {
        if (appActions.get(commandName)) appActions.update(commandName, { value });
        else entry.descriptor.value = value;
      }
      reply({ ok: true, ...(data !== undefined ? { data: toJsonSafe(data) } : {}) });
    } catch (e) {
      reply({ ok: false, error: errorMessage(e) });
    }
  }

  /** Writes to the console without being captured by our own console patch. */
  private consoleOut(method: 'debug' | 'warn', text: string): void {
    quietly(() => {
      try {
        const c = g.console;
        if (c && typeof c[method] === 'function') c[method](text);
      } catch {
        // ignore
      }
    });
  }
}
