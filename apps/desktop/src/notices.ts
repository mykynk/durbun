/**
 * Tray warnings in the app's language. The embedded server reports problems as structured notices
 * next to its English `warnings` (packages/server/src/server.ts StartedServer.notices: code, params,
 * message). Known codes are worded in i18n.ts; an unknown code keeps the server's English message, and
 * a warning no notice stands for (or a bundle without notices) is shown as the server wrote it.
 */
import type { Strings } from './i18n';
import type { DurbunPage } from './ports';

export interface ServerNotice {
  code: string;
  params?: Record<string, unknown>;
  message: string;
}

export function serverWarnings(t: Strings, server: { warnings?: readonly unknown[]; notices?: readonly unknown[] }): string[] {
  const out: string[] = [];
  const covered = new Set<string>();
  for (const n of Array.isArray(server.notices) ? server.notices : []) {
    if (!n || typeof n !== 'object') continue;
    const { code, params, message } = n as Partial<ServerNotice>;
    const english = typeof message === 'string' ? message : '';
    const own = typeof code === 'string' ? t.serverNotice(code, params && typeof params === 'object' ? params : {}) : undefined;
    const line = own ?? english;
    if (!line) continue;
    if (english) covered.add(english);
    out.push(line);
  }
  for (const w of Array.isArray(server.warnings) ? server.warnings : []) {
    if (typeof w === 'string' && w && !covered.has(w)) out.push(w);
  }
  return out;
}

/**
 * The version this app's own server would have: SERVER_VERSION from the bundle (packages/server/src/
 * server.ts), else the app's version (bundles before it was exported; both were 0.1.0 then).
 */
export function bundledServerVersion(mod: { SERVER_VERSION?: unknown }, appVersion: string): string {
  return typeof mod.SERVER_VERSION === 'string' && mod.SERVER_VERSION.trim() ? mod.SERVER_VERSION.trim() : appVersion;
}

/** What the tray says when the window shows another Dürbün: a different version, a missing UI build. */
export function attachNotices(t: Strings, other: { port: number; version: string; page?: DurbunPage }, mine: string): string[] {
  const out: string[] = [];
  if (other.version !== mine) out.push(t.attachedVersionNotice(other.version, mine));
  if (other.page === 'placeholder') out.push(t.attachedPlaceholderNotice(other.port));
  return out;
}
