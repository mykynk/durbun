import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { DeviceActionResult, LogEntry, MockRule, NetworkEntry, ServerSettings, ServerToUi, ToolCheck } from '@durbun/protocol';
import { connectUi, sampleApp, sampleDevice, sampleNetwork, startTestApp, type TestApp, type UiTestClient } from './fakes';

let t: TestApp | undefined;
const clients: UiTestClient[] = [];

async function open(headers?: Record<string, string>): Promise<UiTestClient> {
  const c = await connectUi(t!.port, headers);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.close();
  t = undefined;
});

describe('WS /ui initial sync', () => {
  it('sends hello, snapshot, history in chunks of 5000 and then live batches', async () => {
    t = await startTestApp();
    t.hub.upsertDevice(sampleDevice());
    t.hub.apps.set('app:1', sampleApp());
    t.hub.network.set('app:1:7', sampleNetwork());
    t.hub.addLogs(12_345);
    t.config.setMocks([{ id: 'm1', enabled: true, method: 'get', url: '/v1/pets', match: 'contains', action: { type: 'respond', status: 503 }, createdAt: 1 }]);

    const c = await open();
    await c.synced();
    const types = c.messages.map((m) => m.type);
    expect(types.slice(0, 5)).toEqual(['hello', 'snapshot', 'history', 'history', 'history']);

    const hello = c.messages[0] as Extract<ServerToUi, { type: 'hello' }>;
    expect(hello.server.name).toBe('durbun');
    expect(hello.server.ports.http).toBe(t.port);
    expect(hello.server.protocol).toBe(1);
    expect(hello.settings.maxLogEntries).toBe(200_000);

    const snapshot = c.messages[1] as Extract<ServerToUi, { type: 'snapshot' }>;
    expect(snapshot.devices.map((d) => d.id)).toEqual(['android:R5CT1234']);
    expect(snapshot.apps.map((a) => a.id)).toEqual(['app:1']);
    expect(snapshot.network[0]).toMatchObject({ id: 'app:1:7', status: 200 });
    expect(snapshot.network[0]).not.toHaveProperty('responseBody');
    expect(snapshot.mocks[0]).toMatchObject({ id: 'm1', method: 'GET' });
    expect(snapshot.drivers.map((d) => d.id)).toEqual(['android', 'flutter-vm', 'demo']);
    expect(snapshot.logCount).toBe(12_345);

    const history = c.messages.filter((m): m is Extract<ServerToUi, { type: 'history' }> => m.type === 'history');
    expect(history.map((h) => h.logs.length)).toEqual([5_000, 5_000, 2_345]);
    expect(history.map((h) => h.done)).toEqual([false, false, true]);
    const ids = history.flatMap((h) => h.logs.map((l) => l.id));
    expect(ids[0]).toBe(1);
    expect(ids[ids.length - 1]).toBe(12_345);

    // Live: a batch with one already-delivered line (id 12345) and two new ones.
    const fresh = t.hub.addLogs(2);
    const from = c.messages.length;
    const updated: NetworkEntry = { ...sampleNetwork('app:1:8'), state: 'pending' };
    t.hub.emit({ logs: [t.hub.logs[12_344]!, ...fresh], network: [updated] });
    const batch = await c.waitForType('batch', 2_000, from);
    expect(batch.logs?.map((l) => l.id)).toEqual([12_346, 12_347]);
    expect(batch.network?.[0]?.id).toBe('app:1:8');
    expect(batch).not.toHaveProperty('devices');
  });

  it('sends one empty history chunk with done=true when the buffer is empty', async () => {
    t = await startTestApp();
    const c = await open();
    const h = await c.waitForType('history');
    expect(h).toEqual({ type: 'history', logs: [], done: true });
  });

  it('does not send empty batches and fans out cleared + notices to every client', async () => {
    t = await startTestApp();
    const a = await open();
    const b = await open();
    await Promise.all([a.synced(), b.synced()]);
    const fromA = a.messages.length;
    t.hub.emit({});
    t.hub.notice({ level: 'warn', message: 'adb restarted', code: 'adb.restarted' });
    const reply = await a.command({ name: 'clear', target: 'logs', deviceId: 'android:R5CT1234' });
    expect(reply).toMatchObject({ type: 'reply', ok: true, data: null });
    expect(t.hub.cleared).toEqual([{ target: 'logs', deviceId: 'android:R5CT1234' }]);
    for (const c of [a, b]) {
      await c.waitFor((m) => m.type === 'cleared' && m.target === 'logs' && m.deviceId === 'android:R5CT1234');
      await c.waitFor((m) => m.type === 'notice' && m.code === 'adb.restarted');
    }
    expect(a.messages.slice(fromA).some((m) => m.type === 'batch')).toBe(false);
  });

  it('broadcasts driver status only when it changes', async () => {
    t = await startTestApp();
    const c = await open();
    await c.synced();
    await new Promise((r) => setTimeout(r, 150));
    expect(c.messages.some((m) => m.type === 'drivers')).toBe(false);
    t.android.started = true; // status().active flips
    const drivers = await c.waitForType('drivers', 2_000);
    expect(drivers.drivers.find((d) => d.id === 'android')).toMatchObject({ active: true });
    const count = c.messages.filter((m) => m.type === 'drivers').length;
    await new Promise((r) => setTimeout(r, 150));
    expect(c.messages.filter((m) => m.type === 'drivers').length).toBe(count);
  });
});

describe('WS /ui access control', () => {
  it('accepts the UI origin, the Vite dev origin and clients without Origin', async () => {
    t = await startTestApp();
    const accepted: Record<string, string>[] = [{ Origin: `http://localhost:${t.port}` }, { Origin: 'http://localhost:5173' }, { Origin: `http://127.0.0.1:${t.port}` }, {}];
    for (const headers of accepted) {
      const c = await open(headers);
      await c.waitForType('hello');
    }
  });

  it('rejects foreign origins, cross-site fetch metadata and rebinding hosts with 403', async () => {
    t = await startTestApp();
    const attempts: Record<string, string>[] = [
      { Origin: 'https://evil.example' },
      { Origin: 'http://localhost:8080' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { Host: `evil.example:${t.port}` },
    ];
    for (const headers of attempts) {
      await expect(connectUi(t.port, headers)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('returns 404 for unknown upgrade paths and 426 for plain GET /ui', async () => {
    t = await startTestApp();
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/nope`);
    const status = await new Promise<number>((resolve) => {
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => resolve(-1));
    });
    expect(status).toBe(404);
    const res = await fetch(`${t.base}/ui`);
    expect(res.status).toBe(426);
  });
});

describe('WS /sdk', () => {
  it('accepts any origin and hands the socket to the SDK layer', async () => {
    t = await startTestApp();
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/sdk`, { headers: { Origin: 'http://192.168.1.50:8081' } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const echo = new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())));
    ws.send(JSON.stringify({ type: 'hello' }));
    expect(await echo).toBe('echo:{"type":"hello"}');
    expect(t.sdk.sockets).toHaveLength(1);
    expect(t.sdk.sockets[0]!.meta.transport).toBe('websocket');
    expect(t.sdk.sockets[0]!.meta.remote).toMatch(/^127\.0\.0\.1:\d+$/);
    ws.terminate();
  });
});

describe('WS /ui commands', () => {
  it('routes device actions to the owning driver and maps results', async () => {
    t = await startTestApp();
    const c = await open();
    await c.synced();
    const ok = await c.command({ name: 'device.action', deviceId: 'android:R5CT1234', action: 'screenshot' });
    expect(ok).toMatchObject({ ok: true, data: { url: '/api/files/shot.png' } });
    expect(t.android.actions).toEqual([{ deviceId: 'android:R5CT1234', action: 'screenshot', params: {} }]);

    t.android.result = { ok: false, error: 'device offline', code: 'device.offline' } satisfies DeviceActionResult;
    expect(await c.command({ name: 'device.action', deviceId: 'android:R5CT1234', action: 'open-url', params: { url: 'pati://home' } })).toMatchObject({
      ok: false,
      error: 'device offline',
      code: 'device.offline',
    });
    expect(t.android.actions[1]!.params).toEqual({ url: 'pati://home' });

    expect(await c.command({ name: 'device.action', deviceId: 'ios-sim:ABC', action: 'screenshot' })).toMatchObject({ ok: false, code: 'device.unknown' });
    expect(await c.command({ name: 'device.action', deviceId: 'import:1', action: 'screenshot' })).toMatchObject({ ok: false, code: 'device.readOnly' });
    expect(await c.command({ name: 'device.action', deviceId: 'demo:1', action: 'screenshot' })).toMatchObject({ ok: true });
    expect(t.demo.actions).toHaveLength(1);
    expect(await c.command({ name: 'device.action', action: 'screenshot' })).toMatchObject({ ok: false, code: 'command.invalid' });

    t.android.runAction = async () => {
      throw new Error('adb exploded');
    };
    expect(await c.command({ name: 'device.action', deviceId: 'android:R5CT1234', action: 'screenshot' })).toMatchObject({
      ok: false,
      error: 'adb exploded',
      code: 'command.failed',
    });
  });

  it('routes app actions through the SDK layer', async () => {
    t = await startTestApp();
    t.hub.apps.set('app:1', sampleApp());
    t.hub.apps.set('app:2', sampleApp('app:2', { connected: false }));
    const c = await open();
    await c.synced();
    expect(await c.command({ name: 'app.action', appId: 'app:1', action: 'flutter.debugPaint', params: { enabled: true } })).toMatchObject({
      ok: true,
      data: { toggled: true },
    });
    expect(t.sdk.commands).toEqual([{ appId: 'app:1', name: 'flutter.debugPaint', params: { enabled: true } }]);
    expect(await c.command({ name: 'app.action', appId: 'app:2', action: 'flutter.debugPaint' })).toMatchObject({ ok: false, code: 'app.disconnected' });
    expect(await c.command({ name: 'app.action', appId: 'app:9', action: 'x' })).toMatchObject({ ok: false, code: 'app.unknown' });
    t.sdk.commandResult = { ok: false, error: 'Unknown command' };
    expect(await c.command({ name: 'app.action', appId: 'app:1', action: 'nope' })).toMatchObject({ ok: false, error: 'Unknown command', code: 'action.failed' });
  });

  it('marker.add replies with the log entry', async () => {
    t = await startTestApp();
    const c = await open();
    await c.synced();
    const reply = await c.command({ name: 'marker.add', label: 'Login denemesi', deviceId: 'android:R5CT1234' });
    expect(reply.ok).toBe(true);
    expect(reply.data as LogEntry).toMatchObject({ kind: 'marker', message: 'Login denemesi', deviceId: 'android:R5CT1234' });
  });

  it('mocks.set validates, persists, pushes to the SDK layer and broadcasts', async () => {
    t = await startTestApp();
    const a = await open();
    const b = await open();
    await Promise.all([a.synced(), b.synced()]);
    const rules = [
      { id: 'r1', enabled: true, method: 'post', url: '*/v1/login', match: 'glob', action: { type: 'respond', status: 401, body: '{"error":"bad"}' }, createdAt: 5 },
      { id: 'r2', enabled: false, method: '*', url: 'cdn.pati.app', match: 'contains', action: { type: 'delay', delayMs: 2500 }, createdAt: 6 },
    ];
    const reply = await a.command({ name: 'mocks.set', rules });
    expect(reply.ok).toBe(true);
    const saved = reply.data as MockRule[];
    expect(saved.map((r) => r.method)).toEqual(['POST', '*']);
    expect(t.sdk.mocks).toEqual(saved);
    const fromB = await b.waitFor((m) => m.type === 'mocks' && m.rules.length === 2);
    expect(fromB).toMatchObject({ type: 'mocks', rules: saved });
    await t.config.flush();
    expect(JSON.parse(await readFile(path.join(t.config.dataDir, 'mocks.json'), 'utf8'))).toEqual(saved);

    const bad = await a.command({ name: 'mocks.set', rules: [{ id: 'x', url: 1, action: { type: 'respond', status: 200 } }] });
    expect(bad).toMatchObject({ ok: false, code: 'config.invalid' });
    expect(t.sdk.mocks).toEqual(saved);
  });

  it('settings.update clamps, persists, propagates and broadcasts', async () => {
    t = await startTestApp();
    const a = await open();
    const b = await open();
    await Promise.all([a.synced(), b.synced()]);
    const reply = await a.command({ name: 'settings.update', patch: { maxBodyBytes: 512, logcatTail: 500, watchedApps: [' com.pati ', 'com.pati'] } });
    expect(reply.ok).toBe(true);
    const settings = reply.data as ServerSettings;
    expect(settings.maxBodyBytes).toBe(1_024);
    expect(settings.logcatTail).toBe(500);
    expect(settings.watchedApps).toEqual(['com.pati']);
    await a.waitFor((m) => m.type === 'notice' && m.code === 'settings.adjusted');
    await b.waitFor((m) => m.type === 'settings' && m.settings.logcatTail === 500);
    expect(t.hub.settings.logcatTail).toBe(500);
    expect(t.sdk.configPatches.at(-1)).toEqual({ captureBodies: true, maxBodyBytes: 1_024, metricsIntervalMs: 1_000 });
    await t.config.flush();
    const onDisk = JSON.parse(await readFile(path.join(t.config.dataDir, 'settings.json'), 'utf8'));
    expect(onDisk).toEqual({ maxBodyBytes: 1_024, logcatTail: 500, watchedApps: ['com.pati'] });

    expect(await a.command({ name: 'settings.update', patch: { captureBodies: 'yes please' } })).toMatchObject({ ok: false, code: 'config.invalid' });
  });

  it('settings.update allowLan rebinds the SDK listener and explains the HTTP restart', async () => {
    t = await startTestApp();
    const c = await open();
    await c.synced();
    const reply = await c.command({ name: 'settings.update', patch: { allowLan: true } });
    expect(reply).toMatchObject({ ok: true, data: { allowLan: true } });
    expect(t.sdk.listenCalls.at(-1)).toEqual({ port: 39_751, host: '0.0.0.0' });
    const notice = await c.waitFor((m) => m.type === 'notice' && m.code === 'settings.lanOn');
    expect(notice).toMatchObject({ level: 'warn', params: { restartRequired: 1, sdkPort: 39_751 } });
    expect(t.app.sdkListener).toMatchObject({ host: '0.0.0.0', listening: true });

    t.sdk.listenError = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    await c.command({ name: 'settings.update', patch: { allowLan: false } });
    await c.waitFor((m) => m.type === 'notice' && m.code === 'settings.sdkRebindFailed');
    expect(t.app.sdkListener.listening).toBe(false);
  });

  it('vm.attach / vm.detach go to the Flutter VM module', async () => {
    t = await startTestApp();
    const c = await open();
    await c.synced();
    const paste = 'Launching lib/main.dart…\nA Dart VM Service on iPhone 16 Pro is available at: http://127.0.0.1:50123/Zx9_abc=/\n';
    expect(await c.command({ name: 'vm.attach', input: paste, deviceId: 'ios-sim:ABC' })).toMatchObject({ ok: true, data: { appId: 'app:vm-1' } });
    expect(t.vm.attached).toEqual([{ input: paste, opts: { deviceId: 'ios-sim:ABC' } }]);
    expect(await c.command({ name: 'vm.detach', appId: 'app:vm-1' })).toMatchObject({ ok: true, data: null });
    expect(t.vm.detached).toEqual(['app:vm-1']);
    t.vm.attachError = Object.assign(new Error('No VM service URL found'), { code: 'vm.noServiceUrl' });
    expect(await c.command({ name: 'vm.attach', input: 'nothing here' })).toMatchObject({ ok: false, error: 'No VM service URL found', code: 'vm.noServiceUrl' });
    t.vm.attachError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:50123'), { code: 'ECONNREFUSED' });
    expect(await c.command({ name: 'vm.attach', input: 'http://127.0.0.1:50123/x=/' })).toMatchObject({ ok: false, code: 'command.failed' });
  });

  it('metrics.watch is reference counted per UI connection', async () => {
    t = await startTestApp();
    const a = await open();
    const b = await open();
    await Promise.all([a.synced(), b.synced()]);
    const watch = { name: 'metrics.watch', deviceId: 'android:R5CT1234', pid: 12_345, enabled: true };
    expect(await a.command(watch)).toMatchObject({ ok: true, data: null });
    expect(await b.command(watch)).toMatchObject({ ok: true });
    expect(t.android.watches).toEqual([{ deviceId: 'android:R5CT1234', target: { pid: 12_345 }, enabled: true }]);
    await a.command({ ...watch, enabled: false });
    expect(t.android.watches).toHaveLength(1);
    b.ws.close();
    await b.waitClose();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.android.watches.at(-1)).toEqual({ deviceId: 'android:R5CT1234', target: { pid: 12_345 }, enabled: false });

    t.android.supportsMetrics = false;
    expect(await a.command(watch)).toMatchObject({ ok: false, code: 'metrics.unsupported' });
    expect(await a.command({ name: 'metrics.watch', deviceId: 'android:R5CT1234', enabled: true })).toMatchObject({ ok: false, code: 'command.invalid' });
  });

  it('demo.set starts and stops the demo driver', async () => {
    t = await startTestApp();
    const c = await open();
    await c.synced();
    expect(await c.command({ name: 'demo.set', enabled: true })).toMatchObject({ ok: true, data: { enabled: true } });
    expect(t.demo.started).toBe(true);
    expect(t.demo.context?.tempDir).toBe(t.config.tempDir);
    expect(t.app.info().demo).toBe(true);
    await c.waitFor((m) => m.type === 'drivers' && m.drivers.some((d) => d.id === 'demo' && d.active));
    expect(await c.command({ name: 'demo.set', enabled: true })).toMatchObject({ ok: true, data: { enabled: true } });
    expect(t.demo.startCalls).toBe(1);
    expect(await c.command({ name: 'demo.set', enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(t.demo.stopped).toBe(true);
    t.demo.startError = new Error('demo broke');
    expect(await c.command({ name: 'demo.set', enabled: true })).toMatchObject({ ok: false, error: 'demo broke' });
    expect(t.app.demoActive).toBe(false);
  });

  it('doctor.run aggregates environment, port and driver checks', async () => {
    t = await startTestApp();
    t.android.checkResult = [{ id: 'adb', label: 'adb', status: 'ok', version: '35.0.2', path: '/opt/homebrew/bin/adb' }];
    const c = await open();
    await c.synced();
    const reply = await c.command({ name: 'doctor.run' });
    expect(reply.ok).toBe(true);
    const checks = reply.data as ToolCheck[];
    const ids = checks.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['node', 'data-dir', 'ui-build', 'port-http', 'port-sdk', 'adb', 'flutter']));
    expect(checks.find((x) => x.id === 'port-http')).toMatchObject({ status: 'ok' });
    expect(checks.find((x) => x.id === 'ui-build')).toMatchObject({ status: 'warn', fix: 'npm run build' });
  });

  it('answers unknown and malformed commands without breaking the connection', async () => {
    t = await startTestApp();
    const c = await open();
    await c.synced();
    expect(await c.command({ name: 'self.destruct' })).toMatchObject({ ok: false, code: 'command.unknown' });
    expect(await c.command({ nope: true })).toMatchObject({ ok: false, code: 'command.invalid' });
    expect(await c.command({ name: 'clear', target: 'everything' })).toMatchObject({ ok: false, code: 'command.invalid' });
    c.ws.send('not json at all');
    c.ws.send(JSON.stringify({ type: 'command', command: { name: 'clear', target: 'logs' } })); // no requestId → ignored
    expect(await c.command({ name: 'clear', target: 'all' })).toMatchObject({ ok: true });
  });
});

describe('net.replay', () => {
  let target: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (target ? target.close(() => r()) : r()));
    target = undefined;
  });

  it('re-sends the request from the desktop and records it on the desktop device', async () => {
    const seen: { method?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    target = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ method: req.method, headers: req.headers, body });
        res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
        res.end(JSON.stringify({ id: 99, created: true }));
      });
    });
    await new Promise<void>((r) => target!.listen(0, '127.0.0.1', () => r()));
    const port = (target.address() as { port: number }).port;

    t = await startTestApp();
    t.hub.network.set(
      'app:1:3',
      sampleNetwork('app:1:3', {
        method: 'POST',
        url: `http://127.0.0.1:${port}/v1/pets`,
        requestHeaders: [
          ['content-type', 'application/json'],
          ['host', 'api.pati.app'],
          ['content-length', '999'],
          ['x-trace', 'abc'],
        ],
        requestBody: { encoding: 'utf8', data: '{"name":"Karabaş"}', size: 19 },
        hasRequestBody: true,
      }),
    );
    const c = await open();
    await c.synced();
    const reply = await c.command({ name: 'net.replay', id: 'app:1:3' });
    expect(reply.ok).toBe(true);
    const entry = reply.data as NetworkEntry;
    expect(entry).toMatchObject({ deviceId: 'desktop', source: 'replay', method: 'POST', status: 201, state: 'complete', host: `127.0.0.1:${port}`, path: '/v1/pets' });
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"name":"Karabaş"}' });
    expect(seen[0]!.headers['x-trace']).toBe('abc');
    expect(seen[0]!.headers.host).toBe(`127.0.0.1:${port}`);
    const recorded = t.hub.desktopRequests[0]!;
    expect(recorded.responseBody).toMatchObject({ encoding: 'utf8', data: '{"id":99,"created":true}' });
    expect(recorded.responseHeaders?.filter(([n]) => n === 'set-cookie')).toEqual([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    expect(recorded.timings?.wait).toBeGreaterThanOrEqual(0);

    // Edit & replay: overrides win, GET drops the body with a warning notice.
    const edited = await c.command({ name: 'net.replay', id: 'app:1:3', overrides: { method: 'GET', url: `http://127.0.0.1:${port}/v1/pets?x=1` } });
    expect(edited).toMatchObject({ ok: true, data: { method: 'GET', path: '/v1/pets?x=1' } });
    await c.waitFor((m) => m.type === 'notice' && m.code === 'replay.bodyDropped');
  });

  it('records network failures as failed entries and rejects unknown ids', async () => {
    t = await startTestApp();
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const deadPort = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    t.hub.network.set('app:1:4', sampleNetwork('app:1:4', { url: `http://127.0.0.1:${deadPort}/v1/pets` }));
    const c = await open();
    await c.synced();
    const reply = await c.command({ name: 'net.replay', id: 'app:1:4' });
    expect(reply).toMatchObject({ ok: true, data: { state: 'failed', deviceId: 'desktop' } });
    expect((reply.data as NetworkEntry).error).toMatch(/refused|ECONNREFUSED/i);
    expect(await c.command({ name: 'net.replay', id: 'gone' })).toMatchObject({ ok: false, code: 'net.unknown' });
  });
});
