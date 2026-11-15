#!/usr/bin/env node
/**
 * The GitHub release text: which file to download, the SDK lines to upgrade to, then the version's section of
 * CHANGELOG.md and how to check the checksums:
 *
 *   node scripts/release-notes.mjs 0.3.0 > notes.md
 *   node scripts/release-notes.mjs 0.3.0 --section-only   # the section alone, as written (what the update dialog shows)
 *
 * The section starts at `## [X.Y.Z]` and ends at the next `## [` heading; link reference lines
 * (`[0.3.0]: https://…`) are left out. In the release text the changelog's hard-wrapped lines are joined, because
 * GitHub turns every line break inside a release body into `<br>`. Exits 1 when the section is missing or empty.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RELEASES_URL = 'https://github.com/mykynk/durbun/releases';
const BLOB_URL = 'https://github.com/mykynk/durbun/blob/main';

const plainVersion = (version) => String(version).replace(/^v/, '');

/** The section's body, trimmed; '' when there is none. Lines stay as written (apps/desktop's update feed uses it). */
export function changelogSection(text, version) {
  const v = plainVersion(version);
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
  const v = plainVersion(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^## \\[${v}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm').exec(text);
  return m?.[1];
}

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
/** Lines that are a block of their own and never join with their neighbours. */
const OWN_LINE = /^\s*(#{1,6}(\s|$)|>|(-{3,}|\*{3,}|_{3,})\s*$|\[[^\]]+\]:\s)/;
/** Table rows and HTML: a block of their own when they start one (inside a paragraph they are its text). */
const OWN_BLOCK = /^\s*(\||<[A-Za-z/!])/;

/**
 * Joins the hard-wrapped lines of each paragraph and list item into one line. Code blocks, headings, tables,
 * quotes, blank lines and nested list items stay as they are; a line ending in a hard break (two spaces or `\`)
 * is not joined with the next one.
 */
export function unwrapMarkdown(markdown) {
  const out = [];
  let current; // the paragraph or list item being joined
  let fence; // the opening fence while inside a fenced code block
  let afterList = false; // the last block was a list item (an indented line after a blank one continues it)
  const flush = () => {
    if (current !== undefined) out.push(current);
    current = undefined;
  };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      out.push(line);
      if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      out.push('');
      continue;
    }
    if (OWN_LINE.test(line) || (current === undefined && OWN_BLOCK.test(line))) {
      flush();
      out.push(line);
      afterList = false;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      current = line;
      afterList = true;
      continue;
    }
    if (current === undefined) {
      // A new paragraph. Four spaces or a tab outside a list is an indented code block: keep it.
      if (!afterList && /^( {4}|\t)/.test(line)) {
        out.push(line);
        continue;
      }
      if (!/^\s/.test(line)) afterList = false;
      current = line;
      continue;
    }
    if (/( {2}|\\)$/.test(current)) {
      // A hard line break: keep it.
      out.push(current);
      current = line;
      continue;
    }
    current = `${current.trimEnd()} ${line.trim()}`;
  }
  flush();
  return out.join('\n');
}

/** "Which file is for which Mac", at the top of every release. */
export function downloadsBlock(version) {
  const v = plainVersion(version);
  const link = (file) => `[\`${file}\`](${RELEASES_URL}/download/v${v}/${file})`;
  return [
    '## Downloads',
    '',
    '| Mac | Download |',
    '| --- | --- |',
    `| Apple silicon (M1 and later) | ${link(`Durbun-${v}-arm64.dmg`)} |`,
    `| Intel | ${link(`Durbun-${v}-x64.dmg`)} |`,
    '',
    `macOS 13 or later. Open the disk image and drag Dürbün to Applications. An installed Dürbün offers the update itself (**Dürbün → Check for Updates…**); the \`Durbun-${v}-arm64-mac.zip\` and \`Durbun-${v}-x64-mac.zip\` files and the \`durbun-update-mac-*.json\` feeds are for that in-app updater.`,
  ].join('\n');
}

/** The SDK lines to upgrade to (every channel is published; see the SDK READMEs). */
export function sdkBlock(version) {
  const v = plainVersion(version);
  return [
    '## SDK versions',
    '',
    '| SDK | Version |',
    '| --- | --- |',
    `| Flutter | \`durbun: ^${v}\`, and \`durbun_dio: ^${v}\` for Dio's native adapters |`,
    `| Android | \`io.github.mykynk:durbun:${v}\`, and \`io.github.mykynk:durbun-noop:${v}\` for release builds |`,
    `| iOS | Swift Package Manager: \`https://github.com/mykynk/durbun\`, \`from: "${v}"\`; CocoaPods: \`pod 'Durbun', '~> ${v}'\` |`,
    `| React Native / JavaScript | \`@durbun/react-native@${v}\` |`,
    '',
    `The Mac app and the SDKs do not have to be upgraded together: see [Versions and upgrades](${BLOB_URL}/docs/guides/versions.md).`,
  ].join('\n');
}

/** How to check the downloads. */
export function checksumsBlock() {
  return '**Checksums:** `SHA256SUMS.txt` (`shasum -a 256 -c SHA256SUMS.txt` in the download folder).';
}

/** The release body: downloads, SDK versions, the unwrapped section and the checksums; '' when the section is missing. */
export function releaseBody(text, version) {
  const section = changelogSection(text, version);
  if (!section) return '';
  return [downloadsBlock(version), sdkBlock(version), `## What's new\n\n${unwrapMarkdown(section)}`, `---\n\n${checksumsBlock()}`].join('\n\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <X.Y.Z> [--section-only]');
    process.exit(2);
  }
  const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const notes = process.argv.includes('--section-only') ? changelogSection(text, version) : releaseBody(text, version);
  if (!notes) {
    console.error(`✖ CHANGELOG.md has no "## [${plainVersion(version)}]" section with text.`);
    process.exit(1);
  }
  process.stdout.write(notes + '\n');
}
