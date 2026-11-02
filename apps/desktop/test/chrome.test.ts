import { describe, expect, it } from 'vitest';
import { DESKTOP_CSS, splashUrl } from '../src/chrome';
import { serverPaths } from '../src/paths';

describe('splash', () => {
  it('is a self-contained data: page without scripts', () => {
    const url = splashUrl('Dürbün başlatılıyor…', 'dark');
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    expect(html).toContain('Dürbün başlatılıyor…');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('#0b0d12');
    expect(decodeURIComponent(splashUrl('<b>x</b>', 'light'))).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('desktop CSS', () => {
  it('makes the bars draggable but keeps controls clickable', () => {
    expect(DESKTOP_CSS).toMatch(/\.topbar \{ -webkit-app-region: drag; \}|\.sb-header, \.topbar \{ -webkit-app-region: drag; \}/);
    expect(DESKTOP_CSS).toContain('-webkit-app-region: no-drag');
  });
});

describe('serverPaths', () => {
  it('packaged → Contents/Resources/server, dev → repo dist/', () => {
    expect(serverPaths({ isPackaged: true, resourcesPath: '/Applications/Dürbün.app/Contents/Resources', appPath: 'x' })).toEqual({
      entry: '/Applications/Dürbün.app/Contents/Resources/server/server.mjs',
      uiDir: '/Applications/Dürbün.app/Contents/Resources/server/ui',
    });
    expect(serverPaths({ isPackaged: false, resourcesPath: 'x', appPath: '/repo/apps/desktop' })).toEqual({
      entry: '/repo/dist/server.mjs',
      uiDir: '/repo/dist/ui',
    });
  });
});
