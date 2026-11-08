/**
 * JSON.parse for large request bodies (POST /api/import, up to 500 MB). Decoding the whole Buffer into one
 * string first put that string (twice its size as UTF-16 once a single "ş" is in it) on the heap next to the
 * parsed objects, all in one blocking JSON.parse, under the Mac app's ~4 GB heap cap. Here a top-level
 * object is walked on the bytes: each member, and each element of a member that is an array (a session's
 * `logs`, `network`, …), is decoded and parsed on its own, and the event loop gets a turn every
 * `sliceBytes`. Only the parsed values end up on the heap. The result equals JSON.parse of the whole text.
 */
import { HttpError } from './util';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

const isWs = (b: number | undefined) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

function invalid(detail: string): HttpError {
  return new HttpError(400, `Invalid JSON: ${detail}`, 'body.invalidJson');
}

function skipWs(buf: Buffer, i: number): number {
  while (i < buf.length && isWs(buf[i])) i++;
  return i;
}

/** Index after the string starting at the quote at `i`. */
function stringEnd(buf: Buffer, i: number): number {
  let from = i + 1;
  for (;;) {
    const q = buf.indexOf(QUOTE, from);
    if (q === -1) throw invalid('unterminated string');
    let slashes = 0;
    for (let k = q - 1; k > i && buf[k] === BACKSLASH; k--) slashes++;
    if (slashes % 2 === 0) return q + 1;
    from = q + 1;
  }
}

/** Index after the value starting at `i` (its syntax is checked by JSON.parse later). */
function valueEnd(buf: Buffer, i: number): number {
  const c = buf[i];
  if (c === QUOTE) return stringEnd(buf, i);
  if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
    let depth = 0;
    for (let k = i; k < buf.length; k++) {
      const b = buf[k];
      if (b === QUOTE) k = stringEnd(buf, k) - 1;
      else if (b === OPEN_OBJECT || b === OPEN_ARRAY) depth++;
      else if (b === CLOSE_OBJECT || b === CLOSE_ARRAY) {
        depth--;
        if (depth === 0) return k + 1;
      }
    }
    throw invalid('unexpected end of input');
  }
  let k = i;
  while (k < buf.length) {
    const b = buf[k];
    if (b === COMMA || b === CLOSE_OBJECT || b === CLOSE_ARRAY || isWs(b)) break;
    k++;
  }
  if (k === i) throw invalid(`unexpected character at byte ${i}`);
  return k;
}

function parseSlice(buf: Buffer, start: number, end: number): unknown {
  try {
    return JSON.parse(buf.toString('utf8', start, end));
  } catch (err) {
    throw invalid(`${(err as Error).message} (in bytes ${start}–${end})`);
  }
}

/** Set like JSON.parse does: "__proto__" becomes an own property, not the prototype. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export async function parseJsonBuffer(buf: Buffer, sliceBytes = 8 * 1024 * 1024): Promise<unknown> {
  let i = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0; // UTF-8 BOM
  i = skipWs(buf, i);
  if (i >= buf.length) return undefined;
  if (buf[i] !== OPEN_OBJECT) {
    const end = valueEnd(buf, i);
    if (skipWs(buf, end) !== buf.length) throw invalid(`unexpected data after the value at byte ${end}`);
    return parseSlice(buf, i, end);
  }
  let sinceYield = 0;
  const pace = async (bytes: number) => {
    sinceYield += bytes;
    if (sinceYield < sliceBytes) return;
    sinceYield = 0;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const out: Record<string, unknown> = {};
  i = skipWs(buf, i + 1);
  if (buf[i] === CLOSE_OBJECT) i++;
  else {
    for (;;) {
      if (buf[i] !== QUOTE) throw invalid(`expected a property name at byte ${i}`);
      const keyEnd = stringEnd(buf, i);
      const key = parseSlice(buf, i, keyEnd) as string;
      i = skipWs(buf, keyEnd);
      if (buf[i] !== COLON) throw invalid(`expected ":" at byte ${i}`);
      i = skipWs(buf, i + 1);
      if (buf[i] === OPEN_ARRAY) {
        const list: unknown[] = [];
        i = skipWs(buf, i + 1);
        if (buf[i] === CLOSE_ARRAY) i++;
        else {
          for (;;) {
            const end = valueEnd(buf, i);
            list.push(parseSlice(buf, i, end));
            await pace(end - i);
            i = skipWs(buf, end);
            if (buf[i] === COMMA) i = skipWs(buf, i + 1);
            else if (buf[i] === CLOSE_ARRAY) {
              i++;
              break;
            } else throw invalid(`expected "," or "]" at byte ${i}`);
          }
        }
        define(out, key, list);
      } else {
        const end = valueEnd(buf, i);
        define(out, key, parseSlice(buf, i, end));
        await pace(end - i);
        i = end;
      }
      i = skipWs(buf, i);
      if (buf[i] === COMMA) i = skipWs(buf, i + 1);
      else if (buf[i] === CLOSE_OBJECT) {
        i++;
        break;
      } else throw invalid(`expected "," or "}" at byte ${i}`);
    }
  }
  if (skipWs(buf, i) !== buf.length) throw invalid(`unexpected data after the value at byte ${i}`);
  return out;
}
