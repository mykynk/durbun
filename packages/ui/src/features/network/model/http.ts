import type { Header } from '@durbun/protocol';

/** HTTP helpers for the network view: headers, query strings, cookies, reason phrases. Pure functions. */

export function headerValue(headers: readonly Header[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) if (h[0].toLowerCase() === lower) return h[1];
  return undefined;
}

export function headerValues(headers: readonly Header[] | undefined, name: string): string[] {
  if (!headers) return [];
  const lower = name.toLowerCase();
  const out: string[] = [];
  for (const h of headers) if (h[0].toLowerCase() === lower) out.push(h[1]);
  return out;
}

/** Decode a URL component leniently: '+' → space, malformed escapes are kept as written. */
export function decodeComponent(s: string, plusAsSpace = true): string {
  const v = plusAsSpace ? s.replace(/\+/g, ' ') : s;
  try {
    return decodeURIComponent(v);
  } catch {
    // Decode the valid escapes one by one, keep the broken ones.
    return v.replace(/(%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

export interface Param {
  name: string;
  value: string;
}

/** `a=1&b=x%20y&a=2&flag` → [{a,1},{b,'x y'},{a,2},{flag,''}] (order and duplicates kept). */
export function parseParams(query: string): Param[] {
  const q = query.startsWith('?') ? query.slice(1) : query;
  if (!q) return [];
  const out: Param[] = [];
  for (const part of q.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    out.push({ name: decodeComponent(rawName), value: decodeComponent(rawValue) });
  }
  return out;
}

/** Query string of a URL or path (`?…` without the fragment), '' when none. */
export function queryOf(urlOrPath: string): string {
  const hash = urlOrPath.indexOf('#');
  const s = hash >= 0 ? urlOrPath.slice(0, hash) : urlOrPath;
  const q = s.indexOf('?');
  return q >= 0 ? s.slice(q) : '';
}

/** Decoded query parameters of a URL. */
export function queryParams(url: string): Param[] {
  return parseParams(queryOf(url));
}

/**
 * Readable form of a URL/path for display: UTF-8 escapes are decoded (`k%C4%B1` → `kı`) while escapes of
 * reserved characters (`%2F`, `%26`, `%3D`…) stay as they are, so the structure is unchanged.
 */
export function displayUrl(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** `/v1/pets?page=2` → { pathname: '/v1/pets', query: '?page=2' }. */
export function splitPathQuery(path: string): { pathname: string; query: string } {
  const q = path.indexOf('?');
  if (q < 0) return { pathname: path || '/', query: '' };
  return { pathname: path.slice(0, q) || '/', query: path.slice(q) };
}

/* ───────────── Cookies ───────────── */

export interface Cookie {
  name: string;
  value: string;
}

/** `Cookie: a=1; b=2` → [{a,1},{b,2}]. */
export function parseCookieHeader(value: string): Cookie[] {
  const out: Cookie[] = [];
  for (const part of value.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq < 0) out.push({ name: s, value: '' });
    else out.push({ name: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() });
  }
  return out;
}

export function requestCookies(headers: readonly Header[] | undefined): Cookie[] {
  return headerValues(headers, 'cookie').flatMap(parseCookieHeader);
}

export interface SetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: string;
  sameSite?: string;
  secure: boolean;
  httpOnly: boolean;
  partitioned: boolean;
  /** Other attributes, as written. */
  other: Param[];
}

export function parseSetCookie(value: string): SetCookie | null {
  const parts = value.split(';');
  const first = parts.shift()?.trim() ?? '';
  if (!first) return null;
  const eq = first.indexOf('=');
  const cookie: SetCookie = {
    name: (eq < 0 ? first : first.slice(0, eq)).trim(),
    value: eq < 0 ? '' : first.slice(eq + 1).trim(),
    secure: false,
    httpOnly: false,
    partitioned: false,
    other: [],
  };
  if (!cookie.name) return null;
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    const key = (i < 0 ? s : s.slice(0, i)).trim();
    const val = i < 0 ? '' : s.slice(i + 1).trim();
    switch (key.toLowerCase()) {
      case 'domain':
        cookie.domain = val;
        break;
      case 'path':
        cookie.path = val;
        break;
      case 'expires':
        cookie.expires = val;
        break;
      case 'max-age':
        cookie.maxAge = val;
        break;
      case 'samesite':
        cookie.sameSite = val;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'partitioned':
        cookie.partitioned = true;
        break;
      default:
        cookie.other.push({ name: key, value: val });
    }
  }
  return cookie;
}

/**
 * Split a Set-Cookie value that an SDK folded into one line ("a=1; Path=/, b=2; Expires=Wed, 21 Oct 2026 …").
 * A comma starts a new cookie only when it is followed by `name=` (Expires dates contain commas too).
 */
export function splitFoldedSetCookie(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function responseCookies(headers: readonly Header[] | undefined): SetCookie[] {
  const out: SetCookie[] = [];
  for (const v of headerValues(headers, 'set-cookie')) {
    for (const piece of splitFoldedSetCookie(v)) {
      const c = parseSetCookie(piece);
      if (c) out.push(c);
    }
  }
  return out;
}

/* ───────────── Status texts ───────────── */

export const REASON_PHRASES: Readonly<Record<number, string>> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  418: "I'm a teapot",
  422: 'Unprocessable Content',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

export function reasonPhrase(status: number | undefined): string | undefined {
  return status === undefined ? undefined : REASON_PHRASES[status];
}

/** File-ish name for downloads: host + last path segment, filesystem-safe. */
export function safeFileStem(host: string, path: string): string {
  const { pathname } = splitPathQuery(path);
  const last = pathname.split('/').filter(Boolean).pop() ?? '';
  const stem = `${host}${last ? `-${last}` : ''}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return stem.slice(0, 80) || 'request';
}
