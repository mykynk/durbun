/**
 * What the window may load. Only the local Dürbün server origin is ever loaded inside the app;
 * ordinary web links open in the default browser; everything else is refused.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Same server: http(s)/ws(s) on a loopback host with the app's port (localhost ≡ 127.0.0.1 ≡ ::1). */
export function isAppUrl(url: string, appOrigin: string): boolean {
  const u = parse(url);
  const app = parse(appOrigin);
  if (!u || !app) return false;
  if (!LOOPBACK_HOSTS.has(u.hostname) || !LOOPBACK_HOSTS.has(app.hostname)) return false;
  const port = (x: URL) => x.port || (x.protocol === 'https:' || x.protocol === 'wss:' ? '443' : '80');
  const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  return scheme === app.protocol && port(u) === port(app);
}

/** Links we hand to the default browser / mail app. */
export function isExternalUrl(url: string): boolean {
  const u = parse(url);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:');
}

export type NavigationDecision = 'allow' | 'external' | 'deny';

export function decideNavigation(url: string, appOrigin: string | null): NavigationDecision {
  if (appOrigin && isAppUrl(url, appOrigin)) return 'allow';
  if (isExternalUrl(url)) return 'external';
  return 'deny';
}

/**
 * URL filter for session.webRequest.onBeforeRequest. The `*` scheme only matches http and https, so
 * WebSockets need their own patterns: without them a page could open wss://anywhere unchecked
 * (verified with Electron 45).
 */
export const REQUEST_FILTER_URLS: readonly string[] = ['*://*/*', 'ws://*/*', 'wss://*/*'];

/**
 * Sub-resource / fetch / WebSocket requests: the app origin, and the schemes Chromium uses internally.
 * Anything on the network is blocked, so data shown in the UI can never be sent elsewhere.
 */
export function isAllowedRequest(url: string, appOrigin: string | null): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'devtools:' || u.protocol === 'chrome-extension:') return true;
  return !!appOrigin && isAppUrl(url, appOrigin);
}

/**
 * Permissions the UI uses: crash notifications, copy buttons (write only: the UI never reads the
 * clipboard, and a granted read would let any script on the page read it silently), full screen for
 * screen recordings (<video controls>).
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

export function isAllowedPermission(permission: string, requestingUrl: string, appOrigin: string | null): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && !!appOrigin && isAppUrl(requestingUrl, appOrigin);
}
