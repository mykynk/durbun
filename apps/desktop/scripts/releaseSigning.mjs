#!/usr/bin/env node
/**
 * Signing rules for `npm run app:release` (scripts/dist.mjs --release).
 *
 * A release build must be Developer ID signed and notarized: without the signing environment
 * electron-builder.config.cjs falls back to an ad-hoc signature, and a downloaded ad-hoc app asks the user
 * to override Gatekeeper. So the release build stops before building anything when a variable is missing,
 * unless the ad-hoc build is asked for on purpose (`--allow-unsigned` or DURBUN_ALLOW_UNSIGNED=1).
 * `npm run app:dist` (the local app) is not affected.
 *
 * After the build, `verificationSteps` lists the checks run on the result (codesign, Gatekeeper, the
 * notarization ticket) and `dmgFollowUp` the steps electron-builder leaves for the DMGs (it notarizes the
 * app inside them, not the disk images themselves).
 *
 * Run directly (`node apps/desktop/scripts/releaseSigning.mjs [--allow-unsigned]`) it only applies the
 * gate: the root `app:release` script calls it before the server and UI build.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Either names the "Developer ID Application" certificate in the keychain or points to a .p12 file. */
export const IDENTITY_VARS = ['CSC_NAME', 'CSC_LINK'];

/** Notarization credentials electron-builder accepts; one complete set is needed. */
export const NOTARIZE_SETS = [
  { name: 'App Store Connect API key', vars: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] },
  { name: 'Apple ID', vars: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] },
];

export const ALLOW_UNSIGNED_FLAG = '--allow-unsigned';
export const ALLOW_UNSIGNED_ENV = 'DURBUN_ALLOW_UNSIGNED';

const has = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/**
 * What electron-builder.config.cjs will do with this environment (same rules), plus what is missing for a
 * signed and notarized build.
 */
export function signingState(env) {
  const signed = IDENTITY_VARS.some((v) => has(env, v));
  const complete = NOTARIZE_SETS.find((set) => set.vars.every((v) => has(env, v)));
  // The set the user seems to be filling in (most variables present; the API key on a tie).
  const closest = NOTARIZE_SETS.reduce((best, set) => (set.vars.filter((v) => has(env, v)).length > best.vars.filter((v) => has(env, v)).length ? set : best));
  const missing = [];
  if (!signed) missing.push(`${IDENTITY_VARS[0]} (or ${IDENTITY_VARS[1]})`);
  if (!complete) missing.push(...closest.vars.filter((v) => !has(env, v)));
  return {
    signed,
    notarize: signed && Boolean(complete),
    notarizeSet: complete ?? closest,
    missing,
  };
}

function allowUnsigned(env, argv) {
  return argv.includes(ALLOW_UNSIGNED_FLAG) || /^(1|true|yes)$/i.test(String(env[ALLOW_UNSIGNED_ENV] ?? '').trim());
}

/**
 * May the release build start? `{ proceed, signed, notarize, missing, lines }`; `lines` is what to print
 * (an error when it may not proceed, a warning for an ad-hoc build that was asked for).
 */
export function releaseGate(env, argv = []) {
  const state = signingState(env);
  if (state.signed && state.notarize) return { proceed: true, ...state, lines: [`✓ Signing: ${env.CSC_NAME || 'certificate from CSC_LINK'}; notarization: ${state.notarizeSet.name}`] };
  const otherSet = NOTARIZE_SETS.find((s) => s !== state.notarizeSet);
  if (allowUnsigned(env, argv)) {
    return {
      proceed: true,
      ...state,
      lines: [
        `⚠ Release build WITHOUT ${state.signed ? 'notarization' : 'a Developer ID signature or notarization'} (${ALLOW_UNSIGNED_FLAG} / ${ALLOW_UNSIGNED_ENV}).`,
        '  Do not publish these files: a downloaded copy asks the user to override Gatekeeper.',
        `  Missing: ${state.missing.join(', ')}`,
      ],
    };
  }
  return {
    proceed: false,
    ...state,
    lines: [
      '✖ app:release needs a Developer ID signature and notarization. Missing environment variables:',
      ...state.missing.map((v) => `    ${v}`),
      `  Notarization takes one complete set: ${state.notarizeSet.vars.join(' + ')}${otherSet ? `, or ${otherSet.vars.join(' + ')}` : ''}.`,
      `  For a deliberate ad-hoc test build: ${ALLOW_UNSIGNED_ENV}=1 npm run app:release`,
      '  (the local app is `npm run app:dist`, ad-hoc signed as before).',
    ],
  };
}

/**
 * Checks for the built apps: the signature always (ad-hoc signatures verify too), Gatekeeper and the
 * stapled ticket when notarized. Each is `{ label, cmd, args }` and must exit 0.
 */
export function verificationSteps(state, apps) {
  const steps = [];
  for (const app of apps) {
    steps.push({ label: `signature of ${app}`, cmd: 'codesign', args: ['--verify', '--deep', '--strict', '--verbose=2', app] });
    if (state.signed && state.notarize) {
      steps.push({ label: `Gatekeeper accepts ${app}`, cmd: 'spctl', args: ['--assess', '--type', 'execute', '-vv', app] });
      steps.push({ label: `notarization ticket stapled to ${app}`, cmd: 'xcrun', args: ['stapler', 'validate', app] });
    }
  }
  return steps;
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * electron-builder signs and notarizes the app inside the DMG, not the disk image. For a notarized build
 * these are the commands that remain for each DMG (credentials as environment variable names), followed by
 * the checksums, which must come last because stapling changes the files.
 */
export function dmgFollowUp(state, dmgs, env = {}) {
  if (!(state.signed && state.notarize) || dmgs.length === 0) return [];
  const auth = state.notarizeSet.vars[0] === 'APPLE_API_KEY'
    ? '--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"'
    : '--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"';
  // codesign matches the certificate's common name; CSC_NAME may leave out the "Developer ID Application: " part.
  const name = has(env, 'CSC_NAME') ? env.CSC_NAME.trim() : '';
  const identity = !name
    ? '"Developer ID Application: <name (TEAM ID)>"'
    : name.startsWith('Developer ID Application: ')
      ? '"$CSC_NAME"'
      : '"Developer ID Application: $CSC_NAME"';
  const lines = [];
  for (const dmg of dmgs) {
    const f = q(dmg);
    lines.push(
      `codesign --sign ${identity} --timestamp ${f}`,
      `xcrun notarytool submit ${f} ${auth} --wait`,
      `xcrun stapler staple ${f}`,
      `spctl --assess --type open --context context:primary-signature -v ${f}`,
      `xcrun stapler validate ${f}`,
    );
  }
  lines.push('shasum -a 256 *.dmg *.zip > SHA256SUMS.txt');
  return lines;
}

/** Runs the steps (`spawn` is injectable for tests); returns the labels that failed. */
export function runVerification(steps, spawn = spawnSync) {
  const failed = [];
  for (const step of steps) {
    let ok = false;
    try {
      const r = spawn(step.cmd, step.args, { stdio: 'inherit' });
      ok = r.status === 0;
    } catch {
      ok = false;
    }
    console.log(`${ok ? '✓' : '✖'} ${step.label}`);
    if (!ok) failed.push(step.label);
  }
  return failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const gate = releaseGate(process.env, process.argv.slice(2));
  for (const line of gate.lines) (gate.proceed ? console.log : console.error)(line);
  process.exit(gate.proceed ? 0 : 1);
}
