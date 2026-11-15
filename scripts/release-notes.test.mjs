// node --test scripts/release-notes.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogDate, changelogSection, releaseBody, unwrapMarkdown } from './release-notes.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-12-01

### Added

- **Flows.** A new tab for tests you draw as a graph: requests,
  checks and waits.
  - A nested item that wraps
    onto a second line.
- Second item.

Plain paragraph that
wraps twice and
ends here.

\`\`\`bash
npm run demo
  --port 9750
\`\`\`

| A | B |
| --- | --- |
| 1 | 2 |

## [1.1.0] - 2026-11-01

- Older.

[1.2.0]: https://github.com/mykynk/durbun/compare/v1.1.0...v1.2.0
`;

test('changelogSection keeps the lines as written', () => {
  const section = changelogSection(CHANGELOG, 'v1.2.0');
  assert.ok(section.startsWith('### Added'));
  assert.ok(section.includes('requests,\n  checks and waits.'));
  assert.ok(!section.includes('Older.'));
  assert.equal(changelogSection(CHANGELOG, '9.9.9'), '');
  assert.equal(changelogDate(CHANGELOG, '1.2.0'), '2026-12-01');
});

test('unwrapMarkdown joins wrapped list items and paragraphs', () => {
  const out = unwrapMarkdown(changelogSection(CHANGELOG, '1.2.0'));
  assert.ok(out.includes('- **Flows.** A new tab for tests you draw as a graph: requests, checks and waits.\n'));
  assert.ok(out.includes('\n  - A nested item that wraps onto a second line.\n- Second item.'));
  assert.ok(out.includes('\n\nPlain paragraph that wraps twice and ends here.\n\n'));
});

test('unwrapMarkdown keeps code blocks, tables, headings and blank lines', () => {
  const out = unwrapMarkdown(changelogSection(CHANGELOG, '1.2.0'));
  assert.ok(out.includes('```bash\nnpm run demo\n  --port 9750\n```'));
  assert.ok(out.includes('| A | B |\n| --- | --- |\n| 1 | 2 |'));
  assert.ok(out.startsWith('### Added\n\n- '));
});

test('unwrapMarkdown keeps hard line breaks and indented code', () => {
  assert.equal(unwrapMarkdown('one  \ntwo\nthree'), 'one  \ntwo three');
  assert.equal(unwrapMarkdown('one\\\ntwo'), 'one\\\ntwo');
  assert.equal(unwrapMarkdown('text\n\n    code line\n    more'), 'text\n\n    code line\n    more');
  assert.equal(unwrapMarkdown('- item\n\n  next paragraph\n  of the item'), '- item\n\n  next paragraph of the item');
  assert.equal(unwrapMarkdown('a line\n<b>bold</b> start'), 'a line <b>bold</b> start');
  assert.equal(unwrapMarkdown('1. first\n   wrapped\n2. second'), '1. first wrapped\n2. second');
});

test('releaseBody: downloads, SDK versions, then the changes and the checksums', () => {
  const body = releaseBody(CHANGELOG, '1.2.0');
  const order = ['## Downloads', '## SDK versions', "## What's new", '### Added', '**Checksums:**'].map((s) => body.indexOf(s));
  assert.ok(order.every((i) => i >= 0), body);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(body.includes('[`Durbun-1.2.0-arm64.dmg`](https://github.com/mykynk/durbun/releases/download/v1.2.0/Durbun-1.2.0-arm64.dmg)'));
  assert.ok(body.includes('`Durbun-1.2.0-x64.dmg`'));
  assert.ok(body.includes('`Durbun-1.2.0-arm64-mac.zip`'));
  assert.ok(body.includes('`durbun: ^1.2.0`'));
  assert.ok(body.includes('`io.github.mykynk:durbun:1.2.0`'));
  assert.ok(body.includes('`@durbun/react-native@1.2.0`'));
  assert.equal(releaseBody(CHANGELOG, '9.9.9'), '');
});

test('the artifact names match the Mac app build config', () => {
  const config = readFileSync(path.join(repo, 'apps/desktop/electron-builder.config.cjs'), 'utf8');
  assert.match(config, /artifactName: 'Durbun-\$\{version\}-\$\{arch\}\.\$\{ext\}'/); // dmg
  assert.match(config, /artifactName: 'Durbun-\$\{version\}-\$\{arch\}-mac\.\$\{ext\}'/); // zip
});

test('the real changelog: no wrapped lines left outside code blocks', () => {
  const text = readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  const version = /^## \[(\d+\.\d+\.\d+)\]/m.exec(text)?.[1];
  assert.ok(version, 'CHANGELOG.md has a released section');
  const out = unwrapMarkdown(changelogSection(text, version));
  let inFence = false;
  for (const line of out.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    // A continuation line starts with lowercase text after indentation and no list marker.
    assert.ok(!/^\s+[a-z(]/.test(line), `still wrapped: ${line}`);
  }
});
