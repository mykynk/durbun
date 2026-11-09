#!/usr/bin/env node
/**
 * Every part of Dürbün (Mac app, server, UI, SDKs) carries the same version. This lists each place the
 * version is written and fails when they differ, or when they differ from a release tag:
 *
 *   node scripts/check-versions.mjs              # all equal?
 *   node scripts/check-versions.mjs --tag v0.2.0 # all equal to 0.2.0? (the release workflow)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [file, regex whose first group is the version] */
const SOURCES = [
  ['package.json', /"version":\s*"([^"]+)"/],
  ['packages/protocol/package.json', /"version":\s*"([^"]+)"/],
  ['packages/server/package.json', /"version":\s*"([^"]+)"/],
  ['packages/ui/package.json', /"version":\s*"([^"]+)"/],
  ['apps/desktop/package.json', /"version":\s*"([^"]+)"/],
  ['packages/server/src/version.ts', /SERVER_VERSION = '([^']+)'/],
  ['sdks/js/package.json', /"version":\s*"([^"]+)"/],
  ['sdks/js/src/version.ts', /SDK_VERSION = '([^']+)'/],
  ['sdks/flutter/durbun/pubspec.yaml', /^version:\s*(\S+)/m],
  ['sdks/flutter/durbun/lib/src/core/protocol.dart', /kSdkVersion = '([^']+)'/],
  ['sdks/flutter/durbun/android/build.gradle', /^version = "([^"]+)"/m],
  ['sdks/flutter/durbun/ios/durbun.podspec', /s\.version\s*=\s*'([^']+)'/],
  ['sdks/flutter/durbun/ios/durbun/Sources/durbun/Core/Public/Durbun.swift', /static let version = "([^"]+)"/],
  ['sdks/flutter/durbun_dio/pubspec.yaml', /^version:\s*(\S+)/m],
  ['sdks/flutter/durbun_dio/pubspec.yaml', /^\s+durbun:\s*\^(\S+)/m],
  ['sdks/ios/Sources/Durbun/Public/Durbun.swift', /static let version = "([^"]+)"/],
  ['Durbun.podspec', /s\.version\s*=\s*'([^']+)'/],
  ['sdks/android/durbun/src/main/kotlin/dev/durbun/Durbun.kt', /const val VERSION: String = "([^"]+)"/],
  // The newest changelog entry must be the current version.
  ['CHANGELOG.md', /^## \[([^\]]+)\]/m],
  ['sdks/flutter/durbun/CHANGELOG.md', /^## (\S+)/m],
  ['sdks/flutter/durbun_dio/CHANGELOG.md', /^## (\S+)/m],
];

const tagIndex = process.argv.indexOf('--tag');
const tag = tagIndex > 0 ? process.argv[tagIndex + 1] : undefined;
if (tagIndex > 0 && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag ?? '')) {
  console.error(`✖ --tag needs a tag like v1.2.3, got "${tag ?? ''}"`);
  process.exit(1);
}

const found = SOURCES.map(([file, re]) => {
  let text;
  try {
    text = readFileSync(path.join(root, file), 'utf8');
  } catch {
    return { file, version: undefined };
  }
  return { file, version: re.exec(text)?.[1] };
});

const expected = tag ? tag.slice(1) : found[0].version;
const wrong = found.filter((f) => f.version !== expected);
if (wrong.length > 0) {
  console.error(`✖ expected version ${expected}${tag ? ` (tag ${tag})` : ' (package.json)'}:`);
  for (const f of wrong) console.error(`  ${f.file}: ${f.version ?? 'not found'}`);
  process.exit(1);
}
console.log(`✓ ${found.length} version sources are ${expected}`);
