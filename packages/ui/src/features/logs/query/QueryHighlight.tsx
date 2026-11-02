/** Syntax-colored rendering of query tokens (input overlay, help examples, saved filters…). */
import { memo, useMemo, type ReactNode } from 'react';
import { clsx } from 'clsx';
import type { QueryToken } from './index';
import { parseLogQuery } from './parser';
import { parseLevelName } from './syntax';
import './query.css';

function tokenClass(tok: QueryToken): string {
  let cls = `qt qt--${tok.kind}`;
  if (tok.key && (tok.kind === 'key' || tok.kind === 'operator' || tok.kind === 'value')) cls += ` qt--k-${tok.key}`;
  if (tok.kind === 'value' && tok.key === 'level') {
    const level = parseLevelName(tok.text.replace(/^"|"$/g, ''));
    if (level) cls += ` qt--lv-${level}`;
  }
  return cls;
}

export interface QueryTokensProps {
  tokens: readonly QueryToken[];
  /** Ranges to underline with a wavy error line. */
  errors?: ReadonlyArray<{ from: number; to: number }>;
  /** Source offsets of a matching parenthesis pair to emphasize. */
  parens?: readonly [number, number] | null;
}

/** Token spans (`.qt--<kind>`); a token is split where an error range starts or ends inside it. */
export const QueryTokens = memo(function QueryTokens({ tokens, errors, parens }: QueryTokensProps) {
  const out: ReactNode[] = [];
  for (const tok of tokens) {
    let cls = tokenClass(tok);
    if (parens && tok.kind === 'paren' && (tok.from === parens[0] || tok.from === parens[1])) cls += ' is-match';
    if (!errors || errors.length === 0) {
      out.push(
        <span key={tok.from} className={cls}>
          {tok.text}
        </span>,
      );
      continue;
    }
    const cuts = new Set<number>([tok.from, tok.to]);
    for (const e of errors) {
      if (e.from > tok.from && e.from < tok.to) cuts.add(e.from);
      if (e.to > tok.from && e.to < tok.to) cuts.add(e.to);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const inError = errors.some((e) => e.from <= a && b <= e.to);
      out.push(
        <span key={`${tok.from}:${a}`} className={inError ? `${cls} qt-err` : cls}>
          {tok.text.slice(a - tok.from, b - tok.from)}
        </span>,
      );
    }
  }
  return <>{out}</>;
});

/** The parenthesis pair around the caret ([open.from, close.from]) when the caret touches a parenthesis. */
export function matchingParen(tokens: readonly QueryToken[], caret: number): [number, number] | null {
  let idx = tokens.findIndex((t) => t.kind === 'paren' && t.to === caret);
  if (idx < 0) idx = tokens.findIndex((t) => t.kind === 'paren' && t.from === caret);
  if (idx < 0) return null;
  const start = tokens[idx]!;
  const forward = start.text === '(';
  let depth = 0;
  for (let i = idx; i >= 0 && i < tokens.length; i += forward ? 1 : -1) {
    const t = tokens[i]!;
    if (t.kind !== 'paren') continue;
    depth += (t.text === '(') === forward ? 1 : -1;
    if (depth === 0) return forward ? [start.from, t.from] : [t.from, start.from];
  }
  return null;
}

export interface QueryHighlightProps {
  query: string;
  className?: string;
}

/** A query rendered with the same colors as the query field (monospace, no wrapping). */
export const QueryHighlight = memo(function QueryHighlight({ query, className }: QueryHighlightProps) {
  const parsed = useMemo(() => parseLogQuery(query), [query]);
  return (
    <code className={clsx('qhl', className)}>
      <QueryTokens tokens={parsed.tokens} />
    </code>
  );
});
