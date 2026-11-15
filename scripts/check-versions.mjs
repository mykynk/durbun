#!/usr/bin/env node
/**
 * Every part of Dürbün (Mac app, server, UI, SDKs) carries the same version. This lists each place the
 * version is written (package manifests, version constants, lockfiles, changelogs, install snippets in the
 * docs) and fails when one differs from the others, or from a release tag:
 *
 *   node scripts/check-versions.mjs                # all equal to package.json's version?
 *   node scripts/check-versions.mjs --tag v0.2.0   # all equal to 0.2.0? (the release workflow)
 *   node scripts/check-versions.mjs --write 0.3.0  # write 0.3.0 everywhere (not the changelogs: their new
 *                                                  # section is written by hand), then check again
 *
 * The report names every file, with the line and the value of each place that is wrong.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const V = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`;
const re = (source, flags = 'gm') => new RegExp(source.replace(/\{V\}/g, V), flags);

/**
 * { file, what, pattern (global regex; group 1 is the version), count (expected matches, default 1),
 *   write (false for changelogs) }
 */
export const SOURCES = [
  // Manifests and version constants.
  { file: 'package.json', what: 'version', pattern: re(String.raw`^  "version":\s*"([^"]+)"`) },
  { file: 'packages/protocol/package.json', what: 'version', pattern: re(String.raw`^  "version":\s*"([^"]+)"`) },
  { file: 'packages/server/package.json', what: 'version', pattern: re(String.raw`^  "version":\s*"([^"]+)"`) },
  { file: 'packages/server/package.json', what: '@durbun/protocol dependency', pattern: re(String.raw`"@durbun/protocol":\s*"([^"]+)"`) },
  { file: 'packages/ui/package.json', what: 'version', pattern: re(String.raw`^  "version":\s*"([^"]+)"`) },
  { file: 'packages/ui/package.json', what: '@durbun/protocol dependency', pattern: re(String.raw`"@durbun/protocol":\s*"([^"]+)"`) },
  { file: 'apps/desktop/package.json', what: 'version', pattern: re(String.raw`^  "version":\s*"([^"]+)"`) },
  { file: 'packages/server/src/version.ts', what: 'SERVER_VERSION', pattern: re(String.raw`SERVER_VERSION = '([^']+)'`) },
  { file: 'sdks/js/package.json', what: 'version', pattern: re(String.raw`^  "version":\s*"([^"]+)"`) },
  { file: 'sdks/js/src/version.ts', what: 'SDK_VERSION', pattern: re(String.raw`SDK_VERSION = '([^']+)'`) },
  { file: 'sdks/flutter/durbun/pubspec.yaml', what: 'version', pattern: re(String.raw`^version:\s*(\S+)`) },
  { file: 'sdks/flutter/durbun/lib/src/core/protocol.dart', what: 'kSdkVersion', pattern: re(String.raw`kSdkVersion = '([^']+)'`) },
  { file: 'sdks/flutter/durbun/android/build.gradle', what: 'version', pattern: re(String.raw`^version = "([^"]+)"`) },
  { file: 'sdks/flutter/durbun/android/src/core/kotlin/dev/durbun/Durbun.kt', what: 'VERSION (synced core)', pattern: re(String.raw`const val VERSION: String = "([^"]+)"`) },
  { file: 'sdks/flutter/durbun/ios/durbun.podspec', what: 's.version', pattern: re(String.raw`s\.version\s*=\s*'([^']+)'`) },
  { file: 'sdks/flutter/durbun/ios/durbun/Sources/durbun/Core/Public/Durbun.swift', what: 'version (synced core)', pattern: re(String.raw`static let version = "([^"]+)"`) },
  { file: 'sdks/flutter/durbun_dio/pubspec.yaml', what: 'version', pattern: re(String.raw`^version:\s*(\S+)`) },
  { file: 'sdks/flutter/durbun_dio/pubspec.yaml', what: 'durbun dependency', pattern: re(String.raw`^\s+durbun:\s*\^(\S+)`) },
  { file: 'sdks/ios/Sources/Durbun/Public/Durbun.swift', what: 'version', pattern: re(String.raw`static let version = "([^"]+)"`) },
  { file: 'Durbun.podspec', what: 's.version', pattern: re(String.raw`s\.version\s*=\s*'([^']+)'`) },
  { file: 'sdks/android/durbun/src/main/kotlin/dev/durbun/Durbun.kt', what: 'VERSION', pattern: re(String.raw`const val VERSION: String = "([^"]+)"`) },
  { file: 'sdks/android/durbun-noop/src/main/kotlin/dev/durbun/Durbun.kt', what: 'VERSION', pattern: re(String.raw`const val VERSION: String = "([^"]+)"`) },
  { file: 'sdks/android/durbun-noop/src/test/kotlin/dev/durbun/NoopApiTest.kt', what: 'expected VERSION', pattern: re(String.raw`assertEquals\("([^"]+)", Durbun\.VERSION\)`) },

  // Lockfiles (npm writes them; a stale one makes `npm ci` fail).
  { file: 'package-lock.json', what: 'root version', pattern: re(String.raw`^  "version":\s*"([^"]+)"|^  "packages": \{\n    "": \{\n      "name": "durbun",\n      "version": "([^"]+)"`), count: 2 },
  {
    file: 'package-lock.json',
    what: 'workspace versions',
    pattern: re(String.raw`^    "(?:packages/(?:protocol|server|ui)|sdks/js)": \{\n      "name": "[^"]+",\n      "version": "([^"]+)"`),
    count: 4,
  },
  { file: 'package-lock.json', what: '@durbun/protocol dependencies', pattern: re(String.raw`^        "@durbun/protocol": "([^"]+)"`), count: 2 },
  { file: 'apps/desktop/package-lock.json', what: 'root version', pattern: re(String.raw`^  "version":\s*"([^"]+)"|^  "packages": \{\n    "": \{\n      "name": "[^"]+",\n      "version": "([^"]+)"`), count: 2 },

  // Install snippets and other pinned mentions in the docs.
  { file: 'README.md', what: 'Swift Package Manager "from"', pattern: re(String.raw`mykynk/durbun\` from \`{V}\``) },
  { file: 'README.tr.md', what: 'Swift Package Manager "from"', pattern: re(String.raw`\`{V}\` sürümünden itibaren`) },
  { file: 'Package.swift', what: 'usage comment', pattern: re(String.raw`from: "{V}"`) },
  { file: 'sdks/ios/README.md', what: 'Swift Package Manager "from"', pattern: re(String.raw`from: "{V}"`) },
  { file: 'sdks/ios/README.md', what: "pod '~>'", pattern: re(String.raw`pod 'Durbun', '~> {V}'`), count: 2 },
  { file: 'sdks/ios/README.md', what: 'pod :tag', pattern: re(String.raw`:tag => 'v{V}'`) },
  { file: 'sdks/android/README.md', what: 'Gradle coordinates', pattern: re(String.raw`io\.github\.mykynk:durbun(?:-noop)?:{V}`), count: 3 },
  { file: 'sdks/flutter/durbun/README.md', what: 'pubspec snippet', pattern: re(String.raw`^\s+durbun:\s*\^{V}`) },
  { file: 'sdks/flutter/durbun_dio/README.md', what: 'pubspec snippet', pattern: re(String.raw`^\s+durbun(?:_dio)?:\s*\^{V}`), count: 2 },
  { file: 'sdks/flutter/durbun_dio/pubspec_overrides.yaml', what: 'comment', pattern: re(String.raw`\`durbun: \^{V}\``) },
  { file: 'sdks/js/README.md', what: 'npm pack file name', pattern: re(String.raw`durbun-react-native-{V}\.tgz`), count: 3 },
  { file: '.github/ISSUE_TEMPLATE/bug_report.yml', what: 'version placeholder', pattern: re(String.raw`^\s+placeholder:\s*{V}\s*$`) },

  // The newest released changelog entry must be the current version (written by hand, never by --write).
  // A `## [Unreleased]` section above it collects the next version's entries and is skipped.
  { file: 'CHANGELOG.md', what: 'newest entry', pattern: re(String.raw`^## \[(?!Unreleased\])([^\]]+)\]`, 'm'), write: false },
  // The Flutter changelogs (pub.dev format, `## X.Y.Z`) may also start with an `## Unreleased` section.
  { file: 'sdks/flutter/durbun/CHANGELOG.md', what: 'newest entry', pattern: re(String.raw`^## (?!Unreleased\s*$)(\S+)`, 'm'), write: false },
  { file: 'sdks/flutter/durbun_dio/CHANGELOG.md', what: 'newest entry', pattern: re(String.raw`^## (?!Unreleased\s*$)(\S+)`, 'm'), write: false },
];

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** The version of each match (the first group that matched), with its line; a non-global pattern gives the first only. */
function matchesIn(text, pattern) {
  const out = [];
  const global = pattern.flags.includes('g');
  const rx = global ? new RegExp(pattern.source, pattern.flags) : new RegExp(pattern.source, `${pattern.flags}g`);
  for (const m of text.matchAll(rx)) {
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    if (group < 0) continue;
    const start = m.index + m[0].indexOf(m[group]);
    out.push({ version: m[group], line: lineOf(text, start), start, end: start + m[group].length });
    if (!global) break;
  }
  return out;
}

/**
 * Checks every source against `expected` (default: the first source's version). Returns
 * `{ expected, results: [{ file, what, ok, problem?, matches }] }`.
 */
export function checkVersions(root, sources = SOURCES, expected) {
  const texts = new Map();
  const read = (file) => {
    if (!texts.has(file)) {
      try {
        texts.set(file, readFileSync(path.join(root, file), 'utf8'));
      } catch {
        texts.set(file, undefined);
      }
    }
    return texts.get(file);
  };
  const results = sources.map((source) => {
    const text = read(source.file);
    if (text === undefined) return { ...source, ok: false, problem: 'file not found', matches: [] };
    const matches = matchesIn(text, source.pattern);
    return { ...source, matches };
  });
  const want = expected ?? results[0]?.matches[0]?.version;
  for (const r of results) {
    if (r.problem) continue;
    const count = r.count ?? 1;
    if (r.matches.length === 0) r.problem = 'not found';
    else if (r.matches.length !== count) r.problem = `${r.matches.length} found, expected ${count} (update this check if the file changed)`;
    else if (r.matches.some((m) => m.version !== want)) r.problem = 'wrong version';
    r.ok = !r.problem;
  }
  return { expected: want, results };
}

/**
 * The report, per file: every wrong place as `line N: value (what)` under its file, then the correct files
 * with the number of places checked in each.
 */
export function formatReport({ expected, results }, label = '') {
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  const wrongLines = [];
  const okLines = [];
  for (const [file, rs] of byFile) {
    const places = rs.reduce((n, r) => n + r.matches.length, 0);
    const wrong = rs.filter((r) => !r.ok);
    if (wrong.length === 0) {
      okLines.push(`  ✓ ${file} (${places})`);
      continue;
    }
    wrongLines.push(`  ✖ ${file}`);
    for (const r of wrong) {
      if (r.problem === 'wrong version') {
        for (const m of r.matches) if (m.version !== expected) wrongLines.push(`      line ${m.line}: ${m.version} (${r.what})`);
      } else {
        wrongLines.push(`      ${r.what}: ${r.problem}`);
      }
    }
  }
  const bad = byFile.size - okLines.length;
  const head = bad === 0
    ? `✓ all ${byFile.size} files carry version ${expected}${label}:`
    : `✖ ${bad} of ${byFile.size} files do not carry version ${expected}${label}:`;
  return { ok: bad === 0, text: [head, ...wrongLines, ...okLines].join('\n') };
}

/** Writes `version` into every writable place (changelogs excluded); returns the files changed. */
export function writeVersions(root, version, sources = SOURCES) {
  const changed = [];
  const byFile = new Map();
  for (const s of sources) {
    if (s.write === false) continue;
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }
  for (const [file, ss] of byFile) {
    const full = path.join(root, file);
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const spans = ss.flatMap((s) => matchesIn(text, s.pattern)).sort((a, b) => b.start - a.start);
    let next = text;
    for (const m of spans) next = next.slice(0, m.start) + version + next.slice(m.end);
    if (next !== text) {
      writeFileSync(full, next);
      changed.push(file);
    }
  }
  return changed;
}

const VERSION_ARG = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function main(argv, root) {
  const tagIndex = argv.indexOf('--tag');
  const writeIndex = argv.indexOf('--write');
  const tag = tagIndex >= 0 ? argv[tagIndex + 1] : undefined;
  const write = writeIndex >= 0 ? argv[writeIndex + 1] : undefined;
  if (tagIndex >= 0 && !/^v/.test(tag ?? '')) return { code: 1, err: `✖ --tag needs a tag like v1.2.3, got "${tag ?? ''}"` };
  if (tagIndex >= 0 && !VERSION_ARG.test(tag.slice(1))) return { code: 1, err: `✖ --tag needs a tag like v1.2.3, got "${tag}"` };
  if (writeIndex >= 0 && !VERSION_ARG.test(write ?? '')) return { code: 1, err: `✖ --write needs a version like 1.2.3, got "${write ?? ''}"` };

  const out = [];
  let expected = tag ? tag.slice(1) : undefined;
  let label = tag ? ` (tag ${tag})` : ' (package.json)';
  if (write) {
    const changed = writeVersions(root, write);
    out.push(`Wrote ${write} to ${changed.length} files${changed.length ? `: ${changed.join(', ')}` : ''}.`);
    out.push('Add the new CHANGELOG sections by hand, and run `npm install` so the lockfiles agree.');
    expected = write;
    label = '';
  }
  const report = formatReport(checkVersions(root, SOURCES, expected), label);
  if (report.ok) return { code: 0, out: [...out, report.text].join('\n') };
  return { code: 1, out: out.join('\n'), err: report.text };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = main(process.argv.slice(2), root);
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  process.exit(r.code);
}
