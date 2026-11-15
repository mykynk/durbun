#!/usr/bin/env node
/**
 * `npm run app:dist`: Dürbün.app + .dmg for this Mac (arm64) in apps/desktop/release/.
 * `npm run app:release` (`--release`): .dmg + .zip for Apple silicon and Intel, Developer ID signed and
 * notarized (see electron-builder.config.cjs). It stops before building when the signing environment is
 * incomplete, unless an ad-hoc build is asked for with `--allow-unsigned` / DURBUN_ALLOW_UNSIGNED=1
 * (releaseSigning.mjs), and verifies the signatures of what it built. A release build first removes the
 * DMG, ZIP, feed and checksum files of earlier builds from release/ (never the app folders: the local app
 * runs from release/mac-arm64), and ends with the in-app update feeds (updateFeed.mjs).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { missingFromAsar } from './asarCheck.mjs';
import { appDir, buildApp, ensureBundles, ensureDeps, repoRoot, run } from './prepare.mjs';
import { dmgFollowUp, releaseGate, runVerification, verificationSteps } from './releaseSigning.mjs';
import { isStaleReleaseFile, writeFeeds } from './updateFeed.mjs';

const release = process.argv.includes('--release');
const gate = release ? releaseGate(process.env, process.argv.slice(2)) : undefined;
if (gate) {
  for (const line of gate.lines) (gate.proceed ? console.log : console.error)(line);
  if (!gate.proceed) process.exit(1);
}

const out = path.join(appDir, 'release');
if (release && existsSync(out)) {
  for (const name of readdirSync(out)) {
    if (isStaleReleaseFile(name)) rmSync(path.join(out, name), { force: true });
  }
}

ensureDeps();
ensureBundles();
buildApp();
const targets = release ? ['--mac', 'dmg', 'zip', '--arm64', '--x64'] : ['--mac', 'dmg', '--arm64'];
run(path.join(appDir, 'node_modules', '.bin', 'electron-builder'), ['--config', 'electron-builder.config.cjs', ...targets, '--publish', 'never'], appDir);

const builtApps = [];
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
    builtApps.push(app);
  }
}

if (gate) {
  const failed = runVerification(verificationSteps(gate, builtApps));
  if (failed.length > 0) {
    console.error(`✖ Release verification failed: ${failed.join('; ')}`);
    process.exit(1);
  }
  try {
    const version = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
    for (const f of writeFeeds(out, { version, changelog: readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8') })) {
      console.log(`✓ ${path.relative(repoRoot, f)}  (in-app update feed)`);
    }
  } catch (err) {
    console.error(`✖ Update feeds: ${err.message}`);
    process.exit(1);
  }
  const dmgs = existsSync(out) ? readdirSync(out).filter((n) => n.endsWith('.dmg')) : [];
  const followUp = dmgFollowUp(gate, dmgs, process.env);
  if (followUp.length > 0) {
    console.log('\nThe apps are signed, notarized and stapled. Before uploading, sign, notarize and staple each DMG, then');
    console.log('write the checksums (stapling changes the files), in apps/desktop/release:');
    for (const line of followUp) console.log(`  ${line}`);
  }
}
