/**
 * SDK layer (SPEC §5.3): accepts SDK connections over raw TCP / any NDJSON byte stream, WebSocket and
 * in-process virtual sessions, performs the hello/welcome handshake, keeps connections alive and routes
 * messages into the hub. Also broadcasts mocks/config and runs app commands.
 */
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { DeviceActionResult, MockRule, SdkCommandResult, SdkConfig, ServerSettings, ServerToSdk } from '@durbun/protocol';
import { DEFAULT_SETTINGS, MAX_FRAME_BYTES } from '@durbun/protocol';
import type { WebSocket } from 'ws';
import type { CreateSdkLayerOptions, HubChange, SdkAttachMeta, SdkLayer, VirtualSdkSession } from '../types';
import { configKey, type ConnectionHost, DEFAULT_SDK_TIMINGS, SdkConnection, type SdkTimings } from './connection';
import { isSdkPlaceholder } from './devices';
import { NdjsonDecoder } from './ndjson';
import { rawDataToBuffer, streamWire, virtualWire, webSocketWire } from './wires';

interface PendingCommand {
  appId: string;
  conn: SdkConnection;
  resolve(result: DeviceActionResult): void;
  timer: ReturnType<typeof setTimeout>;
}

const describeMeta = (meta: SdkAttachMeta) => `${meta.transport}${meta.remote ? ` ${meta.remote}` : ''}`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Limits for connections that have not completed their hello (the SDK port is open to the LAN when "allow
 * LAN" is on, and to every app on a plugged-in phone through adb reverse). An SDK sends one small `hello`
 * first, so: its line may be at most `maxHelloBytes` (frames grow to MAX_FRAME_BYTES once established), at most
 * `maxPendingPerRemote` connections per address (`maxPendingTotal` in all) may wait for their hello, and an
 * address may open at most `maxNewPerRemote` connections per `rateWindowMs`. Mutable for tests.
 */
export const SDK_ADMISSION = {
  maxHelloBytes: 64 * 1024,
  maxPendingPerRemote: 8,
  maxPendingTotal: 64,
  maxNewPerRemote: 30,
  rateWindowMs: 10_000,
};

/** Who a connection comes from, for SDK_ADMISSION: its IP (no port), or the adb reverse device. */
export function admissionKey(meta: SdkAttachMeta): string {
  const remote = meta.remote ?? '';
  if (meta.transport !== 'tcp' && meta.transport !== 'websocket') return remote || meta.transport;
  const colon = remote.lastIndexOf(':');
  const ip = (colon > 0 ? remote.slice(0, colon) : remote).toLowerCase();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** "POST / HTTP/1.1": a browser (fetch / form / <img>) or an HTTP tool talking to the raw SDK port. */
const HTTP_REQUEST_LINE = /^[A-Z]+ \S+ HTTP\/\d(?:\.\d)?$/;
const NOT_HTTP_BODY = 'This is the Dürbün SDK port: it speaks NDJSON, not HTTP. Open Dürbün on its HTTP port (9750 by default).\n';
const NOT_HTTP_RESPONSE =
  `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n` +
  `Content-Length: ${Buffer.byteLength(NOT_HTTP_BODY)}\r\n\r\n${NOT_HTTP_BODY}`;

/** Same as `createSdkLayer`, with overridable timings (tests use short ones). */
export function createSdkLayerWithTimings(opts: CreateSdkLayerOptions, overrides: Partial<SdkTimings> = {}): SdkLayer {
  const timings: SdkTimings = { ...DEFAULT_SDK_TIMINGS, ...overrides };
  const logger = opts.logger;
  const hub = opts.hub;
  const connections = new Set<SdkConnection>();
  /** appId → live established connections (several during a transport race / stale socket). */
  const byApp = new Map<string, Set<SdkConnection>>();
  /** `net:` device → number of established sessions on it. */
  const netDeviceRefs = new Map<string, number>();
  /**
   * Driverless `ios-sim:` placeholder → number of established sessions on it. When the last one ends and no
   * driver has reported the simulator meanwhile, it goes offline like a `net:` device (no ghost stays online).
   */
  const placeholderRefs = new Map<string, number>();
  const pending = new Map<string, PendingCommand>();
  /** Admission key → connections still waiting for their hello (SDK_ADMISSION). */
  const preHello = new Map<string, Set<SdkConnection>>();
  let preHelloTotal = 0;
  /** Admission key → times of its recent new connections (within rateWindowMs). */
  const recentOpens = new Map<string, number[]>();
  let mocksOverride: MockRule[] | undefined;
  let configOverride: Partial<SdkConfig> = {};
  let server: net.Server | undefined;
  let closed = false;
  let commandSeq = 0;

  const currentSettings = (): ServerSettings => {
    try {
      return opts.settings() ?? DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  };

  const currentMocks = (): MockRule[] => {
    if (mocksOverride) return mocksOverride;
    try {
      const rules = opts.mocks();
      return Array.isArray(rules) ? rules : [];
    } catch {
      return [];
    }
  };

  const established = (): SdkConnection[] => [...connections].filter((c) => c.established && !c.closed);

  const host: ConnectionHost = {
    hub,
    logger,
    timings,
    serverVersion: opts.serverVersion,

    configFor(deviceId: string): SdkConfig {
      const s = currentSettings();
      return {
        captureBodies: s.captureBodies,
        maxBodyBytes: s.maxBodyBytes,
        metricsIntervalMs: s.metricsIntervalMs,
        deviceLogsAvailable: hub.getDevice(deviceId)?.logs.status === 'streaming',
        ...configOverride,
      };
    },

    mocksFor(bundleId: string): MockRule[] {
      return currentMocks().filter(
        (r) => !!r && r.enabled === true && (!Array.isArray(r.apps) || r.apps.length === 0 || r.apps.includes(bundleId)),
      );
    },

    onEstablished(conn: SdkConnection): void {
      leavePreHello(conn);
      const appId = conn.appId as string;
      let set = byApp.get(appId);
      if (!set) {
        set = new Set();
        byApp.set(appId, set);
      }
      set.add(conn);
      if (conn.networkDevice && conn.deviceId) netDeviceRefs.set(conn.deviceId, (netDeviceRefs.get(conn.deviceId) ?? 0) + 1);
      else if (conn.deviceId && (conn.placeholderDevice || placeholderRefs.has(conn.deviceId))) {
        conn.placeholderDevice = true;
        placeholderRefs.set(conn.deviceId, (placeholderRefs.get(conn.deviceId) ?? 0) + 1);
      }
    },

    onClosed(conn: SdkConnection): void {
      connections.delete(conn);
      leavePreHello(conn);
      for (const [id, p] of pending) {
        if (p.conn !== conn) continue;
        clearTimeout(p.timer);
        pending.delete(id);
        p.resolve({ ok: false, error: 'The app disconnected before answering', code: 'app.disconnected' });
      }
      if (!conn.established || !conn.appId) return;
      const set = byApp.get(conn.appId);
      set?.delete(conn);
      if (!set || set.size === 0) {
        byApp.delete(conn.appId);
        hub.markAppDisconnected(conn.appId);
      }
      if (conn.networkDevice && conn.deviceId) {
        const left = (netDeviceRefs.get(conn.deviceId) ?? 1) - 1;
        if (left > 0) netDeviceRefs.set(conn.deviceId, left);
        else {
          netDeviceRefs.delete(conn.deviceId);
          hub.markDeviceDisconnected(conn.deviceId, 'No app is connected over the network', 'device.networkIdle');
        }
      } else if (conn.placeholderDevice && conn.deviceId && placeholderRefs.has(conn.deviceId)) {
        const left = (placeholderRefs.get(conn.deviceId) ?? 1) - 1;
        if (left > 0) placeholderRefs.set(conn.deviceId, left);
        else {
          placeholderRefs.delete(conn.deviceId);
          const device = hub.getDevice(conn.deviceId);
          // A driver that reported the simulator meanwhile owns its state now.
          if (device && device.state === 'online' && isSdkPlaceholder(device)) {
            hub.markDeviceDisconnected(conn.deviceId, 'No app is connected, and Dürbün does not watch this simulator itself', 'device.sdkIdle');
          }
        }
      }
    },

    onCommandResult(conn: SdkConnection, msg: SdkCommandResult): void {
      const p = pending.get(msg.id);
      if (!p || p.appId !== conn.appId) {
        logger.debug(`command.result for unknown command ${msg.id} from ${conn.describe()}`);
        return;
      }
      clearTimeout(p.timer);
      pending.delete(msg.id);
      const result: DeviceActionResult = { ok: msg.ok };
      if (msg.data !== undefined) result.data = msg.data;
      if (msg.error) result.error = msg.error;
      else if (!msg.ok) result.error = 'The app reported a failure';
      p.resolve(result);
    },
  };

  /** Pushes `config` when a device's log availability changed (e.g. logcat started after the app connected). */
  const unsubscribeHub = hub.subscribe((change: HubChange) => {
    if (change.devices.length === 0) return;
    const changed = new Set(change.devices.map((d) => d.id));
    for (const conn of established()) {
      if (!conn.deviceId || !changed.has(conn.deviceId)) continue;
      const config = host.configFor(conn.deviceId);
      const key = configKey(config);
      if (key === conn.lastConfigKey) continue;
      conn.lastConfigKey = key;
      conn.send({ type: 'config', config });
    }
  });

  /**
   * May a new inbound connection from `meta` start? Refused (with a log line) when its address opened too
   * many connections lately or too many connections are still waiting for their hello.
   */
  function admit(meta: SdkAttachMeta): string | undefined {
    if (meta.transport !== 'tcp' && meta.transport !== 'websocket' && meta.transport !== 'adb-reverse') return undefined;
    const key = admissionKey(meta);
    const now = Date.now();
    const since = now - SDK_ADMISSION.rateWindowMs;
    const opens = (recentOpens.get(key) ?? []).filter((t) => t > since);
    if (opens.length >= SDK_ADMISSION.maxNewPerRemote) {
      recentOpens.set(key, opens);
      return `more than ${SDK_ADMISSION.maxNewPerRemote} new connections from ${key} within ${SDK_ADMISSION.rateWindowMs / 1000} s`;
    }
    if ((preHello.get(key)?.size ?? 0) >= SDK_ADMISSION.maxPendingPerRemote) {
      return `${SDK_ADMISSION.maxPendingPerRemote} connections from ${key} are still waiting for their hello`;
    }
    if (preHelloTotal >= SDK_ADMISSION.maxPendingTotal) return `${SDK_ADMISSION.maxPendingTotal} connections are still waiting for their hello`;
    opens.push(now);
    recentOpens.set(key, opens);
    if (recentOpens.size > 1024) {
      for (const [k, list] of recentOpens) if (!list.some((t) => t > since)) recentOpens.delete(k);
    }
    return undefined;
  }

  function enterPreHello(conn: SdkConnection): void {
    if (conn.meta.transport !== 'tcp' && conn.meta.transport !== 'websocket' && conn.meta.transport !== 'adb-reverse') return;
    const key = admissionKey(conn.meta);
    let set = preHello.get(key);
    if (!set) {
      set = new Set();
      preHello.set(key, set);
    }
    set.add(conn);
    preHelloTotal++;
  }

  function leavePreHello(conn: SdkConnection): void {
    const key = admissionKey(conn.meta);
    const set = preHello.get(key);
    if (!set?.delete(conn)) return;
    preHelloTotal--;
    if (set.size === 0) preHello.delete(key);
  }

  /**
   * Every SDK starts with its JSON `hello`. A stream whose first line is something else is not an SDK —
   * typically a web page's no-cors POST to the raw port, whose body could carry a forged hello: closed
   * before any of it is read (an HTTP client gets a short 400 that says what this port is).
   */
  function refuseNonSdkStream(stream: Duplex, connection: SdkConnection, meta: SdkAttachMeta, line: string): void {
    const http = HTTP_REQUEST_LINE.test(line);
    logger.warn(
      `closed an SDK connection from ${describeMeta(meta)}: its first line is not JSON${http ? ` but an HTTP request ("${line.slice(0, 80)}"), e.g. from a web page` : ''}`,
    );
    if (http && stream.writable) {
      try {
        stream.write(NOT_HTTP_RESPONSE);
      } catch {
        // the connection is closed below anyway
      }
    }
    connection.close('the first line is not JSON', 1002);
  }

  function attachStream(stream: Duplex, meta: SdkAttachMeta): void {
    if (closed || stream.destroyed) {
      if (!stream.destroyed) stream.destroy();
      return;
    }
    const refused = admit(meta);
    if (refused) {
      logger.warn(`refused an SDK connection from ${describeMeta(meta)}: ${refused}`);
      stream.on('error', () => undefined);
      stream.destroy();
      return;
    }
    let conn: SdkConnection | undefined;
    const wire = streamWire(stream, timings.maxBufferedBytes, () => conn?.close('client is not reading (backpressure)', 1013), logger);
    const connection = new SdkConnection(host, meta, wire, true);
    conn = connection;
    connections.add(connection);
    enterPreHello(connection);
    let firstLine = true;
    const decoder = new NdjsonDecoder({
      // Until the hello is in, a line may be only as long as a hello (a 16 MB line would be held in memory).
      maxLineBytes: SDK_ADMISSION.maxHelloBytes,
      onLine: (line) => {
        if (connection.closed) return;
        const first = firstLine;
        firstLine = false;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          if (first) refuseNonSdkStream(stream, connection, meta, line);
          else logger.debug(`ignored a non-JSON line (${line.length} chars) from ${describeMeta(meta)}`);
          return;
        }
        connection.receive(value);
        if (connection.established) decoder.maxLineBytes = MAX_FRAME_BYTES;
      },
      onOversize: (bytes) => {
        if (!connection.established) {
          logger.warn(`closed an SDK connection from ${describeMeta(meta)}: a ${bytes}-byte line before its hello (limit ${SDK_ADMISSION.maxHelloBytes})`);
          connection.close('hello too large', 1009);
          return;
        }
        logger.warn(`dropped an oversized SDK frame (${bytes} bytes) from ${connection.describe()}`);
      },
    });
    stream.on('data', (chunk: Buffer | string) => {
      if (connection.closed) return;
      connection.touch();
      try {
        decoder.push(chunk);
      } catch (err) {
        logger.warn(`failed to decode data from ${connection.describe()}`, err);
      }
      if (decoder.overflowing && !connection.established && !connection.closed) {
        logger.warn(`closed an SDK connection from ${describeMeta(meta)}: more than ${SDK_ADMISSION.maxHelloBytes} bytes before its hello`);
        connection.close('hello too large', 1009);
      }
    });
    stream.on('end', () => {
      try {
        decoder.end();
      } catch {
        // ignore a broken trailing line
      }
      connection.close('stream ended');
    });
    stream.on('close', () => connection.close('stream closed'));
    stream.on('error', (err: Error) => {
      logger.debug(`stream error on ${connection.describe()}: ${err.message}`);
      connection.close(`stream error: ${err.message}`);
    });
    if (stream instanceof net.Socket) {
      stream.setNoDelay(true);
      stream.setKeepAlive(true, 30_000);
    }
    connection.start();
  }

  function attachWebSocket(ws: WebSocket, meta: SdkAttachMeta): void {
    if (closed) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
      return;
    }
    const refused = admit(meta);
    if (refused) {
      logger.warn(`refused an SDK connection from ${describeMeta(meta)}: ${refused}`);
      try {
        ws.close(1013, 'too many connections, try again later');
      } catch {
        ws.terminate();
      }
      return;
    }
    let conn: SdkConnection | undefined;
    const wire = webSocketWire(ws, timings.maxBufferedBytes, () => conn?.close('client is not reading (backpressure)', 1013), logger);
    const connection = new SdkConnection(host, meta, wire, true);
    conn = connection;
    connections.add(connection);
    enterPreHello(connection);
    ws.on('message', (data, isBinary) => {
      if (connection.closed) return;
      connection.touch();
      const buf = rawDataToBuffer(data);
      if (!connection.established && buf.length > SDK_ADMISSION.maxHelloBytes) {
        logger.warn(`closed an SDK connection from ${describeMeta(meta)}: a ${buf.length}-byte message before its hello (limit ${SDK_ADMISSION.maxHelloBytes})`);
        connection.close('hello too large', 1009);
        return;
      }
      if (buf.length > MAX_FRAME_BYTES) {
        logger.warn(`dropped an oversized WebSocket frame (${buf.length} bytes) from ${connection.describe()}`);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(buf.toString('utf8'));
      } catch {
        logger.debug(`ignored a non-JSON ${isBinary ? 'binary' : 'text'} frame from ${describeMeta(meta)}`);
        return;
      }
      connection.receive(value);
    });
    ws.on('pong', () => connection.touch());
    ws.on('close', () => connection.close('websocket closed'));
    ws.on('error', (err: Error) => {
      logger.debug(`websocket error on ${connection.describe()}: ${err.message}`);
      connection.close(`websocket error: ${err.message}`);
    });
    if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
      connection.close('websocket already closed');
      return;
    }
    connection.start();
  }

  function openVirtual(meta: SdkAttachMeta): VirtualSdkSession {
    const listeners = new Set<(message: ServerToSdk) => void>();
    let resolveAppId: (id: string) => void = () => {};
    let rejectAppId: (err: Error) => void = () => {};
    const appId = new Promise<string>((resolve, reject) => {
      resolveAppId = resolve;
      rejectAppId = reject;
    });
    appId.catch(() => {}); // nobody has to observe a session that never completed its handshake
    const connection = new SdkConnection(host, meta, virtualWire(listeners, logger), false, {
      onWelcome: (id) => resolveAppId(id),
      onClosedBeforeWelcome: (reason) => rejectAppId(new Error(`SDK session closed before welcome: ${reason}`)),
    });
    if (closed) connection.close('SDK layer is closed');
    else {
      connections.add(connection);
      connection.start();
    }
    return {
      send: (message) => connection.receive(message),
      onMessage: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: (reason) => connection.close(reason ?? 'closed by its owner'),
      get closed() {
        return connection.closed;
      },
      appId,
    };
  }

  function createListener(): net.Server {
    return net.createServer({ noDelay: true, keepAlive: true, keepAliveInitialDelay: 30_000 }, (socket) => {
      attachStream(socket, { transport: 'tcp', remote: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}` });
    });
  }

  function listenOnce(srv: net.Server, port: number, bindHost: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        srv.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        srv.off('error', onError);
        resolve();
      };
      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(port, bindHost);
    });
  }

  /** Rebinds run one after another (a quick LAN on/off toggle must not race two listeners). */
  let listenQueue: Promise<void> = Promise.resolve();
  function listen(port: number, bindHost: string): Promise<void> {
    const run = listenQueue.then(() => bind(port, bindHost));
    listenQueue = run.catch(() => undefined);
    return run;
  }

  async function bind(port: number, bindHost: string): Promise<void> {
    if (closed) throw new Error('SDK layer is closed');
    const previous = server;
    server = undefined;
    if (previous) {
      // Stops accepting; existing SDK connections stay open (they are tracked separately).
      previous.close();
      await delay(0);
    }
    for (let attempt = 0; ; attempt++) {
      const srv = createListener();
      try {
        await listenOnce(srv, port, bindHost);
        if (closed) {
          srv.close();
          throw new Error('SDK layer is closed');
        }
        srv.on('error', (err) => logger.warn('SDK listener error', err));
        server = srv;
        logger.info(`SDK listener on ${bindHost}:${port}`);
        return;
      } catch (err) {
        srv.close();
        const code = (err as NodeJS.ErrnoException).code;
        // Rebinding the port we just released can race the OS; retry briefly.
        if (code === 'EADDRINUSE' && previous && attempt < 5) {
          await delay(60);
          continue;
        }
        throw err;
      }
    }
  }

  return {
    attachStream,
    attachWebSocket,
    openVirtual,
    listen,

    setMocks(rules: MockRule[]): void {
      mocksOverride = Array.isArray(rules) ? [...rules] : [];
      for (const conn of established()) conn.send({ type: 'mocks', rules: host.mocksFor(conn.bundleId ?? '') });
    },

    setConfig(patch: Partial<SdkConfig>): void {
      const clean: Partial<SdkConfig> = {};
      if (typeof patch?.captureBodies === 'boolean') clean.captureBodies = patch.captureBodies;
      if (typeof patch?.maxBodyBytes === 'number' && Number.isFinite(patch.maxBodyBytes)) clean.maxBodyBytes = patch.maxBodyBytes;
      if (typeof patch?.metricsIntervalMs === 'number' && Number.isFinite(patch.metricsIntervalMs)) {
        clean.metricsIntervalMs = patch.metricsIntervalMs;
      }
      if (typeof patch?.deviceLogsAvailable === 'boolean') clean.deviceLogsAvailable = patch.deviceLogsAvailable;
      configOverride = { ...configOverride, ...clean };
      for (const conn of established()) {
        const config = host.configFor(conn.deviceId ?? '');
        conn.lastConfigKey = configKey(config);
        conn.send({ type: 'config', config });
      }
    },

    sendCommand(appId: string, name: string, params?: Record<string, unknown>, timeoutMs = timings.commandTimeoutMs): Promise<DeviceActionResult> {
      const set = byApp.get(appId);
      const conns = set ? [...set].filter((c) => !c.closed) : [];
      const conn = conns[conns.length - 1];
      if (!conn) return Promise.resolve({ ok: false, error: 'The app is not connected', code: 'app.notConnected' });
      const app = hub.getApp(appId);
      if (app && !app.capabilities.includes('commands') && app.actions.length === 0) {
        return Promise.resolve({
          ok: false,
          error: 'This app does not accept commands (its SDK has no "commands" capability)',
          code: 'app.commandsUnsupported',
        });
      }
      const id = `cmd-${++commandSeq}`;
      return new Promise<DeviceActionResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({
            ok: false,
            error: `The app did not answer within ${Math.round(timeoutMs / 100) / 10} s`,
            code: 'app.commandTimeout',
          });
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { appId, conn, resolve, timer });
        conn.send(params ? { type: 'command', id, name, params } : { type: 'command', id, name });
      });
    },

    connectionCount: () => connections.size,

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribeHub();
      const srv = server;
      server = undefined;
      srv?.close();
      for (const conn of [...connections]) conn.close('server shutting down', 1001);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'Dürbün is shutting down', code: 'server.shutdown' });
      }
      pending.clear();
    },
  };
}
