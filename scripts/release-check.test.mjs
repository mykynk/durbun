// node --test scripts/release-check.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogProblems, electronPatchProblems, localDate, nextSteps, parseArgs, releaseSteps, runSteps, selectSteps, trackedSecrets } from './release-check.mjs';
import { changelogDate, changelogSection, releaseBody } from './release-notes.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-20

### Added
- In-app updates

[0.3.0]: https://github.com/mykynk/durbun/releases/tag/v0.3.0

## [0.2.0] - 2026-11-12

- older
`;

test('release notes are the version section without link references', () => {
  assert.equal(changelogSection(CHANGELOG, '0.3.0'), '### Added\n- In-app updates');
  assert.equal(changelogSection(CHANGELOG, 'v0.2.0'), '- older');
  assert.equal(changelogSection(CHANGELOG, '0.4.0'), '');
  assert.equal(changelogDate(CHANGELOG, '0.3.0'), '2026-11-20');
  assert.equal(changelogDate(CHANGELOG, '0.4.0'), undefined);
});

test('the release notes match the awk the release workflow used', () => {
  // Same rules: from "## [X.Y.Z]" to the next "## [", link references dropped.
  const real = readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  const newest = /^## \[(?!Unreleased\])([^\]]+)\]/m.exec(real)?.[1];
  assert.ok(newest);
  assert.ok(changelogSection(real, newest).length > 0);
});

test('the changelog check wants the section, a date and today', () => {
  assert.deepEqual(changelogProblems(CHANGELOG, '0.3.0', '2026-11-20'), []);
  assert.match(changelogProblems(CHANGELOG, '0.3.0', '2026-11-21')[0], /dated 2026-11-20; the release goes out today, 2026-11-21/);
  assert.deepEqual(changelogProblems(CHANGELOG, '0.3.0', '2026-11-21', { rehearse: true }), []);
  assert.match(changelogProblems(CHANGELOG, '0.4.0', '2026-11-21')[0], /no "## \[0.4.0\] - YYYY-MM-DD" section/);
  assert.match(changelogProblems('## [Unreleased]\n\n## [0.4.0]\n- x\n', '0.4.0', '2026-11-21')[0], /has no date/);
  assert.match(localDate(new Date(2026, 0, 5)), /^2026-01-05$/);
  // "## [Unreleased]" stays on top, empty: entries left there, or a missing heading, are problems.
  assert.match(changelogProblems(CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- forgotten\n'), '0.3.0', '2026-11-20')[0], /still has entries under "## \[Unreleased\]"/);
  assert.match(changelogProblems(CHANGELOG.replace('## [Unreleased]\n\n', ''), '0.3.0', '2026-11-20')[0], /no "## \[Unreleased\]" heading/);
});

test('the release text carries the downloads, the SDK lines and the section', () => {
  const body = releaseBody(CHANGELOG, '0.3.0');
  assert.ok(body.startsWith('## Downloads\n'));
  assert.ok(body.includes("## What's new\n\n### Added\n- In-app updates\n\n---"));
  for (const line of ['Durbun-0.3.0-arm64.dmg', 'Durbun-0.3.0-x64.dmg', 'durbun: ^0.3.0', 'io.github.mykynk:durbun:0.3.0', "pod 'Durbun', '~> 0.3.0'", '@durbun/react-native@0.3.0', 'SHA256SUMS.txt']) assert.ok(body.includes(line), line);
  assert.equal(releaseBody(CHANGELOG, '0.9.9'), '');
});

test('signing keys and secrets in git are found; examples are not', () => {
  assert.deepEqual(trackedSecrets(['AuthKey_ABC123.p8', 'certs/dev.p12', 'apps/.env', '.env.local', '.env.example', 'src/key.ts', 'README.md', '']), ['AuthKey_ABC123.p8', 'certs/dev.p12', 'apps/.env', '.env.local']);
});

test('Electron must be on the latest patch of its major', () => {
  assert.deepEqual(electronPatchProblems('45.3.2', '["45.2.1","45.3.2","45.4.0-beta.1"]'), []);
  assert.match(electronPatchProblems('45.2.1', '"45.3.2"')[0], /Electron 45\.3\.2 is out; the app pins 45\.2\.1/);
  assert.match(electronPatchProblems('45.2.1', 'not json')[0], /could not be read/);
});

test('options: --from, --skip, --rehearse, unknown ones refused', () => {
  const steps = releaseSteps('0.3.0');
  const ids = (opts) => selectSteps(steps, { skip: new Set(), ...opts }).map((s) => s.id);
  assert.equal(ids({})[0], 'git-clean');
  assert.ok(!ids({ rehearse: true }).some((id) => id.startsWith('git') || id === 'tag-free'));
  assert.equal(ids({ from: 'android' })[0], 'android');
  assert.ok(!ids({ skip: new Set(['pod-lint']) }).includes('pod-lint'));
  assert.deepEqual(ids({ only: new Set(['changelog', 'versions']) }), ['versions', 'changelog']);
  assert.throws(() => ids({ from: 'nope' }), /No step "nope"/);
  assert.deepEqual([...parseArgs(['--skip', 'a,b', '--from=x', '--rehearse']).skip], ['a', 'b']);
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
});

test('every check a release needs is in the list, Flutter with --concurrency=2 one suite at a time', () => {
  const steps = releaseSteps('0.3.0');
  const ids = steps.map((s) => s.id);
  for (const id of ['git-clean', 'git-main', 'tag-free', 'secrets', 'versions', 'electron', 'changelog', 'typecheck', 'test', 'build', 'desktop', 'flutter-durbun', 'pub-dry-run', 'android', 'ios', 'pod-lint']) assert.ok(ids.includes(id), id);
  assert.ok(ids.indexOf('flutter-idle') < ids.indexOf('flutter-durbun'));
  const flutterTests = steps.flatMap((s) => s.run ?? []).filter(([cmd, args]) => cmd === 'flutter' && args[0] === 'test');
  assert.equal(flutterTests.length, 2);
  for (const [, args] of flutterTests) assert.ok(args.includes('--concurrency=2'));
  // It never installs, builds the Mac app, tags or uploads.
  const commands = steps.flatMap((s) => s.run ?? []).map(([cmd, args]) => [cmd, ...args].join(' '));
  for (const c of commands) assert.doesNotMatch(c, /npm (ci|install)|app:(dist|release)|git (tag|push)|gh release|publish(?! --dry-run)/, c);
});

test('it stops at the first failure and says how to continue', () => {
  const lines = [];
  const ran = [];
  const steps = [
    { id: 'a', title: 'A', run: [['true', []]] },
    { id: 'b', title: 'B', run: [['false', ['x'], 'sdks/ios']], fix: 'Do the thing.' },
    { id: 'c', title: 'C', run: [['true', []]] },
  ];
  const result = runSteps(steps, { rehearse: true }, { run: (cmd) => (ran.push(cmd), cmd === 'false' ? 3 : 0), print: (l) => lines.push(l), has: () => true, sh: () => ({ status: 0, out: '' }) });
  assert.deepEqual(result, { ok: false, failed: 'b' });
  assert.deepEqual(ran, ['true', 'false']);
  const text = lines.join('\n');
  assert.match(text, /✖ B\n {2}`false x` failed \(exit 3\) in sdks\/ios; its output is above\. Do the thing\./);
  assert.match(text, /npm run release:check -- --from b --rehearse/);
});

test('a missing tool and a failed check are plain problems too', () => {
  const lines = [];
  const io = { print: (l) => lines.push(l), run: () => 0, sh: () => ({ status: 0, out: ' M file\n' }), has: (tool) => tool !== 'pod' };
  assert.deepEqual(runSteps([{ id: 'pod-lint', needs: 'pod', title: 'Pod', run: [['pod', []]] }], {}, io), { ok: false, failed: 'pod-lint' });
  assert.match(lines.join('\n'), /"pod" is not installed or not on PATH\. Install it, or leave this step out with --skip pod-lint/);
  const clean = releaseSteps('0.3.0').find((s) => s.id === 'git-clean');
  assert.equal(runSteps([clean], {}, io).failed, 'git-clean');
});

test('the closing instructions tag only after the artifacts and attach the update feeds', () => {
  const text = nextSteps('0.3.0').join('\n');
  assert.ok(text.indexOf('npm run app:release') < text.indexOf('git tag -a v0.3.0'));
  assert.match(text, /durbun-update-mac-\*\.json/);
});
