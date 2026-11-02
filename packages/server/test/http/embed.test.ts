/**
 * Programmatic entry for embedding hosts such as the Mac app (SPEC §10.7): startServer / startServerWith
 * start and stop without touching the host process (no exit, no signal / error handlers, no stdin), and
 * probeServer tells "a Dürbün is already running on this port" apart from "something else".
 */
import http from 'node:http';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleDir } from '../../src/http/static';
import { probeServer, startServer, startServerWith, type ServerFactories, type StartedServer, type StartServerExtras } from '../../src/server';
import type { DriverContext, StartServerOptions } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { FakeDriver, FakeHub, FakeSdk, FakeVm, makeTempDir } from './fakes';

let dir: string;
let running: StartedServer | undefined;

beforeEach(async () => {
  dir = await makeTempDir('durbun-embed-');
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit'] as const;
const listenerCounts = () => Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));

function factories(): { factories: ServerFactories; android: FakeDriver; hub: FakeHub } {
  const hub = new FakeHub();
  const android = new FakeDriver('android', 'android:');
  return {
    hub,
    android,
    factories: {
      createHub: (opts) => {
        hub.settings = opts.settings;
        return hub;
      },
      createSdkLayer: () => new FakeSdk(),
      createPlatform: () => ({
        drivers: [android, new FakeDriver('ios-sim', 'ios-sim:'), new FakeDriver('ios-device', 'ios:')],
        services: { forwardToDevice: async () => ({ host: '127.0.0.1', port: 1, dispose: async () => {} }) },
      }),
      createFlutterVmModule: () => new FakeVm(),
      createDemoDriver: () => new FakeDriver('demo', 'demo:'),
    },
  };
}

const options = (patch: Partial<StartServerOptions> = {}): StartServerOptions => ({
  httpPort: 0,
  sdkPort: 39_771,
  demo: false,
  dataDir: path.join(dir, 'data'),
  uiDir: undefined,
  verbose: false,
  ...patch,
});

describe('embedding the server (Mac app)', () => {
  it('starts and stops without process side effects; url, info and probeServer work', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const before = listenerCounts();
    const f = factories();
    const extras: StartServerExtras = { logger: silentLogger, moduleDir: dir, driverStartWaitMs: 300 };
    running = await startServerWith(options(), f.factories, extras);
    expect(listenerCounts()).toEqual(before);
    expect(running.url).toMatch(/^http:\/\/localhost:\d+$/);
    const port = Number(new URL(running.url).port);
    expect(port).toBeGreaterThan(0); // httpPort 0 → a free port, reported in url
    expect(running.info.ports.http).toBe(port);

    const health = (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json())) as { ok: boolean; name: string; version: string };
    expect(health).toMatchObject({ ok: true, name: 'durbun' });
    expect(await probeServer(port)).toEqual({ version: health.version });

    // drivers get the device-apps accessor in their context
    const ctx: DriverContext | undefined = f.android.context;
    expect(ctx).toBeDefined();
    f.hub.upsertDeviceApp({ deviceId: 'android:R5CT', id: 'com.mykynk.kumbara' });
    expect(ctx!.getDeviceApps().map((a) => a.key)).toEqual(['android:R5CT|com.mykynk.kumbara']);

    const stopping = running.stop();
    expect(running.stop()).toBe(stopping); // idempotent: same promise
    await stopping;
    running = undefined;
    expect(await probeServer(port, 500)).toBeUndefined();
    expect(listenerCounts()).toEqual(before);
    expect(exit).not.toHaveBeenCalled();
  });

  it('probeServer never rejects: closed port, invalid port, another HTTP server', async () => {
    expect(await probeServer(0)).toBeUndefined();
    expect(await probeServer(70_000)).toBeUndefined();
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'something-else' }));
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const port = (other.address() as { port: number }).port;
    try {
      expect(await probeServer(port)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
    expect(await probeServer(port, 300)).toBeUndefined();
  });

  it('startServer takes optional extras (logger, driverStartWaitMs) and the module dir resolves', () => {
    const typed: (opts: StartServerOptions, extras?: StartServerExtras) => Promise<StartedServer> = startServer;
    expect(typeof typed).toBe('function');
    expect(startServer.length).toBe(1); // extras is optional
    expect(path.isAbsolute(moduleDir())).toBe(true);
  });
});
