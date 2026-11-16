/**
 * `app-data`: the tar writer, the gzip/size-limit pipe, the Android run-as stream (fake adb child) and the
 * simulator container (fake simctl). The run-as error lines come from fixtures/android-run-as-errors.txt, which is
 * NOT taken from a device (written from the AOSP run-as sources; see its header).
 */
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDataPullData } from '@durbun/protocol';
import { androidActionAvailability } from '../../src/platform/android/actions';
import { parseRunAsOutput, pullAndroidAppData, runAsTarCommand } from '../../src/platform/android/appData';
import { pullSimAppData, SIM_ACTIONS } from '../../src/platform/ios/simActions';
import { oncePerDevice, writeTarGz } from '../../src/platform/shared/appData';
import { done } from '../../src/platform/shared/files';
import { looksLikeTar, tarDirectory, tarHeader } from '../../src/platform/shared/tarStream';
import type { RunResult } from '../../src/platform/exec';

let dir: string;
let temp: string;
const ctx = () => ({ tempDir: temp, fileUrl: (n: string) => `/api/files/${n}` });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-appdata-'));
  temp = path.join(dir, 'tmp');
  fs.mkdirSync(temp);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A small app data folder with the usual Android layout, a long name, a non-ASCII name and a link outside. */
function makeAppFolder(root: string): void {
  fs.mkdirSync(path.join(root, 'shared_prefs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shared_prefs', 'session.xml'), '<map><string name="token">abc</string></map>');
  fs.mkdirSync(path.join(root, 'databases'));
  fs.writeFileSync(path.join(root, 'databases', 'app.db'), Buffer.alloc(70_000, 7));
  const deep = path.join(root, 'files', 'a'.repeat(60), 'b'.repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'çay-ğ.json'), '{"ok":true}');
  fs.mkdirSync(path.join(root, 'cache'));
  fs.writeFileSync(path.join(root, 'cache', 'big.bin'), 'cached');
  fs.symlinkSync('/etc/hosts', path.join(root, 'files', 'outside'));
}

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of gen) parts.push(b);
  return Buffer.concat(parts);
}

function extract(file: string): string {
  const out = path.join(dir, `x-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(out);
  execFileSync('tar', ['-xzf', file, '-C', out]);
  return out;
}

describe('tar writer', () => {
  it('a folder round-trips through the system tar: long and non-ASCII names, links kept as links, skipped folders out', async () => {
    const src = path.join(dir, 'src');
    makeAppFolder(src);
    let files = 0;
    const file = path.join(temp, 'a.tar.gz');
    const out = await writeTarGz(tarDirectory(src, { exclude: (rel) => rel === 'cache', onFile: () => (files += 1) }), file);
    expect(out).toMatchObject({ ok: true });
    expect(files).toBe(3);
    const x = extract(file);
    expect(fs.readFileSync(path.join(x, 'shared_prefs', 'session.xml'), 'utf8')).toContain('token');
    expect(fs.statSync(path.join(x, 'databases', 'app.db')).size).toBe(70_000);
    expect(fs.readFileSync(path.join(x, 'files', 'a'.repeat(60), 'b'.repeat(60), 'çay-ğ.json'), 'utf8')).toBe('{"ok":true}');
    expect(fs.lstatSync(path.join(x, 'files', 'outside')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(x, 'cache'))).toBe(false);
  });

  it('headers: valid checksum and magic, a PAX block first for a name over 100 bytes', () => {
    const h = tarHeader({ name: 'shared_prefs/a.xml', type: 'file', size: 5, mtime: 1 });
    expect(h.length).toBe(512);
    expect(looksLikeTar(h)).toBe(true);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(parseInt(h.toString('ascii', 148, 154), 8)).toBe(sum);
    const long = tarHeader({ name: `files/${'x'.repeat(120)}`, type: 'file', size: 1 });
    expect(long.length).toBe(512 * 3);
    expect(long.toString('ascii', 156, 157)).toBe('x');
    expect(long.toString('utf8', 512, 1024)).toContain(`path=files/${'x'.repeat(120)}\n`);
  });

  it('a file that grows while it is read is cut to its header size', async () => {
    const src = path.join(dir, 'grow');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'log.txt'), 'abc');
    const gen = tarDirectory(src);
    const first = await gen.next(); // header of log.txt, size 3
    fs.appendFileSync(path.join(src, 'log.txt'), 'defgh');
    const rest = await collect({ [Symbol.asyncIterator]: () => gen });
    const all = Buffer.concat([first.value as Buffer, rest]);
    expect(all.length % 512).toBe(0);
    expect(all.toString('utf8', 512, 515)).toBe('abc');
    expect(all[515]).toBe(0);
  });

  it('past the size limit: stopped, nothing left on the disk', async () => {
    const src = path.join(dir, 'src');
    makeAppFolder(src);
    let stopped = false;
    const file = path.join(temp, 'big.tar.gz');
    const out = await writeTarGz(tarDirectory(src), file, { maxBytes: 20_000, onStop: () => (stopped = true) });
    expect(out).toMatchObject({ ok: false, reason: 'tooLarge' });
    expect(stopped).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});

/** A stand-in for `adb exec-out …`: stdout/stderr streams, exit after the scripted output. */
function fakeChild(stdout: Buffer | string, stderr = '', exitCode = 0, opts: { chunk?: number; endEarly?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: null; pid?: number; kill(): boolean; killed: boolean };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.pid = 4242; // fake: kill() below is overridden, no signal is sent
  child.kill = () => {
    child.killed = true;
    child.stdout.destroy();
    child.exitCode = 143;
    setImmediate(() => child.emit('exit', 143));
    return true;
  };
  const buf = typeof stdout === 'string' ? Buffer.from(stdout) : stdout;
  const size = opts.chunk ?? 4096;
  setImmediate(async () => {
    for (let i = 0; i < buf.length && !child.killed; i += size) {
      child.stdout.write(buf.subarray(i, i + size));
      await new Promise((r) => setImmediate(r));
    }
    if (child.killed) return;
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.exitCode = exitCode;
    setImmediate(() => child.emit('exit', exitCode));
  });
  return child as unknown as ChildProcess & { killed: boolean };
}

describe('Android: run-as', () => {
  it('the phone-side command: run-as in the data folder, caches left out, the user when given', () => {
    const cmd = runAsTarCommand('com.example.shop');
    expect(cmd.startsWith('run-as com.example.shop sh -c ')).toBe(true);
    expect(cmd).toContain('grep -vxE ".|..|cache|code_cache|lib"');
    expect(cmd).toContain('tar -cf - "$@" 2>/dev/null');
    expect(runAsTarCommand('com.example.shop', 10).startsWith('run-as --user 10 com.example.shop sh -c ')).toBe(true);
  });

  it('error texts (fixtures written from the AOSP sources, NOT captured from a phone)', () => {
    const lines = fs
      .readFileSync(path.join(__dirname, 'fixtures', 'android-run-as-errors.txt'), 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(8);
    for (const line of lines) {
      const [code, text = ''] = line.split('\t');
      expect([text, parseRunAsOutput(text.replace(/\\n/g, '\n'), 'com.example.shop').code]).toEqual([text, code]);
    }
    expect(parseRunAsOutput('run-as: package has corrupt installation: x', 'x').params).toEqual({ detail: 'run-as: package has corrupt installation: x' });
  });

  it('a tar from the phone becomes a .tar.gz in the temp folder (reply shape)', async () => {
    const src = path.join(dir, 'src');
    makeAppFolder(src);
    const tar = await collect(tarDirectory(src, { exclude: (rel) => rel === 'cache' }));
    let command = '';
    const r = await pullAndroidAppData(
      { ctx: ctx(), label: 'Pixel 8', spawn: (c) => ((command = c), fakeChild(tar, 'tar: removing leading /\n', 0, { chunk: 1000 })) },
      'com.example.shop',
    );
    expect(command).toContain('run-as com.example.shop');
    expect(r).toMatchObject({ ok: true, code: 'action.appData.saved' });
    const data = r.data as AppDataPullData;
    expect(Object.keys(data).sort()).toEqual(['appId', 'bytes', 'durationSec', 'file', 'fileName', 'rawBytes', 'url'].sort());
    expect(data).toMatchObject({ appId: 'com.example.shop', rawBytes: tar.length, url: `/api/files/${data.fileName}` });
    expect(path.dirname(data.file)).toBe(temp);
    expect(data.fileName).toMatch(/^app-data-com\.example\.shop-Pixel-8-.*\.tar\.gz$/);
    expect(fs.statSync(data.file).size).toBe(data.bytes);
    const x = extract(data.file);
    expect(fs.readFileSync(path.join(x, 'shared_prefs', 'session.xml'), 'utf8')).toContain('token');
  });

  it('not debuggable / not installed / locked: plain codes, no file left', async () => {
    for (const [text, code] of [
      ['run-as: package not debuggable: com.example.shop\n', 'action.appData.notDebuggable'],
      ['run-as: unknown package: com.example.shop\n', 'action.appData.notInstalled'],
      ["run-as: couldn't chdir to package's data directory '/data/user/0/com.example.shop': Required key not available\n", 'action.appData.locked'],
    ] as const) {
      const r = await pullAndroidAppData({ ctx: ctx(), label: 'Pixel 8', spawn: () => fakeChild(text, '', 1) }, 'com.example.shop');
      expect(r).toMatchObject({ ok: false, code });
    }
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it('a connection that drops mid-stream is not saved as a whole copy', async () => {
    const src = path.join(dir, 'src');
    makeAppFolder(src);
    const tar = await collect(tarDirectory(src));
    const cut = tar.subarray(0, tar.length - 2048 - 100);
    const r = await pullAndroidAppData({ ctx: ctx(), label: 'Pixel 8', spawn: () => fakeChild(cut) }, 'com.example.shop');
    expect(r).toMatchObject({ ok: false, code: 'action.appData.incomplete' });
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it('too large: the phone side is stopped and the reply names the limit', async () => {
    const src = path.join(dir, 'src');
    makeAppFolder(src);
    const tar = await collect(tarDirectory(src));
    let child: (ChildProcess & { killed: boolean }) | undefined;
    const r = await pullAndroidAppData(
      { ctx: ctx(), label: 'Pixel 8', maxBytes: 10_000, spawn: () => (child = fakeChild(tar, '', 0, { chunk: 2048 })) },
      'com.example.shop',
    );
    expect(r).toMatchObject({ ok: false, code: 'action.appData.tooLarge', params: { limit: '1 GiB' } });
    expect(child?.killed).toBe(true);
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it('adb missing', async () => {
    const r = await pullAndroidAppData({ ctx: ctx(), label: 'Pixel 8', spawn: () => null }, 'com.example.shop');
    expect(r).toMatchObject({ ok: false, code: 'action.toolMissing', params: { tool: 'adb' } });
  });

  it('offered on every online Android device', () => {
    expect(androidActionAvailability({ online: true, isEmulator: false, apiLevel: 26 }).actions).toContain('app-data');
    expect(androidActionAvailability({ online: false, isEmulator: false }).actions).not.toContain('app-data');
  });
});

describe('iOS simulator: data container', () => {
  const ok = (stdout: string): RunResult<string> => ({ ok: true, code: 0, signal: null, timedOut: false, stdout, stderr: '' });
  const bad = (stderr: string): RunResult<string> => ({ ok: false, code: 2, signal: null, timedOut: false, stdout: '', stderr });

  it('the data container is copied without caches, snapshots and tmp', async () => {
    const container = path.join(dir, 'Containers', 'Data', 'Application', 'ABC');
    fs.mkdirSync(path.join(container, 'Library', 'Preferences'), { recursive: true });
    fs.writeFileSync(path.join(container, 'Library', 'Preferences', 'com.example.shop.plist'), 'plist');
    fs.mkdirSync(path.join(container, 'Library', 'Caches'), { recursive: true });
    fs.writeFileSync(path.join(container, 'Library', 'Caches', 'x'), 'x');
    fs.mkdirSync(path.join(container, 'Documents'));
    fs.writeFileSync(path.join(container, 'Documents', 'notes.sqlite'), 'db');
    fs.mkdirSync(path.join(container, 'tmp'));
    fs.writeFileSync(path.join(container, 'tmp', 'y'), 'y');
    const calls: string[][] = [];
    const r = await pullSimAppData(
      { udid: 'U1', label: 'iPhone 17', ctx: ctx() as never, simctl: async (args) => (calls.push(args), ok(`${container}\n`)) },
      'com.example.shop',
    );
    expect(calls).toEqual([['get_app_container', 'U1', 'com.example.shop', 'data']]);
    expect(r).toMatchObject({ ok: true, code: 'action.appData.saved' });
    const x = extract((r.data as AppDataPullData).file);
    expect(fs.readFileSync(path.join(x, 'Documents', 'notes.sqlite'), 'utf8')).toBe('db');
    expect(fs.existsSync(path.join(x, 'Library', 'Preferences', 'com.example.shop.plist'))).toBe(true);
    expect(fs.existsSync(path.join(x, 'Library', 'Caches'))).toBe(false);
    expect(fs.existsSync(path.join(x, 'tmp'))).toBe(false);
    expect(SIM_ACTIONS).toContain('app-data');
  });

  it('not installed / nothing to copy', async () => {
    const t = { udid: 'U1', label: 'iPhone 17', ctx: ctx() as never };
    expect(await pullSimAppData({ ...t, simctl: async () => bad('No such file or directory') }, 'com.example.none')).toMatchObject({ ok: false, code: 'action.appNotFound' });
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(path.join(empty, 'Library', 'Caches'), { recursive: true });
    expect(await pullSimAppData({ ...t, simctl: async () => ok(empty) }, 'com.example.shop')).toMatchObject({ ok: false, code: 'action.appData.empty' });
    expect(fs.readdirSync(temp)).toEqual([]);
  });
});

it('one pull per device at a time', async () => {
  let release!: () => void;
  const first = oncePerDevice('android:1', () => new Promise((r) => (release = () => r(done('ok')))));
  expect(await oncePerDevice('android:1', async () => done('second'))).toMatchObject({ ok: false, code: 'action.appData.busy' });
  expect(await oncePerDevice('android:2', async () => done('other'))).toMatchObject({ ok: true });
  release();
  await first;
  expect(await oncePerDevice('android:1', async () => done('again'))).toMatchObject({ ok: true });
});
