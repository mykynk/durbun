import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Text colors stay readable (WCAG AA, 4.5:1 for small text) on every surface they are written on, in both themes
 * and in the no-JS fallback that follows the OS.
 */
const srcDir = existsSync(join(process.cwd(), 'src/styles')) ? join(process.cwd(), 'src') : join(process.cwd(), 'packages/ui/src');
const css = readFileSync(join(srcDir, 'styles/tokens.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  const vars: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) vars[m[1]!] = m[2]!.toLowerCase();
  return vars;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXTS = ['--text-muted', '--text-subtle'];
const SURFACES = ['--bg-app', '--bg-panel', '--bg-elevated', '--bg-sunken', '--bg-hover'];

describe('token contrast', () => {
  for (const selector of [':root[data-theme="dark"]', ':root[data-theme="light"]', ':root:not([data-theme])']) {
    it(`${selector}: secondary text reads on every surface`, () => {
      const vars = block(selector);
      for (const text of TEXTS) {
        const fg = vars[text];
        if (!fg) continue;
        for (const surface of SURFACES) {
          const bg = vars[surface];
          if (!bg) continue;
          expect(contrast(fg, bg), `${selector} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it('the subtle text stays a step below the muted text', () => {
    for (const selector of [':root[data-theme="dark"]', ':root[data-theme="light"]']) {
      const v = block(selector);
      const bg = v['--bg-panel']!;
      expect(contrast(v['--text-subtle']!, bg)).toBeLessThan(contrast(v['--text-muted']!, bg));
    }
  });
});
