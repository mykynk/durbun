import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceActionId, MockRule } from '@durbun/protocol';
import { createDemoDriver } from '../../src/demo/index';
import { PNG_SIGNATURE } from '../../src/demo/png';
import { createSdkLayer } from '../../src/sdk/index';
import type { DeviceDriver, DriverContext, Hub, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { makeHub, makeSettings, sleep, waitFor } from './helpers';

let hub: Hub | undefined;
let sdk: SdkLayer | undefined;
let demo: DeviceDriver | undefined;
let tempDir: string | undefined;

function setup(mocks: MockRule[] = []): { hub: Hub; sdk: SdkLayer; ctx: DriverContext; demo: DeviceDriver } {
  const settings = makeSettings();
  hub = makeHub();
  const h = hub;
  sdk = createSdkLayer({ hub: h, logger: silentLogger, settings: () => settings, mocks: () => mocks, serverVersion: '0.1.0' });
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'durbun-demo-test-'));
  const ctx: DriverContext = {
    hub: h,
    getDevices: () => h.getDevices(),
    getApps: () => h.getApps(),
    getDeviceApps: () => h.getDeviceApps(),
    onLogs: (l) => h.onLogs(l),
    sdk,
    settings: () => settings,
    onSettings: () => () => {},
    logger: silentLogger,
    tempDir,
    fileUrl: (name) => `/api/files/${encodeURIComponent(name)}`,
    ports: { http: 9750, sdk: 9751 },
  };
  demo = createDemoDriver();
  return { hub: h, sdk, ctx, demo };
}

afterEach(async () => {
  await demo?.stop();
  await sdk?.close();
  hub?.dispose();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  demo = undefined;
  sdk = undefined;
  hub = undefined;
  tempDir = undefined;
  vi.useRealTimers();
});

describe('demo driver (real time)', () => {
  it('smoke: devices, apps, logs, network and metrics appear within ~2 s; stop is idempotent and silent', async () => {
    const { hub, sdk, ctx, demo } = setup();
    expect(demo.id).toBe('demo');
    expect(demo.status()).toMatchObject({ id: 'demo', available: true, active: false });
    await demo.start(ctx);
    await demo.start(ctx); // idempotent
    expect(demo.status().active).toBe(true);
    expect(demo.owns('demo:1')).toBe(true);
    expect(demo.owns('demo:3')).toBe(true);
    expect(demo.owns('android:R5CT')).toBe(false);
    await sleep(2200);

    const devices = hub.getDevices();
    expect(devices.map((d) => `${d.id} ${d.name} ${d.platform} ${d.kind} ${d.state}`).sort()).toEqual([
      'demo:1 Pixel 8 · Demo android emulator online',
      'demo:2 iPhone 16 Pro · Demo ios simulator online',
      'demo:3 iPhone 13 · Demo ios physical online',
    ]);
    const apps = hub.getApps();
    expect(apps.map((a) => `${a.deviceId} ${a.app.id} ${a.sdk.platform} ${a.transport} ${a.connected}`).sort()).toEqual([
      'demo:1 com.mykynk.mahalle android demo true',
      'demo:1 com.mykynk.pati flutter demo true',
      'demo:2 com.mykynk.pati flutter demo true',
    ]);
    const logs = hub.getLogs();
    expect(logs.length).toBeGreaterThan(40);
    expect(new Set(logs.map((l) => l.source))).toEqual(new Set(['device', 'app', 'system']));
    expect(logs.some((l) => l.source === 'device' && l.appId)).toBe(true); // pid attribution works
    expect(logs.some((l) => l.kind === 'event')).toBe(true);
    expect(hub.getNetwork().length).toBeGreaterThan(5);
    expect(hub.getNetwork().some((n) => n.graphql?.operationName === 'GetPetStories')).toBe(true);
    const image = hub.getNetwork().find((n) => n.responseContentType === 'image/png' && n.state === 'complete');
    expect(image).toBeDefined();
    const body = hub.getNetworkDetail(image!.id)!.responseBody!;
    expect(body.encoding).toBe('base64');
    expect(Buffer.from(body.data, 'base64').subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(hub.getMetrics().some((m) => m.source === 'demo' && m.fps !== undefined)).toBe(true);
    expect(hub.getProcesses().some((p) => p.name === 'system_server')).toBe(true);

    await demo.stop();
    await demo.stop(); // idempotent
    expect(demo.status().active).toBe(false);
    expect(hub.getDevices().every((d) => d.state === 'disconnected')).toBe(true);
    expect(hub.getApps().every((a) => !a.connected)).toBe(true);
    expect(sdk.connectionCount()).toBe(0);
    const count = hub.getLogCount();
    await sleep(700);
    expect(hub.getLogCount()).toBe(count); // no timers left behind

    // can be started again (UI toggles demo mode at runtime)
    await demo.start(ctx);
    await waitFor(() => hub.getApps().filter((a) => a.connected).length === 3, 3000);
    expect(hub.getDevices().every((d) => d.state === 'online')).toBe(true);
  });

  it('runs device actions: screenshot PNG file, list-apps, app lifecycle, validation, unsupported', async () => {
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    await waitFor(() => hub.getApps().filter((a) => a.connected).length === 3, 3000);

    const shot = await demo.runAction('demo:2', 'screenshot', {});
    expect(shot.ok).toBe(true);
    const data = shot.data as { url: string; file: string; width: number; height: number };
    expect(data.url).toMatch(/^\/api\/files\/screenshot-iphone-16-pro-demo-.*\.png$/);
    expect(path.dirname(data.file)).toBe(tempDir);
    const png = readFileSync(data.file);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(png.readUInt32BE(16)).toBe(data.width);
    expect(png.readUInt32BE(20)).toBe(data.height);

    const list = await demo.runAction('demo:1', 'list-apps', { includeSystem: true });
    expect((list.data as { id: string }[]).map((a) => a.id)).toEqual(expect.arrayContaining(['com.mykynk.pati', 'com.mykynk.mahalle', 'com.android.settings']));

    const pati = () => hub.getApps().filter((a) => a.deviceId === 'demo:1' && a.app.id === 'com.mykynk.pati');
    expect(await demo.runAction('demo:1', 'app-stop', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: true });
    expect(pati().every((a) => !a.connected)).toBe(true);
    expect(hub.getLogs().some((l) => l.code === 'process.died' && l.params?.process === 'com.mykynk.pati')).toBe(true);
    expect(await demo.runAction('demo:1', 'app-launch', { appId: 'com.mykynk.pati' })).toMatchObject({ ok: true });
    await waitFor(() => pati().some((a) => a.connected), 3000);
    expect(pati()).toHaveLength(2); // a new launch = a new session

    const results: Record<string, boolean> = {};
    const tries: [string, DeviceActionId, Record<string, unknown>][] = [
      ['demo:1', 'open-url', { url: 'pati://pets/42' }],
      ['demo:1', 'appearance', { mode: 'dark' }],
      ['demo:1', 'font-scale', { scale: 1.3 }],
      ['demo:1', 'animations', { enabled: false }],
      ['demo:1', 'input-text', { text: 'golden' }],
      ['demo:1', 'key-event', { key: 'back' }],
      ['demo:1', 'location', { lat: 41.0082, lon: 28.9784 }],
      ['demo:1', 'logs-clear-buffer', {}],
      ['demo:1', 'logs-restart', {}],
      ['demo:1', 'app-install', { file: '/tmp/uploads/pati-debug.apk' }],
      ['demo:2', 'push-notification', { appId: 'com.mykynk.pati', payload: { aps: { alert: { title: 'Yeni mesaj', body: 'Ece: Merhaba!' } } } }],
      ['demo:2', 'status-bar', { mode: 'clean' }],
      ['demo:2', 'app-restart', { appId: 'com.mykynk.pati' }],
    ];
    for (const [dev, action, params] of tries) results[`${dev} ${action}`] = (await demo.runAction(dev, action, params)).ok;
    expect(Object.entries(results).filter(([, ok]) => !ok)).toEqual([]);
    expect(hub.getLogs().some((l) => l.tag === 'router' && l.message.includes('pati://pets/42'))).toBe(true);

    // invalid params and unsupported actions are reported, never thrown
    expect(await demo.runAction('demo:1', 'open-url', {})).toMatchObject({ ok: false, code: 'params.invalid' });
    expect(await demo.runAction('demo:1', 'appearance', { mode: 'purple' })).toMatchObject({ ok: false });
    expect(await demo.runAction('demo:1', 'push-notification', { appId: 'x', payload: {} })).toMatchObject({ ok: false, code: 'demo.unsupportedAction' });
    expect(await demo.runAction('demo:2', 'key-event', { key: 'back' })).toMatchObject({ ok: false });
    expect(await demo.runAction('demo:1', 'screen-record', { durationSec: 5 })).toMatchObject({ ok: false });
    expect(await demo.runAction('demo:1', 'app-launch', { appId: 'com.not.installed' })).toMatchObject({ ok: false, code: 'app.notInstalled' });
    expect(await demo.runAction('demo:9', 'screenshot', {})).toMatchObject({ ok: false });

    // device-level metrics polling
    demo.watchMetrics?.('demo:1', { processName: 'system_server' }, true);
    await waitFor(() => hub.getMetrics().some((m) => m.pid === 1043 && m.appId === undefined), 4000);
    demo.watchMetrics?.('demo:1', { processName: 'system_server' }, false);

    await demo.stop();
    expect(await demo.runAction('demo:1', 'screenshot', {})).toMatchObject({ ok: false, code: 'demo.inactive' });
  });

  it('answers flutter.* commands and keeps toggle state', async () => {
    const { hub, sdk, ctx, demo } = setup();
    await demo.start(ctx);
    const app = await waitFor(() => hub.getApps().find((a) => a.connected && a.deviceId === 'demo:1' && a.app.id === 'com.mykynk.pati'), 3000);
    expect(app.actions.map((a) => a.id)).toEqual(expect.arrayContaining(['flutter.debugPaint', 'flutter.brightness', 'flutter.dumpWidgetTree']));
    await expect(sdk.sendCommand(app.id, 'flutter.debugPaint', { value: true })).resolves.toEqual({ ok: true, data: { value: true } });
    await waitFor(() => hub.getApp(app.id)?.actions.find((a) => a.id === 'flutter.debugPaint')?.value === true);
    await expect(sdk.sendCommand(app.id, 'flutter.brightness', { value: 'dark' })).resolves.toMatchObject({ ok: true });
    await expect(sdk.sendCommand(app.id, 'flutter.brightness', { value: 'sepia' })).resolves.toMatchObject({ ok: false });
    await expect(sdk.sendCommand(app.id, 'flutter.dumpWidgetTree')).resolves.toMatchObject({ ok: true });
    expect(hub.getLogs().some((l) => l.message.startsWith('[root](renderObject: RenderView'))).toBe(true);
    await expect(sdk.sendCommand(app.id, 'flutter.nope')).resolves.toMatchObject({ ok: false, error: 'Unknown command: flutter.nope' });
  });
});

describe('demo driver (fast-forwarded virtual time)', () => {
  it('honors mock rules (respond / fail) exactly like an SDK', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const rules: MockRule[] = [
      { id: 'm-me', enabled: true, method: 'GET', url: 'https://api.pati.app/v1/me', match: 'exact', apps: ['com.mykynk.pati'], action: { type: 'respond', status: 503, body: '{"error":"bakım"}', delayMs: 40 }, createdAt: 1 },
      { id: 'm-cdn', enabled: true, method: '*', url: 'https://cdn.pati.app/*', match: 'glob', action: { type: 'fail', error: 'dns' }, createdAt: 2 },
      { id: 'm-off', enabled: false, method: '*', url: 'mahalle', match: 'contains', action: { type: 'respond', status: 418 }, createdAt: 3 },
    ];
    const { hub, ctx, demo } = setup(rules);
    await demo.start(ctx);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1000);
    const net = hub.getNetwork();
    const me = net.filter((n) => n.url === 'https://api.pati.app/v1/me');
    expect(me.length).toBeGreaterThan(0);
    expect(me.every((n) => n.mocked && n.mockRuleId === 'm-me' && n.status === 503)).toBe(true);
    expect(hub.getNetworkDetail(me[0]!.id)!.responseBody!.data).toBe('{"error":"bakım"}');
    expect(net.filter((n) => n.url.includes('/v1/pets?page=1')).every((n) => !n.mocked && n.status === 200)).toBe(true);
    const cdn = net.filter((n) => n.host === 'cdn.pati.app');
    expect(cdn.length).toBeGreaterThan(0);
    expect(cdn.every((n) => n.state === 'failed' && n.mocked && n.error?.includes('Failed host lookup'))).toBe(true);
    expect(net.some((n) => n.host.includes('mahalle') && n.mocked)).toBe(false);
    await demo.stop();
  });

  it('over ~4 virtual minutes shows crashes, ANRs, Flutter errors, reconnects and restarts', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    const { hub, ctx, demo } = setup();
    await demo.start(ctx);
    for (let i = 0; i < 240; i++) await vi.advanceTimersByTimeAsync(1000);
    const logs = hub.getLogs();
    const rate = logs.length / 240;
    expect(rate).toBeGreaterThan(20);
    expect(rate).toBeLessThan(70);

    // Android native crash (AndroidRuntime, grouped) + SDK crash report, then a restart
    expect(logs.some((l) => l.source === 'device' && l.kind === 'crash' && l.tag === 'AndroidRuntime' && l.level === 'fatal')).toBe(true);
    expect(logs.some((l) => l.source === 'app' && l.kind === 'crash' && l.error?.stack?.includes('BasketFragment'))).toBe(true);
    expect(hub.getApps().filter((a) => a.app.id === 'com.mykynk.mahalle').length).toBeGreaterThanOrEqual(2);
    // ANR
    expect(logs.some((l) => l.kind === 'anr' && l.level === 'error' && l.message.startsWith('ANR in com.mykynk.mahalle'))).toBe(true);
    // Flutter error boxes from the SDK and from stdout (device log)
    expect(logs.some((l) => l.kind === 'flutter-error' && l.source === 'app' && l.message.includes('EXCEPTION CAUGHT BY'))).toBe(true);
    expect(logs.some((l) => l.kind === 'flutter-error' && l.source === 'device')).toBe(true);
    // Dart unhandled exception reported as crash, app keeps running
    expect(logs.some((l) => l.kind === 'crash' && l.error?.type === '_TypeError')).toBe(true);
    // iOS native crash → process death → relaunch with a new session
    expect(logs.some((l) => l.kind === 'crash' && l.deviceId === 'demo:2' && l.message.includes('NSInvalidArgumentException'))).toBe(true);
    expect(hub.getApps().filter((a) => a.deviceId === 'demo:2').length).toBeGreaterThanOrEqual(2);
    // transport blip: same session reconnects; the request in flight is upgraded by its late response
    expect(logs.some((l) => l.code === 'app.reconnected')).toBe(true);
    const blip = hub.getNetwork().find((n) => n.url.endsWith('/feed?cursor=eyJvZmZzZXQiOjQwfQ'));
    expect(blip?.state).toBe('complete');
    // lifecycle lines for app processes
    expect(logs.some((l) => l.code === 'process.died')).toBe(true);
    expect(logs.some((l) => l.code === 'process.started')).toBe(true);
    // a believable spread of HTTP outcomes
    const statuses = new Set(hub.getNetwork().map((n) => n.status));
    for (const s of [200, 201, 204, 401, 404, 422, 429, 500]) expect(statuses.has(s)).toBe(true);
    const states = new Set(hub.getNetwork().map((n) => n.state));
    expect(states.has('failed')).toBe(true);
    expect(hub.getNetwork().some((n) => (n.duration ?? 0) > 2000)).toBe(true);
    expect(hub.getNetwork().some((n) => n.method === 'POST' && n.requestBodySize && n.requestBodySize > 1_000_000)).toBe(true); // multipart upload
    expect(hub.getNetwork().some((n) => n.graphql?.operationType === 'mutation')).toBe(true);
    // every log level shows up
    expect(new Set(logs.map((l) => l.level))).toEqual(new Set(['verbose', 'debug', 'info', 'warn', 'error', 'fatal']));
    await demo.stop();
  });
});
