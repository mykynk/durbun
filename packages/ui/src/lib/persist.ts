/** localStorage helpers that never throw (private mode, quota, disabled storage). Keys are prefixed. */

export const STORAGE_PREFIX = 'durbun.';

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStorage(key: string, value: unknown): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStorage(key: string): void {
  try {
    storage()?.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignore */
  }
}
