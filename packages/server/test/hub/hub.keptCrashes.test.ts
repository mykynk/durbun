/**
 * Crash / ANR rows outlive device noise (audit-ux #2): a busy iPhone fills the 200k ring in minutes, but
 * crash rows evicted from it are kept apart (newest MAX_KEPT_CRASH_LOGS) and merged by id into history,
 * counts and exports.
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { isKeptCrashLog, MAX_KEPT_CRASH_LOGS } from '../../src/hub/index';
import type { DeviceLogInput } from '../../src/types';
import { device, makeHub, makeSettings } from './helpers';

const noise = (n: number, from = 0): DeviceLogInput[] =>
  Array.from({ length: n }, (_, i) => ({ ts: 10_000 + from + i, level: 'info', tag: 'spotlightknowledged', message: `noise ${from + i}`, pid: 99, process: 'spotlightknowledged', origin: 'idevicesyslog' }));
const messages = (logs: LogEntry[]) => logs.map((l) => l.message);
const ascending = (logs: LogEntry[]) => logs.every((l, i) => i === 0 || logs[i - 1]!.id < l.id);

describe('crash rows kept beyond the log ring', () => {
  it('decides by kind and origin', () => {
    expect(isKeptCrashLog({ kind: 'crash' })).toBe(true);
    expect(isKeptCrashLog({ kind: 'anr' })).toBe(true);
    expect(isKeptCrashLog({ kind: 'text', origin: 'dropbox' })).toBe(true);
    expect(isKeptCrashLog({ origin: 'crash-report' })).toBe(true);
    for (const e of [{}, { kind: 'flutter-error' as const }, { kind: 'text' as const, origin: 'logcat' as const }, { kind: 'lifecycle' as const, origin: 'durbun' as const }]) {
      expect(isKeptCrashLog(e), JSON.stringify(e)).toBe(false);
    }
  });

  it('survive a flood of device noise: history, paging, count and exports keep them in id order', () => {
    const hub = makeHub({ maxLogEntries: 50 });
    hub.upsertDevice(device('ios:A', { platform: 'ios', name: 'Yusuf iPhone’u' }));
    hub.upsertDevice(device('android:B'));
    const deviceLines = (l: LogEntry) => l.source === 'device';
    hub.pushDeviceLogs('ios:A', [
      { ts: 1, level: 'fatal', tag: 'crash-report', message: 'Kumbara crashed', kind: 'crash', origin: 'crash-report', data: { origin: 'crash-report', previousLaunch: true } },
    ]);
    hub.pushDeviceLogs('android:B', [
      { ts: 2, level: 'error', tag: 'ActivityManager', message: 'ANR in com.mykynk.kumbara', kind: 'anr', origin: 'logcat', pid: 12_045 },
      { ts: 3, level: 'error', tag: 'data_app_anr', message: 'ANR copy', kind: 'anr', origin: 'dropbox' },
      { ts: 4, level: 'info', tag: 'flutter', message: 'an ordinary line', origin: 'logcat', pid: 12_045 },
    ]);
    hub.pushDeviceLogs('ios:A', noise(200));

    const logs = hub.getLogs();
    expect(ascending(logs)).toBe(true);
    expect(messages(logs.filter(deviceLines)).slice(0, 4)).toEqual(['Kumbara crashed', 'ANR in com.mykynk.kumbara', 'ANR copy', 'noise 150']);
    expect(logs.some((l) => l.message === 'an ordinary line')).toBe(false); // ordinary lines still go
    expect(logs.slice(3).every((l) => !isKeptCrashLog(l))).toBe(true);
    expect(logs).toHaveLength(53);
    expect(hub.getLogCount()).toBe(53);

    // paging across the boundary between kept rows and the ring
    expect(messages(hub.getLogs({ afterId: logs[0]!.id, limit: 3 }))).toEqual(['ANR in com.mykynk.kumbara', 'ANR copy', 'noise 150']);
    expect(hub.getLogs({ afterId: logs[2]!.id })).toEqual(logs.slice(3));
    expect(hub.getLogs({ limit: 2 })).toEqual(logs.slice(0, 2));
    expect(hub.getLogs({ afterId: logs[52]!.id })).toEqual([]);
    expect(hub.getLogs({ afterId: 0, limit: 0 })).toEqual([]);

    expect(messages(hub.exportSession().logs).slice(0, 3)).toEqual(['Kumbara crashed', 'ANR in com.mykynk.kumbara', 'ANR copy']);
    expect(messages(hub.exportSession({ deviceId: 'android:B' }).logs)).toEqual(['ANR in com.mykynk.kumbara', 'ANR copy']);
  });

  it('keep the newest MAX_KEPT_CRASH_LOGS; clears remove them like any row; a smaller ring keeps its crashes', () => {
    const hub = makeHub({ maxLogEntries: 50 });
    hub.upsertDevice(device('android:B'));
    const crashes: DeviceLogInput[] = Array.from({ length: MAX_KEPT_CRASH_LOGS + 10 }, (_, i) => ({
      ts: i,
      level: 'fatal',
      tag: 'AndroidRuntime',
      message: `crash ${i}`,
      kind: 'crash',
      origin: 'logcat',
      pid: 100 + i,
    }));
    hub.pushDeviceLogs('android:B', crashes);
    hub.pushDeviceLogs('android:B', noise(100));
    const logs = hub.getLogs().filter((l) => l.source === 'device');
    expect(logs).toHaveLength(MAX_KEPT_CRASH_LOGS + 50);
    expect(logs[0]!.message).toBe('crash 10'); // the 10 oldest crashes went
    expect(logs[MAX_KEPT_CRASH_LOGS - 1]!.message).toBe(`crash ${MAX_KEPT_CRASH_LOGS + 9}`);
    expect(ascending(logs)).toBe(true);

    // a scoped clear removes kept rows of that scope only; a full clear removes everything
    hub.upsertDevice(device('ios:A', { platform: 'ios' }));
    hub.pushDeviceLogs('ios:A', [{ ts: 1, level: 'fatal', tag: 'crash-report', message: 'iPhone crash', kind: 'crash', origin: 'crash-report' }]);
    hub.pushDeviceLogs('ios:A', noise(60));
    expect(hub.getLogs().some((l) => l.message === 'iPhone crash')).toBe(true);
    hub.clear('logs', { deviceId: 'android:B' });
    expect(hub.getLogs().filter((l) => l.deviceId === 'android:B')).toEqual([]);
    expect(messages(hub.getLogs()).filter((m) => m.includes('crash'))).toEqual(['iPhone crash']);
    hub.clear('all');
    expect(hub.getLogs()).toEqual([]);
    expect(hub.getLogCount()).toBe(0);

    // shrinking maxLogEntries keeps the crash rows it evicts
    hub.setSettings(makeSettings({ maxLogEntries: 100 }));
    hub.pushDeviceLogs('ios:A', [{ ts: 1, level: 'fatal', tag: 'Runner', message: '*** Terminating app due to uncaught exception', kind: 'crash', pid: 77 }]);
    hub.pushDeviceLogs('ios:A', noise(99));
    hub.setSettings(makeSettings({ maxLogEntries: 10 }));
    expect(messages(hub.getLogs())[0]).toBe('*** Terminating app due to uncaught exception');
    expect(hub.getLogCount()).toBe(11);
  });
});
