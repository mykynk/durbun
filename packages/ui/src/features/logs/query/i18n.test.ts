import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_LEVELS } from '@durbun/protocol';
import { messageKeys, translate } from '../../../i18n/core';
import { parseLogQuery, queryErrorText } from './index';
import { ERROR_FALLBACKS, type QueryErrorCode } from './parser';
import { IS_VALUES, QUERY_KEYS, SOURCE_VALUES } from './syntax';
import './i18n';

const NS = /^logsQuery\./;
const here = dirname(fileURLToPath(import.meta.url));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

describe('logsQuery dictionary', () => {
  it('Turkish and English define exactly the same keys', () => {
    const tr = new Set(messageKeys('tr').filter((k) => NS.test(k)));
    const en = new Set(messageKeys('en').filter((k) => NS.test(k)));
    expect(tr.size).toBeGreaterThan(80);
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
  });

  it('every literal t(...) key in this folder exists in both languages', () => {
    const keys = new Set<string>();
    for (const f of readdirSync(here)) {
      if (!/\.(ts|tsx)$/.test(f) || f.includes('.test.')) continue;
      const text = readFileSync(join(here, f), 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'(logsQuery\.[A-Za-z0-9_.-]+)'/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(10);
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    expect([...keys].filter((k) => !tr.has(k) || !en.has(k))).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const families: Record<string, readonly string[]> = {
      'logsQuery.keys': QUERY_KEYS,
      'logsQuery.is': IS_VALUES,
      'logsQuery.levels': LOG_LEVELS,
      'logsQuery.sources': SOURCE_VALUES,
      'logsQuery.age': ['s', 'm', 'h', 'd'],
      'logsQuery.error': Object.keys(ERROR_FALLBACKS),
      'logsQuery.help.ops': ['contains', 'equals', 'regex', 'not', 'and', 'or', 'group', 'phrase'],
      'logsQuery.help.examplesText': ['errorsDio', 'crashAnr', 'quietRecent', 'patiReset', 'netWarn', 'timeoutRegex', 'jsonApp', 'flutterStack'],
      'logsQuery.hint': ['navigate', 'accept', 'close'],
    };
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const missing: string[] = [];
    for (const [prefix, ids] of Object.entries(families)) for (const id of ids) if (!tr.has(`${prefix}.${id}`) || !en.has(`${prefix}.${id}`)) missing.push(`${prefix}.${id}`);
    expect(missing).toEqual([]);
  });

  it('error messages use the same placeholders as the English fallbacks', () => {
    for (const [code, fallback] of Object.entries(ERROR_FALLBACKS) as Array<[QueryErrorCode, string]>) {
      const params = Object.fromEntries(placeholders(fallback).map((p) => [p, `«${p}»`]));
      for (const lang of ['tr', 'en'] as const) {
        const text = translate(lang, `logsQuery.error.${code}`, params);
        expect(text).not.toContain('{');
        for (const p of placeholders(fallback)) expect(text).toContain(`«${p}»`);
      }
    }
  });

  it('localizes parser errors (natural Turkish)', () => {
    expect(translate('tr', 'logsQuery.error.badLevel', { value: 'xyz' })).toBe('Bilinmeyen seviye: xyz. verbose, debug, info, warn, error ya da fatal yazın.');
    expect(translate('tr', 'logsQuery.error.missingValue', { key: 'tag' })).toBe('tag: için bir değer yazın');
    expect(queryErrorText(parseLogQuery('level:xyz').error)).toBe('Unknown level: xyz. Use verbose, debug, info, warn, error or fatal.');
    expect(queryErrorText({ message: 'Fallback', from: 0, to: 1 })).toBe('Fallback');
    expect(queryErrorText({ message: 'Fallback', messageKey: 'logsQuery.error.nope', from: 0, to: 1 })).toBe('Fallback');
    expect(queryErrorText(undefined)).toBe('');
  });

  it('Turkish texts are translated, not copied', () => {
    const same = messageKeys('tr')
      .filter((k) => NS.test(k))
      .filter((k) => translate('tr', k, { count: 2, key: 'k', op: 'o', value: 'v', detail: 'd', query: 'q' }) === translate('en', k, { count: 2, key: 'k', op: 'o', value: 'v', detail: 'd', query: 'q' }));
    // Technical level names / keys may legitimately match; everything else must differ.
    expect(same).toEqual([]);
  });

  it('no CSS uppercase transform in the stylesheet', () => {
    const css = readFileSync(join(here, 'query.css'), 'utf8');
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // tokens only, no hard-coded colors
    expect(css).not.toMatch(/rgba?\(/);
  });
});
