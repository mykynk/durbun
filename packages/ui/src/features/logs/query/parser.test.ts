import { describe, expect, it } from 'vitest';
import { compileLogQuery, parseLogQuery, type ParsedQuery, type QueryTokenKind } from './index';
import { astOf, astToString } from './parser';
import { APPS, NOW } from './fixtures.test-data';

const ast = (q: string) => astToString(astOf(parseLogQuery(q)));
const kinds = (q: string) => parseLogQuery(q).tokens.filter((t) => t.kind !== 'whitespace').map((t) => `${t.kind}:${t.text}`);
const errorKey = (q: string) => parseLogQuery(q).error?.messageKey?.replace('logsQuery.error.', '');

function expectCoverage(p: ParsedQuery): void {
  let pos = 0;
  for (const t of p.tokens) {
    expect(t.from).toBe(pos);
    expect(t.to).toBeGreaterThan(t.from);
    expect(t.text).toBe(p.source.slice(t.from, t.to));
    pos = t.to;
  }
  expect(pos).toBe(p.source.length);
}

describe('tokens', () => {
  const samples = [
    '',
    '   ',
    'level:error tag:dio',
    'is:crash | is:anr',
    '-tag:chatty age:5m',
    'app:Pati "connection reset"',
    '(tag:okhttp || tag:dio) -(level:verbose | source:system)',
    'message~:time(d )?out tag~:^(Ok|Dio)$ pid~:^4\\d+',
    'tag:"my tag" msg=:"say \\"hi\\"" "unclosed',
    'https://api.pati.app/v1/pets?page=2 onCreate()',
    'foo:bar ) | | -  (  ',
    'ğüşıöç İSTANBUL tag:Şehir',
    '\t level:e\n',
  ];
  it.each(samples)('cover the whole source in order: %j', (q) => {
    expectCoverage(parseLogQuery(q));
  });

  it('classifies every piece for highlighting', () => {
    expect(kinds('-tag=:OkHttp (a | "b c")')).toEqual([
      'negation:-',
      'key:tag',
      'operator:=:',
      'value:OkHttp',
      'paren:(',
      'text:a',
      'or:|',
      'phrase:"b c"',
      'paren:)',
    ]);
    expect(kinds('msg~:a|b')).toEqual(['key:msg', 'operator:~:', 'value:a|b']);
    expect(kinds('tag:a|b')).toEqual(['key:tag', 'operator::', 'value:a', 'or:|', 'text:b']);
    expect(kinds('foo:bar')).toEqual(['error:foo', 'operator::', 'value:bar']);
    expect(kinds('a ) b')).toEqual(['text:a', 'error:)', 'text:b']);
  });

  it('records the canonical key on key/operator/value tokens', () => {
    const toks = parseLogQuery('msg:x package=:y').tokens.filter((t) => t.kind !== 'whitespace');
    expect(toks.map((t) => t.key)).toEqual(['message', 'message', 'message', 'process', 'process', 'process']);
  });

  it('fuzz: never throws, tokens always cover the source, compile always works', () => {
    const alphabet = ['a', 'Z', 'ı', 'İ', ':', '=', '~', '"', '\\', '(', ')', '|', '-', ' ', 'tag', 'level', 'is', 'age', 'app', '5m', 'crash', 'e', '^', '[', ']', '*'];
    let seed = 1234567;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 1500; i++) {
      let q = '';
      const len = rnd(14);
      for (let j = 0; j < len; j++) q += alphabet[rnd(alphabet.length)];
      const p = parseLogQuery(q);
      expectCoverage(p);
      const c = compileLogQuery(p, { now: NOW, apps: APPS });
      expect(typeof c.test({ id: 1, ts: NOW, deviceId: 'demo:1', source: 'device', level: 'info', tag: 'x', message: 'y' })).toBe('boolean');
    }
  });
});

describe('grammar', () => {
  it('implicit AND, | as lower-precedence OR, parentheses', () => {
    expect(ast('a b')).toBe('(and (text "a") (text "b"))');
    expect(ast('a b | c')).toBe('(or (and (text "a") (text "b")) (text "c"))');
    expect(ast('a | b c')).toBe('(or (text "a") (and (text "b") (text "c")))');
    expect(ast('a (b | c)')).toBe('(and (text "a") (or (text "b") (text "c")))');
    expect(ast('(a)')).toBe('(text "a")');
    expect(ast('a || b')).toBe('(or (text "a") (text "b"))');
  });

  it('negation of terms, phrases and groups', () => {
    expect(ast('-tag:chatty')).toBe('(not (tag : "chatty"))');
    expect(ast('-"connection reset"')).toBe('(not (text "connection reset"))');
    expect(ast('-(a | b)')).toBe('(not (or (text "a") (text "b")))');
    expect(ast('--a')).toBe('(not (not (text "a")))');
    expect(ast('com.foo-bar')).toBe('(text "com.foo-bar")');
  });

  it('quotes and escapes', () => {
    expect(ast('"say \\"hi\\""')).toBe('(text "say \\"hi\\"")');
    expect(ast('"back\\\\slash"')).toBe('(text "back\\\\slash")');
    expect(ast('"keep \\d as is"')).toBe('(text "keep \\\\d as is")');
    expect(ast('tag:"my tag"')).toBe('(tag : "my tag")');
    expect(ast('tag=:""')).toBe('(tag =: "")');
  });

  it('regex values keep |, escapes, classes and whitespace inside closed groups', () => {
    expect(ast('message~:time(d )?out tag:a')).toBe('(and (message ~: "time(d )?out") (tag : "a"))');
    expect(ast('(message~:time(d )?out tag:a)')).toBe('(and (message ~: "time(d )?out") (tag : "a"))');
    expect(ast('tag~:[a b] x')).toBe('(and (tag ~: "[a b]") (text "x"))');
    expect(ast('tag~:a\\)b x')).toBe('(and (tag ~: "a\\\\)b") (text "x"))');
    expect(ast('tag~:ok|dio | x')).toBe('(or (tag ~: "ok|dio") (text "x"))');
    // an unclosed group stops at whitespace instead of swallowing the rest
    expect(kinds('tag~:(a b')).toEqual(['key:tag', 'operator:~:', 'value:(a', 'text:b']);
  });

  it('values keep inner parentheses and URLs are free text', () => {
    expect(ast('message:onCreate()')).toBe('(message : "oncreate()")');
    expect(ast('(tag:a)')).toBe('(tag : "a")');
    expect(ast('https://api.pati.app/v1/pets')).toBe('(text "https://api.pati.app/v1/pets")');
    expect(errorKey('https://api.pati.app/v1/pets')).toBeUndefined();
  });

  it('every key × operator', () => {
    for (const key of ['tag', 'message', 'process', 'app']) {
      expect(ast(`${key}:Ab`)).toBe(`(${key} : "ab")`);
      expect(ast(`${key}=:Ab`)).toBe(`(${key} =: "ab")`);
      expect(ast(`${key}~:^A.b$`)).toBe(`(${key} ~: "^A.b$")`);
    }
    expect(ast('msg:x')).toBe('(message : "x")');
    expect(ast('package:x')).toBe('(process : "x")');
    expect(ast('TAG:x')).toBe('(tag : "x")');
    expect(ast('pid:1234')).toBe('(pid 1234)');
    expect(ast('pid=:1234')).toBe('(pid 1234)');
    expect(ast('pid~:^12')).toBe('(pid ~: "^12")');
    expect(ast('level:warn')).toBe('(level >= warn)');
    expect(ast('level=:warn')).toBe('(level = warn)');
    expect(ast('source:sdk')).toBe('(source app)');
    expect(ast('source=:device')).toBe('(source device)');
    expect(ast('is:crash')).toBe('(is crash)');
    expect(ast('is=:JSON')).toBe('(is json)');
    expect(ast('age:5m')).toBe('(age 300000)');
    for (const bad of ['level~:x', 'source~:x', 'is~:x', 'age=:5m', 'age~:5m']) expect(errorKey(bad)).toBe('badOperator');
  });

  it('level aliases (case-insensitive)', () => {
    const cases: Record<string, string> = {
      v: 'verbose',
      verbose: 'verbose',
      d: 'debug',
      i: 'info',
      INFO: 'info',
      w: 'warn',
      warning: 'warn',
      e: 'error',
      E: 'error',
      f: 'fatal',
      a: 'fatal',
      assert: 'fatal',
      'İNFO': 'info',
    };
    for (const [alias, level] of Object.entries(cases)) expect(ast(`level:${alias}`)).toBe(`(level >= ${level})`);
  });

  it('age units', () => {
    expect(ast('age:30s')).toBe('(age 30000)');
    expect(ast('age:5m')).toBe('(age 300000)');
    expect(ast('age:2h')).toBe('(age 7200000)');
    expect(ast('age:1d')).toBe('(age 86400000)');
    expect(ast('age:1h30m')).toBe('(age 5400000)');
    expect(ast('age:1.5h')).toBe('(age 5400000)');
    expect(ast('age:5M')).toBe('(age 300000)');
    for (const bad of ['age:5', 'age:5x', 'age:m', 'age:0s', 'age:-5m', 'age:5 m']) expect(errorKey(bad)).toBe('badAge');
  });
});

describe('errors and recovery', () => {
  const cases: Array<[string, string, string]> = [
    // query, error code, best-effort AST
    ['tag:"open', 'unclosedQuote', '(tag : "open")'],
    ['"connection res', 'unclosedQuote', '(text "connection res")'],
    ['(tag:a | tag:b', 'unclosedParen', '(or (tag : "a") (tag : "b"))'],
    ['tag:a )', 'strayParen', '(tag : "a")'],
    ['tag:a ()', 'emptyGroup', '(tag : "a")'],
    ['tag:a |', 'strayOr', '(tag : "a")'],
    ['| tag:a', 'strayOr', '(tag : "a")'],
    ['tag:a | | tag:b', 'strayOr', '(or (tag : "a") (tag : "b"))'],
    ['tag:a -', 'danglingNeg', '(tag : "a")'],
    ['- tag:a', 'danglingNeg', '(tag : "a")'],
    ['tag:a ""', 'emptyPhrase', '(tag : "a")'],
    ['level: tag:a', 'missingValue', '(tag : "a")'],
    ['tag:a foo:bar', 'unknownKey', '(and (tag : "a") (text "foo:bar"))'],
    ['level:xyz tag:a', 'badLevel', '(tag : "a")'],
    ['level:wa', 'badLevel', '∅'],
    ['source:web', 'badSource', '∅'],
    ['is:crashes', 'badIs', '∅'],
    ['age:5x', 'badAge', '∅'],
    ['pid:abc', 'badPid', '∅'],
    ['tag~:( tag:a', 'badRegex', '(tag : "a")'],
    ['tag:a | level:xx', 'badLevel', '(tag : "a")'],
  ];
  it.each(cases)('%j → %s with a best-effort AST', (q, code, expected) => {
    const p = parseLogQuery(q);
    expect(p.error?.messageKey).toBe(`logsQuery.error.${code}`);
    expect(p.error!.message.length).toBeGreaterThan(0);
    expect(p.error!.from).toBeGreaterThanOrEqual(0);
    expect(p.error!.to).toBeGreaterThan(p.error!.from);
    expect(p.error!.to).toBeLessThanOrEqual(q.length);
    expect(astToString(astOf(p))).toBe(expected);
    expectCoverage(p);
  });

  it('error spans point at the offending text', () => {
    const at = (q: string) => {
      const e = parseLogQuery(q).error!;
      return q.slice(e.from, e.to);
    };
    expect(at('tag:a level:xyz')).toBe('xyz');
    expect(at('tag:a (b')).toBe('(');
    expect(at('a ) b')).toBe(')');
    expect(at('a | ')).toBe('|');
    expect(at('lvl:warn')).toBe('lvl');
    expect(at('level: x')).toBe('level:');
    expect(at('tag:"abc')).toBe('"abc');
    expect(at('age=:5m')).toBe('age=:');
  });

  it('reports every error in order and the first as `error`', () => {
    const p = parseLogQuery('level:x ) age:y');
    expect(p.errors!.map((e) => e.messageKey)).toEqual(['logsQuery.error.badLevel', 'logsQuery.error.strayParen', 'logsQuery.error.badAge']);
    expect(p.error).toBe(p.errors![0]);
    expect(p.errors![1]!.message).toBe("Unexpected ')'");
  });

  it('messages carry params and the regex detail', () => {
    const p = parseLogQuery('tag~:(abc');
    expect(p.error!.messageParams?.detail).toMatch(/Unterminated group/i);
    expect(parseLogQuery('level:xyz').error!.messageParams).toEqual({ value: 'xyz' });
    expect(parseLogQuery('Level:').error!.message).toBe('Missing value after Level:');
  });

  it('empty and whitespace queries', () => {
    for (const q of ['', '   ', '\t']) {
      const p = parseLogQuery(q);
      expect(p.empty).toBe(true);
      expect(p.error).toBeUndefined();
      expect(astOf(p)).toBeNull();
    }
    expect(parseLogQuery('level:').empty).toBe(false);
  });

  it('never throws on hostile input', () => {
    const nasty = ['\\', '"\\', '((((((((', '))))))))', '||||', '----', 'a:'.repeat(500), '"'.repeat(1001), 'tag~:[', 'x'.repeat(100_000)];
    for (const q of nasty) expect(() => parseLogQuery(q)).not.toThrow();
    // non-string input from a careless caller
    expect(parseLogQuery(undefined as unknown as string).source).toBe('');
  });
});

describe('token kinds used by the highlighter', () => {
  it('only uses the contract kinds', () => {
    const allowed = new Set<QueryTokenKind>(['key', 'operator', 'negation', 'value', 'phrase', 'text', 'or', 'paren', 'whitespace', 'error']);
    for (const t of parseLogQuery('-(tag:a | "b") foo:x ) level=:e msg~:x|y 1').tokens) expect(allowed.has(t.kind)).toBe(true);
  });
});
