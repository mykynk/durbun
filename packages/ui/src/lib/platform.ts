/** True on macOS/iOS (Mod = ⌘), false elsewhere (Mod = Ctrl). */
export const isMac: boolean = (() => {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
    return /mac|iphone|ipad|ipod/i.test(p);
  } catch {
    return false;
  }
})();

/** True inside the Dürbün Mac app (its preload marks <html data-desktop="mac">), false in a browser tab. */
export function isDesktopApp(): boolean {
  try {
    return document.documentElement.getAttribute('data-desktop') === 'mac';
  } catch {
    return false;
  }
}
