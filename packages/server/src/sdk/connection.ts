/**
 * One SDK connection, independent of its transport. Raw streams, WebSockets and in-process virtual
 * sessions all feed decoded JSON values into `receive()`, so every message takes the same path:
 * validate → hello/handshake → hub.
 */
import type {
  MetricSample,
  MockRule,
  SdkCommandResult,
  SdkConfig,
  SdkHello,
  SdkToServer,
  ServerToSdk,
  Transport,
} from '@durbun/protocol';
import { PROTOCOL_VERSION } from '@durbun/protocol';
import type { Hub, Logger, SdkAttachMeta } from '../types';
import { resolveDevice } from './devices';
import { parseSdkMessage } from './validate';

export interface SdkTimings {
  /** Close connections that do not send `hello` in time. */
  helloTimeoutMs: number;
  /** Server → SDK keepalive ping interval. */
  pingIntervalMs: number;
  /** Close connections without any inbound data for this long. */
  idleTimeoutMs: number;
  /** Default `sendCommand` timeout. */
  commandTimeoutMs: number;
  /** Outbound bytes allowed to queue for a client that does not read before it is disconnected. */
  maxBufferedBytes: number;
}

export const DEFAULT_SDK_TIMINGS: SdkTimings = {
  helloTimeoutMs: 10_000,
  pingIntervalMs: 15_000,
  idleTimeoutMs: 45_000,
  commandTimeoutMs: 10_000,
  maxBufferedBytes: 8 * 1024 * 1024,
};

/** Transport-specific output side of a connection. */
export interface Wire {
  readonly kind: 'stream' | 'websocket' | 'virtual';
  send(message: ServerToSdk): void;
  /** Close the underlying transport (idempotent). `code` is a WebSocket close code hint. */
  close(reason: string, code?: number): void;
}

/** What a connection needs from the SDK layer. */
export interface ConnectionHost {
  readonly hub: Hub;
  readonly logger: Logger;
  readonly timings: SdkTimings;
  readonly serverVersion: string;
  configFor(deviceId: string): SdkConfig;
  mocksFor(bundleId: string): MockRule[];
  onEstablished(conn: SdkConnection): void;
  onClosed(conn: SdkConnection): void;
  onCommandResult(conn: SdkConnection, msg: SdkCommandResult): void;
}

export interface HandshakeCallbacks {
  onWelcome?(appId: string): void;
  onClosedBeforeWelcome?(reason: string): void;
}

export function metricSourceFor(transport: Transport): MetricSample['source'] {
  if (transport === 'vm-service') return 'vm-service';
  if (transport === 'demo') return 'demo';
  return 'sdk';
}

export function configKey(config: SdkConfig): string {
  return `${config.captureBodies}|${config.maxBodyBytes}|${config.metricsIntervalMs}|${config.deviceLogsAvailable}`;
}

let connectionSeq = 1;

export class SdkConnection {
  readonly id = connectionSeq++;
  appId: string | undefined;
  deviceId: string | undefined;
  /** App bundle id / package name from `hello` (mock rule filtering). */
  bundleId: string | undefined;
  appName: string | undefined;
  /** Session lives on a `net:` device whose state follows its connections. */
  networkDevice = false;
  established = false;
  closed = false;
  /** Last config sent (to push updates only when something changed). */
  lastConfigKey = '';
  private lastInboundAt = Date.now();
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: ConnectionHost,
    readonly meta: SdkAttachMeta,
    private readonly wire: Wire,
    /** Hello timeout, pings and idle close (off for in-process virtual sessions). */
    private readonly keepalive: boolean,
    private readonly callbacks: HandshakeCallbacks = {},
  ) {}

  describe(): string {
    const who = this.appName ? `${this.appName} (${this.appId})` : `connection #${this.id}`;
    return `${who} via ${this.meta.transport}${this.meta.remote ? ` from ${this.meta.remote}` : ''}`;
  }

  start(): void {
    if (!this.keepalive || this.closed) return;
    this.helloTimer = setTimeout(() => {
      if (!this.established) this.close('no hello within the handshake timeout', 1008);
    }, this.host.timings.helloTimeoutMs);
    this.helloTimer.unref?.();
    this.scheduleIdleCheck(this.host.timings.idleTimeoutMs);
  }

  /** Any inbound bytes count as activity (even partial frames). */
  touch(): void {
    this.lastInboundAt = Date.now();
  }

  send(message: ServerToSdk): void {
    if (this.closed) return;
    try {
      this.wire.send(message);
    } catch (err) {
      this.host.logger.debug(`send failed on ${this.describe()}`, err);
    }
  }

  /** Entry point for every decoded inbound value. */
  receive(value: unknown): void {
    if (this.closed) return;
    this.touch();
    let msg: SdkToServer | undefined;
    try {
      msg = parseSdkMessage(value);
    } catch (err) {
      this.host.logger.debug(`invalid message on ${this.describe()}`, err);
      return;
    }
    if (!msg) {
      this.host.logger.debug(`ignored an invalid/unknown message on ${this.describe()}`);
      return;
    }
    try {
      this.dispatch(msg);
    } catch (err) {
      this.host.logger.warn(`failed to handle "${msg.type}" from ${this.describe()}`, err);
    }
  }

  close(reason: string, code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.helloTimer = this.pingTimer = this.idleTimer = undefined;
    try {
      this.wire.close(reason, code);
    } catch (err) {
      this.host.logger.debug('closing transport failed', err);
    }
    if (this.established) this.host.logger.info(`SDK disconnected: ${this.describe()} (${reason})`);
    else this.host.logger.debug(`SDK connection closed before hello: ${this.describe()} (${reason})`);
    try {
      this.host.onClosed(this);
    } catch (err) {
      this.host.logger.warn(`cleanup after ${this.describe()} failed`, err);
    }
    if (!this.established) this.callbacks.onClosedBeforeWelcome?.(reason);
  }

  private dispatch(msg: SdkToServer): void {
    if (!this.established) {
      if (msg.type !== 'hello') {
        this.host.logger.debug(`"${msg.type}" before hello ignored on ${this.describe()}`);
        return;
      }
      try {
        this.handleHello(msg);
      } catch (err) {
        this.host.logger.warn(`hello from ${this.describe()} rejected`, err);
        this.close('hello could not be processed', 1011);
      }
      return;
    }
    const appId = this.appId as string;
    const hub = this.host.hub;
    switch (msg.type) {
      case 'hello':
        this.host.logger.debug(`duplicate hello ignored on ${this.describe()}`);
        return;
      case 'log':
        hub.pushAppLog(appId, msg);
        return;
      case 'net.request':
        hub.netRequest(appId, msg);
        return;
      case 'net.response':
        hub.netResponse(appId, msg);
        return;
      case 'net.error':
        hub.netError(appId, msg);
        return;
      case 'event':
        hub.pushAppLog(appId, { ts: msg.ts, level: 'info', tag: 'event', message: msg.name, data: msg.props, kind: 'event' });
        return;
      case 'metric': {
        const { type: _type, ...sample } = msg;
        hub.pushAppMetrics(appId, { ...sample, source: metricSourceFor(this.meta.transport) });
        return;
      }
      case 'command.result':
        this.host.onCommandResult(this, msg);
        return;
      case 'actions':
        hub.patchApp(appId, { actions: msg.actions });
        return;
      case 'pong':
        return;
    }
  }

  private handleHello(hello: SdkHello): void {
    const { hub, logger } = this.host;
    const resolved = resolveDevice(hub, hello.device, this.meta);
    const app = hub.registerApp({
      sessionKey: hello.session,
      deviceId: resolved.deviceId,
      sdk: hello.sdk,
      app: hello.app,
      transport: this.meta.transport,
      connected: true,
      connectedAt: Date.now(),
      capabilities: hello.capabilities,
      actions: hello.actions ?? [],
    });
    this.appId = app.id;
    this.deviceId = resolved.deviceId;
    this.bundleId = hello.app.id;
    this.appName = hello.app.name;
    this.networkDevice = resolved.network;
    this.established = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    this.host.onEstablished(this);

    const config = this.host.configFor(resolved.deviceId);
    this.lastConfigKey = configKey(config);
    this.send({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      server: `durbun/${this.host.serverVersion}`,
      appId: app.id,
      config,
      mocks: this.host.mocksFor(hello.app.id),
    });
    if (this.keepalive) {
      this.pingTimer = setInterval(() => this.send({ type: 'ping', ts: Date.now() }), this.host.timings.pingIntervalMs);
      this.pingTimer.unref?.();
    }
    logger.info(`SDK connected: ${this.describe()} → device ${resolved.deviceId}`);
    this.callbacks.onWelcome?.(app.id);
  }

  private scheduleIdleCheck(delayMs: number): void {
    this.idleTimer = setTimeout(() => {
      if (this.closed) return;
      const idle = Date.now() - this.lastInboundAt;
      const limit = this.host.timings.idleTimeoutMs;
      if (idle >= limit) this.close(`no data for ${Math.round(idle / 1000)} s`, 1001);
      else this.scheduleIdleCheck(limit - idle);
    }, Math.max(10, delayMs));
    this.idleTimer.unref?.();
  }
}
