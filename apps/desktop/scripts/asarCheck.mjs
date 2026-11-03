/**
 * After electron-builder: is everything the app loads at run time inside app.asar? The main process,
 * the preload, and the embedded server with its UI (paths.ts). A file missing there means a broken
 * build (the app would show "server bundle not found"), so `npm run app:dist` fails instead.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Archive paths the packaged app needs (forward slashes, no leading slash). */
export const REQUIRED_IN_ASAR = ['package.json', 'out/main.mjs', 'out/preload.cjs', 'server/server.mjs', 'server/ui/index.html'];

/** The required paths that `asarPath` does not contain (`listPackage` is injectable for tests). */
export function missingFromAsar(asarPath, required = REQUIRED_IN_ASAR, listPackage = require('@electron/asar').listPackage) {
  const present = new Set(listPackage(asarPath, { isPack: false }).map((p) => p.replace(/\\/g, '/').replace(/^\/+/, '')));
  return required.filter((p) => !present.has(p));
}
