/**
 * Automatic backups: there is no cloud, so Dürbün writes an encrypted-when-possible `.durbun` backup into a
 * folder the user picks (iCloud Drive, Dropbox, an external disk…) — every `intervalHours`, and an hour after
 * something changed. A new Mac restores from the newest file. Each Mac names its files after itself and only
 * prunes its own (the exact name pattern, oldest by the time in the name), so several Macs can share one folder.
 *
 * The folder is never created from scratch: only its last part, and only when the parent exists. A folder whose
 * disk is unplugged or whose sync service signed out fails clearly instead of filling a local look-alike.
 * A failing automatic backup tells the UI once per failure streak and retries quietly.
 *
 * `<dataDir>/backup.json` (0600) holds the settings and, when the user set one, the passphrase.
 */
import { constants as fsConstants, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackupSettings, BackupSettingsPatch, DurbunPackage, MockRule, PackageExportRequest, UiNotice } from '@durbun/protocol';
import { isPlainObject, writeFileAtomic } from '../config';
import { HttpError } from '../http/util';
import { Queue, readJsonFile, safeFileName, writeJsonFile } from '../flows/util';
import type { Logger } from '../types';
import { machineName } from './machine';
import { MIN_PACKAGE_PASSPHRASE, PACKAGE_JSON_LIMIT_BYTES } from './package';

export const BACKUP_FILE = 'backup.json';
const CHECK_INTERVAL_MS = 10 * 60_000;
/** After a change, the next backup waits at least this long since the last one. */
const AFTER_CHANGE_MS = 60 * 60_000;
/** After a failed automatic backup, the next try waits this long. */
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
/** Our own temp files older than this are leftovers of an interrupted write. */
const STALE_TMP_MS = 60 * 60_000;
const MIN_PASSPHRASE = MIN_PACKAGE_PASSPHRASE;

interface StoredBackup {
  enabled: boolean;
  folder?: string;
  keep: number;
  intervalHours: number;
  includeRuns: boolean;
  passphrase?: string;
  lastBackupAt?: number;
  lastBackupFile?: string;
  lastError?: string;
  lastWarning?: string;
  dirtySince?: number;
  /** A backup is due at the next check (the folder changed). */
  dueSoon?: boolean;
  /** The UI was told about the current failure streak. */
  failNotified?: boolean;
}

const DEFAULTS: StoredBackup = { enabled: false, keep: 10, intervalHours: 24, includeRuns: false };

export interface BackupDeps {
  dataDir: string;
  logger: Logger;
  build(req: PackageExportRequest): Promise<DurbunPackage>;
  notice(n: UiNotice): void;
  now(): number;
  /** This Mac's name in file names (tests). */
  hostName?: string;
}

export function expandFolder(p: string): string {
  const t = p.trim();
  if (t === '~') return os.homedir();
  if (t.startsWith('~/')) return path.join(os.homedir(), t.slice(2));
  return t;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Local time, the way the file name spells it (the user reads it). */
function stampOf(m: RegExpExecArray): number {
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/**
 * The folder, ready to write into: it exists, or only its last part is missing and its parent exists (then it is
 * created). Anything else means the place is gone (a disk unplugged, a sync service signed out).
 */
export async function ensureFolder(folder: string): Promise<void> {
  const unavailable = () => new HttpError(400, `The backup folder is not available: ${folder}`, 'backup.folder.unavailable');
  const stat = await fsp.stat(folder).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? undefined : Promise.reject(err)));
  if (stat && !stat.isDirectory()) throw unavailable();
  if (!stat) {
    const parent = await fsp.stat(path.dirname(folder)).catch(() => undefined);
    if (!parent?.isDirectory()) throw unavailable();
    try {
      await fsp.mkdir(folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new HttpError(400, `Dürbün cannot write to ${folder}: ${(err as Error).message}`, 'backup.folder.unwritable');
    }
  }
  try {
    await fsp.access(folder, fsConstants.W_OK);
  } catch (err) {
    throw new HttpError(400, `Dürbün cannot write to ${folder}: ${(err as Error).message}`, 'backup.folder.unwritable');
  }
}

/**
 * A mock rule listener that calls `onChange` only when the user's own rules change: rules a flow adds while it
 * runs (`flow-…`) are not part of a backup and must not make one due.
 */
export function ownMocksWatcher(initial: readonly MockRule[], onChange: () => void): (rules: readonly MockRule[]) => void {
  const key = (rules: readonly MockRule[]) => JSON.stringify(rules.filter((r) => !r.id.startsWith('flow-')));
  let last = key(initial);
  return (rules) => {
    const next = key(rules);
    if (next === last) return;
    last = next;
    onChange();
  };
}

export class BackupService {
  private data: StoredBackup = { ...DEFAULTS };
  private readonly file: string;
  private readonly queue = new Queue();
  private timer?: NodeJS.Timeout;
  private running?: Promise<{ file: string; size: number }>;
  private readonly host: string;
  private readonly ownName: RegExp;
  private readonly ownTmp: RegExp;
  private lastFailedAt?: number;

  constructor(private readonly deps: BackupDeps) {
    this.file = path.join(deps.dataDir, BACKUP_FILE);
    this.host = safeFileName(deps.hostName ?? machineName(), 'mac');
    const host = escapeRe(this.host);
    this.ownName = new RegExp(`^Durbun-backup-${host}-(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})\\.durbun$`);
    // writeFileAtomic's temp name: `.<file>.<pid>.<hex>.tmp`
    this.ownTmp = new RegExp(`^\\.Durbun-backup-${host}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.durbun\\.\\d+\\.[0-9a-f]+\\.tmp$`);
  }

  async load(): Promise<void> {
    try {
      const raw = await readJsonFile(this.file);
      if (isPlainObject(raw)) this.data = { ...DEFAULTS, ...(raw as Partial<StoredBackup>) };
    } catch (err) {
      this.deps.logger.warn(`could not read ${BACKUP_FILE}: ${(err as Error).message}`);
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 30_000).unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): BackupSettings {
    const d = this.data;
    const s: BackupSettings = { enabled: d.enabled, keep: d.keep, intervalHours: d.intervalHours, includeRuns: d.includeRuns, hasPassphrase: !!d.passphrase };
    if (d.folder) s.folder = d.folder;
    if (d.lastBackupAt) s.lastBackupAt = d.lastBackupAt;
    if (d.lastBackupFile) s.lastBackupFile = d.lastBackupFile;
    if (d.lastError) s.lastError = d.lastError;
    if (d.lastWarning) s.lastWarning = d.lastWarning;
    return s;
  }

  private save(): Promise<void> {
    const snapshot = { ...this.data };
    return this.queue.run(() => writeJsonFile(this.file, snapshot, 0o600));
  }

  async update(raw: unknown): Promise<BackupSettings> {
    if (!isPlainObject(raw)) throw new HttpError(400, 'Expected an object', 'backup.invalid');
    const p = raw as BackupSettingsPatch;
    const next = { ...this.data };
    if (p.folder !== undefined) {
      if (p.folder === null || p.folder === '') delete next.folder;
      else {
        const folder = path.normalize(expandFolder(String(p.folder))).replace(/(.)\/+$/, '$1');
        if (!path.isAbsolute(folder)) throw new HttpError(400, 'Choose a full folder path (starting with / or ~)', 'backup.folder.invalid');
        await ensureFolder(folder);
        if (folder !== next.folder) {
          next.folder = folder;
          // The new folder gets a backup soon; old messages were about the old one.
          next.dueSoon = true;
          delete next.lastError;
          delete next.lastWarning;
          delete next.failNotified;
          this.lastFailedAt = undefined;
        }
      }
    }
    if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
    if (p.keep !== undefined) next.keep = Math.max(1, Math.min(100, Math.round(Number(p.keep)) || DEFAULTS.keep));
    if (p.intervalHours !== undefined) next.intervalHours = Math.max(1, Math.min(24 * 30, Math.round(Number(p.intervalHours)) || DEFAULTS.intervalHours));
    if (typeof p.includeRuns === 'boolean') next.includeRuns = p.includeRuns;
    if (p.passphrase !== undefined) {
      if (p.passphrase === null || p.passphrase === '') delete next.passphrase;
      else if (String(p.passphrase).length < MIN_PASSPHRASE) throw new HttpError(400, `Use at least ${MIN_PASSPHRASE} characters`, 'backup.passphrase.short');
      else next.passphrase = String(p.passphrase);
    }
    if (next.enabled && !next.folder) throw new HttpError(400, 'Choose a folder for the backups first', 'backup.folder.missing');
    this.data = next;
    await this.save();
    return this.status();
  }

  /** Something worth backing up changed. */
  markDirty(): void {
    if (!this.data.enabled) return;
    if (this.data.dirtySince === undefined) {
      this.data.dirtySince = this.deps.now();
      void this.save().catch(() => undefined);
    }
  }

  private due(now: number): boolean {
    const d = this.data;
    if (!d.enabled || !d.folder) return false;
    if (this.lastFailedAt !== undefined && now - this.lastFailedAt < RETRY_AFTER_FAILURE_MS) return false;
    if (d.dueSoon) return true;
    const last = d.lastBackupAt ?? 0;
    if (now - last >= d.intervalHours * 3_600_000) return true;
    return d.dirtySince !== undefined && now - last >= AFTER_CHANGE_MS;
  }

  async tick(): Promise<void> {
    if (this.running || !this.due(this.deps.now())) return;
    try {
      await this.runNow();
    } catch {
      /* lastError is set; the UI shows it */
    }
  }

  fileName(at: number): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `Durbun-backup-${this.host}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.durbun`;
  }

  /**
   * Writes a backup now. `manual`: the user clicked "Back up now" and sees the error there, so no notice goes out;
   * an automatic failure tells the UI once per failure streak.
   */
  runNow(opts: { manual?: boolean } = {}): Promise<{ file: string; size: number }> {
    if (this.running) return this.running;
    const work = (async () => {
      const folder = this.data.folder;
      if (!folder) throw new HttpError(400, 'Choose a folder for the backups first', 'backup.folder.missing');
      const now = this.deps.now();
      let file: string;
      let size: number;
      try {
        const pkg = await this.deps.build({
          kind: 'backup',
          include: { flows: 'all', mocks: true, environments: true, settings: true, uiPrefs: true, slack: true, runs: this.data.includeRuns },
          ...(this.data.passphrase ? { passphrase: this.data.passphrase } : {}),
        });
        const text = JSON.stringify(pkg);
        await ensureFolder(folder);
        file = path.join(folder, this.fileName(now));
        await writeFileAtomic(file, text, 0o600);
        size = Buffer.byteLength(text);
      } catch (err) {
        const message = (err as Error).message;
        this.data = { ...this.data, lastError: message };
        if (!opts.manual) {
          this.lastFailedAt = now;
          if (!this.data.failNotified) {
            this.data.failNotified = true;
            this.deps.notice({ level: 'error', message: `The automatic backup failed: ${message}`, code: 'backup.failed', params: { error: message } });
          }
        }
        await this.save().catch(() => undefined);
        this.deps.logger.warn(`backup failed: ${message}`);
        throw err instanceof HttpError ? err : new HttpError(500, `The backup failed: ${message}`, 'backup.failed');
      }
      // The backup is written: a pruning problem is only a warning.
      let warning: string | undefined;
      try {
        await this.prune(folder, path.basename(file));
      } catch (err) {
        warning = (err as Error).message;
        this.deps.logger.warn(`old backups could not be removed: ${warning}`);
      }
      this.lastFailedAt = undefined;
      this.data = {
        ...this.data,
        lastBackupAt: now,
        lastBackupFile: file,
        lastError: undefined,
        lastWarning: warning,
        dirtySince: undefined,
        dueSoon: undefined,
        failNotified: undefined,
      };
      await this.save().catch((err) => this.deps.logger.warn(`could not save ${BACKUP_FILE}: ${(err as Error).message}`));
      this.deps.logger.info(`backup written: ${file}`);
      return { file, size };
    })();
    this.running = work.finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Keep this Mac's newest `keep` backups in the folder: only files named exactly like ours, oldest by the time
   * in the name, never the one just written. Leftover temp files of interrupted writes go too.
   */
  private async prune(folder: string, justWritten: string): Promise<void> {
    const names = await fsp.readdir(folder);
    const own: { name: string; at: number }[] = [];
    for (const name of names) {
      const m = this.ownName.exec(name);
      if (m) own.push({ name, at: stampOf(m) });
    }
    own.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    const excess = own.length - this.data.keep;
    const remove = own.slice(0, Math.max(0, excess)).filter((f) => f.name !== justWritten);
    for (const f of remove) await fsp.rm(path.join(folder, f.name), { force: true });
    const now = this.deps.now();
    for (const name of names.filter((n) => this.ownTmp.test(n))) {
      const stat = await fsp.stat(path.join(folder, name)).catch(() => undefined);
      if (stat?.isFile() && now - stat.mtimeMs > STALE_TMP_MS) await fsp.rm(path.join(folder, name), { force: true });
    }
  }

  /** Backups in the folder (any Mac), newest first: what a restore offers. */
  async list(): Promise<{ file: string; name: string; size: number; modifiedAt: number }[]> {
    const folder = this.data.folder;
    if (!folder) return [];
    let names: string[];
    try {
      names = await fsp.readdir(folder);
    } catch {
      return [];
    }
    const out: { file: string; name: string; size: number; modifiedAt: number }[] = [];
    // Dot files are temp files and the `._name` companions macOS writes on non-Apple disks.
    for (const name of names.filter((n) => n.endsWith('.durbun') && !n.startsWith('.'))) {
      const stat = await fsp.stat(path.join(folder, name)).catch(() => undefined);
      if (stat?.isFile()) out.push({ file: path.join(folder, name), name, size: stat.size, modifiedAt: stat.mtimeMs });
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 50);
  }

  /** Read one backup of the folder (restore without a file picker). */
  async read(name: string): Promise<unknown> {
    const folder = this.data.folder;
    if (!folder || name.includes('/') || name.includes('..') || name.startsWith('.') || !name.endsWith('.durbun')) throw new HttpError(404, 'No such backup', 'backup.notFound');
    const file = path.join(folder, name);
    let text: string;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      if (stat.size > PACKAGE_JSON_LIMIT_BYTES) {
        throw new HttpError(413, `The file is too large (limit ${Math.round(PACKAGE_JSON_LIMIT_BYTES / 1024 / 1024)} MB)`, 'package.tooLarge');
      }
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'No such backup', 'backup.notFound');
      throw new HttpError(400, `The backup could not be read: ${(err as Error).message}`, 'backup.unreadable');
    }
    try {
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (err) {
      throw new HttpError(400, `The file is damaged or incomplete: ${(err as Error).message}`, 'package.damaged');
    }
  }

  /** Folders worth suggesting: iCloud Drive, cloud storage providers, Documents. */
  static async suggestions(home = os.homedir()): Promise<{ id: string; label: string; path: string }[]> {
    const out: { id: string; label: string; path: string }[] = [];
    const exists = async (p: string) => !!(await fsp.stat(p).catch(() => undefined))?.isDirectory();
    const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    if (await exists(icloud)) out.push({ id: 'icloud', label: 'iCloud Drive', path: path.join(icloud, 'Dürbün') });
    const cloud = path.join(home, 'Library', 'CloudStorage');
    // Only sync services: CloudStorage also holds plain mounts (a phone, a NAS share) that carry nothing to another Mac.
    for (const name of (await fsp.readdir(cloud).catch(() => [] as string[])).sort()) {
      const label = cloudLabel(name);
      if (label) out.push({ id: `cloud:${name}`, label, path: path.join(cloud, name, 'Dürbün') });
    }
    if (!out.some((o) => o.label.startsWith('Dropbox')) && (await exists(path.join(home, 'Dropbox')))) out.push({ id: 'dropbox', label: 'Dropbox', path: path.join(home, 'Dropbox', 'Dürbün') });
    out.push({ id: 'documents', label: 'Documents', path: path.join(home, 'Documents', 'Dürbün Backups') });
    return out;
  }
}

const SYNC_SERVICES: Record<string, string> = {
  Dropbox: 'Dropbox',
  GoogleDrive: 'Google Drive',
  OneDrive: 'OneDrive',
  Box: 'Box',
  pCloudDrive: 'pCloud',
  ProtonDrive: 'Proton Drive',
  Nextcloud: 'Nextcloud',
  SynologyDrive: 'Synology Drive',
  Tresorit: 'Tresorit',
  MEGA: 'MEGA',
};

/** "GoogleDrive-ayse@example.com" → "Google Drive (ayse@example.com)"; undefined for folders that are not a sync service. */
export function cloudLabel(folder: string): string | undefined {
  const m = /^([A-Za-z]+)(?:-(.+))?$/.exec(folder);
  const service = m ? SYNC_SERVICES[m[1]!] : undefined;
  if (!service) return undefined;
  const account = m![2]?.trim();
  return account && account !== m![1] ? `${service} (${account})` : service;
}
