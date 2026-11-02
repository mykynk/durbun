/**
 * Shared steps for `npm run app` / `npm run app:dist`: install this folder's own dependencies on first
 * use (Electron is kept out of the root workspaces so a plain `npm install` never downloads it) and
 * build the server + UI bundles when they are missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(appDir, '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✖ ${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

export function ensureDeps() {
  if (existsSync(path.join(appDir, 'node_modules', 'electron', 'package.json')) && existsSync(path.join(appDir, 'node_modules', 'electron-builder', 'package.json'))) return;
  console.log('◉◉ Masaüstü bağımlılıkları kuruluyor (bir kez) · installing desktop dependencies (once)…');
  run(npm, ['install', '--no-audit', '--no-fund'], appDir);
}

export function ensureBundles() {
  const server = path.join(repoRoot, 'dist', 'server.mjs');
  const ui = path.join(repoRoot, 'dist', 'ui', 'index.html');
  if (existsSync(server) && existsSync(ui)) return;
  console.log('◉◉ Sunucu ve arayüz derleniyor · building server + UI (npm run build)…');
  run(npm, ['run', 'build'], repoRoot);
}

export function buildApp() {
  run(process.execPath, [path.join(appDir, 'scripts', 'build.mjs')], appDir);
}
