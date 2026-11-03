/**
 * Where the embedded server and the UI build are. Packaged: inside app.asar, <app.asar>/server/
 * {server.mjs,ui} (electron-builder `files`), so the asar integrity fuse covers them. Development
 * (`npm run app`): the repo's dist/ (`npm run build`).
 */
import path from 'node:path';

export interface ServerPaths {
  entry: string;
  uiDir: string;
}

export function serverPaths(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): ServerPaths {
  if (opts.isPackaged) {
    // appPath is Contents/Resources/app.asar. Nothing is read from Resources/ outside the archive (an
    // older layout put the server there, where no fuse protected it).
    const dir = path.join(opts.appPath, 'server');
    return { entry: path.join(dir, 'server.mjs'), uiDir: path.join(dir, 'ui') };
  }
  const repo = path.resolve(opts.appPath, '..', '..');
  return { entry: path.join(repo, 'dist', 'server.mjs'), uiDir: path.join(repo, 'dist', 'ui') };
}

/** App icon for the Dock in development (packaged apps use the bundle's .icns). */
export function devIconPath(appPath: string): string {
  return path.resolve(appPath, '..', '..', 'packages', 'ui', 'public', 'icon-512.png');
}
