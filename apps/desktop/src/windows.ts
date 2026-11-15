/**
 * Window bookkeeping for more than one window (no Electron import, so it is unit-tested). Every window
 * shows the same local server; each one keeps its own device, app and tab in the UI.
 *
 *  - the first window is the main one: only its size and place are saved, and closing it hides it (the app
 *    keeps capturing in the menu bar); other windows close for good
 *  - "the window" for the Dock, a second launch, a notification without a sender, Settings…, files opened
 *    from Finder: the focused one, else the one focused last
 *  - the "keeps running in the menu bar" note belongs to closing the LAST visible window
 */
import type { Rect } from './windowState';

export interface WindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  readonly webContents: { readonly id: number };
}

export interface WindowRegistry<W extends WindowLike> {
  add(w: W, opts?: { main?: boolean }): void;
  remove(w: W): void;
  /** The window was focused: it becomes the most recent. */
  focused(w: W): void;
  /** Live windows, most recently focused first. */
  all(): W[];
  readonly size: number;
  main(): W | undefined;
  isMain(w: W): boolean;
  /** The focused window, else the most recently focused live one (visible ones first). */
  current(): W | undefined;
  /** The live window showing these web contents (IPC sender check). */
  byWebContentsId(id: number): W | undefined;
  /** Visible windows other than `except`. */
  visibleOthers(except: W): number;
}

export function createWindowRegistry<W extends WindowLike>(): WindowRegistry<W> {
  // Most recently focused first.
  let order: W[] = [];
  let mainWindow: W | undefined;
  const live = () => {
    order = order.filter((w) => !w.isDestroyed());
    if (mainWindow?.isDestroyed()) mainWindow = undefined;
    return order;
  };
  return {
    add(w, opts = {}) {
      if (order.includes(w)) return;
      order.unshift(w);
      if (opts.main || !mainWindow || mainWindow.isDestroyed()) mainWindow = w;
    },
    remove(w) {
      order = order.filter((x) => x !== w);
      if (mainWindow === w) mainWindow = undefined;
    },
    focused(w) {
      if (!order.includes(w)) return;
      order = [w, ...order.filter((x) => x !== w)];
    },
    all: () => [...live()],
    get size() {
      return live().length;
    },
    main: () => (live(), mainWindow),
    isMain: (w) => w === mainWindow,
    current() {
      const ws = live();
      return ws.find((w) => w.isFocused()) ?? ws.find((w) => w.isVisible()) ?? ws[0];
    },
    byWebContentsId: (id) => live().find((w) => w.webContents.id === id),
    visibleOthers: (except) => live().filter((w) => w !== except && w.isVisible()).length,
  };
}

/**
 * What the red button does. During a quit (or an update restart) every window closes. Otherwise the main
 * window hides (its size and place stay for the next show) and any other window closes for good; the
 * menu-bar note is due when no other window stays visible.
 */
export function closeDecision(opts: { quitting: boolean; isMain: boolean; otherVisible: number }): { action: 'close' | 'hide'; lastWindow: boolean } {
  if (opts.quitting) return { action: 'close', lastWindow: false };
  return { action: opts.isMain ? 'hide' : 'close', lastWindow: opts.otherVisible === 0 };
}

/** Offset of a new window from the one it opens from, like other Mac apps (title bar stays visible). */
export const CASCADE_STEP = 28;

/**
 * Where a new window goes: the size of the window it opens from, one step down and right; back to the top
 * left of that screen's work area when it would leave it. Without a window to start from: centred in the work area.
 */
export function cascadeBounds(from: Rect | undefined, area: Rect, size: { width: number; height: number }): Rect {
  const width = Math.min(from?.width ?? size.width, area.width);
  const height = Math.min(from?.height ?? size.height, area.height);
  if (!from) return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
  let x = from.x + CASCADE_STEP;
  let y = from.y + CASCADE_STEP;
  if (x + width > area.x + area.width || y + height > area.y + area.height) {
    x = area.x + CASCADE_STEP;
    y = area.y + CASCADE_STEP;
    if (x + width > area.x + area.width) x = area.x;
    if (y + height > area.y + area.height) y = area.y;
  }
  return { x, y, width, height };
}

/**
 * Files opened from Finder go to one window: the UI of that window takes them (a window that loads at the
 * same moment asks too, and gets nothing). Once that window is gone, any window may take them.
 */
export function mayTakeOpenedFiles(opts: { senderId: number; targetId: number | null; targetAlive: boolean }): boolean {
  return opts.targetId === null || !opts.targetAlive || opts.senderId === opts.targetId;
}
