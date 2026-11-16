#!/usr/bin/env node
/**
 * The Homebrew cask of a release (`Casks/durbun.rb` in the tap repository mykynk/homebrew-tap), so people can run
 * `brew install --cask mykynk/tap/durbun`. It is written from the same facts as the website's data
 * (scripts/site-data.mjs), never by hand:
 *
 *   node scripts/homebrew-cask.mjs --dir apps/desktop/release --out <tap>/Casks/durbun.rb
 *   node scripts/homebrew-cask.mjs --sums SHA256SUMS.txt
 *
 * - The version is the one every part carries (scripts/check-versions.mjs); it stops when they differ.
 * - `--dir` hashes the two DMGs of that version and checks them against the folder's `SHA256SUMS.txt` when there
 *   is one; `--sums` takes the checksums from that file alone (the published release's). A cask needs both.
 * - From apps/desktop: the minimum macOS (`minimumSystemVersion`), the bundle name inside the DMG (`productName`,
 *   NFD on purpose: see electron-builder.config.cjs), the bundle id (`appId`) and the name Electron gives the
 *   app's own data folder (package.json `productName`). Dürbün updates itself (Squirrel.Mac), so the cask says
 *   `auto_updates true` and Homebrew leaves updating to the app.
 * - `--out <file>` writes the cask there; without it, it is printed.
 *
 * It reads only local files: nothing is downloaded, uploaded or run through `brew`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCES, checkVersions } from './check-versions.mjs';
import { ARCHS, dmgName, filesFromDir, minMacos, parseSums } from './site-data.mjs';

const REPO = 'github.com/mykynk/durbun';
const HOMEPAGE = 'https://appnify.dev/durbun/';
const DESC = 'Live logs, network traffic and performance for Android and iOS apps';
const BUILDER_CONFIG = 'apps/desktop/electron-builder.config.cjs';
const DESKTOP_PACKAGE = 'apps/desktop/package.json';
const SUMS_FILE = 'SHA256SUMS.txt';
/** The data folder the app and the CLI share (apps/desktop/src/main.ts; DURBUN_DATA_DIR only moves it by hand). */
const DATA_DIR = '~/.durbun';

/** Homebrew's names for the macOS majors it knows (`depends_on macos: ">= :ventura"`). */
export const MACOS_NAMES = { 11: 'big_sur', 12: 'monterey', 13: 'ventura', 14: 'sonoma', 15: 'sequoia', 26: 'tahoe' };

/** "13" or "13.5" → ":ventura" (Homebrew compares majors); undefined for a major it has no name for. */
export function macosSymbol(version) {
  const major = Number(String(version ?? '').split('.')[0]);
  const name = MACOS_NAMES[major];
  return name ? `:${name}` : undefined;
}

/**
 * A Ruby double-quoted string. Characters outside ASCII are written as `\uXXXX` when `escape` is set, so a
 * reader sees which form a name is in (NFD and NFC look the same on screen).
 */
export function rubyString(text, { escape = false } = {}) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (ch === '#') out += '\\#';
    else if (escape && code > 0x7e) out += code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

/**
 * The cask. `facts`: `{ version, minMacos, sha256: { arm64, x64 }, appName, appId, dataName }`.
 * `appName` is the bundle's name without `.app`, exactly as in the DMG; `dataName` is the name of
 * ~/Library/Application Support/<dataName> (Electron's userData).
 */
export function caskText({ version, minMacos: macos, sha256, appName, appId, dataName }) {
  const symbol = macosSymbol(macos);
  if (!symbol) throw new Error(`Homebrew has no name for macOS ${macos}: add it to MACOS_NAMES.`);
  const nfd = appName !== appName.normalize('NFC');
  return [
    `# Written by scripts/homebrew-cask.mjs in https://${REPO} for Dürbün ${version}; do not edit by hand.`,
    'cask "durbun" do',
    `  arch arm: "${ARCHS[0]}", intel: "${ARCHS[1]}"`,
    '',
    `  version "${version}"`,
    `  sha256 arm:   "${sha256.arm64}",`,
    `         intel: "${sha256.x64}"`,
    '',
    `  url "https://${REPO}/releases/download/v#{version}/${dmgName('#{version}', '#{arch}')}",`,
    `      verified: "${REPO}/"`,
    `  name ${rubyString(appName.normalize('NFC'))}`,
    `  desc ${rubyString(DESC)}`,
    `  homepage ${rubyString(HOMEPAGE)}`,
    '',
    '  livecheck do',
    '    url :url',
    '    strategy :github_latest',
    '  end',
    '',
    '  # The app updates itself (Check for Updates…): Homebrew leaves updating to it.',
    '  auto_updates true',
    `  depends_on macos: ">= ${symbol}"`,
    '',
    ...(nfd ? ['  # The bundle name is NFD (u + U+0308), exactly as electron-builder writes it into the DMG.'] : []),
    `  app ${rubyString(`${appName}.app`, { escape: nfd })}`,
    '',
    `  uninstall quit: ${rubyString(appId)}`,
    '',
    '  zap trash: [',
    `    ${rubyString(DATA_DIR)},`,
    `    ${rubyString(`~/Library/Application Support/${dataName}`)},`,
    `    ${rubyString(`~/Library/Caches/${appId}.ShipIt`)},`,
    `    ${rubyString(`~/Library/Preferences/${appId}.plist`)},`,
    '  ]',
    'end',
    '',
  ].join('\n');
}

/** Bundle name, bundle id and data folder name from apps/desktop. Returns `{ app }` or `{ error }`. */
export function desktopFacts(root) {
  try {
    const config = createRequire(import.meta.url)(path.join(root, BUILDER_CONFIG));
    const pkg = JSON.parse(readFileSync(path.join(root, DESKTOP_PACKAGE), 'utf8'));
    if (typeof config.productName !== 'string' || !config.productName) return { error: `✖ ${BUILDER_CONFIG} has no productName.` };
    if (typeof config.appId !== 'string' || !config.appId) return { error: `✖ ${BUILDER_CONFIG} has no appId.` };
    // Electron names ~/Library/Application Support/<name> after package.json's productName (or name).
    const dataName = typeof pkg.productName === 'string' && pkg.productName ? pkg.productName : pkg.name;
    return { app: { appName: config.productName, appId: config.appId, dataName } };
  } catch (err) {
    return { error: `✖ Cannot read apps/desktop's configuration: ${err.message}` };
  }
}

/** `--dir`, `--sums`, `--out`. Returns `{ opts }` or `{ error }`. */
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (!['--dir', '--sums', '--out'].includes(arg)) return { error: `✖ Unknown option "${arg}".` };
    if (value === undefined || value.startsWith('--')) return { error: `✖ ${arg} needs a value.` };
    opts[arg.slice(2)] = value;
    i++;
  }
  return { opts };
}

const USAGE = [
  'Usage: node scripts/homebrew-cask.mjs --dir <release folder> [--out <tap>/Casks/durbun.rb]',
  '       node scripts/homebrew-cask.mjs --sums SHA256SUMS.txt [--out <tap>/Casks/durbun.rb]',
].join('\n');

/** Returns `{ code, out?, err? }`; with `--out` the file is written and `out` says where. */
export function main(argv, root, { cwd = process.cwd() } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { code: 2, err: `${parsed.error}\n${USAGE}` };
  const { opts } = parsed;
  if (!opts.dir && !opts.sums) return { code: 2, err: `✖ A cask needs the checksums: give the folder with the DMGs (--dir) or ${SUMS_FILE} (--sums).\n${USAGE}` };
  const resolve = (p) => path.resolve(cwd, p);

  const check = checkVersions(root, SOURCES);
  if (check.results.some((r) => !r.ok) || !check.expected) {
    return { code: 1, err: '✖ The parts of Dürbün do not carry the same version: run node scripts/check-versions.mjs and fix it first.' };
  }
  const version = check.expected;

  let configText = '';
  try {
    configText = readFileSync(path.join(root, BUILDER_CONFIG), 'utf8');
  } catch {
    /* reported below */
  }
  const macos = minMacos(configText);
  if (!macos) return { code: 1, err: `✖ ${BUILDER_CONFIG} has no minimumSystemVersion.` };
  const desktop = desktopFacts(root);
  if (desktop.error) return { code: 1, err: desktop.error };

  let sums;
  const sumsPath = opts.sums ? resolve(opts.sums) : undefined;
  if (sumsPath) {
    try {
      sums = parseSums(readFileSync(sumsPath, 'utf8'));
    } catch {
      return { code: 1, err: `✖ Cannot read ${sumsPath}.` };
    }
  }

  const sha256 = {};
  if (opts.dir) {
    const dir = resolve(opts.dir);
    if (!sums) {
      try {
        sums = parseSums(readFileSync(path.join(dir, SUMS_FILE), 'utf8'));
      } catch {
        sums = undefined;
      }
    }
    const fromDir = filesFromDir(dir, version, sums);
    if (fromDir.error) return { code: 1, err: fromDir.error };
    for (const arch of ARCHS) sha256[arch] = fromDir.files[arch].sha256;
  } else {
    for (const arch of ARCHS) {
      const name = dmgName(version, arch);
      if (!sums.has(name)) return { code: 1, err: `✖ ${sumsPath} has no line for ${name}.` };
      sha256[arch] = sums.get(name);
    }
  }

  let text;
  try {
    text = caskText({ version, minMacos: macos, sha256, ...desktop.app });
  } catch (err) {
    return { code: 1, err: `✖ ${err.message}` };
  }
  if (!opts.out) return { code: 0, out: text.trimEnd() };
  writeFileSync(resolve(opts.out), text);
  return { code: 0, out: `Wrote the Homebrew cask of ${version} to ${resolve(opts.out)}. Commit it to Casks/durbun.rb in mykynk/homebrew-tap.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = main(process.argv.slice(2), root);
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  process.exit(r.code);
}
