/**
 * The update conversation (no Electron import, so it is unit-tested with fakes). Every step that changes
 * something waits for a yes:
 *
 *   check (one GET of the feed) → "Dürbün X is available, download and install?" (with the release notes)
 *     → yes: Squirrel.Mac downloads in the background, the menu says so and the Dock shows activity
 *       → "ready, restart now?" → yes: the server stops cleanly, the app restarts into the new version
 *
 * A copy that cannot replace itself (a local unsigned build, a copy running from the disk image) is offered
 * the disk image for this Mac instead. Any failure says what happened and offers that same disk image.
 * Automatic checks run only after the user said yes once (askAboutAutoCheck) and stay silent unless a new
 * version is there.
 */
import type { DesktopPrefs } from './desktopPrefs';
import type { Strings } from './i18n';
import {
  checkForUpdates,
  dmgFileName,
  downloadUrl,
  feedUrl,
  formatSize,
  notesExcerpt,
  releasePageUrl,
  RELEASES_URL,
  type FeedRelease,
  type SelfUpdate,
  type UpdateArch,
  type UpdateCheck,
} from './updates';

export type UpdatePhase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'downloading'; version: string } | { kind: 'ready'; version: string };

export interface MessageBoxRequest {
  type: 'info' | 'warning' | 'question' | 'error';
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface UpdateFlowDeps {
  /** The current language (menus and dialogs follow the UI). */
  t(): Strings;
  currentVersion: string;
  arch: UpdateArch;
  /** GET with no identifier; resolves to the status and the parsed JSON body (null when not JSON). */
  get(url: string): Promise<{ status: number; body: unknown }>;
  selfUpdate(): SelfUpdate;
  box(request: MessageBoxRequest): Promise<number>;
  openExternal(url: string): void;
  /** Squirrel.Mac: setFeedURL({ url, serverType: 'json' }) + checkForUpdates() (downloads when newer). */
  startDownload(feed: string): void;
  /** Stop the server, let the window close, autoUpdater.quitAndInstall(). */
  restart(): Promise<void>;
  prefs: { get(): DesktopPrefs; update(patch: Partial<DesktopPrefs>): Promise<void> };
  onPhase(phase: UpdatePhase): void;
  log: { info(message: string): void; warn(message: string): void };
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Squirrel reports no progress; a download that says nothing for this long is treated as failed. */
export const DOWNLOAD_WATCHDOG_MS = 30 * 60 * 1000;

export interface UpdateFlow {
  readonly phase: UpdatePhase;
  /** Help → Check for Updates… ('manual': every outcome is shown) or the daily check ('auto': only news). */
  check(mode: 'manual' | 'auto'): Promise<void>;
  /** The one-time question about automatic checks. */
  askAboutAutoCheck(): Promise<void>;
  setAutoCheck(on: boolean): Promise<void>;
  /** The menu item while an update waits: asks before restarting. */
  offerRestart(): Promise<void>;
  /** autoUpdater events. */
  downloaded(): void;
  notAvailable(): void;
  failed(message: string): void;
}

export function createUpdateFlow(deps: UpdateFlowDeps): UpdateFlow {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  let phase: UpdatePhase = { kind: 'idle' };
  let watchdog: unknown;
  let asking = false;

  const setPhase = (next: UpdatePhase) => {
    phase = next;
    deps.onPhase(next);
  };
  const dmgUrl = (version: string) => downloadUrl(version, dmgFileName(version, deps.arch));
  const archName = () => (deps.arch === 'arm64' ? 'Apple silicon' : 'Intel');

  /** One dialog at a time: a daily check never stacks on top of a question the user has not answered. */
  async function ask(request: MessageBoxRequest): Promise<number> {
    asking = true;
    try {
      return await deps.box(request);
    } finally {
      asking = false;
    }
  }

  async function report(result: UpdateCheck, mode: 'manual' | 'auto'): Promise<void> {
    const t = deps.t();
    if (result.kind === 'newer') {
      if (mode === 'auto' && deps.prefs.get().skippedVersion === result.release.version) return;
      return offer(result.release, mode);
    }
    if (mode === 'auto') return;
    if (result.kind === 'current') {
      await ask({ type: 'info', message: t.upToDateTitle, detail: t.upToDateMessage(result.version), buttons: [t.ok] });
      return;
    }
    const detail = result.kind === 'noFeed' ? t.updateNoFeedMessage : t.updateCheckFailedMessage(result.error);
    const r = await ask({ type: 'warning', message: t.updateCheckFailedTitle, detail, buttons: [t.openReleases, t.closeDialog], defaultId: 0, cancelId: 1 });
    if (r === 0) deps.openExternal(`${RELEASES_URL}/latest`);
  }

  async function offer(release: FeedRelease, mode: 'manual' | 'auto'): Promise<void> {
    const t = deps.t();
    const support = deps.selfUpdate();
    const notes = notesExcerpt(release.notes);
    const lead = support.ok
      ? t.updateInstallMessage(deps.currentVersion, formatSize(release.size))
      : t.updateManualMessage(deps.currentVersion, t.updateManualReason(support.reason), archName());
    const detail = notes ? `${lead}\n\n${t.whatsNew}\n${notes}` : lead;
    const buttons = [support.ok ? t.downloadAndInstall : t.downloadDiskImage, t.readWhatsNew, t.later];
    if (mode === 'auto') buttons.push(t.skipVersion);
    for (;;) {
      const r = await ask({ type: 'info', message: t.updateAvailableTitle(release.version), detail, buttons, defaultId: 0, cancelId: 2 });
      if (r === 1) {
        // The full notes on the release page; the question stays open.
        deps.openExternal(releasePageUrl(release.version));
        continue;
      }
      if (r === 0) {
        if (support.ok) startDownload(release.version);
        else deps.openExternal(dmgUrl(release.version));
      } else if (r === 3) {
        await deps.prefs.update({ skippedVersion: release.version });
      }
      return;
    }
  }

  function startDownload(version: string): void {
    deps.log.info(`update: downloading ${version}`);
    setPhase({ kind: 'downloading', version });
    watchdog = setTimer(() => {
      watchdog = undefined;
      if (phase.kind === 'downloading') flow.failed(`no answer after ${DOWNLOAD_WATCHDOG_MS / 60_000} minutes`);
    }, DOWNLOAD_WATCHDOG_MS);
    try {
      deps.startDownload(feedUrl(deps.arch));
    } catch (err) {
      flow.failed((err as Error)?.message ?? String(err));
    }
  }

  function stopWatchdog(): void {
    if (watchdog !== undefined) clearTimer(watchdog);
    watchdog = undefined;
  }

  async function askRestart(version: string): Promise<void> {
    const t = deps.t();
    const r = await ask({ type: 'info', message: t.updateReadyTitle(version), detail: t.updateReadyMessage, buttons: [t.restartNow, t.later], defaultId: 0, cancelId: 1 });
    if (r !== 0 || phase.kind !== 'ready') return;
    deps.log.info(`update: restarting into ${version}`);
    try {
      await deps.restart();
    } catch (err) {
      flow.failed((err as Error)?.message ?? String(err));
    }
  }

  const flow: UpdateFlow = {
    get phase() {
      return phase;
    },

    async check(mode) {
      const t = deps.t();
      if (phase.kind === 'downloading') {
        if (mode === 'manual') await ask({ type: 'info', message: t.updateDownloadingTitle(phase.version), detail: t.updateDownloadingMessage, buttons: [t.ok] });
        return;
      }
      if (phase.kind === 'ready') {
        if (mode === 'manual') await askRestart(phase.version);
        return;
      }
      if (phase.kind === 'checking' || (mode === 'auto' && asking)) return;
      setPhase({ kind: 'checking' });
      let result: UpdateCheck;
      try {
        result = await checkForUpdates(deps.currentVersion, deps.arch, deps.get);
      } finally {
        setPhase({ kind: 'idle' });
      }
      if (mode === 'auto') await deps.prefs.update({ lastUpdateCheck: now() });
      deps.log.info(`update check (${mode}): ${result.kind === 'newer' ? `newer ${result.release.version}` : JSON.stringify(result)}`);
      await report(result, mode);
    },

    async askAboutAutoCheck() {
      if (asking || deps.prefs.get().autoUpdateCheck !== undefined) return;
      const t = deps.t();
      const r = await ask({ type: 'question', message: t.autoCheckTitle, detail: t.autoCheckMessage, buttons: [t.autoCheckYes, t.autoCheckNo], defaultId: 0, cancelId: 1 });
      await flow.setAutoCheck(r === 0);
    },

    async setAutoCheck(on) {
      deps.log.info(`automatic update checks ${on ? 'on' : 'off'}`);
      await deps.prefs.update({ autoUpdateCheck: on });
    },

    async offerRestart() {
      if (phase.kind === 'ready') await askRestart(phase.version);
    },

    downloaded() {
      if (phase.kind !== 'downloading') return;
      stopWatchdog();
      const { version } = phase;
      deps.log.info(`update: ${version} downloaded`);
      setPhase({ kind: 'ready', version });
      void askRestart(version);
    },

    notAvailable() {
      // The feed changed between the question and the download (a release was pulled back).
      if (phase.kind === 'downloading') flow.failed('the update is no longer offered');
    },

    failed(message) {
      deps.log.warn(`update failed: ${message}`);
      if (phase.kind !== 'downloading' && phase.kind !== 'ready') return;
      stopWatchdog();
      const { version } = phase;
      setPhase({ kind: 'idle' });
      const t = deps.t();
      void ask({ type: 'warning', message: t.updateFailedTitle, detail: t.updateFailedMessage(message, archName()), buttons: [t.downloadDiskImage, t.closeDialog], defaultId: 0, cancelId: 1 }).then((r) => {
        if (r === 0) deps.openExternal(dmgUrl(version));
      });
    },
  };
  return flow;
}
