/**
 * Recursive-descent parser for the log query language.
 *
 *   query   := or
 *   or      := and ( '|' and )*            OR binds looser than AND
 *   and     := unary+                      implicit AND between adjacent terms
 *   unary   := '-' unary | '(' or ')' | term
 *   term    := key op value | "phrase" | word
 *
 * Error recovery: every problem is recorded as a QueryError (with an i18n key under `logsQuery.error.*`) and
 * the offending piece is left out of the AST, so the remaining conditions keep filtering while the user
 * types (`level:er` filters nothing instead of everything). Never throws.
 */
import type { LogLevel, LogSource } from '@durbun/protocol';
import type { ParsedQuery, QueryError, QueryToken } from './index';
import { lex, type Lexeme, type TermLexeme } from './lexer';
import { foldCase, KEY_OPERATORS, LEVEL_RANK, parseAge, parseIsValue, parseLevelName, parseSourceName, type IsValue, type QueryOp } from './syntax';

export type TextKey = 'tag' | 'message' | 'process' | 'app';

/** Opaque AST behind `ParsedQuery.ast` (null = no conditions). */
export type QueryNode =
  | { t: 'and'; c: QueryNode[] }
  | { t: 'or'; c: QueryNode[] }
  | { t: 'not'; c: QueryNode }
  /** Free text / phrase: message, tag or process contains `needle` (folded). */
  | { t: 'text'; needle: string; from: number; to: number }
  | { t: 'str'; key: TextKey; op: QueryOp; needle: string; re?: RegExp; from: number; to: number }
  | { t: 'pid'; pid?: number; re?: RegExp; from: number; to: number }
  | { t: 'level'; exact: boolean; level: LogLevel; rank: number; from: number; to: number }
  | { t: 'source'; source: LogSource; from: number; to: number }
  | { t: 'is'; what: IsValue; from: number; to: number }
  | { t: 'age'; ms: number; from: number; to: number };

export type QueryErrorCode =
  | 'unclosedQuote'
  | 'unclosedParen'
  | 'strayParen'
  | 'emptyGroup'
  | 'strayOr'
  | 'danglingNeg'
  | 'emptyPhrase'
  | 'missingValue'
  | 'unknownKey'
  | 'badOperator'
  | 'badLevel'
  | 'badSource'
  | 'badIs'
  | 'badAge'
  | 'badPid'
  | 'badRegex';

/** English fallbacks (the Turkish and English UI texts live in ./i18n.ts under the same codes). */
export const ERROR_FALLBACKS: Readonly<Record<QueryErrorCode, string>> = {
  unclosedQuote: 'Unclosed quote',
  unclosedParen: 'Unclosed parenthesis',
  strayParen: "Unexpected ')'",
  emptyGroup: 'Empty parentheses',
  strayOr: "'|' needs a condition on both sides",
  danglingNeg: "Nothing to exclude after '-'",
  emptyPhrase: 'Empty quotes',
  missingValue: 'Missing value after {key}:',
  unknownKey: "Unknown key '{key}'. Put the text in quotes to search for it.",
  badOperator: '{key} does not support {op}',
  badLevel: "Unknown level '{value}'. Use verbose, debug, info, warn, error or fatal.",
  badSource: "Unknown source '{value}'. Use device, app or system.",
  badIs: "Unknown kind '{value}'. Try is:crash or is:json.",
  badAge: "Invalid age '{value}'. Use e.g. 30s, 5m, 2h or 1d.",
  badPid: "pid must be a number, not '{value}'",
  badRegex: 'Invalid regular expression: {detail}',
};

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (params[name] !== undefined ? String(params[name]) : whole));
}

interface UnaryResult {
  node: QueryNode | null;
  /** Something was consumed syntactically (even if it was invalid and dropped). */
  present: boolean;
}

class Parser {
  private i = 0;
  readonly errors: QueryError[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly lx: readonly Lexeme[],
    private readonly tokens: QueryToken[],
  ) {}

  private peek(): Lexeme | undefined {
    return this.lx[this.i];
  }

  private err(code: QueryErrorCode, from: number, to: number, params: Record<string, string | number> = {}): void {
    const id = `${code}@${from}:${to}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const e: QueryError = { message: fill(ERROR_FALLBACKS[code], params), messageKey: `logsQuery.error.${code}`, from, to };
    if (Object.keys(params).length) e.messageParams = params;
    this.errors.push(e);
  }

  parseRoot(): QueryNode | null {
    const r = this.parseOr(0);
    // Leftovers can only be unmatched ')' at depth 0, which parseAnd already consumes; loop defensively.
    while (this.i < this.lx.length) {
      const l = this.lx[this.i++]!;
      this.err('strayParen', l.from, l.to);
    }
    return r.node;
  }

  private parseOr(depth: number): UnaryResult {
    const branches: QueryNode[] = [];
    let present = false;
    let expectOperand = false;
    let lastOr: Lexeme | undefined;
    for (;;) {
      const p = this.peek();
      if (!p || (p.type === 'rparen' && depth > 0)) break;
      if (p.type === 'or') {
        if (!present || expectOperand) this.err('strayOr', p.from, p.to);
        lastOr = p;
        expectOperand = true;
        present = true;
        this.i++;
        continue;
      }
      const r = this.parseAnd(depth);
      if (r.node) branches.push(r.node);
      if (r.present) {
        present = true;
        expectOperand = false;
      }
    }
    if (expectOperand && lastOr) this.err('strayOr', lastOr.from, lastOr.to);
    return { node: branches.length === 0 ? null : branches.length === 1 ? branches[0]! : { t: 'or', c: branches }, present };
  }

  private parseAnd(depth: number): UnaryResult {
    const items: QueryNode[] = [];
    let present = false;
    for (;;) {
      const p = this.peek();
      if (!p || p.type === 'or') break;
      if (p.type === 'rparen') {
        if (depth > 0) break;
        this.err('strayParen', p.from, p.to);
        this.tokens[p.tok]!.kind = 'error';
        this.i++;
        continue;
      }
      const r = this.parseUnary(depth);
      if (r.node) items.push(r.node);
      present = present || r.present;
    }
    return { node: items.length === 0 ? null : items.length === 1 ? items[0]! : { t: 'and', c: items }, present };
  }

  private parseUnary(depth: number): UnaryResult {
    const p = this.peek()!;
    if (p.type === 'neg') {
      this.i++;
      if (p.dangling) {
        this.err('danglingNeg', p.from, p.to);
        return { node: null, present: true };
      }
      const r = this.parseUnary(depth);
      return { node: r.node ? { t: 'not', c: r.node } : null, present: true };
    }
    if (p.type === 'lparen') {
      this.i++;
      const inner = this.parseOr(depth + 1);
      const close = this.peek();
      if (close && close.type === 'rparen') {
        this.i++;
        if (!inner.present) this.err('emptyGroup', p.from, close.to);
      } else {
        this.err('unclosedParen', p.from, p.to);
      }
      return { node: inner.node, present: true };
    }
    if (p.type === 'term') {
      this.i++;
      return { node: this.term(p), present: true };
    }
    // Unreachable (or/rparen are handled by the callers); consume to guarantee progress.
    this.i++;
    return { node: null, present: false };
  }

  private term(l: TermLexeme): QueryNode | null {
    if (l.unclosed) this.err('unclosedQuote', l.valueFrom, l.valueTo);
    const { from, to } = l;

    // Free text / phrase
    if (l.keyText === undefined) {
      if (!l.value) {
        if (l.quoted) this.err('emptyPhrase', from, to);
        return null;
      }
      return { t: 'text', needle: foldCase(l.value), from, to };
    }

    const op = l.op!;
    const keyText = l.keyText;
    if (!l.key) {
      // Unknown key: keep filtering by the whole term as free text.
      this.err('unknownKey', l.keyFrom, l.keyTo, { key: keyText });
      return { t: 'text', needle: foldCase(`${keyText}${op}${l.value}`), from, to };
    }
    const key = l.key;
    if (!KEY_OPERATORS[key].includes(op)) {
      this.err('badOperator', l.keyFrom, l.opTo, { key: keyText, op });
      return null;
    }
    const v = l.value;
    const textKey = key === 'tag' || key === 'message' || key === 'process' || key === 'app';
    if (!v && !(textKey && l.quoted)) {
      this.err('missingValue', l.keyFrom, l.opTo, { key: keyText });
      return null;
    }
    const vFrom = l.valueFrom;
    const vTo = l.valueTo;

    if (op === '~:') {
      let re: RegExp;
      try {
        re = new RegExp(v, 'i');
      } catch (e) {
        this.err('badRegex', vFrom, vTo, { detail: regexErrorDetail(e) });
        return null;
      }
      if (key === 'pid') return { t: 'pid', re, from, to };
      return { t: 'str', key: key as TextKey, op, needle: v, re, from, to };
    }

    switch (key) {
      case 'tag':
      case 'message':
      case 'process':
      case 'app':
        return { t: 'str', key, op, needle: foldCase(v), from, to };
      case 'pid': {
        if (!/^\d{1,10}$/.test(v)) {
          this.err('badPid', vFrom, vTo, { value: v });
          return null;
        }
        return { t: 'pid', pid: Number(v), from, to };
      }
      case 'level': {
        const level = parseLevelName(v);
        if (!level) {
          this.err('badLevel', vFrom, vTo, { value: v });
          return null;
        }
        return { t: 'level', exact: op === '=:', level, rank: LEVEL_RANK[level], from, to };
      }
      case 'source': {
        const source = parseSourceName(v);
        if (!source) {
          this.err('badSource', vFrom, vTo, { value: v });
          return null;
        }
        return { t: 'source', source, from, to };
      }
      case 'is': {
        const what = parseIsValue(v);
        if (!what) {
          this.err('badIs', vFrom, vTo, { value: v });
          return null;
        }
        return { t: 'is', what, from, to };
      }
      case 'age': {
        const ms = parseAge(v);
        if (ms === undefined) {
          this.err('badAge', vFrom, vTo, { value: v });
          return null;
        }
        return { t: 'age', ms, from, to };
      }
    }
  }
}

function regexErrorDetail(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // "Invalid regular expression: /(/i: Unterminated group" → "Unterminated group"
  const idx = msg.lastIndexOf(': ');
  return idx >= 0 ? msg.slice(idx + 2) : msg;
}

/** Parse a query. Never throws; see ParsedQuery for the shape. */
export function parseLogQuery(source: string): ParsedQuery {
  const src = typeof source === 'string' ? source : '';
  const { tokens, lexemes } = lex(src);
  const parser = new Parser(lexemes, tokens);
  let ast: QueryNode | null = null;
  try {
    ast = parser.parseRoot();
  } catch {
    ast = null; // defensive: a parser bug must never break the Logs view
  }
  const errors = parser.errors.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const parsed: ParsedQuery = { source: src, tokens, empty: src.trim() === '', ast };
  if (errors.length) {
    parsed.error = errors[0];
    parsed.errors = errors;
  }
  return parsed;
}

const NODE_TYPES = new Set(['and', 'or', 'not', 'text', 'str', 'pid', 'level', 'source', 'is', 'age']);

/** The AST of a ParsedQuery produced by parseLogQuery (re-parses foreign/stub objects). */
export function astOf(parsed: ParsedQuery | null | undefined): QueryNode | null {
  if (!parsed) return null;
  const ast = parsed.ast as QueryNode | null | undefined;
  if (ast === null) return null;
  if (ast && typeof ast === 'object' && NODE_TYPES.has((ast as { t?: string }).t ?? '')) return ast;
  return (parseLogQuery(parsed.source ?? '').ast as QueryNode | null) ?? null;
}

/** Debug/test rendering of an AST: `(and (text "a") (not (str tag : "b")))`. */
export function astToString(node: QueryNode | null): string {
  if (!node) return '∅';
  switch (node.t) {
    case 'and':
    case 'or':
      return `(${node.t} ${node.c.map(astToString).join(' ')})`;
    case 'not':
      return `(not ${astToString(node.c)})`;
    case 'text':
      return `(text ${JSON.stringify(node.needle)})`;
    case 'str':
      return `(${node.key} ${node.op} ${JSON.stringify(node.op === '~:' ? node.re?.source : node.needle)})`;
    case 'pid':
      return node.re ? `(pid ~: ${JSON.stringify(node.re.source)})` : `(pid ${node.pid})`;
    case 'level':
      return `(level ${node.exact ? '=' : '>='} ${node.level})`;
    case 'source':
      return `(source ${node.source})`;
    case 'is':
      return `(is ${node.what})`;
    case 'age':
      return `(age ${node.ms})`;
  }
}
