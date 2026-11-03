import { describe, expect, it } from 'vitest';
import { serverPaths } from '../src/paths';

describe('serverPaths', () => {
  it('packaged: the server and the UI come from inside app.asar (covered by the asar integrity fuse)', () => {
    const p = serverPaths({ isPackaged: true, resourcesPath: '/Applications/Dürbün.app/Contents/Resources', appPath: '/Applications/Dürbün.app/Contents/Resources/app.asar' });
    expect(p).toEqual({
      entry: '/Applications/Dürbün.app/Contents/Resources/app.asar/server/server.mjs',
      uiDir: '/Applications/Dürbün.app/Contents/Resources/app.asar/server/ui',
    });
  });
  it('development: the repo\'s dist/', () => {
    const p = serverPaths({ isPackaged: false, resourcesPath: '/x/Electron.app/Contents/Resources', appPath: '/repo/apps/desktop' });
    expect(p).toEqual({ entry: '/repo/dist/server.mjs', uiDir: '/repo/dist/ui' });
  });
});
