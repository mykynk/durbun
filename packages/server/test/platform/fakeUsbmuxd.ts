/**
 * In-process fake of /var/run/usbmuxd speaking the real wire format (16-byte LE header + XML plist),
 * with pluggable per-port handlers standing in for TCP listeners on the device.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { build as buildPlist, type PlistValue } from 'plist';
import { encodeUsbmuxPacket, UsbmuxDecoder, type PlistDict } from '../../src/platform/ios/usbmux';
import { encodeLockdownFrame, LockdownDecoder } from '../../src/platform/ios/lockdown';

export interface FakeDevice {
  deviceId: number;
  udid: string;
  connectionType?: 'USB' | 'Network';
}

/** Called with the raw tunnel socket after "Result 0" was sent (plus bytes to send right away). */
export type PortHandler = (socket: net.Socket) => void;

export class FakeUsbmuxd {
  readonly socketPath: string;
  private readonly dir: string;
  private server?: net.Server;
  private readonly devices = new Map<number, FakeDevice>();
  private readonly paired = new Set<string>();
  private readonly listeners = new Set<net.Socket>();
  private readonly sockets = new Set<net.Socket>();
  private readonly handlers = new Map<string, PortHandler>();
  /** Bytes appended to the Connect "Result 0" packet in the same write (tests leftover handling). */
  connectExtra = new Map<string, Buffer>();
  readonly requests: Array<Record<string, unknown>> = [];

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-'));
    this.socketPath = path.join(this.dir, 'usbmuxd');
  }

  async start(): Promise<void> {
    this.server = net.createServer((s) => this.onConnection(s));
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  attach(dev: FakeDevice): void {
    this.devices.set(dev.deviceId, dev);
    for (const l of this.listeners) this.send(l, this.attachedMsg(dev), 0);
  }

  detach(deviceId: number): void {
    this.devices.delete(deviceId);
    for (const l of this.listeners) this.send(l, { MessageType: 'Detached', DeviceID: deviceId }, 0);
  }

  pair(udid: string, notify = true): void {
    this.paired.add(udid);
    if (!notify) return;
    for (const dev of this.devices.values()) {
      if (dev.udid === udid) for (const l of this.listeners) this.send(l, { MessageType: 'Paired', DeviceID: dev.deviceId }, 0);
    }
  }

  /** Install a "listening" port on a device. */
  onPort(deviceId: number, port: number, handler: PortHandler): void {
    this.handlers.set(`${deviceId}:${port}`, handler);
  }

  private attachedMsg(dev: FakeDevice): PlistDict {
    return {
      MessageType: 'Attached',
      DeviceID: dev.deviceId,
      Properties: {
        ConnectionSpeed: 480000000,
        ConnectionType: dev.connectionType ?? 'USB',
        DeviceID: dev.deviceId,
        LocationID: 336592896,
        ProductID: 4776,
        SerialNumber: dev.udid,
        UDID: dev.udid,
        USBSerialNumber: dev.udid.replace('-', ''),
      },
    };
  }

  private send(socket: net.Socket, payload: PlistDict, tag: number, extra?: Buffer): void {
    const pkt = encodeUsbmuxPacket(payload, tag);
    socket.write(extra ? Buffer.concat([pkt, extra]) : pkt);
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.listeners.delete(socket);
    });
    socket.on('error', () => {});
    const decoder = new UsbmuxDecoder();
    const onData = (chunk: Buffer) => {
      for (const p of decoder.push(chunk)) {
        const msg = p.payload ?? {};
        this.requests.push(msg);
        switch (msg.MessageType) {
          case 'ListDevices':
            this.send(socket, { DeviceList: [...this.devices.values()].map((d) => this.attachedMsg(d)) as PlistValue[] }, p.tag);
            break;
          case 'ReadBUID':
            this.send(socket, { BUID: 'FAKE-BUID' }, p.tag);
            break;
          case 'ReadPairRecord': {
            const udid = String(msg.PairRecordID);
            if (this.paired.has(udid)) {
              const record = buildPlist({ HostID: 'FAKE-HOST', SystemBUID: 'FAKE-BUID' });
              this.send(socket, { PairRecordData: new Uint8Array(Buffer.from(record)) }, p.tag);
            } else this.send(socket, { MessageType: 'Result', Number: 2 }, p.tag);
            break;
          }
          case 'Listen':
            this.listeners.add(socket);
            this.send(socket, { MessageType: 'Result', Number: 0 }, p.tag);
            for (const dev of this.devices.values()) this.send(socket, this.attachedMsg(dev), 0);
            break;
          case 'Connect': {
            const deviceId = Number(msg.DeviceID);
            const raw = Number(msg.PortNumber);
            const port = ((raw & 0xff) << 8) | ((raw >> 8) & 0xff);
            const key = `${deviceId}:${port}`;
            const handler = this.handlers.get(key);
            if (!this.devices.has(deviceId) || !handler) {
              this.send(socket, { MessageType: 'Result', Number: this.devices.has(deviceId) ? 3 : 2 }, p.tag);
              socket.end();
              return;
            }
            socket.off('data', onData);
            this.send(socket, { MessageType: 'Result', Number: 0 }, p.tag, this.connectExtra.get(key));
            handler(socket);
            return;
          }
          default:
            this.send(socket, { MessageType: 'Result', Number: 1 }, p.tag);
        }
      }
    };
    socket.on('data', onData);
  }
}

/** Device-side lockdownd answering QueryType / GetValue like a real iPhone without a session. */
export function fakeLockdown(values: Record<string, PlistValue>): PortHandler {
  return (socket) => {
    const dec = new LockdownDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const req of dec.push(chunk)) {
        if (!req) continue;
        if (req.Request === 'QueryType') {
          socket.write(encodeLockdownFrame({ Request: 'QueryType', Type: 'com.apple.mobile.lockdown' }));
        } else if (req.Request === 'GetValue') {
          socket.write(encodeLockdownFrame({ Request: 'GetValue', Value: values }));
        } else {
          socket.write(encodeLockdownFrame({ Request: String(req.Request), Error: 'InvalidRequest' }));
        }
      }
    });
  };
}
