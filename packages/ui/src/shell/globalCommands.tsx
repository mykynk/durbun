import { BookOpen, Bookmark, FileDown, FileUp, FlaskConical, Keyboard, Languages, LayoutGrid, Monitor, Moon, PanelLeft, Plug, RefreshCw, Settings, Stethoscope, Sun, Trash } from 'lucide-react';
import { useT } from '../i18n';
import { translate } from '../i18n/core';
import { deviceDisplayName } from '../i18n/codes';
import {
  TAB_IDS,
  appGroupName,
  groupApps,
  reconnectNow,
  setScope,
  sortDevices,
  ui,
  useConnection,
  useDemoActive,
  useHub,
  usePrefs,
  useUi,
  type TabId,
} from '../data';
import { useCommands, useShortcut } from '../hooks';
import type { PaletteCommand } from '../lib/commands';
import { PlatformIcon, sdkLabel, type IconType } from '../components/Icons';
import { TAB_ICONS } from './TopBar';
import { deviceSubtitle } from './labels';
import { addMarker, clearEverything, exportHar, exportSession, pickAndImport, setDemo, setTheme, toggleLanguage, toggleSidebar } from './actions';

const TAB_KEYWORDS: Record<TabId, string[]> = {
  logs: ['logs', 'loglar', 'logcat', 'syslog'],
  network: ['network', 'ağ', 'requests', 'istekler', 'http'],
  mocks: ['mocks', 'mock', 'kurallar', 'rules'],
  perf: ['performance', 'performans', 'cpu', 'memory', 'bellek', 'fps'],
  device: ['device', 'cihaz', 'screenshot', 'ekran görüntüsü', 'apps'],
};

/** The message in both languages, so palette search works whatever the UI language is. */
function both(key: string): string[] {
  return [translate('tr', key), translate('en', key)];
}

/** Built-in palette commands and app-wide shortcuts (mounted once in App). */
export function useGlobalCommands(): void {
  const t = useT();
  const devices = useHub((s) => s.devices);
  const apps = useHub((s) => s.apps);
  const deviceApps = useHub((s) => s.deviceApps);
  const status = useConnection((s) => s.status);
  const demo = useDemoActive();
  const theme = usePrefs((s) => s.theme);
  const lang = usePrefs((s) => s.language);
  const sidebarCollapsed = usePrefs((s) => s.sidebarCollapsed);
  const tab = useUi((s) => s.tab);

  const nav = t('shell.palette.groups.navigation');
  const scopeGroup = t('shell.palette.groups.scope');
  const general = t('shell.palette.groups.general');
  const data = t('shell.palette.groups.data');

  const commands: PaletteCommand[] = [
    ...TAB_IDS.map(
      (id, i): PaletteCommand => ({
        id: `go.${id}`,
        title: t(`shell.tabs.${id}`),
        group: nav,
        icon: TAB_ICONS[id],
        shortcut: `Mod+${i + 1}`,
        keywords: [...TAB_KEYWORDS[id], ...both(`shell.tabs.${id}`)],
        priority: 50 - i,
        run: () => ui.setTab(id),
      }),
    ),
    { id: 'scope.all', title: t('shell.scope.all'), group: scopeGroup, icon: LayoutGrid, keywords: ['scope', 'kapsam', ...both('shell.scope.all')], run: () => setScope({ kind: 'all' }) },
    ...sortDevices(Object.values(devices)).map((d): PaletteCommand => {
        const Icon: IconType = ({ size }) => <PlatformIcon device={d} size={Number(size) || 16} />;
        return {
          id: `scope.device.${d.id}`,
          title: deviceDisplayName(d),
          subtitle: deviceSubtitle(d),
          group: scopeGroup,
          icon: Icon,
          keywords: ['scope', 'kapsam', d.model ?? '', d.serial ?? ''],
          run: () => setScope({ kind: 'device', deviceId: d.id }),
        };
      }),
    ...[...groupApps(Object.values(apps), Object.values(deviceApps)).values()]
      .flat()
      .filter((g) => devices[g.deviceId])
      .map((g): PaletteCommand => {
        const latest = g.latest;
        const hint = { deviceId: g.deviceId, bundleId: g.bundleId };
        return {
          id: `scope.app.${g.key}`,
          title: appGroupName(g),
          subtitle: `${deviceDisplayName(devices[g.deviceId], g.deviceId)} · ${latest ? sdkLabel(latest.sdk.platform) : t('sources.badge.device-only')}`,
          group: scopeGroup,
          icon: TAB_ICONS.device,
          keywords: ['scope', 'kapsam', g.bundleId],
          run: () => (latest ? setScope({ kind: 'app', appId: latest.id }, hint) : setScope({ kind: 'deviceApp', deviceId: g.deviceId, bundleId: g.bundleId }, hint)),
        };
      }),
    {
      id: 'sources.explainer',
      title: t('sources.explainer.title'),
      group: general,
      icon: BookOpen,
      keywords: ['source', 'kaynak', 'sdk', 'ssl', 'pinning', 'nereden', 'where', 'store', 'mağaza', 'firebase'],
      run: ui.openDataSources,
    },
    { id: 'settings', title: t('shell.settings.title'), group: general, icon: Settings, shortcut: 'Mod+,', keywords: ['preferences', 'tercihler', ...both('shell.settings.title')], priority: 10, run: () => ui.openSettings() },
    { id: 'doctor', title: t('shell.doctor.title'), group: general, icon: Stethoscope, keywords: ['doctor', 'adb', 'xcode', 'idevicesyslog', ...both('shell.doctor.title')], priority: 9, run: ui.openDoctor },
    ...(['flutter', 'android', 'ios', 'react-native'] as const).map(
      (p): PaletteCommand => ({
        id: `sdk.${p}`,
        title: `${t('shell.sdk.title')}: ${t(`shell.sdk.tabs.${p}`)}`,
        group: general,
        icon: BookOpen,
        keywords: ['install', p, ...both('shell.sdk.title')],
        run: () => ui.openSdkGuide(p),
      }),
    ),
    { id: 'shortcuts', title: t('shell.shortcuts.title'), group: general, icon: Keyboard, shortcut: '?', keywords: both('shell.shortcuts.title'), run: ui.openShortcuts },
    ...(['system', 'dark', 'light'] as const)
      .filter((th) => th !== theme)
      .map(
        (th): PaletteCommand => ({
          id: `theme.${th}`,
          title: `${t('shell.theme.title')}: ${t(`shell.theme.${th}`)}`,
          group: general,
          icon: th === 'dark' ? Moon : th === 'light' ? Sun : Monitor,
          keywords: [...both('shell.theme.title'), ...both(`shell.theme.${th}`)],
          run: () => setTheme(th),
        }),
      ),
    {
      id: 'language',
      title: t('shell.language.switch'),
      group: general,
      icon: Languages,
      keywords: ['language', 'dil', 'english', 'türkçe', lang],
      run: toggleLanguage,
    },
    {
      id: 'sidebar',
      title: sidebarCollapsed ? t('shell.sidebar.expand') : t('shell.sidebar.collapse'),
      group: general,
      icon: PanelLeft,
      shortcut: 'Mod+B',
      keywords: [...both('shell.sidebar.collapse'), ...both('shell.sidebar.expand')],
      run: toggleSidebar,
    },
    // The Logs view registers its own (scope-aware) marker command; avoid a duplicate entry there.
    ...(tab === 'logs'
      ? []
      : [{ id: 'marker', title: t('shell.marker.add'), group: data, icon: Bookmark, shortcut: 'M', keywords: both('shell.marker.add'), run: () => void addMarker() } satisfies PaletteCommand]),
    { id: 'export.all', title: t('shell.io.exportAll'), group: data, icon: FileDown, keywords: ['save', ...both('shell.io.exportAll')], run: () => exportSession('all') },
    { id: 'export.har', title: t('shell.io.exportHar'), group: data, icon: FileDown, keywords: ['har', ...both('shell.io.exportHar')], run: () => void exportHar() },
    { id: 'import', title: t('shell.io.import'), group: data, icon: FileUp, keywords: ['open', ...both('shell.io.import')], run: () => void pickAndImport() },
    {
      id: 'demo',
      title: demo ? t('shell.demo.disable') : t('shell.demo.enable'),
      group: data,
      icon: FlaskConical,
      keywords: ['demo', ...both('shell.demo.enable'), ...both('shell.demo.disable')],
      run: () => void setDemo(!demo),
    },
    { id: 'vm.attach', title: t('shell.vm.attachCommand'), group: data, icon: Plug, keywords: ['vm service', 'dart', 'flutter', 'observatory', 'devtools', ...both('shell.vm.attachCommand')], run: () => ui.openSdkGuide('flutter') },
    { id: 'clear.all', title: t('shell.clearAll.command'), group: data, icon: Trash, keywords: ['reset', ...both('shell.clearAll.command')], run: () => void clearEverything() },
    ...(status === 'reconnecting'
      ? [{ id: 'reconnect', title: t('shell.status.retryNow'), group: general, icon: RefreshCw, priority: 100, keywords: both('shell.status.retryNow'), run: reconnectNow } satisfies PaletteCommand]
      : []),
  ];
  useCommands(commands);

  // App-wide shortcuts.
  const paletteOpen = useUi((s) => s.palette);
  useShortcut('Mod+K', ui.togglePalette, { allowInModal: paletteOpen });
  useShortcut('?', ui.openShortcuts);
  useShortcut('Mod+,', () => ui.openSettings());
  useShortcut('Mod+B', toggleSidebar);
  useShortcut(['Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5'], (e) => {
    const n = Number(e.code?.startsWith('Digit') ? e.code.slice(5) : e.key) - 1;
    const id = TAB_IDS[n];
    if (!id) return false;
    ui.setTab(id);
  });
  // Fallback marker (the Logs view may register its own "M" which runs first).
  useShortcut('M', () => void addMarker(), { priority: -10 });
}
