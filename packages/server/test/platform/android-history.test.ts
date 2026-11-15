/**
 * What happened before the phone was plugged in: older app lines from the log buffer (logcat -d), lmkd
 * memory kills, and a bigger log buffer for next time.
 */
import { describe, expect, it } from 'vitest';
import type { LogBufferSizeData } from '@durbun/protocol';
import { logBufferBytes, parseLogBufferSizes, runAndroidAction } from '../../src/platform/android/actions';
import type { Adb } from '../../src/platform/android/adb';
import { AndroidLogPipeline, parseLowMemoryKill, selectBackfill } from '../../src/platform/android/logcat';
import type { RunResult } from '../../src/platform/exec';
import { ScreenRecorder } from '../../src/platform/shared/screenRecord';
import type { DeviceLogInput } from '../../src/types';
import { createCtx } from './helpers';

const T0 = 1793608981000;
const epoch = (ms: number) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
const line = (ms: number, pid: number, tid: number, lvl: string, tag: string, msg: string) =>
  `${epoch(ms).padStart(20)} ${String(pid).padStart(5)} ${String(tid).padStart(5)} ${lvl} ${tag.padEnd(8)}: ${msg}`;

describe('lmkd kills', () => {
  it('reads the Android 11+ and the Android 9/10 line', () => {
    expect(
      parseLowMemoryKill(
        'lowmemorykiller',
        "Kill 'com.mykynk.pati' (4500), uid 10190, oom_score_adj 0 to free 182340kB rss, 0kB swap; reason: device is not responding",
      ),
    ).toEqual({ process: 'com.mykynk.pati', pid: 4500, uid: 10190, adj: 0, freedKb: 182340, reason: 'device is not responding' });
    expect(parseLowMemoryKill('lowmemorykiller', "Kill 'com.android.chrome:sandboxed_process0' (8123), uid 99012, oom_adj 906 to free 40213kB")).toEqual({
      process: 'com.android.chrome:sandboxed_process0',
      pid: 8123,
      uid: 99012,
      adj: 906,
      freedKb: 40213,
    });
    expect(parseLowMemoryKill('ActivityManager', "Kill 'x' (1), uid 1, oom_adj 0")).toBeNull();
    expect(parseLowMemoryKill('lowmemorykiller', 'Using psi monitors for memory pressure detection')).toBeNull();
  });

  it('marks the kill of the app on screen as an error of that app; background kills keep their level', async () => {
    const out: DeviceLogInput[] = [];
    const p = new AndroidLogPipeline({ emit: (e) => out.push(e) });
    p.pushLine(line(T0, 371, 371, 'I', 'lowmemorykiller', "Kill 'com.mykynk.pati' (4500), uid 10190, oom_score_adj 0 to free 182340kB rss, 0kB swap; reason: device is not responding"));
    p.pushLine(line(T0 + 10, 371, 371, 'I', 'lowmemorykiller', "Kill 'com.example.cached' (5100), uid 10201, oom_score_adj 905 to free 30120kB rss, 0kB swap; reason: low watermark is breached"));
    p.flush();
    expect(out[0]).toMatchObject({ level: 'error', pid: 4500, process: 'com.mykynk.pati', data: { termination: 'low-memory', visible: true, reporterPid: 371 } });
    expect(out[1]).toMatchObject({ level: 'info', pid: 5100, data: { termination: 'low-memory', visible: false, adj: 905 } });
  });
});

describe('history from the log buffer', () => {
  const dump = [
    '--------- beginning of main',
    line(T0 - 5000, 4100, 4100, 'I', 'Pati', 'started before the dump, still running'),
    line(T0, 612, 650, 'I', 'ActivityManager', 'Start proc 4321:com.mykynk.pati/u0a190 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}'),
    line(T0 + 10, 4321, 4321, 'D', 'Pati', 'ödeme ekranı açıldı'),
    line(T0 + 20, 900, 920, 'I', 'wpa_supplicant', 'noise'),
    line(T0 + 30, 1000, 1000, 'I', 'ActivityManager', 'Start proc 7000:com.google.android.gms/u0a12 for service'),
    line(T0 + 40, 7000, 7000, 'I', 'GmsCore', 'gms noise'),
    '--------- beginning of crash',
    line(T0 + 50, 4321, 4321, 'E', 'AndroidRuntime', 'FATAL EXCEPTION: main'),
    line(T0 + 50, 4321, 4321, 'E', 'AndroidRuntime', 'Process: com.mykynk.pati, PID: 4321'),
    line(T0 + 60, 612, 640, 'I', 'ActivityManager', 'Process com.mykynk.pati (pid 4321) has died: fg  TOP'),
    line(T0 + 70, 900, 920, 'I', 'wpa_supplicant', 'tail 1'),
    line(T0 + 70, 900, 920, 'I', 'wpa_supplicant', 'tail 2'),
  ];
  const isApp = (name: string) => name.split(':')[0] === 'com.mykynk.pati';

  it('keeps the tail and, before it, only the user apps, crashes and their ActivityManager lines', () => {
    const plan = selectBackfill(dump, { tail: 2, isAppProcess: isApp, processName: (pid) => (pid === 4100 ? 'com.mykynk.pati:sync' : undefined) });
    const kept = plan.lines.map((l) => l.slice(l.indexOf(': ') + 2));
    expect(kept).toEqual([
      'started before the dump, still running',
      'Start proc 4321:com.mykynk.pati/u0a190 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}',
      'ödeme ekranı açıldı',
      'FATAL EXCEPTION: main',
      'Process: com.mykynk.pati, PID: 4321',
      'Process com.mykynk.pati (pid 4321) has died: fg  TOP',
      'tail 1',
      'tail 2',
    ]);
    expect(plan.history).toBe(6);
    expect(plan.firstTs).toBe(T0 - 5000);
    expect(plan.end).toEqual({ lastTs: T0 + 70, atLast: [dump[11], dump[12]] });
  });

  it('replays the kept lines once and resumes the stream after the dump, also after a kept-out last line', () => {
    const out: DeviceLogInput[] = [];
    const p = new AndroidLogPipeline({ emit: (e) => out.push(e) });
    const plan = selectBackfill(dump, { tail: 0, isAppProcess: isApp });
    p.pushBackfill(plan.lines, plan.end);
    expect(p.lastTimestamp).toBe(T0 + 70); // the dump's last record, though it was left out
    // The stream replays the boundary: the same two lines are dropped, the next one passes.
    p.beginResume();
    p.pushLine(dump[11]!);
    p.pushLine(dump[12]!);
    p.pushLine(line(T0 + 80, 4500, 4500, 'I', 'Pati', 'after the dump'));
    p.flush();
    const msgs = out.map((e) => e.message);
    expect(msgs).not.toContain('tail 1');
    expect(msgs[msgs.length - 1]).toBe('after the dump');
    expect(out.find((e) => e.kind === 'crash')).toMatchObject({ process: 'com.mykynk.pati' });
  });
});

describe('bigger log buffers (logs-restart with bufferSize)', () => {
  it('reads both logcat -g formats', () => {
    expect(
      parseLogBufferSizes(
        'main: ring buffer is 256 KiB (193 KiB consumed, 193 KiB readable), max entry is 5120 B, max payload is 4068 B\nsystem: ring buffer is 1 MiB (310 KiB consumed, 310 KiB readable), max entry is 5120 B, max payload is 4068 B\n',
      ),
    ).toEqual({ main: 262144, system: 1048576 });
    expect(parseLogBufferSizes('main: ring buffer is 256Kb (191Kb consumed), max entry is 5120b, max payload is 4076b\n')).toEqual({ main: 262144 });
    expect(logBufferBytes('16M')).toBe(16 * 1024 * 1024);
    expect(logBufferBytes('16 MB')).toBeUndefined();
  });

  it('sets the size, restarts the stream and reports before / after', async () => {
    const calls: string[] = [];
    let size = '256 KiB';
    const adb = {
      async run(args: string[]): Promise<RunResult<string>> {
        calls.push(args.slice(2).join(' '));
        if (args.includes('-G')) size = '16 MiB';
        const stdout = args.includes('-g') ? `main: ring buffer is ${size} (1 KiB consumed, 1 KiB readable), max entry is 5120 B, max payload is 4068 B\n` : '';
        return { ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false };
      },
    } as unknown as Adb;
    let restarted = 0;
    const t = {
      adb,
      serial: 'R58M123ABC',
      deviceId: 'android:R58M123ABC',
      label: 'Galaxy S21',
      isEmulator: false,
      apiLevel: 34,
      ctx: createCtx(),
      restartLogs: async () => void (restarted += 1),
      recorder: new ScreenRecorder(() => undefined),
    };
    const r = await runAndroidAction(t, 'logs-restart', { bufferSize: '16M' });
    expect(r.ok).toBe(true);
    expect(r.data as LogBufferSizeData).toEqual({ before: { main: 262144 }, after: { main: 16777216 }, requested: '16M' });
    expect(calls).toEqual(['logcat -g', 'logcat -G 16M', 'logcat -g']);
    expect(restarted).toBe(1);
    expect(await runAndroidAction(t, 'logs-restart', { bufferSize: '1G' })).toMatchObject({ ok: false, code: 'action.invalidParams' });
    expect(await runAndroidAction({ ...t, apiLevel: 19 }, 'logs-restart', { bufferSize: '16M' })).toMatchObject({ ok: false, code: 'action.unsupported' });
  });
});
