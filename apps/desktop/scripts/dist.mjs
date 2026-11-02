#!/usr/bin/env node
/** `npm run app:dist`: Dürbün.app + .dmg (arm64, unsigned/ad-hoc) in apps/desktop/release/. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
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
  const app = path.join(release, 'mac-arm64', 'Dürbün.app');
  if (existsSync(app)) console.log(`✓ ${path.relative(path.resolve(appDir, '..', '..'), app)}`);
}
