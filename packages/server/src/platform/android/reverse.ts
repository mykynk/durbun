/**
 * SDK routing for one Android device (SPEC §2.1 / §5.5): a 127.0.0.1 listener on a dynamic port plus
 *   adb -s S reverse tcp:9751 tcp:<dyn>        (raw NDJSON SDK transport → we know the device)
 *   adb -s S reverse tcp:9750 tcp:<http port>  (React Native WebSocket /sdk)
 * Accepted sockets go to ctx.sdk.attachStream(socket, { transport: 'adb-reverse', deviceId }).
 */
import net from 'node:net';
import { DEFAULT_PORTS } from '@durbun/protocol';
import type { DriverContext, Logger } from '../../types';
import type { Adb } from './adb';

export interface ReverseRouterDeps {
  adb: () => Adb | null;
  serial: string;
  deviceId: string;
  ctx: DriverContext;
  logger: Logger;
}

export class AdbReverseRouter {
  private server?: net.Server;
  private port?: number;
  private readonly sockets = new Set<net.Socket>();
  private closed = false;
  private lastError?: string;

  constructor(private readonly deps: ReverseRouterDeps) {}

  get localPort(): number | undefined {
    return this.port;
  }

  get error(): string | undefined {
    return this.lastError;
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

  /** Re-apply missing mappings. Returns true when both are in place. */
  async ensure(): Promise<boolean> {
    const adb = this.deps.adb();
    if (!adb || !this.port || this.closed) return false;
    const { serial, ctx } = this.deps;
    const list = await adb.reverseList(serial);
    const wanted: Array<[number, number]> = [
      [DEFAULT_PORTS.sdk, this.port],
      [DEFAULT_PORTS.http, ctx.ports.http],
    ];
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
      [DEFAULT_PORTS.http, ctx.ports.http],
    ];
    for (const [devicePort, hostPort] of ours) {
      if (hostPort && list.some((m) => m.local === `tcp:${devicePort}` && m.remote === `tcp:${hostPort}`)) {
        await adb.reverseRemove(serial, devicePort);
      }
    }
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
