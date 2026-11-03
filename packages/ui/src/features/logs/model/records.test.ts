import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { crashForeground, crashWhen, crashedBuildOf, entryClock, isNativeTombstone, isWholeSecond, recordUnsymbolicated } from './records';

const base = (p: Partial<LogEntry>): LogEntry => ({ id: 1, ts: 1_793_650_000_000, deviceId: 'android:1', source: 'device', level: 'fatal', tag: 't', message: 'm', ...p });

describe('device crash records', () => {
  it('reads the crashed build from dropbox and .ips data, only for device records', () => {
    expect(crashedBuildOf(base({ origin: 'dropbox', data: { origin: 'dropbox', version: '3.1.0', build: '310' } }))).toBe('3.1.0 (310)');
    expect(crashedBuildOf(base({ data: { origin: 'crash-report', version: '2.4.1', build: '241' } }))).toBe('2.4.1 (241)');
    expect(crashedBuildOf(base({ origin: 'crash-report', data: { origin: 'crash-report', version: '57', build: '57' } }))).toBe('57');
    expect(crashedBuildOf(base({ origin: 'dropbox', data: { origin: 'dropbox', build: '310' } }))).toBe('(310)');
    expect(crashedBuildOf(base({ origin: 'dropbox', data: { origin: 'dropbox' } }))).toBeUndefined();
    // A live log line that happens to carry a version is not a record.
    expect(crashedBuildOf(base({ origin: 'logcat', data: { version: '1.0.0' } }))).toBeUndefined();
  });

  it('foreground only when the record says so', () => {
    expect(crashForeground(base({ origin: 'dropbox', data: { origin: 'dropbox', foreground: true } }))).toBe(true);
    expect(crashForeground(base({ origin: 'dropbox', data: { origin: 'dropbox', foreground: false } }))).toBe(false);
    expect(crashForeground(base({ origin: 'dropbox', data: { origin: 'dropbox' } }))).toBeUndefined();
  });

  it('Android native tombstones are unsymbolicated like .ips; Java crashes and ANRs are not', () => {
    const tomb = (tag: string) => base({ origin: 'dropbox', data: { origin: 'dropbox', dropboxTag: tag } });
    expect(isNativeTombstone(tomb('data_app_native_crash'))).toBe(true);
    expect(recordUnsymbolicated(tomb('data_app_native_crash'))).toBe(true);
    expect(recordUnsymbolicated(tomb('SYSTEM_TOMBSTONE'))).toBe(true);
    expect(recordUnsymbolicated(tomb('data_app_crash'))).toBe(false);
    expect(recordUnsymbolicated(tomb('data_app_anr'))).toBe(false);
    expect(recordUnsymbolicated(base({ origin: 'crash-report', data: { origin: 'crash-report', symbolicated: false } }))).toBe(true);
    expect(recordUnsymbolicated(base({ origin: 'crash-report', data: { origin: 'crash-report', symbolicated: true } }))).toBe(false);
    expect(recordUnsymbolicated(base({ origin: 'logcat', data: { dropboxTag: 'data_app_native_crash' } }))).toBe(false);
  });
});

describe('timestamp precision', () => {
  it('drops the made-up ".000" of whole-second sources only', () => {
    const whole = 1_793_650_007_000;
    expect(isWholeSecond({ ts: whole, origin: 'idevicesyslog' })).toBe(true);
    expect(isWholeSecond({ ts: whole, origin: 'logcat' })).toBe(false);
    expect(isWholeSecond({ ts: whole + 123, origin: 'idevicesyslog' })).toBe(false);
    expect(isWholeSecond({ ts: whole, data: { origin: 'dropbox' } })).toBe(true);
    expect(entryClock({ ts: whole, origin: 'idevicesyslog' })).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(entryClock({ ts: whole, origin: 'logcat' })).toMatch(/^\d\d:\d\d:\d\d\.000$/);
    expect(entryClock({ ts: whole + 5, origin: 'idevicesyslog' })).toMatch(/\.005$/);
  });
});

describe('when an earlier crash happened', () => {
  it('shows the clock for today and adds the date for an older record', () => {
    const now = new Date(2026, 10, 2, 23, 0, 0).getTime();
    expect(crashWhen({ ts: new Date(2026, 10, 2, 19, 52, 20).getTime(), origin: 'dropbox' }, now)).toBe('19:52:20');
    const older = crashWhen({ ts: new Date(2026, 10, 1, 19, 52, 20).getTime(), origin: 'dropbox' }, now);
    expect(older).toMatch(/2026/);
    expect(older).toMatch(/19:52:20/);
  });
});
