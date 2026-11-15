/**
 * One server per data folder. Two servers on the same folder (the Mac app and a CLI on another port, two CLIs)
 * rewrite each other's settings and mock rules, mark each other's running flows as interrupted and remove each
 * other's temporary flow rules. The first server writes `<dataDir>/durbun.lock` (pid, port, start time); a
 * second one reads it and refuses to start while the holder is alive.
 *
 * A lock is stale, and taken over, when its process is gone, when its recorded port does not answer as Dürbün
 * (the pid was reused after a restart) or when it never got a port within START_GRACE_MS (a start that hung).
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = 'durbun.lock';
export const DATA_DIR_IN_USE_CODE = 'server.dataDirInUse';
/** How long a holder may take from writing the lock to listening on its port. */
export const START_GRACE_MS = 120_000;

export interface LockHolder {
  pid: number;
  /** HTTP port, once the holder listens. */
  port?: number;
  startedAt: number;
}

export class DataDirInUseError extends Error {
  readonly code = DATA_DIR_IN_USE_CODE;
  constructor(
    readonly dataDir: string,
    readonly holder: LockHolder,
  ) {
    super(
      holder.port
        ? `The data folder ${dataDir} is in use by Dürbün on port ${holder.port} (pid ${holder.pid})`
        : `The data folder ${dataDir} is in use by another Dürbün that is starting (pid ${holder.pid})`,
    );
    this.name = 'DataDirInUseError';
  }
}

export interface DataDirLock {
  readonly file: string;
  /** Record the port the server listens on (other starts probe it). */
  setPort(port: number): Promise<void>;
  /** Remove the lock if it is still ours; never throws. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** Does a Dürbün answer on this port? (GET /api/health) */
  probe(port: number): Promise<boolean>;
  now?: () => number;
  pid?: number;
  /** Is this process alive? (default: signal 0) */
  alive?: (pid: number) => boolean;
}

/** Lock files this process holds: a second server in the same process (tests, an embedder) must be refused too. */
const heldHere = new Set<string>();

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseHolder(text: string): LockHolder | undefined {
  try {
    const v = JSON.parse(text) as Partial<LockHolder>;
    if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0 || typeof v.startedAt !== 'number') return undefined;
    const holder: LockHolder = { pid: v.pid, startedAt: v.startedAt };
    if (typeof v.port === 'number' && Number.isInteger(v.port) && v.port > 0) holder.port = v.port;
    return holder;
  } catch {
    return undefined;
  }
}

/** Is the holder of an existing lock still running a Dürbün on this folder? */
async function holderActive(file: string, holder: LockHolder, opts: Required<Omit<LockOptions, 'probe'>> & Pick<LockOptions, 'probe'>): Promise<boolean> {
  if (holder.pid === opts.pid) return heldHere.has(file);
  if (!opts.alive(holder.pid)) return false;
  if (holder.port !== undefined) return opts.probe(holder.port);
  return opts.now() - holder.startedAt < START_GRACE_MS;
}

/**
 * Take the lock of `dataDir` (which must exist). Throws DataDirInUseError while another live Dürbün holds it.
 * A folder the lock cannot be written to is not locked (the server falls back to a temp folder there anyway).
 */
export async function acquireDataDirLock(dataDir: string, options: LockOptions): Promise<DataDirLock> {
  const opts = { now: Date.now, pid: process.pid, alive: processAlive, ...options };
  const file = path.join(dataDir, LOCK_FILE);
  const token = randomBytes(8).toString('hex');
  const holder: LockHolder & { token: string } = { pid: opts.pid, startedAt: opts.now(), token };
  const write = (flag: 'wx' | 'w') => fsp.writeFile(file, JSON.stringify(holder) + '\n', { flag, mode: 0o600 });

  let locked = false;
  for (let attempt = 0; attempt < 3 && !locked; attempt++) {
    try {
      await write('wx');
      locked = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return unlocked(file); // read-only folder and the like: run without a lock
      const text = await fsp.readFile(file, 'utf8').catch(() => '');
      const other = parseHolder(text);
      if (other && (await holderActive(file, other, opts))) throw new DataDirInUseError(dataDir, other);
      // Stale: whoever removes it first takes it; a racing start sees our new file on its next attempt.
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
  if (!locked) return unlocked(file);
  heldHere.add(file);

  const ours = async () => {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    try {
      return (JSON.parse(text) as { token?: unknown }).token === token;
    } catch {
      return false;
    }
  };
  let released = false;
  return {
    file,
    async setPort(port) {
      if (released || !(await ours())) return;
      holder.port = port;
      await write('w').catch(() => {});
    },
    async release() {
      if (released) return;
      released = true;
      heldHere.delete(file);
      if (await ours()) await fsp.rm(file, { force: true }).catch(() => {});
    },
  };
}

function unlocked(file: string): DataDirLock {
  return { file, setPort: async () => {}, release: async () => {} };
}
