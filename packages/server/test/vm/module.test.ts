import net from 'node:net';
import type { AppSession, DeviceInfo, LogEntry, SdkLog, SdkMetric } from '@durbun/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFlutterVmModule } from '../../src/platform/flutterVm';
import type { FlutterVmModule } from '../../src/types';
import { FakeVm } from './fakeVm';
import { createFakeContext, waitFor, type FakeContext } from './helpers';

const ANDROID = 'android:emulator-5554';
let vm: FakeVm;
let ctx: FakeContext;
let mod: FlutterVmModule;

function androidDevice(): DeviceInfo {
  return {
    id: ANDROID,
    platform: 'android',
    kind: 'emulator',
    name: 'Pixel 8',
    connection: 'usb',
    state: 'online',
    logs: { status: 'streaming' },
    actions: [],
    firstSeen: 0,
    lastSeen: 0,
  };
}

function logEntry(over: Partial<LogEntry>): LogEntry {
  return { id: 1, ts: Date.now(), deviceId: ANDROID, source: 'device', level: 'info', tag: 'flutter', message: '', ...over };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

beforeEach(async () => {
  vm = new FakeVm();
  vm.addIsolate();
  await vm.start();
  ctx = createFakeContext({ deviceLogsAvailable: true });
  ctx.devices.push(androidDevice());
  mod = createFlutterVmModule({ autoAttachDelayMs: 0, reconnectDelaysMs: [50, 100] });
  await mod.start(ctx);
});

afterEach(async () => {
  await mod.stop();
  await vm.stop();
});

describe('Flutter VM module with a scripted VM', () => {
  it('attaches to a Flutter debug app: identity, device, actions with current values, profiling, refresh rate', async () => {
    vm.flags.set('ext.flutter.debugPaint', true);
    const { appId } = await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    expect(v.meta).toMatchObject({ transport: 'vm-service', deviceId: ANDROID });
    const hello = v.ofType('hello')[0]!;
    expect(hello.app).toMatchObject({ name: 'pati', id: 'pati', pid: 4321, debug: true });
    expect(hello.device).toEqual({ platform: 'android' });
    expect(hello.session).toBe(`vm:4321:${vm.startTime}`);
    const actions = await waitFor(() => v.ofType('actions').at(-1)?.actions, 3000, 'actions');
    const value = (id: string) => actions.find((a) => a.id === id)?.value;
    expect(value('flutter.debugPaint')).toBe(true);
    expect(value('flutter.slowAnimations')).toBe(false);
    expect(value('flutter.brightness')).toBe('system');
    expect(value('flutter.platform')).toBe('default');
    expect(actions.some((a) => a.id === 'flutter.invertOversizedImages')).toBe(false); // not registered
    const iso = [...vm.isolates.keys()][0]!;
    expect(vm.httpLogging.get(iso)).toBe(true);
    expect(vm.callsOf('_flutter.getDisplayRefreshRate')).toEqual([{ viewId: '_flutterView/0x1' }]);
    // Device logs stream on this device → stdout comes from logcat, not from the VM.
    expect(vm.callsOf('streamListen').map((p) => p.streamId)).not.toContain('Stdout');
    expect(ctx.systemLogs.find((s) => s.input.code === 'vm.attached')).toMatchObject({ deviceId: ANDROID, input: { appId } });
    expect(mod.status()).toMatchObject({ id: 'flutter-vm', available: true, active: true, detail: '1 app attached through the Dart VM service' });
    expect((await mod.checks())[0]).toMatchObject({ id: 'flutter-vm', status: 'ok' });
    expect(ctx.notices).toHaveLength(0); // manual attach: the command reply informs the UI
  });

  it('reports heap, RSS and frame metrics', async () => {
    await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    await waitFor(() => v.ofType('actions').length > 0, 3000, 'activation');
    const iso = [...vm.isolates.values()][0]!;
    for (let i = 0; i < 30; i++) {
      vm.emit('Extension', {
        kind: 'Extension',
        extensionKind: 'Flutter.Frame',
        isolate: vm.isolateRef(iso),
        extensionData: { number: i, startTime: 5_000_000 + i * 16667, elapsed: 9000, build: i % 10 === 0 ? 20000 : 4000, raster: 3000, vsyncOverhead: 500 },
      });
    }
    const m = await waitFor(() => (v.ofType('metric') as SdkMetric[]).find((x) => (x.fps ?? 0) > 0), 3000, 'metric with fps');
    expect(m.heapMB).toBe(52);
    expect(m.memoryMB).toBe(200);
    expect(m.jankyFrames).toBe(3);
  });

  it('detects hot restart and hot reload, re-enables profiling and re-advertises actions', async () => {
    await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    await waitFor(() => v.ofType('actions').length > 0, 3000, 'first actions');
    const before = v.ofType('actions').length;
    const fresh = vm.hotRestart();
    await waitFor(() => ctx.systemLogs.find((s) => s.input.code === 'vm.hotRestart'), 3000, 'hot restart line');
    expect(ctx.systemLogs.find((s) => s.input.code === 'vm.hotRestart')!.input.kind).toBe('lifecycle');
    await waitFor(() => vm.httpLogging.get(fresh.id), 3000, 'profiling in the new isolate');
    await waitFor(() => v.ofType('actions').length > before, 3000, 'actions after restart');
    vm.emit('Isolate', { kind: 'IsolateReload', isolate: vm.isolateRef(fresh) });
    await waitFor(() => ctx.systemLogs.find((s) => s.input.code === 'vm.hotReload'), 3000, 'hot reload line');
    expect(v.ofType('hello')).toHaveLength(1);
  });

  it('follows state changes made by other tools (DevTools) and runs commands', async () => {
    await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    await waitFor(() => v.ofType('actions').length > 0, 3000, 'actions');
    const iso = [...vm.isolates.values()][0]!;
    vm.emit('Extension', {
      kind: 'Extension',
      extensionKind: 'Flutter.ServiceExtensionStateChanged',
      isolate: vm.isolateRef(iso),
      extensionData: { extension: 'ext.flutter.repaintRainbow', value: 'true' },
    });
    await waitFor(() => v.ofType('actions').at(-1)!.actions.find((a) => a.id === 'flutter.repaintRainbow')?.value === true, 3000, 'rainbow on');

    expect(await v.command('flutter.platform', { value: 'ios' })).toMatchObject({ ok: true, data: { value: 'iOS' } });
    expect(vm.platformOverride).toBe('iOS');
    expect(await v.command('flutter.brightness', { value: 'dark' })).toMatchObject({ ok: true, data: { value: 'dark' } });
    expect(vm.callsOf('ext.flutter.brightnessOverride').at(-1)).toMatchObject({ value: 'Brightness.dark' });
    expect(await v.command('flutter.slowAnimations', { value: true })).toMatchObject({ ok: true, data: { value: true } });
    expect(vm.timeDilation).toBe(5);
    const dump = await v.command('flutter.dumpRenderTree');
    expect(dump).toMatchObject({ ok: true, data: { lines: 2 } });
    await waitFor(() => (v.ofType('log') as SdkLog[]).find((l) => l.message.startsWith('Render tree (2 lines)\nRenderView#1')), 3000, 'dump log');
    expect(await v.command('flutter.invertOversizedImages')).toMatchObject({ ok: false, error: expect.stringContaining('not available') });

    iso.paused = true;
    vm.emit('Debug', { kind: 'PauseBreakpoint', isolate: vm.isolateRef(iso) });
    await new Promise((r) => setTimeout(r, 50));
    expect(await v.command('flutter.debugPaint', { value: true })).toMatchObject({ ok: false, error: 'The app is paused in the debugger' });
  });

  it('leaves network and stdout to an SDK session of the same process', async () => {
    ctx.config.deviceLogsAvailable = false;
    ctx.apps.push({
      id: 'app:sdk',
      sessionKey: 'k',
      deviceId: ANDROID,
      sdk: { name: 'durbun-flutter', version: '0.1.0', platform: 'flutter' },
      app: { id: 'com.mykynk.pati', name: 'Pati', pid: 4321 },
      transport: 'adb-reverse',
      connected: true,
      connectedAt: 0,
      capabilities: ['logs', 'network', 'metrics'],
      actions: [],
      stats: { logs: 0, requests: 0, errors: 0 },
    } as AppSession);
    await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    expect(v.ofType('hello')[0]!.app).toMatchObject({ id: 'com.mykynk.pati', name: 'Pati' });
    await waitFor(() => v.ofType('actions').length > 0, 3000, 'activation');
    expect(vm.callsOf('ext.dart.io.httpEnableTimelineLogging')).toEqual([]);
    expect(vm.callsOf('streamListen').map((p) => p.streamId)).not.toContain('Stdout');
  });

  it('subscribes to stdout only while the device has no log stream', async () => {
    ctx.config.deviceLogsAvailable = false;
    await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    await waitFor(() => vm.callsOf('streamListen').some((p) => p.streamId === 'Stdout'), 3000, 'stdout subscription');
    const iso = [...vm.isolates.values()][0]!;
    vm.emit('Stdout', { kind: 'WriteEvent', isolate: vm.isolateRef(iso), bytes: Buffer.from('flutter: Merhaba\n').toString('base64') });
    await waitFor(() => (v.ofType('log') as SdkLog[]).find((l) => l.message === 'Merhaba' && l.tag === 'flutter'), 3000, 'stdout line');
    v.deliver({ type: 'config', config: { ...ctx.config, deviceLogsAvailable: true } });
    await waitFor(() => vm.callsOf('streamCancel').some((p) => p.streamId === 'Stdout'), 3000, 'stdout cancelled');
  });

  it('reconnects after a dropped connection and ends when the VM is gone', async () => {
    await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    await waitFor(() => v.ofType('actions').length > 0, 3000, 'activation');
    vm.dropClients();
    await waitFor(() => ctx.logLines.some((l) => l.startsWith('info reconnected to pati')), 3000, 'reconnect');
    expect(v.closed).toBe(false);
    await vm.stop();
    await waitFor(() => v.closed, 5000, 'session end');
    expect(ctx.systemLogs.find((s) => s.input.code === 'vm.detached')!.input.message).toContain('the app stopped');
    expect(ctx.notices.find((n) => n.code === 'vm.detached')).toBeTruthy();
    expect(mod.status().detail).toMatch(/Waiting/);
  });

  it('ends the VM session when the server closes the app session', async () => {
    await mod.attach(vm.url);
    const v = ctx.virtuals[0]!;
    await waitFor(() => v.ofType('actions').length > 0, 3000, 'activation');
    v.close('server shutting down');
    await waitFor(() => mod.status().detail?.startsWith('Waiting'), 3000, 'session end');
  });

  it('marks profile builds (no debug-only extensions) and offers only their actions', async () => {
    const profileVm = new FakeVm();
    profileVm.addIsolate({
      extensions: ['ext.dart.io.httpEnableTimelineLogging', 'ext.dart.io.getHttpProfile', 'ext.flutter.showPerformanceOverlay', 'ext.flutter.debugDumpApp'],
    });
    await profileVm.start();
    try {
      await mod.attach(profileVm.url);
      const v = ctx.virtuals[0]!;
      expect(v.ofType('hello')[0]!.app.debug).toBe(false);
      const actions = await waitFor(() => v.ofType('actions').at(-1)?.actions, 3000, 'actions');
      expect(actions.map((a) => a.id)).toEqual(['flutter.performanceOverlay', 'flutter.dumpWidgetTree']);
    } finally {
      await mod.stop();
      await profileVm.stop();
    }
  });

  it('never attaches twice to the same VM process', async () => {
    const { appId } = await mod.attach(vm.url);
    // Same VM reached through a port forward announced in the device log.
    ctx.emitLogs([logEntry({ pid: 4321, process: 'com.mykynk.pati', message: `The Dart VM service is listening on ${vm.url}` })]);
    await waitFor(() => ctx.forwards.length === 1 && ctx.forwards[0]!.disposed, 5000, 'duplicate attempt cleaned up');
    expect(ctx.virtuals).toHaveLength(1);
    expect((await mod.attach(`ws://127.0.0.1:${vm.port}/fakeTok12=/ws`)).appId).toBe(appId);
    expect(ctx.virtuals).toHaveLength(1);
  });

  it('forwards the port when a device-side URL is pasted for a device', async () => {
    const devicePort = await freePort();
    ctx.forwardPortMap.set(devicePort, vm.port);
    const { appId } = await mod.attach(`The Dart VM service is listening on http://127.0.0.1:${devicePort}/fakeTok12=/`, {
      deviceId: ANDROID,
    });
    expect(appId).toBe('app:1');
    expect(ctx.forwards).toEqual([{ deviceId: ANDROID, port: devicePort, disposed: false }]);
    await mod.detach(appId);
    expect(ctx.forwards[0]!.disposed).toBe(true);
  });

  it('validates input and detach targets', async () => {
    await expect(mod.attach('no url in here')).rejects.toThrow(/No Dart VM service URL found/);
    await expect(mod.detach('app:404')).rejects.toThrow(/No Dart VM service session/);
    const port = await freePort();
    await expect(mod.attach(`http://127.0.0.1:${port}/abcd123=/`)).rejects.toThrow();
    expect(ctx.virtuals).toHaveLength(0);
    const idle = createFlutterVmModule();
    await expect(idle.attach(vm.url)).rejects.toThrow(/not running/);
  });
});

describe('auto-attach', () => {
  it('forwards the device port, names the app after its process, ignores repeats and replaces restarted apps', async () => {
    ctx.emitLogs([
      logEntry({ pid: 4321, process: 'com.mykynk.pati', message: `The Dart VM service is listening on ${vm.url}` }),
    ]);
    const v = await waitFor(() => ctx.virtuals[0], 5000, 'auto-attach');
    await v.appId;
    const hello = v.ofType('hello')[0]!;
    expect(hello.app).toMatchObject({ id: 'com.mykynk.pati', name: 'pati', processName: 'com.mykynk.pati' });
    expect(v.meta.deviceId).toBe(ANDROID);
    expect(ctx.forwards).toEqual([{ deviceId: ANDROID, port: vm.port, disposed: false }]);
    await waitFor(() => ctx.notices.find((n) => n.code === 'vm.attached' && n.level === 'success'), 3000, 'success notice');

    ctx.emitLogs([logEntry({ pid: 4321, process: 'com.mykynk.pati', message: `The Dart VM service is listening on ${vm.url}` })]);
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.virtuals).toHaveLength(1);

    // The app restarts with a new pid and a new VM service URL.
    const restarted = new FakeVm();
    restarted.pid = 5555;
    restarted.addIsolate();
    await restarted.start();
    try {
      ctx.emitLogs([logEntry({ pid: 5555, process: 'com.mykynk.pati', message: `The Dart VM service is listening on ${restarted.url}` })]);
      await waitFor(() => v.closed, 5000, 'old session replaced');
      const v2 = await waitFor(() => ctx.virtuals[1], 5000, 'new session');
      await v2.appId;
      expect(v2.ofType('hello')[0]!.app.pid).toBe(5555);
      expect(ctx.forwards[0]!.disposed).toBe(true);
      await mod.stop();
      expect(ctx.forwards.every((f) => f.disposed)).toBe(true);
    } finally {
      await restarted.stop();
    }
  });

  it('reports a failed attach once (fresh lines) and stays quiet for stale ones', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/dead1234=/`;
    ctx.emitLogs([logEntry({ deviceId: 'ios-sim:ABC', pid: 77, process: 'Runner', message: `flutter: The Dart VM service is listening on ${url}` })]);
    await waitFor(() => ctx.notices.find((n) => n.code === 'vm.attachFailed'), 8000, 'failure notice');
    expect(ctx.systemLogs.find((s) => s.input.code === 'vm.attachFailed')).toMatchObject({ deviceId: 'ios-sim:ABC', input: { level: 'warn' } });
    expect(ctx.forwards).toHaveLength(0); // simulators share the host network
    ctx.emitLogs([logEntry({ deviceId: 'ios-sim:ABC', pid: 77, process: 'Runner', message: `flutter: The Dart VM service is listening on ${url}` })]);
    const staleUrl = `http://127.0.0.1:${port}/old12345=/`;
    ctx.emitLogs([logEntry({ ts: Date.now() - 10 * 60_000, pid: 66, message: `The Dart VM service is listening on ${staleUrl}` })]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(ctx.notices.filter((n) => n.code === 'vm.attachFailed')).toHaveLength(1);
  });

  it('respects the setting and ignores devices it cannot reach', async () => {
    ctx.settingsValue = { ...ctx.settingsValue, autoAttachVmService: false };
    ctx.emitLogs([logEntry({ pid: 4321, message: `The Dart VM service is listening on ${vm.url}` })]);
    ctx.settingsValue = { ...ctx.settingsValue, autoAttachVmService: true };
    ctx.emitLogs([logEntry({ deviceId: 'demo:1', pid: 4321, message: `The Dart VM service is listening on ${vm.url}` })]);
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.virtuals).toHaveLength(0);
    expect(ctx.forwards).toHaveLength(0);
  });
});
