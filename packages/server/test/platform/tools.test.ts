import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultResolveEnv,
  envForArtifactsBinary,
  findFlutterRoots,
  flutterArtifactsEnv,
  resolveAdb,
  resolveIdeviceTool,
  type ResolveEnv,
} from '../../src/platform/tools';
import { run, StreamProcess, liveChildCount, killProcess } from '../../src/platform/exec';
import { LineSplitter, shellQuote, stripAnsi } from '../../src/platform/shared/text';
import { silentLogger } from '../../src/util/logger';
import { waitFor } from './helpers';

function exe(file: string, body = '#!/bin/sh\nexit 0\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('tool resolution', () => {
  let home: string;
  let renv: ResolveEnv;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-home-')));
    renv = { home, env: { PATH: path.join(home, 'bin') } };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('resolves adb in the documented order', () => {
    expect(resolveAdb({}, renv)).toBeNull();
    const onPath = exe(path.join(home, 'bin', 'adb'));
    expect(resolveAdb({}, renv)).toMatchObject({ path: onPath, source: 'path' });
    const sdk = exe(path.join(home, 'Library/Android/sdk/platform-tools/adb'));
    expect(resolveAdb({}, renv)).toMatchObject({ path: sdk, source: 'sdk' });
    const androidHome = exe(path.join(home, 'android-sdk/platform-tools/adb'));
    renv.env.ANDROID_HOME = path.join(home, 'android-sdk');
    expect(resolveAdb({}, renv)).toMatchObject({ path: androidHome, source: 'env' });
    const custom = exe(path.join(home, 'tools/my-adb'));
    expect(resolveAdb({ adbPath: custom }, renv)).toMatchObject({ path: custom, source: 'settings' });
    expect(resolveAdb({ adbPath: '~/tools/my-adb' }, renv)).toMatchObject({ path: custom, source: 'settings' });
    const fallback = resolveAdb({ adbPath: '/nope/adb' }, renv)!;
    expect(fallback.source).toBe('env');
    expect(fallback.detail).toMatch(/not an executable/);
  });

  it('finds idevicesyslog in Flutter caches (fvm, symlinked flutter on PATH) with DYLD_LIBRARY_PATH', () => {
    expect(resolveIdeviceTool('idevicesyslog', {}, renv)).toBeNull();
    const fvm = path.join(home, 'fvm/versions/3.38.5');
    exe(path.join(fvm, 'bin/flutter'));
    fs.mkdirSync(path.join(fvm, 'bin/cache'), { recursive: true });
    fs.writeFileSync(path.join(fvm, 'bin/cache/flutter.version.json'), JSON.stringify({ frameworkVersion: '3.38.5' }));
    const tool = exe(path.join(fvm, 'bin/cache/artifacts/libimobiledevice/idevicesyslog'));
    exe(path.join(fvm, 'bin/cache/artifacts/libusbmuxd/iproxy'));
    const r = resolveIdeviceTool('idevicesyslog', {}, renv)!;
    expect(r).toMatchObject({ path: tool, source: 'flutter-cache' });
    expect(r.detail).toContain('3.38.5');
    const artifacts = path.join(fvm, 'bin/cache/artifacts');
    expect(r.env).toEqual({
      DYLD_LIBRARY_PATH: ['libimobiledevice', 'libimobiledeviceglue', 'libplist', 'libusbmuxd', 'openssl']
        .map((d) => path.join(artifacts, d))
        .join(':'),
    });
    expect(resolveIdeviceTool('iproxy', {}, renv)?.path).toBe(path.join(artifacts, 'libusbmuxd/iproxy'));

    // `flutter` on PATH is a symlink (fvm default) → its real root wins and is listed first.
    const other = path.join(home, 'fvm/versions/3.41.9');
    exe(path.join(other, 'bin/flutter'));
    exe(path.join(other, 'bin/cache/artifacts/libimobiledevice/idevicesyslog'));
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.symlinkSync(path.join(fvm, 'bin/flutter'), path.join(home, 'bin/flutter'));
    expect(findFlutterRoots(renv)[0]).toBe(fvm);
    expect(resolveIdeviceTool('idevicesyslog', {}, renv)?.path).toBe(tool);
  });

  it('prefers settings.idevicesyslogPath and PATH over the Flutter cache', () => {
    const brew = exe(path.join(home, 'bin/idevicesyslog'));
    expect(resolveIdeviceTool('idevicesyslog', {}, renv)).toMatchObject({ path: brew, source: 'path' });
    const custom = exe(path.join(home, 'custom/idevicesyslog'));
    const shot = exe(path.join(home, 'custom/idevicescreenshot'));
    expect(resolveIdeviceTool('idevicesyslog', { idevicesyslogPath: custom }, renv)).toMatchObject({
      path: custom,
      source: 'settings',
    });
    expect(resolveIdeviceTool('idevicescreenshot', { idevicesyslogPath: custom }, renv)?.path).toBe(shot);
  });

  it('derives the DYLD env for binaries inside a Flutter artifacts folder', () => {
    expect(envForArtifactsBinary('/x/flutter/bin/cache/artifacts/libimobiledevice/idevicesyslog')).toEqual(
      flutterArtifactsEnv('/x/flutter/bin/cache/artifacts'),
    );
    expect(envForArtifactsBinary('/opt/homebrew/bin/idevicesyslog')).toBeUndefined();
  });
});

describe.runIf(process.platform === 'darwin')('real tools on this Mac', () => {
  it('runs idevicesyslog --help through the resolved tool (incl. Flutter cache DYLD env)', async () => {
    const tool = resolveIdeviceTool('idevicesyslog', {}, defaultResolveEnv());
    if (!tool) return; // not installed here: nothing to verify
    const r = await run(tool.path, ['--help'], { env: tool.env, timeoutMs: 10_000 });
    expect(`${r.stdout}${r.stderr}`).toContain('Usage: idevicesyslog');
    expect(r.code).toBe(0);
  });
});

describe('exec helpers', () => {
  it('never rejects: reports missing commands and timeouts as data', async () => {
    const missing = await run('/definitely/not/here', []);
    expect(missing).toMatchObject({ ok: false, errorCode: 'ENOENT' });
    const slow = await run('/bin/sleep', ['5'], { timeoutMs: 200 });
    expect(slow).toMatchObject({ ok: false, timedOut: true, errorCode: 'ETIMEDOUT' });
    const echo = await run('/bin/echo', ['a b', '$HOME;rm -rf /']);
    expect(echo.stdout).toBe('a b $HOME;rm -rf /\n'); // argv, never a shell
    const input = await run('/bin/cat', [], { input: 'stdin works' });
    expect(input.stdout).toBe('stdin works');
  });

  it('restarts a crashing stream with backoff and stops cleanly (no zombies)', async () => {
    let spawns = 0;
    const lines: string[] = [];
    const exits: boolean[] = [];
    const sp = new StreamProcess({
      name: 'test',
      logger: silentLogger,
      spec: () => ({ cmd: '/bin/sh', args: ['-c', 'echo run; exit 3'] }),
      onLine: (l) => lines.push(l),
      onSpawn: () => (spawns += 1),
      onExit: (i) => exits.push(i.willRestart),
      backoffInitialMs: 50,
      backoffMaxMs: 100,
    });
    sp.start();
    await waitFor(() => spawns >= 3, 5000);
    await sp.stop();
    expect(lines.filter((l) => l === 'run').length).toBeGreaterThanOrEqual(2);
    // Every exit before stop() schedules a restart; an exit caused by stop() itself does not.
    expect(exits.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(exits.slice(0, -1).every(Boolean)).toBe(true);
    const count = spawns;
    await new Promise((r) => setTimeout(r, 300));
    expect(spawns).toBe(count);
    expect(liveChildCount()).toBe(0);
  });

  it('kills a long-running stream on stop and does not restart it', async () => {
    const sp = new StreamProcess({
      name: 'sleeper',
      logger: silentLogger,
      spec: () => ({ cmd: '/bin/sh', args: ['-c', 'echo up; exec sleep 30'] }),
      onLine: () => {},
    });
    sp.start();
    await waitFor(() => sp.pid !== undefined);
    const pid = sp.pid!;
    await sp.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(sp.running).toBe(false);
  });

  it('killProcess escalates to SIGKILL', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 30'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await killProcess(child, 200);
    expect(child.signalCode).toBe('SIGKILL');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('text helpers', () => {
  it('splits lines across chunks, handles CRLF and caps runaway lines', () => {
    const out: string[] = [];
    const s = new LineSplitter((l) => out.push(l), 10);
    s.push('ab');
    s.push('c\r\nde');
    s.push('f\n');
    s.push('0123456789012345');
    s.flush();
    expect(out).toEqual(['abc', 'def', '0123456789', '012345']);
  });

  it('quotes for the Android shell and strips ANSI', () => {
    expect(shellQuote('com.example.app')).toBe('com.example.app');
    expect(shellQuote("it's & co")).toBe("'it'\\''s & co'");
    expect(shellQuote('')).toBe("''");
    expect(stripAnsi('\x1b[1;31mred\x1b[0m plain')).toBe('red plain');
  });
});
