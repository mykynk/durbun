/**
 * Minimal usbmuxd client (the daemon behind /var/run/usbmuxd that multiplexes TCP to iOS devices).
 *
 * Wire format: 16-byte little-endian header { length (incl. header), version = 1 (plist),
 * message type = 8 (plist), tag } followed by an XML plist dictionary. Requests used here:
 *   ListDevices · Listen (then Attached/Detached/Paired events) · Connect {DeviceID, PortNumber}
 *   (PortNumber in network byte order; after "Result 0" the socket is a raw tunnel) ·
 *   ReadBUID · ReadPairRecord {PairRecordID}.
 */
import net from 'node:net';
import { Duplex } from 'node:stream';
import { build as buildPlist, parse as parsePlist, type PlistValue } from 'plist';

export const USBMUXD_SOCKET = '/var/run/usbmuxd';
export const USBMUX_HEADER_SIZE = 16;
const PLIST_VERSION = 1;
const PLIST_MESSAGE = 8;
const MAX_PACKET = 32 * 1024 * 1024;

export const USBMUX_RESULT = {
  OK: 0,
  BADCOMMAND: 1,
  BADDEV: 2,
  CONNREFUSED: 3,
  BADVERSION: 6,
} as const;

export type PlistDict = { [key: string]: PlistValue };

export interface UsbmuxPacket {
  version: number;
  type: number;
  tag: number;
  /** Parsed plist dictionary (null when the payload was not a dict / not parseable). */
  payload: Record<string, unknown> | null;
}

/** htons(port): usbmuxd expects the Connect port in network byte order. */
export function toNetworkPort(port: number): number {
  return ((port & 0xff) << 8) | ((port >> 8) & 0xff);
}

export function encodeUsbmuxPacket(payload: PlistDict, tag: number): Buffer {
  const body = Buffer.from(buildPlist(payload), 'utf8');
  const header = Buffer.alloc(USBMUX_HEADER_SIZE);
  header.writeUInt32LE(USBMUX_HEADER_SIZE + body.length, 0);
  header.writeUInt32LE(PLIST_VERSION, 4);
  header.writeUInt32LE(PLIST_MESSAGE, 8);
  header.writeUInt32LE(tag >>> 0, 12);
  return Buffer.concat([header, body]);
}

/** Parse an XML or binary plist payload into a dictionary (null if not a dict). */
export function parsePlistDict(data: Buffer): Record<string, unknown> | null {
  try {
    const isBinary = data.length >= 8 && data.toString('latin1', 0, 8) === 'bplist00';
    const value = isBinary ? parsePlist(new Uint8Array(data)) : parsePlist(data.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Incremental decoder: feed socket chunks, get complete packets (handles fragmentation/coalescing). */
export class UsbmuxDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /**
   * Append bytes and return complete packets. `maxPackets` stops decoding early: after a Connect
   * result the rest of the stream is raw tunnel data, not usbmux packets.
   */
  push(chunk: Buffer, maxPackets = Infinity): UsbmuxPacket[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: UsbmuxPacket[] = [];
    while (out.length < maxPackets && this.buf.length >= USBMUX_HEADER_SIZE) {
      const len = this.buf.readUInt32LE(0);
      if (len < USBMUX_HEADER_SIZE || len > MAX_PACKET) throw new Error(`invalid usbmux packet length ${len}`);
      if (this.buf.length < len) break;
      const version = this.buf.readUInt32LE(4);
      const type = this.buf.readUInt32LE(8);
      const tag = this.buf.readUInt32LE(12);
      const body = this.buf.subarray(USBMUX_HEADER_SIZE, len);
      out.push({ version, type, tag, payload: type === PLIST_MESSAGE ? parsePlistDict(Buffer.from(body)) : null });
      this.buf = this.buf.subarray(len);
    }
    return out;
  }

  /** Bytes after the last complete packet (tunnel data that arrived with the Connect result). */
  takeRest(): Buffer {
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return Buffer.from(rest);
  }
}

export class UsbmuxError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'UsbmuxError';
  }
}

export interface UsbmuxDevice {
  /** usbmuxd's numeric id (changes on every attach). */
  deviceId: number;
  udid: string;
  connectionType: 'USB' | 'Network';
  productId?: number;
  properties: Record<string, unknown>;
}

export type UsbmuxEvent =
  | { type: 'attached'; device: UsbmuxDevice }
  | { type: 'detached'; deviceId: number }
  | { type: 'paired'; deviceId: number };

export interface UsbmuxTunnel {
  socket: net.Socket;
  /** Device bytes that arrived together with the Connect result. */
  leftover: Buffer;
}

export interface UsbmuxListener {
  close(): void;
  readonly closed: boolean;
}

/** Normalize one DeviceList item / Attached message into a UsbmuxDevice. */
export function toUsbmuxDevice(msg: Record<string, unknown>): UsbmuxDevice | null {
  const props = (msg.Properties ?? msg) as Record<string, unknown>;
  const deviceId = Number(msg.DeviceID ?? props.DeviceID);
  const udid = String(props.SerialNumber ?? props.UDID ?? '');
  if (!Number.isInteger(deviceId) || !udid) return null;
  const ct = String(props.ConnectionType ?? 'USB');
  return {
    deviceId,
    udid,
    connectionType: ct === 'Network' ? 'Network' : 'USB',
    ...(typeof props.ProductID === 'number' ? { productId: props.ProductID } : {}),
    properties: props,
  };
}

export function resultText(code: number): string {
  switch (code) {
    case USBMUX_RESULT.OK:
      return 'OK';
    case USBMUX_RESULT.BADCOMMAND:
      return 'bad command';
    case USBMUX_RESULT.BADDEV:
      return 'device not found';
    case USBMUX_RESULT.CONNREFUSED:
      return 'connection refused';
    case USBMUX_RESULT.BADVERSION:
      return 'unsupported protocol version';
    default:
      return `error ${code}`;
  }
}

export interface UsbmuxClientOptions {
  socketPath?: string;
  progName?: string;
}

export class UsbmuxClient {
  readonly socketPath: string;
  private readonly progName: string;
  private tag = 0;

  constructor(opts: UsbmuxClientOptions = {}) {
    this.socketPath = opts.socketPath ?? USBMUXD_SOCKET;
    this.progName = opts.progName ?? 'durbun';
  }

  private base(type: string): PlistDict {
    return {
      MessageType: type,
      ClientVersionString: `${this.progName}-usbmux-1`,
      ProgName: this.progName,
      kLibUSBMuxVersion: 3,
    };
  }

  private nextTag(): number {
    this.tag = (this.tag % 0x7fffffff) + 1;
    return this.tag;
  }

  private open(timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new UsbmuxError(`usbmuxd did not accept a connection within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve(socket);
      });
      const onError = (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new UsbmuxError(
            err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
              ? `usbmuxd is not running (${this.socketPath})`
              : `usbmuxd: ${err.message}`,
          ),
        );
      };
      socket.once('error', onError);
    });
  }

  /** One request → one reply on a fresh connection. */
  async request(payload: PlistDict, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const socket = await this.open(timeoutMs);
    const tag = this.nextTag();
    return new Promise((resolve, reject) => {
      const decoder = new UsbmuxDecoder();
      let settled = false;
      const finish = (err: Error | null, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners('data');
        socket.destroy();
        if (err) reject(err);
        else resolve(value!);
      };
      const timer = setTimeout(
        () => finish(new UsbmuxError(`usbmuxd ${String(payload.MessageType)} timed out`)),
        timeoutMs,
      );
      socket.on('data', (chunk: Buffer) => {
        let packets: UsbmuxPacket[];
        try {
          packets = decoder.push(chunk);
        } catch (e) {
          finish(e as Error);
          return;
        }
        for (const p of packets) {
          if (p.tag === tag || packets.length === 1) {
            if (!p.payload) finish(new UsbmuxError('usbmuxd sent an unreadable reply'));
            else finish(null, p.payload);
            return;
          }
        }
      });
      socket.on('error', (err) => finish(new UsbmuxError(`usbmuxd: ${err.message}`)));
      socket.on('close', () => finish(new UsbmuxError('usbmuxd closed the connection')));
      socket.write(encodeUsbmuxPacket(payload, tag));
    });
  }

  async listDevices(timeoutMs = 5000): Promise<UsbmuxDevice[]> {
    const reply = await this.request(this.base('ListDevices'), timeoutMs);
    const list = Array.isArray(reply.DeviceList) ? (reply.DeviceList as Record<string, unknown>[]) : [];
    return list.map((d) => toUsbmuxDevice(d)).filter((d): d is UsbmuxDevice => !!d);
  }

  async readBuid(timeoutMs = 5000): Promise<string | undefined> {
    const reply = await this.request(this.base('ReadBUID'), timeoutMs);
    return typeof reply.BUID === 'string' ? reply.BUID : undefined;
  }

  /** Pair record bytes, or null when this Mac is not paired with (trusted by) the device. */
  async readPairRecord(udid: string, timeoutMs = 5000): Promise<Buffer | null> {
    const reply = await this.request({ ...this.base('ReadPairRecord'), PairRecordID: udid }, timeoutMs);
    const data = reply.PairRecordData;
    if (data instanceof Uint8Array && data.length > 0) return Buffer.from(data);
    return null;
  }

  /** Persistent Listen connection. Resolves once usbmuxd accepted it. */
  listen(onEvent: (ev: UsbmuxEvent) => void, onClose: (err?: Error) => void, timeoutMs = 5000): Promise<UsbmuxListener> {
    return this.open(timeoutMs).then(
      (socket) =>
        new Promise<UsbmuxListener>((resolve, reject) => {
          const tag = this.nextTag();
          const decoder = new UsbmuxDecoder();
          let accepted = false;
          let closed = false;
          const handle: UsbmuxListener = {
            close: () => {
              if (closed) return;
              closed = true;
              socket.destroy();
            },
            get closed() {
              return closed;
            },
          };
          const timer = setTimeout(() => {
            if (!accepted) {
              closed = true;
              socket.destroy();
              reject(new UsbmuxError('usbmuxd Listen timed out'));
            }
          }, timeoutMs);
          socket.on('data', (chunk: Buffer) => {
            let packets: UsbmuxPacket[];
            try {
              packets = decoder.push(chunk);
            } catch (e) {
              socket.destroy(e as Error);
              return;
            }
            for (const p of packets) {
              const msg = p.payload;
              if (!msg) continue;
              const type = String(msg.MessageType ?? '');
              if (!accepted) {
                if (type === 'Result') {
                  clearTimeout(timer);
                  const code = Number(msg.Number ?? -1);
                  if (code !== 0) {
                    closed = true;
                    socket.destroy();
                    reject(new UsbmuxError(`usbmuxd refused Listen: ${resultText(code)}`, code));
                    return;
                  }
                  accepted = true;
                  resolve(handle);
                }
                continue;
              }
              try {
                if (type === 'Attached') {
                  const device = toUsbmuxDevice(msg);
                  if (device) onEvent({ type: 'attached', device });
                } else if (type === 'Detached') {
                  onEvent({ type: 'detached', deviceId: Number(msg.DeviceID) });
                } else if (type === 'Paired') {
                  onEvent({ type: 'paired', deviceId: Number(msg.DeviceID) });
                }
              } catch {
                /* listener errors never break the connection */
              }
            }
          });
          socket.on('error', () => {
            /* followed by close */
          });
          socket.on('close', () => {
            clearTimeout(timer);
            const wasClosed = closed;
            closed = true;
            if (!accepted) {
              reject(new UsbmuxError('usbmuxd closed the Listen connection'));
              return;
            }
            if (!wasClosed) onClose(new UsbmuxError('usbmuxd Listen connection lost'));
            else onClose();
          });
          socket.write(encodeUsbmuxPacket(this.base('Listen'), tag));
        }),
    );
  }

  /**
   * Open a TCP tunnel to `port` on the device. The returned socket is PAUSED; consume `leftover`
   * first (see tunnelToDuplex / pipeTunnel).
   */
  async connect(deviceId: number, port: number, timeoutMs = 5000): Promise<UsbmuxTunnel> {
    const socket = await this.open(timeoutMs);
    const tag = this.nextTag();
    return new Promise<UsbmuxTunnel>((resolve, reject) => {
      const decoder = new UsbmuxDecoder();
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const failWith = (err: Error) => {
        if (done) return;
        done = true;
        cleanup();
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => failWith(new UsbmuxError(`usbmux Connect to port ${port} timed out`)), timeoutMs);
      const onData = (chunk: Buffer) => {
        let packets: UsbmuxPacket[];
        try {
          packets = decoder.push(chunk, 1);
        } catch (e) {
          failWith(e as Error);
          return;
        }
        const p = packets[0];
        if (!p || done) return;
        const code = Number(p.payload?.Number ?? -1);
        if (p.payload?.MessageType !== 'Result' || code !== USBMUX_RESULT.OK) {
          failWith(new UsbmuxError(`usbmux Connect to port ${port}: ${resultText(code)}`, code));
          return;
        }
        done = true;
        cleanup();
        socket.pause();
        resolve({ socket, leftover: decoder.takeRest() });
      };
      const onError = (err: Error) => failWith(new UsbmuxError(`usbmux Connect: ${err.message}`));
      const onClose = () => failWith(new UsbmuxError('usbmuxd closed the connection during Connect'));
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.write(
        encodeUsbmuxPacket({ ...this.base('Connect'), DeviceID: deviceId, PortNumber: toNetworkPort(port) }, tag),
      );
    });
  }
}

/**
 * Wrap a usbmux tunnel as a fresh Duplex (leftover bytes first). Errors on the tunnel close the
 * Duplex without emitting 'error' (consumers see 'close'). `bytesIn()` counts device→desktop bytes.
 */
export function tunnelToDuplex(tunnel: UsbmuxTunnel): Duplex & { bytesIn(): number } {
  const { socket, leftover } = tunnel;
  let bytesIn = leftover.length;
  const duplex = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk: Buffer, _enc, cb) {
      if (socket.destroyed) {
        cb();
        return;
      }
      socket.write(chunk, () => cb());
    },
    final(cb) {
      socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy();
      cb(err);
    },
  }) as Duplex & { bytesIn(): number };
  duplex.bytesIn = () => bytesIn;
  if (leftover.length) duplex.push(leftover);
  socket.on('data', (d: Buffer) => {
    bytesIn += d.length;
    if (!duplex.push(d)) socket.pause();
  });
  socket.on('end', () => duplex.push(null));
  socket.on('error', () => {
    /* surfaced as close */
  });
  socket.on('close', () => {
    if (!duplex.destroyed) duplex.destroy();
  });
  return duplex;
}

/** Bridge a local client socket and a usbmux tunnel both ways (port forwarding). */
export function pipeTunnel(tunnel: UsbmuxTunnel, client: net.Socket): void {
  const { socket, leftover } = tunnel;
  const closeBoth = () => {
    socket.destroy();
    client.destroy();
  };
  socket.on('error', closeBoth);
  client.on('error', closeBoth);
  socket.on('close', () => client.destroy());
  client.on('close', () => socket.destroy());
  if (leftover.length) client.write(leftover);
  socket.pipe(client);
  client.pipe(socket);
  socket.resume();
}
