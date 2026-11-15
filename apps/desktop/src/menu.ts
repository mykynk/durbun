/**
 * Application menu and tray menu templates (pure: no Electron runtime import, so they are unit-tested).
 * Accelerators avoid the UI's own shortcuts (Mod+K, Mod+F, Mod+1…5, Mod+Backspace, Space, ?).
 */
import type { MenuItemConstructorOptions } from 'electron';
import type { Strings } from './i18n';
import type { UpdatePhase } from './updateFlow';

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
  /** While an update waits to be installed: asks before restarting. */
  restartToUpdate(): void;
  setAutoUpdateCheck(on: boolean): void;
  setOpenAtLogin(on: boolean): void;
  /** File → Open…: a Dürbün package, backup or session recording. */
  openFile(): void;
  copyDiagnostics(): void;
  openLicenses(): void;
}

export interface MenuOptions {
  canOpenInBrowser: boolean;
  /** undefined until the user answered (shown unticked). */
  autoUpdateCheck?: boolean;
  update?: UpdatePhase;
  openAtLogin?: boolean;
}

/** The update item: what it does follows the update's phase (a download shows here while it runs). */
export function updateMenuItem(t: Strings, h: MenuHandlers, phase: UpdatePhase = { kind: 'idle' }): MenuItemConstructorOptions {
  switch (phase.kind) {
    case 'checking':
      return { label: t.checkingUpdates, enabled: false };
    case 'downloading':
      return { label: t.updateDownloadingMenu(phase.version), enabled: false };
    case 'ready':
      return { label: t.updateReadyMenu, click: () => h.restartToUpdate() };
    default:
      return { label: t.checkUpdates, click: () => h.checkForUpdates() };
  }
}

export function appMenuTemplate(t: Strings, h: MenuHandlers, opts: MenuOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: t.appName,
      submenu: [
        { role: 'about', label: t.about },
        updateMenuItem(t, h, opts.update),
        { label: t.checkUpdatesAuto, type: 'checkbox', checked: opts.autoUpdateCheck === true, click: (item) => h.setAutoUpdateCheck(Boolean(item?.checked)) },
        { type: 'separator' },
        // ⌘, is the UI's own shortcut (it works while the window is focused): shown here, not registered.
        { label: t.settings, accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: () => h.openSettings() },
        { label: t.openAtLogin, type: 'checkbox', checked: opts.openAtLogin === true, click: (item) => h.setOpenAtLogin(Boolean(item?.checked)) },
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
      label: t.file,
      submenu: [
        { label: t.openFile, accelerator: 'CmdOrCtrl+O', click: () => h.openFile() },
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
        { label: t.copyDiagnostics, click: () => h.copyDiagnostics() },
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

/** Warnings or a failed start: the menu-bar icon carries a dot so they are seen without opening the menu. */
export function trayNeedsAttention(s: ServerState): boolean {
  return s.kind === 'failed' || ((s.kind === 'running' || s.kind === 'attached') && s.warnings.length > 0);
}

export function trayMenuTemplate(t: Strings, s: ServerState, h: MenuHandlers, opts: { update?: UpdatePhase; openAtLogin?: boolean } = {}): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: t.show, click: () => h.showWindow() },
    { type: 'separator' },
    { label: serverLabel(t, s), enabled: false },
  ];
  if ((s.kind === 'running' || s.kind === 'attached') && s.warnings.length > 0) {
    items.push({ label: t.warnings(s.warnings.length), submenu: s.warnings.map((w) => ({ label: w.length > 120 ? w.slice(0, 117) + '…' : w, enabled: false })) });
  }
  if (s.kind === 'failed') items.push({ label: s.error.length > 120 ? s.error.slice(0, 117) + '…' : s.error, enabled: false });
  items.push({ label: t.openInBrowser, enabled: s.kind === 'running' || s.kind === 'attached', click: () => h.openInBrowser() });
  if (opts.update && opts.update.kind !== 'idle' && opts.update.kind !== 'checking') items.push({ type: 'separator' }, updateMenuItem(t, h, opts.update));
  items.push(
    { type: 'separator' },
    { label: t.openAtLogin, type: 'checkbox', checked: opts.openAtLogin === true, click: (item) => h.setOpenAtLogin(Boolean(item?.checked)) },
    { label: t.trayQuit, click: () => h.quit() },
  );
  return items;
}
