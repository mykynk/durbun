/**
 * Dürbün files opened from Finder (double click, Open With, a drop on the Dock icon) or File → Open… (no
 * Electron import, so it is unit-tested). macOS reports them with 'open-file', also before the app is
 * ready; they wait in a queue until the UI is loaded and asks for them. The UI then imports each one through
 * its own "Import a file" path (a package or flow file asks what to bring in, a session recording opens as
 * an imported device, a HAR file is imported as network traffic), so a file opened here behaves exactly like
 * one dropped on the window.
 */
import path from 'node:path';

/** What the window's import accepts: Dürbün packages and backups, session recordings / flow files, HAR files. */
export const OPENABLE = /\.(durbun|json|har)$/i;
/** File → Open… filter (extensions without the dot). */
export const OPEN_EXTENSIONS = ['durbun', 'json', 'har'];

/** The server's import limit (packages/server/src/http/api.ts IMPORT_LIMIT_BYTES). */
export const MAX_OPEN_BYTES = 500 * 1024 * 1024;

export function isOpenable(file: string): boolean {
  return OPENABLE.test(file);
}

export type OpenedFile = { name: string; text: string } | { name: string; error: 'tooLarge' | 'unreadable' | 'unsupported' };

export interface FileReader {
  size(file: string): Promise<number>;
  read(file: string): Promise<string>;
}

/** Reads one queued file for the UI; problems become an error the UI words (never a crash). */
export async function readOpened(file: string, fs: FileReader, maxBytes = MAX_OPEN_BYTES): Promise<OpenedFile> {
  const name = path.basename(file);
  if (!isOpenable(file)) return { name, error: 'unsupported' };
  try {
    if ((await fs.size(file)) > maxBytes) return { name, error: 'tooLarge' };
    return { name, text: await fs.read(file) };
  } catch {
    return { name, error: 'unreadable' };
  }
}

/** Paths waiting for the UI, without duplicates (Finder may report a file twice), oldest first, at most 20. */
export function createOpenQueue(limit = 20): { add(file: string): void; take(): string[]; readonly size: number } {
  let items: string[] = [];
  return {
    add(file) {
      if (!file || items.includes(file)) return;
      items.push(file);
      if (items.length > limit) items = items.slice(-limit);
    },
    take() {
      const out = items;
      items = [];
      return out;
    },
    get size() {
      return items.length;
    },
  };
}
