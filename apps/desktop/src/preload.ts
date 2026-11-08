/**
 * Preload (sandboxed, context-isolated). Exposes a minimal `window.durbunDesktop` bridge and replaces
 * the page's web Notification with one that is shown by the main process: macOS notifications from
 * Electron need the main process (permission prompt, click → bring the window to the front), and an
 * unsigned build gets a Dock-badge fallback there. The UI keeps using the standard Notification API.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface NotifyPayload {
  id: string;
  title: string;
  body: string;
  tag: string;
  silent: boolean;
}

const clickHandlers = new Map<string, () => void>();
let counter = 0;

ipcRenderer.on('durbun:notification-click', (_event, id: unknown) => {
  if (typeof id !== 'string') return;
  const handler = clickHandlers.get(id);
  clickHandlers.delete(id);
  try {
    handler?.();
  } catch {
    /* page handler failed */
  }
});

function setRootAttribute(name: string, value: string | null): void {
  const root = document.documentElement;
  if (!root) return;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

ipcRenderer.on('durbun:fullscreen', (_event, on: unknown) => setRootAttribute('data-desktop-fullscreen', on === true ? '' : null));

const bridge = {
  platform: process.platform,
  notify(options: { title?: unknown; body?: unknown; tag?: unknown; silent?: unknown }): string {
    const id = `n${Date.now().toString(36)}${(counter++).toString(36)}`;
    const payload: NotifyPayload = {
      id,
      title: String(options.title ?? '').slice(0, 300),
      body: String(options.body ?? '').slice(0, 2000),
      tag: String(options.tag ?? '').slice(0, 200),
      silent: options.silent === true,
    };
    ipcRenderer.send('durbun:notify', payload);
    return id;
  },
  onNotificationClick(id: string, handler: () => void): void {
    if (clickHandlers.size > 200) clickHandlers.delete(clickHandlers.keys().next().value!);
    clickHandlers.set(String(id), handler);
  },
  closeNotification(id: string): void {
    clickHandlers.delete(String(id));
    ipcRenderer.send('durbun:notification-close', String(id));
  },
};

contextBridge.exposeInMainWorld('durbunDesktop', bridge);

/** Runs in the page's world (serialized by Electron): a Notification class backed by the bridge. */
function installNotificationShim(): void {
  type Bridge = typeof bridge;
  const desktop = (window as unknown as { durbunDesktop?: Bridge }).durbunDesktop;
  if (!desktop) return;
  type Handler = ((this: unknown, ev: Event) => unknown) | null;
  class DesktopNotification extends EventTarget {
    static get permission(): NotificationPermission {
      return 'granted';
    }
    static requestPermission(callback?: (p: NotificationPermission) => void): Promise<NotificationPermission> {
      if (typeof callback === 'function') callback('granted');
      return Promise.resolve('granted');
    }
    static get maxActions(): number {
      return 0;
    }
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly icon: string;
    readonly data: unknown;
    readonly silent: boolean;
    onclick: Handler = null;
    onshow: Handler = null;
    onclose: Handler = null;
    onerror: Handler = null;
    private readonly id: string;
    constructor(title: string, options: NotificationOptions = {}) {
      super();
      this.title = String(title);
      this.body = options.body == null ? '' : String(options.body);
      this.tag = options.tag == null ? '' : String(options.tag);
      this.icon = options.icon == null ? '' : String(options.icon);
      this.data = options.data ?? null;
      this.silent = options.silent === true;
      this.id = desktop!.notify({ title: this.title, body: this.body, tag: this.tag, silent: this.silent });
      desktop!.onNotificationClick(this.id, () => this.fire('click', this.onclick));
      setTimeout(() => this.fire('show', this.onshow), 0);
    }
    private fire(type: string, handler: Handler): void {
      const ev = new Event(type, { cancelable: true });
      this.dispatchEvent(ev);
      if (typeof handler === 'function') handler.call(this, ev);
    }
    close(): void {
      desktop!.closeNotification(this.id);
      this.fire('close', this.onclose);
    }
  }
  Object.defineProperty(window, 'Notification', { value: DesktopNotification, configurable: true, writable: true });
}

try {
  contextBridge.executeInMainWorld({ func: installNotificationShim });
} catch {
  /* older Electron: the page keeps Chromium's Notification */
}

// Desktop marker + theme and language sync (the window background follows the UI theme, no flash on next
// launch; menus, tray and dialogs follow the UI language).
let lastTheme: string | null = null;
let lastLang: string | null = null;
function syncRoot(): void {
  const root = document.documentElement;
  if (!root) return;
  if (root.getAttribute('data-desktop') !== 'mac') root.setAttribute('data-desktop', 'mac');
  const theme = root.getAttribute('data-theme');
  if ((theme === 'dark' || theme === 'light') && theme !== lastTheme) {
    lastTheme = theme;
    ipcRenderer.send('durbun:theme', theme);
  }
  const lang = root.getAttribute('lang');
  if ((lang === 'tr' || lang === 'en') && lang !== lastLang) {
    lastLang = lang;
    ipcRenderer.send('durbun:language', lang);
  }
}
window.addEventListener('DOMContentLoaded', () => {
  syncRoot();
  new MutationObserver(syncRoot).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-desktop', 'lang'] });
});
// Menu commands for the UI (App menu → Settings…): a DOM event the page listens for (packages/ui, globalCommands).
ipcRenderer.on('durbun:command', (_event, command: unknown) => {
  if (typeof command === 'string') window.dispatchEvent(new CustomEvent('durbun:command', { detail: command }));
});
