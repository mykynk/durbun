import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every colored label stays readable (WCAG AA: 4.5:1 for the small text they all are, 3:1 for icons) on the
 * surfaces it is actually drawn on, in both themes: level badges on their own tint (also on a tinted, hovered or
 * selected log row), methods and status codes on every surface, semantic chips and counters on their soft tint,
 * SDK badges on their tint, and the text colors on every surface.
 *
 * The tints are the ones components.css mixes (`color-mix(in srgb, <color> N%, transparent)`); the alphas are read
 * from there, so making a tint stronger fails here first.
 */
const srcDir = existsSync(join(process.cwd(), 'src/styles')) ? join(process.cwd(), 'src') : join(process.cwd(), 'packages/ui/src');
const tokensCss = readFileSync(join(srcDir, 'styles/tokens.css'), 'utf8');
const componentsCss = readFileSync(join(srcDir, 'styles/components.css'), 'utf8');

type Rgb = [number, number, number];
interface Paint {
  rgb: Rgb;
  alpha: number;
}

function parseColor(value: string): Paint | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255) as Rgb, alpha: 1 };
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(value.trim());
  if (rgba) return { rgb: [Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255], alpha: Number(rgba[4]) };
  return null;
}

function theme(selector: string): Record<string, Paint> {
  const start = tokensCss.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = tokensCss.slice(start, tokensCss.indexOf('}', start));
  const vars: Record<string, Paint> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) {
    const c = parseColor(m[2]!);
    if (c) vars[m[1]!] = c;
  }
  return vars;
}

/** The percentage a components.css rule mixes its color with (`.lvl--pill` → 12). */
function tintOf(rule: string, variable: string): number {
  const start = componentsCss.indexOf(`${rule} {`);
  expect(start, rule).toBeGreaterThanOrEqual(0);
  const body = componentsCss.slice(start, componentsCss.indexOf('}', start));
  const m = new RegExp(`color-mix\\(in srgb, var\\(${variable}\\) (\\d+)%, transparent\\)`).exec(body);
  expect(m, `${rule} tint`).not.toBeNull();
  return Number(m![1]) / 100;
}

/** The token a components.css rule paints `prop` with (`.btn--primary`, 'background' → '--accent-fill'). */
function tokenOf(rule: string, prop: 'background' | 'color'): string {
  const start = componentsCss.indexOf(`${rule} {`);
  expect(start, rule).toBeGreaterThanOrEqual(0);
  const body = componentsCss.slice(start, componentsCss.indexOf('}', start));
  const m = new RegExp(`(?:^|\\n)\\s*${prop}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(body);
  expect(m, `${rule} ${prop}`).not.toBeNull();
  return m![1]!;
}

const over = (top: Rgb, alpha: number, below: Rgb): Rgb => [0, 1, 2].map((i) => top[i]! * alpha + below[i]! * (1 - alpha)) as Rgb;
const lay = (paint: Paint, below: Rgb): Rgb => over(paint.rgb, paint.alpha, below);

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const THEMES = { dark: ':root,\n:root[data-theme="dark"]', light: ':root[data-theme="light"]' } as const;
const LEVELS = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];
const TINTED_ROWS = ['warn', 'error', 'fatal'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'other'];
const STATUSES = ['2xx', '3xx', '4xx', '5xx', 'fail', 'pending'];
const SDKS = ['flutter', 'android', 'ios', 'rn', 'js', 'dart', 'demo'];
const SEMANTIC: [text: string, tint: string][] = [
  ['--success', '--success-soft'],
  ['--warning', '--warning-soft'],
  ['--danger', '--danger-soft'],
  ['--info', '--info-soft'],
  ['--badge-accent', '--accent-soft'],
];

for (const [name, selector] of Object.entries(THEMES)) {
  describe(`${name} theme contrast`, () => {
    const v = theme(selector);
    const color = (k: string): Rgb => {
      expect(v[k], `${name} ${k}`).toBeDefined();
      return v[k]!.rgb;
    };
    const panel = color('--bg-panel');
    const selected = lay(v['--bg-selected']!, panel);
    /** The plain surfaces text sits on. A selected row is the selection tint over the panel. */
    const surfaces: Record<string, Rgb> = {
      'bg-app': color('--bg-app'),
      'bg-panel': panel,
      'bg-elevated': color('--bg-elevated'),
      'bg-sunken': color('--bg-sunken'),
      'bg-hover': color('--bg-hover'),
      'bg-selected': selected,
    };
    const failures: string[] = [];
    const check = (label: string, fg: Rgb, bg: Rgb, min = 4.5) => {
      const ratio = contrast(fg, bg);
      if (ratio < min) failures.push(`${label}: ${ratio.toFixed(2)} < ${min}`);
    };

    it('level badges read on their tint, on plain, tinted, hovered and selected rows', () => {
      failures.length = 0;
      const pill = tintOf('.lvl--pill', '--lvl');
      const letter = tintOf('.lvl--letter', '--lvl');
      const hover = (bg: Rgb) => over(color('--text'), 0.04, bg);
      for (const lv of LEVELS) {
        const fg = color(`--lv-${lv}`);
        const rows: Record<string, Rgb> = { ...surfaces, 'hovered row': hover(panel) };
        if (TINTED_ROWS.includes(lv)) {
          const tinted = lay(v[`--lv-${lv}-bg`]!, panel);
          rows['tinted row'] = tinted;
          rows['tinted row, hovered'] = hover(tinted);
          // A selected tinted row lays the selection twice (background color and image).
          rows['tinted row, selected'] = lay(v['--bg-selected']!, selected);
        }
        for (const [where, bg] of Object.entries(rows)) {
          check(`--lv-${lv} pill on ${where}`, fg, over(fg, pill, bg));
          check(`--lv-${lv} letter on ${where}`, fg, over(fg, letter, bg));
        }
      }
      expect(failures).toEqual([]);
    });

    it('methods, status codes and text colors read on every surface', () => {
      failures.length = 0;
      const texts = [...METHODS.map((m) => `--m-${m}`), ...STATUSES.map((s) => `--st-${s}`), '--text', '--text-muted', '--text-subtle', '--text-meta', '--accent', ...SEMANTIC.map(([t]) => t)];
      for (const t of texts) for (const [where, bg] of Object.entries(surfaces)) check(`${t} on ${where}`, color(t), bg);
      expect(failures).toEqual([]);
    });

    it('semantic chips and counters read on their soft tint; callout icons on theirs', () => {
      failures.length = 0;
      for (const [text, tint] of SEMANTIC) {
        for (const where of ['bg-app', 'bg-panel', 'bg-elevated', 'bg-hover'] as const) {
          check(`${text} on ${tint} over ${where}`, color(text), lay(v[tint]!, surfaces[where]!));
        }
      }
      const callout = tintOf('.callout', '--c');
      for (const c of ['--success', '--warning', '--danger', '--info']) {
        for (const where of ['bg-app', 'bg-panel', 'bg-elevated'] as const) check(`${c} callout icon over ${where}`, color(c), over(color(c), callout, surfaces[where]!), 3);
      }
      expect(failures).toEqual([]);
    });

    it('SDK badges read on their tint', () => {
      failures.length = 0;
      const tint = tintOf('.sdk-badge', '--sdk');
      for (const sdk of SDKS) {
        const fg = color(`--sdk-${sdk}`);
        for (const where of ['bg-app', 'bg-panel', 'bg-elevated', 'bg-hover', 'bg-selected'] as const) check(`--sdk-${sdk} badge on ${where}`, fg, over(fg, tint, surfaces[where]!));
      }
      expect(failures).toEqual([]);
    });

    it('button and tooltip text read on their fill', () => {
      failures.length = 0;
      check('--tooltip-text on --tooltip-bg', color('--tooltip-text'), color('--tooltip-bg'));
      // Filled buttons and the count on an icon button carry text: AA on the fill and on the hover fill, read from
      // the rules components.css actually paints them with.
      const filled: [rule: string, hover: string | null][] = [
        ['.btn--primary', '.btn--primary:not(:disabled):hover'],
        ['.btn--danger', '.btn--danger:not(:disabled):hover'],
        ['.icon-btn__badge--count', null],
      ];
      for (const [rule, hover] of filled) {
        const fg = color(tokenOf(rule, 'color'));
        check(`${rule} text on its fill`, fg, color(tokenOf(rule, 'background')));
        if (hover) check(`${rule} text on its hover fill`, fg, color(tokenOf(hover, 'background')));
      }
      // The fill tokens are what any other filled control uses too.
      check('--text-on-accent on --accent-fill', color('--text-on-accent'), color('--accent-fill'));
      check('--text-on-danger on --danger-fill', color('--text-on-danger'), color('--danger-fill'));
      // The switch thumb and the checkbox mark on --accent are icons (3:1); --accent is also a text colour on dark
      // surfaces, so it is not darkened for them.
      check('--text-on-accent mark on --accent', color('--text-on-accent'), color('--accent'), 3);
      // A filled button is still told apart from the panel it sits on.
      for (const fill of ['--accent-fill', '--danger-fill']) check(`${fill} against bg-panel`, color(fill), panel, 3);
      expect(failures).toEqual([]);
    });
  });
}
