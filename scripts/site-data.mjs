#!/usr/bin/env node
/**
 * The release facts the website shows (version, date, minimum macOS, the DMG files with their addresses, sizes
 * and checksums) as one JSON file, so the site reads them instead of copying them by hand at every release:
 *
 *   node scripts/site-data.mjs --dir apps/desktop/release --out <site>/assets/durbun/release.json
 *   node scripts/site-data.mjs --sums SHA256SUMS.txt --size arm64=118868277 --size x64=126099462 --date 2026-11-12
 *
 * - The version is the one every part carries (scripts/check-versions.mjs); it stops when they differ.
 * - `--dir` reads the two DMGs of that version (`Durbun-<version>-arm64.dmg`, `Durbun-<version>-x64.dmg`):
 *   their sizes, and their SHA-256 computed from the files. When the folder (or `--sums`) has a
 *   `SHA256SUMS.txt`, every DMG must be in it with the same checksum.
 * - Without `--dir`, `--size arm64=<bytes> --size x64=<bytes>` give the sizes and `--sums` the checksums
 *   (optional: without it the file has no `sha256`).
 * - `--date YYYY-MM-DD` is the day the release was published on GitHub; it defaults to today (UTC).
 * - The minimum macOS is apps/desktop's `minimumSystemVersion`.
 * - `--out <file>` writes the JSON there; without it, it is printed.
 *
 * It reads only local files: nothing is downloaded or uploaded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCES, checkVersions } from './check-versions.mjs';

const REPO_URL = 'https://github.com/mykynk/durbun';
export const ARCHS = ['arm64', 'x64'];
const SUMS_FILE = 'SHA256SUMS.txt';
const BUILDER_CONFIG = 'apps/desktop/electron-builder.config.cjs';

/** The DMG electron-builder names for a version and architecture. */
export const dmgName = (version, arch) => `Durbun-${version}-${arch}.dmg`;

/** `shasum -a 256` output as a Map of file name -> lowercase hex checksum. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(path.basename(m[2].trim()), m[1].toLowerCase());
  }
  return sums;
}

/** apps/desktop's `minimumSystemVersion` without trailing zeros ('13.0' -> "13", '13.5.0' -> "13.5"), or undefined. */
export function minMacos(configText) {
  const m = /minimumSystemVersion:\s*['"](\d+(?:\.\d+)*)['"]/.exec(configText);
  return m ? m[1].replace(/(\.0)+$/, '') : undefined;
}

/** True for a real calendar day written as YYYY-MM-DD. */
export function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text ?? '')) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/** Today in UTC, as YYYY-MM-DD (GitHub shows release dates in UTC). */
export const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * The site's data: `files` is `{ arm64: { bytes, sha256? }, x64: { … } }`. Keys stay in this order, so the same
 * release always gives the same file.
 */
export function siteData({ version, date, minMacos: macos, files }) {
  const assets = `${REPO_URL}/releases/download/v${version}`;
  const dmg = {};
  for (const arch of ARCHS) {
    const file = dmgName(version, arch);
    dmg[arch] = { file, url: `${assets}/${file}`, bytes: files[arch].bytes };
    if (files[arch].sha256) dmg[arch].sha256 = files[arch].sha256;
  }
  return {
    generatedBy: `scripts/site-data.mjs in ${REPO_URL}; do not edit by hand`,
    version,
    date,
    minMacos: macos,
    releaseUrl: `${REPO_URL}/releases/tag/v${version}`,
    checksumsUrl: `${assets}/${SUMS_FILE}`,
    dmg,
  };
}

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Sizes and checksums of the version's DMGs in `dir`. `sums` (a parseSums Map, optional) must list each DMG with
 * the same checksum. Returns `{ files }` or `{ error }`.
 */
export function filesFromDir(dir, version, sums) {
  const files = {};
  for (const arch of ARCHS) {
    const name = dmgName(version, arch);
    const file = path.join(dir, name);
    if (!existsSync(file)) return { error: `✖ ${file} is missing. Build the release first (npm run app:release).` };
    const sha256 = sha256Of(file);
    if (sums) {
      if (!sums.has(name)) return { error: `✖ ${SUMS_FILE} has no line for ${name}. Write the checksums again after the DMGs are stapled.` };
      if (sums.get(name) !== sha256) return { error: `✖ ${name} does not match its line in ${SUMS_FILE}: the file changed after the checksums were written. Write them again.` };
    }
    files[arch] = { bytes: statSync(file).size, sha256 };
  }
  return { files };
}

/** `--name value` options; `--size` may repeat. Returns `{ opts }` or `{ error }`. */
export function parseArgs(argv) {
  const opts = { sizes: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (!['--dir', '--sums', '--size', '--date', '--out'].includes(arg)) return { error: `✖ Unknown option "${arg}".` };
    if (value === undefined || value.startsWith('--')) return { error: `✖ ${arg} needs a value.` };
    i++;
    if (arg === '--size') {
      const m = /^(arm64|x64)=(\d+)$/.exec(value);
      if (!m || Number(m[2]) <= 0) return { error: `✖ --size needs arm64=<bytes> or x64=<bytes>, got "${value}".` };
      opts.sizes[m[1]] = Number(m[2]);
    } else opts[arg.slice(2)] = value;
  }
  return { opts };
}

const USAGE = [
  'Usage: node scripts/site-data.mjs --dir <release folder> [--date YYYY-MM-DD] [--out <file>]',
  '       node scripts/site-data.mjs --size arm64=<bytes> --size x64=<bytes> [--sums SHA256SUMS.txt] [--date YYYY-MM-DD] [--out <file>]',
].join('\n');

/** Returns `{ code, out?, err? }`; with `--out` the file is written and `out` says where. */
export function main(argv, root, { cwd = process.cwd(), today = utcDate() } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { code: 2, err: `${parsed.error}\n${USAGE}` };
  const { opts } = parsed;
  const resolve = (p) => path.resolve(cwd, p);

  const check = checkVersions(root, SOURCES);
  if (check.results.some((r) => !r.ok) || !check.expected) {
    return { code: 1, err: '✖ The parts of Dürbün do not carry the same version: run node scripts/check-versions.mjs and fix it first.' };
  }
  const version = check.expected;

  const date = opts.date ?? today;
  if (!isDate(date)) return { code: 2, err: `✖ --date needs a day like 2026-11-12, got "${date}".` };

  let config;
  try {
    config = readFileSync(path.join(root, BUILDER_CONFIG), 'utf8');
  } catch {
    config = '';
  }
  const macos = minMacos(config);
  if (!macos) return { code: 1, err: `✖ ${BUILDER_CONFIG} has no minimumSystemVersion.` };

  let sums;
  const sumsPath = opts.sums ? resolve(opts.sums) : opts.dir && existsSync(path.join(resolve(opts.dir), SUMS_FILE)) ? path.join(resolve(opts.dir), SUMS_FILE) : undefined;
  if (sumsPath) {
    try {
      sums = parseSums(readFileSync(sumsPath, 'utf8'));
    } catch {
      return { code: 1, err: `✖ Cannot read ${sumsPath}.` };
    }
  }

  let files;
  if (opts.dir) {
    if (Object.keys(opts.sizes).length) return { code: 2, err: `✖ --dir reads the sizes from the files: leave out --size.\n${USAGE}` };
    const fromDir = filesFromDir(resolve(opts.dir), version, sums);
    if (fromDir.error) return { code: 1, err: fromDir.error };
    files = fromDir.files;
  } else {
    const missing = ARCHS.filter((arch) => !opts.sizes[arch]);
    if (missing.length) return { code: 2, err: `✖ Give the folder with the DMGs (--dir) or both sizes (missing: ${missing.map((a) => `--size ${a}=<bytes>`).join(', ')}).\n${USAGE}` };
    files = {};
    for (const arch of ARCHS) {
      files[arch] = { bytes: opts.sizes[arch] };
      if (sums) {
        const name = dmgName(version, arch);
        if (!sums.has(name)) return { code: 1, err: `✖ ${sumsPath} has no line for ${name}.` };
        files[arch].sha256 = sums.get(name);
      }
    }
  }

  const json = JSON.stringify(siteData({ version, date, minMacos: macos, files }), null, 2) + '\n';
  if (!opts.out) return { code: 0, out: json.trimEnd() };
  writeFileSync(resolve(opts.out), json);
  return { code: 0, out: `Wrote the site data of ${version} (${date}) to ${resolve(opts.out)}.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = main(process.argv.slice(2), root);
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  process.exit(r.code);
}
