/**
 * Window chrome for the macOS "hiddenInset" title bar: the UI's sidebar header and top bar become the
 * drag area, and the brand/top bar make room for the traffic lights. Injected by the main process into
 * the UI page only (webContents.insertCSS); it depends on UI class names (packages/ui/src/styles/shell.css)
 * and degrades to "no drag area" if those change. The preload also sets <html data-desktop="mac">
 * so the UI can style itself for the app later.
 */
import type { Theme } from './windowState';

/** Top-left of the traffic lights: vertically centered on the 44 px top bar (8 px top margin). */
export const TRAFFIC_LIGHTS = { x: 16, y: 23 } as const;

export const DESKTOP_CSS = `
.sb-header, .topbar { -webkit-app-region: drag; }
.sb-header :is(button, a, input, select, textarea, [role="button"], [role="tab"], [role="tablist"], [tabindex]),
.topbar :is(button, a, input, select, textarea, [role="button"], [role="tab"], [role="tablist"], [tabindex]) {
  -webkit-app-region: no-drag;
}
html:not([data-desktop-fullscreen]) .sidebar:not(.is-compact) .sb-header { padding-left: 74px; }
html:not([data-desktop-fullscreen]) .sidebar.is-compact .sb-header { margin-top: 26px; }
html:not([data-desktop-fullscreen]) .app--compact .topbar { padding-left: 26px; }
`;

const SPLASH_COLORS: Record<Theme, { bg: string; fg: string; muted: string; accent: string }> = {
  dark: { bg: '#0b0d12', fg: '#e7e9ef', muted: '#8a90a2', accent: '#7c6cf2' },
  light: { bg: '#f5f6f9', fg: '#181b24', muted: '#5d6375', accent: '#7c6cf2' },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Tiny "starting…" page shown while the server starts (data: URL, no scripts, no requests). */
export function splashUrl(text: string, theme: Theme): string {
  const c = SPLASH_COLORS[theme];
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
</style></head><body><div class="mark">◉◉</div><div class="name">Dürbün</div><div class="bar"><i></i></div><div class="sub">${escapeHtml(text)}</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
