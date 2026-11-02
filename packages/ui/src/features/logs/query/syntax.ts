/**
 * Vocabulary of the log query language (keys, operators, level / source / is: values, age units) and the
 * case folding shared by the parser, the compiler and the autocomplete.
 */
import { LOG_LEVELS, type LogLevel, type LogSource } from '@durbun/protocol';

/** Canonical query keys (aliases: `msg` → message, `package` → process). */
export type QueryKey = 'tag' | 'message' | 'process' | 'pid' | 'level' | 'source' | 'app' | 'is' | 'age';
export type QueryOp = ':' | '=:' | '~:';
export type IsValue = 'crash' | 'anr' | 'error' | 'json' | 'network' | 'event' | 'marker' | 'stacktrace' | 'flutter';

/** Display / suggestion order of the keys. */
export const QUERY_KEYS: readonly QueryKey[] = ['level', 'tag', 'message', 'process', 'app', 'is', 'source', 'age', 'pid'];

/** Alternative spellings accepted by the parser (shown by the autocomplete when typed). */
export const KEY_ALIASES: ReadonlyArray<readonly [alias: string, key: QueryKey]> = [
  ['msg', 'message'],
  ['package', 'process'],
];

const KEY_LOOKUP = new Map<string, QueryKey>([...QUERY_KEYS.map((k) => [k, k] as const), ...KEY_ALIASES]);

/** Operators each key accepts. `:` = contains (level: ≥, enums: equals), `=:` = equals, `~:` = regex. */
export const KEY_OPERATORS: Readonly<Record<QueryKey, readonly QueryOp[]>> = {
  tag: [':', '=:', '~:'],
  message: [':', '=:', '~:'],
  process: [':', '=:', '~:'],
  app: [':', '=:', '~:'],
  pid: [':', '=:', '~:'],
  level: [':', '=:'],
  source: [':', '=:'],
  is: [':', '=:'],
  age: [':'],
};

export const IS_VALUES: readonly IsValue[] = ['crash', 'anr', 'error', 'json', 'network', 'event', 'marker', 'stacktrace', 'flutter'];
export const SOURCE_VALUES: readonly LogSource[] = ['device', 'app', 'system'];
export const AGE_PRESETS: readonly string[] = ['30s', '1m', '5m', '15m', '1h'];

const IS_LOOKUP = new Set<string>(IS_VALUES);
const SOURCE_LOOKUP = new Map<string, LogSource>([
  ['device', 'device'],
  ['app', 'app'],
  ['sdk', 'app'],
  ['system', 'system'],
]);
const LEVEL_LOOKUP = new Map<string, LogLevel>([
  ['v', 'verbose'],
  ['verbose', 'verbose'],
  ['d', 'debug'],
  ['debug', 'debug'],
  ['i', 'info'],
  ['info', 'info'],
  ['w', 'warn'],
  ['warn', 'warn'],
  ['warning', 'warn'],
  ['e', 'error'],
  ['error', 'error'],
  ['f', 'fatal'],
  ['fatal', 'fatal'],
  ['a', 'fatal'],
  ['assert', 'fatal'],
]);

/** Every spelling accepted for a level (for prefix matching in the autocomplete). */
export const LEVEL_SPELLINGS: ReadonlyArray<readonly [spelling: string, level: LogLevel]> = [...LEVEL_LOOKUP];

export const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.fromEntries(LOG_LEVELS.map((l, i) => [l, i])) as Record<LogLevel, number>;

export const AGE_UNITS: Readonly<Record<'s' | 'm' | 'h' | 'd', number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Case folding used everywhere in the query language: plain `toLowerCase()` (never the Turkish locale),
 * except that the dotted capital İ folds to a plain `i` so the length never changes ("İstanbul" → "istanbul").
 */
export function foldCase(s: string): string {
  const lower = s.toLowerCase();
  return lower.length === s.length ? lower : s.replace(/İ/g, 'i').toLowerCase();
}

export function lookupKey(name: string): QueryKey | undefined {
  return KEY_LOOKUP.get(name.toLowerCase());
}

export function parseLevelName(s: string): LogLevel | undefined {
  return LEVEL_LOOKUP.get(foldCase(s.trim()));
}

export function parseSourceName(s: string): LogSource | undefined {
  return SOURCE_LOOKUP.get(foldCase(s.trim()));
}

export function parseIsValue(s: string): IsValue | undefined {
  const v = foldCase(s.trim());
  return IS_LOOKUP.has(v) ? (v as IsValue) : undefined;
}

const AGE_PART = /(\d+(?:\.\d+)?|\.\d+)([smhd])/y;

/** `30s`, `5m`, `2h`, `1d`, compound `1h30m`, decimals `1.5h` → milliseconds; undefined when invalid or ≤ 0. */
export function parseAge(s: string): number | undefined {
  const v = s.trim().toLowerCase();
  if (!v) return undefined;
  let pos = 0;
  let total = 0;
  while (pos < v.length) {
    AGE_PART.lastIndex = pos;
    const m = AGE_PART.exec(v);
    if (!m) return undefined;
    total += parseFloat(m[1]!) * AGE_UNITS[m[2] as keyof typeof AGE_UNITS];
    pos = AGE_PART.lastIndex;
  }
  return total > 0 && Number.isFinite(total) ? total : undefined;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Case-insensitive pattern (use with the `i` flag) for a folded needle. `[iİ]` lets "istanbul" match
 * "İstanbul" (the regex `i` flag alone does not fold İ); dotless ı stays a distinct letter, as in Turkish.
 */
export function literalPattern(folded: string): string {
  return escapeRegExp(folded).replace(/i/g, '[iİ]');
}

/** Whether a bare value must be quoted to survive re-parsing (whitespace, quotes, `|`, parentheses, empty). */
export function needsQuotes(value: string): boolean {
  return value === '' || /[\s"|()]/.test(value);
}

/** Value as query text, quoted + escaped when needed (`"my tag"`, `"say \"hi\""`). */
export function formatValue(value: string, forceQuotes = false): string {
  if (!forceQuotes && !needsQuotes(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
