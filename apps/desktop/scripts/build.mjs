#!/usr/bin/env node
/**
 * Compile the app's TypeScript with esbuild (from the repo root's node_modules):
 *   src/main.ts    → out/main.mjs    (Electron main process, ESM)
 *   src/preload.ts → out/preload.cjs (sandboxed preload, CommonJS)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  absWorkingDir: appDir,
  bundle: true,
  platform: 'node',
  external: ['electron'],
  sourcemap: 'linked',
  sourcesContent: false,
  legalComments: 'none',
  logLevel: 'warning',
};

const started = Date.now();
try {
  await Promise.all([
    build({ ...common, entryPoints: ['src/main.ts'], outfile: 'out/main.mjs', format: 'esm', target: 'node22' }),
    // The preload's Notification shim is serialized into the page: keep syntax native (no helpers).
    build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'out/preload.cjs', format: 'cjs', target: 'chrome130' }),
  ]);
} catch {
  console.error('✖ desktop build failed · masaüstü derlemesi başarısız');
  process.exit(1);
}
console.log(`✓ apps/desktop/out  (${Date.now() - started} ms)`);
