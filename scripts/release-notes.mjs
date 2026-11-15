#!/usr/bin/env node
/**
 * A version's section of CHANGELOG.md, the text the GitHub release and the in-app update dialog show:
 *
 *   node scripts/release-notes.mjs 0.3.0 > notes.md
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <X.Y.Z>');
    process.exit(2);
  }
  const notes = changelogSection(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes) {
    console.error(`✖ CHANGELOG.md has no "## [${version.replace(/^v/, '')}]" section with text.`);
    process.exit(1);
  }
  process.stdout.write(notes + '\n');
}
