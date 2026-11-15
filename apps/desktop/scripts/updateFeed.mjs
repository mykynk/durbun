#!/usr/bin/env node
/**
 * Update feeds for the Mac app's in-app updates (src/updates.ts): one Squirrel.Mac JSON feed per
 * architecture, attached to the GitHub release next to the DMG and ZIP files. The app reads
 *   https://github.com/mykynk/durbun/releases/latest/download/durbun-update-mac-<arch>.json
 * so the newest published release is always the one offered.
 *
 * `npm run app:release` writes them after the build (scripts/dist.mjs); on its own:
 *   node apps/desktop/scripts/updateFeed.mjs [apps/desktop/release]
 *
 * The ZIP's SHA-256 and size go into the feed: Squirrel.Mac discards a download that does not match them.
 * The ZIPs are final when electron-builder writes them (the app inside is already notarized and stapled;
 * only the DMGs are signed and stapled afterwards), so the feeds can be written right away.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changelogSection } from '../../../scripts/release-notes.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');

export const RELEASES_URL = 'https://github.com/mykynk/durbun/releases';
export const ARCHS = ['arm64', 'x64'];
export const feedFileName = (arch) => `durbun-update-mac-${arch}.json`;
/** electron-builder.config.cjs `mac.artifactName` for the zip target. */
export const zipFileName = (version, arch) => `Durbun-${version}-${arch}-mac.zip`;

/** Files of an earlier release build that must not end up next to the new ones (or in SHA256SUMS.txt). */
export function isStaleReleaseFile(name) {
  return /\.(dmg|zip|blockmap)$/.test(name) || /^durbun-update-mac-.+\.json$/.test(name) || name === 'SHA256SUMS.txt' || name === 'latest-mac.yml' || name === 'notes.md';
}

/** The feed (Squirrel.Mac `serverType: 'json'`): `currentRelease` and its entry in `releases`. */
export function buildFeed({ version, arch, sha256, size, notes, pubDate }) {
  const url = `${RELEASES_URL}/download/v${version}/${encodeURIComponent(zipFileName(version, arch))}`;
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: { version, name: `Dürbün ${version}`, notes, pub_date: pubDate, url, sha256, size },
      },
    ],
  };
}

export function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Writes one feed per architecture into `outDir` from the ZIPs there; returns the files written. Throws
 * when a ZIP is missing or the changelog has no section for the version.
 */
export function writeFeeds(outDir, { version, changelog, pubDate = new Date().toISOString(), archs = ARCHS }) {
  const notes = changelogSection(changelog, version);
  if (!notes) throw new Error(`CHANGELOG.md has no "## [${version}]" section with text`);
  const written = [];
  for (const arch of archs) {
    const zip = path.join(outDir, zipFileName(version, arch));
    let size;
    try {
      size = statSync(zip).size;
    } catch {
      throw new Error(`${zipFileName(version, arch)} is missing in ${outDir}`);
    }
    const feed = buildFeed({ version, arch, sha256: sha256Of(zip), size, notes, pubDate });
    const file = path.join(outDir, feedFileName(arch));
    writeFileSync(file, JSON.stringify(feed, null, 2) + '\n');
    written.push(file);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = path.resolve(process.argv[2] ?? path.join(appDir, 'release'));
  const version = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  try {
    for (const f of writeFeeds(outDir, { version, changelog: readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8') })) console.log(`✓ ${path.relative(repoRoot, f)}`);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
}
