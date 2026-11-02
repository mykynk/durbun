import { readStorage } from '../lib/persist';

declare const __DURBUN_REPO_DIR__: string;

/** Absolute path of the Dürbün repository at build time (Vite `define`), for SDK path snippets. */
export const BUILD_REPO_DIR: string = typeof __DURBUN_REPO_DIR__ === 'string' && __DURBUN_REPO_DIR__ ? __DURBUN_REPO_DIR__ : '/path/to/durbun';

/** The repo path the user confirmed in the SDK guide (falls back to the build-time path). */
export function repoDir(): string {
  const v = readStorage<string>('state.sdk.repoDir', BUILD_REPO_DIR);
  return (typeof v === 'string' && v.trim() ? v.trim() : BUILD_REPO_DIR).replace(/\/+$/, '');
}
