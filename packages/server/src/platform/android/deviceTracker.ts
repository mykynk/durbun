/**
 * Device list changes pushed by the adb server (`host:track-devices-l` over its socket, what `adb
 * track-devices -l` asks): one connection, no process per check. After "OKAY" the server sends the whole
 * `adb devices -l` list (without its header) as a 4-hex-digit length + text, at once and on every change.
 * Talking to the socket never starts, restarts or kills a server. When the stream ends (no server, a server
 * restart, an old server that does not know the request) the driver polls `adb devices -l` again and tries
 * the stream later.
 */
import net from 'node:net';
import { Backoff } from '../shared/timing';

export interface AdbDeviceTrackerOptions {
  port: () => number;
  /** The full device list text (one `adb devices -l` row per line), every time it changes. */
  onList(text: string): void;
  /** The stream ended (it had been live, or it never got there). */
  onDown(reason: string): void;
  /** Tests: shorter retry delays. */
  retryMs?: { initial: number; max: number };
}

/** Parse what is buffered: 'OKAY' / 'FAIL' + message, then length-prefixed lists. */
export function parseTrackFrames(buf: Buffer, acked: boolean): { acked: boolean; lists: string[]; rest: Buffer; failure?: string } {
  const lists: string[] = [];
  let p = 0;
  if (!acked) {
    if (buf.length < 4) return { acked, lists, rest: buf };
    const status = buf.toString('latin1', 0, 4);
    if (status === 'FAIL') {
      const len = buf.length >= 8 ? parseInt(buf.toString('latin1', 4, 8), 16) : NaN;
      const msg = Number.isInteger(len) && buf.length >= 8 + len ? buf.toString('utf8', 8, 8 + len) : 'refused';
      return { acked, lists, rest: Buffer.alloc(0), failure: msg };
    }
    if (status !== 'OKAY') return { acked, lists, rest: Buffer.alloc(0), failure: `unexpected reply "${status}"` };
    acked = true;
    p = 4;
  }
  while (buf.length - p >= 4) {
    const len = parseInt(buf.toString('latin1', p, p + 4), 16);
    if (!Number.isInteger(len) || len < 0 || len > 1024 * 1024) return { acked, lists, rest: Buffer.alloc(0), failure: 'bad length' };
    if (buf.length - p - 4 < len) break;
    lists.push(buf.toString('utf8', p + 4, p + 4 + len));
    p += 4 + len;
  }
  return { acked, lists, rest: buf.subarray(p) };
}

export class AdbDeviceTracker {
  private socket?: net.Socket;
  private stopped = true;
  private liveNow = false;
  private lastList?: string;
  private readonly backoff: Backoff;
  private nextTryAt = 0;

  constructor(private readonly opts: AdbDeviceTrackerOptions) {
    this.backoff = new Backoff(opts.retryMs?.initial ?? 2000, opts.retryMs?.max ?? 60_000);
  }

  /** The stream is connected and has sent its first list. */
  get live(): boolean {
    return this.liveNow && this.lastList !== undefined;
  }

  /** The latest list (while live). */
  get list(): string | undefined {
    return this.live ? this.lastList : undefined;
  }

  /** Connect unless connected, connecting, or waiting before the next try (`force`: do not wait). */
  ensure(force = false): void {
    this.stopped = false;
    if (this.socket) return;
    if (!force && Date.now() < this.nextTryAt) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.liveNow = false;
    this.lastList = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }

  private connect(): void {
    let buf: Buffer = Buffer.alloc(0);
    let acked = false;
    let ended = false;
    const socket = net.connect({ host: '127.0.0.1', port: this.opts.port() });
    this.socket = socket;
    socket.setNoDelay(true);
    const down = (reason: string) => {
      if (ended) return;
      ended = true;
      socket.destroy();
      if (this.socket !== socket) return;
      this.socket = undefined;
      const wasLive = this.liveNow;
      this.liveNow = false;
      this.lastList = undefined;
      // A stream that worked for a while comes back quickly; one that never did waits longer each time.
      if (wasLive) this.backoff.reset();
      this.nextTryAt = Date.now() + this.backoff.next();
      if (!this.stopped) this.opts.onDown(reason);
    };
    socket.on('connect', () => {
      const payload = 'host:track-devices-l';
      socket.write(`${payload.length.toString(16).padStart(4, '0')}${payload}`);
    });
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const r = parseTrackFrames(buf, acked);
      acked = r.acked;
      buf = r.rest;
      if (r.failure) {
        down(`adb server refused device tracking: ${r.failure}`);
        return;
      }
      if (acked) this.liveNow = true;
      for (const list of r.lists) {
        if (this.socket !== socket || this.stopped) return;
        this.lastList = list;
        this.opts.onList(list);
      }
    });
    socket.on('error', (e: NodeJS.ErrnoException) => down(e.code === 'ECONNREFUSED' ? 'no adb server runs' : e.message));
    socket.on('close', () => down('the adb server closed the device stream'));
  }
}
