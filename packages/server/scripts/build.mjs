#!/usr/bin/env node
/**
 * Bundle the server (entry src/cli.ts) into <repo>/dist/durbun.mjs — one ESM file for Node 20+, with a
 * shebang and a createRequire shim for the CommonJS dependencies (ws, plist). The optional native ws
 * add-ons (bufferutil, utf-8-validate) stay external; ws falls back to its JS implementation.
 *
 *   node packages/server/scripts/build.mjs [--minify] [--no-sourcemap]
 */
import { existsSync } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..', '..');
const outfile = path.join(repoRoot, 'dist', 'durbun.mjs');
const flags = new Set(process.argv.slice(2));

const banner = [
  '#!/usr/bin/env node',
  "import { createRequire as __durbunCreateRequire } from 'node:module';",
  'const require = __durbunCreateRequire(import.meta.url);',
].join('\n');

const started = Date.now();
try {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(serverDir, 'src', 'cli.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: banner },
    external: ['bufferutil', 'utf-8-validate'],
    sourcemap: flags.has('--no-sourcemap') ? false : 'linked',
    sourcesContent: false,
    minify: flags.has('--minify'),
    legalComments: 'none',
    logLevel: 'warning',
  });
  if (result.errors.length > 0) process.exit(1);
} catch {
  // esbuild already printed the diagnostics.
  console.error('✖ Build failed · derleme başarısız');
  process.exit(1);
}

await chmod(outfile, 0o755);
const { size } = await stat(outfile);
console.log(`✓ ${path.relative(repoRoot, outfile)}  ${Math.round(size / 1024)} KB  (${Date.now() - started} ms)`);
if (!existsSync(path.join(repoRoot, 'dist', 'ui', 'index.html'))) {
  console.log('  note: dist/ui is missing — the server will show a placeholder page. Build the UI too: npm run build -w @durbun/ui');
}
