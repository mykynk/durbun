// node --test scripts/release-check.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogProblems, localDate, nextSteps, parseArgs, releaseSteps, runSteps, selectSteps } from './release-check.mjs';
import { changelogDate, changelogSection } from './release-notes.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHANGELOG = `# Changelog

## [Unreleased]

- next

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
  assert.match(changelogProblems('## [0.4.0]\n- x\n', '0.4.0', '2026-11-21')[0], /has no date/);
  assert.match(localDate(new Date(2026, 0, 5)), /^2026-01-05$/);
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
  for (const id of ['git-clean', 'git-main', 'tag-free', 'versions', 'changelog', 'typecheck', 'test', 'build', 'desktop', 'flutter-durbun', 'pub-dry-run', 'android', 'ios', 'pod-lint']) assert.ok(ids.includes(id), id);
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
