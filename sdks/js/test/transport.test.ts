/** End-to-end against a fake desktop: hello/welcome, logs/events, ping, commands, buffering, reconnect. */
import { afterEach, describe, expect, it } from 'vitest';
import WsClient from 'ws';
import { Durbun } from '../src/index.js';
import { FakeDesktop, sleep, waitFor } from './helpers/fakeDesktop.js';
import { closedPort } from './helpers/httpServer.js';

let desktop: FakeDesktop | undefined;
let extra: FakeDesktop | undefined;

afterEach(async () => {
  Durbun.stop();
  await desktop?.close();
  await extra?.close();
  desktop = undefined;
  extra = undefined;
});

const quiet = { captureConsole: false, captureNetwork: false, captureMetrics: false, captureErrors: false } as const;

async function startConnected(options: Parameters<typeof Durbun.start>[0] = {}) {
  desktop = desktop ?? (await FakeDesktop.start());
  Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: true, ...quiet, ...options });
  await waitFor(() => Durbun.isConnected, 5_000, 'connection');
  return desktop;
}

describe('handshake', () => {
  it('sends a complete hello and becomes connected on welcome', async () => {
    const d = await startConnected({ appId: 'com.mykynk.pati', appName: 'Pati', appVersion: '1.4.0', captureNetwork: true, captureErrors: true });
    const hello = d.messages('hello')[0];
    expect(hello).toMatchObject({
      type: 'hello',
      protocol: 1,
      sdk: { name: '@durbun/react-native', version: '0.1.0', platform: 'js' },
      app: { id: 'com.mykynk.pati', name: 'Pati', version: '1.4.0', pid: process.pid },
      device: { platform: 'other' },
    });
    expect(typeof hello.session).toBe('string');
    expect(hello.session.length).toBeGreaterThanOrEqual(16);
    expect(hello.capabilities).toEqual(expect.arrayContaining(['logs', 'events', 'commands', 'network', 'mocks', 'crash']));
    expect(hello.capabilities).not.toContain('metrics');
    expect(Math.abs(hello.ts - Date.now())).toBeLessThan(5_000);
    expect(Durbun.isStarted).toBe(true);
  });

  it('works with an injected WebSocket implementation (Node < 22: the ws package)', async () => {
    const d = await startConnected({ WebSocket: WsClient });
    Durbun.info('via ws');
    await d.waitForMessage((m) => m.type === 'log' && m.message === 'via ws');
  });

  it('races candidates without creating duplicate sessions on the desktop', async () => {
    desktop = await FakeDesktop.start();
    // 'localhost' expands to localhost + 127.0.0.1: both reach the same desktop.
    Durbun.start({ host: 'localhost', port: desktop.port, enabled: true, ...quiet });
    await waitFor(() => Durbun.isConnected, 5_000, 'connection');
    await sleep(200);
    expect(desktop.messages('hello')).toHaveLength(1);
    expect(desktop.openSockets()).toBe(1);
  });

  it('enabled: false does nothing at all', async () => {
    desktop = await FakeDesktop.start();
    const originalLog = console.log;
    Durbun.start({ host: '127.0.0.1', port: desktop.port, enabled: false });
    expect(Durbun.isStarted).toBe(false);
    expect(console.log).toBe(originalLog);
    Durbun.info('ignored');
    await sleep(300);
    expect(desktop.connections).toBe(0);
  });
});

describe('logging API', () => {
  it('sends logs with levels, tags, JSON-safe data and errors, plus events, in order', async () => {
    const d = await startConnected();
    const cyclic: Record<string, unknown> = { id: 7 };
    cyclic.self = cyclic;
    Durbun.log('Kullanıcı giriş yaptı', { tag: 'auth', data: { userId: 42 } });
    Durbun.log('Verbose detail', { level: 'verbose' });
    Durbun.debug('cache hit', { data: cyclic });
    Durbun.info('plain');
    Durbun.warn('slow', new Error('took 3 s'));
    Durbun.error('Ödeme başarısız', { error: new TypeError('card declined'), tag: 'payment', data: { amount: 49.9, big: 10n } });
    Durbun.error('caught', 'just a string');
    Durbun.event('purchase', { amount: 49.9, currency: 'TRY' });
    Durbun.event('opened');
    await waitFor(() => d.appMessages().length >= 9, 5_000, '9 messages');
    const [m1, m2, m3, m4, m5, m6, m7, e1, e2] = d.appMessages();
    expect(m1).toMatchObject({ type: 'log', level: 'info', tag: 'auth', message: 'Kullanıcı giriş yaptı', data: { userId: 42 } });
    expect(m2).toMatchObject({ level: 'verbose', tag: 'app', message: 'Verbose detail' });
    expect(m3).toMatchObject({ level: 'debug', data: { id: 7, self: '[Circular]' } });
    expect(m4).toMatchObject({ level: 'info', message: 'plain' });
    expect(m4.data).toBeUndefined();
    expect(m5).toMatchObject({ level: 'warn', error: { type: 'Error', message: 'took 3 s' } });
    expect(m6).toMatchObject({ level: 'error', tag: 'payment', error: { type: 'TypeError', message: 'card declined' }, data: { amount: 49.9, big: '10n' } });
    expect(m6.error.stack).toContain('card declined');
    expect(m7).toMatchObject({ level: 'error', error: { type: 'string', message: 'just a string' } });
    expect(e1).toMatchObject({ type: 'event', name: 'purchase', props: { amount: 49.9, currency: 'TRY' } });
    expect(e2).toEqual({ type: 'event', ts: expect.any(Number), name: 'opened' });
    for (const m of d.appMessages()) expect(typeof m.ts).toBe('number');
  });

  it('is a silent no-op before start and after stop', async () => {
    Durbun.info('before start');
    Durbun.event('x');
    const d = await startConnected();
    Durbun.stop();
    Durbun.info('after stop');
    await sleep(200);
    expect(d.appMessages()).toEqual([]);
    expect(Durbun.isStarted).toBe(false);
    expect(Durbun.isConnected).toBe(false);
  });
});

describe('protocol messages', () => {
  it('answers ping with pong', async () => {
    const d = await startConnected();
    d.broadcast({ type: 'ping', ts: 123 });
    await d.waitForMessage((m) => m.type === 'pong');
  });

  it('runs app actions, reports results and keeps toggle state; unknown commands fail', async () => {
    const calls: unknown[] = [];
    const clear = Durbun.addAction({ id: 'app.clearCache', label: 'Önbelleği temizle' }, (params) => {
      calls.push(params);
      return { cleared: 12 };
    });
    const toggle = Durbun.addAction({ id: 'app.mockLocation', label: 'Sahte konum', kind: 'toggle', value: false }, () => undefined);
    Durbun.addAction({ id: 'app.fail', label: 'Fail' }, async () => {
      throw new Error('cannot do that');
    });
    try {
      const d = await startConnected();
      const hello = d.messages('hello')[0];
      expect(hello.actions).toEqual(
        expect.arrayContaining([
          { id: 'app.clearCache', kind: 'button', label: 'Önbelleği temizle' },
          { id: 'app.mockLocation', kind: 'toggle', label: 'Sahte konum', value: false },
        ]),
      );
      d.broadcast({ type: 'command', id: 'c1', name: 'app.clearCache', params: { force: true } });
      d.broadcast({ type: 'command', id: 'c2', name: 'app.mockLocation', params: { value: true } });
      d.broadcast({ type: 'command', id: 'c3', name: 'app.fail' });
      d.broadcast({ type: 'command', id: 'c4', name: 'flutter.debugPaint' });
      await waitFor(() => d.messages('command.result').length >= 4, 5_000, 'results');
      const results = Object.fromEntries(d.messages('command.result').map((r) => [r.id, r]));
      expect(results.c1).toEqual({ type: 'command.result', id: 'c1', ok: true, data: { cleared: 12 } });
      expect(results.c2).toEqual({ type: 'command.result', id: 'c2', ok: true });
      expect(results.c3).toEqual({ type: 'command.result', id: 'c3', ok: false, error: 'cannot do that' });
      expect(results.c4).toEqual({ type: 'command.result', id: 'c4', ok: false, error: 'Unknown command: flutter.debugPaint' });
      expect(calls).toEqual([{ force: true }]);
      // toggle state change is pushed to the desktop
      const update = await d.waitForMessage((m) => m.type === 'actions' && m.actions.some((a: any) => a.id === 'app.mockLocation' && a.value === true));
      expect(update.actions.length).toBeGreaterThanOrEqual(3);
      clear.remove();
      await d.waitForMessage((m) => m.type === 'actions' && !m.actions.some((a: any) => a.id === 'app.clearCache'));
      toggle.update({ label: 'Konum (sahte)' });
      await d.waitForMessage((m) => m.type === 'actions' && m.actions.some((a: any) => a.label === 'Konum (sahte)'));
    } finally {
      toggle.remove();
      Durbun.addAction({ id: 'app.fail', label: 'x' }, () => undefined).remove();
    }
  });
});

describe('buffering and reconnect', () => {
  it('buffers messages until the desktop appears, then flushes them in order', async () => {
    const port = await closedPort();
    Durbun.start({ host: '127.0.0.1', port, enabled: true, ...quiet });
    for (let i = 1; i <= 3; i++) Durbun.info(`early ${i}`);
    await sleep(700); // a few failed attempts
    desktop = await FakeDesktop.start({ port });
    await waitFor(() => desktop!.logs().length >= 3, 8_000, 'flushed logs');
    expect(desktop.logs().map((m) => m.message)).toEqual(['early 1', 'early 2', 'early 3']);
    const firstHello = desktop.received.findIndex((r) => r.msg.type === 'hello');
    const firstLog = desktop.received.findIndex((r) => r.msg.type === 'log');
    expect(firstHello).toBeLessThan(firstLog);
  });

  it('keeps only the newest maxBufferedMessages and reports how many were dropped', async () => {
    const port = await closedPort();
    Durbun.start({ host: '127.0.0.1', port, enabled: true, maxBufferedMessages: 5, ...quiet });
    for (let i = 1; i <= 12; i++) Durbun.info(`m${i}`);
    desktop = await FakeDesktop.start({ port });
    await waitFor(() => desktop!.logs().length >= 6, 8_000, 'logs + drop warning');
    const logs = desktop.logs();
    expect(logs.slice(0, 5).map((m) => m.message)).toEqual(['m8', 'm9', 'm10', 'm11', 'm12']);
    expect(logs[5]).toMatchObject({ level: 'warn', tag: 'durbun', data: { dropped: 7, bufferLimit: 5 } });
    expect(logs[5].message).toContain('7 messages were dropped');
  });

  it('reconnects with the same session after the connection drops and keeps logging', async () => {
    const d = await startConnected();
    Durbun.info('before drop');
    await d.waitForMessage((m) => m.message === 'before drop');
    const session = d.messages('hello')[0].session;
    const t0 = Date.now();
    d.dropConnections();
    await waitFor(() => !Durbun.isConnected, 3_000, 'disconnect');
    Durbun.info('while down');
    await waitFor(() => d.messages('hello').length === 2 && Durbun.isConnected, 5_000, 'reconnect');
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(d.messages('hello')[1].session).toBe(session);
    Durbun.info('after reconnect');
    await d.waitForMessage((m) => m.message === 'after reconnect');
    const texts = d.logs().map((m) => m.message);
    expect(texts).toEqual(['before drop', 'while down', 'after reconnect']);
  });

  it('survives a desktop restart on the same port', async () => {
    const d = await startConnected();
    const port = d.port;
    await d.close();
    desktop = undefined;
    // Frames written before the SDK notices the closed socket are lost (no acks in the protocol);
    // everything logged while the desktop is down is buffered.
    await waitFor(() => !Durbun.isConnected, 3_000, 'disconnect');
    Durbun.info('during restart');
    await sleep(300);
    extra = await FakeDesktop.start({ port });
    await extra.waitForMessage((m) => m.type === 'log' && m.message === 'during restart', 8_000);
    expect(extra.messages('hello')).toHaveLength(1);
  });

  it('applies config and mock updates from the desktop', async () => {
    const d = await startConnected();
    d.broadcast({ type: 'config', config: { captureBodies: false, maxBodyBytes: 10, metricsIntervalMs: 500, deviceLogsAvailable: true } });
    d.broadcast({ type: 'mocks', rules: [{ id: 'r', enabled: true, method: '*', url: 'x', match: 'contains', action: { type: 'delay', delayMs: 1 }, createdAt: 0 }] });
    await d.barrier();
    Durbun.info('still fine');
    await d.waitForMessage((m) => m.message === 'still fine');
  });
});
