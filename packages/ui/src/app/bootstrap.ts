import { setLanguage } from '../i18n/core';
import { flushPrefs, usePrefs, type UiPrefs } from '../data/stores/prefs';
import { useUi } from '../data/stores/ui';

const LIGHT_QUERY = '(prefers-color-scheme: light)';
const NARROW_QUERY = '(max-width: 899px)';

export function resolveTheme(pref: UiPrefs['theme']): 'dark' | 'light' {
  if (pref === 'dark' || pref === 'light') return pref;
  try {
    return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyPrefs(p: UiPrefs): void {
  const root = document.documentElement;
  const theme = resolveTheme(p.theme);
  root.dataset.theme = theme;
  root.dataset.themePref = p.theme;
  root.dataset.density = p.density;
  root.style.setProperty('--log-fs', `${p.logFontSize}px`);
  setLanguage(p.language);
  root.lang = p.language;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = theme === 'light' ? '#F5F6F9' : '#0B0D12';
}

/**
 * Keep <html> in sync with UI prefs: data-theme (resolved, follows the OS for "system"),
 * data-density, --log-fs, lang. Also tracks the narrow layout breakpoint.
 */
export function initDocumentEffects(): () => void {
  applyPrefs(usePrefs.getState());
  const unsub = usePrefs.subscribe((s, prev) => {
    if (s.theme !== prev.theme || s.density !== prev.density || s.logFontSize !== prev.logFontSize || s.language !== prev.language) applyPrefs(s);
  });
  const light = window.matchMedia?.(LIGHT_QUERY);
  const onScheme = () => {
    if (usePrefs.getState().theme === 'system') applyPrefs(usePrefs.getState());
  };
  light?.addEventListener('change', onScheme);

  const narrow = window.matchMedia?.(NARROW_QUERY);
  const onNarrow = () => useUi.setState({ narrow: Boolean(narrow?.matches), sidebarOverlay: false });
  narrow?.addEventListener('change', onNarrow);
  useUi.setState({ narrow: Boolean(narrow?.matches) });

  window.addEventListener('pagehide', flushPrefs);
  return () => {
    unsub();
    light?.removeEventListener('change', onScheme);
    narrow?.removeEventListener('change', onNarrow);
    window.removeEventListener('pagehide', flushPrefs);
  };
}
