import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SdkCapability } from '@durbun/protocol';
import { messageKeys, translate } from '../../i18n/core';
import './i18n';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const SRC = join(__dirname, '..', '..');
const SDK_CAPABILITY_LIST: readonly SdkCapability[] = ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'];

describe('flows dictionary', () => {
  const tr = new Set(messageKeys('tr').filter((k) => k.startsWith('flows.')));
  const en = new Set(messageKeys('en').filter((k) => k.startsWith('flows.')));

  it('every literal t() key used in the UI exists in Turkish and English', () => {
    const used = new Set<string>();
    for (const f of walk(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'(flows\.[A-Za-z0-9_.-]+)'/g)) used.add(m[1]!);
      // Keys kept in tables (statusKey, template kinds).
      for (const m of text.matchAll(/'(flows\.(?:status|tpl\.kind)\.[A-Za-z]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(300);
    expect([...used].filter((k) => !tr.has(k) || !en.has(k))).toEqual([]);
  });

  it('Turkish and English define the same keys', () => {
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const families: Record<string, readonly string[]> = {
      'flows.status': ['running', 'passed', 'failed', 'skipped', 'cancelled', 'handled'],
      'flows.port': ['out', 'true', 'false', 'loop', 'done', 'error'],
      'flows.field.extractFrom': ['body', 'header', 'status', 'bodyText'],
      'flows.import.state': ['new', 'changed', 'same', 'copy', 'skipped'],
      'flows.inspector.idProblem': ['invalid', 'taken', 'reserved'],
      'flows.settings.idProblem': ['invalid', 'taken'],
      'flows.needs.sdk': SDK_CAPABILITY_LIST,
      'flows.tpl.kind': ['step', 'var', 'input', 'env', 'run', 'target', 'trigger', 'item', 'helper', 'pipe'],
    };
    const missing: string[] = [];
    for (const [prefix, names] of Object.entries(families)) for (const n of names) if (!tr.has(`${prefix}.${n}`) || !en.has(`${prefix}.${n}`)) missing.push(`${prefix}.${n}`);
    expect(missing).toEqual([]);
  });

  it('messages never contain template braces (the interpolation would eat them)', () => {
    const bad: string[] = [];
    for (const lang of ['tr', 'en'] as const) {
      for (const k of lang === 'tr' ? tr : en) {
        const text = translate(lang, k, { count: 2, n: 2, passed: 1, total: 2 });
        if (text.includes('{{') || text.includes('}}')) bad.push(`${lang}:${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('plural messages read naturally', () => {
    expect(translate('en', 'flows.list.steps', { count: 1 })).toBe('1 step');
    expect(translate('en', 'flows.list.steps', { count: 3 })).toBe('3 steps');
    expect(translate('tr', 'flows.list.steps', { count: 3 })).toBe('3 adım');
    expect(translate('tr', 'flows.runPanel.counts', { passed: 4, total: 5 })).toBe('4/5 adım geçti');
    expect(translate('en', 'flows.inspector.idHint', { example: '{{login.body}}' })).toContain('{{login.body}}');
  });
});

describe('issue and step texts', () => {
  const nodes = [{ id: 'req', type: 'http.request' }];
  it('names the field by its label, also inside a preflight issue', async () => {
    const { issueText } = await import('./model/text');
    const required = { code: 'flow.param.required', message: 'url is required', nodeId: 'req', params: { param: 'url' } };
    expect(issueText(required, nodes, 'tr')).toBe('URL gerekli');
    expect(issueText(required, [], 'en')).toBe('url is required');
    const pre = { code: 'preflight.flow.invalid', message: 'url is required', nodeId: 'req', params: { issue: 'flow.param.required', param: 'url', problem: 'url is required' } };
    expect(issueText(pre, nodes, 'tr')).toBe('Akışta düzeltilmesi gereken bir hata var: URL gerekli');
  });

  it('words a step by its type unless it has a label of its own', async () => {
    const { stepName } = await import('./model/text');
    expect(stepName({ type: 'http.request', label: 'HTTP request' }, 'tr')).toBe('HTTP isteği');
    expect(stepName({ type: 'http.request', label: 'Giriş yap' }, 'tr')).toBe('Giriş yap');
    expect(stepName({ type: 'http.request' }, 'en')).toBe('HTTP request');
  });
});

describe('template suggestion texts', () => {
  it('every helper and pipe has a text in both languages', async () => {
    const { TEMPLATE_HELPERS, TEMPLATE_PIPES } = await import('@durbun/protocol');
    const keys = [...Object.keys(TEMPLATE_HELPERS).map((h) => `flows.tpl.detail.helper.${h.slice(1)}`), ...Object.keys(TEMPLATE_PIPES).map((p) => `flows.tpl.detail.pipe.${p}`)];
    expect(keys.filter((k) => !messageKeys('tr').includes(k) || !messageKeys('en').includes(k))).toEqual([]);
  });
});
