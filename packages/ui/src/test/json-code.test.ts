import { describe, expect, it } from 'vitest';
import {
  ROOT_KEY,
  childKey,
  collectContainerKeys,
  detectCodeLanguage,
  jsonPath,
  keysToDepth,
  looksLikeJson,
  prettyJson,
  previewValue,
  searchJson,
  valueToText,
} from '../lib/json';
import { highlightToHtml, markHtml, splitHtmlLines } from '../lib/highlight';
import { compileNoiseRules } from '../data/noise';
import { DEFAULT_NOISE_RULES } from '../data/stores/prefs';
import { findRanges } from '../components/Highlight';

const pets = {
  page: 2,
  items: [
    { id: 20, name: 'Karabaş', owner: { city: 'İstanbul' } },
    { id: 21, name: 'Pamuk', 'content-type': 'x' },
  ],
  ok: true,
  next: null,
};

describe('json paths and previews', () => {
  it('builds JS access paths', () => {
    expect(jsonPath(['items', 0, 'id'])).toBe('data.items[0].id');
    expect(jsonPath(['items', 1, 'content-type'], 'body')).toBe('body.items[1]["content-type"]');
    expect(jsonPath([])).toBe('data');
  });

  it('keeps numeric indices and numeric-looking keys apart', () => {
    expect(childKey(ROOT_KEY, 0)).not.toBe(childKey(ROOT_KEY, '0'));
  });

  it('previews containers compactly', () => {
    expect(previewValue(pets.items[0])).toBe('{id: 20, name: "Karabaş", owner: {…}}');
    expect(previewValue([1, 2, 3])).toBe('[1, 2, 3]');
    expect(previewValue({ long: 'x'.repeat(100) }, 30)).toContain('…');
  });

  it('copies values as text', () => {
    expect(valueToText('plain')).toBe('plain');
    expect(valueToText(42)).toBe('42');
    expect(valueToText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('pretty-prints and detects JSON', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('{oops')).toBeNull();
    expect(looksLikeJson(' [1] ')).toBe(true);
    expect(looksLikeJson('hello')).toBe(false);
  });
});

describe('json search and expansion', () => {
  it('finds keys and values case-insensitively and expands their ancestors', () => {
    const r = searchJson(pets, 'pamuk');
    expect(r.count).toBe(1);
    const match = childKey(childKey(childKey(ROOT_KEY, 'items'), 1), 'name');
    expect(r.matches.has(match)).toBe(true);
    expect(r.expand.has(ROOT_KEY)).toBe(true);
    expect(r.expand.has(childKey(ROOT_KEY, 'items'))).toBe(true);
    expect(searchJson(pets, 'city').count).toBe(1);
    expect(searchJson(pets, '').count).toBe(0);
  });

  it('bounds "expand all" for huge documents', () => {
    const huge = { list: Array.from({ length: 20_000 }, (_, i) => ({ i, tags: ['a'] })) };
    const { keys, truncated } = collectContainerKeys(huge, 5000);
    expect(truncated).toBe(true);
    expect(keys.size).toBeLessThanOrEqual(5000);
    expect(keysToDepth(pets, 1)).toEqual(new Set([ROOT_KEY]));
    expect(keysToDepth(pets, 2).has(childKey(ROOT_KEY, 'items'))).toBe(true);
  });
});

describe('code languages and highlighting', () => {
  it('detects languages from content type or content', () => {
    expect(detectCodeLanguage('application/json; charset=utf-8')).toBe('json');
    expect(detectCodeLanguage('application/problem+json')).toBe('json');
    expect(detectCodeLanguage('text/html')).toBe('html');
    expect(detectCodeLanguage('image/svg+xml')).toBe('xml');
    expect(detectCodeLanguage('application/javascript')).toBe('javascript');
    expect(detectCodeLanguage(undefined, '{"a":1}')).toBe('json');
    expect(detectCodeLanguage(undefined, '<?xml version="1.0"?><a/>')).toBe('xml');
    expect(detectCodeLanguage('text/plain', 'hello')).toBe('plain');
  });

  it('splits highlighted HTML into self-contained lines', () => {
    const html = highlightToHtml('{\n  "a": "x\\ny",\n  "b": 1\n}', 'json');
    const lines = splitHtmlLines(html);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
    // Multi-line span (comment) is closed and reopened.
    expect(splitHtmlLines('<span class="c">a\nb</span>c')).toEqual(['<span class="c">a</span>', '<span class="c">b</span>c']);
  });

  it('escapes plain text', () => {
    expect(highlightToHtml('<b>&"', 'plain')).toBe('&lt;b&gt;&amp;&quot;');
  });

  it('marks text ranges across tags and entities', () => {
    const html = '<span class="s">&quot;Karabaş&quot;</span>, ok';
    // plain text: "Karabaş", ok  → mark 'Kara' (1..5) and 'ok' (11..13)
    const out = markHtml(html, [
      { start: 1, end: 5, current: true },
      { start: 11, end: 13 },
    ]);
    expect(out).toBe('<span class="s">&quot;<mark class="hl hl--current">Kara</mark>baş&quot;</span>, <mark class="hl">ok</mark>');
    // A mark spanning a tag boundary is split, never mis-nested.
    const spanning = markHtml('<span>ab</span>cd', [{ start: 1, end: 3 }]);
    expect(spanning).toBe('<span>a<mark class="hl">b</mark></span><mark class="hl">c</mark>d');
  });

  it('finds highlight ranges with plain toLowerCase', () => {
    expect(findRanges('GET /v1/pets?page=2 → 200', 'pets')).toEqual([[8, 12]]);
    expect(findRanges('aaa', 'a')).toHaveLength(3);
    expect(findRanges('anything', '')).toEqual([]);
  });
});

describe('noise rules', () => {
  const isNoise = compileNoiseRules(DEFAULT_NOISE_RULES);
  const dev = (tag: string, extra: Record<string, unknown> = {}) => ({ source: 'device' as const, tag, message: 'x', ...extra });

  it('hides known-noisy system tags (exact and prefix rules)', () => {
    expect(isNoise(dev('chatty'))).toBe(true);
    expect(isNoise(dev('OpenGLRenderer'))).toBe(true);
    expect(isNoise(dev('ViewRootImpl@a1b2c3[MainActivity]'))).toBe(true);
    expect(isNoise(dev('com.apple.UIKit'))).toBe(true);
    expect(isNoise(dev('flutter'))).toBe(false);
    expect(isNoise(dev('AndroidRuntime'))).toBe(false);
  });

  it('never hides app or system lines, and respects disabled rules', () => {
    expect(isNoise({ source: 'app', tag: 'chatty', message: 'x' })).toBe(false);
    const custom = compileNoiseRules([
      { id: '1', field: 'message', match: 'contains', value: 'BufferQueue', enabled: true },
      { id: '2', field: 'process', match: 'exact', value: 'system_server', enabled: false },
    ]);
    expect(custom(dev('X', { message: 'acquireNextBufferLocked BufferQueue size' }))).toBe(true);
    expect(custom(dev('X', { process: 'system_server' }))).toBe(false);
    expect(compileNoiseRules([])(dev('chatty'))).toBe(false);
  });
});
