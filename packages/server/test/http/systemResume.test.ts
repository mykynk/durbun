/**
 * StartedServer.onSystemResume: after the Mac wakes from sleep every driver that implements resume() is
 * asked to check its streams; failures are logged, never thrown, and wake events close together are folded.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServerWith, SYSTEM_RESUME_DEBOUNCE_MS, type ServerFactories, type StartedServer } from '../../src/server';
import type { DeviceDriver } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { FakeDriver, FakeHub, FakeSdk, FakeVm, makeTempDir } from './fakes';

let dir: string;
let running: StartedServer | undefined;

beforeEach(async () => {
  dir = await makeTempDir('durbun-resume-');
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class ResumingDriver extends FakeDriver {
  resumes = 0;
  failWith: 'throw' | 'reject' | undefined;
  resume(): void | Promise<void> {
    this.resumes++;
    if (this.failWith === 'throw') throw new Error('resume broke');
    if (this.failWith === 'reject') return Promise.reject(new Error('resume rejected'));
  }
}

async function start(drivers: DeviceDriver[]): Promise<StartedServer> {
  const factories: ServerFactories = {
    createHub: () => new FakeHub(),
    createSdkLayer: () => new FakeSdk(),
    createPlatform: () => ({
      drivers,
      services: { forwardToDevice: async () => ({ host: '127.0.0.1', port: 1, dispose: async () => {} }) },
    }),
    createFlutterVmModule: () => new FakeVm(),
    createDemoDriver: () => new FakeDriver('demo', 'demo:'),
  };
  return startServerWith(
    { httpPort: 0, sdkPort: 0, demo: false, dataDir: path.join(dir, 'data'), uiDir: undefined, verbose: false },
    factories,
    { logger: silentLogger, moduleDir: dir, driverStartWaitMs: 300 },
  );
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('onSystemResume', () => {
  it('calls resume() on every driver that has it, skips the others, and never throws', async () => {
    const android = new ResumingDriver('android', 'android:');
    const sim = new ResumingDriver('ios-sim', 'ios-sim:');
    sim.failWith = 'throw';
    const device = new ResumingDriver('ios-device', 'ios:');
    device.failWith = 'reject';
    const plain = new FakeDriver('android', 'other:'); // no resume(): skipped
    running = await start([android, sim, device, plain]);

    expect(() => running!.onSystemResume()).not.toThrow();
    await tick();
    expect([android.resumes, sim.resumes, device.resumes]).toEqual([1, 1, 1]);
  });

  it('folds wake events that arrive within the debounce window; a later wake runs again', async () => {
    const android = new ResumingDriver('android', 'android:');
    running = await start([android]);
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    running.onSystemResume();
    running.onSystemResume();
    await tick();
    now += SYSTEM_RESUME_DEBOUNCE_MS - 1;
    running.onSystemResume();
    await tick();
    expect(android.resumes).toBe(1);

    now += 2;
    running.onSystemResume();
    await tick();
    expect(android.resumes).toBe(2);
  });

  it('does nothing once the server is stopping', async () => {
    const android = new ResumingDriver('android', 'android:');
    running = await start([android]);
    const stopped = running.stop();
    running.onSystemResume();
    await stopped;
    running = undefined;
    expect(android.resumes).toBe(0);
  });
});
