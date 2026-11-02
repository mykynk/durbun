/**
 * Tokenizer for the log query language. Produces
 *  - `tokens`: highlighting tokens covering the whole source in order (whitespace included), and
 *  - `lexemes`: the syntactic units the parser and the autocomplete work on.
 *
 * Lexical rules
 *  - `(` `)` group, `|` (or `||`) OR, a `-` directly before a term negates it.
 *  - `key:value`, `key=:value`, `key~:value` where key is `[A-Za-z_][A-Za-z0-9_]*`. `scheme://…` is free text.
 *  - Values / words run to the next whitespace, `|` or unbalanced `)`; parentheses inside a word stay part of
 *    it (`onCreate()`). Regex values (`~:`) also keep `|`, `\x` escapes, `[…]` classes and whitespace inside
 *    groups (`tag~:ok|dio`, `message~:time(d )?out`).
 *  - `"…"` quotes a phrase or a value; inside quotes `\"` and `\\` are escapes, other backslashes are literal.
 */
import type { QueryToken, QueryTokenKind } from './index';
import { lookupKey, type QueryKey, type QueryOp } from './syntax';

export interface TermLexeme {
  type: 'term';
  from: number;
  to: number;
  /** Key exactly as typed (`Tag`, `msg`…); absent for free text / phrases. */
  keyText?: string;
  /** Canonical key; absent for free text and for unknown keys. */
  key?: QueryKey;
  keyFrom: number;
  keyTo: number;
  op?: QueryOp;
  opTo: number;
  /** Unescaped value without quotes (free text: the word / phrase). */
  value: string;
  /** Raw value span, quotes included. */
  valueFrom: number;
  valueTo: number;
  quoted: boolean;
  /** An opening quote without a closing one (the value runs to the end of the source). */
  unclosed: boolean;
}

export type Lexeme =
  | { type: 'lparen' | 'rparen' | 'or'; from: number; to: number; tok: number }
  | { type: 'neg'; from: number; to: number; tok: number; dangling: boolean }
  | TermLexeme;

export interface LexResult {
  tokens: QueryToken[];
  lexemes: Lexeme[];
}

const KEY_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const WS_RE = /\s/;

export function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WS_RE.test(ch);
}

/** Regex value scan; `spaces` lets whitespace continue inside a group / class. `closed`: no construct left open. */
function scanRegex(src: string, i: number, spaces: boolean): { end: number; closed: boolean } {
  const n = src.length;
  let depth = 0;
  let inClass = false;
  while (i < n) {
    const ch = src[i]!;
    if (WS_RE.test(ch) && (!spaces || (depth === 0 && !inClass))) break;
    if (ch === '\\') {
      i = Math.min(n, i + 2);
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  return { end: i, closed: !(i >= n && (depth > 0 || inClass)) };
}

/**
 * End of a bare word/value starting at `i`. Regex values keep whitespace inside a group or a character
 * class when that group closes (`message~:time(d )?out`); an unclosed group stops at whitespace so it never
 * swallows the rest of the query. Everywhere else whitespace ends the word.
 */
export function scanBare(src: string, i: number, regex: boolean): number {
  if (regex) {
    const greedy = scanRegex(src, i, true);
    return greedy.closed ? greedy.end : scanRegex(src, i, false).end;
  }
  const n = src.length;
  let depth = 0;
  while (i < n) {
    const ch = src[i]!;
    if (WS_RE.test(ch)) break;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    } else if (ch === '|' && depth === 0) break;
    i++;
  }
  return i;
}

/** Quoted string starting at `i` (src[i] === '"'). */
export function scanQuoted(src: string, i: number): { end: number; value: string; closed: boolean } {
  const n = src.length;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const ch = src[j]!;
    if (ch === '\\' && j + 1 < n) {
      const next = src[j + 1]!;
      if (next === '"' || next === '\\') {
        out += next;
        j += 2;
        continue;
      }
    }
    if (ch === '"') return { end: j + 1, value: out, closed: true };
    out += ch;
    j++;
  }
  return { end: n, value: out, closed: false };
}

export function lex(src: string): LexResult {
  const tokens: QueryToken[] = [];
  const lexemes: Lexeme[] = [];
  const n = src.length;

  const push = (kind: QueryTokenKind, from: number, to: number, key?: QueryKey): number => {
    const token: QueryToken = { kind, from, to, text: src.slice(from, to) };
    if (key) token.key = key;
    tokens.push(token);
    return tokens.length - 1;
  };

  let i = 0;
  while (i < n) {
    const ch = src[i]!;

    if (WS_RE.test(ch)) {
      let j = i + 1;
      while (j < n && WS_RE.test(src[j]!)) j++;
      push('whitespace', i, j);
      i = j;
      continue;
    }
    if (ch === '(' || ch === ')') {
      lexemes.push({ type: ch === '(' ? 'lparen' : 'rparen', from: i, to: i + 1, tok: push('paren', i, i + 1) });
      i++;
      continue;
    }
    if (ch === '|') {
      const j = src[i + 1] === '|' ? i + 2 : i + 1; // `||` is accepted as one OR
      lexemes.push({ type: 'or', from: i, to: j, tok: push('or', i, j) });
      i = j;
      continue;
    }
    if (ch === '-') {
      const next = src[i + 1];
      const dangling = next === undefined || WS_RE.test(next) || next === '|' || next === ')';
      lexemes.push({ type: 'neg', from: i, to: i + 1, tok: push('negation', i, i + 1), dangling });
      i++;
      continue;
    }
    if (ch === '"') {
      const q = scanQuoted(src, i);
      push('phrase', i, q.end);
      lexemes.push({
        type: 'term',
        from: i,
        to: q.end,
        keyFrom: i,
        keyTo: i,
        opTo: i,
        value: q.value,
        valueFrom: i,
        valueTo: q.end,
        quoted: true,
        unclosed: !q.closed,
      });
      i = q.end;
      continue;
    }

    // key term?
    KEY_RE.lastIndex = i;
    const km = KEY_RE.exec(src);
    if (km) {
      const keyEnd = i + km[0].length;
      const c1 = src[keyEnd];
      let op: QueryOp | undefined;
      let opEnd = keyEnd;
      if (c1 === ':') {
        op = ':';
        opEnd = keyEnd + 1;
      } else if ((c1 === '=' || c1 === '~') && src[keyEnd + 1] === ':') {
        op = c1 === '=' ? '=:' : '~:';
        opEnd = keyEnd + 2;
      }
      // `https://…` is a URL, not a key.
      if (op && !(op === ':' && src.startsWith('//', opEnd))) {
        const keyText = km[0];
        const key = lookupKey(keyText);
        push(key ? 'key' : 'error', i, keyEnd, key);
        push('operator', keyEnd, opEnd, key);
        let value: string;
        let valueEnd: number;
        let quoted = false;
        let unclosed = false;
        if (src[opEnd] === '"') {
          const q = scanQuoted(src, opEnd);
          value = q.value;
          valueEnd = q.end;
          quoted = true;
          unclosed = !q.closed;
        } else {
          valueEnd = scanBare(src, opEnd, op === '~:');
          value = src.slice(opEnd, valueEnd);
        }
        if (valueEnd > opEnd) push('value', opEnd, valueEnd, key);
        const term: TermLexeme = {
          type: 'term',
          from: i,
          to: valueEnd,
          keyText,
          keyFrom: i,
          keyTo: keyEnd,
          op,
          opTo: opEnd,
          value,
          valueFrom: opEnd,
          valueTo: valueEnd,
          quoted,
          unclosed,
        };
        if (key) term.key = key;
        lexemes.push(term);
        i = valueEnd;
        continue;
      }
    }

    // free-text word
    const end = Math.max(i + 1, scanBare(src, i, false));
    push('text', i, end);
    lexemes.push({
      type: 'term',
      from: i,
      to: end,
      keyFrom: i,
      keyTo: i,
      opTo: i,
      value: src.slice(i, end),
      valueFrom: i,
      valueTo: end,
      quoted: false,
      unclosed: false,
    });
    i = end;
  }
  return { tokens, lexemes };
}
