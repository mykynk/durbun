import type { Header } from './protocol.js';
import type { AnyRecord } from './util.js';

/** Parses `XMLHttpRequest.getAllResponseHeaders()` output ("name: value\r\n" lines). */
export function parseRawHeaders(raw: unknown): Header[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out: Header[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return out;
}

/**
 * Converts any fetch `HeadersInit`-like value into ordered pairs: a `Headers` instance, an array of
 * pairs, or a plain record. Unknown shapes yield an empty list.
 */
export function headersFromInit(init: unknown): Header[] {
  const out: Header[] = [];
  if (!init || typeof init !== 'object') return out;
  try {
    if (Array.isArray(init)) {
      for (const pair of init) {
        if (pair && typeof pair[0] === 'string' && pair.length >= 2) out.push([pair[0], String(pair[1])]);
      }
      return out;
    }
    const h = init as AnyRecord;
    if (typeof h.forEach === 'function' && typeof h.get === 'function') {
      // Headers (WHATWG / whatwg-fetch polyfill / undici).
      h.forEach((value: unknown, name: unknown) => {
        out.push([String(name), String(value)]);
      });
      return out;
    }
    for (const key of Object.keys(h)) {
      const value = h[key];
      if (value === undefined || value === null || typeof value === 'function') continue;
      if (Array.isArray(value)) for (const v of value) out.push([key, String(v)]);
      else out.push([key, String(value)]);
    }
  } catch {
    // Exotic header objects: report what we collected so far.
  }
  return out;
}

/** Case-insensitive lookup; multiple values are joined with ", " (XHR semantics). */
export function findHeader(headers: readonly Header[], name: string): string | undefined {
  const lower = name.toLowerCase();
  let found: string | undefined;
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) found = found === undefined ? v : `${found}, ${v}`;
  }
  return found;
}

/** Serializes pairs back into the raw `getAllResponseHeaders()` format (lower-cased names). */
export function toRawHeaders(headers: readonly Header[]): string {
  let out = '';
  for (const [k, v] of headers) out += `${k.toLowerCase()}: ${v}\r\n`;
  return out;
}
