/**
 * Where the embedded server and the UI build are. Packaged: Contents/Resources/server/{server.mjs,ui}
 * (electron-builder extraResources). Development (`npm run app`): the repo's dist/ (`npm run build`).
 */
import path from 'node:path';

export interface ServerPaths {
  entry: string;
  uiDir: string;
}

export function serverPaths(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): ServerPaths {
  if (opts.isPackaged) {
    const dir = path.join(opts.resourcesPath, 'server');
    return { entry: path.join(dir, 'server.mjs'), uiDir: path.join(dir, 'ui') };
  }
  const repo = path.resolve(opts.appPath, '..', '..');
  return { entry: path.join(repo, 'dist', 'server.mjs'), uiDir: path.join(repo, 'dist', 'ui') };
}

/** App icon for the Dock in development (packaged apps use the bundle's .icns). */
export function devIconPath(appPath: string): string {
  return path.resolve(appPath, '..', '..', 'packages', 'ui', 'public', 'icon-512.png');
}
