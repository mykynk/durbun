/**
 * lockdownd (device port 62078) without a session: framing is a 4-byte big-endian length followed by a
 * plist. `QueryType` then `GetValue` (no key) returns the public values that need no pairing
 * (DeviceName, ProductType, ProductVersion, BuildVersion, UniqueDeviceID, DeviceClass, …).
 */
import { build as buildPlist } from 'plist';
import { parsePlistDict, tunnelToDuplex, UsbmuxError, type PlistDict, type UsbmuxClient } from './usbmux';

export const LOCKDOWN_PORT = 62078;

export function encodeLockdownFrame(payload: PlistDict): Buffer {
  const body = Buffer.from(buildPlist(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class LockdownDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<Record<string, unknown> | null> {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Array<Record<string, unknown> | null> = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 16 * 1024 * 1024) throw new Error(`invalid lockdown frame length ${len}`);
      if (this.buf.length < 4 + len) break;
      out.push(parsePlistDict(Buffer.from(this.buf.subarray(4, 4 + len))));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

export interface LockdownValues {
  DeviceName?: string;
  ProductType?: string;
  ProductVersion?: string;
  BuildVersion?: string;
  DeviceClass?: string;
  HardwareModel?: string;
  UniqueDeviceID?: string;
  [key: string]: unknown;
}

/** QueryType + GetValue on a fresh tunnel; rejects on timeout or lockdown errors. */
export async function lockdownGetValues(
  client: UsbmuxClient,
  deviceId: number,
  timeoutMs = 5000,
): Promise<LockdownValues> {
  const tunnel = await client.connect(deviceId, LOCKDOWN_PORT, timeoutMs);
  const stream = tunnelToDuplex(tunnel);
  const decoder = new LockdownDecoder();
  const replies: Array<Record<string, unknown> | null> = [];
  let waiter: (() => void) | undefined;
  let closed = false;
  stream.on('data', (chunk: Buffer) => {
    try {
      replies.push(...decoder.push(chunk));
    } catch {
      stream.destroy();
    }
    waiter?.();
  });
  stream.on('close', () => {
    closed = true;
    waiter?.();
  });
  const next = (): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (replies.length) {
          waiter = undefined;
          clearTimeout(timer);
          const r = replies.shift();
          if (!r) reject(new UsbmuxError('lockdownd sent an unreadable reply'));
          else resolve(r);
          return true;
        }
        if (closed) {
          waiter = undefined;
          clearTimeout(timer);
          reject(new UsbmuxError('lockdownd closed the connection'));
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        waiter = undefined;
        reject(new UsbmuxError('lockdownd did not answer in time'));
      }, timeoutMs);
      if (!check()) waiter = () => void check();
    });
  try {
    stream.write(encodeLockdownFrame({ Label: 'durbun', Request: 'QueryType' }));
    const type = await next();
    if (type.Type !== undefined && type.Type !== 'com.apple.mobile.lockdown') {
      throw new UsbmuxError(`unexpected lockdown service type ${String(type.Type)}`);
    }
    stream.write(encodeLockdownFrame({ Label: 'durbun', Request: 'GetValue' }));
    const reply = await next();
    if (typeof reply.Error === 'string') throw new UsbmuxError(`lockdownd GetValue: ${reply.Error}`);
    const value = reply.Value;
    if (!value || typeof value !== 'object') throw new UsbmuxError('lockdownd GetValue returned no values');
    return value as LockdownValues;
  } finally {
    stream.destroy();
  }
}
