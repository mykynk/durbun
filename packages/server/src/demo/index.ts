/**
 * Demo driver (SPEC §5.7, §10): three virtual devices ("Pixel 8 · Demo", "iPhone 16 Pro · Demo"
 * simulator, "iPhone 13 · Demo" over USB) producing realistic device logs, apps with the Dürbün SDK
 * (through virtual SDK sessions) producing app logs, events, network traffic and metrics, and apps
 * WITHOUT the SDK (store / Firebase / TestFlight builds) that only show what the OS exposes: device log
 * lines, crash / ANR records and the DeviceApp (version, build type, installer). start()/stop() are
 * idempotent; everything runs on one scheduler timer so stopping leaves nothing behind.
 *
 * Device lines carry the origin the real driver would set (logcat / simctl-log / idevicesyslog, plus
 * dropbox / crash-report records) so every "where does this come from" text in the UI can be seen
 * without a device; the `demo:` device ids and `logs.via: 'demo'` mark the data as demo data.
 */
import type { DeviceActionId, DeviceActionResult, DeviceReaderState, DriverStatus, LogEntry, ToolCheck } from '@durbun/protocol';
import type { DeviceDriver, DriverContext, HubSink } from '../types';
import { type DemoRuntime, type DeviceUiState, runDemoAction } from './actions';
import { restamp, type SimApp } from './appSim';
import { DeviceOnlyApp, type DeviceOnlyDeps, KumbaraAndroid, KumbaraIos, PatiQaAndroid } from './deviceOnly';
import {
  ANDROID_PROCESS_LIST,
  ANDROID_SYSTEM,
  DEMO_DEVICE_IDS,
  DEMO_LOG_ORIGIN,
  IOS_DEVICE_PROCESS_LIST,
  IOS_DEVICE_SYSTEM,
  IOS_PROCESS_LIST,
  IPHONE_DEVICE_ID,
  IPHONE_ID,
  iphoneDevice,
  iphoneUsbDevice,
  PIXEL_ID,
  pixelDevice,
} from './devices';
import { MahalleApp } from './mahalle';
import { AndroidNoise, DEVICE_BUNDLE_ROOT, IosNoise } from './noise';
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
  /** Pati's Xcode build on the USB iPhone: installed, not running until launched from the UI. */
  patiUsb: PatiApp;
  kumbaraAndroid: KumbaraAndroid;
  patiQa: PatiQaAndroid;
  kumbaraIos: KumbaraIos;
  watchers: Map<string, () => void>;
  unsubscribe: (() => void)[];
  /** The Pixel's frame-stats reader as last reported (Android driver rules: on change, else ≤ every 5 min). */
  frameReader?: { state: DeviceReaderState; at: number };
  frameLastOk?: number;
}

const READER_REFRESH_MS = { android: 5 * 60_000, ios: 10 * 60_000 };
const FRAME_NO_DATA_READS = 5;

/** Reports the Pixel's frame-stats reader the way the Android driver does (platform/android/readers.ts). */
function reportFrameReader(r: Running, report: { status: 'ok' } | { status: 'unavailable'; code: string; detail: string }): void {
  const now = Date.now();
  if (report.status === 'ok') r.frameLastOk = now;
  const prev = r.frameReader;
  const code = report.status === 'ok' ? undefined : report.code;
  if (prev && prev.state.status === report.status && prev.state.code === code && now - prev.at < READER_REFRESH_MS.android) return;
  const state: DeviceReaderState = report.status === 'ok' ? { status: 'ok' } : { status: report.status, code: report.code, detail: report.detail };
  if (r.frameLastOk !== undefined) state.lastOk = r.frameLastOk;
  r.frameReader = { state, at: now };
  r.ctx.hub.patchDevice(PIXEL_ID, { readers: { frameStats: state } });
}

const isDemoDevice = (id: string) => (DEMO_DEVICE_IDS as readonly string[]).includes(id);

/** Device lines without an explicit origin get the one the real driver of that device would set. */
function withDemoOrigins(hub: HubSink): HubSink {
  return {
    upsertDevice: (device) => hub.upsertDevice(device),
    patchDevice: (id, patch) => hub.patchDevice(id, patch),
    markDeviceDisconnected: (id, detail, code) => hub.markDeviceDisconnected(id, detail, code),
    pushDeviceLogs: (deviceId, entries) => {
      const origin = DEMO_LOG_ORIGIN[deviceId];
      if (origin) for (const e of entries) e.origin ??= origin;
      hub.pushDeviceLogs(deviceId, entries);
    },
    setProcess: (update) => hub.setProcess(update),
    pushSystemLog: (deviceId, input) => hub.pushSystemLog(deviceId, input),
    pushMetrics: (samples) => hub.pushMetrics(samples),
    notice: (notice) => hub.notice(notice),
    upsertDeviceApp: (input) => hub.upsertDeviceApp(input),
    removeDeviceApps: (deviceId, ids) => hub.removeDeviceApps(deviceId, ids),
  };
}

export function createDemoDriver(): DeviceDriver {
  let running: Running | undefined;

  const allApps = (r: Running): SimApp[] => [r.patiAndroid, r.mahalle, r.patiIos, r.patiUsb, r.kumbaraAndroid, r.patiQa, r.kumbaraIos];

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

  function populate(outer: DriverContext, sched: Scheduler): void {
    const ctx: DriverContext = { ...outer, hub: withDemoOrigins(outer.hub) };
    const logger = ctx.logger;
    const rng = new Rng(DEMO_SEED);
    const now = Date.now();
    const DAY = 86_400_000;

    ctx.hub.upsertDevice(pixelDevice(now));
    ctx.hub.upsertDevice(iphoneDevice(now));
    ctx.hub.upsertDevice(iphoneUsbDevice(now));
    for (const p of ANDROID_PROCESS_LIST) ctx.hub.setProcess({ deviceId: PIXEL_ID, pid: p.pid, name: p.name, event: 'seen', ts: now });
    for (const p of IOS_PROCESS_LIST) ctx.hub.setProcess({ deviceId: IPHONE_ID, pid: p.pid, name: p.name, event: 'seen', ts: now });
    for (const p of IOS_DEVICE_PROCESS_LIST) ctx.hub.setProcess({ deviceId: IPHONE_DEVICE_ID, pid: p.pid, name: p.name, event: 'seen', ts: now });
    for (const id of DEMO_DEVICE_IDS) {
      ctx.hub.pushSystemLog(id, { message: 'Log stream started (demo)', code: 'logs.streamStarted', params: { via: 'demo' } });
    }

    // Live logcat / syslog crash rows by device + pid, for the dropbox copies' `duplicateOf`.
    const liveCrashes = new Map<string, number>();
    const liveKey = (deviceId: string, pid: number, kind: string) => `${deviceId}|${pid}|${kind}`;
    const unsubscribe: (() => void)[] = [];
    try {
      unsubscribe.push(
        outer.onLogs((entries: LogEntry[]) => {
          for (const e of entries) {
            if (e.source !== 'device' || e.pid === undefined || (e.kind !== 'crash' && e.kind !== 'anr')) continue;
            if (e.origin === 'dropbox' || e.origin === 'crash-report' || !isDemoDevice(e.deviceId)) continue;
            liveCrashes.set(liveKey(e.deviceId, e.pid, e.kind), e.id);
            if (liveCrashes.size > 200) liveCrashes.delete(liveCrashes.keys().next().value as string);
          }
        }),
      );
    } catch (err) {
      logger.debug('demo: no log tap (dropbox copies will not be linked to their live rows)', err);
    }

    const deps = (deviceId: string, platform: 'android' | 'ios', salt: number) => ({ ctx, sched, rng: rng.fork(salt), deviceId, platform, logger });
    const onlyDeps = (deviceId: string, platform: 'android' | 'ios', salt: number): DeviceOnlyDeps => ({
      ctx,
      sched,
      rng: rng.fork(salt),
      deviceId,
      platform,
      watchStart: now,
      liveEntryId: (d, pid, kind) => liveCrashes.get(liveKey(d, pid, kind)),
    });
    const patiAndroid = new PatiApp(deps(PIXEL_ID, 'android', 1));
    const mahalle = new MahalleApp(deps(PIXEL_ID, 'android', 2));
    const patiIos = new PatiApp(deps(IPHONE_ID, 'ios', 3));
    const patiUsb = new PatiApp(deps(IPHONE_DEVICE_ID, 'ios', 20), {
      device: { model: 'iPhone14,5', name: 'iPhone 13', osVersion: '17.6.1', manufacturer: 'Apple', isPhysical: true },
      firstPid: 3_120,
    });
    const kumbaraAndroid = new KumbaraAndroid(onlyDeps(PIXEL_ID, 'android', 21));
    const patiQa = new PatiQaAndroid(onlyDeps(PIXEL_ID, 'android', 22));
    const kumbaraIos = new KumbaraIos(onlyDeps(IPHONE_DEVICE_ID, 'ios', 23));
    // How each device reports the SDK builds (SPEC §10.2): Android Studio / flutter run → adb, the
    // simulator → simulator, Xcode on a real iPhone → xcode.
    patiAndroid.deviceApp = { buildType: 'debug', install: { source: 'adb', installer: 'com.android.shell', firstInstall: now - 3 * DAY, lastUpdate: now - 35 * 60_000 } };
    mahalle.deviceApp = { buildType: 'debug', install: { source: 'adb', firstInstall: now - 20 * DAY, lastUpdate: now - 2 * 3_600_000 } };
    patiIos.deviceApp = { buildType: 'debug', install: { source: 'simulator' } };
    patiUsb.deviceApp = { buildType: 'debug', install: { source: 'xcode' } };

    const apps: SimApp[] = [patiAndroid, mahalle, patiIos, patiUsb, kumbaraAndroid, patiQa, kumbaraIos];
    const uiState = (): DeviceUiState => ({ appearance: 'light', fontScale: 1, animations: true, statusBar: 'reset', shots: 0 });
    const deviceState = new Map<string, DeviceUiState>(DEMO_DEVICE_IDS.map((id) => [id, uiState()]));
    const r: Running = {
      ctx,
      sched,
      rng,
      runtime: { ctx, rng: rng.fork(4), sched, apps, deviceState },
      patiAndroid,
      patiIos,
      mahalle,
      patiUsb,
      kumbaraAndroid,
      patiQa,
      kumbaraIos,
      watchers: new Map(),
      unsubscribe,
    };
    running = r;

    // The Xcode build of Pati on the USB iPhone was used a few minutes ago (recently active, not running).
    patiUsb.reportDeviceApp([], false, { lastActivity: now - 9 * 60_000 });

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
    // The USB iPhone is calmer (~2.5 lines/s): one foreground app, no simulator chatter.
    const usbFg = () =>
      patiUsb.running && patiUsb.pid
        ? { pid: patiUsb.pid, bundleId: 'com.mykynk.pati', activity: '' }
        : kumbaraIos.running && kumbaraIos.pid
          ? { pid: kumbaraIos.pid, bundleId: 'com.mykynk.kumbara', activity: '' }
          : undefined;
    // Its own daemons and the on-device bundle folder (not the simulator's pids and Mac paths).
    const usbNoise = new IosNoise(rng.fork(14), usbFg, rng.fork(15).uuid(true), { daemons: IOS_DEVICE_SYSTEM, bundleRoot: DEVICE_BUNDLE_ROOT });
    const usbNoiseRng = rng.fork(16);
    sched.repeat(() => usbNoiseRng.exp(400), () => ctx.hub.pushDeviceLogs(IPHONE_DEVICE_ID, restamp(usbNoise.next(), sched.now())));

    // Occasional bursts (a busy moment on the device): 15–45 lines within ~300 ms.
    sched.repeat(
      () => noiseRng.int(20_000, 45_000),
      () => {
        const n = noiseRng.int(15, 45);
        for (let i = 0; i < n; i++) sched.after(noiseRng.int(0, 300), () => ctx.hub.pushDeviceLogs(PIXEL_ID, restamp(androidNoise.next(), sched.now())));
      },
    );

    // Crash records stay readable on every demo device; lastOk refreshes as often as the drivers send it.
    const crashReadersOk = (ids: readonly string[]) => {
      const t = Date.now();
      for (const id of ids) ctx.hub.patchDevice(id, { readers: { crashReports: { status: 'ok', lastOk: t } } });
    };
    sched.repeat(() => READER_REFRESH_MS.android, () => crashReadersOk([PIXEL_ID]));
    sched.repeat(() => READER_REFRESH_MS.ios, () => crashReadersOk([IPHONE_ID, IPHONE_DEVICE_ID]));

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
    // SDK-less builds: what the device reports on connect (dropbox / crash-report scans), then the apps.
    sched.after(1500, () => kumbaraAndroid.reportEarlierCrash());
    sched.after(1800, () => kumbaraIos.launch('boot'));
    sched.after(2300, () => kumbaraIos.reportEarlierCrash());
    sched.after(3000, () => kumbaraAndroid.launch('boot'));
    sched.after(8000, () => patiQa.launch('user'));
    logger.info('demo mode started: 3 virtual devices, 3 app sessions, 3 builds without the SDK');
  }

  function stop(r: Running): void {
    for (const cancel of r.watchers.values()) cancel();
    r.watchers.clear();
    for (const cancel of r.unsubscribe.splice(0)) {
      try {
        cancel();
      } catch {
        /* ignore */
      }
    }
    for (const app of allApps(r)) app.stop('demo-stop');
    r.sched.stop();
    for (const id of DEMO_DEVICE_IDS) {
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
        ? { id: 'demo', available: true, active: true, detail: 'Generating demo data for 3 virtual devices', code: 'demo.active' }
        : { id: 'demo', available: true, active: false, detail: 'Demo mode is off', code: 'demo.inactive' };
    },

    async checks(): Promise<ToolCheck[]> {
      return [];
    },

    owns(deviceId: string): boolean {
      return isDemoDevice(deviceId);
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
      // A physical iPhone exposes no CPU / memory / FPS from outside (SPEC §10: iosNoDeviceMetrics).
      if (!r || !(deviceId === PIXEL_ID || deviceId === IPHONE_ID)) return;
      // (A target without a pid must not match an app that has not started yet: undefined === undefined.)
      const app = allApps(r).find(
        (a) => a.deviceId === deviceId && ((target.pid !== undefined && a.pid === target.pid) || (!!target.processName && a.identity.processName === target.processName)),
      );
      // SDK-less Android builds also get frame stats (dumpsys gfxinfo / SurfaceFlinger, SPEC §10.4) — except
      // Pati QA: SurfaceFlinger gives no frame times for its SurfaceView, so after a few empty reads the
      // Pixel's frame-stats reader says they cannot be read (and why), as the Android driver does.
      const frameStats = app instanceof DeviceOnlyApp && deviceId === PIXEL_ID;
      const noFrames = frameStats && app === r.patiQa;
      const pid = target.pid ?? app?.pid ?? Object.values(ANDROID_SYSTEM).find((p) => p.name === target.processName)?.pid;
      if (pid === undefined) return;
      const key = `${deviceId}:${pid}`;
      r.watchers.get(key)?.();
      r.watchers.delete(key);
      if (!enabled) return;
      const rng = r.rng.fork(pid);
      const cpu = new Walk(app ? 18 : 4, app ? 15 : 3, 0.2, app ? 3 : 1, 0.1, 180);
      const mem = new Walk(app ? 230 : 90, app ? 240 : 92, 0.05, 1.5, 20, 600);
      const fps = new Walk(57, 58, 0.3, 2.5, 0, 60);
      let reads = 0;
      const cancel = r.sched.repeat(
        () => 2000,
        () => {
          const frames = frameStats && !noFrames;
          r.ctx.hub.pushMetrics([
            {
              ts: Date.now(),
              deviceId,
              pid,
              source: 'demo',
              cpu: round(cpu.step(rng)),
              memoryMB: round(mem.step(rng)),
              threads: rng.int(app ? 30 : 8, app ? 40 : 20),
              ...(frames ? { fps: Math.round(fps.step(rng)), jankyFrames: rng.chance(0.25) ? rng.int(1, 6) : 0 } : {}),
            },
          ]);
          if (frames) reportFrameReader(r, { status: 'ok' });
          else if (noFrames && ++reads >= FRAME_NO_DATA_READS) {
            reportFrameReader(r, {
              status: 'unavailable',
              code: 'reader.frameStats.noData',
              detail: `SurfaceFlinger lists a SurfaceView of ${app.identity.bundleId} but gives no frame times for it; gfxinfo does not see what a SurfaceView draws`,
            });
          }
        },
      );
      r.watchers.set(key, cancel);
    },
  };
}
