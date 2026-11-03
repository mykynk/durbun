/**
 * Self-test for packaged builds: `DURBUN_DESKTOP_SELFTEST=<report.json> Dürbün.app/Contents/MacOS/Dürbün`
 * waits for the UI, checks the security/notification/chrome wiring from inside the window, writes a
 * JSON report (+ a PNG of the page) and quits through the normal quit path (which stops the server). External links are
 * recorded instead of opened. DURBUN_DESKTOP_SELFTEST_NOTIFY=1 also shows one real notification. The page's
 * console is part of the report; `cspViolations` lists what the server's Content-Security-Policy refused
 * (the deliberate example.com fetch below is expected there).
 */
import { BrowserWindow, type WebContents } from 'electron';
import { promises as fsp } from 'node:fs';
import type { Notifier } from './notifier';

export interface ConsoleEntry {
  level: string;
  message: string;
  source: string;
}

/** Console lines that come from a Content-Security-Policy refusal. */
export function cspViolations(entries: readonly ConsoleEntry[]): ConsoleEntry[] {
  return entries.filter((e) => /Content Security Policy|Refused to /i.test(e.message));
}

export interface SelfTestContext {
  reportFile: string;
  wc: WebContents;
  externalOpened: string[];
  /** Everything the window's page logged since it was created. */
  consoleLog: readonly ConsoleEntry[];
  notifier: Notifier;
  info(): Record<string, unknown>;
  quit(): void;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const PAGE_CHECKS = `(async () => {
  const style = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue(prop) : null; };
  const out = {
    href: location.href,
    title: document.title,
    appRendered: !!document.querySelector('.app'),
    desktopAttr: document.documentElement.getAttribute('data-desktop'),
    theme: document.documentElement.getAttribute('data-theme'),
    lang: document.documentElement.getAttribute('lang'),
    navigatorLanguage: navigator.language,
    nodeGlobals: typeof require !== 'undefined' || typeof process !== 'undefined' || typeof module !== 'undefined',
    bridge: typeof window.durbunDesktop,
    notificationClass: typeof Notification === 'undefined' ? null : Notification.name,
    notificationPermission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    topbarAppRegion: style('.topbar', '-webkit-app-region') || style('.topbar', 'app-region'),
    sbHeaderPaddingLeft: style('.sb-header', 'padding-left'),
  };
  // A non-JSON answer (an older or a different server) is reported, not fatal to the whole report.
  out.health = await fetch('/api/health').then((r) => r.json()).catch((e) => 'error: ' + e.message);
  out.doctor = await fetch('/api/doctor').then((r) => r.json()).catch((e) => 'error: ' + e.message);
  out.externalFetch = await fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'allowed', (e) => 'blocked (' + e.message + ')');
  return out;
})()`;

export async function runSelfTest(ctx: SelfTestContext): Promise<void> {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
  try {
    await delay(2_500); // let React render and the WS connect
    report.page = await ctx.wc.executeJavaScript(PAGE_CHECKS, true);
    try {
      const shot = `${ctx.reportFile.replace(/\.json$/, '')}.png`;
      await fsp.writeFile(shot, (await ctx.wc.capturePage()).toPNG());
      report.screenshot = shot;
    } catch (err) {
      report.screenshot = `failed: ${(err as Error).message}`;
    }
    const before = ctx.wc.getURL();
    await ctx.wc.executeJavaScript(`location.href = 'https://example.com/selftest-navigation'; 1`, true).catch(() => undefined);
    await ctx.wc.executeJavaScript(`window.open('https://example.com/selftest-popup', '_blank'); window.open('/api/health', '_blank'); 1`, true).catch(() => undefined);
    await delay(800);
    report.navigation = {
      urlBefore: before,
      urlAfter: ctx.wc.getURL(),
      windows: BrowserWindow.getAllWindows().length,
      externalOpened: [...ctx.externalOpened],
    };
    if (process.env.DURBUN_DESKTOP_SELFTEST_NOTIFY === '1') {
      await ctx.wc.executeJavaScript(`new Notification('Dürbün', { body: 'Bildirim testi · notification test' }); 1`, true);
      await delay(3_000);
      report.notifications = [...ctx.notifier.outcomes];
    }
    report.app = ctx.info();
    report.console = [...ctx.consoleLog];
    report.cspViolations = cspViolations(ctx.consoleLog);
  } catch (err) {
    report.error = (err as Error).stack ?? String(err);
  }
  report.finishedAt = new Date().toISOString();
  try {
    await fsp.writeFile(ctx.reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch {
    /* nowhere to report */
  }
  ctx.quit();
}
