/**
 * Help → Check for Updates… (no Electron import, so it is unit-tested). Runs only when the user asks:
 * Dürbün never contacts anything outside the Mac on its own. One GET to the GitHub releases API of
 * the project; the download itself opens in the browser.
 */

export const REPO_URL = 'https://github.com/mykynk/durbun';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/mykynk/durbun/releases/latest';

export type UpdateCheck =
  | { kind: 'newer'; version: string; url: string }
  | { kind: 'current'; version: string }
  | { kind: 'none' }
  | { kind: 'failed'; error: string };

/** "v1.2.3", "1.2.3-beta.1" → [1, 2, 3] plus the pre-release tag; undefined for anything else. */
export function parseVersion(raw: string): { parts: number[]; pre: string } | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return undefined;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

/** Semver order (pre-releases before their release, compared as text); NaN when either is not a version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i]! - y.parts[i]!;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Compares the running version with the latest GitHub release. `get` returns the HTTP status and the
 * parsed JSON body (or throws). A 404 means no release was published yet.
 */
export async function checkForUpdates(current: string, get: (url: string) => Promise<{ status: number; body: unknown }>): Promise<UpdateCheck> {
  let res: { status: number; body: unknown };
  try {
    res = await get(LATEST_RELEASE_API);
  } catch (err) {
    return { kind: 'failed', error: (err as Error)?.message ?? String(err) };
  }
  if (res.status === 404) return { kind: 'none' };
  if (res.status < 200 || res.status >= 300) return { kind: 'failed', error: `HTTP ${res.status}` };
  const body = res.body as { tag_name?: unknown; html_url?: unknown; draft?: unknown } | null;
  const tag = typeof body?.tag_name === 'string' ? body.tag_name : '';
  if (!parseVersion(tag)) return { kind: 'failed', error: `unexpected release tag "${tag.slice(0, 40)}"` };
  const url = typeof body?.html_url === 'string' && body.html_url.startsWith(`${REPO_URL}/`) ? body.html_url : `${REPO_URL}/releases/latest`;
  const latest = tag.replace(/^v/, '');
  return compareVersions(latest, current) > 0 ? { kind: 'newer', version: latest, url } : { kind: 'current', version: current };
}

/**
 * At most `max` lines per `windowMs` (renderer console errors forwarded to main.log): a UI that logs an
 * error per frame must not fill the disk. Returns how many were dropped since the last allowed line.
 */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now): () => { allowed: boolean; dropped: number } {
  let windowStart = -Infinity;
  let count = 0;
  let dropped = 0;
  return () => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    if (count < max) {
      count++;
      const d = dropped;
      dropped = 0;
      return { allowed: true, dropped: d };
    }
    dropped++;
    return { allowed: false, dropped };
  };
}
