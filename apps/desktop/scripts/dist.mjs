#!/usr/bin/env node
/** `npm run app:dist`: Dürbün.app + .dmg (arm64, unsigned/ad-hoc) in apps/desktop/release/. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { missingFromAsar } from './asarCheck.mjs';
import { appDir, buildApp, ensureBundles, ensureDeps, run } from './prepare.mjs';

ensureDeps();
ensureBundles();
buildApp();
run(path.join(appDir, 'node_modules', '.bin', 'electron-builder'), ['--config', 'electron-builder.config.cjs', '--mac', '--arm64', '--publish', 'never'], appDir);

const release = path.join(appDir, 'release');
if (existsSync(release)) {
  for (const name of readdirSync(release)) {
    if (name.endsWith('.dmg')) console.log(`✓ ${path.join('apps/desktop/release', name)}  ${(statSync(path.join(release, name)).size / 1048576).toFixed(1)} MB`);
  }
  // productName is NFD (electron-builder.config.cjs); APFS finds the folder by either form.
  const app = path.join(release, 'mac-arm64', 'Dürbün.app');
  if (!existsSync(app)) {
    console.error(`✖ ${app} was not produced · uygulama paketi oluşmadı`);
    process.exit(1);
  }
  {
    const missing = missingFromAsar(path.join(app, 'Contents', 'Resources', 'app.asar'));
    if (missing.length > 0) {
      console.error(`✖ app.asar is missing ${missing.join(', ')} · app.asar içinde eksik: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log(`✓ ${path.relative(path.resolve(appDir, '..', '..'), app)}  (server + UI inside app.asar)`);
  }
}
