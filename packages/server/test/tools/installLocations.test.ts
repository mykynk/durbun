/**
 * Tool resolution for a Finder-launched app (the Mac app gets launchd's minimal PATH): adb and Flutter
 * are found in their well-known install folders without a shell profile. Every location is rebased into
 * a temp "home" and temp package-manager prefixes, so the real machine never leaks into the result.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFIXES,
  findFlutterRoots,
  flutterConfiguredAndroidSdk,
  pathDirs,
  resolveAdb,
  resolveIdeviceTool,
  type ResolveEnv,
} from '../../src/platform/tools';

function exe(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

function flutterSdk(root: string, version = '3.38.5'): string {
  exe(path.join(root, 'bin', 'flutter'));
  fs.mkdirSync(path.join(root, 'bin', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'version'), `${version}\n`);
  return root;
}

describe('well-known install locations (launchd PATH)', () => {
  let base: string;
  let home: string;
  let brew: string;
  let usrLocal: string;
  let renv: ResolveEnv;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-tools-')));
    home = path.join(base, 'home');
    brew = path.join(base, 'opt-homebrew');
    usrLocal = path.join(base, 'usr-local');
    fs.mkdirSync(home, { recursive: true });
    // launchd's PATH for apps started from Finder / the Dock.
    renv = { home, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, prefixes: [brew, usrLocal] };
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('keeps the Homebrew bin folders on the search path (Apple silicon first)', () => {
    expect(DEFAULT_PREFIXES).toEqual(['/opt/homebrew', '/usr/local']);
    expect(pathDirs({ PATH: '/usr/bin:/bin' })).toEqual(['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin']);
    expect(pathDirs({ PATH: '/usr/local/bin:/usr/bin' }, [brew, usrLocal])).toEqual(['/usr/local/bin', '/usr/bin', path.join(brew, 'bin'), path.join(usrLocal, 'bin')]);
  });

  it('finds adb from Homebrew android-commandlinetools, the platform-tools cask and ~/Android/Sdk', () => {
    expect(resolveAdb({}, renv)).toBeNull();

    const sdkHome = exe(path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'));
    expect(resolveAdb({}, renv)).toMatchObject({ path: sdkHome, source: 'sdk' });

    const cask = exe(path.join(usrLocal, 'Caskroom', 'android-platform-tools', '35.0.2', 'platform-tools', 'adb'));
    exe(path.join(usrLocal, 'Caskroom', 'android-platform-tools', '34.0.5', 'platform-tools', 'adb'));
    const fromCask = resolveAdb({}, renv)!;
    expect(fromCask).toMatchObject({ path: cask, source: 'sdk' });
    expect(fromCask.detail).toContain('android-platform-tools 35.0.2');

    const cmdline = exe(path.join(brew, 'share', 'android-commandlinetools', 'platform-tools', 'adb'));
    const fromBrew = resolveAdb({}, renv)!;
    expect(fromBrew).toMatchObject({ path: cmdline, source: 'sdk' });
    expect(fromBrew.detail).toContain('Homebrew android-commandlinetools');

    // Homebrew's bin (symlinked adb) is on the search path even when PATH lacks it → wins over the share folders.
    const brewBin = exe(path.join(brew, 'bin', 'adb'));
    expect(resolveAdb({}, renv)).toMatchObject({ path: brewBin, source: 'path' });

    // Android Studio's default SDK still comes before PATH.
    const studio = exe(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
    expect(resolveAdb({}, renv)).toMatchObject({ path: studio, source: 'sdk' });
  });

  it('honors `flutter config --android-sdk` before the default SDK folder', () => {
    exe(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
    const custom = exe(path.join(base, 'android-sdk-custom', 'platform-tools', 'adb'));
    fs.writeFileSync(path.join(home, '.flutter_settings'), JSON.stringify({ 'android-sdk': path.join(base, 'android-sdk-custom') }));
    expect(flutterConfiguredAndroidSdk(renv)).toBe(path.join(base, 'android-sdk-custom'));
    const r = resolveAdb({}, renv)!;
    expect(r).toMatchObject({ path: custom, source: 'sdk' });
    expect(r.detail).toContain('flutter config');
    // a broken settings file is ignored, never thrown
    fs.writeFileSync(path.join(home, '.flutter_settings'), '{not json');
    expect(flutterConfiguredAndroidSdk(renv)).toBeUndefined();
    expect(resolveAdb({}, renv)?.path).toBe(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
  });

  it('finds Flutter SDKs in fvm default, ~/development, Homebrew casks, asdf and FVM_CACHE_PATH', () => {
    expect(findFlutterRoots(renv)).toEqual([]);
    const caskRoot = flutterSdk(path.join(brew, 'Caskroom', 'flutter', '3.41.9', 'flutter'), '3.41.9');
    expect(findFlutterRoots(renv)).toEqual([caskRoot]);
    const dev = flutterSdk(path.join(home, 'development', 'flutter'));
    const asdf = flutterSdk(path.join(home, '.asdf', 'installs', 'flutter', '3.35.7-stable'));
    const fvmVersion = flutterSdk(path.join(home, 'fvm', 'versions', '3.47.8'), '3.47.8');
    fs.symlinkSync(fvmVersion, path.join(home, 'fvm', 'default'));
    const cache = flutterSdk(path.join(base, 'fvm-cache', 'versions', '3.50.0'), '3.50.0');
    renv.env.FVM_CACHE_PATH = path.join(base, 'fvm-cache');
    // fvm default (symlink, deduplicated with its version folder) → fvm versions → home folders → asdf → casks
    expect(findFlutterRoots(renv)).toEqual([fvmVersion, cache, dev, asdf, caskRoot]);

    // idevicesyslog from the Homebrew-cask Flutter cache, with its DYLD env
    renv.env.FVM_CACHE_PATH = '';
    fs.rmSync(path.join(home, 'fvm'), { recursive: true, force: true });
    fs.rmSync(dev, { recursive: true, force: true });
    fs.rmSync(path.join(home, '.asdf'), { recursive: true, force: true });
    const tool = exe(path.join(caskRoot, 'bin', 'cache', 'artifacts', 'libimobiledevice', 'idevicesyslog'));
    const r = resolveIdeviceTool('idevicesyslog', {}, renv)!;
    expect(r).toMatchObject({ path: tool, source: 'flutter-cache' });
    expect(r.detail).toContain('3.41.9');
    expect(r.env?.DYLD_LIBRARY_PATH).toContain(path.join(caskRoot, 'bin', 'cache', 'artifacts', 'libplist'));
  });

  it('stays fast: resolution only stats files (no child processes)', () => {
    exe(path.join(brew, 'share', 'android-commandlinetools', 'platform-tools', 'adb'));
    flutterSdk(path.join(home, 'fvm', 'versions', '3.47.8'));
    const started = performance.now();
    for (let i = 0; i < 50; i++) {
      resolveAdb({}, renv);
      resolveIdeviceTool('idevicesyslog', {}, renv);
    }
    expect((performance.now() - started) / 50).toBeLessThan(20);
  });
});
