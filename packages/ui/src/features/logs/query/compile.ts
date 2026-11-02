/**
 * Compiles a parsed query into a fast predicate over LogEntry.
 *
 * Performance notes (200 000 entries per keystroke):
 *  - case-insensitive "contains" uses a precompiled RegExp with the `i` flag — ~7× faster in V8 than
 *    `toLowerCase().includes()` and allocation-free; equality checks the length first;
 *  - tags / process names are short: a direct regex test beats a Map memo (measured), so only the `app:`
 *    process lookup (which folds case) is memoized;
 *  - level checks are at most three string comparisons (no Set / rank lookups);
 *  - AND / OR children run cheapest first; constants fold (`level:verbose` → always true);
 *  - age cutoffs and app session sets are resolved once at compile time.
 */
import { LOG_LEVELS, type ErrorInfo, type LogEntry, type LogLevel } from '@durbun/protocol';
import type { CompiledLogQuery, LogQueryContext, ParsedQuery } from './index';
import { astOf, type QueryNode } from './parser';
import { findJsonPayload, looksLikeStackTrace } from './analysis';
import { foldCase, LEVEL_RANK, literalPattern } from './syntax';

type Pred = (e: LogEntry) => boolean;
type Built = { k: true; v: boolean } | { k: false; f: Pred; cost: number };

const ALWAYS: Pred = () => true;
const NEVER: Pred = () => false;
const MEMO_LIMIT = 4096;

const constant = (v: boolean): Built => ({ k: true, v });
const pred = (f: Pred, cost: number): Built => ({ k: false, f, cost });

/** Memoizes a string test (tags/process names repeat); resets when it grows too large. */
function memoize(test: (s: string) => boolean): (s: string) => boolean {
  let memo = new Map<string, boolean>();
  return (s) => {
    let r = memo.get(s);
    if (r === undefined) {
      r = test(s);
      if (memo.size >= MEMO_LIMIT) memo = new Map();
      memo.set(s, r);
    }
    return r;
  };
}

function errorMatches(err: ErrorInfo, test: (s: string) => boolean): boolean {
  return (typeof err.message === 'string' && test(err.message)) || (typeof err.stack === 'string' && test(err.stack));
}

interface Ctx {
  now: number;
  apps: LogQueryContext['apps'];
}

/** String test for a text key term (contains / equals / regex); null = always true (empty contains). */
function stringTest(node: Extract<QueryNode, { t: 'str' }>): ((s: string) => boolean) | null {
  if (node.op === '~:') {
    const re = node.re!;
    return (s) => re.test(s);
  }
  if (node.op === '=:') {
    const len = node.needle.length;
    const re = new RegExp(`^${literalPattern(node.needle)}$`, 'i');
    return (s) => s.length === len && re.test(s);
  }
  if (!node.needle) return null;
  const re = new RegExp(literalPattern(node.needle), 'i');
  return (s) => re.test(s);
}

function compileApp(test: (s: string) => boolean, ctx: Ctx): Built {
  const ids = new Set<string>();
  const namesByDevice = new Map<string, Set<string>>();
  for (const s of Object.values(ctx.apps ?? {})) {
    if (!s || typeof s.id !== 'string') continue;
    const app = s.app ?? ({} as Partial<typeof s.app>);
    if (!(test(s.id) || (typeof app.name === 'string' && test(app.name)) || (typeof app.id === 'string' && test(app.id)))) continue;
    ids.add(s.id);
    let names = namesByDevice.get(s.deviceId);
    if (!names) namesByDevice.set(s.deviceId, (names = new Set()));
    if (app.id) names.add(foldCase(app.id));
    if (app.processName) names.add(foldCase(app.processName));
  }
  if (ids.size === 0) return constant(false);
  // Device lines without an appId: process equals the bundle id / process name, or is a sub-process of it
  // (`com.app:remote`), on the device of a matching session.
  const byDevice = new Map<string, (p: string) => boolean>();
  for (const [deviceId, names] of namesByDevice) {
    byDevice.set(
      deviceId,
      memoize((p) => {
        const lp = foldCase(p);
        if (names.has(lp)) return true;
        const colon = lp.indexOf(':');
        return colon > 0 && names.has(lp.slice(0, colon));
      }),
    );
  }
  return pred((e) => {
    if (e.appId !== undefined) return ids.has(e.appId);
    if (e.source === 'app') return false;
    let p = e.process;
    if (p === undefined && e.source === 'system') {
      const param = e.params?.process;
      if (typeof param === 'string') p = param;
    }
    if (p === undefined) return false;
    const m = byDevice.get(e.deviceId);
    return m !== undefined && m(p);
  }, 3);
}

/** `level ≥ rank` as at most three string comparisons (cheaper than a Set or a rank lookup per entry). */
function levelAtLeast(rank: number): Pred {
  const [a, b, c] = LOG_LEVELS.slice(rank) as LogLevel[];
  const [x, y, z] = LOG_LEVELS.slice(0, rank) as LogLevel[];
  switch (rank) {
    case 1:
      return (e) => e.level !== x && e.level !== undefined;
    case 2:
      return (e) => e.level !== x && e.level !== y && e.level !== undefined;
    case 3:
      return (e) => e.level === a || e.level === b || e.level === c;
    case 4:
      return (e) => e.level === a || e.level === b;
    case 5:
      return (e) => e.level === a;
    default:
      return (e) => e.level !== x && e.level !== y && e.level !== z;
  }
}

const isFlutterTag = (tag: string): boolean => tag.length === 7 && (tag === 'flutter' || tag.toLowerCase() === 'flutter');

function hasJson(e: LogEntry): boolean {
  const d = e.data;
  if (d !== null && typeof d === 'object') return true;
  return typeof e.message === 'string' && findJsonPayload(e.message) !== null;
}

function term(node: QueryNode, ctx: Ctx): Built {
  switch (node.t) {
    case 'text': {
      if (!node.needle) return constant(true);
      const re = new RegExp(literalPattern(node.needle), 'i');
      const test = (s: string) => re.test(s);
      return pred(
        (e) => re.test(e.tag ?? '') || (e.process !== undefined && re.test(e.process)) || re.test(e.message ?? '') || (e.error !== undefined && errorMatches(e.error, test)),
        10,
      );
    }
    case 'str': {
      const test = stringTest(node);
      if (!test) return constant(true);
      switch (node.key) {
        case 'tag':
          return pred((e) => test(e.tag ?? ''), 3);
        case 'process':
          return pred((e) => test(e.process ?? ''), 3);
        case 'message':
          if (node.op === '=:') return pred((e) => test(e.message ?? ''), 4);
          return pred((e) => test(e.message ?? '') || (e.error !== undefined && errorMatches(e.error, test)), node.op === '~:' ? 15 : 8);
        case 'app':
          return compileApp(test, ctx);
      }
      return constant(true);
    }
    case 'pid': {
      if (node.re) {
        const re = node.re;
        return pred((e) => e.pid !== undefined && re.test(String(e.pid)), 4);
      }
      const pid = node.pid;
      return pred((e) => e.pid === pid, 1);
    }
    case 'level': {
      if (node.exact) {
        const level = node.level;
        return pred((e) => e.level === level, 1);
      }
      if (node.rank <= 0) return constant(true);
      return pred(levelAtLeast(node.rank), 1);
    }
    case 'source': {
      const source = node.source;
      return pred((e) => e.source === source, 1);
    }
    case 'age': {
      const cutoff = ctx.now - node.ms;
      return pred((e) => e.ts >= cutoff, 1);
    }
    case 'is':
      switch (node.what) {
        case 'crash':
          return pred((e) => e.kind === 'crash', 1);
        case 'anr':
          return pred((e) => e.kind === 'anr', 1);
        case 'network':
          return pred((e) => e.kind === 'network', 1);
        case 'event':
          return pred((e) => e.kind === 'event', 1);
        case 'marker':
          return pred((e) => e.kind === 'marker', 1);
        case 'error':
          return pred((e) => e.level === 'error' || e.level === 'fatal', 1);
        case 'json':
          return pred(hasJson, 20);
        case 'stacktrace':
          return pred((e) => looksLikeStackTrace(e), 12);
        case 'flutter': {
          const flutterApps = new Set<string>();
          for (const s of Object.values(ctx.apps ?? {})) {
            const platform = s?.sdk?.platform;
            if (platform === 'flutter' || platform === 'dart-vm') flutterApps.add(s.id);
          }
          return pred((e) => e.kind === 'flutter-error' || isFlutterTag(e.tag ?? '') || (e.appId !== undefined && flutterApps.has(e.appId)), 2);
        }
      }
      return constant(true);
    default:
      return constant(true);
  }
}

function combine(kind: 'and' | 'or', parts: Built[]): Built {
  const preds: Array<{ f: Pred; cost: number }> = [];
  for (const p of parts) {
    if (p.k) {
      // and: false absorbs, true is neutral; or: true absorbs, false is neutral
      if (kind === 'and' ? !p.v : p.v) return constant(kind === 'or');
      continue;
    }
    preds.push(p);
  }
  if (preds.length === 0) return constant(kind === 'and');
  if (preds.length === 1) return pred(preds[0]!.f, preds[0]!.cost);
  preds.sort((a, b) => a.cost - b.cost);
  const cost = preds.reduce((s, p) => s + p.cost, 0);
  const fs = preds.map((p) => p.f);
  if (kind === 'and') {
    if (fs.length === 2) {
      const [a, b] = fs as [Pred, Pred];
      return pred((e) => a(e) && b(e), cost);
    }
    if (fs.length === 3) {
      const [a, b, c] = fs as [Pred, Pred, Pred];
      return pred((e) => a(e) && b(e) && c(e), cost);
    }
    return pred((e) => {
      for (let i = 0; i < fs.length; i++) if (!fs[i]!(e)) return false;
      return true;
    }, cost);
  }
  if (fs.length === 2) {
    const [a, b] = fs as [Pred, Pred];
    return pred((e) => a(e) || b(e), cost);
  }
  if (fs.length === 3) {
    const [a, b, c] = fs as [Pred, Pred, Pred];
    return pred((e) => a(e) || b(e) || c(e), cost);
  }
  return pred((e) => {
    for (let i = 0; i < fs.length; i++) if (fs[i]!(e)) return true;
    return false;
  }, cost);
}

function build(node: QueryNode, ctx: Ctx): Built {
  switch (node.t) {
    case 'and':
    case 'or':
      return combine(node.t, node.c.map((c) => build(c, ctx)));
    case 'not': {
      const inner = build(node.c, ctx);
      if (inner.k) return constant(!inner.v);
      const f = inner.f;
      return pred((e) => !f(e), inner.cost);
    }
    default:
      return term(node, ctx);
  }
}

function walk(node: QueryNode | null, visit: (n: QueryNode, negated: boolean) => void, negated = false): void {
  if (!node) return;
  visit(node, negated);
  if (node.t === 'and' || node.t === 'or') for (const c of node.c) walk(c, visit, negated);
  else if (node.t === 'not') walk(node.c, visit, !negated);
}

function collectHighlights(root: QueryNode | null): Array<string | RegExp> {
  const out: Array<string | RegExp> = [];
  const seen = new Set<string>();
  walk(root, (n, negated) => {
    if (negated) return;
    if (n.t === 'text' || (n.t === 'str' && n.key === 'message' && n.op === ':')) {
      if (n.needle && !seen.has(n.needle)) {
        seen.add(n.needle);
        out.push(n.needle);
      }
    } else if (n.t === 'str' && n.key === 'message' && n.op === '~:' && n.re && n.re.source !== '(?:)') {
      const key = `/${n.re.source}/`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(new RegExp(n.re.source, 'gi'));
      }
    }
  });
  return out;
}

/**
 * Compile a parsed query (best-effort AST when it has errors) into a predicate. Never throws.
 * `highlights`: positive free-text / `message:` needles (folded lowercase strings) and `message~:` regexes
 * (RegExp with the `g` and `i` flags — use matchAll/exec, or `queryHighlightRanges`).
 */
export function compileLogQuery(parsed: ParsedQuery, ctx: LogQueryContext): CompiledLogQuery {
  const root = astOf(parsed);
  if (!root) return { test: ALWAYS, matchesAll: true, hasAge: false, highlights: [] };
  const c: Ctx = { now: typeof ctx?.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : Date.now(), apps: ctx?.apps ?? {} };
  let hasAge = false;
  walk(root, (n) => {
    if (n.t === 'age') hasAge = true;
  });
  let built: Built;
  try {
    built = build(root, c);
  } catch {
    built = constant(true); // defensive: never break the list
  }
  const highlights = collectHighlights(root);
  if (built.k) return { test: built.v ? ALWAYS : NEVER, matchesAll: built.v, hasAge, highlights: built.v ? [] : highlights };
  return { test: built.f, matchesAll: false, hasAge, highlights };
}

/** Lower bound on the level of matching entries implied by a node (rank), if any. */
function levelBound(node: QueryNode): number | undefined {
  switch (node.t) {
    case 'level':
      return node.rank;
    case 'is':
      return node.what === 'error' ? LEVEL_RANK.error : undefined;
    case 'and': {
      let best: number | undefined;
      for (const c of node.c) {
        const b = levelBound(c);
        if (b !== undefined && (best === undefined || b > best)) best = b;
      }
      return best;
    }
    case 'or': {
      let worst: number | undefined;
      for (const c of node.c) {
        const b = levelBound(c);
        if (b === undefined) return undefined;
        if (worst === undefined || b < worst) worst = b;
      }
      return worst;
    }
    default:
      return undefined;
  }
}

/**
 * Lowest level every match must have, implied by `level:` terms AND-ed at the root (also through groups,
 * OR branches that all carry a bound, and `is:error`). Undefined when unrestricted (or only `level:verbose`).
 */
export function queryMinLevel(parsed: ParsedQuery): LogLevel | undefined {
  const root = astOf(parsed);
  if (!root) return undefined;
  const rank = levelBound(root);
  return rank !== undefined && rank > 0 ? LOG_LEVELS[rank] : undefined;
}

/** The query refers to app sessions (`app:` or `is:flutter`): recompile when the app list changes. */
export function queryUsesApps(parsed: ParsedQuery): boolean {
  let uses = false;
  walk(astOf(parsed), (n) => {
    if ((n.t === 'str' && n.key === 'app') || (n.t === 'is' && n.what === 'flutter')) uses = true;
  });
  return uses;
}

const stringPatterns = new Map<string, RegExp>();

/**
 * Highlight ranges `[start, end)` of `highlights` (from CompiledLogQuery) inside `text`, sorted and merged.
 * Uses the same case folding as matching (İ ≡ i), so ranges are exact even where `toLowerCase` would
 * change the length.
 */
export function queryHighlightRanges(text: string, highlights: ReadonlyArray<string | RegExp>, max = 200): Array<[number, number]> {
  if (!text || highlights.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const h of highlights) {
    let re: RegExp;
    if (typeof h === 'string') {
      if (!h) continue;
      let cached = stringPatterns.get(h);
      if (!cached) {
        if (stringPatterns.size > 256) stringPatterns.clear();
        cached = new RegExp(literalPattern(foldCase(h)), 'gi');
        stringPatterns.set(h, cached);
      }
      re = cached;
    } else {
      re = h.global ? h : new RegExp(h.source, `${h.flags}g`);
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && ranges.length < max && guard++ < max * 4) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push([m.index, m.index + m[0].length]);
    }
    re.lastIndex = 0;
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
