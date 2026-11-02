import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { messageKeys, translate } from '../../i18n/core';
import '../../i18n/foundation';
import '../../i18n/codes';
import './i18n';
import '../mocks/i18n';
import { COLUMNS } from './model/columns';
import { STATUS_CLASSES, TYPE_CATEGORIES } from './model/filters';
import { COPY_FORMATS } from './model/copyAs';
import { TIMING_PHASES } from './model/waterfall';
import { MATCH_TYPES, FAIL_ERRORS, ACTION_TYPES } from '../mocks/model/rules';

const ROOTS = [join(__dirname), join(__dirname, '../mocks')];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const tr = new Set(messageKeys('tr'));
const en = new Set(messageKeys('en'));
const OWN = /^(network|mocks)\./;

describe('network + mocks dictionaries', () => {
  it('every literal t() key used in the two features exists in Turkish and English', () => {
    const keys = new Set<string>();
    for (const root of ROOTS) {
      for (const f of walk(root)) {
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(/\bt\(\s*'((?:network|mocks|common|shell|code)\.[A-Za-z0-9_.-]+)'/g)) keys.add(m[1]!);
      }
    }
    expect(keys.size).toBeGreaterThan(250);
    expect([...keys].filter((k) => !tr.has(k) || !en.has(k))).toEqual([]);
  });

  it('Turkish and English define the same keys', () => {
    const own = (s: Set<string>) => [...s].filter((k) => OWN.test(k));
    expect(own(tr).filter((k) => !en.has(k))).toEqual([]);
    expect(own(en).filter((k) => !tr.has(k))).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const families: Record<string, readonly string[]> = {
      'network.columns': COLUMNS.map((c) => c.id),
      'network.filters.typeNames': TYPE_CATEGORIES,
      'network.filters.statusHint': STATUS_CLASSES,
      'network.menu.copyAs': COPY_FORMATS,
      'network.timing.phase': ['queue', ...TIMING_PHASES],
      'network.timing.hint': ['queue', ...TIMING_PHASES],
      'network.errors': ['timeout', 'dns', 'refused', 'tls', 'reset', 'offline', 'disconnected', 'cancelled', 'generic'],
      'network.body.kinds': ['empty', 'notCaptured', 'json', 'image', 'svg', 'html', 'xml', 'javascript', 'css', 'text', 'form', 'multipart', 'binary'],
      'network.body.modes': ['preview', 'code', 'hex'],
      'network.detail.tabs': ['general', 'request', 'response', 'timing'],
      'network.sections': ['body', 'headers', 'query', 'cookies'],
      'network.compare.tabs': ['general', 'headers', 'response', 'request'],
      'mocks.match': MATCH_TYPES,
      'mocks.match.hint': MATCH_TYPES,
      'mocks.editor.urlPlaceholder': MATCH_TYPES,
      'mocks.errors': FAIL_ERRORS,
      'mocks.errorLabels': FAIL_ERRORS,
      'mocks.actions': ACTION_TYPES,
      'mocks.tester.result': ['applies', 'shadowed', 'appMismatch', 'methodMismatch', 'noMatch'],
      'mocks.validation': [
        'urlRequired',
        'urlTooLong',
        'regexInvalid',
        'containsShort',
        'globNoWildcard',
        'urlSpaces',
        'methodInvalid',
        'statusInvalid',
        'headerNameInvalid',
        'headerNameMissing',
        'base64Invalid',
        'jsonInvalid',
        'bodyIgnored',
        'delayInvalid',
        'delayTooLong',
        'delayRequired',
        'customMessage',
      ],
      'mocks.io.issues': [
        'notJson',
        'noRules',
        'notObject',
        'urlRequired',
        'matchInvalid',
        'regexInvalid',
        'methodInvalid',
        'appsInvalid',
        'actionInvalid',
        'statusInvalid',
        'headersInvalid',
        'bodyInvalid',
        'base64Invalid',
        'delayInvalid',
        'failInvalid',
      ],
    };
    const missing: string[] = [];
    for (const [prefix, ids] of Object.entries(families)) {
      for (const id of ids) {
        const key = `${prefix}.${id}`;
        if (!tr.has(key) || !en.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('formats plurals and numbers per language', () => {
    expect(translate('tr', 'network.toast.cleared', { count: 1234 })).toBe('1.234 istek temizlendi');
    expect(translate('en', 'network.toast.cleared', { count: 1 })).toBe('Cleared 1 request');
    expect(translate('tr', 'mocks.list.hits', { count: 0 })).toBe('eşleşme yok');
    expect(translate('en', 'mocks.list.hits', { count: 3 })).toBe('3 hits');
  });

  it('never relies on CSS uppercase (technical tokens are written literally)', () => {
    for (const f of [join(__dirname, 'network.css'), join(__dirname, '../mocks/mocks.css')]) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/text-transform\s*:\s*uppercase/);
    }
  });
});
