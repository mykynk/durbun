import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { pickLanguage, STRINGS } from '../src/i18n';
import { appMenuTemplate, serverLabel, trayMenuTemplate, type MenuHandlers } from '../src/menu';

const handlers = (): MenuHandlers => ({
  showWindow: vi.fn(),
  openInBrowser: vi.fn(),
  openDataDir: vi.fn(),
  showLog: vi.fn(),
  quit: vi.fn(),
  openSettings: vi.fn(),
  openDocs: vi.fn(),
  reportIssue: vi.fn(),
  checkForUpdates: vi.fn(),
  openLicenses: vi.fn(),
});

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])]);
}

describe('pickLanguage', () => {
  it('follows the first system language', () => {
    expect(pickLanguage(['tr-TR', 'en-US'])).toBe('tr');
    expect(pickLanguage(['tr'])).toBe('tr');
    expect(pickLanguage(['en-TR', 'tr-TR'])).toBe('en');
    expect(pickLanguage(['de-DE'])).toBe('en');
    expect(pickLanguage([])).toBe('en');
  });
});

describe('app menu', () => {
  for (const lang of ['tr', 'en'] as const) {
    it(`${lang}: has Edit roles (copy/paste need them on macOS) and no clashing accelerators`, () => {
      const items = flatten(appMenuTemplate(STRINGS[lang], handlers(), { canOpenInBrowser: true }));
      const roles = items.map((i) => i.role).filter(Boolean);
      expect(roles).toEqual(expect.arrayContaining(['copy', 'paste', 'cut', 'selectAll', 'undo', 'redo', 'reload', 'toggleDevTools', 'hide', 'minimize']));
      const accels = items.map((i) => i.accelerator).filter(Boolean) as string[];
      // UI shortcuts: Mod+K palette, Mod+F search, Mod+1…5 tabs, Mod+Backspace clear.
      for (const a of accels) expect(a).not.toMatch(/^CmdOrCtrl\+([KF1-5]|Backspace)$/);
      for (const i of items) if (i.type !== 'separator') expect(i.label, JSON.stringify(i)).toBeTruthy();
    });
  }
  it('Turkish labels', () => {
    const items = flatten(appMenuTemplate(STRINGS.tr, handlers(), { canOpenInBrowser: false }));
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["Dürbün'den Çık", 'Düzen', 'Kopyala', 'Yapıştır', 'Görünüm', 'Pencere', 'Yardım']));
    expect(items.find((i) => i.label === 'Tarayıcıda Aç')?.enabled).toBe(false);
  });
  it('Settings shows ⌘, without taking the key from the UI, and Help links to docs, issues, updates and licenses', () => {
    const h = handlers();
    const items = flatten(appMenuTemplate(STRINGS.tr, h, { canOpenInBrowser: true }));
    const settings = items.find((i) => i.label === 'Ayarlar…')!;
    expect(settings.accelerator).toBe('CmdOrCtrl+,');
    expect(settings.registerAccelerator).toBe(false);
    (settings.click as () => void)();
    expect(h.openSettings).toHaveBeenCalledOnce();
    for (const [label, fn] of [
      ['Dürbün Belgeleri', h.openDocs],
      ['Sorun Bildir…', h.reportIssue],
      ['Güncellemeleri Denetle…', h.checkForUpdates],
      ['Lisanslar', h.openLicenses],
    ] as const) {
      (items.find((i) => i.label === label)!.click as () => void)();
      expect(fn, label).toHaveBeenCalledOnce();
    }
  });
  it('Quit runs the clean quit handler', () => {
    const h = handlers();
    const quit = flatten(appMenuTemplate(STRINGS.en, h, { canOpenInBrowser: true })).find((i) => i.label === 'Quit Dürbün')!;
    expect(quit.accelerator).toBe('CmdOrCtrl+Q');
    (quit.click as () => void)();
    expect(h.quit).toHaveBeenCalledOnce();
  });
});

describe('tray menu', () => {
  it('shows the server state (tr)', () => {
    const t = STRINGS.tr;
    const items = trayMenuTemplate(t, { kind: 'running', port: 9750, warnings: [] }, handlers());
    expect(items.map((i) => i.label).filter(Boolean)).toEqual(["Dürbün'ü göster", 'Sunucu: çalışıyor · 9750', 'Tarayıcıda Aç', 'Çık']);
    expect(items.find((i) => i.label === 'Sunucu: çalışıyor · 9750')?.enabled).toBe(false);
  });
  it('lists warnings and failure reasons', () => {
    const t = STRINGS.en;
    const warn = trayMenuTemplate(t, { kind: 'running', port: 9760, warnings: ['Port 9750 is used by another program; Dürbün runs on port 9760.'] }, handlers());
    const sub = warn.find((i) => i.label === 'Warnings (1)')!.submenu as MenuItemConstructorOptions[];
    expect(sub[0]!.label).toContain('9760');
    const failed = trayMenuTemplate(t, { kind: 'failed', error: 'x'.repeat(300) }, handlers());
    expect(failed.map((i) => i.label)).toContain('Server: could not start');
    expect(failed.find((i) => i.label?.startsWith('xxx'))!.label!.length).toBeLessThanOrEqual(118);
    expect(failed.find((i) => i.label === 'Open in Browser')?.enabled).toBe(false);
  });
  it('labels every state in both languages', () => {
    for (const t of [STRINGS.tr, STRINGS.en]) {
      expect(serverLabel(t, { kind: 'starting' })).toBeTruthy();
      expect(serverLabel(t, { kind: 'attached', port: 9750, warnings: [] })).toContain('9750');
    }
    expect(serverLabel(STRINGS.tr, { kind: 'attached', port: 9750, warnings: [] })).toBe('Sunucu: başka bir Dürbün · 9750');
  });
  it('tells which Dürbün the window shows when another one with a different version is attached', () => {
    const t = STRINGS.tr;
    const items = trayMenuTemplate(t, { kind: 'attached', port: 9750, warnings: [t.attachedVersionNotice('0.0.9', '0.1.0')] }, handlers());
    const sub = items.find((i) => i.label === 'Uyarılar (1)')!.submenu as MenuItemConstructorOptions[];
    expect(sub[0]!.label).toBe("Pencerede başka bir Dürbün (sürüm 0.0.9) açık; bu uygulama 0.1.0. O kapanınca uygulama kendi sunucusunu başlatır.");
    expect(items.find((i) => i.label === 'Tarayıcıda Aç')?.enabled).toBe(true);
  });
  it('notices fit in the tray menu without being cut (≤ 120 characters)', () => {
    for (const t of [STRINGS.tr, STRINGS.en]) {
      for (const notice of [
        t.portFallbackNotice(9750, 9760),
        t.attachedVersionNotice('10.12.3', '10.12.4'),
        t.shellEnvNotice('zsh', 3),
        t.shellEnvNotice('fish'),
      ]) {
        expect(notice.length, notice).toBeLessThanOrEqual(120);
      }
    }
  });
});
