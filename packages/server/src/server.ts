/**
 * Server wiring (SPEC §5.1): config → hub → SDK layer → platform drivers / Flutter VM module / demo driver
 * → HTTP + WebSocket → SDK TCP listener → drivers started in the background, each isolated (a driver that
 * throws or hangs never stops the server). Modules that fail to construct are replaced by "unavailable"
 * stand-ins that report the reason through driver status and the doctor. Only a failing hub (nothing can
 * work without the store) or an unusable HTTP port aborts the start.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { DeviceActionResult, DriverStatus, ToolCheck } from '@durbun/protocol';
import { defaultDataDir, expandHome, loadConfig } from './config';
import { acquireDataDirLock, DATA_DIR_IN_USE_CODE, DataDirInUseError, type DataDirLock } from './dataDirLock';
import { createDemoDriver } from './demo/index';
import { createHttpApp, resolveUiDir, type HttpApp, type HttpAppDeps } from './http/index';
import { errorMessage } from './http/util';
import { createFlutterVmModule } from './platform/flutterVm/index';
import { createPlatform } from './platform/index';
import { createHub } from './hub/index';
import { createSdkLayer } from './sdk/index';
import type {
  CreateHubOptions,
  CreateSdkLayerOptions,
  DeviceDriver,
  DriverContext,
  FlutterVmModule,
  Hub,
  Logger,
  Platform,
  PlatformServices,
  RunningServer,
  SdkLayer,
  ServerNotice,
  StartServerOptions,
  VirtualSdkSession,
} from './types';
import { createLogger, redactingLogger, setLogLevel } from './util/logger';
import { SERVER_VERSION } from './version';

/** Version of this server bundle (the Mac app compares it with a Dürbün it attaches to). */
export { SERVER_VERSION };
export type { ServerNotice };

/** Constructors of the modules owned by other teams (injectable for tests). */
export interface ServerFactories {
  createHub(opts: CreateHubOptions): Hub;
  createSdkLayer(opts: CreateSdkLayerOptions): SdkLayer;
  createPlatform(): Platform;
  createFlutterVmModule(): FlutterVmModule;
  createDemoDriver(): DeviceDriver;
}

export const defaultFactories: ServerFactories = {
  createHub,
  createSdkLayer,
  createPlatform,
  createFlutterVmModule,
  createDemoDriver,
};

export interface StartedServer extends RunningServer {
  /** Problems the user should know about (printed by the CLI banner). */
  readonly warnings: string[];
  /** The same problems with codes and parameters, in the same order, for hosts that word them (ServerNotice). */
  readonly notices?: ServerNotice[];
  readonly uiDir: string | null;
  readonly dataDir: string;
  readonly sdkListening: boolean;
  readonly app: HttpApp;
  /**
   * The Mac woke from sleep: every driver checks its streams and port forwards and restarts what died
   * (DeviceDriver.resume). Never throws; calls within a few seconds of the last one are folded into it
   * (sleep/wake and screen unlock often arrive together), so it is safe to call on every wake event.
   */
  onSystemResume(): void;
}

export interface StartServerExtras {
  logger?: Logger;
  /** How long startServer waits for driver start() calls before resolving (they continue in the background). */
  driverStartWaitMs?: number;
  /** Directory used to locate the bundled UI (defaults to the running module's directory). */
  moduleDir?: string;
  /** Extra options for the HTTP app (tests: shorter intervals, fetch stub). */
  http?: Partial<Pick<HttpAppDeps, 'driverStatusIntervalMs' | 'replayTimeoutMs' | 'fetchImpl'>>;
}

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly port?: number,
  ) {
    super(message);
    this.name = 'ServerStartError';
  }
}

const PLATFORM_DRIVER_IDS = ['android', 'ios-sim', 'ios-device'] as const;
const DRIVER_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_DRIVER_START_WAIT_MS = 3_000;
/** Wake events within this window after a resume run are folded into it. */
export const SYSTEM_RESUME_DEBOUNCE_MS = 5_000;
/** A driver whose resume() hangs is logged and left behind after this long (the next wake tries again). */
const DRIVER_RESUME_TIMEOUT_MS = 15_000;

/* ────────────────────────────── stand-ins for modules that failed to load ────────────────────────────── */

export function unavailableDriver(id: DeviceDriver['id'], reason: string): DeviceDriver {
  return {
    id,
    start: async () => {},
    stop: async () => {},
    status: (): DriverStatus => ({ id, available: false, active: false, detail: `Failed to initialize: ${reason}`, code: 'driver.initFailed' }),
    checks: async (): Promise<ToolCheck[]> => [
      { id: `driver-${id}`, label: id, status: 'error', detail: `The ${id} driver failed to initialize: ${reason}` },
    ],
    owns: () => false,
    runAction: async (): Promise<DeviceActionResult> => ({ ok: false, error: `The ${id} driver is unavailable: ${reason}`, code: 'driver.initFailed' }),
  };
}

export function unavailableVm(reason: string): FlutterVmModule {
  return {
    start: async () => {},
    stop: async () => {},
    status: () => ({ id: 'flutter-vm', available: false, active: false, detail: `Failed to initialize: ${reason}`, code: 'driver.initFailed' }),
    checks: async () => [{ id: 'flutter-vm', label: 'Flutter VM Service', status: 'error', detail: `Failed to initialize: ${reason}` }],
    attach: async () => {
      throw new Error(`The Flutter VM Service module is unavailable: ${reason}`);
    },
    detach: async () => {},
  };
}

export function unavailableServices(reason: string): PlatformServices {
  return {
    forwardToDevice: async () => {
      throw new Error(`Port forwarding is unavailable: ${reason}`);
    },
  };
}

/** SDK layer stand-in: refuses connections, so device logs keep working without app SDK support. */
export function unavailableSdk(reason: string): SdkLayer {
  return {
    attachStream: (stream) => stream.destroy(),
    attachWebSocket: (ws) => ws.close(1011, 'SDK layer unavailable'),
    openVirtual: (): VirtualSdkSession => {
      const appId = Promise.reject(new Error(`SDK layer unavailable: ${reason}`));
      appId.catch(() => {});
      return { send: () => {}, onMessage: () => () => {}, close: () => {}, closed: true, appId };
    },
    listen: async () => {
      throw new Error(`SDK layer unavailable: ${reason}`);
    },
    setMocks: () => {},
    setConfig: () => {},
    sendCommand: async () => ({ ok: false, error: `SDK layer unavailable: ${reason}`, code: 'sdk.unavailable' }),
    connectionCount: () => 0,
    close: async () => {},
  };
}

/* ────────────────────────────── helpers ────────────────────────────── */

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Run a start function; failures are logged, never thrown. */
function startIsolated(name: string, fn: () => Promise<void>, logger: Logger): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => logger.debug(`${name} started`),
      (err) => logger.warn(`${name} failed to start: ${errorMessage(err)} — continuing without it`),
    );
}

/** Run a stop/close function with a timeout; failures are logged, never thrown. */
async function settle(name: string, fn: () => Promise<unknown>, logger: Logger, timeoutMs = DRIVER_STOP_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (err) {
    logger.warn(`${name}: ${errorMessage(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ────────────────────────────── start ────────────────────────────── */

/**
 * Start a complete Dürbün server in this process. This is the programmatic entry used by the CLI and by
 * embedding hosts such as the Mac app (SPEC §10.7):
 *
 *   const server = await startServer({ httpPort: 9750, sdkPort: 9751, demo: false, dataDir, uiDir, verbose: false });
 *   window.loadURL(server.url);            // http://127.0.0.1:<bound port>
 *   app.on('before-quit', () => server.stop());
 *
 * It never calls process.exit, never reads stdin and installs no signal / uncaughtException handlers
 * (the CLI adds those itself with installShutdownHandlers). It rejects with a ServerStartError
 * (`code` 'EADDRINUSE' | 'EACCES' | 'hub.failed' | …) when the HTTP port cannot be used; use
 * probeServer(port) to tell "another Dürbün is already running there" from "another program".
 * Everything else (missing adb / Xcode, SDK port taken, a driver failing) is reported through
 * `warnings`, driver status and the doctor, never thrown. `stop()` is idempotent and stops every child
 * process the drivers started. `httpPort: 0` binds a free port (`url` has the real one).
 */
export function startServer(opts: StartServerOptions, extras: StartServerExtras = {}): Promise<StartedServer> {
  return startServerWith(opts, defaultFactories, extras);
}

/** Is a Dürbün server answering on this port (GET /api/health)? Resolves with its version, never rejects. */
export async function probeServer(port: number, timeoutMs = 1_500): Promise<{ version: string } | undefined> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; name?: unknown; version?: unknown };
    if (body && body.ok === true && body.name === 'durbun') return { version: String(body.version ?? '?') };
  } catch {
    /* nothing there, or not HTTP */
  }
  return undefined;
}

export async function startServerWith(opts: StartServerOptions, factories: ServerFactories, extras: StartServerExtras = {}): Promise<StartedServer> {
  const lock = await lockDataDir(opts.dataDir);
  try {
    return await startLocked(opts, factories, extras, lock);
  } catch (err) {
    await lock.release();
    throw err;
  }
}

/** One server per data folder (see dataDirLock.ts); the lock is taken before the config files are read. */
async function lockDataDir(dataDirInput: string): Promise<DataDirLock> {
  const dir = path.resolve(expandHome(dataDirInput || defaultDataDir()));
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Not creatable: loadConfig falls back to a temp folder and says so; that run goes unlocked.
    return { file: '', setPort: async () => {}, release: async () => {} };
  }
  try {
    return await acquireDataDirLock(dir, { probe: async (port) => !!(await probeServer(port)) });
  } catch (err) {
    if (err instanceof DataDirInUseError) throw new ServerStartError(err.message, DATA_DIR_IN_USE_CODE, err.holder.port);
    throw err;
  }
}

async function startLocked(opts: StartServerOptions, factories: ServerFactories, extras: StartServerExtras, lock: DataDirLock): Promise<StartedServer> {
  // No line may carry a secret (Dart VM service tokens), whatever logger the embedder passed.
  const logger = redactingLogger(extras.logger ?? createLogger('durbun'));
  if (opts.verbose) setLogLevel('debug');
  const warnings: string[] = [];
  const notices: ServerNotice[] = [];
  const warn = (code: string, message: string, params?: ServerNotice['params']) => {
    warnings.push(message);
    notices.push(params ? { code, params, message } : { code, message });
  };

  const config = await loadConfig(opts.dataDir, { lanOverride: opts.lan, logger: logger.child('config') });
  warnings.push(...config.warnings);
  notices.push(...(config.notices ?? config.warnings.map((message) => ({ code: 'config.invalid', message }))));

  let hub: Hub;
  try {
    hub = factories.createHub({ settings: config.settings, logger: logger.child('hub') });
  } catch (err) {
    throw new ServerStartError(`The log store (hub) could not be created: ${errorMessage(err)}`, 'hub.failed');
  }

  let sdk: SdkLayer;
  try {
    sdk = factories.createSdkLayer({
      hub,
      logger: logger.child('sdk'),
      settings: () => config.settings,
      mocks: () => config.mocks,
      serverVersion: SERVER_VERSION,
    });
  } catch (err) {
    const reason = errorMessage(err);
    logger.error(`SDK layer failed to initialize: ${reason}`);
    warn('sdk.unavailable', `App SDK connections are unavailable: ${reason}`, { reason });
    sdk = unavailableSdk(reason);
  }

  let platform: Platform;
  try {
    platform = factories.createPlatform();
    if (!platform || !Array.isArray(platform.drivers)) throw new Error('createPlatform() returned no drivers');
  } catch (err) {
    const reason = errorMessage(err);
    logger.error(`device drivers failed to initialize: ${reason}`);
    warn('drivers.unavailable', `Device drivers are unavailable: ${reason}`, { reason });
    platform = { drivers: PLATFORM_DRIVER_IDS.map((id) => unavailableDriver(id, reason)), services: unavailableServices(reason) };
  }

  let vm: FlutterVmModule;
  try {
    vm = factories.createFlutterVmModule();
  } catch (err) {
    const reason = errorMessage(err);
    logger.error(`Flutter VM module failed to initialize: ${reason}`);
    warn('vm.unavailable', `Flutter VM Service capture is unavailable: ${reason}`, { reason });
    vm = unavailableVm(reason);
  }

  let demo: DeviceDriver | null;
  try {
    demo = factories.createDemoDriver();
  } catch (err) {
    const reason = errorMessage(err);
    logger.warn(`demo driver failed to initialize: ${reason}`);
    if (opts.demo) warn('demo.unavailable', `Demo mode is unavailable: ${reason}`, { reason });
    demo = null;
  }

  const ui = resolveUiDir(opts.uiDir, extras.moduleDir);
  if (ui.explicitInvalid) {
    warn('ui.dirInvalid', `--ui-dir ${ui.explicitInvalid} has no index.html; ${ui.dir ? `using ${ui.dir} instead` : 'serving the placeholder page'}`, {
      dir: ui.explicitInvalid,
      ...(ui.dir ? { fallback: ui.dir } : {}),
    });
  }
  if (!ui.dir) warn('ui.missing', 'The web UI is not built yet: run "npm run build" (the browser shows a placeholder page until then).');

  // Mutable: ports.http becomes the bound port and ports.device the device gateway after listen() (drivers read them when they start).
  const ports: DriverContext['ports'] = { http: opts.httpPort, sdk: opts.sdkPort };
  const baseContext: DriverContext = {
    hub,
    getDevices: () => hub.getDevices(),
    getApps: () => hub.getApps(),
    getDeviceApps: () => hub.getDeviceApps(),
    onLogs: (listener) => hub.onLogs(listener),
    sdk,
    settings: () => config.settings,
    onSettings: (listener) => config.onSettings((settings) => listener(settings)),
    logger: logger.child('driver'),
    tempDir: config.tempDir,
    fileUrl: (fileName) => `/api/files/${encodeURIComponent(fileName)}`,
    ports,
  };
  const contextFor = (id: string): DriverContext => ({ ...baseContext, logger: logger.child(id) });

  const app = createHttpApp({
    hub,
    sdk,
    drivers: platform.drivers,
    vm,
    demo,
    config,
    logger: logger.child('http'),
    demoContext: contextFor('demo'),
    uiDir: ui.dir,
    ports,
    version: SERVER_VERSION,
    ...extras.http,
  });

  const lan = config.settings.allowLan;
  try {
    ports.http = await app.listen(opts.httpPort, lan ? '0.0.0.0' : '127.0.0.1');
    if (app.devicePort !== undefined) ports.device = app.devicePort;
    await lock.setPort(ports.http);
  } catch (err) {
    await app.close().catch(() => {});
    await settle('sdk.close', () => sdk.close(), logger, 2_000);
    try {
      hub.dispose();
    } catch {
      /* ignore */
    }
    await config.flush();
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') throw new ServerStartError(`Port ${opts.httpPort} is already in use`, 'EADDRINUSE', opts.httpPort);
    if (code === 'EACCES') throw new ServerStartError(`No permission to listen on port ${opts.httpPort}`, 'EACCES', opts.httpPort);
    throw new ServerStartError(`The HTTP server could not start: ${errorMessage(err)}`, code, opts.httpPort);
  }

  if (!(await app.bindSdk(lan))) {
    const message = `SDK port ${opts.sdkPort}: ${app.sdkListener.error ?? 'not listening'} — apps on simulators or Wi-Fi cannot connect over TCP (Android over USB still works).`;
    if (app.sdkListener.errorCode === 'EADDRINUSE') warn('sdk.portBusy', message, { port: opts.sdkPort });
    else warn('sdk.listenFailed', message, { port: opts.sdkPort, error: app.sdkListener.error ?? 'not listening' });
  }

  const starts: Promise<void>[] = platform.drivers.map((driver) =>
    startIsolated(`driver ${driver.id}`, () => driver.start(contextFor(driver.id)), logger),
  );
  starts.push(startIsolated('Flutter VM module', () => vm.start({ ...contextFor('flutter-vm'), platform: platform.services }), logger));

  if (opts.demo) {
    try {
      await app.setDemo(true);
    } catch (err) {
      warn('demo.startFailed', `Demo mode could not start: ${errorMessage(err)}`, { reason: errorMessage(err) });
    }
  }
  await Promise.race([Promise.allSettled(starts), delay(extras.driverStartWaitMs ?? DEFAULT_DRIVER_START_WAIT_MS)]);

  let stopping: Promise<void> | undefined;
  let lastResumeAt = Number.NEGATIVE_INFINITY;
  let resuming = false;
  const onSystemResume = (): void => {
    try {
      const now = Date.now();
      if (stopping || resuming || now - lastResumeAt < SYSTEM_RESUME_DEBOUNCE_MS) return;
      lastResumeAt = now;
      resuming = true;
      const drivers = demo ? [...platform.drivers, demo] : platform.drivers;
      logger.debug('system resumed: checking device drivers');
      const tasks = drivers.map((d) =>
        typeof d.resume === 'function' ? settle(`resuming driver ${d.id}`, () => Promise.resolve(d.resume?.()), logger, DRIVER_RESUME_TIMEOUT_MS) : Promise.resolve(),
      );
      void Promise.all(tasks).finally(() => {
        resuming = false;
      });
    } catch (err) {
      resuming = false;
      logger.warn(`system resume: ${errorMessage(err)}`);
    }
  };

  const shutdown = async (): Promise<void> => {
    logger.debug('shutting down');
    // Let in-flight starts settle so their child processes get stopped too.
    await Promise.race([Promise.allSettled(starts), delay(3_000)]);
    const tasks: Promise<void>[] = platform.drivers.map((d) => settle(`stopping driver ${d.id}`, () => d.stop(), logger));
    tasks.push(settle('stopping the Flutter VM module', () => vm.stop(), logger));
    if (app.demoActive) tasks.push(settle('stopping demo mode', () => app.setDemo(false), logger));
    await Promise.all(tasks);
    await settle('closing the SDK layer', () => sdk.close(), logger, 3_000);
    await app.close();
    try {
      hub.dispose();
    } catch (err) {
      logger.warn(`hub.dispose: ${errorMessage(err)}`);
    }
    await config.flush();
    await lock.release();
    logger.debug('stopped');
  };

  return {
    // Never "localhost": browsers try ::1 first, where another program may listen; the server binds IPv4.
    url: `http://127.0.0.1:${ports.http}`,
    get info() {
      return app.info();
    },
    stop: () => (stopping ??= shutdown()),
    onSystemResume,
    warnings,
    notices,
    uiDir: ui.dir,
    dataDir: config.dataDir,
    get sdkListening() {
      return app.sdkListener.listening;
    },
    app,
  };
}

/* ────────────────────────────── process signals ────────────────────────────── */

export interface ShutdownHandlerOptions {
  log?: (line: string) => void;
  /** Hard limit for a graceful stop (default 10 s). */
  timeoutMs?: number;
  exit?: (code: number) => void;
}

/**
 * SIGINT/SIGTERM/SIGHUP → graceful stop → exit 0. A second signal forces an immediate exit (130).
 * Returns a function that removes the handlers.
 */
export function installShutdownHandlers(server: Pick<RunningServer, 'stop'>, opts: ShutdownHandlerOptions = {}): () => void {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let received = 0;
  const handler = (signal: NodeJS.Signals) => {
    received++;
    if (received > 1) {
      log('Zorla çıkılıyor · forcing exit');
      exit(130);
      return;
    }
    log(`\nKapatılıyor… · shutting down… (${signal}; tekrar Ctrl+C = zorla çık · press Ctrl+C again to force)`);
    const timer = setTimeout(() => {
      log('Kapatma zaman aşımına uğradı · shutdown timed out, forcing exit');
      exit(1);
    }, opts.timeoutMs ?? 10_000);
    timer.unref();
    server.stop().then(
      () => {
        clearTimeout(timer);
        exit(0);
      },
      (err) => {
        clearTimeout(timer);
        log(`Kapatma hatası · shutdown error: ${errorMessage(err)}`);
        exit(1);
      },
    );
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
