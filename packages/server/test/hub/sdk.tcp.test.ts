import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { MockRule } from '@durbun/protocol';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import type { Hub, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { device, freePort, hello, makeHub, makeSettings, NdjsonClient, sleep, waitFor } from './helpers';

const rule = (patch: Partial<MockRule>): MockRule => ({
  id: 'r1',
  enabled: true,
  method: 'GET',
  url: '/v1/feed',
  match: 'contains',
  action: { type: 'respond', status: 503, body: '{"error":"maintenance"}' },
  createdAt: 1,
  ...patch,
});

let hub: Hub;
let sdk: SdkLayer;
let clients: NdjsonClient[] = [];
let mocks: MockRule[] = [];

async function setup(timings = {}) {
  hub = makeHub();
  mocks = [
    rule({ id: 'all-apps' }),
    rule({ id: 'other-app', apps: ['com.other.app'] }),
    rule({ id: 'disabled', enabled: false }),
    rule({ id: 'pati-only', apps: ['com.mykynk.pati'], method: '*', url: 'https://api.pati.app/v1/*', match: 'glob' }),
  ];
  sdk = createSdkLayerWithTimings(
    { hub, logger: silentLogger, settings: () => makeSettings({ maxBodyBytes: 65_536 }), mocks: () => mocks, serverVersion: '0.1.0' },
    timings,
  );
  const port = await freePort();
  await sdk.listen(port, '127.0.0.1');
  return port;
}

async function connect(port: number) {
  const c = await NdjsonClient.connect(port);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await sdk?.close();
  hub?.dispose();
});

describe('SDK layer over raw TCP', () => {
  it('handshakes: hello → welcome with app id, config and per-app mocks; creates a net device', async () => {
    const port = await setup();
    const c = await connect(port);
    c.send(hello());
    const welcome = await c.next('welcome');
    expect(welcome).toMatchObject({
      protocol: 1,
      server: 'durbun/0.1.0',
      config: { captureBodies: true, maxBodyBytes: 65_536, metricsIntervalMs: 1000, deviceLogsAvailable: false },
    });
    expect(welcome.appId).toMatch(/^app:\d+$/);
    expect(welcome.mocks.map((r) => r.id)).toEqual(['all-apps', 'pati-only']);
    const app = hub.getApp(welcome.appId)!;
    expect(app).toMatchObject({ connected: true, transport: 'tcp', sessionKey: 'launch-abc', app: { id: 'com.mykynk.pati' } });
    expect(app.deviceId).toBe('net:android-pixel-8-pixel-8');
    expect(hub.getDevice(app.deviceId)).toMatchObject({ kind: 'physical', connection: 'local', state: 'online', logs: { status: 'unavailable' } });
    expect(sdk.connectionCount()).toBe(1);
  });

  it('routes logs, network, events, metrics and action updates into the hub', async () => {
    const port = await setup();
    const c = await connect(port);
    c.send(hello());
    const { appId } = await c.next('welcome');
    c.send({ type: 'log', ts: 1000, level: 'warn', tag: 'auth', message: 'Token süresi doluyor', data: { expiresIn: 58 } });
    c.send({ type: 'net.request', id: 'r1', ts: 1001, method: 'GET', url: 'https://api.pati.app/v1/me', headers: [['accept', 'application/json']], source: 'dart:io' });
    c.send({ type: 'net.response', id: 'r1', ts: 1101, status: 200, headers: [['content-type', 'application/json']], body: { encoding: 'utf8', data: '{"id":4821}', size: 11 } });
    c.send({ type: 'event', ts: 1200, name: 'purchase', props: { orderId: 'PT-1', amount: 1249.7, currency: 'TRY' } });
    c.send({ type: 'metric', ts: 1300, cpu: 23.5, memoryMB: 211.2, fps: 58.9, jankyFrames: 2 });
    c.send({ type: 'actions', actions: [{ id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', value: true }] });
    await waitFor(() => hub.getApp(appId)?.actions.length);
    const logs = hub.getLogs().filter((l) => l.appId === appId);
    expect(logs.find((l) => l.tag === 'auth')).toMatchObject({ level: 'warn', source: 'app', data: { expiresIn: 58 } });
    expect(logs.find((l) => l.kind === 'event')).toMatchObject({ tag: 'event', message: 'purchase', level: 'info', data: { orderId: 'PT-1' } });
    expect(logs.find((l) => l.kind === 'network')).toMatchObject({ message: 'GET https://api.pati.app/v1/me', netId: `${appId}:r1` });
    expect(hub.getNetwork()[0]).toMatchObject({ state: 'complete', status: 200, duration: 100 });
    expect(hub.getMetrics()[0]).toMatchObject({ appId, source: 'sdk', cpu: 23.5, pid: 8421 });
    expect(hub.getApp(appId)!.actions[0]).toMatchObject({ id: 'flutter.debugPaint', value: true });
  });

  it('broadcasts mocks and config, and runs commands with a round-trip', async () => {
    const port = await setup();
    const c = await connect(port);
    c.send(hello());
    const { appId } = await c.next('welcome');
    sdk.setMocks([rule({ id: 'new', apps: ['com.mykynk.pati'] }), rule({ id: 'not-for-me', apps: ['com.other'] })]);
    const m = await c.next('mocks');
    expect(m.rules.map((r) => r.id)).toEqual(['new']);
    sdk.setConfig({ captureBodies: false, metricsIntervalMs: 2000 });
    const cfg = await c.next('config');
    expect(cfg.config).toMatchObject({ captureBodies: false, metricsIntervalMs: 2000, maxBodyBytes: 65_536 });

    const pending = sdk.sendCommand(appId, 'flutter.debugPaint', { value: true });
    const cmd = await c.next('command');
    expect(cmd).toMatchObject({ name: 'flutter.debugPaint', params: { value: true } });
    c.send({ type: 'command.result', id: cmd.id, ok: true, data: { value: true } });
    await expect(pending).resolves.toEqual({ ok: true, data: { value: true } });

    const failing = sdk.sendCommand(appId, 'flutter.unknown');
    const cmd2 = await waitFor(() => c.all('command')[1]);
    c.send({ type: 'command.result', id: cmd2.id, ok: false, error: 'Unknown command' });
    await expect(failing).resolves.toEqual({ ok: false, error: 'Unknown command' });

    await expect(sdk.sendCommand('app:404', 'x')).resolves.toMatchObject({ ok: false, code: 'app.notConnected' });
    await expect(sdk.sendCommand(appId, 'slow', undefined, 50)).resolves.toMatchObject({ ok: false, code: 'app.commandTimeout' });
  });

  it('pushes a config update when the device starts streaming logs', async () => {
    const port = await setup();
    hub.upsertDevice(device('android:R5CT', { logs: { status: 'starting' } }));
    const c = await connect(port);
    c.send(hello());
    const welcome = await c.next('welcome');
    expect(hub.getApp(welcome.appId)!.deviceId).toBe('android:R5CT'); // unambiguous model match
    expect(welcome.config.deviceLogsAvailable).toBe(false);
    hub.patchDevice('android:R5CT', { logs: { status: 'streaming', via: 'logcat' } });
    const cfg = await c.next('config');
    expect(cfg.config.deviceLogsAvailable).toBe(true);
  });

  it('reuses the app session on reconnect and marks disconnects', async () => {
    const port = await setup();
    const c1 = await connect(port);
    c1.send(hello());
    const w1 = await c1.next('welcome');
    c1.send({ type: 'net.request', id: 'p', ts: 1, method: 'GET', url: 'https://api.pati.app/v1/feed', headers: [], source: 'dart:io' });
    await waitFor(() => hub.getNetwork().length);
    c1.close();
    await waitFor(() => hub.getApp(w1.appId)?.connected === false);
    expect(hub.getNetwork()[0]).toMatchObject({ state: 'failed', error: 'App disconnected before the response arrived' });
    const deviceId = hub.getApp(w1.appId)!.deviceId;
    await waitFor(() => hub.getDevice(deviceId)?.state === 'disconnected');

    const c2 = await connect(port);
    c2.send(hello());
    const w2 = await c2.next('welcome');
    expect(w2.appId).toBe(w1.appId);
    expect(hub.getDevice(deviceId)!.state).toBe('online');
    c2.send({ type: 'net.response', id: 'p', ts: 5, status: 200, headers: [] });
    await waitFor(() => hub.getNetwork()[0]!.state === 'complete');
    const codes = hub.getLogs().filter((l) => l.source === 'system').map((l) => l.code);
    expect(codes).toEqual(['device.connected', 'app.connected', 'app.disconnected', 'device.disconnected', 'device.connected', 'app.reconnected']);
  });

  it('keeps the session connected while a second transport of the same launch is alive', async () => {
    const port = await setup();
    const a = await connect(port);
    const b = await connect(port);
    a.send(hello());
    const wa = await a.next('welcome');
    b.send(hello());
    const wb = await b.next('welcome');
    expect(wb.appId).toBe(wa.appId);
    a.close();
    await sleep(100);
    expect(hub.getApp(wa.appId)!.connected).toBe(true);
    b.close();
    await waitFor(() => hub.getApp(wa.appId)?.connected === false);
    expect(hub.getLogs().filter((l) => l.code === 'app.disconnected')).toHaveLength(1);
  });

  it('survives chunked frames, split UTF-8 and garbage input', async () => {
    const port = await setup();
    const c = await connect(port);
    c.writeRaw('this is not json\n{"type":"log","message":"before hello"}\n[1,2,3]\n');
    const helloBytes = Buffer.from(`${JSON.stringify(hello())}\n`);
    for (let i = 0; i < helloBytes.length; i += 7) {
      c.writeRaw(helloBytes.subarray(i, i + 7));
      await sleep(1);
    }
    const { appId } = await c.next('welcome');
    const line = Buffer.from(`${JSON.stringify({ type: 'log', ts: 1, level: 'info', tag: 'i18n', message: 'Ödeme başarılı ✓ 🐾 İstanbul' })}\n`);
    const cut = line.indexOf(Buffer.from('🐾')) + 2; // inside the 4-byte emoji
    c.writeRaw(line.subarray(0, cut));
    await sleep(20);
    c.writeRaw(line.subarray(cut));
    c.writeRaw('{"type":"net.request"}\n{"type":"metric"}\n{"type":"unknown","x":1}\nnull\n{"broken":\n');
    c.writeRaw(`${JSON.stringify({ type: 'log', ts: 2, level: 'info', message: 'still alive' })}\n`);
    await waitFor(() => hub.getLogs().some((l) => l.message === 'still alive'));
    const messages = hub.getLogs().filter((l) => l.appId === appId && l.source === 'app').map((l) => l.message);
    expect(messages).toEqual(['Ödeme başarılı ✓ 🐾 İstanbul', 'still alive']);
    expect(hub.getLogs().some((l) => l.message === 'before hello')).toBe(false);
    expect(c.closed).toBe(false);
  });

  it('closes connections without hello, pings established ones and closes idle ones', async () => {
    const port = await setup({ helloTimeoutMs: 100, pingIntervalMs: 50, idleTimeoutMs: 300 });
    const silent = await connect(port);
    await waitFor(() => silent.closed, 2000);

    const c = await connect(port);
    c.send(hello());
    const { appId } = await c.next('welcome');
    const ping = await c.next('ping');
    expect(typeof ping.ts).toBe('number');
    // answering pongs keeps it alive past the idle timeout
    const keep = setInterval(() => c.send({ type: 'pong', ts: Date.now() }), 60);
    await sleep(450);
    clearInterval(keep);
    expect(c.closed).toBe(false);
    await waitFor(() => c.closed, 2000);
    await waitFor(() => hub.getApp(appId)?.connected === false);
  });

  it('can rebind the listener (LAN toggle) without dropping live sessions', async () => {
    const port = await setup();
    const c = await connect(port);
    c.send(hello());
    const { appId } = await c.next('welcome');
    const port2 = await freePort();
    await sdk.listen(port2, '127.0.0.1');
    await expect(new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve('connected');
      });
      s.once('error', reject);
    })).rejects.toThrow();
    const c2 = await connect(port2);
    c2.send(hello({ session: 'other-launch' }));
    await c2.next('welcome');
    expect(hub.getApp(appId)!.connected).toBe(true);
    // rebinding the same port works too
    await sdk.listen(port2, '127.0.0.1');
    const c3 = await connect(port2);
    c3.send(hello({ session: 'third' }));
    await c3.next('welcome');
  });

  it('close() shuts everything down and resolves pending commands', async () => {
    const port = await setup();
    const c = await connect(port);
    c.send(hello());
    const { appId } = await c.next('welcome');
    const pending = sdk.sendCommand(appId, 'never-answered');
    await sdk.close();
    await expect(pending).resolves.toMatchObject({ ok: false });
    await waitFor(() => c.closed);
    expect(sdk.connectionCount()).toBe(0);
    expect(hub.getApp(appId)!.connected).toBe(false);
  });
});
