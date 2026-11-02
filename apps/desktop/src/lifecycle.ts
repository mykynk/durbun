/**
 * Quit coordination (no Electron import, so it is unit-tested). The first 'before-quit' is held until
 * the embedded server stopped (adb / log stream children included); then the quit is issued again and
 * goes through. Electron can drop that second quit when it races a page load: the last window then
 * closes as an ordinary 'window-all-closed' instead of 'will-quit' (Electron 45, ⌘Q or SIGTERM while
 * the UI page was loading), and the process stayed alive with no window, tray or server, still holding
 * the single-instance lock. 'window-all-closed' during a quit therefore issues the quit once more.
 */

export interface QuitFlowDeps {
  /** Stop the server; resolves even when stopping fails or times out. */
  stop(): Promise<void>;
  /** app.quit() */
  quit(): void;
  /** Runs once the server stopped, right before the quit is issued again (tray, watchers). */
  onStopped?(): void;
}

export interface QuitFlow {
  /** True from the first quit request on. */
  readonly quitting: boolean;
  /** app 'before-quit' */
  beforeQuit(event: { preventDefault(): void }): void;
  /** app 'window-all-closed': keep running in the menu bar, unless a quit is under way. */
  windowAllClosed(): void;
}

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
  let quitting = false;
  let stopped = false;
  let stopping: Promise<void> | null = null;
  return {
    get quitting() {
      return quitting;
    },
    beforeQuit(event) {
      quitting = true;
      if (stopped) return;
      event.preventDefault();
      stopping ??= deps
        .stop()
        .catch(() => undefined)
        .finally(() => {
          stopped = true;
          deps.onStopped?.();
          deps.quit();
        });
    },
    windowAllClosed() {
      if (quitting) deps.quit();
    },
  };
}
