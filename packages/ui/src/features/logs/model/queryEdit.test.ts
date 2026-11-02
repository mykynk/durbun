import { describe, expect, it } from 'vitest';
import { PRESETS, makeTerm, normalizeQuery, pushHistory, quoteValue, sanitizeSavedFilters, splitTerms, toggleTerm } from './queryEdit';
import { buildHighlighter, highlightSegments } from './highlight';
import { dedupeHash, dedupeText, isDedupeCandidate, sameDedupeText } from './dedupe';

describe('query editing from clicks', () => {
  it('builds exact tag/process terms and quotes when needed', () => {
    expect(makeTerm('tag', 'OkHttp')).toBe('tag=:OkHttp');
    expect(makeTerm('tag', 'OkHttp', { exclude: true })).toBe('-tag=:OkHttp');
    expect(makeTerm('process', 'com.android.systemui')).toBe('process=:com.android.systemui');
    expect(makeTerm('pid', 4821)).toBe('pid:4821');
    expect(makeTerm('level', 'warn')).toBe('level:warn');
    expect(makeTerm('is', 'crash')).toBe('is:crash');
    expect(makeTerm('tag', 'My Tag')).toBe('tag=:"My Tag"');
    expect(quoteValue('a"b')).toBe('"a\\"b"');
  });

  it('splits terms respecting quotes and parentheses', () => {
    expect(splitTerms('tag:a  "two words" (x | y) -level:info')).toEqual(['tag:a', '"two words"', '(x | y)', '-level:info']);
  });

  it('toggles terms: add, remove on second click, replace the negation', () => {
    expect(toggleTerm('', 'tag=:A')).toBe('tag=:A');
    expect(toggleTerm('level:warn', 'tag=:A')).toBe('level:warn tag=:A');
    expect(toggleTerm('level:warn tag=:A', 'tag=:A')).toBe('level:warn');
    expect(toggleTerm('tag=:A', '-tag=:A')).toBe('-tag=:A');
    expect(toggleTerm('is:crash | is:anr', 'tag=:A')).toBe('(is:crash | is:anr) tag=:A');
  });

  it('normalizes whitespace and keeps a deduplicated history', () => {
    expect(normalizeQuery('  tag:a   level:warn ')).toBe('tag:a level:warn');
    expect(pushHistory(['b', 'a'], ' a ')).toEqual(['a', 'b']);
    expect(pushHistory(['a'], '   ')).toEqual(['a']);
    expect(pushHistory(Array.from({ length: 40 }, (_, i) => `q${i}`), 'new')).toHaveLength(30);
  });

  it('has the built-in presets from the brief', () => {
    expect(PRESETS.map((p) => p.query)).toEqual(['level:error', 'is:crash | is:anr | (tag=:flutter level:error)', 'is:network', 'is:flutter', 'is:event']);
  });

  it('sanitizes persisted saved filters', () => {
    expect(sanitizeSavedFilters('nope')).toEqual([]);
    const out = sanitizeSavedFilters([{ id: 'a', name: 'Auth', query: 'tag:auth' }, { name: 'no id', query: 'x' }, { bad: true }, null]);
    expect(out).toHaveLength(2);
    expect(out[1]!.id).toMatch(/^f/);
  });
});

describe('highlighting', () => {
  it('marks search terms (case-insensitive) and user rules with their color', () => {
    const h = buildHighlighter(['token'], [{ pattern: 'HTTP \\d{3}', regex: true, caseSensitive: true, color: 'red', enabled: true }]);
    const segs = highlightSegments('Token yenilendi · HTTP 401 · token', h);
    expect(segs).toEqual([
      { text: 'Token', search: true },
      { text: ' yenilendi · ' },
      { text: 'HTTP 401', color: 'red' },
      { text: ' · ' },
      { text: 'token', search: true },
    ]);
  });

  it('lets earlier rules win overlaps and ignores invalid or disabled rules', () => {
    const h = buildHighlighter(
      ['abc'],
      [
        { pattern: 'bcd', regex: false, caseSensitive: false, color: 'blue', enabled: true },
        { pattern: '(', regex: true, caseSensitive: false, color: 'red', enabled: true },
        { pattern: 'x', regex: false, caseSensitive: false, color: 'green', enabled: false },
      ],
    );
    expect(h.rules).toHaveLength(2);
    expect(highlightSegments('abcde', h)).toEqual([{ text: 'abc', search: true }, { text: 'de' }]);
  });

  it('returns the text unchanged without rules', () => {
    expect(highlightSegments('plain', buildHighlighter([], []))).toEqual([{ text: 'plain' }]);
  });
});

describe('dedupe keys', () => {
  it('strips the flutter: prefix and trailing whitespace', () => {
    expect(dedupeText('flutter: hello  ')).toBe('hello');
    expect(dedupeText('hello')).toBe('hello');
    expect(dedupeHash({ message: 'flutter: x' })).toBe(dedupeHash({ message: 'x\n' }));
    expect(dedupeHash({ message: 'x' })).not.toBe(dedupeHash({ message: 'y' }));
    expect(dedupeHash({ message: 'x' })).toBeGreaterThanOrEqual(0);
    expect(sameDedupeText('flutter: hello ', 'hello')).toBe(true);
    expect(sameDedupeText('hello', 'hellO')).toBe(false);
    // same head and tail, different middle: the hash collides on purpose, the full compare does not
    const a = `${'h'.repeat(60)}A${'t'.repeat(30)}`;
    const b = `${'h'.repeat(60)}B${'t'.repeat(30)}`;
    expect(dedupeHash({ message: a })).toBe(dedupeHash({ message: b }));
    expect(sameDedupeText(a, b)).toBe(false);
  });

  it('only considers app/device text-like entries', () => {
    expect(isDedupeCandidate({ source: 'app', message: 'x' })).toBe(true);
    expect(isDedupeCandidate({ source: 'system', message: 'x' })).toBe(false);
    expect(isDedupeCandidate({ source: 'app', kind: 'event', message: 'x' })).toBe(false);
    expect(isDedupeCandidate({ source: 'device', kind: 'network', message: 'GET /' })).toBe(false);
  });
});
