/**
 * Chart colors read from the design tokens (canvas cannot use CSS variables directly). Re-read whenever the
 * resolved theme (`data-theme` on <html>) changes so uPlot charts follow dark/light.
 *
 * Series hues were checked with the dataviz palette validator for the pairs that share a chart
 * (memory/heap, fps/jank, requests/failed, logs/errors): CVD ΔE ≥ 8 in both themes.
 */
import { useEffect, useState } from 'react';

export interface ChartColors {
  text: string;
  muted: string;
  subtle: string;
  grid: string;
  surface: string;
  cpu: string;
  memory: string;
  heap: string;
  fps: string;
  jank: string;
  requests: string;
  failed: string;
  logs: string;
  errorLogs: string;
  crash: string;
  anr: string;
  marker: string;
  connect: string;
  /** Canvas font for axis labels. */
  font: string;
  theme: string;
}

/** Token per chart color (tokens.css defines all of them for both themes). */
const VARS: Record<Exclude<keyof ChartColors, 'font' | 'theme'>, string> = {
  text: '--text',
  muted: '--text-muted',
  subtle: '--text-subtle',
  grid: '--border',
  surface: '--bg-panel',
  cpu: '--pick-green',
  memory: '--accent',
  heap: '--pick-orange',
  fps: '--pick-blue',
  jank: '--warning',
  requests: '--st-3xx',
  failed: '--danger',
  logs: '--text-muted',
  errorLogs: '--danger',
  crash: '--danger',
  anr: '--warning',
  marker: '--accent',
  connect: '--text-subtle',
};

export function readChartColors(): ChartColors {
  const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const get = (name: string) => style?.getPropertyValue(name).trim() ?? '';
  const out = {} as ChartColors;
  for (const [key, cssVar] of Object.entries(VARS)) (out as unknown as Record<string, string>)[key] = get(cssVar);
  out.font = `${get('--fs-xs') || '11px'} ${get('--font-ui') || 'sans-serif'}`;
  out.theme = typeof document !== 'undefined' ? (document.documentElement.getAttribute('data-theme') ?? '') : '';
  return out;
}

/** Current chart colors; updates when the theme changes. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState(readChartColors);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const obs = new MutationObserver(() => {
      setColors((prev) => {
        const next = readChartColors();
        return next.theme === prev.theme && next.surface === prev.surface && next.text === prev.text ? prev : next;
      });
    });
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    // The theme may have changed between the initial render and this effect.
    setColors((prev) => {
      const next = readChartColors();
      return next.theme === prev.theme && next.surface === prev.surface ? prev : next;
    });
    return () => obs.disconnect();
  }, []);
  return colors;
}

/** `#rrggbb` / `#rgb` / `rgb(a)(…)` with a new alpha (other formats are returned unchanged). */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.replace(/./g, (x) => x + x);
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return c;
}
