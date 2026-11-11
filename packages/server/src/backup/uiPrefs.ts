/**
 * The UI keeps its preferences (theme, language, noise rules, column choices…) in the browser's storage.
 * It also sends a copy here, so a backup made by the server (automatic backups) carries them and a restore on
 * a new Mac brings them back. `<dataDir>/ui-prefs.json`.
 */
import path from 'node:path';
import { isPlainObject } from '../config';
import { HttpError } from '../http/util';
import { Queue, readJsonFile, writeJsonFile } from '../flows/util';

export const UI_PREFS_FILE = 'ui-prefs.json';
export const UI_PREFS_LIMIT_BYTES = 2 * 1024 * 1024;

export class UiPrefsStore {
  readonly file: string;
  private cache: Record<string, unknown> | undefined;
  private readonly queue = new Queue();
  private readonly listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, UI_PREFS_FILE);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async get(): Promise<Record<string, unknown>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readJsonFile(this.file);
      this.cache = isPlainObject(raw) ? raw : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async put(raw: unknown): Promise<void> {
    if (!isPlainObject(raw)) throw new HttpError(400, 'Expected an object', 'uiPrefs.invalid');
    if (JSON.stringify(raw).length > UI_PREFS_LIMIT_BYTES) throw new HttpError(413, 'The preferences are too large', 'uiPrefs.tooLarge');
    // Compared with what is on disk: the UI sends its copy whenever it connects, and that is no change.
    const before = this.cache ?? (await this.get());
    const changed = JSON.stringify(raw) !== JSON.stringify(before);
    this.cache = raw;
    await this.queue.run(() => writeJsonFile(this.file, raw, 0o600));
    if (changed) for (const l of this.listeners) l();
  }
}
