/**
 * Real end-to-end test: a Dart program (fixtures/app.dart) run by the Dart SDK from Flutter's cache with
 * the VM service enabled; the module attaches through a pasted output block, and later DDS takes over
 * (the direct connection is dropped by the VM and must be re-established through DDS without duplicates).
 * Kept under ~30 s; every child process is killed in afterAll.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SdkLog, SdkMetric, SdkNetError, SdkNetRequest, SdkNetResponse } from '@durbun/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createFlutterVmModule } from '../../src/platform/flutterVm';
import { connectVmService } from '../../src/platform/flutterVm/rpc';
import { normalizeVmServiceUrl } from '../../src/platform/flutterVm/url';
import { createFakeContext, waitFor } from './helpers';

/** `DURBUN_TEST_DART`, else the first `dart` on PATH; without one the suite is skipped. */
const DART = process.env.DURBUN_TEST_DART ?? findOnPath('dart');
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app.dart');
const hasDart = fs.existsSync(DART);

const children: ChildProcess[] = [];

function findOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return name;
}

function spawnTracked(cmd: string, args: string[]): { child: ChildProcess; output: () => string } {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (out += String(d)));
  return { child, output: () => out };
}

afterAll(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
});

describe.skipIf(!hasDart)('Flutter VM module against a real Dart VM', () => {
  it(
    'captures logs, stdout, network with bodies, metrics and commands, and survives DDS taking over',
    async () => {
      const app = spawnTracked(DART, ['--enable-vm-service=0', '--no-dds', FIXTURE, '--seconds', '25']);
      const rawUrl = await waitFor(() => /listening on (http:\/\/\S+)/.exec(app.output())?.[1], 15_000, 'VM service URL');

      const ctx = createFakeContext();
      const vm = createFlutterVmModule({ autoAttachDelayMs: 0 });
      await vm.start(ctx);
      const pasted = [
        'Running Gradle task \'assembleDebug\'... see https://docs.gradle.org/8.0/userguide/command_line_interface.html',
        app.output(),
        'The Flutter DevTools debugger and profiler is available at: http://127.0.0.1:9101?uri=' + rawUrl,
      ].join('\n');
      const { appId } = await vm.attach(pasted);
      expect(appId).toBe('app:1');
      const v = ctx.virtuals[0]!;
      expect(v.meta.transport).toBe('vm-service');

      // hello
      const hello = v.ofType('hello')[0]!;
      expect(hello.sdk.platform).toBe('dart-vm');
      expect(hello.app.pid).toBe(app.child.pid);
      expect(hello.app.name).toBe('app');
      expect(hello.capabilities).toEqual(expect.arrayContaining(['logs', 'network', 'metrics', 'commands']));
      expect(hello.session).toMatch(new RegExp(`^vm:${app.child.pid}:\\d+$`));
      expect(hello.device.platform).toBe('other');

      const logs = () => v.ofType('log') as SdkLog[];
      const requests = () => v.ofType('net.request') as SdkNetRequest[];
      const responses = () => v.ofType('net.response') as SdkNetResponse[];
      const errors = () => v.ofType('net.error') as SdkNetError[];
      const metrics = () => v.ofType('metric') as SdkMetric[];

      await waitFor(
        () =>
          logs().some((l) => l.tag === 'fixture.error') &&
          logs().some((l) => l.kind === 'flutter-error') &&
          logs().some((l) => l.tag === 'navigation') &&
          errors().length > 0 &&
          responses().some((r) => r.status === 404) &&
          metrics().some((m) => (m.fps ?? 0) > 0),
        12_000,
        'logs, network and metrics',
      );

      // dart:developer logs with mapped levels, logger names as tags, full long messages and errors
      const tick = logs().find((l) => l.tag === 'fixture.tick')!;
      expect(tick.level).toBe('info');
      expect(tick.message).toMatch(/^tick \d+$/);
      expect(logs().find((l) => l.tag === 'fixture.debug')!.level).toBe('debug');
      const long = logs().find((l) => l.tag === 'fixture.long')!;
      expect(long.level).toBe('warn');
      expect(long.message.length).toBeGreaterThan(200);
      expect(long.message).toMatch(/end \d+$/);
      const err = logs().find((l) => l.tag === 'fixture.error')!;
      expect(err.level).toBe('error');
      expect(err.message).toMatch(/^parse failed \d+$/);
      expect(err.error?.type).toBe('FormatException');
      expect(err.error?.message).toMatch(/^FormatException: bad input \d+$/);
      expect(err.error?.stack).toContain('app.dart');
      const plain = logs().find((l) => l.message.startsWith('plain log without level'))!;
      expect(plain.tag).toBe('log');
      expect(plain.level).toBe('info');

      // stdout/stderr (no device logs in this context); "partial " + print() assembled into one line
      const printed = logs().find((l) => l.message.startsWith('partial printed line'))!;
      expect(printed.level).toBe('info');
      expect(printed.tag).toBe('flutter'); // the fixture registers ext.flutter.* → treated as a Flutter app
      expect(logs().find((l) => l.message.startsWith('stderr line'))!.level).toBe('error');

      // Flutter events
      const flutterError = logs().find((l) => l.kind === 'flutter-error')!;
      expect(flutterError.level).toBe('error');
      expect(flutterError.message).toContain('EXCEPTION CAUGHT BY WIDGETS LIBRARY');
      expect(logs().find((l) => l.tag === 'navigation')!.message).toBe('→ /details');

      // network: one request + one terminal message per id, bodies decoded as UTF-8
      const ids = requests().map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      const get = requests().find((r) => r.method === 'GET' && r.url.includes('/api/users?page='))!;
      expect(get.source).toBe('vm-service');
      expect(get.headers).toEqual(expect.arrayContaining([['accept', 'application/json']]));
      const getResp = await waitFor(() => responses().find((r) => r.id === get.id), 5000, 'GET response');
      expect(getResp.status).toBe(200);
      expect(getResp.statusText).toBe('OK');
      expect(getResp.body?.encoding).toBe('utf8');
      expect(JSON.parse(getResp.body!.data).users[0].name).toBe('Ayşe');
      expect(getResp.headers).toEqual(expect.arrayContaining([['x-request-path', '/api/users']]));
      expect(getResp.timings?.wait).toBeGreaterThanOrEqual(0);
      expect(getResp.remoteAddress).toMatch(/^127\.0\.0\.1:\d+$/);
      const post = requests().find((r) => r.method === 'POST' && r.url.endsWith('/api/login'))!;
      expect(JSON.parse(post.body!.data)).toMatchObject({ user: 'yusuf' });
      const postResp = await waitFor(() => responses().find((r) => r.id === post.id), 5000, 'POST response');
      expect(JSON.parse(postResp.body!.data)).toMatchObject({ token: 'tok-123', user: 'yusuf' });
      const failed = errors()[0]!;
      expect(requests().some((r) => r.id === failed.id && r.url.endsWith('/unreachable'))).toBe(true);
      expect(failed.error).toMatch(/refused|SocketException|Connection/i);

      // metrics: heap from getMemoryUsage, RSS from getVM, FPS/jank from Flutter.Frame (60 Hz, 1 janky / 6)
      const withFps = metrics().filter((m) => (m.fps ?? 0) > 0);
      const m = withFps[withFps.length - 1]!;
      expect(m.heapMB).toBeGreaterThan(0);
      expect(m.memoryMB).toBeGreaterThan(0);
      expect(m.fps).toBeGreaterThanOrEqual(54);
      expect(m.fps).toBeLessThanOrEqual(66);
      expect(m.jankyFrames).toBeGreaterThan(0);
      expect(m.frameBuildMs).toBeGreaterThan(4);

      // commands → service extensions; actions advertised once the extensions exist and kept in sync
      const advertised = await waitFor(
        () => v.ofType('actions').map((m) => m.actions).find((a) => a.some((x) => x.id === 'flutter.debugPaint')),
        5000,
        'actions update',
      );
      expect(advertised.map((a) => a.id)).toEqual(['flutter.debugPaint', 'flutter.slowAnimations', 'flutter.dumpWidgetTree']);
      expect(advertised.find((a) => a.id === 'flutter.debugPaint')).toMatchObject({ kind: 'toggle', value: false, group: 'flutter' });
      const paint = await v.command('flutter.debugPaint', { value: true });
      expect(paint).toMatchObject({ ok: true, data: { value: true } });
      const actionsMsgs = v.ofType('actions');
      expect(actionsMsgs[actionsMsgs.length - 1]!.actions.find((a) => a.id === 'flutter.debugPaint')?.value).toBe(true);
      const slow = await v.command('flutter.slowAnimations');
      expect(slow).toMatchObject({ ok: true, data: { value: true } });
      const dump = await v.command('flutter.dumpWidgetTree');
      expect(dump.ok).toBe(true);
      expect((dump.data as { text: string }).text).toContain('MaterialApp');
      await waitFor(() => logs().find((l) => l.message.startsWith('Widget tree') && l.message.includes('Merhaba Dürbün')), 3000, 'dump log');
      expect((await v.command('flutter.brightness', { value: 'dark' })).ok).toBe(false);
      expect((await v.command('flutter.nope')).ok).toBe(false);

      // DDS takes over: the VM drops our direct connection; the session reconnects through DDS.
      const ticksBefore = logs().filter((l) => l.tag === 'fixture.tick').length;
      const dds = spawnTracked(DART, ['development-service', `--vm-service-uri=${rawUrl}`]);
      const ddsUri = await waitFor(() => /"ddsUri":"([^"]+)"/.exec(dds.output())?.[1], 10_000, 'DDS start');
      await waitFor(
        () => logs().filter((l) => l.tag === 'fixture.tick').length >= ticksBefore + 4,
        10_000,
        'logs after DDS took over',
      );
      expect(v.closed).toBe(false);
      expect(v.ofType('hello')).toHaveLength(1);
      expect(ctx.logLines.some((l) => /^info reconnected to app via DDS/.test(l))).toBe(true);
      const tickMessages = logs().filter((l) => l.tag === 'fixture.tick').map((l) => l.message);
      expect(new Set(tickMessages).size).toBe(tickMessages.length);
      const reqIds = requests().map((r) => r.id);
      expect(new Set(reqIds).size).toBe(reqIds.length);
      const terminalIds = [...responses(), ...errors()].map((r) => r.id);
      expect(new Set(responses().map((r) => r.id)).size).toBe(responses().length);
      expect(terminalIds.every((id) => reqIds.includes(id))).toBe(true);

      // Plain redirect following: the raw VM URL now answers 302 → DDS.
      const redirected = await connectVmService(rawUrl);
      expect(redirected.redirected).toBe(true);
      expect(redirected.url).toBe(normalizeVmServiceUrl(ddsUri));
      expect(await redirected.isDds()).toBe(true);
      await redirected.close();

      // A second module attaching late gets DDS's Logging history replayed.
      const ctx2 = createFakeContext();
      const vm2 = createFlutterVmModule({ autoAttachDelayMs: 0 });
      await vm2.start(ctx2);
      const attachedAt = Date.now();
      await vm2.attach(rawUrl);
      const v2 = ctx2.virtuals[0]!;
      await waitFor(() => (v2.ofType('log') as SdkLog[]).some((l) => l.tag === 'fixture.tick' && l.ts < attachedAt - 300), 5000, 'history replay');
      await vm2.stop();
      expect(v2.closed).toBe(true);

      // Auto-attach from a device log line (simulator → no port forward), reaching DDS through the redirect.
      const ctx3 = createFakeContext({ deviceLogsAvailable: true });
      const vm3 = createFlutterVmModule({ autoAttachDelayMs: 0 });
      await vm3.start(ctx3);
      ctx3.emitLogs([
        {
          id: 1,
          ts: Date.now(),
          deviceId: 'ios-sim:0E6A8C9F-1D2B-4C3D-9E8F-112233445566',
          source: 'device',
          level: 'info',
          tag: 'flutter',
          message: `The Dart VM service is listening on ${rawUrl}`,
          pid: app.child.pid,
          process: 'app',
        },
      ]);
      const v3 = await waitFor(() => ctx3.virtuals[0], 8000, 'auto-attach');
      await v3.appId;
      expect(v3.meta.deviceId).toBe('ios-sim:0E6A8C9F-1D2B-4C3D-9E8F-112233445566');
      expect(await waitFor(() => ctx3.notices.find((n) => n.code === 'vm.attached'), 5000, 'success notice')).toMatchObject({
        level: 'success',
      });
      expect(ctx3.forwards).toHaveLength(0);
      await vm3.stop();

      // Detach: the virtual session closes, a vm.detached line is written, profiling is turned off again.
      await vm.detach(appId);
      expect(v.closed).toBe(true);
      expect(ctx.systemLogs.map((s) => s.input.code)).toEqual(expect.arrayContaining(['vm.attached', 'vm.detached']));
      const check = await connectVmService(rawUrl);
      const isolates = (await check.call<{ isolates: { id: string }[] }>('getVM')).isolates;
      const state = await check.callExtension<{ enabled: boolean }>('ext.dart.io.httpEnableTimelineLogging', isolates[0]!.id);
      expect(state.enabled).toBe(false);
      await check.close();
      await vm.stop();
      expect(vm.status()).toMatchObject({ id: 'flutter-vm', active: false });
    },
    45_000,
  );
});
