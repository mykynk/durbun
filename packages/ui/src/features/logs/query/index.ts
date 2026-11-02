/**
 * Log query language (SPEC §7.3) — CONTRACT between the Logs view (ui-logs, consumer) and this folder
 * (ui-logs-query, owner). Exported names, types and signatures are FROZEN: the owner replaces the stub
 * internals (and may add files under `query/`), the consumer only imports from `./query`.
 *
 * Syntax (Android Studio–like):
 *   tag:net        tag contains "net" (case-insensitive)        -tag:chatty    negation (any term or group)
 *   tag=:OkHttp    tag equals (case-insensitive)                tag~:^Ok.*$    tag matches regex (JS, `i`)
 *   message:, message=:, message~:      same three forms for the message (alias `msg:`)
 *   process: / package:                 process name (same three forms)
 *   pid:1234                            exact pid
 *   level:warn                          level ≥ warn (v/verbose, d/debug, i/info, w/warn/warning,
 *                                       e/error, f/fatal/a/assert)
 *   source:device|app|system            entry source (`sdk` = app)
 *   app:Pati                            app session id, app name or bundle id contains; also device lines
 *                                       whose process is that app's bundle id / process name
 *   is:crash|anr|error|json|network|event|marker|stacktrace|flutter
 *   age:30s|5m|2h|1d                    newer than now − age
 *   free text / "quoted phrase"         message, tag or process contains
 *   a b   → AND        a | b   → OR (lower precedence than AND)        ( … )  grouping
 *
 * `is:` semantics: crash → kind 'crash'; anr → kind 'anr'; error → level ≥ error; json →
 * `findJsonPayload(message)` or `data` is an object/array; network → kind 'network'; event → kind 'event';
 * marker → kind 'marker'; stacktrace → `looksLikeStackTrace(entry)`; flutter → kind 'flutter-error' OR tag
 * 'flutter' OR the entry's app session has sdk.platform 'flutter' | 'dart-vm'.
 *
 * Implementation notes (owner):
 *  - Also accepted: `||` as OR, `level=:warn` (exactly warn), `pid~:` (regex on the pid), compound ages
 *    (`1h30m`), `scheme://…` as free text (not a key). Free text, `message:` and `message~:` also look at
 *    `error.message` / `error.stack` (crash stacks), `message=:` compares the message only.
 *  - `app:` device lines are matched on the device of a matching session; sub-processes (`com.app:remote`)
 *    count. `app:` and `is:flutter` depend on `ctx.apps` → recompile when apps change (`queryUsesApps`).
 *  - Errors never throw; invalid pieces are left out of the AST so the rest keeps filtering.
 *  - Case folding is plain lower-casing (never the Turkish locale) with İ ≡ i.
 */
import type { AppSession, LogEntry, LogLevel } from '@durbun/protocol';
import { parseLogQuery as parseImpl } from './parser';
import { compileLogQuery as compileImpl, queryMinLevel as minLevelImpl } from './compile';
import { suggestLogQuery as suggestImpl } from './suggest';
import { findJsonPayload as findJsonImpl, looksLikeStackTrace as stackImpl } from './analysis';
import type { QueryKey } from './syntax';
import './i18n';

export { LogQueryInput, LogQueryHelp } from './LogQueryInput';
export type { LogQueryInputProps } from './LogQueryInput';

/* Additions (owner): helpers the Logs view may use. */
export type { LogQueryHelpProps } from './LogQueryHelp';
export { QueryHighlight } from './QueryHighlight';
export { queryHighlightRanges, queryUsesApps } from './compile';
export { queryErrorText } from './i18n';
export { queryTerm, appendQueryTerm } from './terms';
export { isStackFrameLine } from './analysis';
export type { QueryKey, QueryOp, IsValue } from './syntax';

/* ───────────────────────────── parse ───────────────────────────── */

export type QueryTokenKind =
  | 'key' // `tag`, `message`, … (without the colon)
  | 'operator' // `:`, `=:`, `~:`
  | 'negation' // leading `-`
  | 'value' // value of a key term
  | 'phrase' // "quoted phrase" (free text)
  | 'text' // bare free text
  | 'or' // `|`
  | 'paren' // `(` or `)`
  | 'whitespace'
  | 'error'; // unparsable span (also reported in ParsedQuery.error)

export interface QueryToken {
  kind: QueryTokenKind;
  /** Half-open source range [from, to). */
  from: number;
  to: number;
  text: string;
  /** (addition) Canonical key of a key / operator / value token (`msg` → 'message'); absent for unknown keys. */
  key?: QueryKey;
}

export interface QueryError {
  /** English fallback text. */
  message: string;
  /** i18n key under the owner's namespace (e.g. 'logsQuery.error.unclosedParen'), when available. */
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  from: number;
  to: number;
}

export interface ParsedQuery {
  source: string;
  /** Tokens covering the whole source in order (whitespace included) — for syntax highlighting. */
  tokens: QueryToken[];
  /** First syntax error, if any. Compilation still works on the best-effort AST. */
  error?: QueryError;
  /** (addition) Every syntax error, in source order (`errors[0] === error`). */
  errors?: QueryError[];
  /** No conditions at all (empty or whitespace). */
  empty: boolean;
  /** Opaque AST consumed by compileLogQuery. */
  readonly ast: unknown;
}

/** Parse a query. Never throws; errors are reported in `error` / `errors` with a best-effort AST. */
export function parseLogQuery(source: string): ParsedQuery {
  return parseImpl(source);
}

/* ───────────────────────────── compile ───────────────────────────── */

export interface LogQueryContext {
  /** Reference "now" (ms epoch) for `age:` terms. When `hasAge`, recompile every few seconds. */
  now: number;
  /** App sessions by id (for `app:` and `is:flutter`). */
  apps: Readonly<Record<string, AppSession>>;
}

export interface CompiledLogQuery {
  test(entry: LogEntry): boolean;
  /** True when the query has no conditions (test() always returns true) — lets the view skip work. */
  matchesAll: boolean;
  /** The query contains `age:` (time-dependent). */
  hasAge: boolean;
  /** Positive free-text / message terms to highlight in matching rows (strings are lowercase). */
  highlights: Array<string | RegExp>;
}

/**
 * Compile into a fast predicate (200 000 entries × typical queries in a few ms). `highlights`: folded
 * lowercase needles and `message~:` RegExps (flags `gi`) — `queryHighlightRanges(text, highlights)` turns
 * them into ranges.
 */
export function compileLogQuery(parsed: ParsedQuery, ctx: LogQueryContext): CompiledLogQuery {
  return compileImpl(parsed, ctx);
}

/** Lowest level required by a top-level `level:` term (AND-ed at the root), if any — an optimization hint. */
export function queryMinLevel(parsed: ParsedQuery): LogLevel | undefined {
  return minLevelImpl(parsed);
}

/* ───────────────────────────── autocomplete ───────────────────────────── */

export interface QuerySuggestion {
  /** Text shown in the popup. */
  label: string;
  /** Replacement for the source range [from, to). */
  insert: string;
  from: number;
  to: number;
  /** Secondary text, already localized (e.g. "etikete göre", "128 satır"). */
  detail?: string;
  kind: 'key' | 'value' | 'history';
  /** (addition) Key this suggestion completes or belongs to (value suggestions: the key of the value). */
  key?: QueryKey;
  /** (addition) The first item may be highlighted immediately (Enter accepts it). */
  preselect?: boolean;
}

export interface QuerySuggestData {
  /** Recent distinct values, most frequent first (collected by the Logs view from the visible store). */
  tags: string[];
  processes: string[];
  apps: Array<{ id: string; name: string; bundleId: string }>;
  /** Previously submitted queries, most recent first. */
  history: string[];
}

/** Suggestions for the cursor position (≤ 12; history when the field is empty). Never throws. */
export function suggestLogQuery(source: string, cursor: number, data: QuerySuggestData): QuerySuggestion[] {
  return suggestImpl(source, cursor, data);
}

/* ───────────────────────────── shared analysis ───────────────────────────── */

/**
 * Location of the first JSON object/array payload inside a message (balanced braces/brackets that
 * JSON.parse accepts, at least `{}`/`[]` with content), or null. Used for `is:json` and by the Logs view to
 * render a JSON preview — keep it fast (bail out early on messages without `{` / `[`).
 */
export function findJsonPayload(message: string): { start: number; end: number; value: unknown } | null {
  return findJsonImpl(message);
}

/**
 * Whether an entry carries a stack trace: `error.stack` non-empty, or ≥ 2 message lines that look like
 * frames (Dart `#0 …`, Java/Kotlin `at a.b(File.kt:1)`, JS `at fn (file:1:2)`, Apple `3 UIKitCore 0x…`).
 */
export function looksLikeStackTrace(entry: Pick<LogEntry, 'message' | 'error'>): boolean {
  return stackImpl(entry);
}
