/**
 * SDK routing for one Android device (SPEC §2.1 / §5.5): a 127.0.0.1 listener on a dynamic port plus
 *   adb -s S reverse tcp:9751 tcp:<dyn>           (raw NDJSON SDK transport → we know the device)
 *   adb -s S reverse tcp:9750 tcp:<gateway port>  (React Native WebSocket /sdk)
 * Accepted sockets go to ctx.sdk.attachStream(socket, { transport: 'adb-reverse', deviceId }).
 * tcp:9750 never points at the HTTP port itself: a reversed connection arrives from 127.0.0.1, which the
 * HTTP port trusts with everything (/api, /ui), so any app on the phone could read and steer Dürbün. The
 * device gateway (`ctx.ports.device`, see http/app.ts) serves /sdk and GET /api/health only.
 *
 * Two Dürbüns on one computer (the Mac app next to a CLI or test server) see the same phones, but a phone
 * has one tcp:9751 and one tcp:9750. Re-pointing them on every check made the two take the route from each
 * other every 10 s, so the first one keeps it: while tcp:9750 points to a port where another Dürbün answers
 * GET /api/health and its tcp:9751 listener accepts connections, ensure() leaves both mappings alone and says
 * so (log + a system line on the device, pushed again while we keep yielding once the line may be gone: see
 * `routeNoticeRepeatMs`). Mappings with nothing behind them (connection refused: a killed Dürbün) or with
 * another program behind them are taken over at once. A Dürbün that does not answer in time (busy event loop,
 * paused in a debugger) or whose SDK listener is missing or dead gets `takeOverAfterChecks` checks before we
 * take its route (it may only be busy, or it restarted without Android support and no longer serves us).
 */
import net from 'node:net';
import { DEFAULT_PORTS } from '@durbun/protocol';
import type { DriverContext, Logger } from '../../types';
import type { Adb } from './adb';
import type { PortMapping } from './parsers';

export interface ReverseRouterDeps {
  adb: () => Adb | null;
  serial: string;
  deviceId: string;
  ctx: DriverContext;
  logger: Logger;
}

export const REVERSE_TIMING = {
  /** Health / connect probes of another Dürbün's ports (local, so this is generous). */
  probeTimeoutMs: 1500,
  /**
   * Checks (ensure() runs every 10 s) another Dürbün may miss (no health answer in time, or no live SDK
   * listener) before we take its route.
   */
  takeOverAfterChecks: 2,
  /**
   * While we yield, the system line is pushed again after this long: "clear logs" may have removed it, and
   * nothing else on the device says where its SDK apps are (DeviceInfo has no field for it yet).
   */
  routeNoticeRepeatMs: 10 * 60_000,
};

/** System line (params `{ port }`): this device's SDK connections go to the Dürbün on that HTTP port. */
export const ROUTE_ELSEWHERE_CODE = 'sdk.routeElsewhere';

/**
 * GET /api/health on 127.0.0.1:<port> (same check as server.ts probeServer):
 * 'durbun' answered as a Dürbün; 'notDurbun' another program answered (or not HTTP / not JSON);
 * 'refused' nothing listens there; 'noAnswer' it accepted but gave no answer in time or dropped the connection.
 */
export type DurbunProbe = 'durbun' | 'notDurbun' | 'refused' | 'noAnswer';

export async function probeDurbun(port: number, timeoutMs = REVERSE_TIMING.probeTimeoutMs): Promise<DurbunProbe> {
  return (await probeHealth(port, timeoutMs)).state;
}

/**
 * probeDurbun plus the HTTP port that Dürbün reports (`httpPort`: its device gateway answers on another
 * port than the one the user opens; older builds reverse tcp:9750 to the HTTP port and report none).
 */
async function probeHealth(port: number, timeoutMs: number): Promise<{ state: DurbunProbe; httpPort?: number }> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return { state: 'refused' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { state: 'notDurbun' };
    }
    const body = (await res.json()) as { ok?: unknown; name?: unknown; httpPort?: unknown } | null;
    if (!body || body.ok !== true || body.name !== 'durbun') return { state: 'notDurbun' };
    const httpPort = Number(body.httpPort);
    return Number.isInteger(httpPort) && httpPort > 0 && httpPort <= 65_535 ? { state: 'durbun', httpPort } : { state: 'durbun' };
  } catch (e) {
    if (e instanceof SyntaxError) return { state: 'notDurbun' }; // body is not JSON
    const err = e as { code?: unknown; cause?: { code?: unknown } };
    const code = String(err.cause?.code ?? err.code ?? '');
    if (code === 'ECONNREFUSED') return { state: 'refused' };
    if (code.startsWith('HPE_')) return { state: 'notDurbun' }; // undici: the answer is not HTTP
    return { state: 'noAnswer' }; // TimeoutError, ECONNRESET, "other side closed", …
  }
}

/** Does a Dürbün answer GET /api/health on 127.0.0.1:<port>? */
export async function durbunAnswersAt(port: number, timeoutMs = REVERSE_TIMING.probeTimeoutMs): Promise<boolean> {
  return (await probeDurbun(port, timeoutMs)) === 'durbun';
}

/** Does anything accept a TCP connection on 127.0.0.1:<port>? The socket is closed at once, nothing is sent. */
export function acceptsConnections(port: number, timeoutMs = REVERSE_TIMING.probeTimeoutMs): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Host port a device port is reversed to ("tcp:9750 tcp:54321" → 54321); undefined when not a TCP target. */
function hostPortOf(list: PortMapping[], devicePort: number): number | undefined {
  const remote = list.find((m) => m.local === `tcp:${devicePort}`)?.remote;
  const port = Number(remote ? /^tcp:(\d{1,5})$/.exec(remote)?.[1] : undefined);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

export class AdbReverseRouter {
  private server?: net.Server;
  private port?: number;
  private readonly sockets = new Set<net.Socket>();
  private closed = false;
  private lastError?: string;
  /** Port tcp:9750 maps to for the other Dürbün whose route we leave alone (announced once per owner, see `noticeGone`). */
  private yieldedTo?: number;
  /** HTTP port that Dürbün reports (its UI), else `yieldedTo`. */
  private yieldedHttp?: number;
  /** Consecutive checks that found that Dürbün not answering in time, or its SDK listener missing or dead. */
  private deadChecks = 0;
  /** The routeElsewhere line pushed for `yieldedTo`: when, and its hub log id. */
  private notice?: { at: number; logId?: number };
  /** Newest hub log id seen while yielding (tells when the shared ring has evicted our line). */
  private newestLogId = 0;
  private unsubLogs?: () => void;

  constructor(private readonly deps: ReverseRouterDeps) {}

  get localPort(): number | undefined {
    return this.port;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** HTTP port of the other Dürbün that holds this device's SDK route, while we leave it alone. */
  get heldBy(): number | undefined {
    return this.yieldedHttp ?? this.yieldedTo;
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  async start(): Promise<void> {
    if (this.server || this.closed) return;
    const server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    server.on('error', (err) => this.deps.logger.warn(`reverse listener ${this.deps.serial}: ${err.message}`));
    server.unref();
    this.server = server;
    const addr = server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : undefined;
  }

  /** Re-apply missing mappings (unless another Dürbün holds the route). Returns true when both are ours and in place. */
  async ensure(): Promise<boolean> {
    const adb = this.deps.adb();
    if (!adb || !this.port || this.closed) return false;
    const { serial, ctx } = this.deps;
    const list = await adb.reverseList(serial);
    if (list && (await this.leaveToOtherDurbun(list))) return false;
    const wanted: Array<[number, number]> = [[DEFAULT_PORTS.sdk, this.port]];
    const gateway = ctx.ports.device;
    if (gateway) wanted.push([DEFAULT_PORTS.http, gateway]);
    else if (list?.some((m) => m.local === `tcp:${DEFAULT_PORTS.http}` && m.remote === `tcp:${ctx.ports.http}`)) {
      // No device gateway: never leave the phone a route to the HTTP port (an older build's mapping).
      await adb.reverseRemove(serial, DEFAULT_PORTS.http);
    }
    let ok = true;
    for (const [devicePort, hostPort] of wanted) {
      if (this.closed) return false;
      const present = list?.some((m) => m.local === `tcp:${devicePort}` && m.remote === `tcp:${hostPort}`);
      if (present) continue;
      const r = await adb.reverse(serial, devicePort, hostPort);
      if (!r.ok) {
        ok = false;
        this.lastError = (r.error ?? r.stderr.trim()) || `adb reverse failed (exit ${r.code})`;
        this.deps.logger.debug(`adb reverse tcp:${devicePort} on ${serial} failed: ${this.lastError}`);
      } else {
        this.deps.logger.debug(`adb reverse tcp:${devicePort} → tcp:${hostPort} on ${serial}`);
      }
    }
    if (ok) this.lastError = undefined;
    return ok;
  }

  /** Close the listener and SDK sockets; optionally remove our reverse mappings from the device. */
  async stop(removeMappings: boolean): Promise<void> {
    this.closed = true;
    this.release();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!removeMappings) return;
    const adb = this.deps.adb();
    if (!adb) return;
    const { serial, ctx } = this.deps;
    const list = await adb.reverseList(serial);
    if (!list) return;
    const ours: Array<[number, number | undefined]> = [
      [DEFAULT_PORTS.sdk, this.port],
      [DEFAULT_PORTS.http, ctx.ports.device],
      [DEFAULT_PORTS.http, ctx.ports.http], // an older build's mapping
    ];
    const removed = new Set<number>();
    for (const [devicePort, hostPort] of ours) {
      if (removed.has(devicePort)) continue;
      if (hostPort && list.some((m) => m.local === `tcp:${devicePort}` && m.remote === `tcp:${hostPort}`)) {
        removed.add(devicePort);
        await adb.reverseRemove(serial, devicePort);
      }
    }
  }

  /**
   * true = another Dürbün holds this device's route: tcp:9750 points to its answering device gateway (an
   * older build: its HTTP port) and its tcp:9751 listener is alive (or is given `takeOverAfterChecks` checks
   * to come back). See the header.
   */
  private async leaveToOtherDurbun(list: PortMapping[]): Promise<boolean> {
    const { serial, ctx, logger } = this.deps;
    const http = hostPortOf(list, DEFAULT_PORTS.http);
    // Ours: our gateway, or our own HTTP port from an older build (re-pointed to the gateway by ensure()).
    if (http === undefined || http === ctx.ports.device || http === ctx.ports.http) {
      this.release();
      return false;
    }
    const health = await probeHealth(http, REVERSE_TIMING.probeTimeoutMs);
    const probe = health.state;
    if (this.closed) return true;
    if (probe === 'refused' || probe === 'notDurbun') {
      // A killed Dürbün (nothing listens) or another program on that port: nobody to leave the route to.
      this.release();
      return false;
    }
    if (probe === 'noAnswer') {
      // Busy (a large import, a debugger pause) or hung: one slow answer must not cut its SDK connections.
      return this.missedCheck(http, `does not answer GET /api/health within ${REVERSE_TIMING.probeTimeoutMs} ms`);
    }
    const sdk = hostPortOf(list, DEFAULT_PORTS.sdk);
    const serving = sdk !== undefined && sdk !== this.port && (await acceptsConnections(sdk));
    if (this.closed) return true;
    // Missing / dead listener, or tcp:9751 half taken by us: let that Dürbün repair its route first.
    if (!serving) return this.missedCheck(http, `has no live tcp:${DEFAULT_PORTS.sdk} listener`);
    this.deadChecks = 0;
    const owner = health.httpPort ?? http;
    if (this.yieldedTo !== http || this.yieldedHttp !== owner) {
      this.yieldedTo = http;
      this.yieldedHttp = owner;
      this.lastError = `adb reverse tcp:${DEFAULT_PORTS.sdk} / tcp:${DEFAULT_PORTS.http} belong to another Dürbün (port ${owner})`;
      logger.info(`${serial}: SDK connections from this device go to another Dürbün on port ${owner}; leaving its adb reverse mappings alone`);
      this.announce(owner);
    } else if (this.noticeGone()) {
      this.announce(owner);
    }
    return true;
  }

  /** A check the other Dürbün on `http` missed: true = still leave it the route, false = take it over now. */
  private missedCheck(http: number, why: string): boolean {
    const { serial, logger } = this.deps;
    this.deadChecks += 1;
    if (this.deadChecks < REVERSE_TIMING.takeOverAfterChecks) {
      logger.debug(`${serial}: the Dürbün on port ${http} ${why}; checking again`);
      return true;
    }
    logger.info(`${serial}: the Dürbün on port ${http} ${why} again; taking this device's SDK connections over`);
    this.release();
    return false;
  }

  /** We no longer yield (route ours, free, or taken over). */
  private release(): void {
    this.yieldedTo = undefined;
    this.yieldedHttp = undefined;
    this.deadChecks = 0;
    this.notice = undefined;
    this.newestLogId = 0;
    this.unsubLogs?.();
    this.unsubLogs = undefined;
  }

  /** Push the routeElsewhere system line for the Dürbün on `port` (and watch the log ring while we yield). */
  private announce(port: number): void {
    const { serial, ctx, logger, deviceId } = this.deps;
    if (!this.unsubLogs) {
      try {
        this.unsubLogs = ctx.onLogs((entries) => {
          const id = entries[entries.length - 1]?.id;
          if (typeof id === 'number' && id > this.newestLogId) this.newestLogId = id;
        });
      } catch (e) {
        logger.debug(`${serial}: onLogs subscription failed: ${(e as Error).message}`);
      }
    }
    let logId: number | undefined;
    try {
      logId = ctx.hub.pushSystemLog(deviceId, {
        level: 'warn',
        code: ROUTE_ELSEWHERE_CODE,
        message: `This device's SDK connections go to another Dürbün running on this computer (localhost:${port}). Apps with the SDK show up there; device logs still appear here.`,
        params: { port },
      })?.id;
    } catch (e) {
      logger.debug(`${serial}: system line failed: ${(e as Error).message}`);
    }
    this.notice = { at: Date.now(), logId };
    if (typeof logId === 'number' && logId > this.newestLogId) this.newestLogId = logId;
  }

  /**
   * The routeElsewhere line may no longer be in the hub: the shared ring has taken `maxLogEntries` newer
   * lines since (minutes with a busy iPhone attached), or `routeNoticeRepeatMs` passed ("clear logs" is not
   * visible to drivers).
   */
  private noticeGone(): boolean {
    const notice = this.notice;
    if (!notice) return true;
    if (Date.now() - notice.at >= REVERSE_TIMING.routeNoticeRepeatMs) return true;
    let cap: number | undefined;
    try {
      cap = this.deps.ctx.settings().maxLogEntries;
    } catch {
      cap = undefined;
    }
    return typeof notice.logId === 'number' && typeof cap === 'number' && cap > 0 && this.newestLogId - notice.logId >= cap;
  }

  private onConnection(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {
      /* reported by the SDK layer */
    });
    try {
      this.deps.ctx.sdk.attachStream(socket, {
        transport: 'adb-reverse',
        deviceId: this.deps.deviceId,
        remote: `adb-reverse:${this.deps.serial}`,
      });
    } catch (e) {
      this.deps.logger.warn(`attachStream failed for ${this.deps.serial}: ${(e as Error).message}`);
      socket.destroy();
    }
  }
}
