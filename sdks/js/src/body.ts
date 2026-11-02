/**
 * Body capture: turns request/response payloads into `WireBody`s without consuming the app's own
 * streams. Pure JS UTF-8 / base64 codecs (Hermes lacks parts of TextDecoder/btoa on older versions).
 */
import { isTextContentType, type WireBody } from './protocol.js';
import { g, isPromiseLike, setTimer, clearTimer, type AnyRecord } from './util.js';

export interface BodyConfig {
  captureBodies: boolean;
  maxBodyBytes: number;
}

/* ────────────────────────────── UTF-8 ────────────────────────────── */

/** Number of UTF-8 bytes of a JS string (lone surrogates count as U+FFFD, like TextEncoder). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export function utf8Encode(s: string): Uint8Array {
  const TE = g.TextEncoder;
  if (typeof TE === 'function') {
    try {
      return new TE().encode(s);
    } catch {
      // fall through to the manual encoder
    }
  }
  const out = new Uint8Array(utf8Length(s));
  let p = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out[p++] = c;
    else if (c < 0x800) {
      out[p++] = 0xc0 | (c >> 6);
      out[p++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[p++] = 0xe0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    } else {
      out[p++] = 0xf0 | (c >> 18);
      out[p++] = 0x80 | ((c >> 12) & 0x3f);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    }
  }
  return p === out.length ? out : out.subarray(0, p);
}

export function utf8Decode(bytes: Uint8Array): string {
  const TD = g.TextDecoder;
  if (typeof TD === 'function') {
    try {
      return new TD('utf-8').decode(bytes);
    } catch {
      // fall through
    }
  }
  // WHATWG UTF-8 decoder (same U+FFFD replacement as TextDecoder / Buffer: one per maximal invalid subpart).
  let out = '';
  let chunk: number[] = [];
  const emit = (cp: number) => {
    if (cp > 0xffff) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length > 8000) {
      out += String.fromCharCode.apply(null, chunk);
      chunk = [];
    }
  };
  let needed = 0;
  let seen = 0;
  let cp = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) emit(b);
      else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        cp = b & 0x07;
      } else emit(0xfffd);
      continue;
    }
    if (b < lower || b > upper) {
      cp = needed = seen = 0;
      lower = 0x80;
      upper = 0xbf;
      emit(0xfffd);
      i--; // reprocess this byte as the start of a new sequence
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    if (++seen === needed) {
      emit(cp);
      cp = needed = seen = 0;
    }
  }
  if (needed !== 0) emit(0xfffd);
  out += String.fromCharCode.apply(null, chunk);
  return out;
}

/** Longest prefix of `s` whose UTF-8 encoding fits in `maxBytes` (never splits a character). */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (s.length * 3 <= maxBytes) return s;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let w = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    let step = 1;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        w = 4;
        step = 2;
      }
    }
    if (n + w > maxBytes) return s.slice(0, i);
    n += w;
    i += step - 1;
  }
  return s;
}

/** Cut position <= max that does not split a UTF-8 sequence. */
function utf8SafeCut(bytes: Uint8Array, max: number): number {
  if (max >= bytes.length) return bytes.length;
  let idx = max;
  while (idx > 0 && (bytes[idx] & 0xc0) === 0x80) idx--;
  return idx;
}

/* ────────────────────────────── base64 ────────────────────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let B64_LOOKUP: Int16Array | undefined;

export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let line: string[] = [];
  const len = bytes.length;
  const full = len - (len % 3);
  for (let i = 0; i < full; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    line.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
    if (line.length >= 4096) {
      parts.push(line.join(''));
      line = [];
    }
  }
  const rest = len - full;
  if (rest === 1) {
    const n = bytes[full] << 16;
    line.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==');
  } else if (rest === 2) {
    const n = (bytes[full] << 16) | (bytes[full + 1] << 8);
    line.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=');
  }
  parts.push(line.join(''));
  return parts.join('');
}

/** Lenient decoder: ignores whitespace and invalid characters, accepts URL-safe alphabet and missing padding. */
export function base64Decode(input: string): Uint8Array {
  if (!B64_LOOKUP) {
    B64_LOOKUP = new Int16Array(256).fill(-1);
    for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
    B64_LOOKUP['-'.charCodeAt(0)] = 62;
    B64_LOOKUP['_'.charCodeAt(0)] = 63;
  }
  const lookup = B64_LOOKUP;
  const out = new Uint8Array(Math.floor((input.length * 3) / 4) + 3);
  let p = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 61 /* = */) break;
    const v = code < 256 ? lookup[code] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

/** Base64 length → decoded byte count (without decoding). */
export function base64DecodedLength(b64: string): number {
  let len = b64.length;
  while (len > 0 && b64.charCodeAt(len - 1) === 61) len--;
  return Math.floor((len * 3) / 4);
}

/* ────────────────────────────── Text detection ────────────────────────────── */

/**
 * Whether a body with this content type is captured as UTF-8. Extends the protocol rule with an explicit
 * `charset=` parameter (always text) and content sniffing when no content type is known at all.
 */
export function isTextual(contentType: string | undefined, sample?: Uint8Array): boolean {
  if (contentType) {
    if (isTextContentType(contentType)) return true;
    const ct = contentType.toLowerCase();
    return ct.includes('charset=') && !ct.includes('charset=binary');
  }
  return sample ? looksLikeText(sample) : false;
}

/** Valid UTF-8 without NUL / unusual control bytes in the first 2 KB. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 2048);
  if (n === 0) return true;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      if (b === 0 || (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12)) return false;
      i++;
      continue;
    }
    const len = b >= 0xf0 && b < 0xf5 ? 4 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xc2 && b < 0xe0 ? 2 : 0;
    if (len === 0) return false;
    for (let k = 1; k < len; k++) {
      if (i + k >= bytes.length) return true; // truncated sample: accept
      if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    }
    i += len;
  }
  return true;
}

/* ────────────────────────────── WireBody builders ────────────────────────────── */

function sizeOnly(size: number): WireBody {
  return { encoding: 'utf8', data: '', size, truncated: true };
}

/** Body from a JS string. Strings are text by nature: base64 only for explicitly binary content types. */
export function bodyFromString(text: string, contentType: string | undefined, cfg: BodyConfig): WireBody {
  const size = utf8Length(text);
  if (!cfg.captureBodies) return sizeOnly(size);
  const max = Math.max(0, cfg.maxBodyBytes);
  if (!contentType || isTextual(contentType)) {
    if (size <= max) return { encoding: 'utf8', data: text, size };
    return { encoding: 'utf8', data: truncateUtf8(text, max), size, truncated: true };
  }
  const bytes = utf8Encode(text);
  return bodyFromBytes(bytes, contentType, cfg);
}

/** Body from raw bytes; `totalSize` is the full size when `bytes` is already a truncated prefix. */
export function bodyFromBytes(
  bytes: Uint8Array,
  contentType: string | undefined,
  cfg: BodyConfig,
  totalSize = bytes.length,
): WireBody {
  const size = Math.max(totalSize, bytes.length);
  if (!cfg.captureBodies) return sizeOnly(size);
  const max = Math.max(0, cfg.maxBodyBytes);
  const truncated = size > max || bytes.length > max;
  if (isTextual(contentType, bytes)) {
    const cut = utf8SafeCut(bytes, Math.min(max, bytes.length));
    const body: WireBody = { encoding: 'utf8', data: utf8Decode(cut === bytes.length ? bytes : bytes.subarray(0, cut)), size };
    if (truncated) body.truncated = true;
    return body;
  }
  const part = bytes.length > max ? bytes.subarray(0, max) : bytes;
  const body: WireBody = { encoding: 'base64', data: base64Encode(part), size };
  if (truncated) body.truncated = true;
  return body;
}

/** Body from base64 data (e.g. RN FileReader data URLs); `totalSize` = full size when the data is a prefix. */
export function bodyFromBase64(b64: string, contentType: string | undefined, cfg: BodyConfig, totalSize?: number): WireBody {
  const decodedLength = base64DecodedLength(b64);
  const size = Math.max(totalSize ?? decodedLength, decodedLength);
  if (!cfg.captureBodies) return sizeOnly(size);
  // Known-binary data within the limit is passed through as-is; text (or unknown → sniff) is decoded.
  if (contentType && !isTextual(contentType) && decodedLength <= Math.max(0, cfg.maxBodyBytes) && /^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    const body: WireBody = { encoding: 'base64', data: b64, size };
    if (size > decodedLength) body.truncated = true;
    return body;
  }
  return bodyFromBytes(base64Decode(b64), contentType, cfg, size);
}

/* ────────────────────────────── Blob / FormData ────────────────────────────── */

export interface BlobLike {
  size: number;
  type?: string;
  /** File name (File objects). */
  name?: string;
  slice?(start?: number, end?: number, contentType?: string): BlobLike;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export function isBlobLike(v: unknown): v is BlobLike {
  if (!v || typeof v !== 'object') return false;
  const b = v as AnyRecord;
  if (typeof b.size !== 'number' || typeof b.slice !== 'function') return false;
  const BlobCtor = g.Blob;
  if (typeof BlobCtor === 'function') {
    try {
      if (v instanceof BlobCtor) return true;
    } catch {
      // ignore
    }
  }
  return typeof b.type === 'string';
}

export function isFormDataLike(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const FD = g.FormData;
  if (typeof FD === 'function') {
    try {
      if (v instanceof FD) return true;
    } catch {
      // ignore
    }
  }
  const f = v as AnyRecord;
  return (typeof f.append === 'function' && Array.isArray(f._parts)) || (typeof f.append === 'function' && typeof f.getAll === 'function');
}

export function isArrayBufferLike(v: unknown): v is ArrayBuffer {
  if (!v || typeof v !== 'object') return false;
  const AB = g.ArrayBuffer;
  if (typeof AB === 'function' && v instanceof AB) return true;
  return Object.prototype.toString.call(v) === '[object ArrayBuffer]' || Object.prototype.toString.call(v) === '[object SharedArrayBuffer]';
}

export function isArrayBufferViewLike(v: unknown): v is ArrayBufferView {
  return !!v && typeof v === 'object' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(v);
}

export function viewToBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Reads up to `maxBytes` of a Blob: `arrayBuffer()` (web/Node) or `FileReader.readAsDataURL` (React Native). */
export function readBlobPrefix(
  blob: BlobLike,
  maxBytes: number,
  timeoutMs = 10_000,
): Promise<{ bytes?: Uint8Array; base64?: string } | undefined> {
  let part: BlobLike = blob;
  try {
    if (blob.size > maxBytes && typeof blob.slice === 'function') part = blob.slice(0, Math.max(0, maxBytes));
  } catch {
    part = blob;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { bytes?: Uint8Array; base64?: string } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolve(value);
    };
    const timer = setTimer(() => finish(undefined), timeoutMs);
    try {
      if (typeof part.arrayBuffer === 'function') {
        part.arrayBuffer().then(
          (ab) => finish({ bytes: new Uint8Array(ab) }),
          () => finish(undefined),
        );
        return;
      }
      const FR = g.FileReader;
      if (typeof FR !== 'function') {
        finish(undefined);
        return;
      }
      const reader = new FR();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          const comma = result.indexOf(',');
          finish({ base64: comma >= 0 ? result.slice(comma + 1) : '' });
        } else if (isArrayBufferLike(result)) {
          finish({ bytes: new Uint8Array(result) });
        } else finish(undefined);
      };
      reader.onerror = () => finish(undefined);
      reader.readAsDataURL(part);
    } catch {
      finish(undefined);
    }
  });
}

/** Captures a Blob as a WireBody (async, never consumes the blob). */
export function bodyFromBlob(blob: BlobLike, contentType: string | undefined, cfg: BodyConfig): Promise<WireBody | undefined> {
  const size = typeof blob.size === 'number' ? blob.size : 0;
  if (size === 0) return Promise.resolve(undefined);
  if (!cfg.captureBodies) return Promise.resolve(sizeOnly(size));
  const ct = contentType || (typeof blob.type === 'string' && blob.type ? blob.type : undefined);
  return readBlobPrefix(blob, Math.max(0, cfg.maxBodyBytes)).then((res) => {
    if (!res) return undefined;
    if (res.bytes) return bodyFromBytes(res.bytes, ct, cfg, size);
    if (res.base64 !== undefined) return bodyFromBase64(res.base64, ct, cfg, size);
    return undefined;
  });
}

function describeFormValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
  if (!value || typeof value !== 'object') return String(value);
  const v = value as AnyRecord;
  if (typeof v.uri === 'string') {
    // React Native file part: { uri, name, type }
    const out: AnyRecord = { file: typeof v.name === 'string' ? v.name : v.uri.split('/').pop() || 'file' };
    if (typeof v.type === 'string') out.type = v.type;
    out.uri = v.uri;
    return out;
  }
  if (isBlobLike(v)) {
    const out: AnyRecord = { file: typeof v.name === 'string' && v.name ? v.name : 'blob' };
    if (typeof v.type === 'string' && v.type) out.type = v.type;
    out.size = v.size;
    return out;
  }
  if (typeof v.string === 'string') return v.string;
  return String(value);
}

/** JSON summary of a FormData body: `{"field":"value","avatar":{"file":"a.jpg","type":"image/jpeg","size":123}}`. */
export function formDataSummary(fd: unknown): string {
  const fields: Array<[string, unknown]> = [];
  const f = fd as AnyRecord;
  try {
    if (Array.isArray(f._parts)) {
      for (const part of f._parts) if (Array.isArray(part)) fields.push([String(part[0]), describeFormValue(part[1])]);
    } else if (typeof f.forEach === 'function') {
      f.forEach((value: unknown, name: unknown) => fields.push([String(name), describeFormValue(value)]));
    }
  } catch {
    // partial summary
  }
  const grouped: Record<string, unknown[]> = {};
  const order: string[] = [];
  for (const [name, value] of fields) {
    if (!Object.prototype.hasOwnProperty.call(grouped, name)) {
      grouped[name] = [];
      order.push(name);
    }
    grouped[name].push(value);
  }
  const out: AnyRecord = {};
  for (const name of order) out[name] = grouped[name].length === 1 ? grouped[name][0] : grouped[name];
  return JSON.stringify(out);
}

/** Default content type browsers / RN use for a body without an explicit Content-Type header. */
export function inferContentType(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return undefined;
  const USP = g.URLSearchParams;
  if (typeof USP === 'function' && body instanceof USP) return 'application/x-www-form-urlencoded;charset=UTF-8';
  if (isFormDataLike(body)) return 'multipart/form-data';
  if (isBlobLike(body)) return typeof body.type === 'string' && body.type ? body.type : undefined;
  return undefined;
}

/**
 * Captures an outgoing request body (XHR `send()` argument or fetch `init.body`).
 * Returns undefined when there is no body or it cannot be captured without consuming it (streams).
 */
export function captureRequestBody(
  body: unknown,
  contentType: string | undefined,
  cfg: BodyConfig,
): WireBody | Promise<WireBody | undefined> | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body.length ? bodyFromString(body, contentType, cfg) : undefined;
  const USP = g.URLSearchParams;
  if (typeof USP === 'function' && body instanceof USP) {
    return bodyFromString(String(body), contentType || 'application/x-www-form-urlencoded', cfg);
  }
  if (isFormDataLike(body)) {
    // Multipart bytes are produced by the platform; report a readable field summary instead.
    return bodyFromString(formDataSummary(body), 'application/json', cfg);
  }
  if (isBlobLike(body)) return bodyFromBlob(body, contentType, cfg);
  if (isArrayBufferLike(body)) return bodyFromBytes(new Uint8Array(body), contentType, cfg);
  if (isArrayBufferViewLike(body)) return bodyFromBytes(viewToBytes(body), contentType, cfg);
  const b = body as AnyRecord;
  if (typeof b.getReader === 'function' || isPromiseLike(body)) return undefined; // streams: never consume
  if (typeof b.nodeType === 'number') {
    // Document (web)
    const XS = g.XMLSerializer;
    if (typeof XS === 'function') {
      try {
        return bodyFromString(new XS().serializeToString(body), contentType || 'application/xml', cfg);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  try {
    return bodyFromString(String(body), contentType, cfg);
  } catch {
    return undefined;
  }
}
