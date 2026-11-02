/** JSON helpers shared by JsonTree, CodeView and features. */

export type PathSegment = string | number;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** JS-style access path: ["items", 0, "id"] → `data.items[0].id`; odd keys → `data["content-type"]`. */
export function jsonPath(segments: readonly PathSegment[], root = 'data'): string {
  let out = root;
  for (const s of segments) {
    if (typeof s === 'number') out += `[${s}]`;
    else if (IDENT.test(s)) out += `.${s}`;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

/** Internal node key for expand/collapse state (unambiguous for numbers vs numeric-looking keys). */
export function childKey(parentKey: string, seg: PathSegment): string {
  return typeof seg === 'number' ? `${parentKey}\u0002${seg}` : `${parentKey}\u0003${seg}`;
}

export const ROOT_KEY = '$';

export function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object';
}

export function entriesOf(v: Record<string, unknown> | unknown[]): [PathSegment, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  return Object.entries(v);
}

export function childCount(v: Record<string, unknown> | unknown[]): number {
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}

export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cheap pre-check before parsing: looks like a JSON object/array. */
export function looksLikeJson(text: string): boolean {
  const s = text.trim();
  if (s.length < 2) return false;
  return (s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']');
}

/** Pretty-printed JSON, or null when the text is not valid JSON. */
export function prettyJson(text: string, indent = 2): string | null {
  const r = tryParseJson(text);
  return r.ok ? JSON.stringify(r.value, null, indent) : null;
}

/** Value rendered as copyable text: strings raw, everything else JSON (pretty for containers). */
export function valueToText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v, null, isContainer(v) ? 2 : undefined) ?? String(v);
  } catch {
    return String(v);
  }
}

/** One-line preview: `{id: 1, name: "Ali", …}` / `[3 items]`. */
export function previewValue(v: unknown, maxLen = 80): string {
  const prim = (x: unknown): string => {
    if (typeof x === 'string') return JSON.stringify(x.length > 40 ? `${x.slice(0, 40)}…` : x);
    if (x === null) return 'null';
    if (Array.isArray(x)) return `Array(${x.length})`;
    if (typeof x === 'object') return '{…}';
    return String(x);
  };
  if (!isContainer(v)) return prim(v);
  const parts: string[] = [];
  let len = 2;
  const entries = entriesOf(v);
  for (const [k, x] of entries) {
    const part = Array.isArray(v) ? prim(x) : `${typeof k === 'string' && IDENT.test(k) ? k : JSON.stringify(k)}: ${prim(x)}`;
    if (len + part.length > maxLen && parts.length > 0) {
      parts.push('…');
      break;
    }
    parts.push(part);
    len += part.length + 2;
  }
  return Array.isArray(v) ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`;
}

/** Keys of all containers (for "expand all"), bounded by `budget` nodes. */
export function collectContainerKeys(data: unknown, budget = 5000): { keys: Set<string>; truncated: boolean } {
  const keys = new Set<string>();
  let visited = 0;
  let truncated = false;
  const walk = (v: unknown, key: string) => {
    if (!isContainer(v)) return;
    if (visited >= budget) {
      truncated = true;
      return;
    }
    keys.add(key);
    visited++;
    for (const [seg, child] of entriesOf(v)) {
      if (isContainer(child)) walk(child, childKey(key, seg));
      if (visited >= budget) {
        truncated = true;
        return;
      }
    }
  };
  walk(data, ROOT_KEY);
  return { keys, truncated };
}

/** Containers up to `depth` levels (root = depth 0). */
export function keysToDepth(data: unknown, depth: number, budget = 2000): Set<string> {
  const keys = new Set<string>();
  const walk = (v: unknown, key: string, d: number) => {
    if (!isContainer(v) || d >= depth || keys.size >= budget) return;
    keys.add(key);
    for (const [seg, child] of entriesOf(v)) walk(child, childKey(key, seg), d + 1);
  };
  walk(data, ROOT_KEY, 0);
  return keys;
}

export interface JsonSearchResult {
  /** Node keys whose key or primitive value matches. */
  matches: Set<string>;
  /** Ancestor container keys to expand so every match is visible. */
  expand: Set<string>;
  count: number;
  truncated: boolean;
}

/** Case-insensitive search over keys and primitive values (plain toLowerCase, SPEC §7.1). */
export function searchJson(data: unknown, query: string, budget = 50_000): JsonSearchResult {
  const q = query.trim().toLowerCase();
  const res: JsonSearchResult = { matches: new Set(), expand: new Set(), count: 0, truncated: false };
  if (!q) return res;
  let visited = 0;
  const walk = (v: unknown, key: string, label: PathSegment | null, ancestors: string[]): void => {
    if (visited++ > budget) {
      res.truncated = true;
      return;
    }
    const keyHit = typeof label === 'string' && label.toLowerCase().includes(q);
    const valueHit = !isContainer(v) && String(v === null ? 'null' : v).toLowerCase().includes(q);
    if (keyHit || valueHit) {
      res.matches.add(key);
      res.count++;
      for (const a of ancestors) res.expand.add(a);
    }
    if (isContainer(v)) {
      const next = [...ancestors, key];
      for (const [seg, child] of entriesOf(v)) {
        walk(child, childKey(key, seg), seg, next);
        if (res.truncated) return;
      }
    }
  };
  walk(data, ROOT_KEY, null, []);
  return res;
}

export type CodeLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'css' | 'plain';

/** Pick a CodeView language from a Content-Type and/or the text itself. */
export function detectCodeLanguage(contentType?: string, text?: string): CodeLanguage {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml') || ct.includes('svg')) return 'xml';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript';
  if (ct.includes('css')) return 'css';
  if (text) {
    const s = text.trimStart();
    if (looksLikeJson(text) && tryParseJson(text).ok) return 'json';
    if (/^<!doctype html|^<html[\s>]/i.test(s)) return 'html';
    if (s.startsWith('<?xml') || /^<[A-Za-z][\w:.-]*[\s>]/.test(s)) return 'xml';
  }
  return 'plain';
}
