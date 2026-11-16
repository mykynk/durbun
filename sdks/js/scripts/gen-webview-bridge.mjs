// Bundles the web view bridge (webview/bridge.ts) into the copies the native SDKs embed:
//   sdks/android/durbun/src/main/kotlin/dev/durbun/internal/WebViewBridgeScript.kt
//   sdks/ios/Sources/Durbun/WebView/WebViewBridgeScript.swift
// One source, the same minified bytes on both platforms.
//
//   node scripts/gen-webview-bridge.mjs           # write both copies
//   node scripts/gen-webview-bridge.mjs --check   # exit code 1 when a copy drifted (test/webview-sync.test.ts runs it)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export const ENTRY = here('../webview/entry.ts');
export const ANDROID_COPY = here('../../android/durbun/src/main/kotlin/dev/durbun/internal/WebViewBridgeScript.kt');
export const IOS_COPY = here('../../ios/Sources/Durbun/WebView/WebViewBridgeScript.swift');

const HEADER = 'Generated from sdks/js/webview/bridge.ts by sdks/js/scripts/gen-webview-bridge.mjs. Do not edit.';
const CHUNK = 100;

/** The minified, self-running script (ASCII only: esbuild escapes everything else). */
export function bundleBridge() {
  const result = buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2017'],
    platform: 'browser',
    legalComments: 'none',
    charset: 'ascii',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text.trim();
}

function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
  return out;
}

export function kotlinSource(script) {
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n');
  const lines = chunks(script).map((part) => `        "${escape(part)}"`);
  return [
    `// ${HEADER}`,
    'package dev.durbun.internal',
    '',
    '/** The script `DurbunWebView` injects into a web view: reports fetch, XMLHttpRequest and console calls. */',
    'internal object WebViewBridgeScript {',
    '    const val SOURCE: String =',
    lines.join(' +\n'),
    '}',
    '',
  ].join('\n');
}

export function swiftSource(script) {
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const lines = chunks(script).map((part) => `        "${escape(part)}",`);
  return [
    `// ${HEADER}`,
    '',
    '/// The script `DurbunWebView` injects into a web view: reports fetch, XMLHttpRequest and console calls.',
    'enum WebViewBridgeScript {',
    '    static let source: String = [',
    ...lines,
    '    ].joined()',
    '}',
    '',
  ].join('\n');
}

/** [path, wanted content] for each copy. */
export function copies() {
  const script = bundleBridge();
  return [
    [ANDROID_COPY, kotlinSource(script)],
    [IOS_COPY, swiftSource(script)],
  ];
}

/** Paths whose content differs from what the bridge source generates (empty = in sync). */
export function drifted() {
  return copies()
    .filter(([path, wanted]) => {
      try {
        return readFileSync(path, 'utf8') !== wanted;
      } catch {
        return true;
      }
    })
    .map(([path]) => path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const stale = drifted();
    if (stale.length) {
      console.error('The web view bridge copies drifted from sdks/js/webview/bridge.ts:\n  ' + stale.join('\n  '));
      console.error('Run: npm run webview:generate -w @durbun/react-native');
      process.exit(1);
    }
    console.log('Web view bridge copies are in sync.');
  } else {
    for (const [path, content] of copies()) writeFileSync(path, content);
    console.log('Web view bridge copies written (Android, iOS).');
  }
}
