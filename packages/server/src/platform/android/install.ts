/**
 * Android installs beyond a single .apk, and what the package manager's refusals mean.
 *
 *   .apk   adb install -r -t -d <file>
 *   .apks  bundletool build-apks output (a zip): universal.apk, or splits/<module>-<config>.apk
 *          (master, ABI, screen density, language) and standalones/ for Android 4.x. The splits that fit the
 *          phone (`getprop ro.product.cpu.abilist`, `wm density`) go to one `adb install-multiple`.
 *   .xapk  a zip with <package>.apk, config.<abi|density|language>.apk splits and Android/obb/<package>/*.obb;
 *          the same split choice, the OBB files are copied to /sdcard/Android/obb/<package>/.
 * The archive layouts follow bundletool's documentation and common .xapk files; the refusal reasons are the
 * package manager's INSTALL_FAILED_* / INSTALL_PARSE_FAILED_* names.
 */
import fs from 'node:fs';
import path from 'node:path';

export type AndroidPackageKind = 'apk' | 'apks' | 'xapk';

export function androidPackageKind(file: string): AndroidPackageKind | undefined {
  const m = /\.(apk|apks|xapk)$/i.exec(file);
  return m ? (m[1]!.toLowerCase() as AndroidPackageKind) : undefined;
}

export interface DeviceSpec {
  /** Supported ABIs, preferred first ("arm64-v8a", "armeabi-v7a"…). */
  abis: string[];
  /** Screen density in dpi (an override set with `wm density` wins). */
  density?: number;
}

/** Output of `getprop ro.product.cpu.abilist; wm density`. */
export function parseDeviceSpec(text: string): DeviceSpec {
  const lines = text.split('\n').map((l) => l.trim());
  const abiLine = lines.find((l) => /^[a-z0-9_-]+(,[a-z0-9_-]+)*$/i.test(l) && /arm|x86|mips/i.test(l));
  const abis = abiLine ? abiLine.split(',').filter(Boolean) : [];
  const override = /Override density:\s*(\d+)/i.exec(text)?.[1];
  const physical = /Physical density:\s*(\d+)/i.exec(text)?.[1];
  const density = Number(override ?? physical);
  return { abis, ...(Number.isFinite(density) && density > 0 ? { density } : {}) };
}

const ABI_SPLITS = new Set(['armeabi', 'armeabi_v7a', 'arm64_v8a', 'x86', 'x86_64', 'mips', 'mips64']);
const DENSITY_SPLITS: Record<string, number> = { ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640 };

type SplitConfig = { kind: 'master' } | { kind: 'abi'; abi: string } | { kind: 'density'; dpi: number } | { kind: 'other' };

function classify(config: string | undefined): SplitConfig {
  if (config === undefined || config === 'master') return { kind: 'master' };
  if (ABI_SPLITS.has(config)) return { kind: 'abi', abi: config };
  const dpi = DENSITY_SPLITS[config];
  if (dpi !== undefined) return { kind: 'density', dpi };
  // Languages ("tr", "en") and anything else (texture formats…) are installed as they are.
  return { kind: 'other' };
}

export type SplitChoice = { apks: string[]; obb: string[] } | { error: 'noMatchingAbis'; available: string[] } | { error: 'empty' };

/**
 * The APKs of an unpacked .apks / .xapk (paths relative to its folder, "/"-separated) that fit the phone, and
 * the OBB files of an .xapk. One ABI split (the phone's most preferred one on offer) and one density split
 * (the smallest bucket at or above the screen's density, else the largest) per module.
 */
export function chooseSplits(files: readonly string[], kind: 'apks' | 'xapk', spec: DeviceSpec, apiLevel?: number): SplitChoice {
  const apkFiles = files.filter((f) => /\.apk$/i.test(f));
  const obb = kind === 'xapk' ? files.filter((f) => /^Android\/obb\/[^/]+\/[^/]+\.obb$/i.test(f)) : [];
  if (kind === 'apks') {
    const universal = apkFiles.find((f) => f === 'universal.apk');
    if (universal) return { apks: [universal], obb };
  }
  let splits: Array<{ file: string; module: string; config: SplitConfig }>;
  if (kind === 'apks') {
    const inSplits = apkFiles.filter((f) => f.startsWith('splits/'));
    const standalones = apkFiles.filter((f) => f.startsWith('standalones/'));
    // Split APKs need Android 5 (API 21); older phones take one standalone APK.
    if (!inSplits.length || (apiLevel !== undefined && apiLevel < 21 && standalones.length)) {
      if (!standalones.length) return { error: 'empty' };
      const abi = spec.abis.map((a) => a.replace(/-/g, '_')).find((a) => standalones.some((s) => s.includes(`-${a}`)));
      return { apks: [standalones.find((s) => abi && s.includes(`-${abi}`)) ?? standalones[0]!], obb };
    }
    splits = inSplits.map((file) => {
      const base = path.posix.basename(file, '.apk');
      const dash = base.indexOf('-');
      const module = dash === -1 ? base : base.slice(0, dash);
      return { file, module, config: classify(dash === -1 ? undefined : base.slice(dash + 1)) };
    });
  } else {
    splits = apkFiles
      .filter((f) => !f.includes('/'))
      .map((file) => {
        const base = path.posix.basename(file, '.apk');
        const m = /^(?:(.+)\.)?config\.(.+)$/.exec(base);
        return m ? { file, module: m[1] ?? 'base', config: classify(m[2]) } : { file, module: base, config: { kind: 'master' } as SplitConfig };
      });
  }
  if (!splits.length) return { error: 'empty' };
  const abiPrefs = spec.abis.map((a) => a.replace(/-/g, '_'));
  const offeredAbis = [...new Set(splits.flatMap((s) => (s.config.kind === 'abi' ? [s.config.abi] : [])))];
  const abi = abiPrefs.find((a) => offeredAbis.includes(a));
  if (offeredAbis.length && !abi && abiPrefs.length) return { error: 'noMatchingAbis', available: offeredAbis.map((a) => a.replace(/_/g, '-')) };
  const offeredDpis = [...new Set(splits.flatMap((s) => (s.config.kind === 'density' ? [s.config.dpi] : [])))].sort((a, b) => a - b);
  const want = spec.density ?? 480;
  const dpi = offeredDpis.find((d) => d >= want) ?? offeredDpis[offeredDpis.length - 1];
  // The base / master APKs first, the configuration splits after them.
  const ordered = [...splits.filter((s) => s.config.kind === 'master'), ...splits.filter((s) => s.config.kind !== 'master')];
  const apks = ordered
    .filter((s) => {
      if (s.config.kind === 'abi') return abi ? s.config.abi === abi : s === splits.find((x) => x.config.kind === 'abi' && x.module === s.module);
      if (s.config.kind === 'density') return s.config.dpi === dpi;
      return true;
    })
    .map((s) => s.file);
  return { apks, obb };
}

/** Every file under `root` as "/"-separated relative paths (an unpacked archive). */
export async function listFiles(root: string, depth = 6): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string, d: number): Promise<void> => {
    if (d > depth) return;
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), relPath, d + 1);
      else if (e.isFile()) out.push(relPath);
    }
  };
  await walk(root, '', 0);
  return out.sort();
}

/** What a package manager refusal means for the person installing (DeviceActionResult.code). */
const INSTALL_FAILURES: Array<[RegExp, string]> = [
  [/^INSTALL_FAILED_UPDATE_INCOMPATIBLE\b/, 'action.install.signatureMismatch'],
  [/^INSTALL_FAILED_VERSION_DOWNGRADE\b/, 'action.install.downgrade'],
  [/^INSTALL_FAILED_(USER_RESTRICTED|ABORTED)\b/, 'action.install.userRestricted'],
  [/^INSTALL_FAILED_INSUFFICIENT_STORAGE\b/, 'action.install.noSpace'],
  [/^INSTALL_FAILED_NO_MATCHING_ABIS\b/, 'action.install.noMatchingAbis'],
  [/^INSTALL_FAILED_OLDER_SDK\b/, 'action.install.olderSdk'],
  [/^INSTALL_FAILED_MISSING_SPLIT\b/, 'action.install.missingSplit'],
  [/^INSTALL_PARSE_FAILED_(NO_CERTIFICATES|INCONSISTENT_CERTIFICATES)\b/, 'action.install.notSigned'],
  [/^INSTALL_FAILED_VERIFICATION_FAILURE\b/, 'action.install.verificationFailed'],
];

/** "Failure [INSTALL_FAILED_X: details]" in adb's output → the reason and its code. */
export function installFailure(out: string): { reason?: string; code: string } {
  const reason = /Failure \[([^\]]+)\]/.exec(out)?.[1]?.trim();
  if (!reason) return { code: 'action.installFailed' };
  return { reason, code: INSTALL_FAILURES.find(([re]) => re.test(reason))?.[1] ?? 'action.installFailed' };
}
