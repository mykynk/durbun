/**
 * Dürbün for macOS (SPEC §10.7). Double-click → the Dürbün server starts inside this process (the
 * bundled dist/server.mjs, UI from dist/ui) and its UI opens in a window. No terminal, no commands.
 *
 *  - single instance (a second launch focuses the window)
 *  - PATH / ANDROID_HOME / … from the login shell before the server starts (Finder gives a bare env)
 *  - port 9750 / SDK 9751 (DURBUN_PORT / DURBUN_SDK_PORT override); a Dürbün already on the port is
 *    reused; a port held by another program → a nearby free port
 *  - data dir ~/.durbun (shared with the CLI; DURBUN_DATA_DIR overrides; DURBUN_USER_DATA_DIR moves the
 *    Electron profile, DURBUN_DEMO=1 starts with demo data, DURBUN_DEBUG=1 logs verbosely)
 *  - menu-bar item, closing the window keeps capturing; Quit (⌘Q / menu bar) stops the server cleanly
 *  - the window only ever loads the local server; links open in the default browser
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, session, shell, Tray, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DESKTOP_CSS, splashUrl, TRAFFIC_LIGHTS } from './chrome';
import { applyLoginShellEnv, type ShellEnvKey, type ShellEnvResult } from './env';
import { pickLanguage, STRINGS, type Strings } from './i18n';
import { installFileLog, type FileLog } from './log';
import { appMenuTemplate, serverLabel, trayMenuTemplate, type MenuHandlers, type ServerState } from './menu';
import { decideNavigation, isAllowedPermission, isAllowedRequest, isAppUrl, REQUEST_FILTER_URLS } from './navigation';
import { createNotifier, type Notifier, type NotifyRequest } from './notifier';
import { devIconPath, serverPaths } from './paths';
import { DEFAULT_HTTP_PORT, DEFAULT_SDK_PORT, defaultPortDeps, parsePortEnv, planHttpPort } from './ports';
import { runSelfTest } from './selftest';
import { renderTrayBitmap } from './trayIcon';
import { fitBounds, MIN_SIZE, readWindowState, THEME_BACKGROUND, writeWindowState, type Theme, type WindowState } from './windowState';

/** The part of dist/server.mjs this app uses (packages/server/src/server.ts). */
interface EmbeddedServer {
  url: string;
  info: { ports?: { http?: number; sdk?: number } };
  warnings: string[];
  sdkListening: boolean;
  stop(): Promise<void>;
}
interface ServerModule {
  startServer(opts: {
    httpPort: number;
    sdkPort: number;
    demo: boolean;
    dataDir: string;
    uiDir?: string;
    verbose: boolean;
  }): Promise<EmbeddedServer>;
}

const STOP_TIMEOUT_MS = 12_000;
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
  let quitting = false;
  let stopped = false;
  let shellEnv: { result: ShellEnvResult; changed: ShellEnvKey[] } | null = null;
  const externalOpened: string[] = [];
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  let winState: WindowState = readWindowState(stateFile);
  const dataDir = process.env.DURBUN_DATA_DIR ? path.resolve(process.env.DURBUN_DATA_DIR) : path.join(os.homedir(), '.durbun');

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
  };

  const refreshMenus = () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(t, handlers, { canOpenInBrowser: appOrigin !== null })));
    if (tray && !tray.isDestroyed()) {
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(t, state, handlers)));
      tray.setToolTip(`Dürbün — ${serverLabel(t, state)}`);
    }
  };

  const setState = (next: ServerState) => {
    state = next;
    refreshMenus();
  };

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

  function isTrustedSender(sender: WebContents, frameUrl: string | undefined): boolean {
    return !!win && !win.isDestroyed() && sender === win.webContents && !!appOrigin && !!frameUrl && isAppUrl(frameUrl, appOrigin);
  }

  /* ───────────── window ───────────── */

  function createWindow(): void {
    const primary = screen.getPrimaryDisplay();
    const areas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
    const bounds = fitBounds(winState.bounds, areas);
    const theme: Theme = winState.theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
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
      if (!w.isDestroyed()) w.show();
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
      // macOS: closing the window keeps Dürbün running in the menu bar (capture continues).
      if (!quitting) {
        event.preventDefault();
        w.hide();
      }
    });
    w.on('closed', () => {
      if (win === w) win = null;
    });
    w.on('focus', () => notifier.clearBadge());
    w.on('enter-full-screen', () => w.webContents.send('durbun:fullscreen', true));
    w.on('leave-full-screen', () => w.webContents.send('durbun:fullscreen', false));

    const wc = w.webContents;
    wc.on('dom-ready', () => {
      if (appOrigin && isAppUrl(wc.getURL(), appOrigin)) wc.insertCSS(DESKTOP_CSS).catch(() => undefined);
    });
    let retries = 0;
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || !appOrigin || !isAppUrl(url, appOrigin) || code === -3 /* aborted */) return;
      log.warn(`UI load failed (${code} ${description}) for ${url}`);
      if (retries++ < 10) setTimeout(() => !w.isDestroyed() && w.loadURL(url), 1_000);
    });
    wc.on('render-process-gone', (_e, details) => {
      log.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`);
      if (details.reason !== 'clean-exit' && appOrigin && !w.isDestroyed()) setTimeout(() => !w.isDestroyed() && w.loadURL(appOrigin!), 500);
    });

    void w.loadURL(appOrigin ?? splashUrl(t.splash, theme));
  }

  function loadUi(origin: string): void {
    appOrigin = origin;
    refreshMenus();
    if (!win || win.isDestroyed()) createWindow();
    else void win.loadURL(origin);
    if (selfTestFile && win) {
      win.webContents.once('did-finish-load', () =>
        void runSelfTest({
          reportFile: selfTestFile,
          wc: win!.webContents,
          externalOpened,
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
            isPackaged: app.isPackaged,
            logFile: log.file,
          }),
          quit: () => app.quit(),
        }),
      );
    }
  }

  /* ───────────── server ───────────── */

  async function startOrAttach(): Promise<void> {
    setState({ kind: 'starting' });
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
    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const plan = await planHttpPort(httpPort, sdkPort, defaultPortDeps);
      if (quitting) return;
      if (plan.kind === 'attach') {
        log.info(`a Dürbün ${plan.version} already runs on port ${plan.port}; opening it`);
        setState({ kind: 'attached', port: plan.port });
        loadUi(`http://localhost:${plan.port}`);
        return;
      }
      try {
        log.info(`starting the server on port ${plan.port || '(auto)'} / SDK ${sdkPort}, data ${dataDir}, ui ${uiDir ?? '(none)'}`);
        startInFlight = mod.startServer({
          httpPort: plan.port,
          sdkPort,
          demo: process.env.DURBUN_DEMO === '1',
          dataDir,
          uiDir,
          verbose: Boolean(process.env.DURBUN_DEBUG),
        });
        const started = await startInFlight.finally(() => {
          startInFlight = null;
        });
        if (quitting) return; // quit was requested meanwhile; stopServer() took over this server
        server = started;
        const port = started.info?.ports?.http ?? (Number(new URL(started.url).port) || plan.port);
        const warnings = [...started.warnings];
        if (plan.fallback) warnings.unshift(t.portFallbackNotice(httpPort, port));
        for (const w of warnings) log.warn(w);
        log.info(`server running at ${started.url}`);
        setState({ kind: 'running', port, warnings });
        loadUi(`http://localhost:${port}`);
        return;
      } catch (err) {
        const e = err as Error & { code?: string };
        lastError = e.message;
        if (e.code === 'EADDRINUSE') {
          log.warn(`port ${plan.port} became busy; trying again`);
          continue;
        }
        return fail(e.message);
      }
    }
    return fail(lastError || 'no free port');
  }

  async function fail(message: string): Promise<void> {
    log.error(`server start failed: ${message}`);
    setState({ kind: 'failed', error: message });
    if (selfTestFile) {
      await writeSelfTestFailure(message);
      app.quit();
      return;
    }
    const parent = win && !win.isDestroyed() ? win : undefined;
    const options = {
      type: 'error' as const,
      message: t.startFailedTitle,
      detail: `${t.startFailedMessage}\n\n${message}`,
      buttons: [t.retry, t.showLog, t.trayQuit],
      defaultId: 0,
      cancelId: 2,
    };
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (response === 0) return startOrAttach();
    if (response === 1) shell.showItemInFolder(log.file);
    else app.quit();
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
  app.on('window-all-closed', () => {
    // Stay in the menu bar (the window is only hidden on close anyway).
  });

  let stopping: Promise<void> | null = null;
  app.on('before-quit', (event) => {
    quitting = true;
    if (stopped) return;
    event.preventDefault();
    stopping ??= stopServer().finally(() => {
      stopped = true;
      tray?.destroy();
      app.quit();
    });
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
    app.setAboutPanelOptions({
      applicationName: 'Dürbün',
      applicationVersion: app.getVersion(),
      credits: t === STRINGS.tr ? 'Android ve iOS için canlı log, ağ ve performans izleyici' : 'Live logs, network and performance inspector for Android and iOS',
    });
    if (!app.isPackaged && process.platform === 'darwin') {
      const icon = devIconPath(app.getAppPath());
      if (existsSync(icon)) app.dock?.setIcon(icon);
    }
    setupSecurity();
    try {
      const image = nativeImage.createFromBitmap(renderTrayBitmap(36, 3), { width: 36, height: 36, scaleFactor: 2 });
      image.setTemplateImage(true);
      tray = new Tray(image);
    } catch (err) {
      log.warn(`menu-bar icon unavailable: ${(err as Error).message}`);
    }
    refreshMenus();
    if (!win || win.isDestroyed()) createWindow();

    shellEnv = await envReady;
    const r = shellEnv.result;
    log.info(
      `login shell ${r.shell}: ${r.env ? `ok in ${r.ms} ms` : `unavailable (${r.error ?? 'unknown'}) after ${r.ms} ms`}; updated ${shellEnv.changed.join(', ') || 'nothing'}`,
    );
    await startOrAttach();
  });
}
