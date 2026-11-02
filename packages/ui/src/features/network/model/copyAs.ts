import type { Header, WireBody } from '@durbun/protocol';

/**
 * "Copy as …" generators: cURL (POSIX shell), fetch (JS), Dart (dio), Swift (URLSession) and
 * Kotlin (OkHttp). Pure functions; notes explain what could not be reproduced (binary or missing
 * bodies) and are shown to the user next to the copied text — never inside it (zsh would try to run
 * a leading `#` line).
 */

export type CopyFormat = 'curl' | 'fetch' | 'dio' | 'swift' | 'kotlin';
export const COPY_FORMATS: readonly CopyFormat[] = ['curl', 'fetch', 'dio', 'swift', 'kotlin'];

export interface CopyRequest {
  method: string;
  url: string;
  headers: readonly Header[];
  body?: WireBody | null;
  /** The request had a body that was not captured / was evicted. */
  hasBody?: boolean;
}

export type CopyNote =
  | { code: 'bodyNotCaptured' }
  | { code: 'bodyTruncated'; captured: number; size: number }
  | { code: 'binaryBody'; size: number }
  | { code: 'bodyOmitted'; size: number };

export interface CopyResult {
  code: string;
  notes: CopyNote[];
}

/** Base64 bodies above this size are left out of generated code (a placeholder is used instead). */
export const MAX_INLINE_BINARY = 256 * 1024;

/** Headers that the HTTP client computes itself (or that are HTTP/2 pseudo headers). */
function dropHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith(':') || n === 'content-length' || n === 'host' || n === 'connection' || n === 'transfer-encoding';
}

interface PreparedBody {
  kind: 'none' | 'text' | 'binary';
  text?: string;
  base64?: string;
  size: number;
}

function base64Size(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

function prepare(req: CopyRequest): { body: PreparedBody; notes: CopyNote[]; headers: Header[]; method: string } {
  const notes: CopyNote[] = [];
  const method = (req.method && req.method !== '?' ? req.method : 'GET').toUpperCase();
  const headers = req.headers.filter(([name]) => !dropHeader(name)).map(([n, v]) => [n, v] as Header);
  const b = req.body;
  let body: PreparedBody = { kind: 'none', size: 0 };
  if (b && b.data === '' && b.truncated && b.size > 0) {
    notes.push({ code: 'bodyNotCaptured' });
  } else if (b && b.data !== '') {
    if (b.encoding === 'base64') {
      const captured = base64Size(b.data);
      body = { kind: 'binary', base64: b.data.replace(/\s+/g, ''), size: captured };
      if (b.truncated || captured < b.size) notes.push({ code: 'bodyTruncated', captured, size: b.size });
    } else {
      const captured = new TextEncoder().encode(b.data).length;
      body = { kind: 'text', text: b.data, size: captured };
      if (b.truncated || captured < b.size) notes.push({ code: 'bodyTruncated', captured, size: b.size });
    }
  } else if (req.hasBody) {
    notes.push({ code: 'bodyNotCaptured' });
  }
  return { body, notes, headers, method };
}

function contentTypeOf(headers: readonly Header[]): string | undefined {
  return headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1];
}

function isJsonType(ct: string | undefined): boolean {
  return !!ct && /json/i.test(ct);
}

/* ───────────── cURL ───────────── */

/**
 * POSIX single-quote escaping: 'it'\''s' — safe in bash and zsh (no globbing, `$`, `!` or `=`
 * expansion), newlines and unicode included. Plain words (methods) stay unquoted.
 */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function toCurl(req: CopyRequest): CopyResult {
  const { body, notes, headers, method } = prepare(req);
  const parts: string[] = [`curl ${shellQuote(req.url)}`];
  const hasData = body.kind !== 'none';
  if (method === 'HEAD') parts.push('--head');
  else if (!((method === 'GET' && !hasData) || (method === 'POST' && hasData))) parts.push(`-X ${shellQuote(method)}`);
  let compressed = false;
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'accept-encoding' && /gzip|deflate|br|zstd/i.test(value)) {
      // curl negotiates (and decodes) the encodings it supports itself.
      compressed = true;
      continue;
    }
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (body.kind === 'text') parts.push(`--data-raw ${shellQuote(body.text ?? '')}`);
  else if (body.kind === 'binary') {
    parts.push('--data-binary @body.bin');
    notes.push({ code: 'binaryBody', size: body.size });
  }
  if (compressed) parts.push('--compressed');
  return { code: parts.join(' \\\n  '), notes };
}

/* ───────────── fetch (JS) ───────────── */

const jsString = (s: string) => JSON.stringify(s);

function mergedHeaders(headers: readonly Header[]): [string, string][] {
  const map = new Map<string, [string, string]>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const cur = map.get(key);
    if (cur) cur[1] = `${cur[1]}${key === 'cookie' ? '; ' : ', '}${value}`;
    else map.set(key, [name, value]);
  }
  return [...map.values()];
}

function indentLines(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : pad + l))
    .join('\n');
}

export function toFetch(req: CopyRequest): CopyResult {
  const { body, notes, headers, method } = prepare(req);
  const lines: string[] = [];
  lines.push(`const response = await fetch(${jsString(req.url)}, {`);
  lines.push(`  method: ${jsString(method)},`);
  const merged = mergedHeaders(headers);
  if (merged.length > 0) {
    lines.push('  headers: {');
    for (const [n, v] of merged) lines.push(`    ${jsString(n)}: ${jsString(v)},`);
    lines.push('  },');
  }
  if (body.kind === 'text') {
    const text = body.text ?? '';
    let json: unknown;
    let isJson = false;
    if (isJsonType(contentTypeOf(headers))) {
      try {
        json = JSON.parse(text);
        isJson = true;
      } catch {
        isJson = false;
      }
    }
    if (isJson) lines.push(`  body: JSON.stringify(${indentLines(JSON.stringify(json, null, 2), '  ')}),`);
    else lines.push(`  body: ${jsString(text)},`);
  } else if (body.kind === 'binary') {
    if (body.size > MAX_INLINE_BINARY) {
      lines.push('  body: binaryBody, // the captured binary body is too large to inline');
      notes.push({ code: 'bodyOmitted', size: body.size });
    } else lines.push(`  body: Uint8Array.from(atob(${jsString(body.base64 ?? '')}), (c) => c.charCodeAt(0)),`);
  }
  lines.push('});');
  return { code: lines.join('\n'), notes };
}

/* ───────────── Dart (dio) ───────────── */

/** Dart single-quoted string literal (escapes `\`, `'`, `$`, control characters). */
export function dartString(s: string): string {
  let out = "'";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '$') out += '\\$';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return `${out}'`;
}

export function toDio(req: CopyRequest): CopyResult {
  const { body, notes, headers, method } = prepare(req);
  const imports = ["import 'package:dio/dio.dart';"];
  let data: string | null = null;
  if (body.kind === 'text') data = dartString(body.text ?? '');
  else if (body.kind === 'binary') {
    if (body.size > MAX_INLINE_BINARY) {
      data = 'binaryBody /* the captured binary body is too large to inline */';
      notes.push({ code: 'bodyOmitted', size: body.size });
    } else {
      imports.unshift("import 'dart:convert';");
      data = `base64Decode(${dartString(body.base64 ?? '')})`;
    }
  }
  const merged = mergedHeaders(headers);
  const lines: string[] = [...imports, '', 'final dio = Dio();', 'final response = await dio.request<dynamic>(', `  ${dartString(req.url)},`];
  if (data) lines.push(`  data: ${data},`);
  lines.push('  options: Options(');
  lines.push(`    method: ${dartString(method)},`);
  if (merged.length > 0) {
    lines.push('    headers: {');
    for (const [n, v] of merged) lines.push(`      ${dartString(n)}: ${dartString(v)},`);
    lines.push('    },');
  }
  lines.push('  ),');
  lines.push(');');
  return { code: lines.join('\n'), notes };
}

/* ───────────── Swift (URLSession) ───────────── */

/** Swift string literal (escapes `\`, `"`, control characters; `\(` cannot appear unescaped). */
export function swiftString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

export function toSwift(req: CopyRequest): CopyResult {
  const { body, notes, headers, method } = prepare(req);
  const lines: string[] = ['import Foundation', '', `var request = URLRequest(url: URL(string: ${swiftString(req.url)})!)`, `request.httpMethod = ${swiftString(method)}`];
  for (const [n, v] of headers) lines.push(`request.addValue(${swiftString(v)}, forHTTPHeaderField: ${swiftString(n)})`);
  if (body.kind === 'text') lines.push(`request.httpBody = Data(${swiftString(body.text ?? '')}.utf8)`);
  else if (body.kind === 'binary') {
    if (body.size > MAX_INLINE_BINARY) {
      lines.push('request.httpBody = binaryBody // the captured binary body is too large to inline');
      notes.push({ code: 'bodyOmitted', size: body.size });
    } else lines.push(`request.httpBody = Data(base64Encoded: ${swiftString(body.base64 ?? '')})`);
  }
  lines.push('', 'let (data, response) = try await URLSession.shared.data(for: request)');
  return { code: lines.join('\n'), notes };
}

/* ───────────── Kotlin (OkHttp) ───────────── */

/** Kotlin string literal (escapes `\`, `"`, `$`, control characters). */
export function kotlinString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '$') out += '\\$';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

const OKHTTP_BODY_REQUIRED = new Set(['POST', 'PUT', 'PATCH', 'PROPPATCH', 'REPORT']);

export function toKotlin(req: CopyRequest): CopyResult {
  const { body, notes, headers, method } = prepare(req);
  const imports = ['import okhttp3.OkHttpClient', 'import okhttp3.Request'];
  const ct = contentTypeOf(req.headers);
  const mediaType = ct ? `${kotlinString(ct)}.toMediaType()` : 'null';
  let bodyExpr: string | null = null;
  if (body.kind === 'text') {
    bodyExpr = `${kotlinString(body.text ?? '')}.toRequestBody(${mediaType})`;
    imports.push('import okhttp3.RequestBody.Companion.toRequestBody');
  } else if (body.kind === 'binary') {
    if (body.size > MAX_INLINE_BINARY) {
      bodyExpr = `binaryBody.toRequestBody(${mediaType}) /* the captured binary body is too large to inline */`;
      notes.push({ code: 'bodyOmitted', size: body.size });
    } else {
      bodyExpr = `${kotlinString(body.base64 ?? '')}.decodeBase64()!!.toRequestBody(${mediaType})`;
      imports.push('import okhttp3.RequestBody.Companion.toRequestBody', 'import okio.ByteString.Companion.decodeBase64');
    }
  } else if (OKHTTP_BODY_REQUIRED.has(method)) {
    bodyExpr = `ByteArray(0).toRequestBody(${mediaType})`;
    imports.push('import okhttp3.RequestBody.Companion.toRequestBody');
  }
  if (ct && bodyExpr) imports.push('import okhttp3.MediaType.Companion.toMediaType');
  const lines: string[] = [...new Set(imports), '', 'val client = OkHttpClient()', 'val request = Request.Builder()', `    .url(${kotlinString(req.url)})`];
  for (const [n, v] of headers) lines.push(`    .addHeader(${kotlinString(n)}, ${kotlinString(v)})`);
  if (method === 'GET' && !bodyExpr) lines.push('    .get()');
  else if (method === 'HEAD' && !bodyExpr) lines.push('    .head()');
  else lines.push(`    .method(${kotlinString(method)}, ${bodyExpr ?? 'null'})`);
  lines.push('    .build()', '', 'client.newCall(request).execute().use { response ->', '    println(response.body?.string())', '}');
  return { code: lines.join('\n'), notes };
}

export function copyAs(format: CopyFormat, req: CopyRequest): CopyResult {
  switch (format) {
    case 'curl':
      return toCurl(req);
    case 'fetch':
      return toFetch(req);
    case 'dio':
      return toDio(req);
    case 'swift':
      return toSwift(req);
    case 'kotlin':
      return toKotlin(req);
  }
}
