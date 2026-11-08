/**
 * Application menu and tray menu templates (pure: no Electron runtime import, so they are unit-tested).
 * Accelerators avoid the UI's own shortcuts (Mod+K, Mod+F, Mod+1…5, Mod+Backspace, Space, ?).
 */
import type { MenuItemConstructorOptions } from 'electron';
import type { Strings } from './i18n';

export interface MenuHandlers {
  showWindow(): void;
  openInBrowser(): void;
  openDataDir(): void;
  showLog(): void;
  quit(): void;
  /** Opens the UI's settings (the window comes forward first). */
  openSettings(): void;
  openDocs(): void;
  reportIssue(): void;
  checkForUpdates(): void;
  openLicenses(): void;
}

export function appMenuTemplate(t: Strings, h: MenuHandlers, opts: { canOpenInBrowser: boolean }): MenuItemConstructorOptions[] {
  return [
    {
      label: t.appName,
      submenu: [
        { role: 'about', label: t.about },
        { label: t.checkUpdates, click: () => h.checkForUpdates() },
        { type: 'separator' },
        // ⌘, is the UI's own shortcut (it works while the window is focused): shown here, not registered.
        { label: t.settings, accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: () => h.openSettings() },
        { type: 'separator' },
        { role: 'services', label: t.services },
        { type: 'separator' },
        { role: 'hide', label: t.hide },
        { role: 'hideOthers', label: t.hideOthers },
        { role: 'unhide', label: t.showAll },
        { type: 'separator' },
        { label: t.quit, accelerator: 'CmdOrCtrl+Q', click: () => h.quit() },
      ],
    },
    {
      label: t.edit,
      submenu: [
        { role: 'undo', label: t.undo },
        { role: 'redo', label: t.redo },
        { type: 'separator' },
        { role: 'cut', label: t.cut },
        { role: 'copy', label: t.copy },
        { role: 'paste', label: t.paste },
        { role: 'selectAll', label: t.selectAll },
      ],
    },
    {
      label: t.view,
      submenu: [
        { role: 'reload', label: t.reload },
        { role: 'forceReload', label: t.forceReload },
        { role: 'toggleDevTools', label: t.devTools },
        { type: 'separator' },
        { role: 'resetZoom', label: t.actualSize },
        { role: 'zoomIn', label: t.zoomIn },
        { role: 'zoomOut', label: t.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullScreen },
      ],
    },
    {
      label: t.window,
      submenu: [
        { role: 'minimize', label: t.minimize },
        { role: 'zoom', label: t.zoom },
        { role: 'close', label: t.close },
        { type: 'separator' },
        { label: t.show, click: () => h.showWindow() },
        { role: 'front', label: t.front },
      ],
    },
    {
      role: 'help',
      label: t.help,
      submenu: [
        { label: t.docs, click: () => h.openDocs() },
        { label: t.reportIssue, click: () => h.reportIssue() },
        { type: 'separator' },
        { label: t.openInBrowser, enabled: opts.canOpenInBrowser, click: () => h.openInBrowser() },
        { label: t.openDataDir, click: () => h.openDataDir() },
        { label: t.showLog, click: () => h.showLog() },
        { type: 'separator' },
        { label: t.licenses, click: () => h.openLicenses() },
      ],
    },
  ];
}

export type ServerState =
  | { kind: 'starting' }
  | { kind: 'running'; port: number; warnings: string[] }
  | { kind: 'attached'; port: number; warnings: string[] }
  | { kind: 'failed'; error: string };

export function serverLabel(t: Strings, s: ServerState): string {
  switch (s.kind) {
    case 'starting':
      return t.serverStarting;
    case 'running':
      return t.serverRunning(s.port);
    case 'attached':
      return t.serverAttached(s.port);
    case 'failed':
      return t.serverFailed;
  }
}

export function trayMenuTemplate(t: Strings, s: ServerState, h: MenuHandlers): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: t.show, click: () => h.showWindow() },
    { type: 'separator' },
    { label: serverLabel(t, s), enabled: false },
  ];
  if ((s.kind === 'running' || s.kind === 'attached') && s.warnings.length > 0) {
    items.push({ label: t.warnings(s.warnings.length), submenu: s.warnings.map((w) => ({ label: w.length > 120 ? w.slice(0, 117) + '…' : w, enabled: false })) });
  }
  if (s.kind === 'failed') items.push({ label: s.error.length > 120 ? s.error.slice(0, 117) + '…' : s.error, enabled: false });
  items.push(
    { label: t.openInBrowser, enabled: s.kind === 'running' || s.kind === 'attached', click: () => h.openInBrowser() },
    { type: 'separator' },
    { label: t.trayQuit, click: () => h.quit() },
  );
  return items;
}
