/**
 * Autocomplete for the log query field.
 *
 * Context at the cursor (from the lexer):
 *  - empty field              → query history
 *  - between terms / after `-` / after `(` → keys
 *  - typing a bare word       → keys starting with it, then shortcuts (`is:crash`, `tag:OkHttp`, …)
 *  - typing a key before `:`  → keys (prefix, then subsequence: `lvl` → level)
 *  - after `key:`             → values for that key (tags/processes from data ranked prefix-first then by
 *                               frequency, apps, levels, sources, is: kinds, age presets)
 *  - inside a "phrase" / after `~:` → nothing
 * Ranges are [from, to) in the source; a value insert gets a trailing space at the end of the source.
 * `preselect` marks lists whose first item may be highlighted right away (Enter accepts it) — never for
 * free-form values the user may have typed completely (Enter must then submit what they typed).
 */
import { LOG_LEVELS } from '@durbun/protocol';
import { t } from '../../../i18n';
import type { QuerySuggestData, QuerySuggestion } from './index';
import { lex } from './lexer';
import {
  AGE_PRESETS,
  foldCase,
  formatValue,
  IS_VALUES,
  KEY_ALIASES,
  LEVEL_SPELLINGS,
  QUERY_KEYS,
  SOURCE_VALUES,
  type QueryKey,
  type QueryOp,
} from './syntax';
import './i18n';

export const MAX_SUGGESTIONS = 12;

export type SuggestContext =
  | { kind: 'history' }
  | { kind: 'none' }
  | { kind: 'empty'; from: number; to: number }
  | { kind: 'key'; prefix: string; typedKey: string; from: number; to: number; op: QueryOp }
  | { kind: 'word'; prefix: string; from: number; to: number }
  | { kind: 'value'; key: QueryKey; op: QueryOp; prefix: string; from: number; to: number; quoted: boolean };

function unescapeQuoted(raw: string): string {
  return raw.replace(/\\(["\\])/g, '$1');
}

/** What is being typed at `cursor`. */
export function suggestContext(source: string, cursor: number): SuggestContext {
  if (source.trim() === '') return { kind: 'history' };
  const c = Math.max(0, Math.min(Number.isFinite(cursor) ? Math.floor(cursor) : source.length, source.length));
  const { lexemes } = lex(source);
  for (const l of lexemes) {
    if (l.type !== 'term' || c <= l.from || c > l.to) continue;
    if (l.keyText === undefined) {
      if (l.quoted) return { kind: 'none' };
      return { kind: 'word', prefix: source.slice(l.from, c), from: l.from, to: l.to };
    }
    if (c < l.opTo) return { kind: 'key', prefix: source.slice(l.keyFrom, Math.min(c, l.keyTo)), typedKey: l.keyText, from: l.keyFrom, to: l.opTo, op: l.op! };
    if (!l.key) return { kind: 'none' };
    let prefix: string;
    if (l.quoted) {
      const closed = !l.unclosed && l.valueTo - l.valueFrom >= 2;
      const innerEnd = closed ? l.valueTo - 1 : l.valueTo;
      prefix = unescapeQuoted(source.slice(l.valueFrom + 1, Math.max(l.valueFrom + 1, Math.min(c, innerEnd))));
    } else prefix = source.slice(l.valueFrom, c);
    return { kind: 'value', key: l.key, op: l.op!, prefix, from: l.valueFrom, to: l.valueTo, quoted: l.quoted };
  }
  return { kind: 'empty', from: c, to: c };
}

function isSubsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

function keyItem(name: string, key: QueryKey, op: QueryOp, from: number, to: number): QuerySuggestion {
  const detail = name === key ? t(`logsQuery.keys.${key}`) : `${t(`logsQuery.keys.${key}`)} · ${t('logsQuery.aliasOf', { key })}`;
  return { label: `${name}${op}`, insert: `${name}${op}`, from, to, detail, kind: 'key', key, preselect: true };
}

/** `typedKey`: the complete key already in front of an operator (key context) — not offered again. */
function keyItems(prefix: string, from: number, to: number, op: QueryOp, typedKey?: string): QuerySuggestion[] {
  const p = foldCase(prefix);
  const typed = typedKey === undefined ? undefined : foldCase(typedKey);
  const out: QuerySuggestion[] = [];
  for (const k of QUERY_KEYS) {
    if (!k.startsWith(p) || k === typed) continue;
    out.push(keyItem(k, k, op, from, to));
  }
  if (p) {
    for (const [alias, k] of KEY_ALIASES) {
      if (alias.startsWith(p) && !k.startsWith(p) && alias !== typed) out.push(keyItem(alias, k, op, from, to));
    }
  }
  if (out.length === 0 && typed !== undefined && p.length >= 2) {
    for (const k of QUERY_KEYS) if (k !== typed && isSubsequence(p, k)) out.push(keyItem(k, k, op, from, to));
  }
  return out;
}

/** Prefix matches first (in the given frequency order), then contains matches. */
export function rankValues(values: readonly string[], prefix: string, max: number): string[] {
  const p = foldCase(prefix);
  const seen = new Set<string>();
  const head: string[] = [];
  const tail: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || !v || seen.has(v)) continue;
    seen.add(v);
    if (!p) {
      head.push(v);
      if (head.length >= max) break;
      continue;
    }
    const f = foldCase(v);
    if (f.startsWith(p)) {
      head.push(v);
      if (head.length >= max) break;
    } else if (tail.length < max && f.includes(p)) tail.push(v);
  }
  return head.concat(tail).slice(0, max);
}

interface AppRef {
  id: string;
  name: string;
  bundleId: string;
}

function rankApps(apps: readonly AppRef[], prefix: string, max: number): Array<{ value: string; other: string }> {
  const p = foldCase(prefix);
  const seen = new Set<string>();
  const head: Array<{ value: string; other: string }> = [];
  const tail: Array<{ value: string; other: string }> = [];
  for (const a of apps) {
    if (!a) continue;
    const name = typeof a.name === 'string' ? a.name : '';
    const bundleId = typeof a.bundleId === 'string' ? a.bundleId : '';
    const id = `${name}|${bundleId}`;
    if ((!name && !bundleId) || seen.has(id)) continue;
    seen.add(id);
    const fn = foldCase(name);
    const fb = foldCase(bundleId);
    if (!p || fn.startsWith(p)) head.push({ value: name || bundleId, other: bundleId });
    else if (fb.startsWith(p)) head.push({ value: bundleId, other: name });
    else if (fn.includes(p)) tail.push({ value: name, other: bundleId });
    else if (fb.includes(p)) tail.push({ value: bundleId, other: name });
  }
  return head.concat(tail).slice(0, max);
}

function ageDetail(value: string): string | undefined {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
  if (!m) return undefined;
  return t(`logsQuery.age.${m[2]}`, { count: Number(m[1]) });
}

function valueItems(ctx: Extract<SuggestContext, { kind: 'value' }>, data: NormalizedData, source: string): QuerySuggestion[] {
  const { key, op, prefix, from, to, quoted } = ctx;
  if (op === '~:') return [];
  const p = foldCase(prefix);
  const tail = to >= source.length ? ' ' : '';
  const item = (value: string, opts: { label?: string; detail?: string; preselect: boolean }): QuerySuggestion => ({
    label: opts.label ?? value,
    insert: formatValue(value, quoted) + tail,
    from,
    to,
    detail: opts.detail,
    kind: 'value',
    key,
    preselect: opts.preselect,
  });
  let items: QuerySuggestion[] = [];
  switch (key) {
    case 'level': {
      const levels = LOG_LEVELS.filter((l) => !p || LEVEL_SPELLINGS.some(([spelling, level]) => level === l && spelling.startsWith(p)));
      items = levels.map((l) => item(l, { detail: op === '=:' ? t('logsQuery.levelExact') : t(`logsQuery.levels.${l}`), preselect: true }));
      break;
    }
    case 'source':
      items = SOURCE_VALUES.filter((s) => !p || s.startsWith(p) || (s === 'app' && 'sdk'.startsWith(p))).map((s) =>
        item(s, { detail: t(`logsQuery.sources.${s}`), preselect: true }),
      );
      break;
    case 'is':
      items = IS_VALUES.filter((v) => v.startsWith(p)).map((v) => item(v, { detail: t(`logsQuery.is.${v}`), preselect: true }));
      break;
    case 'age': {
      const values = /^\d+(?:\.\d+)?$/.test(p) ? ['s', 'm', 'h', 'd'].map((u) => `${p}${u}`) : AGE_PRESETS.filter((a) => a.startsWith(p));
      items = values.map((v) => item(v, { detail: ageDetail(v), preselect: true }));
      break;
    }
    case 'tag':
      items = rankValues(data.tags, prefix, MAX_SUGGESTIONS).map((v) => item(v, { preselect: !p }));
      break;
    case 'process':
      items = rankValues(data.processes, prefix, MAX_SUGGESTIONS).map((v) => item(v, { preselect: !p }));
      break;
    case 'app':
      items = rankApps(data.apps, prefix, MAX_SUGGESTIONS).map((a) => item(a.value, { detail: a.other || undefined, preselect: !p }));
      break;
    default:
      return [];
  }
  // Drop what is already typed exactly: Enter must submit it, not "accept" it.
  return items.filter((s) => foldCase(s.label) !== p);
}

/**
 * Shortcuts while typing a bare word: `cr` → is:crash, `okh` → tag:OkHttp, `pati` → app:Pati. Never
 * preselected: Enter keeps searching the typed text. Data-driven shortcuts start at 3 characters.
 */
function shortcutItems(prefix: string, from: number, to: number, data: NormalizedData, source: string): QuerySuggestion[] {
  const p = foldCase(prefix);
  if (p.length < 2) return [];
  const tail = to >= source.length ? ' ' : '';
  const out: QuerySuggestion[] = [];
  const add = (key: QueryKey, value: string, detail?: string) => {
    const text = `${key}:${formatValue(value)}`;
    out.push({ label: text, insert: text + tail, from, to, detail, kind: 'value', key, preselect: false });
  };
  for (const v of IS_VALUES) if (v.startsWith(p)) add('is', v, t(`logsQuery.is.${v}`));
  if (p.length < 3) return out;
  for (const l of LOG_LEVELS) if (l !== 'error' && l.startsWith(p)) add('level', l, t(`logsQuery.levels.${l}`));
  for (const v of rankValues(data.tags, prefix, 4)) add('tag', v);
  for (const v of rankValues(data.processes, prefix, 3)) add('process', v);
  for (const a of rankApps(data.apps, prefix, 2)) add('app', a.value, a.other || undefined);
  return out;
}

function historyItems(history: readonly string[], source: string): QuerySuggestion[] {
  const out: QuerySuggestion[] = [];
  const seen = new Set<string>();
  for (const q of history) {
    const s = typeof q === 'string' ? q.trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push({ label: s, insert: s, from: 0, to: source.length, kind: 'history' });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

interface NormalizedData {
  tags: readonly string[];
  processes: readonly string[];
  apps: readonly AppRef[];
  history: readonly string[];
}

function normalize(data: QuerySuggestData | null | undefined): NormalizedData {
  return {
    tags: Array.isArray(data?.tags) ? data.tags : [],
    processes: Array.isArray(data?.processes) ? data.processes : [],
    apps: Array.isArray(data?.apps) ? data.apps : [],
    history: Array.isArray(data?.history) ? data.history : [],
  };
}

/** Suggestions for the cursor position (at most MAX_SUGGESTIONS). Never throws. */
export function suggestLogQuery(source: string, cursor: number, data: QuerySuggestData): QuerySuggestion[] {
  const src = typeof source === 'string' ? source : '';
  const d = normalize(data);
  let ctx: SuggestContext;
  try {
    ctx = suggestContext(src, cursor);
  } catch {
    return [];
  }
  switch (ctx.kind) {
    case 'history':
      return historyItems(d.history, src);
    case 'none':
      return [];
    case 'empty':
      return keyItems('', ctx.from, ctx.to, ':').slice(0, MAX_SUGGESTIONS);
    case 'key':
      return keyItems(ctx.prefix, ctx.from, ctx.to, ctx.op, ctx.typedKey).slice(0, MAX_SUGGESTIONS);
    case 'word':
      return [...keyItems(ctx.prefix, ctx.from, ctx.to, ':'), ...shortcutItems(ctx.prefix, ctx.from, ctx.to, d, src)].slice(0, MAX_SUGGESTIONS);
    case 'value':
      return valueItems(ctx, d, src).slice(0, MAX_SUGGESTIONS);
  }
}
