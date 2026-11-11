import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { messageKeys, translate, type TFunction } from '../../i18n/core';
import './i18n';
import { FLOW_FILE_ACCEPT, readPicked, sniffFormat } from './store';
import { hasFollowUps, readErrorText, resultSummary, stripBom } from './ImportDialog';
import type { PackageImportResult } from '@durbun/protocol';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const SRC = join(__dirname, '..', '..');

describe('transfer dictionary', () => {
  const tr = new Set(messageKeys('tr').filter((k) => k.startsWith('transfer.')));
  const en = new Set(messageKeys('en').filter((k) => k.startsWith('transfer.')));

  it('every literal t() key used in the UI exists in Turkish and English', () => {
    const used = new Set<string>();
    for (const f of walk(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'(transfer\.[A-Za-z0-9_.-]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((k) => !tr.has(k) || !en.has(k))).toEqual([]);
  });

  it('Turkish and English define the same keys', () => {
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const families: Record<string, readonly string[]> = {
      'transfer.backup.every': ['h6', 'h12', 'h24', 'h72', 'h168'],
      'transfer.import.kind': ['share', 'backup'],
      'transfer.import.state': ['new', 'changed', 'same', 'copy', 'skipped'],
      'transfer.import.conflict': ['keepBoth', 'replace', 'skip'],
    };
    const missing: string[] = [];
    for (const [prefix, names] of Object.entries(families)) for (const n of names) if (!tr.has(`${prefix}.${n}`) || !en.has(`${prefix}.${n}`)) missing.push(`${prefix}.${n}`);
    expect(missing).toEqual([]);
  });

  it('plural parts read naturally', () => {
    expect(translate('en', 'transfer.import.part.flows', { count: 1 })).toBe('1 flow');
    expect(translate('en', 'transfer.import.part.flows', { count: 3 })).toBe('3 flows');
    expect(translate('tr', 'transfer.import.part.flows', { count: 3 })).toBe('3 akış');
  });
});

describe('sniffFormat', () => {
  it('tells packages, flows and sessions apart from the first bytes', () => {
    expect(sniffFormat('{"format":"durbun-package","version":1')).toBe('package');
    expect(sniffFormat('{\n  "format": "durbun-flow",')).toBe('flow');
    expect(sniffFormat('{"format":"durbun-session","version":1}')).toBe('session');
    expect(sniffFormat('[{"format":"durbun-flow","id":"a"}]')).toBe('flow');
    expect(sniffFormat('{"hello":1}')).toBe('unknown');
    expect(sniffFormat('not json')).toBe('unknown');
  });
});

describe('readPicked', () => {
  const file = (name: string, text: string) => new File([text], name);
  it('sets the first package apart and keeps the other texts', async () => {
    const pkg = '{"format":"durbun-package","version":1,"kind":"share"}';
    const flow = '{"format":"durbun-flow","version":1,"id":"a"}';
    expect(await readPicked([file('a.json', flow), file('Ekip.durbun', pkg), file('b.durbun', pkg)])).toEqual({ pkg: { name: 'Ekip.durbun', text: pkg }, texts: [flow] });
    expect(await readPicked([file('a.md', 'answer')])).toEqual({ texts: ['answer'] });
    expect(FLOW_FILE_ACCEPT.split(',')).toContain('.durbun');
  });
});

describe('import helpers', () => {
  const en: TFunction = (key, params) => translate('en', key, params);
  const result = (patch: Partial<PackageImportResult> = {}): PackageImportResult => ({
    flows: { added: 0, replaced: 0, skipped: 0, renamed: 0 },
    mocks: { added: 0, replaced: 0, skipped: 0 },
    environments: { added: 0, replaced: 0, skipped: 0 },
    settings: false,
    slack: false,
    runs: 0,
    secretsRestored: false,
    warnings: [],
    ...patch,
  });

  it('drops a byte order mark', () => {
    expect(stripBom('\uFEFF{"a":1}')).toBe('{"a":1}');
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
  });

  it('says plainly when a file is damaged or too large', () => {
    expect(readErrorText({ code: 'body.invalidJson', message: 'x' }, en)).toBe(en('transfer.import.damaged'));
    expect(readErrorText({ code: 'package.damaged', message: 'x' }, en)).toBe(en('transfer.import.damaged'));
    expect(readErrorText({ code: 'package.tooLarge', message: 'x' }, en)).toContain('256');
    expect(readErrorText({ code: 'body.tooLarge', message: 'x' }, en)).toBe(readErrorText({ code: 'package.tooLarge' }, en));
  });

  it('keeps the dialog open only when something needs a look', () => {
    expect(hasFollowUps(result())).toBe(false);
    expect(hasFollowUps(result({ automationOff: 1 }))).toBe(true);
    expect(hasFollowUps(result({ emptySecrets: [{ kind: 'env', id: 'dev', name: 'Dev', keys: ['token'] }] }))).toBe(true);
    expect(hasFollowUps(result({ warnings: ['x'], notices: [{ code: 'package.run.failed', message: 'x' }] }))).toBe(true);
    expect(hasFollowUps(result({ warnings: ['older server'] }))).toBe(true);
  });

  it('sums up what came in, not what was already here', () => {
    expect(resultSummary(result({ flows: { added: 1, replaced: 1, skipped: 0, renamed: 1, same: 4 } }), en)).toBe('3 flows');
    expect(resultSummary(result({ mocks: { added: 0, replaced: 0, skipped: 0, same: 2 } }), en)).toBe('');
  });
});
