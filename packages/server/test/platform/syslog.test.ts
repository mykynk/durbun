import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLogInput } from '../../src/types';
import { deviceNameVariants, parseSyslogLine, SyslogLineParser } from '../../src/platform/ios/syslog';
import { FlutterErrorGrouper } from '../../src/platform/shared/flutter';

const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();

describe('deviceNameVariants', () => {
  it('includes the user-facing name and hostname forms', () => {
    expect(deviceNameVariants('Yusuf iPhone’u')).toEqual(
      expect.arrayContaining(['Yusuf iPhone’u', 'Yusuf-iPhone’u', 'Yusuf-iPhoneu']),
    );
    expect(deviceNameVariants('Ömer’in iPhone’u')).toContain('Omerin-iPhoneu');
    expect(deviceNameVariants(undefined)).toEqual([]);
  });
});

describe('parseSyslogLine', () => {
  const names = deviceNameVariants('Yusuf iPhone’u');

  it('parses a hostname-style device name with process(image)[pid] <Level>', () => {
    const r = parseSyslogLine(
      'Nov  2 11:43:01 Yusuf-iPhoneu SpringBoard(FrontBoard)[57] <Notice>: [app<com.mykynk.pati>:1234] Workspace assertion state did change',
      names,
      NOW,
    );
    expect(r.type).toBe('entry');
    if (r.type !== 'entry') return;
    expect(r.entry).toMatchObject({
      ts: new Date(2026, 10, 2, 11, 43, 1).getTime(),
      level: 'info',
      tag: 'FrontBoard',
      process: 'SpringBoard',
      pid: 57,
      message: '[app<com.mykynk.pati>:1234] Workspace assertion state did change',
    });
  });

  it('strips a device name with spaces/apostrophes and maps Flutter prints', () => {
    const r = parseSyslogLine(
      'Nov  2 11:43:01.123456 Yusuf iPhone’u Runner(Flutter)[1234] <Notice>: flutter: Merhaba dünya [ok]',
      names,
      NOW,
    );
    if (r.type !== 'entry') throw new Error('expected entry');
    expect(r.entry).toMatchObject({
      ts: new Date(2026, 10, 2, 11, 43, 1).getTime() + 123.456,
      tag: 'flutter',
      process: 'Runner',
      pid: 1234,
      level: 'info',
      message: 'Merhaba dünya [ok]',
    });
  });

  it('falls back to "first token is the device name" for unknown names', () => {
    const r = parseSyslogLine('Oct 15 08:48:45 iPhone kernel(AppleBiometricSensor)[0] <Notice>: hello', [], NOW);
    if (r.type !== 'entry') throw new Error('expected entry');
    expect(r.entry).toMatchObject({ process: 'kernel', tag: 'AppleBiometricSensor', pid: 0 });
    const k = parseSyslogLine('Nov  2 11:43:01 iPhone kernel[0] <Debug>: AppleKeyStore: operation failed', [], NOW);
    if (k.type !== 'entry') throw new Error('expected entry');
    expect(k.entry).toMatchObject({ process: 'kernel', tag: 'kernel', level: 'debug' });
  });

  it('maps syslog levels', () => {
    const lvl = (l: string) => {
      const r = parseSyslogLine(`Nov  2 11:43:01 iPhone x[1] <${l}>: m`, [], NOW);
      return r.type === 'entry' ? r.entry.level : undefined;
    };
    expect(lvl('Error')).toBe('error');
    expect(lvl('Warning')).toBe('warn');
    expect(lvl('Info')).toBe('info');
    expect(lvl('Debug')).toBe('debug');
    expect(lvl('Critical')).toBe('fatal');
    expect(lvl('Fault')).toBe('error');
  });

  it('assumes the previous year for December lines read in early January', () => {
    const jan1 = new Date(2027, 0, 1, 0, 0, 5).getTime();
    const r = parseSyslogLine('Dec 31 23:59:58 iPhone x[1] <Notice>: late', [], jan1);
    if (r.type !== 'entry') throw new Error('expected entry');
    expect(new Date(r.entry.ts).getFullYear()).toBe(2026);
  });

  it('recognises status and continuation lines', () => {
    expect(parseSyslogLine('[connected:00008130-0001A2B3C4D5E6F7]', [], NOW)).toEqual({
      type: 'status',
      connected: true,
      udid: '00008130-0001A2B3C4D5E6F7',
    });
    expect(parseSyslogLine('[disconnected]', [], NOW)).toEqual({ type: 'status', connected: false });
    expect(parseSyslogLine('\tat continuation', [], NOW)).toEqual({ type: 'continuation', text: '\tat continuation' });
  });

  it('flags uncaught NSExceptions as crashes', () => {
    const r = parseSyslogLine(
      "Nov  2 11:43:01 iPhone Runner(CoreFoundation)[1234] <Error>: *** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: 'x'",
      [],
      NOW,
    );
    if (r.type !== 'entry') throw new Error('expected entry');
    expect(r.entry).toMatchObject({ kind: 'crash', level: 'fatal' });
  });
});

describe('SyslogLineParser', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('strips ANSI, joins continuation lines and reports connection status', () => {
    const out: DeviceLogInput[] = [];
    const status: boolean[] = [];
    const p = new SyslogLineParser((e) => out.push(e), (c) => status.push(c));
    p.setDeviceName('Yusuf iPhone’u');
    p.pushLine('[connected:00008130-0001A2B3C4D5E6F7]');
    p.pushLine('\x1b[0;36mNov  2 11:43:01\x1b[0m Yusuf-iPhoneu \x1b[1;32mRunner(Foundation)\x1b[0m[1234] <Notice>: line one');
    p.pushLine('line two');
    p.pushLine('line three');
    p.pushLine('Nov  2 11:43:02 Yusuf-iPhoneu Runner(Foundation)[1234] <Notice>: next record');
    expect(status).toEqual([true]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ message: 'line one\nline two\nline three', tag: 'Foundation', process: 'Runner' });
    vi.advanceTimersByTime(100);
    expect(out).toHaveLength(2);
  });

  it('feeds Flutter error boxes from the device log into one flutter-error entry', () => {
    const out: DeviceLogInput[] = [];
    const g = new FlutterErrorGrouper((e) => out.push(e));
    const p = new SyslogLineParser((e) => g.push(e));
    const lines = [
      '══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞══════════════════════════════════════',
      'The following assertion was thrown building Home:',
      'boom',
      '═══════════════════════════════════════════════════════════════════════════════',
    ];
    for (const l of lines) p.pushLine(`Nov  2 11:43:01 iPhone Runner(Flutter)[1234] <Notice>: flutter: ${l}`);
    p.flush();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'flutter-error', tag: 'flutter', level: 'error', process: 'Runner' });
    expect(out[0]!.message).toBe(lines.join('\n'));
  });
});
