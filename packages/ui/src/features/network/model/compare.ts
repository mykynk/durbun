import type { Header, WireBody } from '@durbun/protocol';
import { decodeBody, prettyJsonText } from './body';
import { splitLines } from './diff';

/** Helpers for comparing two requests: header tables and body text normalized for a line diff. */

export type HeaderDiffState = 'same' | 'changed' | 'onlyA' | 'onlyB';

export interface HeaderDiffRow {
  /** Display name (first spelling seen). */
  name: string;
  a: string[];
  b: string[];
  state: HeaderDiffState;
}

/** Union of header names (case-insensitive), with each side's values. Order: A's order, then B-only names. */
export function diffHeaders(a: readonly Header[] | undefined, b: readonly Header[] | undefined): HeaderDiffRow[] {
  const rows = new Map<string, HeaderDiffRow>();
  for (const [n, v] of a ?? []) {
    const key = n.toLowerCase();
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { name: n, a: [], b: [], state: 'same' }));
    r.a.push(v);
  }
  for (const [n, v] of b ?? []) {
    const key = n.toLowerCase();
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { name: n, a: [], b: [], state: 'same' }));
    r.b.push(v);
  }
  for (const r of rows.values()) {
    if (r.a.length === 0) r.state = 'onlyB';
    else if (r.b.length === 0) r.state = 'onlyA';
    else r.state = r.a.join('\n') === r.b.join('\n') ? 'same' : 'changed';
  }
  return [...rows.values()];
}

export interface BodyLines {
  kind: 'none' | 'notCaptured' | 'text' | 'json' | 'binary';
  lines: string[];
  size: number;
  truncated: boolean;
  /** Raw base64 / text used for "identical?" checks of binary bodies. */
  raw: string;
}

/** Body as lines for the diff (pretty JSON, optionally with sorted keys). */
export function bodyLines(wire: WireBody | undefined | null, contentType: string | undefined, opts: { sortKeys?: boolean; pretty?: boolean } = {}): BodyLines {
  const body = decodeBody(wire);
  if (!body || body.empty) return { kind: 'none', lines: [], size: 0, truncated: false, raw: '' };
  if (body.notCaptured) return { kind: 'notCaptured', lines: [], size: body.size, truncated: false, raw: '' };
  const text = body.text;
  if (text === null) return { kind: 'binary', lines: [], size: body.size, truncated: body.truncated, raw: body.wire.data };
  const looksJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(text);
  if (looksJson && opts.pretty !== false) {
    const pretty = prettyJsonText(text, { sortKeys: opts.sortKeys });
    if (pretty !== null) return { kind: 'json', lines: splitLines(pretty), size: body.size, truncated: body.truncated, raw: text };
  }
  return { kind: 'text', lines: splitLines(text), size: body.size, truncated: body.truncated, raw: text };
}
