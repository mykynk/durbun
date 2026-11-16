// node --test scripts/site-data.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDate, main, minMacos, parseArgs, parseSums, siteData } from './site-data.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A folder with two small stand-in DMGs of the repository's version and, optionally, SHA256SUMS.txt. */
function releaseDir(sums) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-site-data-'));
  writeFileSync(path.join(dir, `Durbun-${version}-arm64.dmg`), 'arm');
  writeFileSync(path.join(dir, `Durbun-${version}-x64.dmg`), 'intel!');
  if (sums) writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums);
  return dir;
}

test('parseSums reads shasum output, text and binary mode', () => {
  const sums = parseSums(`${'a'.repeat(64)}  Durbun-1.0.0-arm64.dmg\r\n${'B'.repeat(64)} *dir/Durbun-1.0.0-x64.dmg\nnot a line\n`);
  assert.equal(sums.get('Durbun-1.0.0-arm64.dmg'), 'a'.repeat(64));
  assert.equal(sums.get('Durbun-1.0.0-x64.dmg'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('minMacos drops trailing zeros and reads the real config', () => {
  assert.equal(minMacos("minimumSystemVersion: '13.0',"), '13');
  assert.equal(minMacos('minimumSystemVersion: "13.5.0"'), '13.5');
  assert.equal(minMacos('nothing'), undefined);
  assert.match(minMacos(readFileSync(path.join(repo, 'apps/desktop/electron-builder.config.cjs'), 'utf8')), /^\d+(\.\d+)?$/);
});

test('isDate accepts only real days', () => {
  assert.ok(isDate('2026-11-12'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate('12.11.2026'));
  assert.ok(!isDate(undefined));
});

test('siteData names every address after the version; sha256 only when known', () => {
  const data = siteData({ version: '1.2.3', date: '2026-12-01', minMacos: '13', files: { arm64: { bytes: 10, sha256: 'f'.repeat(64) }, x64: { bytes: 20 } } });
  assert.deepEqual(Object.keys(data), ['generatedBy', 'version', 'date', 'minMacos', 'releaseUrl', 'checksumsUrl', 'dmg']);
  assert.equal(data.releaseUrl, 'https://github.com/mykynk/durbun/releases/tag/v1.2.3');
  assert.equal(data.checksumsUrl, 'https://github.com/mykynk/durbun/releases/download/v1.2.3/SHA256SUMS.txt');
  assert.deepEqual(data.dmg.arm64, {
    file: 'Durbun-1.2.3-arm64.dmg',
    url: 'https://github.com/mykynk/durbun/releases/download/v1.2.3/Durbun-1.2.3-arm64.dmg',
    bytes: 10,
    sha256: 'f'.repeat(64),
  });
  assert.equal(data.dmg.x64.file, 'Durbun-1.2.3-x64.dmg');
  assert.equal('sha256' in data.dmg.x64, false);
});

test('parseArgs takes repeated sizes and rejects the rest', () => {
  assert.deepEqual(parseArgs(['--size', 'arm64=5', '--size', 'x64=6', '--date', '2026-11-12']).opts, { sizes: { arm64: 5, x64: 6 }, date: '2026-11-12' });
  assert.match(parseArgs(['--size', 'universal=5']).error, /arm64=<bytes>/);
  assert.match(parseArgs(['--dir']).error, /needs a value/);
  assert.match(parseArgs(['--nope', 'x']).error, /Unknown option/);
});

test('--dir measures and hashes the DMGs and checks them against SHA256SUMS.txt', () => {
  const dir = releaseDir(`${sha('arm')}  Durbun-${version}-arm64.dmg\n${sha('intel!')}  Durbun-${version}-x64.dmg\n`);
  try {
    const out = path.join(dir, 'release.json');
    const r = main(['--dir', dir, '--out', out], repo, { today: '2026-12-24' });
    assert.equal(r.code, 0, r.err);
    const data = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(data.version, version);
    assert.equal(data.date, '2026-12-24');
    assert.deepEqual([data.dmg.arm64.bytes, data.dmg.arm64.sha256], [3, sha('arm')]);
    assert.deepEqual([data.dmg.x64.bytes, data.dmg.x64.sha256], [6, sha('intel!')]);
    assert.ok(readFileSync(out, 'utf8').endsWith('}\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dir stops when a DMG is missing from SHA256SUMS.txt or differs from it', () => {
  for (const sums of [`${sha('arm')}  Durbun-${version}-arm64.dmg\n`, `${sha('arm')}  Durbun-${version}-arm64.dmg\n${sha('old')}  Durbun-${version}-x64.dmg\n`]) {
    const dir = releaseDir(sums);
    try {
      const r = main(['--dir', dir], repo);
      assert.equal(r.code, 1);
      assert.match(r.err, /SHA256SUMS\.txt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const empty = mkdtempSync(path.join(os.tmpdir(), 'durbun-site-data-'));
  try {
    assert.match(main(['--dir', empty], repo).err, /is missing/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('sizes given by hand, with or without the checksums file', () => {
  const plain = main(['--size', 'arm64=118868277', '--size', 'x64=126099462', '--date', '2026-11-12'], repo);
  assert.equal(plain.code, 0, plain.err);
  const data = JSON.parse(plain.out);
  assert.equal(data.dmg.x64.bytes, 126099462);
  assert.equal('sha256' in data.dmg.arm64, false);

  const dir = releaseDir(`${sha('a')}  Durbun-${version}-arm64.dmg\n${sha('b')}  Durbun-${version}-x64.dmg\n`);
  try {
    const r = main(['--sums', 'SHA256SUMS.txt', '--size', 'arm64=1', '--size', 'x64=2', '--date', '2026-11-12'], repo, { cwd: dir });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).dmg.x64.sha256, sha('b'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(main(['--size', 'arm64=1'], repo).code, 2);
  assert.equal(main(['--size', 'arm64=1', '--size', 'x64=2', '--date', 'today'], repo).code, 2);
});
