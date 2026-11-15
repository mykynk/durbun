/**
 * One server per data folder: a second start on the same folder is refused while the first one runs, and a
 * lock left by a crashed run, a reused pid or a start that hung is taken over.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireDataDirLock, DATA_DIR_IN_USE_CODE, LOCK_FILE, START_GRACE_MS } from '../../src/dataDirLock';
import { makeTempDir } from './fakes';

const OTHER_PID = 424_242;
const never = async () => false;

describe('data folder lock', () => {
  it('refuses a second holder in this process until the first releases', async () => {
    const dir = await makeTempDir();
    const first = await acquireDataDirLock(dir, { probe: never });
    await first.setPort(9760);
    expect(JSON.parse(await readFile(path.join(dir, LOCK_FILE), 'utf8'))).toMatchObject({ pid: process.pid, port: 9760 });
    await expect(acquireDataDirLock(dir, { probe: never })).rejects.toMatchObject({ code: DATA_DIR_IN_USE_CODE, holder: { port: 9760 } });
    await first.release();
    const second = await acquireDataDirLock(dir, { probe: never });
    await second.release();
  });

  it('another live process: in use while its port answers as Dürbün, or while it is still starting', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, LOCK_FILE);
    const alive = () => true;
    await writeFile(file, JSON.stringify({ pid: OTHER_PID, port: 9750, startedAt: 1_000 }));
    await expect(acquireDataDirLock(dir, { probe: async (p) => p === 9750, alive })).rejects.toThrow(/port 9750/);
    // Same pid, nothing on its port: the pid was reused after a restart.
    const reused = await acquireDataDirLock(dir, { probe: never, alive });
    await reused.release();

    await writeFile(file, JSON.stringify({ pid: OTHER_PID, startedAt: 1_000 }));
    await expect(acquireDataDirLock(dir, { probe: never, alive, now: () => 1_000 + START_GRACE_MS - 1 })).rejects.toThrow(/starting/);
    const hung = await acquireDataDirLock(dir, { probe: never, alive, now: () => 1_000 + START_GRACE_MS });
    await hung.release();
  });

  it('a dead holder or an unreadable lock is stale; release never removes a lock that is not ours', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, LOCK_FILE);
    await writeFile(file, JSON.stringify({ pid: OTHER_PID, port: 9750, startedAt: 1 }));
    const a = await acquireDataDirLock(dir, { probe: async () => true, alive: () => false });
    await writeFile(file, 'not json');
    const b = await acquireDataDirLock(dir, { probe: never });
    await a.release(); // a's lock was replaced: b's file stays
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: process.pid });
    await b.release();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
