/**
 * Dürbün for macOS (SPEC §10.7). Double-click → the Dürbün server starts inside this process (the
 * bundled dist/server.mjs, UI from dist/ui) and its UI opens in a window. No terminal, no commands.
 *
 *  - single instance (a second launch focuses the window)
 *  - PATH / ANDROID_HOME / … from the login shell before the server starts (Finder gives a bare env)
 *  - port 9750 / SDK 9751 (DURBUN_PORT / DURBUN_SDK_PORT override); a Dürbün already on the port is
 *    reused once it proves it is one (health + its UI; replaced by our own server when it stops); a port
 *    held by another program → a nearby free port
 *  - the window loads http://127.0.0.1:<port>, the host the probe checked (never "localhost", which
 *    Chromium tries on ::1 first); the UI preferences and the page zoom of the old localhost origin are
 *    moved over once
 *  - data dir ~/.durbun (shared with the CLI; DURBUN_DATA_DIR overrides; DURBUN_USER_DATA_DIR moves the
 *    Electron profile, DURBUN_DEMO=1 starts with demo data, DURBUN_DEBUG=1 logs verbosely)
 *  - menu-bar item, closing the window keeps capturing (said once); Quit (⌘Q / menu bar) stops the server
 *    cleanly; Open at Login starts it hidden in the menu bar
 *  - the window only ever loads the local server; links open in the default browser
 *  - Dürbün files open from Finder and File → Open… (openFiles.ts); updates only after a yes (updateFlow.ts)
 */
import { app, autoUpdater, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, session, shell, Tray, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splashUrl, statusPageUrl, syncFullScreen, TRAFFIC_LIGHTS } from './chrome';
import { applyLoginShellEnv, SHELL_ENV_TIMEOUT_MS, type ShellEnvKey, type ShellEnvResult } from './env';
import { pickLanguage, STRINGS, type Strings } from './i18n';
import { createPrefsStore } from './desktopPrefs';
import { diagnosticsText, issueUrl, lastLines, shortLocation } from './diagnostics';
import { createQuitFlow } from './lifecycle';
import { installFileLog, pruneCrashDumps, type FileLog, type ScopedLogger } from './log';
import { appMenuTemplate, serverLabel, trayMenuTemplate, trayNeedsAttention, type MenuHandlers, type ServerState } from './menu';
import { decideNavigation, isAllowedPermission, isAllowedRequest, isAppUrl, REQUEST_FILTER_URLS } from './navigation';
import { attachNotices, bundledServerVersion, serverWarnings } from './notices';
import { createNotifier, type Notifier, type NotifyRequest } from './notifier';
import { createOpenQueue, readOpened } from './openFiles';
import { devIconPath, serverPaths } from './paths';
import { DEFAULT_HTTP_PORT, DEFAULT_SDK_PORT, isPortFree, parsePortEnv, probeDurbun, proveDurbun, watchAttached, type DurbunProbe } from './ports';
import { createReloadGuard, resolveFailure, type FailureChoice } from './recovery';
import { runSelfTest, type ConsoleEntry } from './selftest';
import { startedOrigin, startOrAttachServer } from './startup';
import { applyZoomLevel, BLANK_PAGE, LEGACY_HOST, legacyOriginFor, migrateUiStorage, planZoomMove, recordZoomMoved } from './storageMigration';
import { renderTrayBitmap } from './trayIcon';
import { createUpdateFlow, type MessageBoxRequest, type UpdatePhase } from './updateFlow';
import { autoCheckDue, bundlePath, createRateLimiter, parseCodesign, REPO_URL, selfUpdateSupport, shouldAskAutoCheck, shouldOfferMove, updateArch, type SignatureKind } from './updates';
import { fitBounds, MIN_SIZE, readWindowState, THEME_BACKGROUND, writeWindowState, type Theme, type WindowState } from './windowState';

/** The part of dist/server.mjs this app uses (packages/server/src/server.ts). */
interface EmbeddedServer {
  url: string;
  info: { ports?: { http?: number; sdk?: number } };
  warnings: string[];
  /** Structured twins of `warnings` (code, params, English message); absent in older bundles. */
  notices?: unknown[];
  sdkListening: boolean;
  stop(): Promise<void>;
}
interface ServerModule {
  startServer(
    opts: {
      httpPort: number;
      sdkPort: number;
      demo: boolean;
      dataDir: string;
      uiDir?: string;
      verbose: boolean;
    },
    extras?: { logger?: ScopedLogger },
  ): Promise<EmbeddedServer>;
  /** "Is a Dürbün answering on this port?" (absent in older bundles). */
  probeServer?(port: number): Promise<DurbunProbe | undefined>;
  /** The bundled server's version (absent in older bundles: the app's own version stands in). */
  SERVER_VERSION?: string;
}

const STOP_TIMEOUT_MS = 12_000;
/** The one-time preference move must never hold the window back for long. */
const STORAGE_MIGRATION_TIMEOUT_MS = 4_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const selfTestFile = process.env.DURBUN_DESKTOP_SELFTEST || '';

process.setSourceMapsEnabled?.(true);
// Separate profile for tests / a second copy (window state, UI preferences, single-instance lock, log).
if (process.env.DURBUN_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.DURBUN_USER_DATA_DIR));

if (!app.requestSingleInstanceLock()) {
  // Another Dürbün app owns the window and the server; it gets 'second-instance' and comes forward.
  app.quit();
} else {
  run();
}

function run(): void {
  const log: FileLog = installFileLog(path.join(app.getPath('userData'), 'logs', 'main.log'));
  log.info(`Dürbün ${app.getVersion()} (Electron ${process.versions.electron}, Node ${process.versions.node}) starting; packaged=${app.isPackaged}`);
  // Errors are data: a bug in one module must not take down the window (Electron would show a dialog).
  process.on('uncaughtException', (err) => log.error(`uncaught exception (still running): ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => log.error(`unhandled rejection (still running): ${String((reason as Error)?.stack ?? reason)}`));
  // Native crashes (GPU, renderer, main) leave a minidump in ~/Library/Application Support/Dürbün/Crashpad
  // for bug reports. Nothing is uploaded anywhere.
  try {
    crashReporter.start({ uploadToServer: false, compress: true });
  } catch (err) {
    log.warn(`crash reporter unavailable: ${(err as Error).message}`);
  }

  // Start asking the login shell right away; it runs while Electron initializes.
  const envReady: Promise<{ result: ShellEnvResult; changed: ShellEnvKey[] }> = applyLoginShellEnv(process.env).catch((err) => ({
    result: { env: null, shell: '?', ms: 0, error: String(err) },
    changed: [],
  }));

  let t: Strings = STRINGS.en;
  let win: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let server: EmbeddedServer | null = null;
  let startInFlight: Promise<EmbeddedServer> | null = null;
  let appOrigin: string | null = null;
  let state: ServerState = { kind: 'starting' };
  let stopWatch: (() => void) | null = null;
  let shellEnv: { result: ShellEnvResult; changed: ShellEnvKey[] } | null = null;
  const externalOpened: string[] = [];
  const consoleLog: ConsoleEntry[] = [];
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const migrationFile = path.join(app.getPath('userData'), 'storage-migration.json');
  let zoomChecked = false;
  let winState: WindowState = readWindowState(stateFile);
  const dataDir = process.env.DURBUN_DATA_DIR ? path.resolve(process.env.DURBUN_DATA_DIR) : path.join(os.homedir(), '.durbun');
  const prefs = createPrefsStore(path.join(app.getPath('userData'), 'desktop.json'));
  /** The server version the window shows (own bundle, or the attached Dürbün's). */
  let serverVersion: string | undefined;
  let openAtLogin = false;
  /** Opened at login: the window stays hidden, Dürbün captures from the menu bar. */
  let startHidden = false;
  let openedAtLogin = false;
  let trayImages: { plain: Electron.NativeImage; attention: Electron.NativeImage } | null = null;
  const bundle = bundlePath(process.execPath);
  let signature: SignatureKind = 'other';
  let signatureRead: Promise<void> = Promise.resolve();
  let updatePhase: UpdatePhase = { kind: 'idle' };
  let installingUpdate = false;

  // Files opened from Finder can arrive before 'ready' (the app was not running): they wait for the UI.
  const openQueue = createOpenQueue();
  app.on('open-file', (event, file) => {
    event.preventDefault();
    log.info(`open-file: ${path.basename(file)}`);
    openQueue.add(file);
    deliverOpenedFiles();
  });

  const openExternal = (url: string) => {
    if (selfTestFile) {
      externalOpened.push(url);
      return;
    }
    shell.openExternal(url).catch((err) => log.warn(`could not open ${url}: ${(err as Error).message}`));
  };

  const showWindow = () => {
    if (!app.isReady()) return; // 'activate' can arrive before 'ready'; the window comes with ready
    if (!win || win.isDestroyed()) createWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
  };

  const handlers: MenuHandlers = {
    showWindow,
    openInBrowser: () => {
      if (appOrigin) openExternal(appOrigin);
    },
    openDataDir: () => {
      shell.openPath(dataDir).then((err) => err && log.warn(`open ${dataDir}: ${err}`));
    },
    showLog: () => shell.showItemInFolder(log.file),
    quit: () => app.quit(),
    openSettings: () => {
      showWindow();
      if (win && !win.isDestroyed() && appOrigin) win.webContents.send('durbun:command', 'settings');
    },
    openDocs: () => openExternal(`${REPO_URL}#readme`),
    reportIssue: () => void reportIssue(),
    copyDiagnostics: () => void copyDiagnostics(),
    checkForUpdates: () => void updates.check('manual'),
    restartToUpdate: () => void updates.offerRestart(),
    setAutoUpdateCheck: (on) => {
      void updates.setAutoCheck(on).then(() => {
        refreshMenus();
        if (on) void autoUpdateTick();
      });
    },
    setOpenAtLogin: (on) => void setOpenAtLogin(on),
    openFile: () => void pickFiles(),
    openLicenses: () => {
      const dir = app.isPackaged ? path.join(process.resourcesPath, 'legal') : path.resolve(app.getAppPath(), '..', '..');
      shell.openPath(path.join(dir, 'LICENSE')).then((err) => err && log.warn(`open licenses: ${err}`));
      if (app.isPackaged) shell.showItemInFolder(path.join(dir, 'THIRD_PARTY_NOTICES.txt'));
    },
  };

  const box = (opts: Electron.MessageBoxOptions) => {
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
    return parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
  };

  /* ───────────── updates (updateFlow.ts) ───────────── */

  // A session of its own: no cookies, no cache, and the default session lets the window reach only the
  // local server. The request names no user, machine or install.
  const fetchFeed = async (url: string) => {
    const ses = session.fromPartition('durbun-update-check');
    const res = await ses.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Durbun' }, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15_000) });
    let body: unknown = null;
    if (res.ok) {
      try {
        body = JSON.parse(await res.text());
      } catch {
        body = null;
      }
    }
    return { status: res.status, body };
  };

  const updates = createUpdateFlow({
    t: () => t,
    currentVersion: app.getVersion(),
    arch: updateArch(process.arch, app.runningUnderARM64Translation),
    get: fetchFeed,
    selfUpdate: () => selfUpdateSupport({ isPackaged: app.isPackaged, signature, bundle, parentWritable: bundle ? isWritable(path.dirname(bundle)) : false }),
    box: (req: MessageBoxRequest) => box({ ...req, noLink: true }).then((r) => r.response),
    openExternal,
    startDownload: (url) => {
      autoUpdater.setFeedURL({ url, serverType: 'json', headers: { 'user-agent': 'Durbun' } });
      autoUpdater.checkForUpdates();
    },
    restart: async () => {
      // quitAndInstall closes the windows first (the close handler lets them go), then the usual quit path
      // stops the server and Squirrel.Mac swaps the app and starts the new version.
      installingUpdate = true;
      autoUpdater.quitAndInstall();
      setTimeout(() => {
        if (!installingUpdate || isQuitting()) return;
        installingUpdate = false;
        updates.failed('Dürbün did not quit to install the update');
      }, 20_000);
    },
    prefs,
    onPhase: (phase) => {
      updatePhase = phase;
      refreshMenus();
      // The Dock icon shows activity while the update downloads (Squirrel.Mac reports no progress).
      if (win && !win.isDestroyed()) win.setProgressBar(phase.kind === 'downloading' ? 2 : -1);
    },
    log,
  });
  autoUpdater.on('update-downloaded', () => updates.downloaded());
  autoUpdater.on('update-not-available', () => updates.notAvailable());
  autoUpdater.on('error', (err) => {
    installingUpdate = false;
    updates.failed(err?.message ?? String(err));
  });

  /** Automatic checks: only after the user's yes, at most once a day, never during the first minutes. */
  let autoUpdateStarted = false;
  async function autoUpdateTick(): Promise<void> {
    if (!app.isPackaged || selfTestFile || isQuitting()) return;
    if (shouldAskAutoCheck(prefs.get(), app.isPackaged) && win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
      await updates.askAboutAutoCheck();
      refreshMenus();
    }
    if (autoCheckDue(prefs.get(), Date.now())) await updates.check('auto');
  }
  function startAutoUpdates(): void {
    if (autoUpdateStarted || !app.isPackaged || selfTestFile) return;
    autoUpdateStarted = true;
    setTimeout(() => void autoUpdateTick(), 2 * 60_000);
    setInterval(() => void autoUpdateTick(), 60 * 60_000).unref();
  }

  function isWritable(dir: string): boolean {
    try {
      accessSync(dir, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Developer ID, ad-hoc or unsigned (codesign prints the signature details on stderr). Read once at start;
   * the move-to-Applications question waits for it.
   */
  function readSignature(): Promise<void> {
    if (!app.isPackaged || !bundle) return Promise.resolve();
    return new Promise((resolve) => {
      execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 10_000 }, (_err, _stdout, stderr) => {
        signature = parseCodesign(String(stderr ?? ''));
        log.info(`signature: ${signature}`);
        resolve();
      });
    });
  }

  /* ───────────── files opened from Finder / File → Open… (openFiles.ts) ───────────── */

  let uiLoaded = false;
  function deliverOpenedFiles(): void {
    if (openQueue.size === 0 || !app.isReady()) return;
    showWindow();
    // The UI asks for the files itself (it also does when it starts); this tells a loaded UI they are there.
    if (win && !win.isDestroyed() && appOrigin && uiLoaded) win.webContents.send('durbun:command', 'open-file');
  }

  ipcMain.handle('durbun:take-opened-files', async (event) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url)) return [];
    const files = openQueue.take();
    const results = await Promise.all(files.map((f) => readOpened(f, { size: async (p) => (await fsp.stat(p)).size, read: (p) => fsp.readFile(p, 'utf8') })));
    const out: { name: string; text: string }[] = [];
    for (const r of results) {
      if ('text' in r) out.push(r);
      else {
        log.warn(`open-file ${r.name}: ${r.error}`);
        void box({ type: 'warning', message: t.openFailedTitle, detail: t.openFailedMessage(r.name, r.error), buttons: [t.ok] });
      }
    }
    return out;
  });

  async function pickFiles(): Promise<void> {
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Dürbün', extensions: ['durbun', 'json'] }],
      message: t.openFileMessage,
    };
    const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (canceled) return;
    for (const f of filePaths) openQueue.add(f);
    deliverOpenedFiles();
  }

  /* ───────────── diagnostics (diagnostics.ts) ───────────── */

  async function collectDiagnostics(): Promise<string> {
    const port = state.kind === 'running' || state.kind === 'attached' ? state.port : undefined;
    let doctor: unknown;
    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/doctor`, { signal: AbortSignal.timeout(8_000) });
        if (res.ok) doctor = await res.json();
      } catch (err) {
        log.warn(`diagnostics: tool check unavailable (${(err as Error).message})`);
      }
    }
    let logTail = '';
    try {
      const handle = await fsp.open(log.file, 'r');
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, size - length);
        logTail = lastLines(buf.toString('utf8'), 200, size > length);
      } finally {
        await handle.close();
      }
    } catch {
      /* no log */
    }
    return diagnosticsText({
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      server: serverVersion,
      macos: process.getSystemVersion(),
      arch: process.arch,
      translated: app.runningUnderARM64Translation,
      packaged: app.isPackaged,
      mode: state.kind,
      httpPort: port,
      sdkPort: server?.info?.ports?.sdk,
      lan: readLanSetting(),
      signature: app.isPackaged ? signature : undefined,
      location: shortLocation(bundle, os.homedir()),
      warnings: state.kind === 'running' || state.kind === 'attached' ? state.warnings : state.kind === 'failed' ? [state.error] : [],
      doctor,
      logTail,
    });
  }

  async function copyDiagnostics(): Promise<void> {
    clipboard.writeText(await collectDiagnostics());
    await box({ type: 'info', message: t.diagnosticsCopiedTitle, detail: t.diagnosticsCopiedMessage, buttons: [t.ok] });
  }

  /** The bug report form, prefilled with the version and environment; the long part goes through the clipboard. */
  async function reportIssue(): Promise<void> {
    clipboard.writeText(await collectDiagnostics());
    const { response } = await box({ type: 'info', message: t.reportIssueTitle, detail: t.reportIssueMessage, buttons: [t.openForm, t.cancel], defaultId: 0, cancelId: 1 });
    if (response === 0) openExternal(issueUrl({ app: app.getVersion(), macos: process.getSystemVersion(), arch: process.arch, translated: app.runningUnderARM64Translation }));
  }

  /** The server's LAN setting (settings.json in the data folder): the SDK port is then reachable from the network. */
  function readLanSetting(): boolean | undefined {
    try {
      const raw = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) as { allowLan?: unknown };
      return raw.allowLan === true;
    } catch {
      return undefined;
    }
  }

  /* ───────────── login item, first close, Applications folder ───────────── */

  async function setOpenAtLogin(on: boolean): Promise<void> {
    if (!app.isPackaged) {
      log.info('Open at Login works in the packaged app only');
      refreshMenus();
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: on });
      const settings = app.getLoginItemSettings();
      openAtLogin = settings.openAtLogin;
      log.info(`open at login: ${on ? 'on' : 'off'} (${settings.status ?? '?'})`);
      if (on && settings.status === 'requires-approval') await box({ type: 'info', message: t.loginApprovalTitle, detail: t.loginApprovalMessage, buttons: [t.ok] });
    } catch (err) {
      log.warn(`open at login: ${(err as Error).message}`);
    }
    refreshMenus();
  }

  /** Once: closing the window does not stop Dürbün (users took it for a quit and left the SDK port open). */
  function closeNoteOnce(): void {
    if (prefs.get().closeNoteShown || selfTestFile) return;
    void prefs.update({ closeNoteShown: true });
    void dialog.showMessageBox({ type: 'info', message: t.closeNoteTitle, detail: t.closeNoteMessage(readLanSetting() === true), buttons: [t.ok] });
  }

  /**
   * A copy running from the disk image or App Translocation is asked once per launch whether it should
   * move to Applications, until it moved or the user ticked "Don't ask again"; a copy in another folder is
   * asked only when it is a Developer ID signed release (a developer's own build is never asked). The
   * rule is shouldOfferMove (updates.ts). A move relaunches the app.
   */
  async function offerMoveToApplications(): Promise<void> {
    let inApplications = false;
    try {
      inApplications = !app.isPackaged || app.isInApplicationsFolder();
    } catch {
      return;
    }
    await signatureRead;
    const decision = shouldOfferMove({
      isPackaged: app.isPackaged,
      inApplications,
      declined: prefs.get().moveToApplicationsDeclined === true,
      openedAtLogin,
      selfTest: Boolean(selfTestFile),
      bundle,
      signature,
    });
    if (!decision.offer || !bundle) return;
    const where = decision.location === 'folder' ? t.moveWhere('folder', shortLocation(path.dirname(bundle), os.homedir())) : t.moveWhere(decision.location);
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      message: t.moveTitle,
      detail: t.moveMessage(where),
      buttons: [t.moveNow, t.notNow],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: t.doNotAskAgain,
    });
    if (response !== 0) {
      if (checkboxChecked) await prefs.update({ moveToApplicationsDeclined: true });
      return;
    }
    try {
      log.info('moving the app to the Applications folder');
      app.moveToApplicationsFolder({
        conflictHandler: (conflict) =>
          conflict === 'existsAndRunning' ||
          dialog.showMessageBoxSync({ type: 'question', message: t.moveReplaceTitle, detail: t.moveReplaceMessage, buttons: [t.replace, t.cancel], defaultId: 0, cancelId: 1 }) === 0,
      });
    } catch (err) {
      log.warn(`move to Applications failed: ${(err as Error).message}`);
      await dialog.showMessageBox({ type: 'warning', message: t.moveFailedTitle, detail: t.moveFailedMessage((err as Error).message), buttons: [t.ok] });
    }
  }

  // The versions a bug report asks for, in About too (an attached Dürbün can run another server version).
  const applyAboutPanel = () =>
    app.setAboutPanelOptions({
      applicationName: 'Dürbün',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright © 2026 Muhammed Yusuf Kaynak · MIT License',
      credits: t.aboutCredits(
        `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}${serverVersion ? ` · Server ${serverVersion}` : ''}`,
      ),
    });

  const refreshMenus = () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(appMenuTemplate(t, handlers, { canOpenInBrowser: appOrigin !== null, autoUpdateCheck: prefs.get().autoUpdateCheck, update: updatePhase, openAtLogin })),
    );
    if (tray && !tray.isDestroyed()) {
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(t, state, handlers, { update: updatePhase, openAtLogin })));
      tray.setToolTip(`Dürbün — ${serverLabel(t, state)}`);
      if (trayImages) tray.setImage(trayNeedsAttention(state) ? trayImages.attention : trayImages.plain);
    }
  };

  const setState = (next: ServerState) => {
    state = next;
    refreshMenus();
  };

  const currentTheme = (): Theme => winState.theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  /** What the window shows without a UI: the splash, or why the server could not start. */
  const statusPage = (theme: Theme) =>
    state.kind === 'failed' ? statusPageUrl({ theme, title: t.startFailedTitle, text: state.error, busy: false }) : splashUrl(t.splash, theme);

  const quitFlow = createQuitFlow({
    stop: () => stopServer(),
    quit: () => app.quit(),
    onStopped: () => tray?.destroy(),
  });
  const isQuitting = () => quitFlow.quitting;

  const notifier: Notifier = createNotifier({ log, onClick: showWindow, isFocused: () => !!win && !win.isDestroyed() && win.isFocused() });

  /* ───────────── security: what the renderer may load, ask for and open ───────────── */

  const setupSecurity = () => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ok = isAllowedPermission(permission, details.requestingUrl || wc.getURL(), appOrigin);
      if (!ok) log.debug(`permission "${permission}" denied for ${details.requestingUrl}`);
      callback(ok);
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => isAllowedPermission(permission, requestingOrigin, appOrigin));
    ses.webRequest.onBeforeRequest({ urls: [...REQUEST_FILTER_URLS] }, (details, callback) => {
      const ok = isAllowedRequest(details.url, appOrigin);
      if (!ok) log.debug(`blocked request ${details.url}`);
      callback({ cancel: !ok });
    });
    ses.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
      item.once('done', (_e, result) => {
        if (result === 'completed') app.dock?.downloadFinished(item.getSavePath());
      });
    });
  };

  app.on('web-contents-created', (_event, wc) => {
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      // New windows never open inside the app: same-server files (recordings) and web links go to the browser.
      if (decideNavigation(url, appOrigin) !== 'deny') openExternal(url);
      return { action: 'deny' };
    });
    const guard = (event: { preventDefault(): void }, url: string) => {
      const decision = decideNavigation(url, appOrigin);
      if (decision === 'allow') return;
      event.preventDefault();
      if (decision === 'external') openExternal(url);
      else log.debug(`navigation to ${url} refused`);
    };
    wc.on('will-navigate', (event, url) => guard(event, url));
    wc.on('will-redirect', (event, url) => guard(event, url));
  });

  ipcMain.on('durbun:notify', (event, payload: NotifyRequest) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url)) return;
    if (!payload || typeof payload.id !== 'string') return;
    notifier.show(
      { id: payload.id, title: String(payload.title ?? ''), body: String(payload.body ?? ''), tag: String(payload.tag ?? ''), silent: payload.silent === true },
      event.sender,
    );
  });
  ipcMain.on('durbun:notification-close', (event, id: unknown) => {
    if (isTrustedSender(event.sender, event.senderFrame?.url) && typeof id === 'string') notifier.close(id);
  });
  ipcMain.on('durbun:theme', (event, theme: unknown) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url) || (theme !== 'dark' && theme !== 'light')) return;
    if (win && !win.isDestroyed()) win.setBackgroundColor(THEME_BACKGROUND[theme]);
    if (winState.theme !== theme) {
      winState = { ...winState, theme };
      void writeWindowState(stateFile, winState);
    }
  });

  // Menus, tray and dialogs follow the UI's language (the preload reports <html lang>), so a Turkish UI
  // never sits next to English menus on a Mac whose first system language is English.
  ipcMain.on('durbun:language', (event, lang: unknown) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url) || (lang !== 'tr' && lang !== 'en')) return;
    if (t === STRINGS[lang]) return;
    t = STRINGS[lang];
    log.info(`menu language follows the UI: ${lang}`);
    applyAboutPanel();
    refreshMenus();
  });

  function isTrustedSender(sender: WebContents, frameUrl: string | undefined): boolean {
    return !!win && !win.isDestroyed() && sender === win.webContents && !!appOrigin && !!frameUrl && isAppUrl(frameUrl, appOrigin);
  }

  /* ───────────── window ───────────── */

  function createWindow(): void {
    const primary = screen.getPrimaryDisplay();
    const areas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
    const bounds = fitBounds(winState.bounds, areas);
    const theme = currentTheme();
    const w = new BrowserWindow({
      ...bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: 'Dürbün',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHTS,
      backgroundColor: THEME_BACKGROUND[theme],
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    });
    win = w;
    if (winState.maximized) w.maximize();
    w.once('ready-to-show', () => {
      if (w.isDestroyed()) return;
      // Opened at login: Dürbün captures from the menu bar until the user opens the window.
      if (startHidden) {
        startHidden = false;
        return;
      }
      // A self-test run shows the window without taking the focus from what the user is doing.
      selfTestFile ? w.showInactive() : w.show();
    });

    let saveTimer: NodeJS.Timeout | undefined;
    const saveBounds = () => {
      if (w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return;
      winState = { ...winState, maximized: w.isMaximized(), bounds: w.isMaximized() ? winState.bounds : w.getBounds() };
      void writeWindowState(stateFile, winState);
    };
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveBounds, 400);
    };
    w.on('resize', scheduleSave);
    w.on('move', scheduleSave);
    w.on('close', (event) => {
      saveBounds();
      // macOS: closing the window keeps Dürbün running in the menu bar (capture continues), except while
      // an update closes it to restart.
      if (!isQuitting() && !installingUpdate) {
        event.preventDefault();
        w.hide();
        closeNoteOnce();
      }
    });
    w.on('closed', () => {
      if (win === w) win = null;
    });
    w.on('focus', () => notifier.clearBadge());
    syncFullScreen(w, (on) => {
      if (!w.isDestroyed()) w.webContents.send('durbun:fullscreen', on);
    });

    const wc = w.webContents;
    // UI errors (React error boundaries, uncaught errors) reach main.log, so Help → Show Log has them.
    const rendererErrors = createRateLimiter(30, 60_000);
    wc.on('console-message', (details) => {
      if (selfTestFile && consoleLog.length < 200) consoleLog.push({ level: details.level, message: details.message.slice(0, 2_000), source: details.sourceId });
      if (details.level !== 'error') return;
      const { allowed, dropped } = rendererErrors();
      if (!allowed) return;
      log.warn(`renderer error${dropped ? ` (+${dropped} not logged)` : ''}: ${details.message.slice(0, 4_000)} (${details.sourceId}:${details.lineNumber})`);
    });
    // A hung UI (e.g. a pathological search pattern) gets a way out: the renderer is restarted and the
    // UI drops the saved search it was applying (packages/ui, logs.queryApplying).
    let unresponsiveAsked = false;
    w.on('unresponsive', () => {
      log.warn('UI renderer unresponsive');
      if (unresponsiveAsked || w.isDestroyed()) return;
      unresponsiveAsked = true;
      void dialog
        .showMessageBox(w, { type: 'warning', message: t.unresponsiveTitle, detail: t.unresponsiveMessage, buttons: [t.wait, t.reload], defaultId: 0, cancelId: 0 })
        .then(({ response }) => {
          unresponsiveAsked = false;
          if (response === 1 && !w.isDestroyed()) {
            log.warn('restarting the unresponsive UI renderer');
            wc.forcefullyCrashRenderer();
          }
        });
    });
    w.on('responsive', () => log.info('UI renderer responsive again'));
    // Quick retries first (the server is starting or restarting), then a slow retry behind a status page:
    // the window never stays blank. A successful load starts the count again.
    let retries = 0;
    wc.on('did-start-loading', () => {
      uiLoaded = false;
    });
    wc.on('did-finish-load', () => {
      if (!appOrigin || !isAppUrl(wc.getURL(), appOrigin)) return;
      retries = 0;
      uiLoaded = true;
      deliverOpenedFiles();
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || !appOrigin || !isAppUrl(url, appOrigin) || code === -3 /* aborted */) return;
      log.warn(`UI load failed (${code} ${description}) for ${url}`);
      retries++;
      if (retries === 11) void w.loadURL(statusPageUrl({ theme: currentTheme(), text: t.uiLoadRetrying, busy: true }));
      setTimeout(() => !w.isDestroyed() && w.loadURL(url), retries <= 10 ? 1_000 : 10_000);
    });
    const reloads = createReloadGuard();
    wc.on('render-process-gone', (_e, details) => {
      log.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`);
      if (details.reason === 'clean-exit' || !appOrigin || w.isDestroyed()) return;
      if (reloads.allow()) {
        setTimeout(() => !w.isDestroyed() && appOrigin && w.loadURL(appOrigin), 500);
        return;
      }
      log.error('the UI keeps crashing; automatic reloads stopped');
      void dialog
        .showMessageBox(w, { type: 'warning', message: t.uiCrashedTitle, detail: t.uiCrashedMessage(details.reason), buttons: [t.reload, t.showLog], defaultId: 0, cancelId: 1 })
        .then(({ response }) => {
          if (response === 1) shell.showItemInFolder(log.file);
          else if (!w.isDestroyed() && appOrigin) {
            reloads.reset();
            void w.loadURL(appOrigin);
          }
        });
    });

    void w.loadURL(appOrigin ?? statusPage(theme));
  }

  /**
   * Show the UI of the server on `port`. First, once per port, the UI preferences of the localhost origin
   * the window used up to 0.1.x move to `origin`; its page zoom moves once (storageMigration.ts).
   */
  async function loadUi(port: number, origin: string): Promise<void> {
    await moveUiPreferences(port, origin);
    if (isQuitting()) return;
    appOrigin = origin;
    refreshMenus();
    if (!win || win.isDestroyed()) createWindow();
    else void win.loadURL(origin);
    if (win) moveZoomLevel(win, origin);
    if (selfTestFile && win) {
      win.webContents.once('did-finish-load', () =>
        void runSelfTest({
          reportFile: selfTestFile,
          wc: win!.webContents,
          externalOpened,
          consoleLog,
          notifier,
          info: () => ({
            language: t === STRINGS.tr ? 'tr' : 'en',
            preferredSystemLanguages: app.getPreferredSystemLanguages(),
            state,
            trayLabel: serverLabel(t, state),
            tray: !!tray && !tray.isDestroyed(),
            appOrigin,
            dataDir,
            shellEnv: shellEnv && { shell: shellEnv.result.shell, ms: shellEnv.result.ms, error: shellEnv.result.error, changed: shellEnv.changed },
            path: process.env.PATH,
            windowBounds: win && !win.isDestroyed() ? win.getBounds() : null,
            windowButtonPosition: win && !win.isDestroyed() ? win.getWindowButtonPosition() : null,
            zoomLevel: win && !win.isDestroyed() ? win.webContents.getZoomLevel() : null,
            isPackaged: app.isPackaged,
            logFile: log.file,
          }),
          quit: () => app.quit(),
        }),
      );
    }
  }

  /**
   * Chromium keeps the zoom per host, so the localhost level of 0.1.x would reset once on 127.0.0.1. It is
   * read from the profile's Preferences and set when the window first shows the UI on the new host;
   * Chromium then keeps it for that host. Never by loading http://localhost (::1 may be another program).
   */
  function moveZoomLevel(w: BrowserWindow, origin: string): void {
    if (zoomChecked) return;
    zoomChecked = true;
    const host = new URL(origin).hostname;
    const plan = planZoomMove(migrationFile, path.join(app.getPath('userData'), 'Preferences'), host);
    const record = () => void recordZoomMoved(migrationFile).catch((err) => log.warn(`could not record the zoom move: ${(err as Error).message}`));
    if (plan.kind === 'none') record();
    if (plan.kind !== 'move') return;
    const wc = w.webContents;
    const onLoad = () => {
      let shown = '';
      try {
        shown = new URL(wc.getURL()).hostname;
      } catch {
        /* not a URL yet */
      }
      if (shown !== host) return; // the splash or a status page: wait for the UI
      wc.off('did-finish-load', onLoad);
      if (applyZoomLevel(wc, plan.level)) log.info(`page zoom ${plan.level} moved from ${LEGACY_HOST} to ${host}`);
      record();
    };
    wc.on('did-finish-load', onLoad);
  }

  async function moveUiPreferences(port: number, origin: string): Promise<void> {
    const file = migrationFile;
    // A hidden window shows empty data: documents of both origins (no request leaves the app).
    const page = async () => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
      return {
        open: async (o: string) => {
          await w.loadURL(BLANK_PAGE, { baseURLForDataURL: `${o}/` });
        },
        run: <T,>(script: string) => w.webContents.executeJavaScript(script, true) as Promise<T>,
        close: () => {
          if (!w.isDestroyed()) w.destroy();
        },
      };
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        migrateUiStorage(port, file, page, origin),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), STORAGE_MIGRATION_TIMEOUT_MS);
        }),
      ]);
      if (result === 'timeout') log.warn(`moving the UI preferences to ${origin} takes too long; the window opens without waiting`);
      else if (result.kind === 'moved') log.info(`UI preferences: ${result.keys} key(s) copied from ${legacyOriginFor(port)} to ${origin}`);
    } catch (err) {
      log.warn(`UI preferences could not be moved to ${origin}: ${(err as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ───────────── server ───────────── */

  async function startOrAttach(): Promise<void> {
    stopWatch?.();
    stopWatch = null;
    const wasFailed = state.kind === 'failed';
    setState({ kind: 'starting' });
    if (wasFailed && !appOrigin && win && !win.isDestroyed()) void win.loadURL(statusPage(currentTheme()));
    const paths = serverPaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
    if (!existsSync(paths.entry)) return fail(t.missingBundle(paths.entry));
    let mod: ServerModule;
    try {
      mod = (await import(pathToFileURL(paths.entry).href)) as ServerModule;
      if (typeof mod.startServer !== 'function') throw new Error(`${paths.entry} does not export startServer`);
    } catch (err) {
      return fail(`${(err as Error).message}`);
    }
    const httpPort = parsePortEnv(process.env.DURBUN_PORT, DEFAULT_HTTP_PORT);
    const sdkPort = parsePortEnv(process.env.DURBUN_SDK_PORT, DEFAULT_SDK_PORT);
    const uiDir = existsSync(path.join(paths.uiDir, 'index.html')) ? paths.uiDir : undefined;
    const verbose = Boolean(process.env.DURBUN_DEBUG);
    // "Is it a real Dürbün?": the server's own health check (GET /api/health), plus a semver version and
    // the Dürbün UI (or its no-UI page) at "/" before the window is handed to it.
    const health = (port: number) => (typeof mod.probeServer === 'function' ? mod.probeServer(port) : probeDurbun(port));
    const probe = (port: number) => proveDurbun(port, { health });
    const outcome = await startOrAttachServer(httpPort, sdkPort, {
      probe,
      isFree: isPortFree,
      cancelled: isQuitting,
      onBusy: (port) => log.warn(`port ${port} turned out to be busy; trying the next one`),
      start: (port) => {
        log.info(`starting the server on port ${port || '(auto)'} / SDK ${sdkPort}, data ${dataDir}, ui ${uiDir ?? '(none)'}`);
        const p = mod.startServer({ httpPort: port, sdkPort, demo: process.env.DURBUN_DEMO === '1', dataDir, uiDir, verbose }, { logger: log.scoped('durbun', { debug: verbose }) });
        startInFlight = p;
        return p.finally(() => {
          if (startInFlight === p) startInFlight = null;
        });
      },
    });
    if (isQuitting() || outcome.kind === 'cancelled') return; // a server started meanwhile is stopped by stopServer()
    if (outcome.kind === 'failed') return fail(outcome.error);
    if (outcome.kind === 'attached') {
      const warnings = attachNotices(t, outcome, bundledServerVersion(mod, app.getVersion()));
      log.info(`a Dürbün ${outcome.version} already runs on port ${outcome.port} (${outcome.page ?? 'ui'}); opening ${outcome.origin}`);
      for (const w of warnings) log.warn(w);
      serverVersion = outcome.version;
      applyAboutPanel();
      setState({ kind: 'attached', port: outcome.port, warnings });
      await loadUi(outcome.port, outcome.origin);
      if (isQuitting()) return;
      startAutoUpdates();
      // When that Dürbün stops (its terminal closed), this app starts its own server instead of
      // leaving the window on a dead page.
      stopWatch = watchAttached(outcome.port, {
        probe,
        onGone: () => {
          stopWatch = null;
          if (isQuitting()) return;
          log.warn(`the Dürbün on port ${outcome.port} stopped answering; starting this app's own server`);
          void startOrAttach();
        },
      });
      return;
    }
    const started = outcome.server;
    server = started;
    const { port, origin } = startedOrigin(started, outcome.port);
    const fallback = outcome.fallback ? [t.portFallbackNotice(httpPort, port)] : [];
    const shell = shellWarnings();
    // The log keeps the server's own (English) wording; the tray speaks the app's language.
    for (const w of [...fallback, ...(started.warnings ?? []), ...shell]) log.warn(w);
    const warnings = [...fallback, ...serverWarnings(t, started), ...shell];
    log.info(`server running at ${origin}`);
    serverVersion = bundledServerVersion(mod, app.getVersion());
    applyAboutPanel();
    setState({ kind: 'running', port, warnings });
    await loadUi(port, origin);
    startAutoUpdates();
  }

  /** The login shell could not be asked: say so, tools may then be missing (Finder's bare PATH). */
  function shellWarnings(): string[] {
    const r = shellEnv?.result;
    if (!r || r.env) return [];
    return [t.shellEnvNotice(path.basename(r.shell), r.timedOut ? SHELL_ENV_TIMEOUT_MS / 1000 : undefined)];
  }

  async function fail(message: string): Promise<void> {
    log.error(`server start failed: ${message}`);
    setState({ kind: 'failed', error: message });
    if (isQuitting()) return;
    if (selfTestFile) {
      await writeSelfTestFailure(message);
      app.quit();
      return;
    }
    // The window says why instead of "starting…", and the dialog keeps Retry within reach.
    appOrigin = null;
    refreshMenus();
    if (win && !win.isDestroyed()) void win.loadURL(statusPage(currentTheme()));
    showWindow();
    const options = {
      type: 'error' as const,
      message: t.startFailedTitle,
      detail: `${t.startFailedMessage}\n\n${message}`,
      buttons: [t.retry, t.showLog, t.trayQuit],
      defaultId: 0,
      cancelId: 2,
    };
    const choices: FailureChoice[] = ['retry', 'log', 'quit'];
    const choice = await resolveFailure(
      async () => {
        const parent = win && !win.isDestroyed() ? win : undefined;
        const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return choices[response] ?? 'quit';
      },
      () => shell.showItemInFolder(log.file),
      isQuitting,
    );
    if (choice === 'retry') return startOrAttach();
    if (choice === 'quit') app.quit();
  }

  async function writeSelfTestFailure(message: string): Promise<void> {
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(selfTestFile, JSON.stringify({ error: message, state }, null, 2) + '\n');
    } catch {
      /* ignore */
    }
  }

  async function stopServer(): Promise<void> {
    // A quit during the start waits for it, so drivers that already spawned adb/log stream get stopped.
    let s = server;
    if (!s && startInFlight) s = await startInFlight.catch(() => null);
    server = null;
    if (!s) return;
    log.info('stopping the server');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      s.stop().then(
        () => log.info('server stopped'),
        (err) => log.warn(`server stop failed: ${(err as Error).message}`),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn(`server stop timed out after ${STOP_TIMEOUT_MS / 1000} s`);
          resolve();
        }, STOP_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /* ───────────── lifecycle ───────────── */

  app.on('second-instance', () => {
    log.info('second launch: bringing the window forward');
    showWindow();
  });
  app.on('activate', () => showWindow());
  // Stay in the menu bar when the window closes (it is only hidden anyway), except during a quit.
  app.on('window-all-closed', () => quitFlow.windowAllClosed());
  app.on('before-quit', (event) => {
    stopWatch?.();
    stopWatch = null;
    quitFlow.beforeQuit(event);
  });
  // `kill`, Ctrl+C in a terminal, logout: same clean path (adb/log stream children get stopped).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      log.info(`${signal} received; quitting`);
      app.quit();
    });
  }

  app.whenReady().then(async () => {
    t = STRINGS[pickLanguage(app.getPreferredSystemLanguages())];
    applyAboutPanel();
    void prefs.update({ launches: (prefs.get().launches ?? 0) + 1 });
    if (app.isPackaged) {
      try {
        const login = app.getLoginItemSettings();
        openAtLogin = login.openAtLogin;
        openedAtLogin = login.wasOpenedAtLogin === true && !selfTestFile;
        startHidden = openedAtLogin;
        if (openedAtLogin) log.info('opened at login: the window stays hidden');
      } catch (err) {
        log.warn(`login item state unavailable: ${(err as Error).message}`);
      }
    }
    signatureRead = readSignature();
    // Crashpad keeps every minidump: the old ones go (30 days, newest 20 kept).
    void pruneCrashDumps(app.getPath('crashDumps')).then((n) => n > 0 && log.info(`removed ${n} old crash dump(s)`));
    if (!app.isPackaged && process.platform === 'darwin') {
      const icon = devIconPath(app.getAppPath());
      if (existsSync(icon)) app.dock?.setIcon(icon);
    }
    setupSecurity();
    try {
      const image = (badge: boolean) => {
        const img = nativeImage.createFromBitmap(renderTrayBitmap(36, 3, badge), { width: 36, height: 36, scaleFactor: 2 });
        img.setTemplateImage(true);
        return img;
      };
      trayImages = { plain: image(false), attention: image(true) };
      tray = new Tray(trayImages.plain);
    } catch (err) {
      log.warn(`menu-bar icon unavailable: ${(err as Error).message}`);
    }
    refreshMenus();
    if (!win || win.isDestroyed()) createWindow();
    // Before the server starts: a move relaunches the app.
    await offerMoveToApplications();
    if (isQuitting()) return;

    shellEnv = await envReady;
    const r = shellEnv.result;
    log.info(
      `login shell ${r.shell}: ${r.env ? `ok in ${r.ms} ms` : `unavailable (${r.error ?? 'unknown'}) after ${r.ms} ms`}; updated ${shellEnv.changed.join(', ') || 'nothing'}`,
    );
    await startOrAttach();
  });
}
