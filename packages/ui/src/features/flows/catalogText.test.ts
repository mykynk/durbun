import { describe, expect, it } from 'vitest';
import { FLOW_NODE_GROUPS, FLOW_NODE_SPECS } from '@durbun/protocol';
import { GROUP_TEXT, NODE_TEXT_TR, PARAM_LABELS_EN } from './catalogText';

/** `{{template}}` and `backticked` tokens: they must survive translation unchanged. */
function tokens(text: string): string[] {
  return [...new Set(text.match(/\{\{[^{}]*\}\}|`[^`]+`/g) ?? [])].sort();
}

/** Every string in a (nested) value, with its path. */
function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  return out;
}

const SPEC_TYPES = FLOW_NODE_SPECS.map((s) => s.type);
const sorted = (keys: string[]) => [...keys].sort();
const words = (label: string) => label.trim().split(/\s+/).length;

describe('flow catalog texts', () => {
  it('cover exactly the catalog types', () => {
    expect(sorted(Object.keys(NODE_TEXT_TR))).toEqual(sorted(SPEC_TYPES));
    expect(sorted(Object.keys(PARAM_LABELS_EN))).toEqual(sorted(SPEC_TYPES));
  });

  it('cover every group in both languages', () => {
    for (const lang of ['tr', 'en'] as const) {
      expect(sorted(Object.keys(GROUP_TEXT[lang]))).toEqual(sorted([...FLOW_NODE_GROUPS]));
      for (const group of FLOW_NODE_GROUPS) expect(GROUP_TEXT[lang][group].trim(), `${lang}.${group}`).not.toBe('');
    }
  });

  describe.each(FLOW_NODE_SPECS.map((s) => [s.type, s] as const))('%s', (type, spec) => {
    const tr = NODE_TEXT_TR[type]!;
    const en = PARAM_LABELS_EN[type]!;

    it('has every param (and no unknown ones) in both languages', () => {
      const names = spec.params.map((p) => p.name);
      expect(sorted(Object.keys(tr.params))).toEqual(sorted(names));
      expect(sorted(Object.keys(en))).toEqual(sorted(names));
    });

    it('has short labels in both languages', () => {
      for (const p of spec.params) {
        const enLabel = en[p.name] ?? '';
        const trLabel = tr.params[p.name]?.label ?? '';
        expect(enLabel.trim(), `${type}.${p.name} EN`).not.toBe('');
        expect(trLabel.trim(), `${type}.${p.name} TR`).not.toBe('');
        expect(words(enLabel), `${type}.${p.name} EN "${enLabel}"`).toBeLessThanOrEqual(4);
        expect(words(trLabel), `${type}.${p.name} TR "${trLabel}"`).toBeLessThanOrEqual(4);
        expect(enLabel[0], `${type}.${p.name} EN sentence case`).toBe(enLabel[0]!.toUpperCase());
      }
    });

    it('labels every option of select params and nothing else', () => {
      for (const p of spec.params) {
        const options = tr.params[p.name]?.options;
        if (p.kind === 'select') {
          expect(sorted(Object.keys(options ?? {})), `${type}.${p.name}`).toEqual(sorted((p.options ?? []).map((o) => o.value)));
        } else {
          expect(options, `${type}.${p.name} is not a select`).toBeUndefined();
        }
      }
    });

    it('translates placeholders only where the catalog has one', () => {
      for (const p of spec.params) {
        if (tr.params[p.name]?.placeholder !== undefined) expect(p.placeholder, `${type}.${p.name}`).toBeDefined();
      }
    });

    it('has every output (and no unknown ones)', () => {
      expect(sorted(Object.keys(tr.outputs))).toEqual(sorted(spec.outputs.map((o) => o.name)));
    });

    it('has no empty Turkish text', () => {
      for (const [path, text] of strings(tr, type)) expect(text.trim(), path).not.toBe('');
    });

    it('keeps template and backticked tokens unchanged', () => {
      const pairs: [string, string, string][] = [
        [`${type}.title`, spec.title, tr.title],
        [`${type}.description`, spec.description, tr.description],
      ];
      for (const p of spec.params) {
        const t = tr.params[p.name]!;
        pairs.push([`${type}.${p.name}.hint`, p.description, t.hint]);
        for (const o of p.options ?? []) pairs.push([`${type}.${p.name}.options.${o.value}`, o.label, t.options?.[o.value] ?? '']);
        if (t.placeholder !== undefined) pairs.push([`${type}.${p.name}.placeholder`, p.placeholder ?? '', t.placeholder]);
      }
      for (const o of spec.outputs) pairs.push([`${type}.outputs.${o.name}`, o.description, tr.outputs[o.name] ?? '']);
      for (const [path, english, turkish] of pairs) expect(tokens(turkish), path).toEqual(tokens(english));
    });
  });
});
