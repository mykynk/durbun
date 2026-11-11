import { mkdir, readdir, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurbunPackage, MockRule, UiNotice } from '@durbun/protocol';
import { BackupService, ensureFolder, ownMocksWatcher } from '../../src/backup/scheduler';
import { UiPrefsStore } from '../../src/backup/uiPrefs';
import { silentLogger } from '../../src/util/logger';
import { makeTempDir } from '../http/fakes';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await makeTempDir('durbun-backup-');
  dirs.push(d);
  return d;
}

const HOUR = 3_600_000;

function service(base: string, host: string, clock: { now: number }, notices: UiNotice[] = []): BackupService {
  return new BackupService({
    dataDir: path.join(base, `data-${host}`),
    logger: silentLogger,
    build: async () => ({ format: 'durbun-package', version: 1, kind: 'backup', createdAt: clock.now, createdBy: { app: 'Dürbün', version: 'test' }, contents: {} }) as DurbunPackage,
    notice: (n) => notices.push(n),
    now: () => clock.now,
    hostName: host,
  });
}

describe('backup rotation', () => {
  it('prunes only this Mac’s files when "Yusuf" and "Yusuf-Air" share a folder', async () => {
    const base = await tempDir();
    const folder = path.join(base, 'Backups');
    const clock = { now: new Date(2026, 10, 11, 12, 0, 0).getTime() };
    const air = service(base, 'Yusuf-Air', clock);
    await air.update({ folder, keep: 3, enabled: true });
    for (let i = 0; i < 3; i++) {
      clock.now += HOUR;
      await air.runNow();
    }
    const yusuf = service(base, 'Yusuf', clock);
    await yusuf.update({ folder, keep: 2, enabled: true });
    const written: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.now += HOUR;
      written.push(path.basename((await yusuf.runNow()).file));
    }
    const files = (await readdir(folder)).sort();
    // Yusuf keeps its two newest; Yusuf-Air's three stay untouched.
    expect(files.filter((f) => f.startsWith('Durbun-backup-Yusuf-Air-'))).toHaveLength(3);
    expect(files.filter((f) => !f.startsWith('Durbun-backup-Yusuf-Air-'))).toEqual(written.slice(1).sort());
    expect(yusuf.status().lastBackupFile).toBe(path.join(folder, written[2]!));

    // And the other way round: Yusuf-Air never counts Yusuf's files as its own.
    clock.now += HOUR;
    await air.runNow();
    expect((await readdir(folder)).filter((f) => !f.startsWith('Durbun-backup-Yusuf-Air-'))).toHaveLength(2);
  });

  it('orders by the time in the name and never removes the file it just wrote', async () => {
    const base = await tempDir();
    const folder = path.join(base, 'Backups');
    await mkdir(folder);
    // A file from "the future" (the clock was set back since): the name sorts after the new one.
    await writeFile(path.join(folder, 'Durbun-backup-Mac-2030-01-01_00-00-00.durbun'), '{}');
    // Not ours: a different pattern, a temp file of another Mac, a note.
    await writeFile(path.join(folder, 'Durbun-backup-Mac-old.durbun'), '{}');
    await writeFile(path.join(folder, 'notes.txt'), 'x');
    const clock = { now: new Date(2026, 10, 11, 12, 0, 0).getTime() };
    const mac = service(base, 'Mac', clock);
    await mac.update({ folder, keep: 1, enabled: true });
    const { file } = await mac.runNow();
    const files = (await readdir(folder)).sort();
    expect(files).toContain(path.basename(file));
    expect(files).toContain('Durbun-backup-Mac-old.durbun');
    expect(files).toContain('notes.txt');
  });

  it('removes its own stale temp files and leaves fresh ones', async () => {
    const base = await tempDir();
    const folder = path.join(base, 'Backups');
    await mkdir(folder);
    const stale = '.Durbun-backup-Mac-2026-11-10_08-00-00.durbun.123.abcd1234.tmp';
    const fresh = '.Durbun-backup-Mac-2026-11-11_11-59-00.durbun.456.beef0001.tmp';
    const other = '.Durbun-backup-Other-2026-11-10_08-00-00.durbun.123.abcd1234.tmp';
    for (const n of [stale, fresh, other]) await writeFile(path.join(folder, n), 'partial');
    const clock = { now: Date.now() };
    const old = new Date(clock.now - 2 * HOUR);
    await utimes(path.join(folder, stale), old, old);
    await utimes(path.join(folder, other), old, old);
    const mac = service(base, 'Mac', clock);
    await mac.update({ folder, enabled: true });
    await mac.runNow();
    const files = await readdir(folder);
    expect(files).not.toContain(stale);
    expect(files).toContain(fresh);
    expect(files).toContain(other);
  });

  it('treats a pruning problem after a written backup as a warning', async () => {
    const base = await tempDir();
    const folder = path.join(base, 'Backups');
    await mkdir(folder);
    // An old "backup" that is a folder: removing it fails.
    await mkdir(path.join(folder, 'Durbun-backup-Mac-2020-01-01_00-00-00.durbun'));
    const clock = { now: new Date(2026, 10, 11, 12, 0, 0).getTime() };
    const notices: UiNotice[] = [];
    const mac = service(base, 'Mac', clock, notices);
    await mac.update({ folder, keep: 1, enabled: true });
    const { file } = await mac.runNow();
    const status = mac.status();
    expect(status.lastBackupFile).toBe(file);
    expect(status.lastError).toBeUndefined();
    expect(status.lastWarning).toMatch(/\S/);
    expect(notices).toEqual([]);
  });
});

describe('backup folder', () => {
  it('creates only the last folder, and only when its parent exists', async () => {
    const base = await tempDir();
    await ensureFolder(path.join(base, 'Dürbün'));
    expect(await readdir(base)).toContain('Dürbün');
    await expect(ensureFolder(path.join(base, 'gone', 'Dürbün'))).rejects.toMatchObject({ code: 'backup.folder.unavailable' });
    expect(await readdir(base)).not.toContain('gone');
    await writeFile(path.join(base, 'file'), 'x');
    await expect(ensureFolder(path.join(base, 'file'))).rejects.toMatchObject({ code: 'backup.folder.unavailable' });
  });

  it('refuses a folder whose parent is missing, and a run fails when the folder went away', async () => {
    const base = await tempDir();
    const clock = { now: Date.now() };
    const mac = service(base, 'Mac', clock);
    await expect(mac.update({ folder: path.join(base, 'Volumes', 'Disk', 'Dürbün') })).rejects.toMatchObject({ code: 'backup.folder.unavailable' });
    const disk = path.join(base, 'Disk');
    await mkdir(disk);
    await mac.update({ folder: path.join(disk, 'Dürbün'), enabled: true });
    await rm(disk, { recursive: true });
    await expect(mac.runNow({ manual: true })).rejects.toMatchObject({ code: 'backup.folder.unavailable' });
    // Nothing was recreated in its place.
    expect(await readdir(base)).not.toContain('Disk');
  });

  it('a new folder makes a backup due at the next check', async () => {
    const base = await tempDir();
    const clock = { now: Date.now() };
    const mac = service(base, 'Mac', clock);
    await mac.update({ folder: path.join(base, 'A'), enabled: true });
    await mac.tick();
    expect(await readdir(path.join(base, 'A'))).toHaveLength(1);
    // Within the interval nothing is due…
    clock.now += 60_000;
    await mac.tick();
    expect(await readdir(path.join(base, 'A'))).toHaveLength(1);
    // …until the folder changes.
    await mac.update({ folder: path.join(base, 'B') });
    await mac.tick();
    expect(await readdir(path.join(base, 'B'))).toHaveLength(1);
  });
});

describe('backup failures', () => {
  it('tells the UI once per failure streak and never for a manual run', async () => {
    const base = await tempDir();
    const folder = path.join(base, 'Backups');
    const clock = { now: Date.now() };
    const notices: UiNotice[] = [];
    const mac = service(base, 'Mac', clock, notices);
    await mac.update({ folder, enabled: true });
    await rm(folder, { recursive: true });
    await writeFile(folder, 'not a folder');

    await expect(mac.runNow({ manual: true })).rejects.toMatchObject({ code: 'backup.folder.unavailable' });
    expect(notices).toHaveLength(0);
    for (let i = 0; i < 4; i++) {
      clock.now += 40 * 60_000;
      await mac.tick();
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'error', code: 'backup.failed' });
    expect(mac.status().lastError).toMatch(/not available/);

    // Fixed: the next run succeeds, and a new streak is told again.
    await rm(folder);
    await mkdir(folder);
    clock.now += 40 * 60_000;
    await mac.tick();
    expect(mac.status().lastError).toBeUndefined();
    await rm(folder, { recursive: true });
    await writeFile(folder, 'not a folder');
    clock.now += 25 * HOUR;
    await mac.tick();
    expect(notices).toHaveLength(2);
  });

  it('waits before retrying a failed automatic backup', async () => {
    const base = await tempDir();
    const folder = path.join(base, 'Backups');
    const clock = { now: Date.now() };
    let builds = 0;
    const mac = new BackupService({
      dataDir: path.join(base, 'data'),
      logger: silentLogger,
      build: async () => {
        builds++;
        throw new Error('disk full');
      },
      notice: () => {},
      now: () => clock.now,
      hostName: 'Mac',
    });
    await mac.update({ folder, enabled: true });
    await mac.tick();
    expect(builds).toBe(1);
    clock.now += 10 * 60_000;
    await mac.tick();
    expect(builds).toBe(1);
    clock.now += 25 * 60_000;
    await mac.tick();
    expect(builds).toBe(2);
  });
});

describe('reading a backup', () => {
  it('says plainly when a file is damaged, too large or missing', async () => {
    const base = await tempDir();
    const folder = path.join(base, 'Backups');
    const mac = service(base, 'Mac', { now: Date.now() });
    await mac.update({ folder });
    await writeFile(path.join(folder, 'cut.durbun'), '{"format":"durbun-package","version":1,"con');
    await writeFile(path.join(folder, 'bom.durbun'), '﻿{"format":"durbun-package","version":1,"contents":{}}');
    await writeFile(path.join(folder, 'huge.durbun'), '');
    await truncate(path.join(folder, 'huge.durbun'), 257 * 1024 * 1024);
    await expect(mac.read('cut.durbun')).rejects.toMatchObject({ code: 'package.damaged' });
    await expect(mac.read('bom.durbun')).resolves.toMatchObject({ format: 'durbun-package' });
    await expect(mac.read('huge.durbun')).rejects.toMatchObject({ code: 'package.tooLarge', status: 413 });
    await expect(mac.read('none.durbun')).rejects.toMatchObject({ code: 'backup.notFound' });
    await expect(mac.read('../x.durbun')).rejects.toMatchObject({ code: 'backup.notFound' });
    // `._name` companions macOS writes on other disks are not listed.
    await writeFile(path.join(folder, '._bom.durbun'), 'x');
    expect((await mac.list()).map((f) => f.name)).not.toContain('._bom.durbun');
  });
});

describe('what makes a backup due', () => {
  it('rules a flow adds while it runs do not count', () => {
    let changes = 0;
    const own: MockRule = { id: 'm1', enabled: true, method: 'GET', url: '/a', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 1 } as MockRule;
    const watch = ownMocksWatcher([own], () => changes++);
    watch([own, { ...own, id: 'flow-run-1' }]);
    watch([own]);
    expect(changes).toBe(0);
    watch([{ ...own, enabled: false }]);
    expect(changes).toBe(1);
  });

  it('the UI sending the same preferences after a restart is no change', async () => {
    const base = await tempDir();
    await new UiPrefsStore(base).put({ theme: 'dark' });
    const again = new UiPrefsStore(base);
    let changes = 0;
    again.onChange(() => changes++);
    await again.put({ theme: 'dark' });
    expect(changes).toBe(0);
    await again.put({ theme: 'light' });
    expect(changes).toBe(1);
    expect(JSON.parse(await readFile(again.file, 'utf8'))).toEqual({ theme: 'light' });
  });
});
