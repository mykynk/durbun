/**
 * Text highlighting for log rows: search terms from the compiled query (`compiled.highlights`) plus the
 * user's highlight rules (`prefs.highlightRules`, colors `var(--pick-<color>)`). Pure + cheap: runs only
 * for rendered rows.
 */

export interface HighlightRuleLike {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  color: string;
  enabled: boolean;
}

export interface Highlighter {
  /** Global regexes; `color` undefined = search match. Search terms come first (they win overlaps). */
  rules: ReadonlyArray<{ re: RegExp; color?: string }>;
  /** Stable identity for memo comparisons. */
  key: string;
}

export const NO_HIGHLIGHT: Highlighter = { rules: [], key: '' };

export interface Segment {
  text: string;
  /** Search match. */
  search?: boolean;
  /** User highlight rule color name. */
  color?: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globalize(re: RegExp): RegExp | null {
  try {
    return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  } catch {
    return null;
  }
}

export function buildHighlighter(search: ReadonlyArray<string | RegExp>, rules: readonly HighlightRuleLike[]): Highlighter {
  const out: { re: RegExp; color?: string }[] = [];
  const keys: string[] = [];
  const words = search.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (words.length) {
    // Longest first so overlapping terms prefer the longer match.
    const sorted = [...new Set(words)].sort((a, b) => b.length - a.length);
    out.push({ re: new RegExp(sorted.map(escapeRe).join('|'), 'gi') });
    keys.push(`s:${sorted.join('\u0001')}`);
  }
  for (const s of search) {
    if (typeof s === 'string') continue;
    const re = globalize(s);
    if (re) {
      out.push({ re });
      keys.push(`r:${re.source}/${re.flags}`);
    }
  }
  for (const r of rules) {
    if (!r.enabled || !r.pattern) continue;
    let re: RegExp | null = null;
    try {
      re = new RegExp(r.regex ? r.pattern : escapeRe(r.pattern), r.caseSensitive ? 'g' : 'gi');
    } catch {
      re = null;
    }
    if (!re) continue;
    out.push({ re, color: r.color });
    keys.push(`h:${r.color}:${re.source}/${re.flags}`);
  }
  return out.length ? { rules: out, key: keys.join('\u0002') } : NO_HIGHLIGHT;
}

/** Split `text` into plain / highlighted segments (earlier rules win overlaps). */
export function highlightSegments(text: string, h: Highlighter, maxMatches = 200): Segment[] {
  if (!text || h.rules.length === 0) return [{ text }];
  const ranges: { s: number; e: number; color?: string }[] = [];
  for (const rule of h.rules) {
    const re = rule.re;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < maxMatches) {
      const s = m.index;
      const e = s + m[0].length;
      if (e === s) {
        re.lastIndex++;
        continue;
      }
      if (!ranges.some((r) => s < r.e && e > r.s)) ranges.push({ s, e, color: rule.color });
    }
  }
  if (ranges.length === 0) return [{ text }];
  ranges.sort((a, b) => a.s - b.s);
  const out: Segment[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.s > pos) out.push({ text: text.slice(pos, r.s) });
    out.push(r.color ? { text: text.slice(r.s, r.e), color: r.color } : { text: text.slice(r.s, r.e), search: true });
    pos = r.e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}
