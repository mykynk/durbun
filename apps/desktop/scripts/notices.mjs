/**
 * THIRD_PARTY_NOTICES.txt for the app bundle: the license text of every npm package that ends up in the
 * server and UI bundles (the root lockfile's non-dev packages, workspaces left out). Electron's own
 * LICENSE and Chromium's LICENSES.chromium.html are copied into the bundle by electron-builder.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i;

/** [{ name, version, license, text }] sorted by name; `text` is undefined when no license file exists. */
export function thirdPartyPackages(repoRoot) {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const seen = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || entry.dev || entry.devOptional || entry.link) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (name.startsWith('@durbun/') || seen.has(`${name}@${entry.version}`)) continue;
    const dir = path.join(repoRoot, key);
    const file = existsSync(dir) ? readdirSync(dir).find((f) => LICENSE_FILE.test(f)) : undefined;
    seen.set(`${name}@${entry.version}`, {
      name,
      version: entry.version,
      license: entry.license ?? 'see package',
      text: file ? readFileSync(path.join(dir, file), 'utf8').trim() : undefined,
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function noticesText(packages) {
  const parts = [
    'Dürbün includes the following third-party software. Electron and Chromium license texts are in',
    'LICENSE.electron.txt and LICENSES.chromium.html next to this folder.',
  ];
  for (const p of packages) {
    parts.push('', '='.repeat(78), `${p.name} ${p.version} (${p.license})`, '='.repeat(78), '', p.text ?? `License: ${p.license} (no license file shipped with the package).`);
  }
  return parts.join('\n') + '\n';
}
