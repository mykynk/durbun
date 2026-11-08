#!/usr/bin/env node
/**
 * `npm run app:dist`: Dürbün.app + .dmg for this Mac (arm64) in apps/desktop/release/.
 * `npm run app:release` (`--release`): .dmg + .zip for Apple silicon and Intel, signed and notarized when
 * the signing environment is set (see electron-builder.config.cjs), ad-hoc signed otherwise.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { missingFromAsar } from './asarCheck.mjs';
import { appDir, buildApp, ensureBundles, ensureDeps, run } from './prepare.mjs';

const release = process.argv.includes('--release');

ensureDeps();
ensureBundles();
buildApp();
const targets = release ? ['--mac', 'dmg', 'zip', '--arm64', '--x64'] : ['--mac', 'dmg', '--arm64'];
run(path.join(appDir, 'node_modules', '.bin', 'electron-builder'), ['--config', 'electron-builder.config.cjs', ...targets, '--publish', 'never'], appDir);

const out = path.join(appDir, 'release');
if (existsSync(out)) {
  for (const name of readdirSync(out)) {
    if (name.endsWith('.dmg') || name.endsWith('.zip')) console.log(`✓ ${path.join('apps/desktop/release', name)}  ${(statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB`);
  }
  // productName is NFD (electron-builder.config.cjs); APFS finds the folder by either form.
  for (const folder of release ? ['mac-arm64', 'mac'] : ['mac-arm64']) {
    const app = path.join(out, folder, 'Dürbün.app');
    if (!existsSync(app)) {
      console.error(`✖ ${app} was not produced · uygulama paketi oluşmadı`);
      process.exit(1);
    }
    const missing = missingFromAsar(path.join(app, 'Contents', 'Resources', 'app.asar'));
    if (missing.length > 0) {
      console.error(`✖ app.asar is missing ${missing.join(', ')} · app.asar içinde eksik: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log(`✓ ${path.relative(path.resolve(appDir, '..', '..'), app)}  (server + UI inside app.asar)`);
  }
}
