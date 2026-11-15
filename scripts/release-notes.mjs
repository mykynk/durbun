#!/usr/bin/env node
/**
 * The GitHub release text: a version's section of CHANGELOG.md plus a fixed footer (which file is for which
 * Mac, the SDK lines to upgrade to, the checksums):
 *
 *   node scripts/release-notes.mjs 0.3.0 > notes.md
 *   node scripts/release-notes.mjs 0.3.0 --section-only   # the section alone (what the update dialog shows)
 *
 * The section starts at `## [X.Y.Z]` and ends at the next `## [` heading; link reference lines
 * (`[0.3.0]: https://…`) are left out. Exits 1 when the section is missing or empty.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The section's body, trimmed; '' when there is none. */
export function changelogSection(text, version) {
  const v = String(version).replace(/^v/, '');
  const out = [];
  let on = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!on) {
      if (line.startsWith(`## [${v}]`)) on = true;
      continue;
    }
    if (line.startsWith('## [')) break;
    if (/^\[[^\]]+\]: /.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** The date of the section heading (`## [X.Y.Z] - YYYY-MM-DD`), or undefined. */
export function changelogDate(text, version) {
  const v = String(version).replace(/^v/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^## \\[${v}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm').exec(text);
  return m?.[1];
}

/** Install and upgrade lines under every release. */
export function releaseFooter(version) {
  const v = String(version).replace(/^v/, '');
  return [
    '---',
    '',
    `**Mac app:** \`Durbun-${v}-arm64.dmg\` for Apple silicon, \`Durbun-${v}-x64.dmg\` for Intel (macOS 13 or later). An installed Dürbün offers the update itself: **Dürbün → Check for Updates…**.`,
    '',
    `**SDKs:** Flutter \`durbun: ^${v}\` (and \`durbun_dio: ^${v}\`) · Android \`io.github.mykynk:durbun:${v}\` (\`durbun-noop\` for release builds) · iOS Swift Package Manager \`from: "${v}"\` or \`pod 'Durbun', '~> ${v}'\` · React Native \`@durbun/react-native@${v}\``,
    '',
    '**Checksums:** `SHA256SUMS.txt` (`shasum -a 256 -c SHA256SUMS.txt` in the download folder).',
  ].join('\n');
}

/** The release body: the section and the footer; '' when the section is missing. */
export function releaseBody(text, version) {
  const section = changelogSection(text, version);
  return section ? `${section}\n\n${releaseFooter(version)}` : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <X.Y.Z>');
    process.exit(2);
  }
  const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const notes = process.argv.includes('--section-only') ? changelogSection(text, version) : releaseBody(text, version);
  if (!notes) {
    console.error(`✖ CHANGELOG.md has no "## [${version.replace(/^v/, '')}]" section with text.`);
    process.exit(1);
  }
  process.stdout.write(notes + '\n');
}
