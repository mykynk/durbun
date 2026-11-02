import type { Header, WireBody } from '@durbun/protocol';
import { headerValue, parseParams, type Param } from './http';

/**
 * Body helpers: decoding captured bodies (utf8 / base64), classification for the viewers, image
 * sniffing, hex dumps, multipart and GraphQL parsing. Pure (browser built-ins only).
 */

/* ───────────── Bytes ───────────── */

export function base64ToBytes(b64: string): Uint8Array {
  let clean = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (clean.length % 4 === 1) clean = clean.slice(0, -1); // a lone trailing char cannot be decoded
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Bytes as text when they are valid UTF-8 without binary control characters, else null.
 * A multi-byte character cut by truncation at the very end is tolerated.
 */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  const dec = new TextDecoder('utf-8', { fatal: true });
  let text: string | null = null;
  for (let cut = 0; cut <= 3 && cut <= bytes.length; cut++) {
    try {
      text = dec.decode(cut ? bytes.subarray(0, bytes.length - cut) : bytes);
      break;
    } catch {
      text = null;
    }
  }
  if (text === null) return null;
  return looksBinary(text) ? null : text;
}

/** NUL bytes or many C0 control characters (except tab/newline/CR/FF/ESC) → binary. */
function looksBinary(text: string): boolean {
  const n = Math.min(text.length, 8192);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return true;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) control++;
  }
  return n > 0 && control / n > 0.02;
}

/* ───────────── Decoded body ───────────── */

/** Lazily decoded view of a captured `WireBody`. */
export class DecodedBody {
  private bytesCache?: Uint8Array;
  private textCache?: string | null;

  constructor(readonly wire: WireBody) {}

  get encoding(): 'utf8' | 'base64' {
    return this.wire.encoding === 'base64' ? 'base64' : 'utf8';
  }

  /** Size-only placeholder (capture off or too large, SPEC §9.4). */
  get notCaptured(): boolean {
    return this.wire.data === '' && this.wire.truncated === true && this.wire.size > 0;
  }

  get empty(): boolean {
    return this.wire.data === '' && !this.notCaptured;
  }

  /** Full size reported by the SDK (bytes). */
  get size(): number {
    return Math.max(Number(this.wire.size) || 0, this.capturedBytes);
  }

  get capturedBytes(): number {
    if (this.wire.data === '') return 0;
    if (this.encoding === 'base64') return this.bytes.length;
    return this.bytes.length;
  }

  get truncated(): boolean {
    return !this.notCaptured && (this.wire.truncated === true || this.capturedBytes < (Number(this.wire.size) || 0));
  }

  get bytes(): Uint8Array {
    if (!this.bytesCache) this.bytesCache = this.encoding === 'base64' ? base64ToBytes(this.wire.data) : utf8Bytes(this.wire.data);
    return this.bytesCache;
  }

  /** Text for utf8 bodies (always) and base64 bodies that decode to UTF-8 text; null for binary. */
  get text(): string | null {
    if (this.textCache === undefined) this.textCache = this.encoding === 'utf8' ? this.wire.data : decodeUtf8Text(this.bytes);
    return this.textCache;
  }
}

export function decodeBody(wire: WireBody | undefined | null): DecodedBody | null {
  if (!wire || typeof wire.data !== 'string') return null;
  return new DecodedBody(wire);
}

/* ───────────── Classification ───────────── */

export type BodyKind =
  | 'empty'
  | 'notCaptured'
  | 'json'
  | 'image'
  | 'svg'
  | 'html'
  | 'xml'
  | 'javascript'
  | 'css'
  | 'text'
  | 'form'
  | 'multipart'
  | 'binary';

export function classifyBody(contentType: string | undefined, body: DecodedBody): BodyKind {
  if (body.notCaptured) return 'notCaptured';
  if (body.empty) return 'empty';
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/svg')) return 'svg';
  if (ct.startsWith('image/')) return 'image';
  if (ct.includes('multipart/')) return 'multipart';
  if (ct.includes('x-www-form-urlencoded')) return 'form';
  if (!ct || ct.includes('octet-stream')) {
    if (sniffImage(body.bytes.subarray(0, 64))) return 'image';
  }
  const text = body.text;
  if (text === null) return sniffImage(body.bytes.subarray(0, 64)) ? 'image' : 'binary';
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript';
  if (ct.includes('css')) return 'css';
  const s = text.trimStart();
  if ((s.startsWith('{') || s.startsWith('[')) && isJson(text)) return 'json';
  if (/^<!doctype html|^<html[\s>]/i.test(s)) return 'html';
  if (s.startsWith('<?xml')) return 'xml';
  return 'text';
}

export function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Deeply sorted object keys (stable diffs of JSON whose key order differs). */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** Pretty-printed JSON text (null when not JSON). */
export function prettyJsonText(text: string, opts: { sortKeys?: boolean; indent?: number } = {}): string | null {
  try {
    const v = JSON.parse(text);
    return JSON.stringify(opts.sortKeys ? sortKeysDeep(v) : v, null, opts.indent ?? 2);
  } catch {
    return null;
  }
}

/* ───────────── Images ───────────── */

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | 'avif' | 'heic';
  width?: number;
  height?: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** Image format and dimensions from the first bytes (header only). */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const info: ImageInfo = { format: 'jpeg' };
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16be(b, i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.height = u16be(b, i + 5);
        info.width = u16be(b, i + 7);
        break;
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return info;
  }
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ' && b.length >= 30) return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L' && b.length >= 25) {
      const b0 = b[21]!;
      const b1 = b[22]!;
      const b2 = b[23]!;
      const b3 = b[24]!;
      return { format: 'webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunk === 'VP8X' && b.length >= 30) return { format: 'webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
    return { format: 'webp' };
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = (b[18]! | (b[19]! << 8) | (b[20]! << 16) | (b[21]! << 24)) >> 0;
    const h = (b[22]! | (b[23]! << 8) | (b[24]! << 16) | (b[25]! << 24)) >> 0;
    return { format: 'bmp', width: Math.abs(w), height: Math.abs(h) };
  }
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { format: 'ico' };
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { format: 'avif' };
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return { format: 'heic' };
  }
  return null;
}

/* ───────────── Hex dump ───────────── */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Classic 16-bytes-per-line hex dump of `bytes[start, end)` with offsets and an ASCII column. */
export function hexDump(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const lines: string[] = [];
  const stop = Math.min(end, bytes.length);
  for (let off = start; off < stop; off += 16) {
    let hex = '';
    let text = '';
    for (let i = 0; i < 16; i++) {
      const p = off + i;
      if (i === 8) hex += ' ';
      if (p < stop) {
        const v = bytes[p]!;
        hex += `${HEX[v]} `;
        text += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '.';
      } else hex += '   ';
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${text}|`);
  }
  return lines.join('\n');
}

/* ───────────── Multipart ───────────── */

export function boundaryOf(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : undefined;
}

export interface MultipartPart {
  headers: Header[];
  name?: string;
  filename?: string;
  contentType?: string;
  /** Captured size of the part body (bytes). */
  size: number;
  /** Text preview for text-like parts (first 2 000 chars). */
  text?: string;
  /** The capture ended inside this part. */
  truncated: boolean;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function dispositionParam(value: string, key: string): string | undefined {
  const star = new RegExp(`${key}\\*=([^;]+)`, 'i').exec(value);
  if (star) {
    const v = star[1]!.trim().replace(/^"|"$/g, '');
    const m = /^[^']*'[^']*'(.*)$/.exec(v);
    try {
      return decodeURIComponent(m ? m[1]! : v);
    } catch {
      return m ? m[1] : v;
    }
  }
  const quoted = new RegExp(`(?:^|;)\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(value);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, '$1');
  const plain = new RegExp(`(?:^|;)\\s*${key}=([^;]+)`, 'i').exec(value);
  return plain ? plain[1]!.trim() : undefined;
}

const PREVIEW_CHARS = 2000;

/** Parts of a multipart body. `complete` is false when the closing delimiter is missing (truncated capture). */
export function parseMultipart(bytes: Uint8Array, boundary: string): { parts: MultipartPart[]; complete: boolean } {
  const enc = new TextEncoder();
  const delim = enc.encode(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let pos = indexOfBytes(bytes, delim, 0);
  if (pos < 0) return { parts, complete: false };
  let complete = false;
  while (pos >= 0) {
    let start = pos + delim.length;
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) {
      complete = true;
      break;
    }
    if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2;
    else if (bytes[start] === 0x0a) start += 1;
    const next = indexOfBytes(bytes, delim, start);
    let end = next < 0 ? bytes.length : next;
    // The CRLF before the next delimiter belongs to the delimiter.
    if (next >= 0) {
      if (bytes[end - 2] === 0x0d && bytes[end - 1] === 0x0a) end -= 2;
      else if (bytes[end - 1] === 0x0a) end -= 1;
    }
    const chunk = bytes.subarray(start, Math.max(start, end));
    const sep = indexOfBytes(chunk, enc.encode('\r\n\r\n'), 0);
    const sepLen = sep >= 0 ? 4 : 0;
    const altSep = sep < 0 ? indexOfBytes(chunk, enc.encode('\n\n'), 0) : -1;
    const headEnd = sep >= 0 ? sep : altSep >= 0 ? altSep : chunk.length;
    const headText = new TextDecoder('utf-8').decode(chunk.subarray(0, headEnd));
    const body = chunk.subarray(Math.min(chunk.length, headEnd + (sep >= 0 ? sepLen : altSep >= 0 ? 2 : 0)));
    const headers: Header[] = [];
    for (const line of headText.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
    const disposition = headerValue(headers, 'content-disposition') ?? '';
    const contentType = headerValue(headers, 'content-type');
    const part: MultipartPart = {
      headers,
      name: dispositionParam(disposition, 'name'),
      filename: dispositionParam(disposition, 'filename'),
      contentType,
      size: body.length,
      truncated: next < 0,
    };
    const textLike = !contentType || /^text\/|json|xml|x-www-form-urlencoded|javascript/i.test(contentType);
    if (textLike && !part.filename) {
      const text = decodeUtf8Text(body.subarray(0, PREVIEW_CHARS * 4));
      if (text !== null) part.text = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
    }
    parts.push(part);
    if (next < 0) break;
    pos = next;
  }
  return { parts, complete };
}

/** Form fields of an `application/x-www-form-urlencoded` body. */
export function parseFormBody(text: string): Param[] {
  return parseParams(text.trim());
}

/* ───────────── GraphQL ───────────── */

export interface GraphqlOperation {
  query?: string;
  operationName?: string;
  variables?: unknown;
  extensions?: unknown;
}

function asOperation(v: unknown): GraphqlOperation | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const hasQuery = typeof o.query === 'string';
  const persisted = !!o.extensions && typeof o.extensions === 'object' && 'persistedQuery' in (o.extensions as object);
  if (!hasQuery && !persisted) return null;
  const op: GraphqlOperation = {};
  if (hasQuery) op.query = o.query as string;
  if (typeof o.operationName === 'string' && o.operationName) op.operationName = o.operationName;
  if (o.variables !== undefined && o.variables !== null) op.variables = o.variables;
  if (o.extensions !== undefined && o.extensions !== null) op.extensions = o.extensions;
  return op;
}

/**
 * GraphQL operations of a request: JSON body `{query, variables, operationName}` (or a batch array),
 * `application/graphql` text, or GET `?query=…&variables=…`. Null when it is not GraphQL.
 */
export function parseGraphqlRequest(input: { method: string; url: string; contentType?: string; text?: string | null }): GraphqlOperation[] | null {
  const ct = (input.contentType ?? '').toLowerCase();
  if (input.text) {
    if (ct.includes('application/graphql')) return [{ query: input.text }];
    try {
      const v = JSON.parse(input.text) as unknown;
      if (Array.isArray(v)) {
        const ops = v.map(asOperation);
        return ops.length > 0 && ops.every(Boolean) ? (ops as GraphqlOperation[]) : null;
      }
      const op = asOperation(v);
      return op ? [op] : null;
    } catch {
      return null;
    }
  }
  if (input.method.toUpperCase() === 'GET') {
    const q = input.url.indexOf('?');
    if (q < 0) return null;
    const params = parseParams(input.url.slice(q));
    const query = params.find((p) => p.name === 'query')?.value;
    if (!query) return null;
    const op: GraphqlOperation = { query };
    const name = params.find((p) => p.name === 'operationName')?.value;
    if (name) op.operationName = name;
    const vars = params.find((p) => p.name === 'variables')?.value;
    if (vars) {
      try {
        op.variables = JSON.parse(vars);
      } catch {
        op.variables = vars;
      }
    }
    return [op];
  }
  return null;
}

export interface GraphqlError {
  message: string;
  path?: string;
  locations?: string;
  code?: string;
}

/** `errors` of a GraphQL response (`{data, errors: [{message, path, locations, extensions}]}`). */
export function graphqlErrors(response: unknown): GraphqlError[] {
  if (!response || typeof response !== 'object') return [];
  const list = Array.isArray(response) ? response.flatMap((r) => (r && typeof r === 'object' ? ((r as { errors?: unknown }).errors ?? []) : [])) : (response as { errors?: unknown }).errors;
  if (!Array.isArray(list)) return [];
  return list.map((e): GraphqlError => {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const out: GraphqlError = { message: typeof o.message === 'string' ? o.message : JSON.stringify(e) };
    if (Array.isArray(o.path)) out.path = o.path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');
    if (Array.isArray(o.locations)) {
      out.locations = o.locations
        .map((l) => (l && typeof l === 'object' ? `${(l as { line?: unknown }).line}:${(l as { column?: unknown }).column}` : ''))
        .filter(Boolean)
        .join(', ');
    }
    const ext = o.extensions as Record<string, unknown> | undefined;
    if (ext && typeof ext.code === 'string') out.code = ext.code;
    return out;
  });
}

type GqlToken = { kind: 'punct' | 'name' | 'string' | 'number' | 'comment' | 'spread' | 'var'; text: string };

function tokenizeGraphql(src: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      const end = src.indexOf('\n', i);
      tokens.push({ kind: 'comment', text: src.slice(i, end < 0 ? src.length : end).trimEnd() });
      i = end < 0 ? src.length : end;
      continue;
    }
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end < 0 ? src.length : end + 3;
      tokens.push({ kind: 'string', text: src.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      tokens.push({ kind: 'string', text: src.slice(i, Math.min(src.length, j + 1)) });
      i = j + 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', text: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[\w]/.test(src[j]!)) j++;
      tokens.push({ kind: 'var', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /\w/.test(src[j]!)) j++;
      tokens.push({ kind: 'name', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-\d]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\d.eE+-]/.test(src[j]!)) j++;
      tokens.push({ kind: 'number', text: src.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', text: c });
    i++;
  }
  return tokens;
}

/**
 * Re-indent a (possibly minified) GraphQL document: one field per line inside selection sets,
 * arguments and variable definitions kept inline (`user(id: $id, first: 10)`). Strings and comments
 * are preserved; commas are insignificant in GraphQL and are re-inserted only between arguments.
 */
export function formatGraphql(src: string, indentUnit = '  '): string {
  const tokens = tokenizeGraphql(src);
  let out = '';
  let depth = 0; // selection-set depth
  let paren = 0; // arguments / variable definitions
  let bracket = 0; // list values / list types
  let objDepth = 0; // input object literals inside arguments
  let lineStart = true;
  let prev: GqlToken | null = null;
  let inlineNext = false; // the next token continues the current field ("alias: field", "... on T", "@dir")
  const newline = () => {
    out = out.replace(/[ ]+$/, '');
    out += `\n${indentUnit.repeat(depth)}`;
    lineStart = true;
  };
  const write = (s: string, space: boolean) => {
    if (!lineStart && space) out += ' ';
    out += s;
    lineStart = false;
  };
  const NO_COMMA_AFTER = new Set(['(', '[', '{', ':', '=', '@']);
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx]!;
    const inArgs = paren > 0 || bracket > 0 || objDepth > 0;
    const pt = prev?.text;
    if (tok.kind === 'comment') {
      write(tok.text, true);
      newline();
      prev = tok;
      continue;
    }
    if (tok.kind === 'punct') {
      const p = tok.text;
      switch (p) {
        case '{':
          if (inArgs) {
            if (prev && !NO_COMMA_AFTER.has(pt!) && prev.kind !== 'spread') out += ',';
            objDepth++;
            write('{', pt !== '(' && pt !== '[');
          } else {
            write('{', true);
            depth++;
            newline();
          }
          break;
        case '}':
          if (objDepth > 0) {
            objDepth--;
            out += ' }';
          } else {
            depth = Math.max(0, depth - 1);
            newline();
            out += '}';
            lineStart = false;
            if (depth === 0 && idx + 1 < tokens.length) {
              out += '\n';
              newline();
            }
          }
          break;
        case '(':
          paren++;
          out += '(';
          lineStart = false;
          break;
        case ')':
          paren = Math.max(0, paren - 1);
          out += ')';
          break;
        case '[':
          if (inArgs && prev && !NO_COMMA_AFTER.has(pt!)) out += ',';
          bracket++;
          write('[', pt !== '(' && pt !== '[');
          break;
        case ']':
          bracket = Math.max(0, bracket - 1);
          out += ']';
          break;
        case ':':
        case '!':
          out += p;
          break;
        default:
          write(p, true);
      }
      inlineNext = p === ':' || p === '=' || p === '@';
      prev = tok;
      continue;
    }
    // names, variables, strings, numbers, spreads
    if (!inArgs && depth > 0 && !inlineNext && !lineStart && prev && prev.kind !== 'spread') newline();
    if (inArgs && prev && !NO_COMMA_AFTER.has(pt!) && prev.kind !== 'spread' && !inlineNext) out += ',';
    let space = pt !== '(' && pt !== '[' && pt !== '@';
    if (prev?.kind === 'spread') space = tok.kind === 'name' && tok.text === 'on';
    write(tok.text, space);
    inlineNext = tok.kind === 'spread' || (tok.kind === 'name' && tok.text === 'on' && prev?.kind === 'spread');
    prev = tok;
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}
