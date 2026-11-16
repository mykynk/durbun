// node --test scripts/homebrew-cask.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { caskText, desktopFacts, macosSymbol, main, parseArgs, rubyString } from './homebrew-cask.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const NFD_NAME = 'Dürbün'.normalize('NFD');

/** A folder with two small stand-in DMGs of the repository's version and, optionally, SHA256SUMS.txt. */
function releaseDir(sums) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-cask-'));
  writeFileSync(path.join(dir, `Durbun-${version}-arm64.dmg`), 'arm');
  writeFileSync(path.join(dir, `Durbun-${version}-x64.dmg`), 'intel!');
  if (sums) writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums);
  return dir;
}

const facts = (patch = {}) => ({
  version: '0.3.0',
  minMacos: '13',
  sha256: { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) },
  appName: NFD_NAME,
  appId: 'dev.durbun.desktop',
  dataName: 'Dürbün',
  ...patch,
});

test('macosSymbol names the major Homebrew compares', () => {
  assert.equal(macosSymbol('13'), ':ventura');
  assert.equal(macosSymbol('13.5'), ':ventura');
  assert.equal(macosSymbol('14'), ':sonoma');
  assert.equal(macosSymbol('10.15'), undefined);
});

test('rubyString escapes quotes, backslashes and interpolation; non-ASCII on request', () => {
  assert.equal(rubyString('a "b" \\ #{x}'), '"a \\"b\\" \\\\ \\#{x}"');
  assert.equal(rubyString(`${NFD_NAME}.app`, { escape: true }), '"Du\\u0308rbu\\u0308n.app"');
  assert.equal(rubyString('Dürbün'), '"Dürbün"');
});

test('apps/desktop gives the bundle name in NFD, the bundle id and the data folder name', () => {
  const { app } = desktopFacts(repo);
  assert.equal(app.appName, NFD_NAME);
  assert.notEqual(app.appName, app.appName.normalize('NFC'));
  assert.equal(app.appId, 'dev.durbun.desktop');
  assert.equal(app.dataName.normalize('NFC'), 'Dürbün');
});

test('the cask: both architectures, the release URL, the real bundle, auto updates, macOS minimum, zap paths', () => {
  const text = caskText(facts());
  assert.match(text, /^cask "durbun" do$/m);
  assert.match(text, /arch arm: "arm64", intel: "x64"/);
  assert.match(text, /version "0\.3\.0"/);
  assert.match(text, new RegExp(`sha256 arm:   "${'a'.repeat(64)}",\\n\\s+intel: "${'b'.repeat(64)}"`));
  assert.match(text, /url "https:\/\/github\.com\/mykynk\/durbun\/releases\/download\/v#\{version\}\/Durbun-#\{version\}-#\{arch\}\.dmg",\n\s+verified: "github\.com\/mykynk\/durbun\/"/);
  assert.match(text, /homepage "https:\/\/appnify\.dev\/durbun\/"/);
  assert.match(text, /^  auto_updates true$/m);
  assert.match(text, /depends_on macos: ">= :ventura"/);
  assert.match(text, /^  app "Du\\u0308rbu\\u0308n\.app"$/m);
  assert.match(text, /uninstall quit: "dev\.durbun\.desktop"/);
  for (const p of ['~/.durbun', '~/Library/Application Support/Dürbün', '~/Library/Caches/dev.durbun.desktop.ShipIt', '~/Library/Preferences/dev.durbun.desktop.plist']) assert.ok(text.includes(`"${p}",`), p);
  // Homebrew's own rules for desc: no article first, no app name, short, no full stop.
  const desc = /desc "([^"]+)"/.exec(text)[1];
  assert.ok(desc.length <= 80 && !/^(a|an|the) /i.test(desc) && !/dürbün|durbun/i.test(desc) && !desc.endsWith('.'));
});

test('an NFC bundle name is written as it is, without the note', () => {
  const text = caskText(facts({ appName: 'Dürbün' }));
  assert.match(text, /^  app "Dürbün\.app"$/m);
  assert.doesNotMatch(text, /NFD/);
});

test('a macOS Homebrew has no name for stops the cask', () => {
  assert.throws(() => caskText(facts({ minMacos: '10.15' })), /MACOS_NAMES/);
});

test('parseArgs takes --dir, --sums, --out and rejects the rest', () => {
  assert.deepEqual(parseArgs(['--dir', 'r', '--out', 'c.rb']).opts, { dir: 'r', out: 'c.rb' });
  assert.match(parseArgs(['--size', 'arm64=1']).error, /Unknown option/);
  assert.match(parseArgs(['--dir']).error, /needs a value/);
});

test('--dir hashes the DMGs and checks them against SHA256SUMS.txt', () => {
  const ok = releaseDir(`${sha('arm')}  Durbun-${version}-arm64.dmg\n${sha('intel!')}  Durbun-${version}-x64.dmg\n`);
  const bad = releaseDir(`${'0'.repeat(64)}  Durbun-${version}-arm64.dmg\n${sha('intel!')}  Durbun-${version}-x64.dmg\n`);
  try {
    const r = main(['--dir', ok], repo);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`sha256 arm:   "${sha('arm')}"`));
    assert.ok(r.out.includes(`intel: "${sha('intel!')}"`));
    assert.ok(r.out.includes(`version "${version}"`));
    const out = path.join(ok, 'durbun.rb');
    assert.equal(main(['--dir', ok, '--out', out], repo).code, 0);
    assert.equal(readFileSync(out, 'utf8'), `${r.out}\n`);
    const r2 = main(['--dir', bad], repo);
    assert.equal(r2.code, 1);
    assert.match(r2.err, /does not match/);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('--sums alone gives the checksums; a missing line or no checksums at all stops it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-cask-sums-'));
  try {
    const full = path.join(dir, 'full.txt');
    writeFileSync(full, `${'c'.repeat(64)}  Durbun-${version}-arm64.dmg\n${'d'.repeat(64)}  Durbun-${version}-x64.dmg\n`);
    const r = main(['--sums', full], repo);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`"${'c'.repeat(64)}"`) && r.out.includes(`"${'d'.repeat(64)}"`));
    const half = path.join(dir, 'half.txt');
    writeFileSync(half, `${'c'.repeat(64)}  Durbun-${version}-arm64.dmg\n`);
    assert.match(main(['--sums', half], repo).err, /no line for Durbun-.*-x64\.dmg/);
    assert.equal(main([], repo).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the cask is valid Ruby (checked only where a ruby binary exists)', (t) => {
  if (spawnSync('sh', ['-c', 'command -v ruby']).status !== 0) return t.skip('no ruby on this machine');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-cask-ruby-'));
  try {
    const file = path.join(dir, 'durbun.rb');
    writeFileSync(file, caskText(facts()));
    const r = spawnSync('ruby', ['-c', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
