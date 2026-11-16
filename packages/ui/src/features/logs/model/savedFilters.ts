/**
 * Saved log filters ("Kayıtlı filtreler"). Kept in this window's storage under the key the Logs tab always used
 * (so filters saved before this store existed are simply read), shared with the other windows through the storage
 * event, and carried by the preference copy on the server (backups, packages, a new address): see
 * `features/transfer/prefsSync.ts`.
 */
import { create } from 'zustand';
import { readStorage, STORAGE_PREFIX, writeStorage } from '../../../lib/persist';
import { sanitizeSavedFilters, type SavedFilter } from './queryEdit';

/** The storage key `usePersistentState('logs.savedFilters')` wrote; unchanged so earlier filters are kept. */
export const SAVED_FILTERS_KEY = 'state.logs.savedFilters';

interface SavedFiltersState {
  filters: SavedFilter[];
}

export const useSavedFilters = create<SavedFiltersState>()(() => ({ filters: sanitizeSavedFilters(readStorage<unknown>(SAVED_FILTERS_KEY, [])) }));

export function savedFilters(): SavedFilter[] {
  return useSavedFilters.getState().filters;
}

export function setSavedFilters(next: SavedFilter[] | ((cur: SavedFilter[]) => SavedFilter[])): void {
  const value = sanitizeSavedFilters(typeof next === 'function' ? next(savedFilters()) : next);
  useSavedFilters.setState({ filters: value });
  writeStorage(SAVED_FILTERS_KEY, value);
}

const sameFilter = (a: SavedFilter, b: SavedFilter) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && a.query.trim() === b.query.trim();

/**
 * Filters from a package, a backup or the server's copy, added to the ones here: the same name and query is not
 * added twice, a name already used for another query gets a " (2)"; nothing here is removed or changed.
 */
export function mergeSavedFilters(current: readonly SavedFilter[], incoming: unknown): SavedFilter[] {
  const out = [...current];
  for (const f of sanitizeSavedFilters(incoming)) {
    if (out.some((x) => sameFilter(x, f))) continue;
    let name = f.name;
    for (let n = 2; out.some((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase()); n++) name = `${f.name.slice(0, 54)} (${n})`;
    const id = out.some((x) => x.id === f.id) ? `f${Math.random().toString(36).slice(2, 9)}` : f.id;
    out.push({ id, name, query: f.query });
  }
  return sanitizeSavedFilters(out);
}

// Another window saved or removed a filter.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_PREFIX + SAVED_FILTERS_KEY) return;
    useSavedFilters.setState({ filters: sanitizeSavedFilters(readStorage<unknown>(SAVED_FILTERS_KEY, [])) });
  });
}
