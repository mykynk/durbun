/**
 * Building queries from clicks (SPEC §1.1.9: click a tag → filter, Alt-click → exclude):
 *   appendQueryTerm(query, queryTerm('tag', 'OkHttp', { op: '=:' }))           → `… tag=:OkHttp`
 *   appendQueryTerm(query, queryTerm('tag', 'chatty', { negate: true }))       → `… -tag:chatty`
 */
import { lex, scanBare, type Lexeme } from './lexer';
import { formatValue, type QueryKey, type QueryOp } from './syntax';

function valueText(value: string, regex: boolean): string {
  if (value === '' || value.startsWith('"')) return formatValue(value, true);
  return scanBare(value, 0, regex) === value.length ? value : formatValue(value, true);
}

/** One term, quoted when needed: queryTerm('tag', 'my tag') → `tag:"my tag"`; `{ negate: true }` → `-tag:…`. */
export function queryTerm(key: QueryKey, value: string | number, opts: { op?: QueryOp; negate?: boolean } = {}): string {
  const op = opts.op ?? ':';
  return `${opts.negate ? '-' : ''}${key}${op}${valueText(String(value), op === '~:')}`;
}

/** Top-level AND units [from, to) (a term or group with its `-`), or null when the query has a top-level OR. */
function topLevelUnits(lexemes: readonly Lexeme[]): Array<{ from: number; to: number }> | null {
  const units: Array<{ from: number; to: number }> = [];
  let depth = 0;
  let start = -1;
  for (const l of lexemes) {
    if (l.type === 'or' && depth === 0) return null;
    if (depth === 0 && start < 0 && (l.type === 'neg' || l.type === 'term' || l.type === 'lparen')) start = l.from;
    if (l.type === 'lparen') depth++;
    else if (l.type === 'rparen') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        units.push({ from: start, to: l.to });
        start = -1;
      }
    } else if (l.type === 'term' && depth === 0) {
      units.push({ from: start, to: l.to });
      start = -1;
    }
  }
  const last = lexemes[lexemes.length - 1];
  if (start >= 0 && last) units.push({ from: start, to: last.to });
  return units;
}

/**
 * AND a term to a query: no-op when the same term is already there, replaces its opposite (`tag:x` ↔
 * `-tag:x`), and wraps a top-level OR in parentheses so the meaning is kept (`a | b` + `c` → `(a | b) c`).
 */
export function appendQueryTerm(query: string, term: string): string {
  const t = term.trim();
  const q = query.trim();
  if (!t) return query;
  if (!q) return t;
  const units = topLevelUnits(lex(q).lexemes);
  if (units === null) return `(${q}) ${t}`;
  if (units.some((u) => q.slice(u.from, u.to) === t)) return query;
  const opposite = t.startsWith('-') ? t.slice(1) : `-${t}`;
  const opp = units.find((u) => q.slice(u.from, u.to) === opposite);
  const base = opp ? `${q.slice(0, opp.from).trimEnd()} ${q.slice(opp.to).trimStart()}`.trim() : q;
  return base ? `${base} ${t}` : t;
}
