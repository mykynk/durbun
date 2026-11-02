/**
 * Window chrome for the macOS "hiddenInset" title bar. The preload sets <html data-desktop="mac"> (and
 * data-desktop-fullscreen while in full screen); the UI styles itself under those selectors
 * (packages/ui/src/styles/shell.css, "Dürbün.app (macOS)"): the sidebar header and top bar become the
 * drag area and the brand makes room for the traffic lights placed here.
 */
import type { Theme } from './windowState';

/** Top-left of the traffic lights: vertically centered on the 44 px top bar (8 px top margin). */
export const TRAFFIC_LIGHTS = { x: 16, y: 23 } as const;

const SPLASH_COLORS: Record<Theme, { bg: string; fg: string; muted: string; accent: string }> = {
  dark: { bg: '#0b0d12', fg: '#e7e9ef', muted: '#8a90a2', accent: '#7c6cf2' },
  light: { bg: '#f5f6f9', fg: '#181b24', muted: '#5d6375', accent: '#7c6cf2' },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Static page shown in the window while there is no UI to show (data: URL, no scripts, no requests):
 * the "starting…" splash (`busy`), or why the server could not start (`title` + `text`).
 */
export function statusPageUrl(opts: { theme: Theme; text: string; title?: string; busy: boolean }): string {
  const c = SPLASH_COLORS[opts.theme];
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Dürbün</title><style>
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:${c.bg};color:${c.fg};
font:13px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;-webkit-app-region:drag;user-select:none;cursor:default}
.mark{font-size:30px;color:${c.accent};letter-spacing:-4px}.name{font-size:17px;font-weight:600}.sub{color:${c.muted}}
.bar{width:120px;height:3px;border-radius:2px;background:${c.muted}33;overflow:hidden}
.bar i{display:block;width:40%;height:100%;background:${c.accent};border-radius:2px;animation:s 1.1s ease-in-out infinite alternate}
@keyframes s{from{transform:translateX(-10%)}to{transform:translateX(160%)}}
.title{font-size:15px;font-weight:600}
.detail{max-width:560px;padding:0 24px;color:${c.muted};white-space:pre-wrap;text-align:center;-webkit-app-region:no-drag;user-select:text;cursor:text}
</style></head><body><div class="mark">◉◉</div><div class="name">Dürbün</div>${
    opts.busy
      ? `<div class="bar"><i></i></div><div class="sub">${escapeHtml(opts.text)}</div>`
      : `${opts.title ? `<div class="title">${escapeHtml(opts.title)}</div>` : ''}<div class="detail">${escapeHtml(opts.text)}</div>`
  }</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** The "starting…" splash shown while the server starts. */
export function splashUrl(text: string, theme: Theme): string {
  return statusPageUrl({ theme, text, busy: true });
}

/** The parts of a BrowserWindow the full-screen sync uses (a fake in tests). */
export interface FullScreenSource {
  on(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
  isFullScreen(): boolean;
  webContents: { on(event: 'dom-ready', listener: () => void): unknown };
}

/**
 * Keeps <html data-desktop-fullscreen> (set by the preload) in sync: on every transition and on every
 * page load, because a page loaded or reloaded in full screen starts without the attribute.
 */
export function syncFullScreen(w: FullScreenSource, send: (on: boolean) => void): void {
  w.on('enter-full-screen', () => send(true));
  w.on('leave-full-screen', () => send(false));
  w.webContents.on('dom-ready', () => send(w.isFullScreen()));
}
