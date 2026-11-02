import fs from 'node:fs';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build as buildPlist } from 'plist';
import {
  encodeUsbmuxPacket,
  parsePlistDict,
  toNetworkPort,
  tunnelToDuplex,
  UsbmuxClient,
  UsbmuxDecoder,
  UsbmuxError,
  USBMUXD_SOCKET,
  type UsbmuxEvent,
} from '../../src/platform/ios/usbmux';
import { encodeLockdownFrame, lockdownGetValues, LockdownDecoder } from '../../src/platform/ios/lockdown';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { waitFor } from './helpers';

describe('usbmux packet format', () => {
  it('encodes a 16-byte little-endian header followed by an XML plist', () => {
    const pkt = encodeUsbmuxPacket({ MessageType: 'ListDevices', ProgName: 'durbun', kLibUSBMuxVersion: 3 }, 7);
    expect(pkt.readUInt32LE(0)).toBe(pkt.length);
    expect(pkt.readUInt32LE(4)).toBe(1); // version: plist
    expect(pkt.readUInt32LE(8)).toBe(8); // message: plist
    expect(pkt.readUInt32LE(12)).toBe(7); // tag
    const body = pkt.subarray(16).toString('utf8');
    expect(body).toContain('<plist version="1.0">');
    expect(body).toContain('<key>MessageType</key>');
    expect(body).toContain('<integer>3</integer>');
  });

  it('puts Connect ports in network byte order', () => {
    expect(toNetworkPort(62078)).toBe(0x7ef2);
    expect(toNetworkPort(9752)).toBe(0x1826);
    expect(toNetworkPort(toNetworkPort(9755))).toBe(9755);
  });

  it('decodes fragmented and coalesced packets and keeps trailing tunnel bytes', () => {
    const a = encodeUsbmuxPacket({ MessageType: 'Result', Number: 0 }, 1);
    const b = encodeUsbmuxPacket({ MessageType: 'Attached', DeviceID: 3 }, 0);
    const extra = Buffer.from('{"type":"hello"}\n');
    const all = Buffer.concat([a, b, extra]);
    const dec = new UsbmuxDecoder();
    const got = [];
    for (let i = 0; i < a.length + b.length; i += 1) got.push(...dec.push(all.subarray(i, i + 1)));
    // After the last packet the stream is tunnel data: decode nothing more, keep the bytes.
    got.push(...dec.push(extra, 0));
    expect(got.map((p) => p.payload?.MessageType)).toEqual(['Result', 'Attached']);
    expect(dec.takeRest().toString()).toBe('{"type":"hello"}\n');
    const dec2 = new UsbmuxDecoder();
    expect(dec2.push(all, 2).map((p) => p.tag)).toEqual([1, 0]);
    expect(dec2.takeRest().equals(extra)).toBe(true);
    // A Connect reply followed by tunnel bytes in the same chunk.
    const dec3 = new UsbmuxDecoder();
    expect(dec3.push(Buffer.concat([a, extra]), 1)).toHaveLength(1);
    expect(dec3.takeRest().equals(extra)).toBe(true);
  });

  it('rejects absurd packet lengths and parses binary plists', () => {
    const bad = Buffer.alloc(16);
    bad.writeUInt32LE(4, 0);
    expect(() => new UsbmuxDecoder().push(bad)).toThrow(/invalid usbmux packet length/);
    expect(parsePlistDict(Buffer.from(buildPlist({ A: 1 })))).toEqual({ A: 1 });
    expect(parsePlistDict(Buffer.from('not a plist'))).toBeNull();
  });

  it('frames lockdown messages with a 4-byte big-endian length', () => {
    const f = encodeLockdownFrame({ Label: 'durbun', Request: 'QueryType' });
    expect(f.readUInt32BE(0)).toBe(f.length - 4);
    const dec = new LockdownDecoder();
    expect(dec.push(f.subarray(0, 10))).toEqual([]);
    expect(dec.push(f.subarray(10))).toEqual([{ Label: 'durbun', Request: 'QueryType' }]);
  });
});

describe.runIf(process.platform === 'darwin' && fs.existsSync(USBMUXD_SOCKET))('real usbmuxd', () => {
  it('answers ListDevices and ReadBUID', async () => {
    const client = new UsbmuxClient();
    const devices = await client.listDevices(3000);
    expect(Array.isArray(devices)).toBe(true);
    for (const d of devices) expect(d.udid).toMatch(/^[0-9A-Fa-f-]{24,40}$/);
    expect(await client.readBuid(3000)).toMatch(/^[0-9A-F-]{36}$/);
  });

  it('accepts a Listen connection', async () => {
    const client = new UsbmuxClient();
    const l = await client.listen(
      () => {},
      () => {},
      3000,
    );
    expect(l.closed).toBe(false);
    l.close();
  });
});

describe('UsbmuxClient against a fake usbmuxd', () => {
  let mux: FakeUsbmuxd;
  let client: UsbmuxClient;
  const UDID = '00008130-000A1B2C3D4E001F';

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    client = new UsbmuxClient({ socketPath: mux.socketPath });
  });
  afterEach(async () => {
    await mux.close();
  });

  it('lists devices and reads pair records', async () => {
    mux.attach({ deviceId: 5, udid: UDID });
    const devices = await client.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ deviceId: 5, udid: UDID, connectionType: 'USB', productId: 4776 });
    expect(await client.readPairRecord(UDID)).toBeNull();
    mux.pair(UDID, false);
    expect((await client.readPairRecord(UDID))?.length).toBeGreaterThan(10);
    expect(mux.requests[0]).toMatchObject({ MessageType: 'ListDevices', ProgName: 'durbun', kLibUSBMuxVersion: 3 });
  });

  it('streams Attached / Paired / Detached events on a Listen connection', async () => {
    const events: UsbmuxEvent[] = [];
    let closed = false;
    const l = await client.listen(
      (e) => events.push(e),
      () => (closed = true),
    );
    mux.attach({ deviceId: 9, udid: UDID, connectionType: 'Network' });
    mux.pair(UDID);
    mux.detach(9);
    await waitFor(() => events.length >= 3);
    expect(events[0]).toMatchObject({ type: 'attached', device: { deviceId: 9, connectionType: 'Network' } });
    expect(events[1]).toEqual({ type: 'paired', deviceId: 9 });
    expect(events[2]).toEqual({ type: 'detached', deviceId: 9 });
    l.close();
    await waitFor(() => closed);
  });

  it('connects tunnels, delivering bytes that arrived with the Connect result', async () => {
    mux.attach({ deviceId: 5, udid: UDID });
    mux.connectExtra.set('5:9752', Buffer.from('{"type":"hello"}\n'));
    mux.onPort(5, 9752, (sock) => {
      sock.on('data', (d) => sock.write(`echo:${d.toString()}`));
    });
    const tunnel = await client.connect(5, 9752);
    const duplex = tunnelToDuplex(tunnel);
    const chunks: string[] = [];
    duplex.on('data', (d: Buffer) => chunks.push(d.toString()));
    await waitFor(() => chunks.join('').includes('hello'));
    duplex.write('ping\n');
    await waitFor(() => chunks.join('').includes('echo:ping'));
    expect(chunks.join('')).toBe('{"type":"hello"}\necho:ping\n');
    expect(duplex.bytesIn()).toBe(Buffer.byteLength(chunks.join('')));
    const closed = new Promise((r) => duplex.once('close', r));
    duplex.destroy();
    await closed;
  });

  it('reports refused ports and unknown devices with usbmux result codes', async () => {
    mux.attach({ deviceId: 5, udid: UDID });
    await expect(client.connect(5, 9753)).rejects.toMatchObject({ code: 3 });
    await expect(client.connect(77, 9753)).rejects.toBeInstanceOf(UsbmuxError);
  });

  it('reads lockdown values without a session', async () => {
    mux.attach({ deviceId: 5, udid: UDID });
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
    const v = await lockdownGetValues(client, 5);
    expect(v).toMatchObject({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' });
  });

  it('fails cleanly when usbmuxd is not there', async () => {
    const nowhere = new UsbmuxClient({ socketPath: `${mux.socketPath}.missing` });
    await expect(nowhere.listDevices(500)).rejects.toThrow(/usbmuxd is not running/);
  });

  it('notices when the daemon closes a Listen connection', async () => {
    let lost: Error | undefined;
    await client.listen(
      () => {},
      (err) => (lost = err),
    );
    await mux.close();
    await waitFor(() => lost);
    expect(lost?.message).toMatch(/lost/);
    mux = new FakeUsbmuxd();
    await mux.start();
  });
});

describe('net helpers', () => {
  it('pipes a local socket through a tunnel (port forwarding)', async () => {
    const mux = new FakeUsbmuxd();
    await mux.start();
    try {
      mux.attach({ deviceId: 2, udid: 'X' });
      mux.onPort(2, 8181, (sock) => sock.on('data', (d) => sock.write(d.toString().toUpperCase())));
      const client = new UsbmuxClient({ socketPath: mux.socketPath });
      const { pipeTunnel } = await import('../../src/platform/ios/usbmux');
      const server = net.createServer((c) => {
        c.pause();
        void client.connect(2, 8181).then((t) => pipeTunnel(t, c));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as net.AddressInfo).port;
      const c = net.connect(port, '127.0.0.1');
      let got = '';
      c.on('data', (d) => (got += d.toString()));
      c.write('vm service');
      await waitFor(() => got === 'VM SERVICE');
      c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      await mux.close();
    }
  });
});
