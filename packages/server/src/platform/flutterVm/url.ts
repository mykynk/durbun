/**
 * Dart VM service URL handling: find a service URL in arbitrary pasted text (`flutter run` output,
 * DevTools links, device log lines) and normalize it to the WebSocket endpoint `ws://host:port/<token>=/ws`.
 */

const SCHEME_URL_RE = /(?:https?|wss?):\/\/[^\s'"<>`]+/gi;
const BARE_HOST_PORT_RE =
  /(?:^|[\s'"(=])((?:\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[0-9a-fA-F:.]+\]):\d{2,5}\/[^\s'"<>`]*)/g;
/** Lines that announce a VM service (device logs, `flutter run`, `dart run --observe`). */
const VM_LINE_RE = /\b(?:Dart VM [Ss]ervice|VM [Ss]ervice|Observatory)\b/;
/** Device-side announcement, e.g. "The Dart VM service is listening on http://127.0.0.1:41935/Ab0-c_d1E2f=/". */
const ANNOUNCEMENT_RE =
  /(?:Dart VM [Ss]ervice is listening on|VM [Ss]ervice is listening on|Observatory listening on)\s+((?:https?:)?\/\/[A-Za-z0-9:/=_\-.~+%[\]]+)/;
/** Auth-token path segment the VM service / DDS put in front of every path, e.g. "/xGm5ma3sRbA=/". */
const TOKEN_PATH_RE = /\/[A-Za-z0-9_\-+]{4,}={1,2}(?:\/|$)/;

const TRAILING_JUNK_RE = /[.,;:!?)}>'"]+$/;

function trimCandidate(raw: string): string {
  let s = raw.replace(TRAILING_JUNK_RE, '');
  // Drop a trailing ']' that does not close an IPv6 host bracket.
  while (s.endsWith(']') && (s.match(/\[/g)?.length ?? 0) < (s.match(/]/g)?.length ?? 0)) {
    s = s.slice(0, -1).replace(TRAILING_JUNK_RE, '');
  }
  return s;
}

function tryParseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** True for 127.x.x.x, localhost, ::1 (with or without brackets). */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Normalize any VM service / DDS URL (http, https, ws, wss; with or without the trailing `/ws`;
 * DevTools paths stripped) to its WebSocket endpoint. Throws for unsupported input.
 */
export function normalizeVmServiceUrl(input: string): string {
  const url = tryParseUrl(input.trim());
  if (!url) throw new Error(`Not a valid VM service URL: ${input}`);
  let scheme: string;
  switch (url.protocol) {
    case 'http:':
    case 'ws:':
      scheme = 'ws:';
      break;
    case 'https:':
    case 'wss:':
      scheme = 'wss:';
      break;
    default:
      throw new Error(`Unsupported VM service URL scheme "${url.protocol}" in ${input}`);
  }
  if (!url.host) throw new Error(`VM service URL has no host: ${input}`);
  let path = url.pathname;
  const devtools = path.indexOf('/devtools');
  if (devtools >= 0) path = path.slice(0, devtools);
  path = path.replace(/\/+$/, '');
  if (!path.endsWith('/ws')) path += '/ws';
  return `${scheme}//${url.host}${path}`;
}

/** `ws://h:p/tok=/ws` → `http://h:p/tok=/` (the service root, safe to GET for probing). */
export function toHttpBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  const scheme = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
  const path = url.pathname.replace(/\/ws\/?$/, '').replace(/\/+$/, '') + '/';
  return `${scheme}//${url.host}${path}`;
}

/** Same URL with another host/port (used after forwarding a device port). */
export function withHostPort(wsUrl: string, host: string, port: number): string {
  const url = new URL(wsUrl);
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${url.protocol}//${h}:${port}${url.pathname}`;
}

export interface ParsedServiceUrl {
  host: string;
  port: number;
  wsUrl: string;
}

export function parseServiceUrl(wsUrl: string): ParsedServiceUrl {
  const url = new URL(wsUrl);
  const port = url.port ? Number(url.port) : url.protocol === 'wss:' ? 443 : 80;
  return { host: url.hostname, port, wsUrl };
}

/**
 * Turn the Location of a VM service redirect into the DDS WebSocket URL. A redirect of the service
 * root points at DDS's DevTools (`…/devtools/?uri=ws://…/ws`); a redirect of `/ws` points at DDS's root.
 */
export function wsUrlFromRedirect(location: string, base: string): string {
  const resolved = new URL(location, base);
  const inner = devtoolsInner(resolved);
  return normalizeVmServiceUrl(inner ?? resolved.toString());
}

interface Candidate {
  url: string;
  rank: number;
  index: number;
}

function devtoolsInner(url: URL): string | undefined {
  // Old DevTools links keep the query inside the hash: http://127.0.0.1:9100/#/?uri=ws%3A%2F%2F…
  const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '';
  const uri = url.searchParams.get('uri') ?? new URLSearchParams(hashQuery).get('uri');
  if (!uri) return undefined;
  const inner = tryParseUrl(uri);
  if (!inner || !/^(?:https?|wss?):$/.test(inner.protocol)) return undefined;
  return inner.toString();
}

/**
 * Find the VM service URL in arbitrary user input: a bare URL, a DevTools URL (`?uri=`), or a whole
 * pasted block of `flutter run` / `dart run --observe` output. Returns the normalized ws URL.
 */
export function extractVmServiceUrl(input: string): string | undefined {
  const text = input ?? '';
  if (!text.trim()) return undefined;
  const candidates: Candidate[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const vmLine = VM_LINE_RE.test(line);
    const found: { raw: string; index: number }[] = [];
    for (const m of line.matchAll(SCHEME_URL_RE)) found.push({ raw: m[0], index: m.index ?? 0 });
    if (found.length === 0) {
      for (const m of line.matchAll(BARE_HOST_PORT_RE)) found.push({ raw: `http://${m[1]}`, index: m.index ?? 0 });
    }
    for (const f of found) {
      const raw = trimCandidate(f.raw);
      const url = tryParseUrl(raw);
      if (!url || !url.host) continue;
      const inner = devtoolsInner(url);
      const target = inner ?? raw;
      const targetUrl = tryParseUrl(target);
      if (!targetUrl) continue;
      const looksLikeService =
        targetUrl.pathname.endsWith('/ws') || TOKEN_PATH_RE.test(targetUrl.pathname) || /^wss?:$/.test(targetUrl.protocol);
      // A bare DevTools page without ?uri= cannot be attached to.
      if (!inner && /\/devtools(?:\/|$)/.test(targetUrl.pathname) && !TOKEN_PATH_RE.test(targetUrl.pathname)) continue;
      let rank: number;
      if (vmLine && !inner) rank = 0;
      else if (inner) rank = 1;
      else if (looksLikeService) rank = 2;
      else if (targetUrl.port && isLoopbackHost(targetUrl.hostname)) rank = 3;
      else rank = 4;
      candidates.push({ url: target, rank, index: offset + f.index });
    }
    offset += line.length + 1;
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const best = candidates[0]!;
  // Arbitrary web links (docs, Gradle warnings) are never VM services unless they are the only input.
  if (best.rank === 4 && candidates.length > 1) return undefined;
  try {
    return normalizeVmServiceUrl(best.url);
  } catch {
    return undefined;
  }
}

/** URL from a device log line announcing the VM service (or undefined). Not normalized. */
export function parseVmServiceAnnouncement(message: string): string | undefined {
  if (!message || (message.indexOf('listening on') < 0)) return undefined;
  const m = ANNOUNCEMENT_RE.exec(message);
  if (!m) return undefined;
  let url = trimCandidate(m[1]!);
  if (url.startsWith('//')) url = `http:${url}`;
  return tryParseUrl(url) ? url : undefined;
}

/** Strip the auth token from a URL for display in notices (keeps host and port). */
export function redactServiceUrl(url: string): string {
  const parsed = tryParseUrl(url);
  if (!parsed) return url;
  return `${parsed.protocol}//${parsed.host}/…`;
}
