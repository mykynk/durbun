import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLogInput } from '../../src/types';
import {
  AndroidCrashGrouper,
  AndroidLogPipeline,
  BoundaryDeduper,
  detectProcessEvent,
  logcatSinceArg,
  LogcatMerger,
  parseLogcatLine,
  unescapePrintable,
  type LogcatLine,
  type ProcessEvent,
} from '../../src/platform/android/logcat';
import { fixture } from './helpers';

describe('parseLogcatLine', () => {
  it('parses threadtime + epoch with the right-aligned 19-char seconds column', () => {
    const l = parseLogcatLine(
      '         1793608981.101   612   650 I ActivityManager: Start proc 4321:com.mykynk.pati/u0a190 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}',
    )!;
    expect(l).toMatchObject({
      ts: 1793608981101,
      pid: 612,
      tid: 650,
      level: 'info',
      tag: 'ActivityManager',
    });
    expect(l.message).toBe(
      'Start proc 4321:com.mykynk.pati/u0a190 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}',
    );
  });

  it('parses unpadded epoch, short padded tags and every level letter', () => {
    const levels: Array<[string, string]> = [
      ['V', 'verbose'],
      ['D', 'debug'],
      ['I', 'info'],
      ['W', 'warn'],
      ['E', 'error'],
      ['F', 'fatal'],
      ['A', 'fatal'],
    ];
    for (const [c, lvl] of levels) {
      const l = parseLogcatLine(`1793608981.320  4321  4321 ${c} flutter : hello`)!;
      expect(l.level).toBe(lvl);
      expect(l.tag).toBe('flutter');
      expect(l.message).toBe('hello');
    }
  });

  it('parses the classic MM-DD format as local time of the current year', () => {
    const now = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const l = parseLogcatLine('11-02 11:43:01.123  1234  1250 D flutter : hello', now)!;
    expect(l.ts).toBe(new Date(2026, 10, 2, 11, 43, 1).getTime() + 123);
    expect(l).toMatchObject({ pid: 1234, tid: 1250, level: 'debug', tag: 'flutter', message: 'hello' });
  });

  it('puts a December line read on January 1st into the previous year', () => {
    const now = new Date(2027, 0, 1, 0, 0, 5).getTime();
    const l = parseLogcatLine('12-31 23:59:58.900  1  1 I init    : x', now)!;
    expect(new Date(l.ts).getFullYear()).toBe(2026);
  });

  it('parses year format with microseconds and a zone offset', () => {
    const l = parseLogcatLine('2026-11-02 11:43:01.123456 +0300  1234  1250 W Foo     : msg')!;
    expect(l.ts).toBeCloseTo(Date.UTC(2026, 10, 2, 8, 43, 1) + 123.456, 3);
    expect(l.tag).toBe('Foo');
    expect(l.level).toBe('warn');
  });

  it('accepts an optional uid column (-v uid), named or numeric', () => {
    const a = parseLogcatLine('1793608983.500 u0_a190  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main')!;
    expect(a).toMatchObject({ pid: 4321, tid: 4321, tag: 'AndroidRuntime', message: 'FATAL EXCEPTION: main' });
    const b = parseLogcatLine('1793608983.500  1000   612   650 I ActivityManager: hi')!;
    expect(b).toMatchObject({ pid: 612, tid: 650, tag: 'ActivityManager' });
  });

  it('handles empty messages, tags with spaces and colons inside the message', () => {
    expect(parseLogcatLine('1793608982.002  4321  4321 I flutter : ')!.message).toBe('');
    expect(parseLogcatLine('1793608982.002  4321  4321 I flutter :')!).toMatchObject({ tag: 'flutter', message: '' });
    expect(parseLogcatLine('1793608982.002  1000  1000 I AppOps Service: started')!.tag).toBe('AppOps Service');
    const l = parseLogcatLine('1793608982.002  4321  4321 I okhttp.OkHttpClient: --> GET https://x.dev/a?b=1: c')!;
    expect(l.tag).toBe('okhttp.OkHttpClient');
    expect(l.message).toBe('--> GET https://x.dev/a?b=1: c');
  });

  it('reverses -v printable backslash doubling but keeps other escapes visible', () => {
    const l = parseLogcatLine(
      '1793608981.320  4321  4321 I flutter : {"path":"C:\\\\\\\\temp","note":"he said \\\\"hi\\\\""}',
    )!;
    expect(l.message).toBe('{"path":"C:\\\\temp","note":"he said \\"hi\\""}');
    expect(JSON.parse(l.message)).toEqual({ path: 'C:\\temp', note: 'he said "hi"' });
    expect(unescapePrintable('a\\rb\\x80c\\\\d')).toBe('a\\rb\\x80c\\d');
    expect(unescapePrintable('trailing\\')).toBe('trailing\\');
  });

  it('keeps UTF-8 text intact', () => {
    const l = parseLogcatLine('1793608981.330  4321  4321 I flutter : Kullanıcı giriş yaptı — ÇĞİÖŞÜ çğıöşü')!;
    expect(l.message).toBe('Kullanıcı giriş yaptı — ÇĞİÖŞÜ çğıöşü');
  });

  it('parses brief format as a fallback and rejects separators/garbage', () => {
    const now = 1_700_000_000_000;
    expect(parseLogcatLine('I/ActivityManager(  612): Displayed com.x/.Main: +350ms', now)).toMatchObject({
      ts: now,
      pid: 612,
      tag: 'ActivityManager',
      message: 'Displayed com.x/.Main: +350ms',
    });
    expect(parseLogcatLine('--------- beginning of main')).toBeNull();
    expect(parseLogcatLine('read: unexpected EOF!')).toBeNull();
    expect(parseLogcatLine('')).toBeNull();
  });

  it('is fast and has no pathological backtracking', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      lines.push(`         17936089${String(81 + (i % 9)).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}  ${1000 + (i % 50)}  ${2000 + (i % 7)} D Tag${i % 13}: message number ${i} with some payload {"k":${i}}`);
    }
    lines.push(`1793608981.1 ${'9 '.repeat(5000)}`); // adversarial
    lines.push(`         1793608981.101   612   650 I ${'a'.repeat(20000)}`);
    const start = performance.now();
    let n = 0;
    for (const l of lines) if (parseLogcatLine(l)) n += 1;
    const ms = performance.now() - start;
    expect(n).toBeGreaterThanOrEqual(50_000);
    expect(ms).toBeLessThan(1500);
  });
});

describe('LogcatMerger', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rec = (header: string, message: string): LogcatLine => ({
    ts: 1,
    pid: 1,
    tid: 1,
    level: 'error',
    tag: 'AndroidRuntime',
    message,
    header,
  });

  it('joins consecutive lines with an identical header and flushes on a new header', () => {
    const out: LogcatLine[] = [];
    const m = new LogcatMerger((l) => out.push(l));
    m.push(rec('H1', 'FATAL EXCEPTION: main'));
    m.push(rec('H1', 'Process: x, PID: 1'));
    m.push(rec('H1', '\tat a.b(c.java:1)'));
    expect(out).toHaveLength(0);
    m.push(rec('H2', 'next'));
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe('FATAL EXCEPTION: main\nProcess: x, PID: 1\n\tat a.b(c.java:1)');
  });

  it('holds the pending record at most ~60 ms', () => {
    const out: LogcatLine[] = [];
    const m = new LogcatMerger((l) => out.push(l));
    m.push(rec('H1', 'a'));
    vi.advanceTimersByTime(59);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(out).toHaveLength(1);
  });
});

describe('BoundaryDeduper / resume', () => {
  it('drops the lines repeated by `logcat -T <last epoch>` after a restart', () => {
    const d = new BoundaryDeduper();
    const lines = [
      '1793608981.101  1  1 I A: one',
      '1793608981.102  1  1 I A: two',
      '1793608981.102  1  1 I A: three',
    ];
    for (const l of lines) expect(d.accept(parseLogcatLine(l)!, l)).toBe(true);
    expect(logcatSinceArg(d.lastTimestamp!)).toBe('1793608981.102');
    d.beginResume();
    const replay = [...lines.slice(1), '1793608981.102  1  1 I A: four', '1793608981.200  1  1 I A: five'];
    const accepted = replay.filter((l) => d.accept(parseLogcatLine(l)!, l));
    expect(accepted).toEqual(['1793608981.102  1  1 I A: four', '1793608981.200  1  1 I A: five']);
    // After the boundary everything flows again, even identical text.
    expect(d.accept(parseLogcatLine('1793608981.200  1  1 I A: five')!, 'x')).toBe(true);
  });
});

describe('detectProcessEvent', () => {
  const name = (pid: number) => (pid === 77 ? 'com.app' : undefined);
  it('recognises process starts in both the modern and the legacy format', () => {
    expect(detectProcessEvent('ActivityManager', 'Start proc 4321:com.google.android.gms:persistent/u0a146 for service {x}', 5, name)).toEqual({
      pid: 4321,
      name: 'com.google.android.gms:persistent',
      event: 'started',
      ts: 5,
    });
    expect(
      detectProcessEvent(
        'ActivityManager',
        'Start proc com.example.app for activity com.example.app/.Main: pid=1234 uid=10061 gids={50061, 9997}',
        5,
        name,
      ),
    ).toMatchObject({ pid: 1234, name: 'com.example.app', event: 'started' });
  });

  it('recognises deaths (has died / Killing / Zygote with a known pid)', () => {
    expect(detectProcessEvent('ActivityManager', 'Process com.app (pid 77) has died: cch+5 CEM', 1, name)).toMatchObject({
      pid: 77,
      event: 'died',
    });
    expect(detectProcessEvent('ActivityManager', 'Killing 77:com.app/u0a190 (adj 900): empty #17', 1, name)).toMatchObject({
      pid: 77,
      name: 'com.app',
      event: 'died',
    });
    expect(detectProcessEvent('Zygote', 'Process 77 exited due to signal 9 (Killed)', 1, name)).toMatchObject({
      pid: 77,
      name: 'com.app',
      event: 'died',
    });
    expect(detectProcessEvent('Zygote', 'Process 78 exited due to signal 9 (Killed)', 1, name)).toBeNull();
    expect(detectProcessEvent('chatty', 'Start proc 1:x/y for z', 1, name)).toBeNull();
  });
});

describe('AndroidCrashGrouper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const e = (pid: number, tag: string, message: string, ts = 1000, level: DeviceLogInput['level'] = 'error'): DeviceLogInput => ({
    ts,
    pid,
    tid: pid,
    level,
    tag,
    message,
  });

  it('closes a Java crash after the idle window when nothing else arrives', () => {
    const out: DeviceLogInput[] = [];
    const g = new AndroidCrashGrouper((x) => out.push(x));
    g.push(e(10, 'AndroidRuntime', 'FATAL EXCEPTION: main\nProcess: com.a, PID: 10'));
    g.push(e(11, 'chatty', 'other process line', 1000, 'info'));
    g.push(e(10, 'AndroidRuntime', '\tat x.y(z.java:1)'));
    expect(out.map((x) => x.tag)).toEqual(['chatty']);
    vi.advanceTimersByTime(450);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ kind: 'crash', level: 'fatal', pid: 10 });
    expect(out[1]!.message.split('\n')).toHaveLength(3);
    expect(out[1]!.data).toEqual({ crashedProcess: 'com.a', crashedPid: 10 });
  });

  it('starts a new tombstone group when a DEBUG line arrives more than 2 s later', () => {
    const out: DeviceLogInput[] = [];
    const g = new AndroidCrashGrouper((x) => out.push(x));
    g.push(e(9, 'DEBUG', '*** *** *** *** *** ***', 1000, 'fatal'));
    g.push(e(9, 'DEBUG', 'pid: 5, tid: 6, name: main  >>> com.n <<<', 1500, 'fatal'));
    g.push(e(9, 'DEBUG', 'late unrelated line', 4000, 'fatal'));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'crash', pid: 5, tid: 6, process: 'com.n' });
    expect(out[1]).toMatchObject({ message: 'late unrelated line' });
    expect(out[1]!.kind).toBeUndefined();
  });
});

describe('AndroidLogPipeline (realistic logcat capture)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function runFixture() {
    const out: DeviceLogInput[] = [];
    const events: ProcessEvent[] = [];
    const names = new Map<number, string>([[612, 'system_server']]);
    const p = new AndroidLogPipeline({
      emit: (x) => out.push(x),
      onProcessEvent: (ev) => {
        events.push(ev);
        if (ev.event === 'started') names.set(ev.pid, ev.name);
        else names.delete(ev.pid);
      },
      processName: (pid) => names.get(pid),
    });
    for (const line of fixture('logcat-epoch.txt').split('\n')) p.pushLine(line);
    p.flush();
    return { out, events, p };
  }

  it('produces one entry per log record with crashes, ANRs and Flutter errors grouped', () => {
    const { out, p } = runFixture();
    expect(p.unparsed).toBe(0);
    const kinds = out.map((x) => x.kind ?? 'text');
    expect(kinds.filter((k) => k === 'crash')).toHaveLength(3); // Java crash, tombstone, Dart unhandled exception
    expect(kinds.filter((k) => k === 'anr')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'flutter-error')).toHaveLength(2); // box + "Another exception"
    expect(out).toHaveLength(18);
  });

  it('keeps JSON payloads valid after printable un-escaping and fills process names', () => {
    const { out } = runFixture();
    const json = out.find((x) => x.message.startsWith('{"event"'))!;
    expect(JSON.parse(json.message)).toEqual({ event: 'login', userId: 42, path: 'C:\\temp', note: 'he said "hi"' });
    expect(json.process).toBe('com.mykynk.pati');
    expect(out[0]).toMatchObject({ tag: 'ActivityManager', process: 'system_server' });
  });

  it('groups the Flutter error box into one flutter-error entry, letting other processes through', () => {
    const { out } = runFixture();
    const boxIdx = out.findIndex((x) => x.kind === 'flutter-error' && x.message.includes('EXCEPTION CAUGHT BY'));
    const box = out[boxIdx]!;
    expect(box).toMatchObject({ level: 'error', tag: 'flutter', pid: 4321, ts: 1793608982001 });
    const lines = box.message.split('\n');
    expect(lines[0]).toContain('══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞');
    expect(lines.at(-1)).toMatch(/^═+$/);
    expect(lines).toContain('A RenderFlex overflowed by 42 pixels on the right.');
    expect(lines).toHaveLength(7);
    // The ActivityManager line printed while the box was open is emitted before it.
    expect(out[boxIdx - 1]!.message).toContain('Unable to start service');
  });

  it('merges the AndroidRuntime FATAL EXCEPTION across headers into one fatal crash', () => {
    const { out } = runFixture();
    const crash = out.find((x) => x.tag === 'AndroidRuntime')!;
    expect(crash).toMatchObject({ kind: 'crash', level: 'fatal', pid: 4321, process: 'com.mykynk.pati' });
    expect(crash.message.split('\n')).toEqual([
      'FATAL EXCEPTION: main',
      'Process: com.mykynk.pati, PID: 4321',
      'java.lang.IllegalStateException: Boom',
      '\tat com.mykynk.pati.MainActivity.onCreate(MainActivity.kt:21)',
      '\tat android.app.Activity.performCreate(Activity.java:8595)',
      '\tat android.app.ActivityThread.main(ActivityThread.java:8177)',
    ]);
    expect(out.filter((x) => x.tag === 'AndroidRuntime')).toHaveLength(1);
  });

  it('groups the native tombstone and attributes it to the crashed process', () => {
    const { out } = runFixture();
    const t = out.find((x) => x.tag === 'DEBUG')!;
    expect(t).toMatchObject({ kind: 'crash', level: 'fatal', pid: 5001, tid: 5001, process: 'com.example.native' });
    expect(t.data).toMatchObject({ reporterPid: 5010, signal: 'SIGSEGV', thread: 'RenderThread' });
    expect(t.message.split('\n')).toHaveLength(11);
    expect(out.filter((x) => x.tag === 'DEBUG')).toHaveLength(1);
  });

  it('marks ANRs and attributes them to the app pid', () => {
    const { out } = runFixture();
    const anr = out.find((x) => x.kind === 'anr')!;
    expect(anr).toMatchObject({ level: 'error', pid: 4400, process: 'com.mykynk.pati', tag: 'ActivityManager' });
    expect(anr.data).toMatchObject({ reporterPid: 612, package: 'com.mykynk.pati' });
    expect(anr.message).toContain('Reason: Input dispatching timed out');
  });

  it('marks the Dart unhandled exception (engine line + stack) as a crash', () => {
    const { out } = runFixture();
    const dart = out.find((x) => x.message.includes('Unhandled Exception'))!;
    expect(dart).toMatchObject({ kind: 'crash', level: 'error', tag: 'flutter', pid: 4400 });
    expect(dart.message).toContain('Ödeme başarısız');
    expect(dart.message.split('\n')).toHaveLength(4);
    const another = out.find((x) => x.message.startsWith('Another exception was thrown'))!;
    expect(another).toMatchObject({ kind: 'flutter-error', level: 'error' });
  });

  it('reports process start/death events in order', () => {
    const { events } = runFixture();
    expect(events.map((e) => [e.event, e.pid, e.name])).toEqual([
      ['started', 4321, 'com.mykynk.pati'],
      ['died', 4321, 'com.mykynk.pati'],
      ['died', 4400, 'com.mykynk.pati'],
    ]);
  });

  it('emits non-logcat lines as warnings instead of dropping them silently', () => {
    const out: DeviceLogInput[] = [];
    const p = new AndroidLogPipeline({ emit: (x) => out.push(x) });
    p.pushLine('logcat: Unexpected EOF!');
    expect(out[0]).toMatchObject({ level: 'warn', tag: 'logcat', message: 'logcat: Unexpected EOF!' });
  });
});

describe('AndroidLogPipeline throughput', () => {
  it('handles well over 1000 lines/s', () => {
    vi.useRealTimers();
    let n = 0;
    const p = new AndroidLogPipeline({ emit: () => (n += 1), processName: () => 'com.x' });
    const tags = ['ActivityManager', 'chatty', 'flutter', 'OpenGLRenderer', 'ViewRootImpl', 'AndroidRuntime'];
    const lines: string[] = [];
    for (let i = 0; i < 30_000; i += 1) {
      const ts = (1793608981000 + i).toString();
      lines.push(
        `         ${ts.slice(0, 10)}.${ts.slice(10)}  ${1000 + (i % 40)}  ${1000 + (i % 40)} ${'VDIWE'[i % 5]} ${tags[i % tags.length]}: line ${i} lorem ipsum dolor sit amet`,
      );
    }
    const start = performance.now();
    for (const l of lines) p.pushLine(l);
    p.flush();
    const ms = performance.now() - start;
    expect(n).toBeGreaterThan(25_000);
    // 30k lines must take far less than the 30 s they represent at 1000 lines/s.
    expect(ms).toBeLessThan(3000);
  });
});
