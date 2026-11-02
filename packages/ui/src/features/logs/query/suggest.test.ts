import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../../i18n';
import { parseLogQuery, suggestLogQuery, type QuerySuggestData, type QuerySuggestion } from './index';
import { suggestContext } from './suggest';

const DATA: QuerySuggestData = {
  tags: ['flutter', 'OkHttp', 'chatty', 'ActivityManager', 'dio', 'DioClient', 'my tag', 'ViewRootImpl'],
  processes: ['com.mykynk.pati', 'system_server', 'com.mykynk.mahalle', 'Runner'],
  apps: [
    { id: 'app:1', name: 'Pati', bundleId: 'com.mykynk.pati' },
    { id: 'app:3', name: 'Pati', bundleId: 'com.mykynk.pati' },
    { id: 'app:2', name: 'Mahalle', bundleId: 'com.mykynk.mahalle' },
  ],
  history: ['level:error tag:dio', 'is:crash | is:anr', 'level:error tag:dio', '  ', '-tag:chatty age:5m'],
};

/** Suggestions with the cursor at the caret mark (or at the end). */
function at(q: string, data: QuerySuggestData = DATA): QuerySuggestion[] {
  const i = q.indexOf('‸');
  const source = i >= 0 ? q.slice(0, i) + q.slice(i + 1) : q;
  return suggestLogQuery(source, i >= 0 ? i : source.length, data);
}
const labels = (q: string, data?: QuerySuggestData) => at(q, data).map((s) => s.label);
/** Applies a suggestion the way the input does. */
function apply(source: string, s: QuerySuggestion): string {
  return source.slice(0, s.from) + s.insert + source.slice(s.to);
}

afterEach(() => setLanguage('en'));

describe('history', () => {
  it('empty field → recent queries (deduped, trimmed), replacing everything', () => {
    const s = suggestLogQuery('', 0, DATA);
    expect(s.map((x) => x.label)).toEqual(['level:error tag:dio', 'is:crash | is:anr', '-tag:chatty age:5m']);
    expect(s.every((x) => x.kind === 'history' && x.from === 0 && x.to === 0 && !x.preselect)).toBe(true);
    const ws = suggestLogQuery('   ', 3, DATA);
    expect(ws[0]).toMatchObject({ from: 0, to: 3, insert: 'level:error tag:dio' });
  });

  it('caps at 12 and survives missing data', () => {
    const history = Array.from({ length: 40 }, (_, i) => `tag:t${i}`);
    expect(suggestLogQuery('', 0, { ...DATA, history })).toHaveLength(12);
    expect(suggestLogQuery('', 0, {} as QuerySuggestData)).toEqual([]);
    expect(suggestLogQuery('tag:', 4, null as unknown as QuerySuggestData)).toEqual([]);
  });
});

describe('keys', () => {
  it('bare word → keys by prefix with localized details', () => {
    const s = at('le');
    expect(s[0]).toMatchObject({ label: 'level:', insert: 'level:', from: 0, to: 2, kind: 'key', key: 'level', preselect: true, detail: 'This level and above' });
    expect(labels('p')).toEqual(['process:', 'pid:']);
    expect(labels('pa')).toEqual(['package:']);
    expect(labels('ms')).toEqual(['msg:']);
    expect(labels('level')).toEqual(['level:']);
  });

  it('Turkish details', () => {
    setLanguage('tr');
    expect(at('le')[0]!.detail).toBe('Bu seviye ve üstü');
    expect(at('pa')[0]!.detail).toBe('Süreç adı içerir · process: ile aynı');
    expect(at('is:cr')[0]!.detail).toBe('Çökmeler');
  });

  it('after a space, "(" or "-" → every key at the cursor', () => {
    expect(labels('tag:a ')).toEqual(['level:', 'tag:', 'message:', 'process:', 'app:', 'is:', 'source:', 'age:', 'pid:']);
    const neg = at('-');
    expect(neg).toHaveLength(9);
    expect(neg[0]).toMatchObject({ from: 1, to: 1 });
    expect(at('(')[0]).toMatchObject({ from: 1, to: 1, label: 'level:' });
  });

  it('negated word keeps the "-"', () => {
    const s = at('-ta')[0]!;
    expect(s).toMatchObject({ label: 'tag:', from: 1, to: 3 });
    expect(apply('-ta', s)).toBe('-tag:');
  });

  it('typing a key before ":" (with typo correction)', () => {
    const s = at('lvl‸:warn');
    expect(s.map((x) => x.label)).toEqual(['level:']);
    expect(apply('lvl:warn', s[0]!)).toBe('level:warn');
    expect(labels('lev‸el:warn')).toEqual([]); // already exactly `level`
    expect(at('ta‸=:x')[0]).toMatchObject({ label: 'tag=:', insert: 'tag=:', from: 0, to: 4 });
  });
});

describe('values', () => {
  it('level: all levels, aliases, exact operator', () => {
    const all = at('level:');
    expect(all.map((s) => s.label)).toEqual(['verbose', 'debug', 'info', 'warn', 'error', 'fatal']);
    expect(all[0]).toMatchObject({ kind: 'value', key: 'level', preselect: true, from: 6, to: 6, insert: 'verbose ' });
    expect(all[3]!.detail).toBe('Warnings and errors');
    expect(labels('level:e')).toEqual(['error']);
    expect(labels('level:w')).toEqual(['warn']);
    expect(labels('level:a')).toEqual(['fatal']);
    expect(labels('level:warni')).toEqual(['warn']);
    expect(labels('level:error')).toEqual([]); // complete: Enter submits
    expect(at('level=:')[0]!.detail).toBe('This level only');
  });

  it('is:, source:, age:', () => {
    expect(labels('is:')).toEqual(['crash', 'anr', 'error', 'json', 'network', 'event', 'marker', 'stacktrace', 'flutter']);
    expect(labels('is:s')).toEqual(['stacktrace']);
    expect(at('is:fl')[0]).toMatchObject({ label: 'flutter', detail: 'Flutter errors and logs', preselect: true });
    expect(labels('source:')).toEqual(['device', 'app', 'system']);
    expect(labels('source:sd')).toEqual(['app']);
    expect(labels('age:')).toEqual(['30s', '1m', '5m', '15m', '1h']);
    expect(at('age:')[2]!.detail).toBe('Last 5 minutes');
    expect(labels('age:1')).toEqual(['1s', '1m', '1h', '1d']);
    expect(at('age:1')[1]!.detail).toBe('Last 1 minute');
    expect(labels('age:5m')).toEqual([]);
    setLanguage('tr');
    expect(at('age:')[4]!.detail).toBe('Son 1 saat');
  });

  it('tag: prefix matches first, then contains, in frequency order', () => {
    expect(labels('tag:')).toEqual(DATA.tags);
    expect(at('tag:')[0]!.preselect).toBe(true);
    expect(labels('tag:d')).toEqual(['dio', 'DioClient']);
    expect(labels('tag:o')).toEqual(['OkHttp', 'dio', 'DioClient', 'ViewRootImpl']);
    expect(at('tag:o')[0]!.preselect).toBe(false); // the user may have typed a complete value
    expect(labels('tag:dio')).toEqual(['DioClient']); // exact match dropped
    expect(labels('tag~:o')).toEqual([]); // no completion for regexes
  });

  it('quotes values that need it and handles a quoted prefix', () => {
    const my = at('tag:my')[0]!;
    expect(my).toMatchObject({ label: 'my tag', insert: '"my tag" ', from: 4, to: 6 });
    expect(apply('tag:my', my)).toBe('tag:"my tag" ');
    expect(parseLogQuery(apply('tag:my', my)).error).toBeUndefined();
    const quoted = at('tag:"Ok')[0]!;
    expect(quoted).toMatchObject({ label: 'OkHttp', insert: '"OkHttp" ', from: 4, to: 7 });
    expect(at('tag:"Ok"')[0]).toMatchObject({ label: 'OkHttp', from: 4, to: 8 });
  });

  it('replaces the whole value when the cursor is inside it (no trailing space mid-query)', () => {
    const s = at('tag:Ok‸Ht level:e')[0]!;
    expect(s).toMatchObject({ label: 'OkHttp', from: 4, to: 8, insert: 'OkHttp' });
    expect(apply('tag:OkHt level:e', s)).toBe('tag:OkHttp level:e');
  });

  it('process: and app:', () => {
    expect(labels('process:pati')).toEqual(['com.mykynk.pati']);
    expect(labels('process:pa')).toEqual(['com.mykynk.pati', 'com.mykynk.mahalle']); // contains pa
    expect(labels('package:sys')).toEqual(['system_server']);
    expect(at('app:')).toMatchObject([
      { label: 'Pati', detail: 'com.mykynk.pati' },
      { label: 'Mahalle', detail: 'com.mykynk.mahalle' },
    ]);
    expect(at('app:com.mykynk.m')[0]).toMatchObject({ label: 'com.mykynk.mahalle', detail: 'Mahalle' });
    expect(labels('app:hal')).toEqual(['Mahalle']);
  });

  it('message:, pid:, unknown keys and phrases have no completions', () => {
    expect(at('message:x')).toEqual([]);
    expect(at('pid:4')).toEqual([]);
    expect(at('foo:bar')).toEqual([]);
    expect(at('"conn')).toEqual([]);
  });

  it('caps the list at 12', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    expect(at('tag:', { ...DATA, tags })).toHaveLength(12);
    expect(at('ta', { ...DATA, tags }).length).toBeLessThanOrEqual(12);
  });
});

describe('shortcuts while typing free text', () => {
  it('suggests full terms without preselecting them', () => {
    const cra = at('cra');
    expect(cra.map((s) => s.label)).toEqual(['is:crash']);
    expect(cra[0]).toMatchObject({ insert: 'is:crash ', from: 0, to: 3, preselect: false, key: 'is' });
    expect(labels('okh')).toEqual(['tag:OkHttp']);
    expect(labels('err')).toEqual(['is:error']);
    expect(labels('warn')).toEqual(['level:warn']);
    expect(labels('mah')).toEqual(['process:com.mykynk.mahalle', 'app:Mahalle']);
    expect(labels('runn')).toEqual(['process:Runner']);
    expect(labels('acti')).toEqual(['tag:ActivityManager']);
    expect(labels('cr')).toEqual(['is:crash']); // is: kinds from 2 characters
    expect(labels('pa')).toEqual(['package:']); // data shortcuts only from 3 characters
  });

  it('keys come first and are preselected', () => {
    const s = at('ta');
    expect(s[0]).toMatchObject({ label: 'tag:', preselect: true });
    expect(labels('a')).toEqual(['app:', 'age:']); // one letter: keys only
  });

  it('ranges in the middle of a query', () => {
    const q = 'level:e cra tag:x';
    const s = suggestLogQuery(q, 11, DATA)[0]!;
    expect(s).toMatchObject({ label: 'is:crash', from: 8, to: 11, insert: 'is:crash' });
    expect(apply(q, s)).toBe('level:e is:crash tag:x');
  });
});

describe('suggestContext', () => {
  it('describes the cursor position', () => {
    expect(suggestContext('', 0)).toEqual({ kind: 'history' });
    expect(suggestContext('tag:ok level:e', 6)).toMatchObject({ kind: 'value', key: 'tag', prefix: 'ok', from: 4, to: 6 });
    expect(suggestContext('tag:ok level:e', 7)).toEqual({ kind: 'empty', from: 7, to: 7 });
    expect(suggestContext('tag:ok level:e', 9)).toMatchObject({ kind: 'key', prefix: 'le', from: 7, to: 13 });
    expect(suggestContext('a "b c', 5)).toEqual({ kind: 'none' });
    expect(suggestContext('word', 99)).toMatchObject({ kind: 'word', prefix: 'word' });
    expect(suggestContext('word', -5)).toEqual({ kind: 'empty', from: 0, to: 0 });
  });
});
