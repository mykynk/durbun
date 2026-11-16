import type { Header, NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { decodeBody } from './body';

/**
 * Where the text a body search found sits in one request, so the detail panel can open that tab and section and
 * mark the match: the response body first (what people search for most), then the request body, the headers and
 * the URL. Case-insensitive like the server's search (plain `toLowerCase`, SPEC §7.1).
 */
export type MatchPlace =
  | { tab: 'response'; section: 'body' | 'headers' }
  | { tab: 'request'; section: 'body' | 'headers' | 'query' }
  | { tab: 'general'; section: 'url' };

function headersHave(headers: readonly Header[] | undefined, needle: string): boolean {
  return !!headers?.some(([k, v]) => k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle));
}

function bodyHas(wire: NetworkDetail['requestBody'], needle: string): boolean {
  const text = decodeBody(wire)?.text;
  return !!text && text.toLowerCase().includes(needle);
}

/** Where `text` occurs in this request (bodies only when the detail is loaded), or null. */
export function findMatchPlace(entry: NetworkEntry, detail: NetworkDetail | null | undefined, text: string): MatchPlace | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  if (detail && bodyHas(detail.responseBody, needle)) return { tab: 'response', section: 'body' };
  if (detail && bodyHas(detail.requestBody, needle)) return { tab: 'request', section: 'body' };
  if (headersHave(entry.responseHeaders, needle)) return { tab: 'response', section: 'headers' };
  if (headersHave(entry.requestHeaders, needle)) return { tab: 'request', section: 'headers' };
  const q = entry.url.indexOf('?');
  if (q >= 0 && entry.url.slice(q + 1).toLowerCase().includes(needle)) return { tab: 'request', section: 'query' };
  if (entry.url.toLowerCase().includes(needle)) return { tab: 'general', section: 'url' };
  return null;
}

/** Case-insensitive [start, end) offsets of `needle` in `text` (at most `max`). */
export function matchOffsets(text: string, needle: string, max = 500): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = needle.toLowerCase();
  if (!n) return out;
  const hay = text.toLowerCase();
  // `toLowerCase` keeps lengths for everything but a few letters (İ); offsets are only used when they line up.
  if (hay.length !== text.length) return out;
  let at = hay.indexOf(n);
  while (at >= 0 && out.length < max) {
    out.push([at, at + n.length]);
    at = hay.indexOf(n, at + n.length);
  }
  return out;
}
