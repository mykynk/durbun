#!/usr/bin/env node
/**
 * Bundle the server into <repo>/dist — ESM for Node 20+, with a createRequire shim for the CommonJS
 * dependencies (ws, plist). The optional native ws add-ons (bufferutil, utf-8-validate) stay external;
 * ws falls back to its JS implementation.
 *
 *   dist/durbun.mjs  entry src/cli.ts     the `durbun` command (shebang, runs the CLI when executed)
 *   dist/server.mjs  entry src/server.ts  programmatic entry for embedding (the Mac app): exports
 *                                         startServer, startServerWith, ServerStartError, … — no CLI,
 *                                         no side effects on import
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
const flags = new Set(process.argv.slice(2));

const requireShim = [
  "import { createRequire as __durbunCreateRequire } from 'node:module';",
  'const require = __durbunCreateRequire(import.meta.url);',
];

const targets = [
  { entry: 'cli.ts', outfile: path.join(repoRoot, 'dist', 'durbun.mjs'), banner: ['#!/usr/bin/env node', ...requireShim], executable: true },
  { entry: 'server.ts', outfile: path.join(repoRoot, 'dist', 'server.mjs'), banner: requireShim, executable: false },
];

const started = Date.now();
try {
  const results = await Promise.all(
    targets.map((t) =>
      build({
        absWorkingDir: repoRoot,
        entryPoints: [path.join(serverDir, 'src', t.entry)],
        outfile: t.outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        banner: { js: t.banner.join('\n') },
        external: ['bufferutil', 'utf-8-validate'],
        sourcemap: flags.has('--no-sourcemap') ? false : 'linked',
        sourcesContent: false,
        minify: flags.has('--minify'),
        legalComments: 'none',
        logLevel: 'warning',
      }),
    ),
  );
  if (results.some((r) => r.errors.length > 0)) process.exit(1);
} catch {
  // esbuild already printed the diagnostics.
  console.error('✖ Build failed · derleme başarısız');
  process.exit(1);
}

const elapsed = Date.now() - started;
for (const t of targets) {
  if (t.executable) await chmod(t.outfile, 0o755);
  const { size } = await stat(t.outfile);
  console.log(`✓ ${path.relative(repoRoot, t.outfile)}  ${Math.round(size / 1024)} KB  (${elapsed} ms)`);
}
if (!existsSync(path.join(repoRoot, 'dist', 'ui', 'index.html'))) {
  console.log('  note: dist/ui is missing — the server will show a placeholder page. Build the UI too: npm run build -w @durbun/ui');
}
