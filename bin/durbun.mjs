#!/usr/bin/env node
// Dürbün launcher: runs the bundled server in ../dist/durbun.mjs (built by `npm run build`).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const major = Number.parseInt(process.versions.node, 10);
if (major < 20) {
  console.error(`Dürbün Node.js 20+ gerektirir · Dürbün needs Node.js 20 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const bundle = new URL('../dist/durbun.mjs', import.meta.url);
if (!existsSync(fileURLToPath(bundle))) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  console.error(
    [
      'Dürbün henüz derlenmemiş · Dürbün is not built yet.',
      '',
      `  cd "${repo}"`,
      '  npm run build          # arayüz + sunucu → dist/  ·  UI + server → dist/',
      '',
      'Geliştirme modu · development mode:  npm run dev',
    ].join('\n'),
  );
  process.exit(1);
}

process.setSourceMapsEnabled?.(true);
const { runCli } = await import(bundle.href);
await runCli(process.argv.slice(2));
