/**
 * Editing the query text from clicks (tag chip → `tag=:X`, Alt-click → `-tag=:X`, detail panel filter /
 * exclude buttons) and the built-in saved-filter presets. Only produces text in the query language of
 * `./query` (SPEC §7.3); parsing stays with that module.
 */

export type QueryField = 'tag' | 'process' | 'message' | 'pid' | 'level' | 'source' | 'app' | 'is';

const NEEDS_QUOTES = /[\s"()|]/;

/** Quote a value when it contains spaces, quotes, parentheses or `|`. */
export function quoteValue(v: string): string {
  if (v === '' || NEEDS_QUOTES.test(v)) return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return v;
}

/** One term, e.g. `tag=:OkHttp`, `-process=:com.android.systemui`, `pid:4821`. */
export function makeTerm(field: QueryField, value: string | number, opts: { exclude?: boolean; exact?: boolean } = {}): string {
  const exact = opts.exact ?? (field === 'tag' || field === 'process');
  const op = exact && field !== 'pid' && field !== 'level' && field !== 'source' && field !== 'is' ? '=:' : ':';
  return `${opts.exclude ? '-' : ''}${field}${op}${quoteValue(String(value))}`;
}

/** Split into top-level whitespace-separated terms (quotes and parentheses respected). */
export function splitTerms(query: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < query.length) cur += query[++i]!;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') {
      quote = true;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const negate = (term: string) => (term.startsWith('-') ? term.slice(1) : `-${term}`);

/**
 * Add a term (AND) to the query. Clicking the same filter again removes it; adding the opposite
 * (`tag=:X` vs `-tag=:X`) replaces it. A query with a top-level `|` is wrapped in parentheses first so
 * the new term applies to all of it.
 */
export function toggleTerm(query: string, term: string): string {
  const terms = splitTerms(query.trim());
  if (terms.includes(term)) return terms.filter((t) => t !== term).join(' ');
  const opposite = negate(term);
  if (terms.includes(opposite)) return terms.map((t) => (t === opposite ? term : t)).join(' ');
  if (terms.includes('|')) return `(${terms.join(' ')}) ${term}`;
  return [...terms, term].join(' ');
}

/** Collapse whitespace (for comparing a query with a saved filter). */
export function normalizeQuery(q: string): string {
  return splitTerms(q.trim()).join(' ');
}

export interface FilterPreset {
  id: string;
  /** i18n key under `logs.presets`. */
  labelKey: string;
  query: string;
}

/** Built-in quick filters (SPEC §7.3 saved filters). */
export const PRESETS: readonly FilterPreset[] = [
  { id: 'errors', labelKey: 'logs.presets.errors', query: 'level:error' },
  { id: 'crashes', labelKey: 'logs.presets.crashes', query: 'is:crash | is:anr | (tag=:flutter level:error)' },
  { id: 'network', labelKey: 'logs.presets.network', query: 'is:network' },
  { id: 'flutter', labelKey: 'logs.presets.flutter', query: 'is:flutter' },
  { id: 'events', labelKey: 'logs.presets.events', query: 'is:event' },
];

export interface SavedFilter {
  id: string;
  name: string;
  query: string;
}

export function sanitizeSavedFilters(raw: unknown): SavedFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is SavedFilter => !!x && typeof x === 'object' && typeof (x as SavedFilter).name === 'string' && typeof (x as SavedFilter).query === 'string')
    .map((x) => ({ id: typeof x.id === 'string' && x.id ? x.id : `f${Math.random().toString(36).slice(2, 9)}`, name: x.name.slice(0, 60), query: x.query }))
    .slice(0, 50);
}

/** Most recent first, deduplicated, at most `max`. */
export function pushHistory(history: readonly string[], query: string, max = 30): string[] {
  const q = normalizeQuery(query);
  if (!q) return [...history];
  return [q, ...history.filter((h) => h !== q)].slice(0, max);
}
