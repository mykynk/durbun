/**
 * The running adb server, asked directly over its socket (`host:version`), which never starts, restarts
 * or kills a server. Every adb client command does more: when the server's version differs from the
 * client's, the client kills that server and starts its own. With two adb installs on one Mac (Android
 * Studio's SDK and Homebrew, say) each side would then keep killing the other's server, so the driver asks
 * here first and only runs adb when the versions match (or no server runs).
 */
import net from 'node:net';
import { run } from '../exec';
import { adbProtocolVersion } from './parsers';

export const ADB_SERVER_PROBE = {
  /** Port of the adb server; undefined = $ANDROID_ADB_SERVER_PORT, else 5037 (tests point it elsewhere). */
  port: undefined as number | undefined,
  timeoutMs: 1000,
};

export const DEFAULT_ADB_SERVER_PORT = 5037;

/** The adb server port adb itself uses: $ANDROID_ADB_SERVER_PORT, else 5037. */
export function adbServerPort(env: NodeJS.ProcessEnv = process.env): number {
  if (ADB_SERVER_PROBE.port !== undefined) return ADB_SERVER_PROBE.port;
  const n = Number(env.ANDROID_ADB_SERVER_PORT);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_ADB_SERVER_PORT;
}

/**
 * Version of the adb server listening on 127.0.0.1:`port`: a number, 'none' when nothing listens there,
 * undefined when the answer was not understood in time (then the caller carries on as before).
 */
export function queryAdbServerVersion(port = adbServerPort(), timeoutMs = ADB_SERVER_PROBE.timeoutMs): Promise<number | 'none' | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (v: number | 'none' | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref?.();
    socket.on('connect', () => {
      const payload = 'host:version';
      socket.write(`${payload.length.toString(16).padStart(4, '0')}${payload}`);
    });
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const v = parseVersionReply(buf);
      if (v !== 'more') finish(v);
    });
    socket.on('end', () => {
      const v = parseVersionReply(buf);
      finish(v === 'more' ? undefined : v);
    });
    socket.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED' ? 'none' : undefined));
  });
}

/** "OKAY" + 4 hex length + 4 hex version ("OKAY00040029" → 41); 'more' while incomplete. */
export function parseVersionReply(buf: Buffer): number | undefined | 'more' {
  if (buf.length < 4) return 'more';
  const status = buf.subarray(0, 4).toString('latin1');
  if (status !== 'OKAY') return undefined;
  if (buf.length < 8) return 'more';
  const len = parseInt(buf.subarray(4, 8).toString('latin1'), 16);
  if (!Number.isInteger(len) || len <= 0 || len > 64) return undefined;
  if (buf.length < 8 + len) return 'more';
  const v = parseInt(buf.subarray(8, 8 + len).toString('latin1'), 16);
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

export interface AdbBinaryInfo {
  path: string;
  /** "1.0.41 (35.0.2-12147458)". */
  version?: string;
  /** 41 */
  protocol?: number;
}

/** `adb version` of one binary (never contacts the server). */
export async function adbBinaryInfo(adbPath: string, env?: Record<string, string>): Promise<AdbBinaryInfo> {
  const r = await run(adbPath, ['version'], { timeoutMs: 10_000, ...(env ? { env } : {}) });
  if (!r.ok) return { path: adbPath };
  const v = /Android Debug Bridge version ([\d.]+)/.exec(r.stdout)?.[1];
  const build = /^Version (\S+)/m.exec(r.stdout)?.[1];
  const protocol = adbProtocolVersion(r.stdout);
  return {
    path: adbPath,
    ...(v ? { version: build ? `${v} (${build})` : v } : {}),
    ...(protocol ? { protocol } : {}),
  };
}
