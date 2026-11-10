/**
 * The HTTP/WebSocket control plane: one node:http server with
 *   - static UI (or the "please build" page),
 *   - REST /api/* (loopback + allowed origins only),
 *   - WebSocket upgrades: /ui (loopback + allowed origins) and /sdk (any address, no pages of other sites;
 *     handed to the SDK layer),
 * plus a device gateway on its own loopback port (`adb reverse tcp:9750` points there): /sdk and
 * GET /api/health only, so apps on a plugged-in phone never reach /api or /ui.
 * It also owns the runtime state the UI can change: demo on/off, SDK listener binding (LAN toggle), driver
 * status broadcasts, settings/mocks propagation. Built from plain dependencies so tests can pass fakes.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type DriverStatus,
  type MockRule,
  type ServerInfo,
  type ServerSettings,
  type ServerToUi,
  type ToolCheck,
  type UiNotice,
} from '@durbun/protocol';
import { cleanTempDir, TEMP_CLEAN_INTERVAL_MS, TEMP_KEEP_WHILE_RUNNING, TEMP_MAX_AGE_MS, type ConfigStore } from '../config';
import { runDoctor as runDoctorChecks, type PortState } from '../doctor';
import type { ClearEvent, DeviceDriver, DriverContext, FlutterVmModule, Hub, HubChange, Logger, SdkLayer } from '../types';
import { SERVER_VERSION } from '../version';
import { createApiHandler } from './api';
import { SlackStore } from './slack';
import { CommandError, createCommandRouter, withTimeout } from './commands';
import { checkLocalAccess, checkSdkUpgrade } from './security';
import { createStaticHandler } from './static';
import { UiChannel } from './uiSocket';
import { errorMessage, sendError, sendJson } from './util';

export const DRIVER_STATUS_INTERVAL_MS = 5_000;
const UI_MAX_PAYLOAD = 32 * 1024 * 1024;
const DEMO_TIMEOUT_MS = 20_000;

export interface HttpAppDeps {
  hub: Hub;
  sdk: SdkLayer;
  /** Platform drivers (android, ios-sim, ios-device). */
  drivers: DeviceDriver[];
  vm?: FlutterVmModule | null;
  demo?: DeviceDriver | null;
  config: ConfigStore;
  logger: Logger;
  /** Context used to start the demo driver when the UI turns demo mode on. */
  demoContext?: DriverContext;
  /** Built UI directory (null → placeholder page). */
  uiDir: string | null;
  /** Ports from the CLI. `http` may be 0 (tests); the bound port is used after listen(). */
  ports: { http: number; sdk: number };
  version?: string;
  startedAt?: number;
  driverStatusIntervalMs?: number;
  replayTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  uploadLimitBytes?: number;
  importLimitBytes?: number;
  /** This Mac's own addresses and host names, for /sdk pages (tests); default ownHostNames() per upgrade. */
  ownHostNames?: () => Iterable<string>;
  /** Temp cleanup while running (tests): every `tempCleanIntervalMs`, entries older than `tempMaxAgeMs`. */
  tempCleanIntervalMs?: number;
  tempMaxAgeMs?: number;
}

export interface SdkListenerState {
  host: string;
  port: number;
  listening: boolean;
  error?: string;
  /** errno code of the failed listen (e.g. 'EADDRINUSE'). */
  errorCode?: string;
}

export interface HttpApp {
  readonly server: http.Server;
  /** Bound HTTP port (the requested one before listen()). */
  readonly port: number;
  readonly host: string;
  /**
   * Loopback port of the device gateway, the target of `adb reverse tcp:9750` (see createHttpApp): it serves
   * only the /sdk WebSocket and GET /api/health. Undefined before listen() or when it could not listen.
   */
  readonly devicePort: number | undefined;
  /**
   * Bind the HTTP server, then the device gateway (127.0.0.1, a free port). Rejects (e.g. EADDRINUSE) without
   * side effects. Resolves with the bound HTTP port.
   */
  listen(port: number, host: string): Promise<number>;
  /** Close UI sockets, stop timers, close the HTTP server (drivers/SDK are stopped by server.ts). */
  close(): Promise<void>;
  info(): ServerInfo;
  readonly demoActive: boolean;
  setDemo(enabled: boolean): Promise<boolean>;
  /** (Re)bind the raw-TCP SDK listener on 127.0.0.1 or 0.0.0.0. Never throws; resolves with success. */
  bindSdk(lan: boolean): Promise<boolean>;
  readonly sdkListener: SdkListenerState;
  broadcast(message: ServerToUi): void;
  notice(notice: UiNotice): void;
  driverStatuses(): DriverStatus[];
  runDoctor(): Promise<ToolCheck[]>;
  uiClientCount(): number;
}

/** Non-internal IPv4 addresses (for Wi-Fi setup hints). */
export function hostAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.add(a.address);
    }
  }
  return [...out];
}

function safeStatus(d: { id: string; status(): DriverStatus }): DriverStatus {
  try {
    const s = d.status();
    if (s && typeof s === 'object') return { ...s, id: s.id ?? (d.id as DriverStatus['id']) };
  } catch (err) {
    return { id: d.id as DriverStatus['id'], available: false, active: false, detail: `Status unavailable: ${errorMessage(err)}`, code: 'driver.statusFailed' };
  }
  return { id: d.id as DriverStatus['id'], available: false, active: false };
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  const body = `${text}\n`;
  try {
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  } catch {
    socket.destroy();
  }
}

/** Split a request target into pathname + query without letting `//host/...` change the host part. */
function splitTarget(raw: string | undefined): { pathname: string; query: URLSearchParams } {
  let target = raw ?? '/';
  if (/^https?:\/\//i.test(target)) {
    try {
      const u = new URL(target);
      target = u.pathname + u.search;
    } catch {
      target = '/';
    }
  }
  const q = target.indexOf('?');
  const pathname = q >= 0 ? target.slice(0, q) : target;
  return { pathname: pathname.startsWith('/') ? pathname : `/${pathname}`, query: new URLSearchParams(q >= 0 ? target.slice(q + 1) : '') };
}

const SDK_CONFIG_KEYS = ['captureBodies', 'maxBodyBytes', 'metricsIntervalMs'] as const;

export function createHttpApp(deps: HttpAppDeps): HttpApp {
  const { hub, sdk, config, logger } = deps;
  const version = deps.version ?? SERVER_VERSION;
  const startedAt = deps.startedAt ?? Date.now();
  const vm = deps.vm ?? null;
  const demo = deps.demo ?? null;
  let boundPort = deps.ports.http;
  let boundHost = '127.0.0.1';
  let httpLan = false;
  let demoActive = false;
  let closed = false;
  let sdkListener: SdkListenerState = { host: '127.0.0.1', port: deps.ports.sdk, listening: false };
  let demoChain: Promise<unknown> = Promise.resolve();
  let sdkChain: Promise<unknown> = Promise.resolve();
  const sockets = new Set<Socket>();
  const unsubscribers: (() => void)[] = [];

  const allDrivers = (): DeviceDriver[] => (demo ? [...deps.drivers, demo] : [...deps.drivers]);

  function info(): ServerInfo {
    return {
      name: 'durbun',
      version,
      protocol: PROTOCOL_VERSION,
      ports: { http: boundPort, sdk: deps.ports.sdk },
      startedAt,
      demo: demoActive,
      lan: config.settings.allowLan,
      hostAddresses: hostAddresses(),
      dataDir: config.dataDir,
      platform: process.platform,
    };
  }

  function driverStatuses(): DriverStatus[] {
    const list = deps.drivers.map(safeStatus);
    if (vm) list.push(safeStatus({ id: 'flutter-vm', status: () => vm.status() }));
    if (demo) list.push(safeStatus(demo));
    return list;
  }

  function runDoctor(): Promise<ToolCheck[]> {
    const ports: PortState[] = [
      { id: 'port-http', label: `HTTP port ${boundPort}`, port: boundPort, host: boundHost, state: closed ? 'unknown' : 'listening' },
      {
        id: 'port-sdk',
        label: `SDK port ${sdkListener.port}`,
        port: sdkListener.port,
        host: sdkListener.host,
        state: sdkListener.listening ? 'listening' : sdkListener.error ? 'failed' : 'unknown',
        error: sdkListener.error,
      },
    ];
    return runDoctorChecks({ drivers: allDrivers(), vm, ports, uiDir: deps.uiDir, dataDir: config.dataDir });
  }

  /* ───────────── UI channel + commands ───────────── */

  const router = createCommandRouter({
    hub,
    sdk,
    config,
    logger: logger.child('commands'),
    drivers: allDrivers,
    vm,
    setDemo: (enabled) => setDemo(enabled),
    runDoctor,
    onLanChanged,
    replayTimeoutMs: deps.replayTimeoutMs,
    fetchImpl: deps.fetchImpl,
    tempDir: config.tempDir,
  });

  const ui = new UiChannel({
    hub,
    logger: logger.child('ui'),
    router,
    hello: () => ({ type: 'hello', server: info(), settings: config.settings }),
    snapshot: () => ({
      type: 'snapshot',
      devices: hub.getDevices(),
      apps: hub.getApps(),
      network: hub.getNetwork(),
      mocks: config.mocks,
      drivers: driverStatuses(),
      processes: hub.getProcesses(),
      metrics: hub.getMetrics(),
      logCount: hub.getLogCount(),
      deviceApps: hub.getDeviceApps(),
    }),
  });

  const broadcast = (message: ServerToUi) => ui.broadcast(message);
  const notice = (n: UiNotice) => ui.broadcast({ type: 'notice', ...n });

  function guard<A extends unknown[]>(what: string, fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      try {
        fn(...args);
      } catch (err) {
        logger.error(`${what} failed: ${errorMessage(err)}`);
      }
    };
  }

  unsubscribers.push(
    hub.subscribe(guard('hub batch', (change: HubChange) => ui.broadcastChange(change))),
    hub.onCleared(guard('hub cleared', (e: ClearEvent) => broadcast({ type: 'cleared', ...e }))),
    hub.onNotice(guard('hub notice', (n: UiNotice) => notice(n))),
    config.onSettings(
      guard('settings change', (settings: ServerSettings, previous: ServerSettings) => {
        try {
          hub.setSettings(settings);
        } catch (err) {
          logger.error(`hub.setSettings failed: ${errorMessage(err)}`);
        }
        if (SDK_CONFIG_KEYS.some((k) => settings[k] !== previous[k])) {
          try {
            sdk.setConfig({ captureBodies: settings.captureBodies, maxBodyBytes: settings.maxBodyBytes, metricsIntervalMs: settings.metricsIntervalMs });
          } catch (err) {
            logger.error(`sdk.setConfig failed: ${errorMessage(err)}`);
          }
        }
        broadcast({ type: 'settings', settings });
      }),
    ),
    config.onMocks(
      guard('mocks change', (rules: MockRule[]) => {
        try {
          sdk.setMocks(rules);
        } catch (err) {
          logger.error(`sdk.setMocks failed: ${errorMessage(err)}`);
        }
        broadcast({ type: 'mocks', rules });
      }),
    ),
    config.onWriteError(
      guard('config write error', (err: Error, file: string) =>
        notice({
          level: 'error',
          message: `Could not save ${file}: ${err.message}`,
          code: 'config.writeFailed',
          params: { file, error: err.message },
        }),
      ),
    ),
  );

  let lastDrivers = JSON.stringify(driverStatuses());
  const refreshDrivers = () => {
    const statuses = driverStatuses();
    const json = JSON.stringify(statuses);
    if (json === lastDrivers) return;
    lastDrivers = json;
    broadcast({ type: 'drivers', drivers: statuses });
  };
  const driverTimer = setInterval(guard('driver status refresh', refreshDrivers), deps.driverStatusIntervalMs ?? DRIVER_STATUS_INTERVAL_MS);
  driverTimer.unref();

  // Screenshots, recordings and uploads older than a day go while the app runs for days (config.ts).
  let tempCleaning = false;
  const tempTimer = setInterval(() => {
    if (tempCleaning || closed) return;
    tempCleaning = true;
    cleanTempDir(config.tempDir, deps.tempMaxAgeMs ?? TEMP_MAX_AGE_MS, Date.now(), TEMP_KEEP_WHILE_RUNNING)
      .then((removed) => {
        if (removed > 0) logger.debug(`removed ${removed} old temp entr${removed === 1 ? 'y' : 'ies'}`);
      })
      .catch((err) => logger.debug(`temp cleanup failed: ${errorMessage(err)}`))
      .finally(() => {
        tempCleaning = false;
      });
  }, deps.tempCleanIntervalMs ?? TEMP_CLEAN_INTERVAL_MS);
  tempTimer.unref();

  /* ───────────── demo + SDK listener ───────────── */

  function setDemo(enabled: boolean): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (!demo || !deps.demoContext) throw new CommandError('Demo mode is not available in this build', 'demo.unavailable');
      if (enabled && !demoActive) {
        await withTimeout(Promise.resolve().then(() => demo.start(deps.demoContext!)), DEMO_TIMEOUT_MS, 'Starting demo mode', 'demo.timeout');
        demoActive = true;
        logger.info('demo mode on');
      } else if (!enabled && demoActive) {
        demoActive = false;
        await withTimeout(Promise.resolve().then(() => demo.stop()), DEMO_TIMEOUT_MS, 'Stopping demo mode', 'demo.timeout');
        logger.info('demo mode off');
      }
      refreshDrivers();
      return demoActive;
    };
    const result = demoChain.then(run, run);
    demoChain = result.catch(() => undefined);
    return result;
  }

  function bindSdk(lan: boolean): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const host = lan ? '0.0.0.0' : '127.0.0.1';
      try {
        await sdk.listen(deps.ports.sdk, host);
        sdkListener = { host, port: deps.ports.sdk, listening: true };
        logger.debug(`SDK listener on ${host}:${deps.ports.sdk}`);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const message =
          code === 'EADDRINUSE' ? `Port ${deps.ports.sdk} is already used by another program` : `Could not listen on ${host}:${deps.ports.sdk}: ${errorMessage(err)}`;
        sdkListener = { host, port: deps.ports.sdk, listening: false, error: message, ...(code ? { errorCode: code } : {}) };
        logger.warn(`SDK listener: ${message}`);
        return false;
      }
    };
    const result = sdkChain.then(run, run);
    sdkChain = result.catch(() => undefined);
    return result;
  }

  async function onLanChanged(lan: boolean): Promise<void> {
    const ok = await bindSdk(lan);
    if (!ok) {
      notice({
        level: 'error',
        message: `Could not reopen the SDK port: ${sdkListener.error ?? 'unknown error'}`,
        code: 'settings.sdkRebindFailed',
        params: { port: deps.ports.sdk, error: sdkListener.error ?? '' },
      });
      return;
    }
    const restartNeeded = lan !== httpLan;
    const params = { sdkPort: deps.ports.sdk, httpPort: boundPort, restartRequired: restartNeeded ? 1 : 0 };
    const head = lan
      ? `SDK port ${deps.ports.sdk} now accepts app connections from your local network.`
      : `SDK port ${deps.ports.sdk} now accepts app connections from this computer only.`;
    const tail = restartNeeded ? ` The HTTP/WebSocket port ${boundPort} keeps its current binding until Dürbün is restarted.` : '';
    notice({ level: restartNeeded ? 'warn' : 'success', message: head + tail, code: lan ? 'settings.lanOn' : 'settings.lanOff', params });
  }

  /* ───────────── HTTP ───────────── */

  const staticHandler = createStaticHandler(deps.uiDir, () => ({ version }));
  const api = createApiHandler({
    hub,
    tempDir: config.tempDir,
    logger: logger.child('api'),
    version,
    runDoctor,
    uploadLimitBytes: deps.uploadLimitBytes,
    importLimitBytes: deps.importLimitBytes,
    slack: SlackStore.inDataDir(config.dataDir, logger.child('slack'), deps.fetchImpl),
  });

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname, query } = splitTarget(req.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const access = checkLocalAccess(req, boundPort);
      if (!access.ok) {
        logger.warn(`blocked ${req.method} ${pathname}: ${access.reason}`);
        sendError(res, 403, 'Forbidden', 'access.denied');
        return;
      }
      await api(req, res, pathname, query);
      return;
    }
    if (pathname === '/ui' || pathname === '/sdk') {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket', Connection: 'Upgrade' });
      res.end('This endpoint only accepts WebSocket connections.\n');
      return;
    }
    await staticHandler(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      logger.error(`${req.method} ${req.url} failed: ${errorMessage(err)}`);
      if (!res.headersSent) sendError(res, 500, 'Internal error', 'internal');
      else res.destroy();
    });
  });
  server.requestTimeout = 30 * 60_000; // large uploads / imports
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (err, socket) => {
    logger.debug(`client error: ${err.message}`);
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  const uiWss = new WebSocketServer({ noServer: true, maxPayload: UI_MAX_PAYLOAD, clientTracking: false });
  const sdkWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, clientTracking: true });

  /** /sdk upgrade, on the HTTP port and on the device gateway alike. */
  function upgradeSdk(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const access = checkSdkUpgrade(req, deps.ownHostNames?.());
    if (!access.ok) {
      logger.warn(`blocked WebSocket /sdk from ${req.socket.remoteAddress ?? '?'}: ${access.reason}`);
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    sdkWss.handleUpgrade(req, socket, head, (ws) => {
      const remote = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
      try {
        sdk.attachWebSocket(ws, { transport: 'websocket', remote });
      } catch (err) {
        logger.error(`SDK WebSocket from ${remote} rejected: ${errorMessage(err)}`);
        ws.close(1011, 'SDK layer unavailable');
      }
    });
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', (err) => logger.debug(`upgrade socket error: ${err.message}`));
    const { pathname } = splitTarget(req.url);
    if (closed) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if (pathname === '/ui' || pathname === '/ui/') {
      const access = checkLocalAccess(req, boundPort);
      if (!access.ok) {
        logger.warn(`blocked WebSocket /ui: ${access.reason}`);
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      uiWss.handleUpgrade(req, socket, head, (ws) => ui.attach(ws));
      return;
    }
    if (pathname === '/sdk' || pathname === '/sdk/') {
      upgradeSdk(req, socket, head);
      return;
    }
    rejectUpgrade(socket, 404, 'Not Found');
  });

  /* ───────────── device gateway ───────────── */

  /*
   * `adb reverse tcp:9750` makes the phone's localhost:9750 a loopback connection on this Mac, so every app
   * on a plugged-in phone would pass checkLocalAccess on the HTTP port (logs, bodies, mocks, device actions,
   * replay). The reverse mapping therefore points at this listener instead: 127.0.0.1 only, its own port,
   * and it serves what device apps need and nothing else (the /sdk WebSocket of React Native / the JS SDK
   * and GET /api/health, which another Dürbün probes before it leaves the device's route to us).
   */
  let gateway: http.Server | undefined;
  let devicePort: number | undefined;

  function onGatewayRequest(req: IncomingMessage, res: ServerResponse): void {
    const { pathname } = splitTarget(req.url);
    if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      // httpPort: the port the user knows this Dürbün by (another Dürbün names it when it leaves us the route).
      sendJson(res, 200, { ok: true, name: 'durbun', version, httpPort: boundPort });
      return;
    }
    if (pathname === '/sdk' || pathname === '/sdk/') {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket', Connection: 'Upgrade' });
      res.end('This endpoint only accepts WebSocket connections.\n');
      return;
    }
    logger.debug(`device gateway: refused ${req.method} ${pathname}`);
    sendError(res, 404, 'Not found', 'api.notFound');
  }

  async function listenGateway(): Promise<void> {
    const g = http.createServer(onGatewayRequest);
    g.requestTimeout = 30_000;
    g.headersTimeout = 10_000;
    g.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    g.on('clientError', (err, socket) => {
      if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    g.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', (err) => logger.debug(`gateway upgrade socket error: ${err.message}`));
      const { pathname } = splitTarget(req.url);
      if (closed) rejectUpgrade(socket, 503, 'Service Unavailable');
      else if (pathname === '/sdk' || pathname === '/sdk/') upgradeSdk(req, socket, head);
      else rejectUpgrade(socket, 404, 'Not Found');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        g.once('error', reject);
        g.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
          g.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      // Raw-TCP SDK connections (tcp:9751) still work; only React Native over USB goes without.
      logger.warn(`device gateway could not listen: ${errorMessage(err)} — React Native apps over USB cannot connect`);
      return;
    }
    g.on('error', (err) => logger.error(`device gateway error: ${err.message}`));
    const addr = g.address();
    gateway = g;
    devicePort = typeof addr === 'object' && addr ? addr.port : undefined;
  }

  async function listen(port: number, host: string): Promise<number> {
    const bound = await listenHttp(port, host);
    if (!gateway) await listenGateway();
    if (closed && gateway) gateway.close();
    return bound;
  }

  function listenHttp(port: number, host: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        boundPort = typeof addr === 'object' && addr ? addr.port : port;
        boundHost = host;
        httpLan = host === '0.0.0.0' || host === '::';
        server.on('error', (err) => logger.error(`HTTP server error: ${err.message}`));
        resolve(boundPort);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host, exclusive: true });
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(driverTimer);
    clearInterval(tempTimer);
    for (const u of unsubscribers) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    ui.closeAll(1001, 'Dürbün is shutting down');
    for (const ws of sdkWss.clients) ws.terminate();
    const serverClosed = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    server.closeIdleConnections();
    gateway?.close();
    gateway?.closeIdleConnections();
    const graceTimer = setTimeout(() => {
      for (const s of sockets) s.destroy();
    }, 1_000);
    graceTimer.unref();
    await Promise.race([serverClosed, new Promise<void>((r) => setTimeout(r, 3_000).unref())]);
    clearTimeout(graceTimer);
    for (const s of sockets) s.destroy();
    uiWss.close();
    sdkWss.close();
    ui.dispose();
  }

  return {
    server,
    get port() {
      return boundPort;
    },
    get devicePort() {
      return devicePort;
    },
    get host() {
      return boundHost;
    },
    listen,
    close,
    info,
    get demoActive() {
      return demoActive;
    },
    setDemo,
    bindSdk,
    get sdkListener() {
      return sdkListener;
    },
    broadcast,
    notice,
    driverStatuses,
    runDoctor,
    uiClientCount: () => ui.size,
  };
}
