/**
 * Updates, the pure part (no Electron import, so it is unit-tested). updateFlow.ts runs the dialogs;
 * main.ts wires Electron's autoUpdater (Squirrel.Mac) to it.
 *
 * Looking for a new version is one GET of a static file attached to the latest GitHub release, one file per
 * architecture (apps/desktop/scripts/updateFeed.mjs writes them):
 *   https://github.com/mykynk/durbun/releases/latest/download/durbun-update-mac-<arch>.json
 * The request carries no identifier. It happens when the user picks Check for Updates…, and on its own only
 * after the user said yes once (desktopPrefs.autoUpdateCheck). The file is Squirrel.Mac's JSON feed
 * (serverType 'json'), so the same file later drives the download, which only starts after a yes.
 */

export const REPO_URL = 'https://github.com/mykynk/durbun';
export const RELEASES_URL = `${REPO_URL}/releases`;

export type UpdateArch = 'arm64' | 'x64';

/**
 * Which build this Mac should get: an Intel build running under Rosetta on Apple silicon moves to the
 * Apple silicon build.
 */
export function updateArch(processArch: string, runningUnderARM64Translation: boolean): UpdateArch {
  return processArch === 'arm64' || runningUnderARM64Translation ? 'arm64' : 'x64';
}

export const feedFileName = (arch: UpdateArch) => `durbun-update-mac-${arch}.json`;
export const feedUrl = (arch: UpdateArch) => `${RELEASES_URL}/latest/download/${feedFileName(arch)}`;
/** electron-builder.config.cjs artifact names. */
export const zipFileName = (version: string, arch: UpdateArch) => `Durbun-${version}-${arch}-mac.zip`;
export const dmgFileName = (version: string, arch: UpdateArch) => `Durbun-${version}-${arch}.dmg`;
export const downloadUrl = (version: string, file: string) => `${RELEASES_URL}/download/v${version}/${encodeURIComponent(file)}`;
export const releasePageUrl = (version: string) => `${RELEASES_URL}/tag/v${version}`;

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

/** One release in the feed, as the app uses it. */
export interface FeedRelease {
  version: string;
  /** Markdown, the release's CHANGELOG.md section. */
  notes: string;
  pubDate?: string;
  /** The .zip Squirrel.Mac installs (only ever a file of this project's releases). */
  zipUrl: string;
  size?: number;
  sha256?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The release a feed points at: `currentRelease` and its entry in `releases` (Squirrel.Mac reads the same
 * two). An error text for anything else, including a download outside this project's releases.
 */
export function parseFeed(body: unknown): FeedRelease | { error: string } {
  if (!isObject(body)) return { error: 'the update file is not a JSON object' };
  const current = typeof body.currentRelease === 'string' ? body.currentRelease : '';
  if (!parseVersion(current)) return { error: `unexpected version "${current.slice(0, 40)}" in the update file` };
  const releases = Array.isArray(body.releases) ? body.releases : [];
  const entry = releases.find((r) => isObject(r) && r.version === current) as Record<string, unknown> | undefined;
  const to = entry && isObject(entry.updateTo) ? entry.updateTo : undefined;
  if (!to) return { error: `the update file has no entry for ${current}` };
  const url = typeof to.url === 'string' ? to.url : '';
  if (!url.startsWith(`${RELEASES_URL}/download/`) || !url.endsWith('.zip')) return { error: 'the update file points outside the project releases' };
  const out: FeedRelease = { version: current.replace(/^v/, ''), notes: typeof to.notes === 'string' ? to.notes : '', zipUrl: url };
  if (typeof to.pub_date === 'string') out.pubDate = to.pub_date;
  if (typeof to.size === 'number' && Number.isFinite(to.size) && to.size > 0) out.size = to.size;
  if (typeof to.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(to.sha256)) out.sha256 = to.sha256.toLowerCase();
  return out;
}

export type UpdateCheck =
  | { kind: 'newer'; release: FeedRelease }
  | { kind: 'current'; version: string }
  /** The latest release has no update file for this Mac (a release made before in-app updates). */
  | { kind: 'noFeed' }
  | { kind: 'failed'; error: string };

/**
 * Reads the feed for `arch` and compares it with the running version. `get` returns the HTTP status and the
 * parsed JSON body, or throws.
 */
export async function checkForUpdates(current: string, arch: UpdateArch, get: (url: string) => Promise<{ status: number; body: unknown }>): Promise<UpdateCheck> {
  let res: { status: number; body: unknown };
  try {
    res = await get(feedUrl(arch));
  } catch (err) {
    return { kind: 'failed', error: (err as Error)?.message ?? String(err) };
  }
  if (res.status === 404) return { kind: 'noFeed' };
  if (res.status < 200 || res.status >= 300) return { kind: 'failed', error: `HTTP ${res.status}` };
  const release = parseFeed(res.body);
  if ('error' in release) return { kind: 'failed', error: release.error };
  return compareVersions(release.version, current) > 0 ? { kind: 'newer', release } : { kind: 'current', version: current };
}

/**
 * Release notes for a dialog: Markdown made plain (headings, links, emphasis, bullets), at most `maxLines`
 * lines and `maxChars` characters, "…" when cut.
 */
export function notesExcerpt(markdown: string, maxLines = 12, maxChars = 900): string {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*[-*+]\s+/, '• ')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/`([^`]*)`/g, '$1')
        .trimEnd(),
    )
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let out = lines.slice(0, maxLines).join('\n');
  let cut = lines.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars).replace(/\s+\S*$/, '');
    cut = true;
  }
  return cut ? `${out}\n…` : out;
}

/** "84 MB" */
export function formatSize(bytes: number | undefined): string | undefined {
  if (!bytes || !Number.isFinite(bytes)) return undefined;
  return `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

/* ───────────── can this copy replace itself? ───────────── */

export type SignatureKind = 'developerId' | 'adhoc' | 'unsigned' | 'other';

/** What `codesign -dv --verbose=2 <app>` (stderr) says about the signature. */
export function parseCodesign(output: string): SignatureKind {
  if (/not signed at all/i.test(output)) return 'unsigned';
  if (/^Signature=adhoc\s*$/m.test(output)) return 'adhoc';
  if (/^Authority=Developer ID Application: /m.test(output) && /^TeamIdentifier=(?!not set)\S+/m.test(output)) return 'developerId';
  return 'other';
}

/** The .app bundle around the executable (…/Dürbün.app/Contents/MacOS/Dürbün). */
export function bundlePath(execPath: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m?.[1];
}

export type SelfUpdate = { ok: true } | { ok: false; reason: 'development' | 'unsigned' | 'location' };

/**
 * Squirrel.Mac replaces the app only when it is Developer ID signed and its folder is writable; a copy
 * running from the disk image, from App Translocation (opened straight from Downloads) or from a read-only
 * place cannot replace itself. Those copies get the disk image for this Mac instead.
 */
export function selfUpdateSupport(input: { isPackaged: boolean; signature: SignatureKind; bundle?: string; parentWritable: boolean }): SelfUpdate {
  if (!input.isPackaged || !input.bundle) return { ok: false, reason: 'development' };
  if (input.signature !== 'developerId') return { ok: false, reason: 'unsigned' };
  if (input.bundle.startsWith('/Volumes/') || input.bundle.includes('/AppTranslocation/') || !input.parentWritable) return { ok: false, reason: 'location' };
  return { ok: true };
}

export type AppLocation = 'diskImage' | 'translocated' | 'folder';

/** Where a bundle outside Applications runs from. */
export function appLocation(bundle: string): AppLocation {
  if (bundle.includes('/AppTranslocation/')) return 'translocated';
  if (bundle.startsWith('/Volumes/')) return 'diskImage';
  return 'folder';
}

/**
 * Should the app offer to move itself to Applications? Always from a disk image or App Translocation (that
 * copy stops working when the disk image is ejected), whatever the signature. From an ordinary folder only
 * a Developer ID signed copy (a downloaded release) is asked: an ad-hoc or unsigned copy there is a
 * developer's own build, which is never asked.
 */
export function shouldOfferMove(input: {
  isPackaged: boolean;
  inApplications: boolean;
  declined: boolean;
  openedAtLogin: boolean;
  selfTest: boolean;
  bundle?: string;
  signature: SignatureKind;
}): { offer: false } | { offer: true; location: AppLocation } {
  if (!input.isPackaged || input.inApplications || input.declined || input.openedAtLogin || input.selfTest || !input.bundle) return { offer: false };
  const location = appLocation(input.bundle);
  if (location === 'folder' && input.signature !== 'developerId') return { offer: false };
  return { offer: true, location };
}

/* ───────────── automatic checks ───────────── */

export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Ask about automatic checks once, never on the very first launch (the user is busy setting up), only in a
 * packaged app, and only while no answer was given.
 */
export function shouldAskAutoCheck(prefs: { autoUpdateCheck?: boolean; launches?: number }, isPackaged: boolean): boolean {
  return isPackaged && prefs.autoUpdateCheck === undefined && (prefs.launches ?? 0) >= 2;
}

/** An automatic check is due when the user allowed it and the last one is a day old (or in the future). */
export function autoCheckDue(prefs: { autoUpdateCheck?: boolean; lastUpdateCheck?: number }, now: number): boolean {
  if (prefs.autoUpdateCheck !== true) return false;
  const last = prefs.lastUpdateCheck ?? 0;
  return now - last >= AUTO_CHECK_INTERVAL_MS || last > now;
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
