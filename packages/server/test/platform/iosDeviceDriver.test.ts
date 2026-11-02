import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IosDeviceDriver } from '../../src/platform/ios/deviceDriver';
import { liveChildCount } from '../../src/platform/exec';
import { FakeUsbmuxd, fakeLockdown } from './fakeUsbmuxd';
import { createCtx, waitFor, type FakeCtx } from './helpers';

const UDID = '00008130-000A1B2C3D4E001F';
const ID = `ios:${UDID}`;

/** A stand-in for idevicesyslog that prints realistic output and runs until killed. */
function writeFakeSyslog(dir: string): string {
  const file = path.join(dir, 'idevicesyslog');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('idevicesyslog 1.3.0-fake');
  process.exit(0);
}
const udid = process.argv[process.argv.indexOf('-u') + 1];
require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'syslog-args.txt'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
const out = [
  '[connected:' + udid + ']',
  'Nov  2 11:43:01 Test-iPhoneu SpringBoard(FrontBoard)[57] <Notice>: [app<com.mykynk.pati>:1234] Workspace assertion state did change',
  'Nov  2 11:43:01.123456 Test iPhone’u Runner(Flutter)[1234] <Notice>: flutter: Merhaba dünya',
  'Nov  2 11:43:02 Test-iPhoneu Runner(Foundation)[1234] <Error>: first line',
  'second line of the same record',
];
process.stdout.write(out.join('\\n') + '\\n');
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe('IosDeviceDriver with a fake usbmuxd', () => {
  let mux: FakeUsbmuxd;
  let dir: string;
  let ctx: FakeCtx;
  let driver: IosDeviceDriver;

  beforeEach(async () => {
    mux = new FakeUsbmuxd();
    await mux.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-ios-'));
    ctx = createCtx({ settings: { idevicesyslogPath: writeFakeSyslog(dir) } });
    driver = new IosDeviceDriver({ socketPath: mux.socketPath, useDevicectl: false });
    mux.onPort(5, 62078, fakeLockdown({ DeviceName: 'Test iPhone’u', ProductType: 'iPhone16,2', ProductVersion: '27.2' }));
  });

  afterEach(async () => {
    await driver.stop();
    await mux.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('announces a trusted device, streams its syslog and cleans up on detach', async () => {
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    const dev = await waitFor(() => ctx.hub.devices.get(ID));
    expect(dev).toMatchObject({
      platform: 'ios',
      kind: 'physical',
      name: 'Test iPhone’u',
      model: 'iPhone 15 Pro Max',
      osVersion: '27.2',
      connection: 'usb',
      state: 'online',
    });
    expect(dev.actions).toContain('logs-restart');
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    expect(ctx.hub.system.map((s) => s.input.code)).toContain('logs.streamStarted');
    await waitFor(() => ctx.hub.logs.length >= 3, 5000);
    const entries = ctx.hub.logs.map((l) => l.entry);
    expect(entries[0]).toMatchObject({ process: 'SpringBoard', tag: 'FrontBoard', pid: 57 });
    expect(entries[1]).toMatchObject({ process: 'Runner', tag: 'flutter', message: 'Merhaba dünya', level: 'info' });
    expect(entries[2]).toMatchObject({ level: 'error', message: 'first line\nsecond line of the same record' });
    expect(ctx.hub.processes.some((p) => p.pid === 1234 && p.name === 'Runner')).toBe(true);
    const args = fs.readFileSync(path.join(dir, 'syslog-args.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(args[0]).toEqual(['-u', UDID, '--no-colors']);
    expect(driver.status()).toMatchObject({ id: 'ios-device', available: true, active: true });

    mux.detach(5);
    await waitFor(() => ctx.hub.disconnected.find((d) => d.id === ID));
    await waitFor(() => liveChildCount() === 0, 5000);
  });

  it('shows untrusted devices as unauthorized until they are paired', async () => {
    mux.attach({ deviceId: 5, udid: UDID });
    await driver.start(ctx);
    const dev = await waitFor(() => ctx.hub.devices.get(ID));
    expect(dev).toMatchObject({ state: 'unauthorized', stateCode: 'device.untrusted', actions: [] });
    expect(dev.logs).toMatchObject({ status: 'unavailable', code: 'device.untrusted' });
    expect(liveChildCount()).toBe(0);
    mux.pair(UDID);
    await waitFor(() => ctx.hub.devices.get(ID)?.state === 'online');
    await waitFor(() => ctx.hub.devices.get(ID)?.logs.status === 'streaming');
    expect(ctx.hub.devices.get(ID)?.stateCode).toBeUndefined();
  });

  it('hands SDK tunnels (device ports 9752–9755) to the SDK layer', async () => {
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    mux.onPort(5, 9753, (sock) => {
      sock.write('{"type":"hello","protocol":1}\n');
      sock.on('data', (d) => sock.write(`ack ${d.toString()}`));
    });
    await driver.start(ctx);
    const att = await waitFor(() => ctx.attached[0], 6000);
    expect(att.meta).toEqual({ transport: 'usbmux', deviceId: ID, remote: `usbmux:${UDID}:9753` });
    let got = '';
    att.stream.on('data', (d: Buffer) => (got += d.toString()));
    await waitFor(() => got.includes('"hello"'));
    att.stream.write('{"type":"welcome"}\n');
    await waitFor(() => got.includes('ack {"type":"welcome"}'));
    // Only one tunnel per port while it is open.
    await new Promise((r) => setTimeout(r, 2500));
    expect(ctx.attached).toHaveLength(1);
    const connects = mux.requests.filter((r) => r.MessageType === 'Connect');
    const ports = new Set(
      connects.map((c) => {
        const raw = Number(c.PortNumber);
        return ((raw & 0xff) << 8) | (raw >> 8);
      }),
    );
    expect([...ports].filter((p) => p >= 9752 && p <= 9755).sort()).toEqual([9752, 9753, 9754, 9755]);
    expect(ports.has(62078)).toBe(true); // lockdown GetValue
  });

  it('forwards a local port to a device port through usbmux', async () => {
    mux.pair(UDID, false);
    mux.attach({ deviceId: 5, udid: UDID });
    mux.onPort(5, 41234, (sock) => sock.on('data', (d) => sock.write(`vm:${d.toString()}`)));
    await driver.start(ctx);
    await waitFor(() => ctx.hub.devices.get(ID));
    const fwd = await driver.forward(ID, 41234);
    expect(fwd.host).toBe('127.0.0.1');
    const c = net.connect(fwd.port, fwd.host);
    let got = '';
    c.on('data', (d) => (got += d.toString()));
    c.write('getVM');
    await waitFor(() => got === 'vm:getVM');
    await fwd.dispose();
    await waitFor(() => c.destroyed);
    await expect(driver.forward('ios:unknown', 1)).rejects.toThrow(/not connected/);
  });

  it('reports usbmuxd problems as data instead of throwing', async () => {
    const lonely = new IosDeviceDriver({ socketPath: `${mux.socketPath}.nope`, useDevicectl: false });
    await lonely.start(ctx);
    expect(lonely.status()).toMatchObject({ available: false, code: 'logs.usbmuxdUnavailable' });
    const checks = await lonely.checks();
    expect(checks.find((c) => c.id === 'usbmuxd')?.status).toBe('missing');
    expect(checks.find((c) => c.id === 'idevicesyslog')).toMatchObject({ status: 'ok', version: '1.3.0-fake', path: ctx.settings().idevicesyslogPath });
    await lonely.stop();
  });
});
