/**
 * Demo driver (SPEC §5.7): two virtual devices ("Pixel 8 · Demo", "iPhone 16 Pro · Demo") producing
 * realistic device logs, plus apps with the Dürbün SDK (through virtual SDK sessions) producing app
 * logs, events, network traffic and metrics. start()/stop() are idempotent; everything runs on one
 * scheduler timer so stopping leaves nothing behind.
 */
import type { DeviceActionId, DeviceActionResult, DriverStatus, ToolCheck } from '@durbun/protocol';
import type { DeviceDriver, DriverContext } from '../types';
import { type DemoRuntime, type DeviceUiState, runDemoAction } from './actions';
import { type DemoApp, restamp } from './appSim';
import { ANDROID_PROCESS_LIST, ANDROID_SYSTEM, IOS_PROCESS_LIST, IPHONE_ID, iphoneDevice, PIXEL_ID, pixelDevice } from './devices';
import { MahalleApp } from './mahalle';
import { AndroidNoise, IosNoise } from './noise';
import { PatiApp } from './pati';
import { Rng, round, Walk } from './rng';
import { Scheduler } from './scheduler';

/** Fixed seed: the same demo story every run (timing still varies a little). */
export const DEMO_SEED = 20_261_102;
const TICK_MS = 50;

interface Running {
  ctx: DriverContext;
  sched: Scheduler;
  rng: Rng;
  runtime: DemoRuntime;
  patiAndroid: PatiApp;
  patiIos: PatiApp;
  mahalle: MahalleApp;
  watchers: Map<string, () => void>;
}

export function createDemoDriver(): DeviceDriver {
  let running: Running | undefined;

  const allApps = (r: Running): DemoApp[] => [r.patiAndroid, r.mahalle, r.patiIos];

  function start(ctx: DriverContext): void {
    const sched = new Scheduler(TICK_MS, (err) => ctx.logger.warn('demo task failed', err));
    sched.start();
    try {
      populate(ctx, sched);
    } catch (err) {
      sched.stop();
      throw err;
    }
  }

  function populate(ctx: DriverContext, sched: Scheduler): void {
    const logger = ctx.logger;
    const rng = new Rng(DEMO_SEED);
    const now = Date.now();

    ctx.hub.upsertDevice(pixelDevice(now));
    ctx.hub.upsertDevice(iphoneDevice(now));
    for (const p of ANDROID_PROCESS_LIST) ctx.hub.setProcess({ deviceId: PIXEL_ID, pid: p.pid, name: p.name, event: 'seen', ts: now });
    for (const p of IOS_PROCESS_LIST) ctx.hub.setProcess({ deviceId: IPHONE_ID, pid: p.pid, name: p.name, event: 'seen', ts: now });
    for (const id of [PIXEL_ID, IPHONE_ID]) {
      ctx.hub.pushSystemLog(id, { message: 'Log stream started (demo)', code: 'logs.streamStarted', params: { via: 'demo' } });
    }

    const deps = (deviceId: string, platform: 'android' | 'ios', salt: number) => ({ ctx, sched, rng: rng.fork(salt), deviceId, platform, logger });
    const patiAndroid = new PatiApp(deps(PIXEL_ID, 'android', 1));
    const mahalle = new MahalleApp(deps(PIXEL_ID, 'android', 2));
    const patiIos = new PatiApp(deps(IPHONE_ID, 'ios', 3));
    const deviceState = new Map<string, DeviceUiState>([
      [PIXEL_ID, { appearance: 'light', fontScale: 1, animations: true, statusBar: 'reset', shots: 0 }],
      [IPHONE_ID, { appearance: 'light', fontScale: 1, animations: true, statusBar: 'reset', shots: 0 }],
    ]);
    const r: Running = {
      ctx,
      sched,
      rng,
      runtime: { ctx, rng: rng.fork(4), sched, apps: [patiAndroid, mahalle, patiIos], deviceState },
      patiAndroid,
      patiIos,
      mahalle,
      watchers: new Map(),
    };
    running = r;

    // System noise: ~10 lines/s on the Pixel, ~7 lines/s on the iPhone (Poisson arrivals).
    const fgAndroid = () => {
      const app = patiAndroid.running ? patiAndroid : mahalle.running ? mahalle : undefined;
      return app?.pid ? { pid: app.pid, bundleId: app.identity.bundleId, activity: '.MainActivity' } : undefined;
    };
    let batteryLevel = 87;
    const androidNoise = new AndroidNoise(rng.fork(10), fgAndroid, () => batteryLevel);
    const iosNoise = new IosNoise(rng.fork(11), () => (patiIos.running && patiIos.pid ? { pid: patiIos.pid, bundleId: 'com.mykynk.pati', activity: '' } : undefined), rng.fork(12).uuid(true));
    const noiseRng = rng.fork(13);
    sched.repeat(() => noiseRng.exp(100), () => ctx.hub.pushDeviceLogs(PIXEL_ID, restamp(androidNoise.next(), sched.now())));
    sched.repeat(() => noiseRng.exp(145), () => ctx.hub.pushDeviceLogs(IPHONE_ID, restamp(iosNoise.next(), sched.now())));

    // Occasional bursts (a busy moment on the device): 15–45 lines within ~300 ms.
    sched.repeat(
      () => noiseRng.int(20_000, 45_000),
      () => {
        const n = noiseRng.int(15, 45);
        for (let i = 0; i < n; i++) sched.after(noiseRng.int(0, 300), () => ctx.hub.pushDeviceLogs(PIXEL_ID, restamp(androidNoise.next(), sched.now())));
      },
    );

    // Battery drift on the Pixel (the simulator has no battery).
    const battery = new Walk(87, 86, 0.05, 0.6, 15, 100);
    sched.repeat(
      () => 45_000,
      () => {
        batteryLevel = Math.round(battery.step(noiseRng));
        ctx.hub.patchDevice(PIXEL_ID, { battery: { level: batteryLevel, charging: true }, lastSeen: Date.now() });
      },
    );

    // Apps start right away so the first seconds already show a full picture.
    sched.after(120, () => patiAndroid.launch('boot'));
    sched.after(450, () => patiIos.launch('boot'));
    sched.after(1000, () => mahalle.launch('boot'));
    logger.info('demo mode started: 2 virtual devices, 3 app sessions');
  }

  function stop(r: Running): void {
    for (const cancel of r.watchers.values()) cancel();
    r.watchers.clear();
    for (const app of allApps(r)) app.stop('demo-stop');
    r.sched.stop();
    for (const id of [PIXEL_ID, IPHONE_ID]) {
      r.ctx.hub.pushSystemLog(id, { message: 'Log stream stopped (demo)', code: 'logs.streamStopped', params: { via: 'demo' } });
      r.ctx.hub.markDeviceDisconnected(id, 'Demo mode turned off', 'demo.stopped');
    }
    r.ctx.logger.info('demo mode stopped');
  }

  return {
    id: 'demo',

    async start(ctx: DriverContext): Promise<void> {
      if (running) return;
      try {
        start(ctx);
      } catch (err) {
        ctx.logger.error('demo mode failed to start', err);
        if (running) stop(running);
        running = undefined;
      }
    },

    async stop(): Promise<void> {
      const r = running;
      if (!r) return;
      running = undefined;
      try {
        stop(r);
      } catch (err) {
        r.ctx.logger.warn('demo mode did not stop cleanly', err);
        r.sched.stop();
      }
    },

    status(): DriverStatus {
      return running
        ? { id: 'demo', available: true, active: true, detail: 'Generating demo data for 2 virtual devices', code: 'demo.active' }
        : { id: 'demo', available: true, active: false, detail: 'Demo mode is off', code: 'demo.inactive' };
    },

    async checks(): Promise<ToolCheck[]> {
      return [];
    },

    owns(deviceId: string): boolean {
      return deviceId === PIXEL_ID || deviceId === IPHONE_ID;
    },

    async runAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
      const r = running;
      if (!r) return { ok: false, error: 'Demo mode is off', message: 'Demo mode is off', code: 'demo.inactive' };
      try {
        return await runDemoAction(r.runtime, deviceId, action, params ?? {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message, message, code: 'demo.actionFailed' };
      }
    },

    watchMetrics(deviceId: string, target: { pid?: number; processName?: string }, enabled: boolean): void {
      const r = running;
      if (!r || !(deviceId === PIXEL_ID || deviceId === IPHONE_ID)) return;
      const app = allApps(r).find((a) => a.deviceId === deviceId && (a.pid === target.pid || (target.processName && a.identity.processName === target.processName)));
      const pid = target.pid ?? app?.pid ?? Object.values(ANDROID_SYSTEM).find((p) => p.name === target.processName)?.pid;
      if (pid === undefined) return;
      const key = `${deviceId}:${pid}`;
      r.watchers.get(key)?.();
      r.watchers.delete(key);
      if (!enabled) return;
      const rng = r.rng.fork(pid);
      const cpu = new Walk(app ? 18 : 4, app ? 15 : 3, 0.2, app ? 3 : 1, 0.1, 180);
      const mem = new Walk(app ? 230 : 90, app ? 240 : 92, 0.05, 1.5, 20, 600);
      const cancel = r.sched.repeat(
        () => 2000,
        () =>
          r.ctx.hub.pushMetrics([
            { ts: Date.now(), deviceId, pid, source: 'demo', cpu: round(cpu.step(rng)), memoryMB: round(mem.step(rng)), threads: rng.int(app ? 30 : 8, app ? 40 : 20) },
          ]),
      );
      r.watchers.set(key, cancel);
    },
  };
}
