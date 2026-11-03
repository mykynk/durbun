import net from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StartServerOptions } from '../../src/types';
import { installShutdownHandlers, SERVER_VERSION, ServerStartError, startServerWith, type ServerFactories, type StartedServer } from '../../src/server';
import { silentLogger } from '../../src/util/logger';
import { connectUi, FakeDriver, FakeHub, FakeSdk, FakeVm, makeTempDir } from './fakes';

let dir: string;
let running: StartedServer | undefined;

interface Fakes {
  hub: FakeHub;
  sdk: FakeSdk;
  android: FakeDriver;
  iosSim: FakeDriver;
  iosDevice: FakeDriver;
  vm: FakeVm;
  demo: FakeDriver;
  factories: ServerFactories;
}

function fakes(patch: Partial<ServerFactories> = {}): Fakes {
  const f = {
    hub: new FakeHub(),
    sdk: new FakeSdk(),
    android: new FakeDriver('android', 'android:'),
    iosSim: new FakeDriver('ios-sim', 'ios-sim:'),
    iosDevice: new FakeDriver('ios-device', 'ios:'),
    vm: new FakeVm(),
    demo: new FakeDriver('demo', 'demo:'),
  } as Fakes;
  f.factories = {
    createHub: (opts) => {
      f.hub.settings = opts.settings;
      return f.hub;
    },
    createSdkLayer: () => f.sdk,
    createPlatform: () => ({ drivers: [f.android, f.iosSim, f.iosDevice], services: { forwardToDevice: async () => ({ host: '127.0.0.1', port: 1, dispose: async () => {} }) } }),
    createFlutterVmModule: () => f.vm,
    createDemoDriver: () => f.demo,
    ...patch,
  };
  return f;
}

function options(patch: Partial<StartServerOptions> = {}): StartServerOptions {
  return { httpPort: 0, sdkPort: 39_761, demo: false, dataDir: path.join(dir, 'data'), verbose: false, ...patch };
}

const extras = () => ({ logger: silentLogger, moduleDir: dir, driverStartWaitMs: 500 });

beforeEach(async () => {
  dir = await makeTempDir('durbun-server-');
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

function portOf(url: string): number {
  return Number(new URL(url).port);
}

async function isClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });
}

describe('startServer wiring', () => {
  it('starts every module, serves the API and shuts everything down', async () => {
    const f = fakes();
    running = await startServerWith(options({ demo: true }), f.factories, extras());
    const port = portOf(running.url);
    expect(running.url).toBe(`http://localhost:${port}`);
    expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toMatchObject({ ok: true, name: 'durbun' });

    expect(f.sdk.listenCalls).toEqual([{ port: 39_761, host: '127.0.0.1' }]);
    for (const d of [f.android, f.iosSim, f.iosDevice]) {
      expect(d.started).toBe(true);
      expect(d.context?.ports).toEqual({ http: port, sdk: 39_761 });
      expect(d.context?.fileUrl('shot 1.png')).toBe('/api/files/shot%201.png');
      expect(d.context?.tempDir).toBe(path.join(dir, 'data', 'tmp'));
    }
    expect(f.vm.started).toBe(true);
    expect(f.demo.started).toBe(true);
    expect(running.info).toMatchObject({ name: 'durbun', demo: true, lan: false, ports: { http: port, sdk: 39_761 }, dataDir: path.join(dir, 'data') });
    expect(running.sdkListening).toBe(true);
    expect(running.warnings).toEqual(['The web UI is not built yet: run "npm run build" (the browser shows a placeholder page until then).']);
    expect(running.notices).toEqual([{ code: 'ui.missing', message: running.warnings[0] }]);

    // A settings change from the UI reaches drivers (ctx.onSettings / ctx.settings) and the hub.
    const seen: number[] = [];
    f.android.context!.onSettings((s) => seen.push(s.logcatTail));
    const ui = await connectUi(port);
    await ui.synced();
    expect(await ui.command({ name: 'settings.update', patch: { logcatTail: 750 } })).toMatchObject({ ok: true });
    expect(seen).toEqual([750]);
    expect(f.android.context!.settings().logcatTail).toBe(750);
    expect(f.hub.settings.logcatTail).toBe(750);
    ui.ws.terminate();

    await running.stop();
    const stoppedAgain = running.stop(); // idempotent
    await stoppedAgain;
    running = undefined;
    for (const d of [f.android, f.iosSim, f.iosDevice, f.demo]) expect(d.stopped).toBe(true);
    expect(f.vm.stopped).toBe(true);
    expect(f.sdk.closed).toBe(true);
    expect(f.hub.disposed).toBe(true);
    expect(await isClosed(port)).toBe(true);
  });

  it('keeps running when drivers fail to start or hang', async () => {
    const f = fakes();
    f.android.startError = new Error('adb: command not found');
    f.iosDevice.startDelayMs = 10_000;
    const t0 = Date.now();
    running = await startServerWith(options(), f.factories, extras());
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(f.iosSim.started).toBe(true);
    expect(f.android.started).toBe(false);
    const res = await fetch(`http://127.0.0.1:${portOf(running.url)}/api/health`);
    expect(res.status).toBe(200);
    const t1 = Date.now();
    await running.stop();
    running = undefined;
    expect(Date.now() - t1).toBeLessThan(8_000);
  });

  it('replaces modules that fail to construct with unavailable stand-ins', async () => {
    const f = fakes({
      createPlatform: () => {
        throw new Error('createPlatform: not implemented yet');
      },
      createFlutterVmModule: () => {
        throw new Error('vm boom');
      },
      createSdkLayer: () => {
        throw new Error('sdk boom');
      },
      createDemoDriver: () => {
        throw new Error('demo boom');
      },
    });
    running = await startServerWith(options({ demo: true }), f.factories, extras());
    expect(running.warnings.join('\n')).toMatch(/Device drivers are unavailable: createPlatform: not implemented yet/);
    expect(running.warnings.join('\n')).toMatch(/App SDK connections are unavailable: sdk boom/);
    expect(running.warnings.join('\n')).toMatch(/Flutter VM Service capture is unavailable: vm boom/);
    expect(running.warnings.join('\n')).toMatch(/Demo mode is unavailable: demo boom/);
    // the same problems with codes and parameters (the Mac app words them in Turkish)
    expect(running.notices?.map((n) => [n.code, n.params])).toEqual([
      ['sdk.unavailable', { reason: 'sdk boom' }],
      ['drivers.unavailable', { reason: 'createPlatform: not implemented yet' }],
      ['vm.unavailable', { reason: 'vm boom' }],
      ['demo.unavailable', { reason: 'demo boom' }],
      ['ui.missing', undefined],
      ['sdk.listenFailed', { port: 39_761, error: 'Could not listen on 127.0.0.1:39761: SDK layer unavailable: sdk boom' }],
      ['demo.startFailed', { reason: 'Demo mode is not available in this build' }],
    ]);
    expect(running.notices?.map((n) => n.message)).toEqual(running.warnings);
    expect(running.sdkListening).toBe(false);
    const statuses = running.app.driverStatuses();
    expect(statuses.map((s) => [s.id, s.available])).toEqual([
      ['android', false],
      ['ios-sim', false],
      ['ios-device', false],
      ['flutter-vm', false],
    ]);
    const checks = await running.app.runDoctor();
    expect(checks.find((c) => c.id === 'driver-android')).toMatchObject({ status: 'error' });
    expect(checks.find((c) => c.id === 'port-sdk')).toMatchObject({ status: 'error' });
  });

  it('fails clearly when the hub cannot be created', async () => {
    const f = fakes({
      createHub: () => {
        throw new Error('createHub: not implemented yet');
      },
    });
    await expect(startServerWith(options(), f.factories, extras())).rejects.toMatchObject({
      name: 'ServerStartError',
      code: 'hub.failed',
      message: 'The log store (hub) could not be created: createHub: not implemented yet',
    });
  });

  it('reports a busy HTTP port with EADDRINUSE and cleans up', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    const f = fakes();
    try {
      const err = await startServerWith(options({ httpPort: port }), f.factories, extras()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServerStartError);
      expect(err).toMatchObject({ code: 'EADDRINUSE', port });
      expect(f.sdk.closed).toBe(true);
      expect(f.hub.disposed).toBe(true);
      expect(f.android.startCalls).toBe(0);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('warns when the SDK port cannot be opened but keeps serving', async () => {
    const f = fakes();
    f.sdk.listenError = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:39761'), { code: 'EADDRINUSE' });
    running = await startServerWith(options(), f.factories, extras());
    expect(running.sdkListening).toBe(false);
    expect(running.warnings.join('\n')).toMatch(/SDK port 39761: Port 39761 is already used by another program/);
    expect(running.notices?.at(-1)).toEqual({ code: 'sdk.portBusy', params: { port: 39_761 }, message: running.warnings.at(-1) });
  });

  it('gives config problems codes too, and exports the server version for embedders', async () => {
    const data = path.join(dir, 'data');
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'settings.json'), JSON.stringify({ iosSimLogScope: 'everything' }));
    await writeFile(path.join(data, 'mocks.json'), '[{ "id": ');
    running = await startServerWith(options(), fakes().factories, extras());
    const byCode = (code: string) => running!.notices?.filter((n) => n.code === code) ?? [];
    expect(byCode('config.invalid')).toEqual([
      { code: 'config.invalid', params: { file: 'settings.json', detail: 'iosSimLogScope must be one of apps, all — using the default' }, message: 'settings.json: iosSimLogScope must be one of apps, all — using the default' },
    ]);
    const unreadable = byCode('config.unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]!.params).toMatchObject({ file: 'mocks.json', backup: expect.stringContaining('mocks.json.corrupt-') });
    expect(running.notices?.map((n) => n.message)).toEqual(running.warnings);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(running.info.version).toBe(SERVER_VERSION);
  });
});

describe('installShutdownHandlers', () => {
  it('stops gracefully on the first signal and forces exit on the second', async () => {
    const exits: number[] = [];
    const logs: string[] = [];
    let release!: () => void;
    const stopped = new Promise<void>((r) => (release = r));
    let stops = 0;
    const remove = installShutdownHandlers(
      {
        stop: () => {
          stops++;
          return stopped;
        },
      },
      { exit: (c) => exits.push(c), log: (l) => logs.push(l) },
    );
    try {
      process.emit('SIGHUP', 'SIGHUP');
      expect(stops).toBe(1);
      expect(logs[0]).toMatch(/Kapatılıyor… · shutting down/);
      process.emit('SIGHUP', 'SIGHUP');
      expect(exits).toEqual([130]);
      release();
      await new Promise((r) => setTimeout(r, 10));
      expect(exits).toEqual([130, 0]);
    } finally {
      remove();
    }
  });
});
