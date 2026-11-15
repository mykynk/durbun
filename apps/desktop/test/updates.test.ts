import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autoCheckDue,
  bundlePath,
  checkForUpdates,
  compareVersions,
  createRateLimiter,
  dmgFileName,
  downloadUrl,
  feedUrl,
  formatSize,
  notesExcerpt,
  parseCodesign,
  parseFeed,
  parseVersion,
  selfUpdateSupport,
  shouldOfferMove,
  shouldAskAutoCheck,
  updateArch,
  zipFileName,
} from '../src/updates';
// @ts-expect-error plain .mjs script without types
import { buildFeed, feedFileName as scriptFeedName, isStaleReleaseFile, writeFeeds, zipFileName as scriptZipName } from '../scripts/updateFeed.mjs';

const feed = (version: string, arch: 'arm64' | 'x64' = 'arm64', extra: Record<string, unknown> = {}) =>
  buildFeed({ version, arch, sha256: 'a'.repeat(64), size: 88_000_000, notes: '### Added\n- **Open files** from [Finder](https://x)\n', pubDate: '2026-11-20T10:00:00.000Z', ...extra });

describe('versions', () => {
  it('parses tags with or without v, pre-release and build parts', () => {
    expect(parseVersion('v1.2.3')).toEqual({ parts: [1, 2, 3], pre: '' });
    expect(parseVersion('0.2.0-beta.1+abc')).toEqual({ parts: [0, 2, 0], pre: 'beta.1' });
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion('latest')).toBeUndefined();
  });
  it('orders like semver', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('x', '1.0.0')).toBeNaN();
  });
});

describe('feed location and file names', () => {
  it('one static file per architecture under releases/latest; Rosetta gets the Apple silicon build', () => {
    expect(feedUrl('arm64')).toBe('https://github.com/mykynk/durbun/releases/latest/download/durbun-update-mac-arm64.json');
    expect(updateArch('arm64', false)).toBe('arm64');
    expect(updateArch('x64', false)).toBe('x64');
    expect(updateArch('x64', true)).toBe('arm64');
  });
  it('the app and the release script agree on every file name', () => {
    expect(scriptFeedName('x64')).toBe(feedUrl('x64').split('/').pop());
    expect(scriptZipName('0.3.0', 'x64')).toBe(zipFileName('0.3.0', 'x64'));
    expect(downloadUrl('0.3.0', dmgFileName('0.3.0', 'arm64'))).toBe('https://github.com/mykynk/durbun/releases/download/v0.3.0/Durbun-0.3.0-arm64.dmg');
  });
});

describe('parseFeed', () => {
  it('reads what the release script writes (the Squirrel.Mac JSON format)', () => {
    const r = parseFeed(feed('0.3.0', 'x64'));
    expect(r).toEqual({
      version: '0.3.0',
      notes: '### Added\n- **Open files** from [Finder](https://x)\n',
      pubDate: '2026-11-20T10:00:00.000Z',
      zipUrl: 'https://github.com/mykynk/durbun/releases/download/v0.3.0/Durbun-0.3.0-x64-mac.zip',
      size: 88_000_000,
      sha256: 'a'.repeat(64),
    });
  });
  it('refuses broken feeds and downloads outside the project', () => {
    expect(parseFeed(null)).toHaveProperty('error');
    expect(parseFeed({ currentRelease: 'next', releases: [] })).toHaveProperty('error');
    expect(parseFeed({ currentRelease: '0.3.0', releases: [] })).toHaveProperty('error');
    const evil = feed('0.3.0');
    evil.releases[0].updateTo.url = 'https://evil.example/Durbun.zip';
    expect(parseFeed(evil)).toEqual({ error: 'the update file points outside the project releases' });
  });
  it('drops a malformed checksum or size instead of passing it to Squirrel', () => {
    const r = parseFeed(feed('0.3.0', 'arm64', { sha256: 'xyz', size: -1 }));
    expect(r).not.toHaveProperty('sha256');
    expect(r).not.toHaveProperty('size');
  });
});

describe('checkForUpdates', () => {
  const reply = (status: number, body: unknown) => async (url: string) => {
    expect(url).toBe(feedUrl('arm64'));
    return { status, body };
  };
  it('reports a newer release with its notes', async () => {
    const r = await checkForUpdates('0.2.0', 'arm64', reply(200, feed('0.3.0')));
    expect(r).toMatchObject({ kind: 'newer', release: { version: '0.3.0', size: 88_000_000 } });
  });
  it('is current for the same or an older release', async () => {
    expect(await checkForUpdates('0.3.0', 'arm64', reply(200, feed('0.3.0')))).toEqual({ kind: 'current', version: '0.3.0' });
    expect(await checkForUpdates('0.4.0', 'arm64', reply(200, feed('0.3.0')))).toEqual({ kind: 'current', version: '0.4.0' });
  });
  it('a release without a feed, errors and odd replies fail softly', async () => {
    expect(await checkForUpdates('0.2.0', 'arm64', reply(404, null))).toEqual({ kind: 'noFeed' });
    expect(await checkForUpdates('0.2.0', 'arm64', reply(503, null))).toEqual({ kind: 'failed', error: 'HTTP 503' });
    expect((await checkForUpdates('0.2.0', 'arm64', reply(200, { currentRelease: 'nightly' }))).kind).toBe('failed');
    expect(
      await checkForUpdates('0.2.0', 'arm64', async () => {
        throw new Error('offline');
      }),
    ).toEqual({ kind: 'failed', error: 'offline' });
  });
});

describe('notes and sizes for the dialog', () => {
  it('turns Markdown into plain lines and cuts long notes', () => {
    expect(notesExcerpt('### Added\n\n- **Open files** from [Finder](https://x) with `⌘O`\n\n\n- Two')).toBe('Added\n\n• Open files from Finder with ⌘O\n\n• Two');
    const long = Array.from({ length: 30 }, (_, i) => `- item ${i}`).join('\n');
    const cut = notesExcerpt(long, 5);
    expect(cut.split('\n')).toHaveLength(6);
    expect(cut.endsWith('…')).toBe(true);
    expect(notesExcerpt('x '.repeat(2000), 12, 100).length).toBeLessThanOrEqual(103);
  });
  it('formats sizes in MB', () => {
    expect(formatSize(88_000_000)).toBe('84 MB');
    expect(formatSize(undefined)).toBeUndefined();
  });
});

describe('can this copy replace itself?', () => {
  const devId = 'Executable=/Applications/Dürbün.app/Contents/MacOS/Dürbün\nAuthority=Developer ID Application: Someone (ABCDE12345)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345\n';
  it('reads the codesign output', () => {
    expect(parseCodesign(devId)).toBe('developerId');
    expect(parseCodesign('Executable=/x\nSignature=adhoc\nTeamIdentifier=not set\n')).toBe('adhoc');
    expect(parseCodesign('/x: code object is not signed at all')).toBe('unsigned');
    expect(parseCodesign('Authority=Apple Development: me\nTeamIdentifier=ABCDE12345')).toBe('other');
  });
  it('finds the bundle around the executable', () => {
    expect(bundlePath('/Applications/Dürbün.app/Contents/MacOS/Dürbün')).toBe('/Applications/Dürbün.app');
    expect(bundlePath('/usr/local/bin/node')).toBeUndefined();
  });
  it('only a Developer ID signed copy in a writable folder updates itself', () => {
    const base = { isPackaged: true, signature: 'developerId' as const, bundle: '/Applications/Dürbün.app', parentWritable: true };
    expect(selfUpdateSupport(base)).toEqual({ ok: true });
    expect(selfUpdateSupport({ ...base, isPackaged: false })).toEqual({ ok: false, reason: 'development' });
    expect(selfUpdateSupport({ ...base, signature: 'adhoc' })).toEqual({ ok: false, reason: 'unsigned' });
    expect(selfUpdateSupport({ ...base, bundle: '/Volumes/Dürbün 0.3.0/Dürbün.app' })).toEqual({ ok: false, reason: 'location' });
    expect(selfUpdateSupport({ ...base, bundle: '/private/var/folders/x/T/AppTranslocation/ABC/d/Dürbün.app' })).toEqual({ ok: false, reason: 'location' });
    expect(selfUpdateSupport({ ...base, parentWritable: false })).toEqual({ ok: false, reason: 'location' });
  });
});

describe('move to Applications', () => {
  const base = { isPackaged: true, inApplications: false, declined: false, openedAtLogin: false, selfTest: false, signature: 'developerId' as const };
  const dmg = '/Volumes/Dürbün 0.3.0/Dürbün.app';
  const translocated = '/private/var/folders/x/T/AppTranslocation/ABC/d/Dürbün.app';
  const folder = '/Users/someone/code/durbun/apps/desktop/release/mac-arm64/Dürbün.app';
  it('always offers from a disk image or App Translocation, whatever the signature', () => {
    for (const signature of ['developerId', 'adhoc', 'unsigned', 'other'] as const) {
      expect(shouldOfferMove({ ...base, signature, bundle: dmg })).toEqual({ offer: true, location: 'diskImage' });
      expect(shouldOfferMove({ ...base, signature, bundle: translocated })).toEqual({ offer: true, location: 'translocated' });
    }
  });
  it('from an ordinary folder only a Developer ID copy is asked; a local ad-hoc build never', () => {
    expect(shouldOfferMove({ ...base, bundle: folder })).toEqual({ offer: true, location: 'folder' });
    for (const signature of ['adhoc', 'unsigned', 'other'] as const) expect(shouldOfferMove({ ...base, signature, bundle: folder })).toEqual({ offer: false });
  });
  it('never in Applications, in development, at login, in a self-test or after "Don\'t ask again"', () => {
    for (const patch of [{ inApplications: true }, { isPackaged: false }, { openedAtLogin: true }, { selfTest: true }, { declined: true }, { bundle: undefined }]) {
      expect(shouldOfferMove({ ...base, bundle: dmg, ...patch }), JSON.stringify(patch)).toEqual({ offer: false });
    }
  });
});

describe('automatic checks', () => {
  it('asks once, never on the first launch and never in development', () => {
    expect(shouldAskAutoCheck({ launches: 1 }, true)).toBe(false);
    expect(shouldAskAutoCheck({ launches: 2 }, true)).toBe(true);
    expect(shouldAskAutoCheck({ launches: 2 }, false)).toBe(false);
    expect(shouldAskAutoCheck({ launches: 9, autoUpdateCheck: false }, true)).toBe(false);
  });
  it('runs once a day after a yes', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(autoCheckDue({}, 10 * day)).toBe(false);
    expect(autoCheckDue({ autoUpdateCheck: false }, 10 * day)).toBe(false);
    expect(autoCheckDue({ autoUpdateCheck: true }, 10 * day)).toBe(true);
    expect(autoCheckDue({ autoUpdateCheck: true, lastUpdateCheck: 10 * day - 1000 }, 10 * day)).toBe(false);
    expect(autoCheckDue({ autoUpdateCheck: true, lastUpdateCheck: 9 * day }, 10 * day)).toBe(true);
    // A clock that went back does not stop the checks for good.
    expect(autoCheckDue({ autoUpdateCheck: true, lastUpdateCheck: 20 * day }, 10 * day)).toBe(true);
  });
});

describe('release feeds (scripts/updateFeed.mjs)', () => {
  it('writes one feed per architecture with the ZIP checksum, size and the changelog section', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-feed-'));
    writeFileSync(path.join(dir, 'Durbun-0.3.0-arm64-mac.zip'), 'arm');
    writeFileSync(path.join(dir, 'Durbun-0.3.0-x64-mac.zip'), 'intel!');
    const changelog = '# Changelog\n\n## [0.3.0] - 2026-11-20\n\n### Added\n- Updates\n\n## [0.2.0] - 2026-11-12\n- old\n';
    const files = writeFeeds(dir, { version: '0.3.0', changelog, pubDate: '2026-11-20T00:00:00.000Z' }) as string[];
    expect(files.map((f) => path.basename(f))).toEqual(['durbun-update-mac-arm64.json', 'durbun-update-mac-x64.json']);
    const x64 = parseFeed(JSON.parse(readFileSync(files[1]!, 'utf8')));
    expect(x64).toMatchObject({ version: '0.3.0', notes: '### Added\n- Updates', size: 6, zipUrl: expect.stringContaining('Durbun-0.3.0-x64-mac.zip') });
    expect((x64 as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('stops when a ZIP or the changelog section is missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-feed-'));
    expect(() => writeFeeds(dir, { version: '0.3.0', changelog: '## [0.3.0] - x\n- a\n' })).toThrow(/Durbun-0.3.0-arm64-mac.zip is missing/);
    expect(() => writeFeeds(dir, { version: '0.3.0', changelog: '## [0.2.0]\n- a\n' })).toThrow(/no "## \[0.3.0\]" section/);
  });
  it('a release build clears the old artifacts, never the app folders', () => {
    for (const f of ['Durbun-0.2.0-arm64.dmg', 'Durbun-0.2.0-x64-mac.zip', 'Durbun-0.2.0-x64-mac.zip.blockmap', 'durbun-update-mac-arm64.json', 'SHA256SUMS.txt']) expect(isStaleReleaseFile(f), f).toBe(true);
    for (const f of ['mac-arm64', 'mac', 'builder-debug.yml']) expect(isStaleReleaseFile(f), f).toBe(false);
  });
});

describe('createRateLimiter', () => {
  it('allows max per window and reports what it dropped', () => {
    let now = 0;
    const next = createRateLimiter(2, 1_000, () => now);
    expect(next()).toEqual({ allowed: true, dropped: 0 });
    expect(next()).toEqual({ allowed: true, dropped: 0 });
    expect(next().allowed).toBe(false);
    expect(next().allowed).toBe(false);
    now = 1_000;
    expect(next()).toEqual({ allowed: true, dropped: 2 });
  });
});
