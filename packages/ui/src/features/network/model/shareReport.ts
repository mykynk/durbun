import type { Header, WireBody } from '@durbun/protocol';
import { copyAs } from './copyAs';
import { reasonPhrase } from './http';

/**
 * The share report: one request as text a teammate can read without Dürbün (Slack, Jira, e-mail,
 * GitHub). Light Markdown: plain lines, a bullet list and fenced blocks, so it reads well rendered
 * and as plain text. The Flutter in-app panel builds the same text (`share_report.dart` in
 * `sdks/flutter/durbun`); keep the two in step (`shareReport.test.ts` and `share_report_test.dart`
 * pin the same English report).
 *
 * Secret values are masked by default (headers such as Authorization and Cookie, token/password
 * query keys and JSON/form fields). Numbers and units are formatted without a locale.
 */

export const MASK = '••••';
/** Longer bodies are cut for sharing (a chat message stays readable). */
export const MAX_SHARED_BODY_CHARS = 20_000;

export interface ShareInput {
  method: string;
  url: string;
  state: 'pending' | 'complete' | 'failed' | 'cancelled';
  status?: number;
  statusText?: string;
  error?: string;
  /** Epoch ms. */
  startTs: number;
  /** Minutes east of UTC for the local time (default: this machine's offset at `startTs`). */
  utcOffsetMinutes?: number;
  /** ms */
  duration?: number;
  source: string;
  /** e.g. "mutation Login" */
  graphql?: string;
  app?: string;
  device?: string;
  mocked?: boolean;
  /** Rule name or id. */
  mockRule?: string;
  requestHeaders: readonly Header[];
  responseHeaders?: readonly Header[];
  requestContentType?: string;
  responseContentType?: string;
  requestBody?: WireBody | null;
  responseBody?: WireBody | null;
  /** A body was sent / received but not captured (or dropped later). */
  requestBodyMissing?: boolean;
  responseBodyMissing?: boolean;
}

export interface ShareOptions {
  /** Replace secret values with ••••. */
  mask: boolean;
  /** Request and response bodies (also the body in cURL). */
  bodies: boolean;
  /** A cURL command at the end. */
  curl: boolean;
}

export const DEFAULT_SHARE_OPTIONS: ShareOptions = { mask: true, bodies: true, curl: true };

export interface ShareLabels {
  pending: string;
  failed: string;
  cancelled: string;
  time: string;
  app: string;
  device: string;
  client: string;
  graphql: string;
  trace: string;
  mocked: (rule: string | undefined) => string;
  error: string;
  requestHeaders: string;
  responseHeaders: string;
  requestBody: string;
  responseBody: string;
  notCaptured: string;
  binary: string;
  captured: (captured: string, total: string) => string;
  more: (chars: number) => string;
  curlNoBody: string;
  masked: string;
}

/* ───────────── secrets ───────────── */

const SECRET_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'pwd', 'pass', 'otp', 'auth', 'session', 'sid']);
const SECRET_PARTS = ['token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'api-key', 'credential', 'signature', 'sessionid', 'session_id', 'session-id'];

/** Header, query, form or JSON key whose value is a secret. */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAMES.has(n) || SECRET_PARTS.some((p) => n.includes(p));
}

function maskHeaderValue(name: string, value: string): string {
  const n = name.toLowerCase();
  if (n === 'cookie') {
    return value
      .split(';')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map((p) => (p.indexOf('=') > 0 ? `${p.slice(0, p.indexOf('='))}=${MASK}` : p))
      .join('; ');
  }
  if (n === 'set-cookie') {
    const parts = value.split(';').map((p) => p.trim());
    const first = parts[0] ?? '';
    const eq = first.indexOf('=');
    return [eq > 0 ? `${first.slice(0, eq)}=${MASK}` : MASK, ...parts.slice(1).filter((p) => p !== '')].join('; ');
  }
  if (n === 'authorization' || n === 'proxy-authorization') {
    const m = /^(\S+)\s+\S/.exec(value);
    return m ? `${m[1]} ${MASK}` : MASK;
  }
  return MASK;
}

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

const JSON_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

class Masker {
  count = 0;

  constructor(readonly on: boolean) {}

  private hit<T>(v: T): T {
    this.count++;
    return v;
  }

  header(name: string, value: string): string {
    if (!this.on || !isSecretName(name) || value === MASK) return value;
    const masked = maskHeaderValue(name, value);
    return masked === value ? value : this.hit(masked);
  }

  headers(list: readonly Header[]): Header[] {
    return list.map(([n, v]) => [n, this.header(n, v)] as Header);
  }

  query(qs: string): string {
    if (!this.on) return qs;
    return qs
      .split('&')
      .map((p) => {
        const eq = p.indexOf('=');
        if (eq <= 0 || !isSecretName(decodeKey(p.slice(0, eq))) || p.slice(eq + 1) === MASK || eq === p.length - 1) return p;
        return this.hit(`${p.slice(0, eq)}=${MASK}`);
      })
      .join('&');
  }

  url(url: string): string {
    if (!this.on) return url;
    const hash = url.indexOf('#');
    const base = hash < 0 ? url : url.slice(0, hash);
    const frag = hash < 0 ? '' : url.slice(hash);
    let out = base.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@:]*):([^/?#@]+)@/, (_m, head: string) => this.hit(`${head}:${MASK}@`));
    const q = out.indexOf('?');
    if (q >= 0) out = out.slice(0, q + 1) + this.query(out.slice(q + 1));
    return out + frag;
  }

  body(text: string, contentType: string, json: boolean): string {
    if (!this.on) return text;
    if (json) {
      return text.replace(JSON_PAIR, (m, key: string, sep: string, value: string) =>
        isSecretName(key) && value !== MASK ? this.hit(`"${key}"${sep}"${MASK}"`) : m,
      );
    }
    if (contentType.toLowerCase().includes('x-www-form-urlencoded')) return this.query(text);
    return text;
  }
}

/* ───────────── formatting ───────────── */

const TRACE_HEADERS = new Set([
  'x-request-id',
  'x-correlation-id',
  'correlation-id',
  'request-id',
  'x-trace-id',
  'traceparent',
  'x-amzn-trace-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-b3-traceid',
  'x-cloud-trace-context',
  'cf-ray',
  'x-vercel-id',
  'sentry-trace',
  'x-datadog-trace-id',
]);

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** "2026-11-04 19:22:19.768 (UTC+03:00) · 2026-11-04T16:22:19.768Z" */
export function shareTime(ts: number, utcOffsetMinutes?: number): string {
  const ms = Math.round(ts);
  const off = utcOffsetMinutes ?? -new Date(ms).getTimezoneOffset();
  const local = new Date(ms + off * 60_000).toISOString();
  const abs = Math.abs(off);
  const zone = `UTC${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${local.slice(0, 10)} ${local.slice(11, 23)} (${zone}) · ${new Date(ms).toISOString()}`;
}

/** "12 B", "1.5 KB", "3.2 MB" (no locale: the report is technical). */
export function shareBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "120 ms", "1.50 s" */
export function shareDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Pretty JSON without parsing it: numbers stay exactly as sent, cut or broken JSON still indents. */
export function reindentJson(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let depth = 0;
  let i = 0;
  const nl = () => '\n' + '  '.repeat(depth);
  const space = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, Math.min(j + 1, n)));
      i = j + 1;
    } else if (space(ch)) {
      i++;
    } else if (ch === '{' || ch === '[') {
      let j = i + 1;
      while (j < n && space(text[j])) j++;
      if (text[j] === (ch === '{' ? '}' : ']')) {
        out.push(ch + text[j]!);
        i = j + 1;
      } else {
        depth++;
        out.push(ch + nl());
        i++;
      }
    } else if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
      out.push(nl() + ch);
      i++;
    } else if (ch === ',') {
      out.push(',' + nl());
      i++;
    } else if (ch === ':') {
      out.push(': ');
      i++;
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join('');
}

function looksJson(contentType: string, text: string): boolean {
  if (contentType.toLowerCase().includes('json')) return true;
  const t = text.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function fenceLanguage(contentType: string, json: boolean): string {
  const ct = contentType.toLowerCase();
  if (json) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  return '';
}

/** A fence longer than any backtick run in [text], so the block never closes early. */
function fenced(out: string[], language: string, text: string): void {
  let longest = 0;
  for (const run of text.match(/`{3,}/g) ?? []) longest = Math.max(longest, run.length);
  const f = '`'.repeat(Math.max(3, longest + 1));
  out.push(`${f}${language}`, text, f, '');
}

function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

function base64Size(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

function bodySection(
  out: string[],
  label: string,
  body: WireBody | null | undefined,
  missing: boolean | undefined,
  contentType: string | undefined,
  m: Masker,
  labels: ShareLabels,
): void {
  if (!body || body.data === '') {
    if (missing || (body && body.size > 0)) out.push(`${label}: ${labels.notCaptured}`, '');
    return;
  }
  const ct = contentType ?? '';
  const captured = body.encoding === 'base64' ? base64Size(body.data) : utf8Size(body.data);
  const size = body.truncated || captured < body.size ? labels.captured(shareBytes(captured), shareBytes(body.size)) : shareBytes(body.size);
  const head = `${label} (${[ct.split(';')[0]!.trim(), size].filter((s) => s !== '').join(', ')})`;
  if (body.encoding === 'base64') {
    out.push(`${head}: ${labels.binary}`, '');
    return;
  }
  const json = looksJson(ct, body.data);
  let text = m.body(body.data, ct, json);
  if (json) text = reindentJson(text);
  let rest = 0;
  if (text.length > MAX_SHARED_BODY_CHARS) {
    let cut = MAX_SHARED_BODY_CHARS;
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    rest = text.length - cut;
    text = text.slice(0, cut);
  }
  out.push(`${head}:`);
  fenced(out, fenceLanguage(ct, json), text);
  if (rest > 0) out.push(labels.more(rest), '');
}

function headerSection(out: string[], label: string, headers: readonly Header[], m: Masker): void {
  if (headers.length === 0) return;
  out.push(`${label} (${headers.length}):`);
  fenced(out, 'http', m.headers(headers).map(([n, v]) => `${n}: ${v}`).join('\n'));
}

function outcome(input: ShareInput, labels: ShareLabels): string {
  const parts: string[] = [];
  if (input.state === 'pending') return labels.pending;
  if (input.status !== undefined) parts.push(`${input.status} ${input.statusText || reasonPhrase(input.status) || ''}`.trim());
  if (input.state === 'cancelled') parts.push(labels.cancelled);
  else if (input.state === 'failed') parts.push(labels.failed);
  if (input.duration !== undefined) parts.push(shareDuration(input.duration));
  return parts.join(' · ');
}

function traceIds(headers: readonly Header[]): string[] {
  const out: string[] = [];
  for (const [name, value] of headers) {
    if (!TRACE_HEADERS.has(name.toLowerCase())) continue;
    const item = `${name} ${value}`;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function buildShareReport(input: ShareInput, options: ShareOptions, labels: ShareLabels): string {
  const m = new Masker(options.mask);
  const method = (input.method && input.method !== '?' ? input.method : 'GET').toUpperCase();
  const url = m.url(input.url);
  const out: string[] = [`${method} ${url}`, `→ ${outcome(input, labels)}`, ''];

  out.push(`- ${labels.time}: ${shareTime(input.startTs, input.utcOffsetMinutes)}`);
  if (input.graphql) out.push(`- ${labels.graphql}: ${input.graphql}`);
  if (input.app) out.push(`- ${labels.app}: ${input.app}`);
  if (input.device) out.push(`- ${labels.device}: ${input.device}`);
  out.push(`- ${labels.client}: ${input.source}`);
  const ids = traceIds([...input.requestHeaders, ...(input.responseHeaders ?? [])]);
  if (ids.length > 0) out.push(`- ${labels.trace}: ${ids.join(' · ')}`);
  if (input.mocked) out.push(`- ${labels.mocked(input.mockRule)}`);
  out.push('');

  if (input.error && input.state !== 'cancelled') {
    out.push(`${labels.error}:`);
    fenced(out, '', input.error);
  }
  headerSection(out, labels.requestHeaders, input.requestHeaders, m);
  if (options.bodies) bodySection(out, labels.requestBody, input.requestBody, input.requestBodyMissing, input.requestContentType, m, labels);
  headerSection(out, labels.responseHeaders, input.responseHeaders ?? [], m);
  if (options.bodies) bodySection(out, labels.responseBody, input.responseBody, input.responseBodyMissing, input.responseContentType, m, labels);

  if (options.curl && input.method !== '?') {
    const b = options.bodies ? input.requestBody : null;
    const ct = input.requestContentType ?? '';
    // A body too long to show is too long for the command too.
    const tooLong = !!b && b.encoding === 'utf8' && b.data.length > MAX_SHARED_BODY_CHARS;
    const body = tooLong ? null : b && b.encoding === 'utf8' && b.data !== '' ? { ...b, data: m.body(b.data, ct, looksJson(ct, b.data)) } : b;
    out.push('cURL:');
    fenced(out, 'bash', copyAs('curl', { method, url, headers: m.headers(input.requestHeaders), body }).code);
    if (tooLong) out.push(labels.curlNoBody, '');
  }
  if (m.count > 0) out.push(labels.masked);
  return out.join('\n').trimEnd();
}
