/**
 * Turns `console.*` / `Durbun.log` arguments into a readable one-line message plus structured data:
 *  - printf-style substitutions (%s %d %i %f %o %O %j %c %%) like browsers and Node;
 *  - objects render as compact JSON in the message and are kept as JSON-safe `data` (tree in the UI);
 *  - the first Error becomes `error` (type/message/stack) so the UI can fold the stack trace;
 *  - a leading "[Tag] " becomes the log tag (hash-colored chip in the UI) and is removed from the text.
 */
import type { ErrorInfo } from './protocol.js';
import { errorInfo, isErrorLike, previewValue, toJsonSafe } from './jsonSafe.js';

export interface FormattedArgs {
  message: string;
  data?: unknown;
  error?: ErrorInfo;
  tag?: string;
}

const OBJECT_PREVIEW_CHARS = 1_000;

/** Objects and arrays are kept as structured `data`; functions only render as text. */
function isStructured(v: unknown): boolean {
  return typeof v === 'object' && v !== null;
}

/** Single argument → text, the way consoles print it. */
export function renderArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return `${String(v)}n`;
  if (typeof v === 'symbol') return previewValue(v);
  if (typeof v === 'function') return `[Function: ${(v as { name?: string }).name || 'anonymous'}]`;
  if (isErrorLike(v)) {
    const info = errorInfo(v);
    return info.message ? `${info.type}: ${info.message}` : String(info.type);
  }
  return previewValue(v, OBJECT_PREVIEW_CHARS);
}

function formatNumber(v: unknown, integer: boolean): string {
  if (typeof v === 'bigint') return `${String(v)}n`;
  if (typeof v === 'symbol') return 'NaN';
  const n = integer ? parseInt(String(v), 10) : typeof v === 'number' ? v : parseFloat(String(v));
  return String(n);
}

const LEVEL_WORDS = /^(verbose|trace|debug|info|information|log|warn|warning|error|err|fatal|critical)$/i;

/** "[Auth] Login ok" → { tag: 'Auth', rest: 'Login ok' }; level words, numbers and timestamps are not tags. */
export function extractTagPrefix(message: string): { tag: string; rest: string } | undefined {
  const m = /^\[([A-Za-z_][\w.:/@#-]{0,39})\][ \t]+(?=\S)/.exec(message);
  if (!m || LEVEL_WORDS.test(m[1])) return undefined;
  return { tag: m[1], rest: message.slice(m[0].length) };
}

/** Formats console-style arguments (see module doc). */
export function formatArgs(args: readonly unknown[], opts: { extractTag?: boolean } = {}): FormattedArgs {
  const parts: string[] = [];
  const structured: unknown[] = [];
  let error: ErrorInfo | undefined;
  let i = 0;

  const note = (v: unknown) => {
    if (isErrorLike(v)) {
      if (!error) error = errorInfo(v);
    } else if (isStructured(v)) structured.push(v);
  };

  if (typeof args[0] === 'string' && args[0].indexOf('%') >= 0 && args.length > 1) {
    const fmt = args[0];
    i = 1;
    let out = '';
    let last = 0;
    const re = /%[sdifoOjc%]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fmt))) {
      out += fmt.slice(last, m.index);
      last = m.index + m[0].length;
      const spec = m[0][1];
      if (spec === '%') {
        out += '%';
        continue;
      }
      if (i >= args.length) {
        out += m[0];
        continue;
      }
      const arg = args[i++];
      switch (spec) {
        case 's':
          out += renderArg(arg);
          note(arg);
          break;
        case 'd':
          out += formatNumber(arg, false);
          break;
        case 'i':
          out += formatNumber(arg, true);
          break;
        case 'f':
          out += String(typeof arg === 'number' ? arg : parseFloat(String(arg)));
          break;
        case 'o':
        case 'O':
        case 'j':
          out += isStructured(arg) && !isErrorLike(arg) ? previewValue(arg, OBJECT_PREVIEW_CHARS) : renderArg(arg);
          note(arg);
          break;
        case 'c':
          // CSS styling: consumed, not printed.
          break;
        default:
          break;
      }
    }
    out += fmt.slice(last);
    parts.push(out);
  }

  for (; i < args.length; i++) {
    const arg = args[i];
    parts.push(renderArg(arg));
    note(arg);
  }

  let message = parts.join(' ');
  const result: FormattedArgs = { message };
  if (opts.extractTag) {
    const prefix = extractTagPrefix(message);
    if (prefix) {
      result.tag = prefix.tag;
      message = prefix.rest;
      result.message = message;
    }
  }
  if (structured.length === 1) result.data = toJsonSafe(structured[0]);
  else if (structured.length > 1) result.data = toJsonSafe(structured);
  if (error) result.error = error;
  return result;
}
