/**
 * Templates: `{{ expression }}` inside any string parameter.
 *
 *   {{login.body.token}}              node output (node id `login`)
 *   {{getCart.headers['x-total']}}     bracket keys for names with dashes
 *   {{getCart.body.items[0].id}}       array index
 *   {{vars.orderId}} {{env.baseUrl}} {{input.email}} {{target.appId}} {{trigger.message}} {{run.id}}
 *   {{$uuid}} {{$now}} {{$timestamp}} {{$randomInt(1, 100)}} {{$randomString(8)}} {{$randomEmail}}
 *   {{login.body.items | length}}      pipes: json, length, upper, lower, trim, first, last, urlencode, base64, default('x'), string, number
 *
 * A string that is exactly one template keeps the value's type (a number stays a number, an object an object);
 * templates inside longer text are converted to text (objects as JSON).
 *
 * A template is a path, never an expression: `{{a.b > 0}}` is a syntax error (comparisons belong in condition
 * rules). A `}}` without a `{{` before it is literal text (nested JSON ends in `}}`); an unclosed `{{` is an error.
 * Helper and pipe arguments are fixed values: numbers, true/false/null or quoted text ('x', "x", \' escapes a quote).
 */

export const RESERVED_ROOTS: ReadonlySet<string> = new Set(['env', 'vars', 'input', 'target', 'trigger', 'run', 'item']);

export type PathSegment = string | number;

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly code: 'template.syntax' | 'template.unknownRoot' | 'template.unknownHelper' | 'template.unknownPipe',
    readonly ref: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;

interface TemplateSpan {
  /** Index of `{{`. */
  start: number;
  /** Index after `}}`. */
  end: number;
  /** The text between the braces (untrimmed). */
  expr: string;
}

/**
 * The `{{ … }}` spans of a string, left to right. A `}}` inside a quoted argument does not close the template;
 * `unclosed` is set when a `{{` has no `}}` after it (that `{{` and the rest stay text).
 */
function scanTemplates(value: string): { spans: TemplateSpan[]; unclosed?: 'braces' | 'quote' } {
  const spans: TemplateSpan[] = [];
  let from = 0;
  for (;;) {
    const open = value.indexOf('{{', from);
    if (open < 0) return { spans };
    let close = -1;
    let quote: string | null = null;
    for (let j = open + 2; j < value.length - 1; j++) {
      const c = value[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') quote = c;
      else if (c === '}' && value[j + 1] === '}') {
        close = j;
        break;
      }
    }
    let unclosedQuote = false;
    if (close < 0) {
      // A stray quote (e.g. `[\"a\"]` copied out of a JSON string): fall back to the first `}}`.
      close = value.indexOf('}}', open + 2);
      unclosedQuote = close >= 0;
      if (close < 0) return { spans, unclosed: quote ? 'quote' : 'braces' };
    }
    spans.push({ start: open, end: close + 2, expr: value.slice(open + 2, close) });
    if (unclosedQuote) return { spans, unclosed: 'quote' };
    from = close + 2;
  }
}

/** Replace every template span of a string. */
function replaceTemplates(value: string, fn: (expr: string, whole: string) => string): string {
  const { spans } = scanTemplates(value);
  if (spans.length === 0) return value;
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += value.slice(at, s.start) + fn(s.expr, value.slice(s.start, s.end));
    at = s.end;
  }
  return out + value.slice(at);
}

export function hasTemplate(value: string): boolean {
  return scanTemplates(value).spans.length > 0;
}

/** The template expressions in a string, trimmed (e.g. ['login.body.token']). */
export function templateExpressions(value: string): string[] {
  return scanTemplates(value).spans.map((s) => s.expr.trim());
}

/** Root names a string's templates read (`login` for {{login.body.token}}; helpers like $uuid are left out). */
export function templateRoots(value: string): string[] {
  const roots: string[] = [];
  for (const expr of templateExpressions(value)) {
    const head = splitPipes(expr)[0]?.trim() ?? '';
    const m = IDENT.exec(head);
    if (m && !m[0].startsWith('$')) roots.push(m[0]);
  }
  return roots;
}

/** Every template root used anywhere inside a JSON-like value. */
export function collectTemplateRoots(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const r of templateRoots(value)) into.add(r);
  } else if (Array.isArray(value)) {
    for (const v of value) collectTemplateRoots(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectTemplateRoots(v, into);
  }
  return into;
}

/** Parse `a.b[0]['c-d']` (optionally starting with `$.` or `$`) into segments. */
export function parsePath(path: string): PathSegment[] {
  let s = path.trim();
  if (s.startsWith('$.')) s = s.slice(2);
  else if (s === '$') return [];
  else if (s.startsWith('$[')) s = s.slice(1);
  const out: PathSegment[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '.') {
      i++;
      continue;
    }
    if (c === '[') {
      const close = findClosingBracket(s, i);
      if (close < 0) throw new TemplateError(`Missing ] in "${path}"`, 'template.syntax', path);
      const inner = s.slice(i + 1, close).trim();
      if (/^-?\d+$/.test(inner)) out.push(Number(inner));
      else if (inner.length >= 2 && ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"')))) out.push(inner.slice(1, -1).replace(/\\(.)/g, '$1'));
      else if (inner === '*') throw new TemplateError(`Wildcards are not supported in "${path}"`, 'template.syntax', path);
      else out.push(inner);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    const name = s.slice(i, j).trim();
    if (name) out.push(name);
    i = j;
  }
  return out;
}

function findClosingBracket(s: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === ']') return i;
  }
  return -1;
}

/** Characters that make a template head an expression rather than a path (outside brackets and quotes). */
const EXPRESSION_CHARS = /[\s<>=!&|+*/%?:,;()]/;

/**
 * Why the path part of a template head (`.body.items[0]`) is not a path, or null. Templates read values; they
 * cannot compare or compute (`{{a.b > 0}}`, `{{a || b}}`, `{{!a}}`).
 */
function pathProblem(head: string, rest: string): string | null {
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === '[') {
      const close = findClosingBracket(rest, i);
      if (close < 0) return `Missing ] in "${head}"`;
      i = close;
      continue;
    }
    if (EXPRESSION_CHARS.test(c)) {
      return `"${head}" is not a path: templates read a value (login.body.token) and cannot compare or compute — use a condition rule or a pipe instead of "${c.trim() || 'a space'}"`;
    }
  }
  return null;
}

/** Read a path from a value. `length` works on arrays and strings; headers are matched case-insensitively. */
export function getPath(value: unknown, segments: readonly PathSegment[]): unknown {
  let cur: unknown = value;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg < 0 ? cur.length + seg : seg];
      continue;
    }
    if (seg === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length;
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    const obj = cur as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, seg)) {
      cur = obj[seg];
      continue;
    }
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      cur = cur[Number(seg)];
      continue;
    }
    const lower = seg.toLowerCase();
    const key = Object.keys(obj).find((k) => k.toLowerCase() === lower);
    cur = key === undefined ? undefined : obj[key];
  }
  return cur;
}

/* ────────────────────────────── evaluation ────────────────────────────── */

export type TemplateScope = Record<string, unknown>;

export interface ResolveOptions {
  /** Unknown roots throw (default true); false leaves them empty. */
  strict?: boolean;
}

function splitPipes(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '|' && expr[i + 1] === '|') i++; // `||` is an operator, not two pipes (the path check rejects it)
    else if (c === '|' && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/** Helper and pipe arguments: numbers, true/false/null and quoted text (`\'` / `\"` / `\\` escape inside quotes). */
function parseArgs(text: string, ref: string): unknown[] {
  const s = text.trim();
  if (!s) return [];
  const out: unknown[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === ',') i++;
    if (i >= s.length) break;
    const c = s[i]!;
    if (c === "'" || c === '"') {
      let value = '';
      let j = i + 1;
      for (; j < s.length && s[j] !== c; j++) {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        value += s[j];
      }
      if (j >= s.length) throw new TemplateError(`Unclosed quote in "${ref}"`, 'template.syntax', ref);
      out.push(value);
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ',') j++;
      const raw = s.slice(i, j).trim();
      const n = Number(raw);
      if (raw === 'true' || raw === 'false' || raw === 'null') out.push(raw === 'null' ? null : raw === 'true');
      else if (raw !== '' && Number.isFinite(n)) out.push(n);
      else {
        throw new TemplateError(
          `Argument ${raw} in "${ref}" must be a fixed value: a number, true/false or text in quotes ('${raw}'); arguments cannot read paths`,
          'template.syntax',
          ref,
        );
      }
      i = j;
    }
  }
  return out;
}

function randomHex(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const h = randomHex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const TEMPLATE_HELPERS: Readonly<Record<string, { description: string; run: (args: unknown[]) => unknown }>> = {
  $uuid: { description: 'Random UUID v4', run: () => uuid() },
  $now: { description: 'Current time, ISO 8601', run: () => new Date().toISOString() },
  $timestamp: { description: 'Current time in epoch milliseconds (number)', run: () => Date.now() },
  $randomInt: {
    description: '$randomInt(min, max): whole number between min and max (inclusive)',
    run: (args) => {
      const min = Math.ceil(Number(args[0] ?? 0));
      const max = Math.floor(Number(args[1] ?? 1_000_000));
      return min + Math.floor(Math.random() * (Math.max(max, min) - min + 1));
    },
  },
  $randomString: {
    description: '$randomString(length): random lower-case letters and digits (default 8)',
    run: (args) => {
      const n = Math.min(Math.max(Math.floor(Number(args[0] ?? 8)) || 8, 1), 256);
      let s = '';
      for (let i = 0; i < n; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)];
      return s;
    },
  },
  $randomEmail: { description: 'Random e-mail address at example.com', run: () => `qa+${Date.now().toString(36)}${randomHex(4)}@example.com` },
};

function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function base64(text: string): string {
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: { from(s: string, e: string): { toString(e: string): string } } };
  if (g.Buffer) return g.Buffer.from(text, 'utf8').toString('base64');
  if (g.btoa) return g.btoa(unescape(encodeURIComponent(text)));
  return text;
}

export const TEMPLATE_PIPES: Readonly<Record<string, { description: string; run: (v: unknown, args: unknown[]) => unknown }>> = {
  json: { description: 'Value as JSON text', run: (v) => JSON.stringify(v ?? null) },
  string: { description: 'Value as text', run: (v) => toText(v) },
  number: { description: 'Value as a number', run: (v) => Number(v) },
  length: { description: 'Length of a list, text or object', run: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0) },
  upper: { description: 'Upper case', run: (v) => toText(v).toUpperCase() },
  lower: { description: 'Lower case', run: (v) => toText(v).toLowerCase() },
  trim: { description: 'Without surrounding spaces', run: (v) => toText(v).trim() },
  first: { description: 'First item of a list', run: (v) => (Array.isArray(v) ? v[0] : v) },
  last: { description: 'Last item of a list', run: (v) => (Array.isArray(v) ? v[v.length - 1] : v) },
  urlencode: { description: 'URL-encoded text', run: (v) => encodeURIComponent(toText(v)) },
  base64: { description: 'Base64 of the text', run: (v) => base64(toText(v)) },
  default: { description: "default('x'): x when the value is empty", run: (v, args) => (v === undefined || v === null || v === '' ? args[0] : v) },
};

const HELPER_RE = /^(\$[A-Za-z]+)\s*(?:\(([\s\S]*)\))?$/;
const PIPE_RE = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:\(([\s\S]*)\))?\s*$/;

/** Evaluate one expression (the text between {{ and }}). */
export function evaluateExpression(expr: string, scope: TemplateScope, opts: ResolveOptions = {}): unknown {
  const parts = splitPipes(expr);
  const head = (parts[0] ?? '').trim();
  let value: unknown;
  if (head.startsWith('$')) {
    const m = HELPER_RE.exec(head);
    const helper = m ? TEMPLATE_HELPERS[m[1]!] : undefined;
    if (!m || !helper) throw new TemplateError(`Unknown helper "${head}"`, 'template.unknownHelper', expr);
    value = helper.run(parseArgs(m[2] ?? '', expr));
  } else {
    const root = IDENT.exec(head)?.[0];
    if (!root) throw new TemplateError(`Cannot read "${head}"`, 'template.syntax', expr);
    const rest = head.slice(root.length);
    const problem = pathProblem(head, rest);
    if (problem) throw new TemplateError(problem, 'template.syntax', expr);
    if (!Object.prototype.hasOwnProperty.call(scope, root)) {
      if (opts.strict === false) value = undefined;
      else throw new TemplateError(`Nothing named "${root}" yet (a node id, vars, env, input, target, trigger or run)`, 'template.unknownRoot', expr);
    } else {
      value = getPath(scope[root], parsePath(rest));
    }
  }
  for (const pipe of parts.slice(1)) {
    const m = PIPE_RE.exec(pipe);
    const fn = m ? TEMPLATE_PIPES[m[1]!] : undefined;
    if (!m || !fn) throw new TemplateError(`Unknown pipe "${pipe.trim()}"`, 'template.unknownPipe', expr);
    value = fn.run(value, parseArgs(m[2] ?? '', expr));
  }
  return value;
}

/** Resolve the templates in a string. Exactly one template → the raw value; otherwise text. */
export function resolveTemplate(value: string, scope: TemplateScope, opts: ResolveOptions = {}): unknown {
  if (!value.includes('{{')) return value;
  const { spans } = scanTemplates(value);
  if (spans.length === 1 && spans[0]!.start === 0 && spans[0]!.end === value.length) return evaluateExpression(spans[0]!.expr.trim(), scope, opts);
  return replaceTemplates(value, (expr) => toText(evaluateExpression(expr.trim(), scope, opts)));
}

/** Resolve the templates in a string and always return text. */
export function resolveText(value: unknown, scope: TemplateScope, opts: ResolveOptions = {}): string {
  if (typeof value !== 'string') return toText(value);
  return toText(resolveTemplate(value, scope, opts));
}

/** Resolve every string inside a JSON-like value (keys stay as they are). */
export function resolveDeep(value: unknown, scope: TemplateScope, opts: ResolveOptions = {}): unknown {
  if (typeof value === 'string') return resolveTemplate(value, scope, opts);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope, opts));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveDeep(v, scope, opts);
    return out;
  }
  return value;
}

/** Check a string's template syntax without a scope: the first problem, or null. */
export function templateSyntaxError(value: string): string | null {
  const { spans, unclosed } = scanTemplates(value);
  for (const span of spans) {
    const expr = span.expr.trim();
    if (!expr) return 'Empty {{ }}';
    const parts = splitPipes(expr);
    const head = parts[0]!.trim();
    try {
      if (head.startsWith('$')) {
        const m = HELPER_RE.exec(head);
        if (!m || !TEMPLATE_HELPERS[m[1]!]) return `Unknown helper "${head}"`;
        parseArgs(m[2] ?? '', expr);
      } else {
        const root = IDENT.exec(head)?.[0];
        if (!root) return `Cannot read "${head}"`;
        const problem = pathProblem(head, head.slice(root.length));
        if (problem) return problem;
        parsePath(head.slice(root.length));
      }
      for (const pipe of parts.slice(1)) {
        const m = PIPE_RE.exec(pipe);
        if (!m || !TEMPLATE_PIPES[m[1]!]) return `Unknown pipe "${pipe.trim()}"`;
        parseArgs(m[2] ?? '', expr);
      }
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (unclosed === 'quote') return 'Unclosed quote inside {{ }}';
  if (unclosed === 'braces') return 'Unclosed {{ (every {{ needs a }} after it)';
  return null;
}

/** Replace a root name (a node id) in every template of a value. */
export function renameTemplateRoot(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    return replaceTemplates(value, (expr, whole) => {
      const lead = /^\s*/.exec(expr)![0];
      const body = expr.slice(lead.length);
      // `from` may be an id being fixed (`get-cart`): compare the text, then check that the name ends there.
      if (!body.startsWith(from) || /[A-Za-z0-9_$-]/.test(body[from.length] ?? '')) return whole;
      return `{{${lead}${to}${body.slice(from.length)}}}`;
    });
  }
  if (Array.isArray(value)) return value.map((v) => renameTemplateRoot(v, from, to));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renameTemplateRoot(v, from, to);
    return out;
  }
  return value;
}
