/**
 * Which names hold secrets (credential headers; password / token / key / session fields of bodies and queries),
 * and masking of captured requests for files people share (HAR, session exports). One heuristic for the whole
 * product: "create a flow from requests" moves the same values into secret environment variables.
 * Masked values become SECRET_MASK; names, cookie names and the auth scheme ("Bearer") stay readable.
 */
import type { Header, LogEntry, NetworkDetail, StreamMessage, WireBody } from './index';

/** What a masked value is replaced by (the flows' MASK too). */
export const SECRET_MASK = '••••';

/** Header names whose value is always a secret. */
export const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Words of a field / header / query name that mark its value as a secret. */
const SECRET_WORDS = new Set(['password', 'passwd', 'pass', 'pwd', 'passcode', 'passphrase', 'secret', 'token', 'otp', 'pin', 'auth', 'authorization', 'session', 'sessionid', 'sid', 'cookie', 'signature', 'sig', 'credential', 'credentials', 'jwt', 'apikey', 'appcheck']);
/** A word that is a secret only after one of these (`api_key`, `accessKey`; not `idempotency-key`). */
const KEY_PREFIXES = new Set(['api', 'access', 'private', 'secret', 'subscription', 'client', 'app', 'master']);

/** Words of a name: `newPassword` → new, password; `X-Goog-Api-Key` → x, goog, api, key. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Does a field, header or query name hold a secret (password, token, api key, session, cookie…)? */
export function isSecretName(name: string): boolean {
  if (SECRET_HEADERS.has(name.toLowerCase())) return true;
  const words = nameWords(name);
  if (words.length === 1 && words[0] === 'key') return true;
  return words.some((w, i) => SECRET_WORDS.has(w) || (w === 'key' && i > 0 && KEY_PREFIXES.has(words[i - 1]!)));
}

/** A header whose value is a secret. CORS policy headers (`Access-Control-Allow-Credentials`) only describe one. */
export function isSecretHeader(name: string): boolean {
  const n = name.toLowerCase();
  return !n.startsWith('access-control-') && isSecretName(n);
}

/** A secret header's value with the secret parts masked: cookie names and the auth scheme stay. */
export function maskHeaderValue(name: string, value: string): string {
  const n = name.toLowerCase();
  if (value === SECRET_MASK) return value;
  if (n === 'cookie') {
    return value
      .split(';')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map((p) => (p.indexOf('=') > 0 ? `${p.slice(0, p.indexOf('='))}=${SECRET_MASK}` : SECRET_MASK))
      .join('; ');
  }
  if (n === 'set-cookie') {
    const parts = value.split(';').map((p) => p.trim());
    const first = parts[0] ?? '';
    const eq = first.indexOf('=');
    return [eq > 0 ? `${first.slice(0, eq)}=${SECRET_MASK}` : SECRET_MASK, ...parts.slice(1).filter((p) => p !== '')].join('; ');
  }
  if (n === 'authorization' || n === 'proxy-authorization') {
    const m = /^(\S+)\s+\S/.exec(value);
    return m ? `${m[1]} ${SECRET_MASK}` : SECRET_MASK;
  }
  return SECRET_MASK;
}

export function maskHeaders(list: readonly Header[]): Header[] {
  return list.map(([n, v]) => (isSecretHeader(n) ? ([n, maskHeaderValue(n, v)] as Header) : ([n, v] as Header)));
}

function decodeName(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

/** A query string or a form body (`a=1&token=x`, no leading "?") with secret values masked. */
export function maskQuery(qs: string): string {
  return qs
    .split('&')
    .map((p) => {
      const eq = p.indexOf('=');
      if (eq <= 0 || eq === p.length - 1 || !isSecretName(decodeName(p.slice(0, eq)))) return p;
      return `${p.slice(0, eq)}=${SECRET_MASK}`;
    })
    .join('&');
}

/** A URL (or a path with a query) with its password (`user:pw@`) and secret query values masked. */
export function maskUrl(url: string): string {
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const frag = hash < 0 ? '' : url.slice(hash);
  let out = base.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@:]*):([^/?#@]+)@/, (_m, head: string) => `${head}:${SECRET_MASK}@`);
  const q = out.indexOf('?');
  if (q >= 0) out = out.slice(0, q + 1) + maskQuery(out.slice(q + 1));
  return out + frag;
}

/** `"key": "value"` / `"key": 123` / `"key": true` pairs of a JSON text (also inside a truncated body). */
const JSON_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true\b|false\b)/g;

/** A text body with secret JSON fields or form fields masked (other text unchanged). */
export function maskBodyText(text: string, contentType: string | undefined): string {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('x-www-form-urlencoded')) return maskQuery(text);
  const head = text.trimStart()[0];
  if (type.includes('json') || head === '{' || head === '[') {
    return text.replace(JSON_PAIR, (m, key: string, sep: string, value: string) => (isSecretName(key) && value !== `"${SECRET_MASK}"` ? `"${key}"${sep}"${SECRET_MASK}"` : m));
  }
  return text;
}

function headerOf(headers: readonly Header[] | undefined, name: string): string | undefined {
  return headers?.find(([k]) => k.toLowerCase() === name)?.[1];
}

function maskBody(body: WireBody | undefined, contentType: string | undefined): WireBody | undefined {
  if (!body || body.encoding !== 'utf8') return body;
  const data = maskBodyText(body.data, contentType);
  return data === body.data ? body : { ...body, data };
}

/** A copy of a captured request with its secrets masked (headers, cookies, URL, text bodies). */
export function maskNetworkDetail(d: NetworkDetail): NetworkDetail {
  const out: NetworkDetail = { ...d, url: maskUrl(d.url), path: maskUrl(d.path), requestHeaders: maskHeaders(d.requestHeaders ?? []) };
  if (d.responseHeaders) out.responseHeaders = maskHeaders(d.responseHeaders);
  const requestBody = maskBody(d.requestBody, d.requestContentType ?? headerOf(d.requestHeaders, 'content-type'));
  if (requestBody) out.requestBody = requestBody;
  const responseBody = maskBody(d.responseBody, d.responseContentType ?? headerOf(d.responseHeaders, 'content-type'));
  if (responseBody) out.responseBody = responseBody;
  if (d.streamMessages) out.streamMessages = d.streamMessages.map(maskStreamMessage);
  return out;
}

/**
 * A stream message with secret-looking fields of a JSON / form payload masked (a chat socket's auth message,
 * a token in an event); other text and binary payloads unchanged.
 */
export function maskStreamMessage(m: StreamMessage): StreamMessage {
  const body = maskBody(m.body, undefined);
  return body === m.body ? m : { ...m, body };
}

/** A log row with the secrets of a network row's "METHOD URL" text masked (other rows unchanged). */
export function maskLogEntry(e: LogEntry): LogEntry {
  if (e.kind !== 'network') return e;
  const message = e.message.replace(/\S+:\/\/\S+/g, (u) => maskUrl(u));
  return message === e.message ? e : { ...e, message };
}
