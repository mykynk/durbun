import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { appendQueryTerm, compileLogQuery, parseLogQuery, queryHighlightRanges, queryMinLevel, queryTerm, queryUsesApps } from './index';
import { ALL, APPS, FX, NOW, entry } from './fixtures.test-data';

type FxName = keyof typeof FX;
const NAMES = Object.keys(FX) as FxName[];

function compile(q: string, apps = APPS) {
  return compileLogQuery(parseLogQuery(q), { now: NOW, apps });
}
/** Names of the fixtures matching `q`. */
function matches(q: string, apps = APPS): FxName[] {
  const c = compile(q, apps);
  return NAMES.filter((n) => c.test(FX[n]));
}

describe('free text and phrases', () => {
  it('matches message, tag or process (case-insensitive)', () => {
    expect(matches('reset')).toEqual(['okhttp', 'dioError']);
    expect(matches('CHATTY')).toEqual(['chatty']); // tag
    expect(matches('system_server')).toEqual(['anr', 'chatty']); // process
    expect(matches('"connection reset"')).toEqual(['okhttp', 'dioError']);
    expect(matches('"Connection Reset by"')).toEqual(['dioError']);
  });

  it('also finds text inside error.message / error.stack (crash stacks)', () => {
    expect(matches('checkout_controller')).toEqual(['dartCrashSdk']);
    expect(matches('message:payment_service')).toEqual(['dartCrashSdk']);
    expect(matches('message=:payment_service')).toEqual([]);
  });

  it('folds İ like i and keeps ı distinct (Turkish)', () => {
    expect(matches('istanbul')).toEqual(['jsonLine']);
    expect(matches('İSTANBUL')).toEqual(['jsonLine']);
    expect(matches('giriş')).toEqual(['dataLine']);
    expect(matches('GİRİŞ')).toEqual(['dataLine']);
    expect(matches('kullanici')).toEqual([]); // ı ≠ i
    expect(matches('kullanıcı')).toEqual(['dataLine']);
  });

  it('special characters are literal', () => {
    expect(matches('"(0,0,1080,2400)"')).toEqual(['verbose']);
    expect(matches('page=2')).toEqual(['networkRow']);
    expect(matches('https://api.pati.app/v1/pets')).toEqual(['networkRow']);
    expect(matches('.*')).toEqual([]);
  });
});

describe('keys × operators', () => {
  it('tag', () => {
    expect(matches('tag:ok')).toEqual(['okhttp']);
    expect(matches('tag=:okhttp')).toEqual(['okhttp']);
    expect(matches('tag=:ok')).toEqual([]);
    expect(matches('tag~:^(dio|okhttp)$')).toEqual(['okhttp', 'dioError']);
    expect(matches('-tag:chatty').includes('chatty')).toBe(false);
    expect(matches('tag=:""')).toEqual([]);
  });

  it('message', () => {
    expect(matches('message:"no local endpoint"')).toEqual(['iosFault']);
    expect(matches('msg=:purchase')).toEqual(['event']);
    expect(matches('message~:"time(d )?out|skipped \\d+ frames"')).toEqual(['anr', 'old']);
    expect(matches('message~:time(d )?out')).toEqual(['anr']); // whitespace inside a regex group
  });

  it('process / package', () => {
    expect(matches('process:mahalle')).toEqual(['androidCrash', 'okhttp']);
    expect(matches('package=:runner')).toEqual(['iosFault', 'deviceLineRunner', 'deviceLineRunnerOtherDevice']);
    expect(matches('process~:\\.pati(:|$)')).toEqual(['flutterBox', 'deviceLinePati', 'deviceLinePatiSub', 'verbose', 'old']);
  });

  it('pid', () => {
    expect(matches('pid:5120')).toEqual(['androidCrash', 'okhttp']);
    expect(matches('pid=:1043')).toEqual(['anr', 'chatty']);
    expect(matches('pid~:^8')).toEqual(['iosFault', 'kasaLine']);
    expect(matches('-pid:4123')).not.toContain('flutterBox');
  });

  it('level ≥ and level =', () => {
    expect(matches('level:error')).toEqual(['androidCrash', 'anr', 'iosFault', 'flutterBox', 'dartCrashSdk', 'dioError']);
    expect(matches('level:f')).toEqual(['androidCrash', 'dartCrashSdk']);
    expect(matches('level=:warn')).toEqual(['okhttp', 'old']);
    expect(matches('level:v')).toEqual(NAMES);
    expect(compile('level:verbose').matchesAll).toBe(true);
    expect(matches('-level:debug')).toEqual(['verbose']);
  });

  it('source', () => {
    expect(matches('source:system')).toEqual(['marker', 'processStarted']);
    expect(matches('source:sdk')).toEqual(['dartCrashSdk', 'jsonLine', 'dataLine', 'networkRow', 'event', 'dioError']);
    expect(matches('source:device').length).toBe(ALL.filter((e) => e.source === 'device').length);
  });

  it('age uses ctx.now and reports hasAge', () => {
    expect(matches('age:5m')).not.toContain('chatty'); // 10 min old
    expect(matches('age:15m')).toContain('chatty');
    expect(matches('-age:1h')).toEqual(['old']);
    expect(compile('age:5m').hasAge).toBe(true);
    expect(compile('tag:a | -age:5m').hasAge).toBe(true);
    expect(compile('tag:a').hasAge).toBe(false);
    const later = compileLogQuery(parseLogQuery('age:5m'), { now: NOW + 3_600_000, apps: APPS });
    expect(later.test(FX.okhttp)).toBe(false);
  });
});

describe('is:', () => {
  it('crash / anr / network / event / marker by kind', () => {
    expect(matches('is:crash')).toEqual(['androidCrash', 'dartCrashSdk']);
    expect(matches('is:anr')).toEqual(['anr']);
    expect(matches('is:crash | is:anr')).toEqual(['androidCrash', 'anr', 'dartCrashSdk']);
    expect(matches('is:network')).toEqual(['networkRow']);
    expect(matches('is:event')).toEqual(['event']);
    expect(matches('is:marker')).toEqual(['marker']);
  });

  it('error = level ≥ error (iOS fault is error, not fatal)', () => {
    expect(matches('is:error')).toEqual(matches('level:error'));
    expect(matches('is:error')).toContain('iosFault');
  });

  it('json = payload in the message or object/array data', () => {
    expect(matches('is:json')).toEqual(['jsonLine', 'dataLine', 'event']);
    expect(compile('is:json').test(entry({ message: 'Bundle[{id=1, name=x}] [main] [ 1234.5678] {}' }))).toBe(false);
    expect(compile('is:json').test(entry({ message: 'ok', data: [1, 2] }))).toBe(true);
    expect(compile('is:json').test(entry({ message: 'ok', data: 'text' }))).toBe(false);
  });

  it('stacktrace = error.stack or ≥ 2 frame lines', () => {
    expect(matches('is:stacktrace')).toEqual(['androidCrash', 'dartCrashSdk']);
  });

  it('flutter = flutter-error kind, tag flutter or a Flutter app session', () => {
    expect(matches('is:flutter')).toEqual(['flutterBox', 'dartCrashSdk', 'jsonLine', 'networkRow', 'event', 'dioError', 'deviceLinePati']);
    expect(compile('is:flutter').test(entry({ tag: 'Flutter', message: 'x' }))).toBe(true);
    const vm = { ...APPS, 'app:9': { ...APPS['app:2']!, id: 'app:9', sdk: { name: 'durbun-vm-service', version: '1', platform: 'dart-vm' as const } } };
    expect(compileLogQuery(parseLogQuery('is:flutter'), { now: NOW, apps: vm }).test(entry({ appId: 'app:9', source: 'app', message: 'x' }))).toBe(true);
  });
});

describe('app:', () => {
  it('matches sessions by name, bundle id or session id and their device lines', () => {
    // Mahalle: its SDK line (app:2) + device lines of process com.mykynk.mahalle on demo:1.
    expect(matches('app:Mahalle')).toEqual(['androidCrash', 'dataLine', 'okhttp']);
    // Pati: SDK lines (app:1/app:3) + device lines whose process is the bundle id (+ sub-process) on that
    // device + the process.started system line; iOS `Runner` lines on demo:2 without an appId too.
    expect(matches('app:pati')).toEqual([
      'iosFault',
      'flutterBox',
      'dartCrashSdk',
      'jsonLine',
      'networkRow',
      'event',
      'dioError',
      'deviceLinePati',
      'deviceLinePatiSub',
      'deviceLineRunner',
      'processStarted',
      'verbose',
      'old',
    ]);
    expect(matches('app:com.mykynk.mahalle')).toEqual(['androidCrash', 'dataLine', 'okhttp']);
    expect(matches('app=:app:2')).toEqual(['androidCrash', 'dataLine', 'okhttp']);
    expect(matches('app~:^kasa$')).toEqual(['kasaLine']);
  });

  it('does not leak to other devices or to lines attributed to another app', () => {
    const pati = matches('app:pati');
    expect(pati).not.toContain('deviceLineRunnerOtherDevice'); // Runner on demo:3
    expect(pati).not.toContain('kasaLine'); // demo:2 but attributed to Kasa (appId)
    expect(pati).not.toContain('chatty'); // system_server
  });

  it('unknown app matches nothing; the query depends on apps', () => {
    expect(matches('app:Nope')).toEqual([]);
    expect(queryUsesApps(parseLogQuery('app:Pati level:e'))).toBe(true);
    expect(queryUsesApps(parseLogQuery('is:flutter'))).toBe(true);
    expect(queryUsesApps(parseLogQuery('tag:x'))).toBe(false);
    expect(matches('app:pati', {})).toEqual([]);
  });
});

describe('combinations from the cheat sheet', () => {
  it.each<[string, FxName[]]>([
    ['level:error tag:dio', ['dioError']],
    ['-tag:chatty age:5m', NAMES.filter((n) => n !== 'chatty' && n !== 'old')],
    ['app:Pati "connection reset"', ['dioError']],
    ['(tag:okhttp | tag:dio) level:warn', ['okhttp', 'dioError']],
    ['is:json source:app', ['jsonLine', 'dataLine', 'event']],
    ['is:flutter is:stacktrace', ['dartCrashSdk']],
    ['-(is:crash | is:anr) level:fatal', []],
    ['reset -dio', ['okhttp']],
  ])('%s', (q, expected) => {
    expect(matches(q)).toEqual(expected);
  });
});

describe('compiled metadata', () => {
  it('matchesAll for empty, invalid-only and tautological queries', () => {
    for (const q of ['', '  ', 'level:', '(', 'level:verbose', '-(-level:v)', 'tag:""']) expect(compile(q).matchesAll).toBe(true);
    expect(compile('tag:a').matchesAll).toBe(false);
    const never = compile('-level:verbose');
    expect(never.matchesAll).toBe(false);
    expect(ALL.some((e) => never.test(e))).toBe(false);
  });

  it('keeps filtering on the valid part while typing', () => {
    expect(matches('tag:dio level:er')).toEqual(['dioError']); // `level:er` is dropped, not "match nothing"
    expect(matches('tag:dio | level:')).toEqual(['dioError']);
  });

  it('highlights: positive free text + message terms only', () => {
    const c = compile('Reset message:Peer -tag:x -hidden "Connection Reset" message~:time(d )?out (a | -b) level:e');
    const strings = c.highlights.filter((h) => typeof h === 'string');
    expect(strings).toEqual(['reset', 'peer', 'connection reset', 'a']);
    const regexes = c.highlights.filter((h): h is RegExp => h instanceof RegExp);
    expect(regexes.map((r) => r.source)).toEqual(['time(d )?out']);
    expect(regexes[0]!.flags).toContain('g');
    expect(regexes[0]!.flags).toContain('i');
  });

  it('queryHighlightRanges merges, respects İ and regexes', () => {
    expect(queryHighlightRanges('Connection reset by peer', ['reset', 'connection reset'])).toEqual([[0, 16]]);
    expect(queryHighlightRanges('İstanbul, ISTANBUL', ['istanbul'])).toEqual([
      [0, 8],
      [10, 18],
    ]);
    expect(queryHighlightRanges('timed out, timeout', [/time(d )?out/gi])).toEqual([
      [0, 9],
      [11, 18],
    ]);
    expect(queryHighlightRanges('aaa', [/x*/gi])).toEqual([]);
  });

  it('queryMinLevel', () => {
    const min = (q: string) => queryMinLevel(parseLogQuery(q));
    expect(min('level:warn tag:x')).toBe('warn');
    expect(min('tag:x (level:info level:error)')).toBe('error');
    expect(min('level:warn | level:error')).toBe('warn');
    expect(min('level:warn | tag:x')).toBeUndefined();
    expect(min('-level:warn')).toBeUndefined();
    expect(min('is:error')).toBe('error');
    expect(min('level:verbose')).toBeUndefined();
    expect(min('')).toBeUndefined();
  });

  it('never throws on odd contexts and stub ASTs', () => {
    const p = parseLogQuery('app:x is:flutter age:5m');
    expect(() => compileLogQuery(p, { now: Number.NaN, apps: undefined as never }).test(FX.event)).not.toThrow();
    const stubLike = { source: 'reset', tokens: [], empty: false, ast: 'reset' };
    expect(compileLogQuery(stubLike, { now: NOW, apps: APPS }).test(FX.okhttp)).toBe(true);
    const odd = { id: 1, ts: NOW, deviceId: 'x', source: 'device', level: 'info' } as unknown as LogEntry;
    expect(() => compile('reset tag:x process:y is:json is:stacktrace is:flutter').test(odd)).not.toThrow();
  });
});

describe('click-filter helpers', () => {
  it('queryTerm quotes only when needed', () => {
    expect(queryTerm('tag', 'OkHttp')).toBe('tag:OkHttp');
    expect(queryTerm('tag', 'my tag', { op: '=:' })).toBe('tag=:"my tag"');
    expect(queryTerm('tag', 'chatty', { negate: true })).toBe('-tag:chatty');
    expect(queryTerm('message', 'onCreate()')).toBe('message:onCreate()');
    expect(queryTerm('message', 'a|b', { op: '~:' })).toBe('message~:a|b');
    expect(queryTerm('message', 'a|b')).toBe('message:"a|b"');
    expect(queryTerm('pid', 4123)).toBe('pid:4123');
    expect(queryTerm('tag', '')).toBe('tag:""');
    for (const v of ['my tag', 'a"b', 'x)', '(y', 'z|w', 'back\\slash']) {
      const p = parseLogQuery(queryTerm('tag', v, { op: '=:' }));
      expect(p.error).toBeUndefined();
      expect(compileLogQuery(p, { now: NOW, apps: {} }).test(entry({ tag: v, message: '' }))).toBe(true);
    }
  });

  it('appendQueryTerm ANDs, dedupes, flips and protects OR', () => {
    expect(appendQueryTerm('', 'tag:a')).toBe('tag:a');
    expect(appendQueryTerm('level:e', 'tag:a')).toBe('level:e tag:a');
    expect(appendQueryTerm('level:e tag:a', 'tag:a')).toBe('level:e tag:a');
    expect(appendQueryTerm('level:e -tag:a', 'tag:a')).toBe('level:e tag:a');
    expect(appendQueryTerm('tag:a level:e', '-tag:a')).toBe('level:e -tag:a');
    expect(appendQueryTerm('tag:a | tag:b', 'level:e')).toBe('(tag:a | tag:b) level:e');
    expect(appendQueryTerm('(tag:a | tag:b) x', '-(tag:a | tag:b)')).toBe('x -(tag:a | tag:b)');
    expect(appendQueryTerm('x -"a b"', '"a b"')).toBe('x "a b"');
  });
});
