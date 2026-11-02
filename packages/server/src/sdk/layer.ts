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
  const pending = new Map<string, PendingCommand>();
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
      const appId = conn.appId as string;
      let set = byApp.get(appId);
      if (!set) {
        set = new Set();
        byApp.set(appId, set);
      }
      set.add(conn);
      if (conn.networkDevice && conn.deviceId) netDeviceRefs.set(conn.deviceId, (netDeviceRefs.get(conn.deviceId) ?? 0) + 1);
    },

    onClosed(conn: SdkConnection): void {
      connections.delete(conn);
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

  function attachStream(stream: Duplex, meta: SdkAttachMeta): void {
    if (closed || stream.destroyed) {
      if (!stream.destroyed) stream.destroy();
      return;
    }
    let conn: SdkConnection | undefined;
    const wire = streamWire(stream, timings.maxBufferedBytes, () => conn?.close('client is not reading (backpressure)', 1013), logger);
    const connection = new SdkConnection(host, meta, wire, true);
    conn = connection;
    connections.add(connection);
    const decoder = new NdjsonDecoder({
      maxLineBytes: MAX_FRAME_BYTES,
      onLine: (line) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          logger.debug(`ignored a non-JSON line (${line.length} chars) from ${describeMeta(meta)}`);
          return;
        }
        connection.receive(value);
      },
      onOversize: (bytes) => logger.warn(`dropped an oversized SDK frame (${bytes} bytes) from ${connection.describe()}`),
    });
    stream.on('data', (chunk: Buffer | string) => {
      if (connection.closed) return;
      connection.touch();
      try {
        decoder.push(chunk);
      } catch (err) {
        logger.warn(`failed to decode data from ${connection.describe()}`, err);
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
    let conn: SdkConnection | undefined;
    const wire = webSocketWire(ws, timings.maxBufferedBytes, () => conn?.close('client is not reading (backpressure)', 1013), logger);
    const connection = new SdkConnection(host, meta, wire, true);
    conn = connection;
    connections.add(connection);
    ws.on('message', (data, isBinary) => {
      if (connection.closed) return;
      connection.touch();
      const buf = rawDataToBuffer(data);
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
