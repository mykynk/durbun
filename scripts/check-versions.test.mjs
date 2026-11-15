// node --test scripts/check-versions.test.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SOURCES, checkVersions, formatReport, main, writeVersions } from './check-versions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A temp copy of every file the check reads. */
function copyOfSources() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-versions-'));
  for (const file of new Set(SOURCES.map((s) => s.file))) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    cpSync(path.join(repo, file), path.join(dir, file));
  }
  return dir;
}

test('the repository is consistent, every source is found the expected number of times', () => {
  const { results } = checkVersions(repo);
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => `${r.file} ${r.what}: ${r.problem}`), []);
});

test('a stale place is reported under its file with line, value and what it is', () => {
  const dir = copyOfSources();
  try {
    const file = path.join(dir, 'sdks/ios/README.md');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace(/pod 'Durbun', '~> (\d+\.\d+\.\d+)'/, "pod 'Durbun', '~> 0.0.1'"));
    const check = checkVersions(dir);
    const report = formatReport(check, ' (package.json)');
    assert.equal(report.ok, false);
    assert.match(report.text, /^✖ 1 of \d+ files do not carry version/);
    assert.match(report.text, /  ✖ sdks\/ios\/README\.md\n      line \d+: 0\.0\.1 \(pod '~>'\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an Unreleased section on top of a changelog is skipped, the released entry below it is checked', () => {
  const dir = copyOfSources();
  try {
    for (const [file, heading] of [
      ['CHANGELOG.md', '## [Unreleased]'],
      ['sdks/flutter/durbun/CHANGELOG.md', '## Unreleased'],
      ['sdks/flutter/durbun_dio/CHANGELOG.md', '## Unreleased'],
    ]) {
      const full = path.join(dir, file);
      const text = readFileSync(full, 'utf8').replace(/^## (?:\[Unreleased\]|Unreleased)\s*\n(?:(?!## )[^\n]*\n)*/m, '');
      writeFileSync(full, `${heading}\n\n- next\n\n${text}`);
    }
    assert.equal(formatReport(checkVersions(dir)).ok, true);
    // A stale released entry under the Unreleased section is still found.
    const dio = path.join(dir, 'sdks/flutter/durbun_dio/CHANGELOG.md');
    writeFileSync(dio, readFileSync(dio, 'utf8').replace(/^## (?!Unreleased)\S+/m, '## 0.0.1'));
    assert.match(formatReport(checkVersions(dir)).text, /✖ sdks\/flutter\/durbun_dio\/CHANGELOG\.md\n      line \d+: 0\.0\.1 \(newest entry\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or reshaped place is reported, not skipped', () => {
  const dir = copyOfSources();
  try {
    rmSync(path.join(dir, 'Package.swift'));
    const file = path.join(dir, 'sdks/android/README.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/io\.github\.mykynk:durbun-noop:/g, 'io.github.mykynk:durbun-off:'));
    const text = formatReport(checkVersions(dir)).text;
    assert.match(text, /✖ Package\.swift\n      usage comment: file not found/);
    assert.match(text, /✖ sdks\/android\/README\.md\n      Gradle coordinates: 1 found, expected 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--write updates every place except the changelogs, and the check then names only those', () => {
  const dir = copyOfSources();
  try {
    const changed = writeVersions(dir, '9.8.7');
    assert.ok(changed.includes('package-lock.json'));
    assert.ok(!changed.some((f) => f.endsWith('CHANGELOG.md')));
    const { results } = checkVersions(dir, SOURCES, '9.8.7');
    assert.deepEqual([...new Set(results.filter((r) => !r.ok).map((r) => r.file))].sort(), [
      'CHANGELOG.md',
      'sdks/flutter/durbun/CHANGELOG.md',
      'sdks/flutter/durbun_dio/CHANGELOG.md',
    ]);
    // Only the version strings changed.
    const before = readFileSync(path.join(repo, 'sdks/ios/README.md'), 'utf8');
    const after = readFileSync(path.join(dir, 'sdks/ios/README.md'), 'utf8');
    assert.equal(after.split('9.8.7').join('X'), before.split(checkVersions(repo).expected).join('X'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arguments are validated', () => {
  assert.equal(main(['--tag', '0.2.0'], repo).code, 1);
  assert.equal(main(['--tag', 'v0.2'], repo).code, 1);
  assert.equal(main(['--write', 'next'], repo).code, 1);
  assert.equal(main(['--tag', 'v0.0.0-never'], repo).code, 1);
});
