import { useMemo, useRef, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowDownUp,
  ArrowLeftRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleQuestionMark,
  Drama,
  Ellipsis,
  Languages,
  FileDown,
  FileUp,
  Gauge,
  Info,
  Keyboard,
  LayoutGrid,
  Monitor,
  Moon,
  PanelLeftOpen,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Stethoscope,
  Sun,
  Waypoints,
} from 'lucide-react';
import { useT } from '../i18n';
import { deviceDisplayName } from '../i18n/codes';
import {
  metricsStore,
  ui,
  useCompiledScope,
  useConnection,
  useHub,
  useMetricsVersion,
  useMocks,
  usePrefs,
  useScope,
  useScopedLogCounts,
  useScopedNetworkCounts,
  useUi,
  scopeTarget,
  setScope,
  useScopeStore,
  sortDevices,
  groupApps,
  appGroupName,
  buildBadgeOf,
  explainSources,
  type TabId,
} from '../data';
import { Tabs, type TabItem } from '../components/Tabs';
import { IconButton } from '../components/Button';
import { CountBadge, StatusDot } from '../components/Badges';
import { DropdownMenu, type MenuItem } from '../components/Menu';
import { Kbd } from '../components/Kbd';
import { PlatformIcon, SdkBadge, type IconType } from '../components/Icons';
import { Tooltip } from '../components/Tooltip';
import { formatClock, formatCompact } from '../lib/format';
import { appTitle } from './labels';
import { BuildBadgeChip, ScopeSourcesButton, SourceBadge } from '../sources';
import { exportHar, exportSession, pickAndImport, setTheme, toggleLanguage, toggleSidebar } from './actions';

export const TAB_ICONS: Record<TabId, IconType> = {
  logs: ScrollText,
  network: ArrowLeftRight,
  mocks: Drama,
  perf: Gauge,
  device: Smartphone,
};

/**
 * Count of problems that appeared while a tab was not visible. Resets when the tab is shown or the
 * scope changes, so badges call attention to NEW errors instead of shouting a permanent total.
 */
function useUnseen(count: number, visible: boolean, scopeKey: string): number {
  const base = useRef({ key: scopeKey, seen: count });
  if (base.current.key !== scopeKey) base.current = { key: scopeKey, seen: count };
  if (visible || count < base.current.seen) base.current.seen = count;
  return Math.max(0, count - base.current.seen);
}

function TabCount({ total, alert, alertTitle }: { total: number; alert: number; alertTitle?: string }) {
  return (
    <>
      {total > 0 ? <span className="tab__count tnum">{formatCompact(total)}</span> : null}
      <CountBadge count={alert} tone="danger" title={alertTitle} />
    </>
  );
}

function usePerfLive(): boolean {
  const compiled = useCompiledScope();
  useMetricsVersion({ throttleMs: 2000 });
  const now = Date.now();
  for (const s of metricsStore.series.values()) if (now - s.updatedAt < 6000 && compiled.metrics(s)) return true;
  return false;
}

export function TopBar() {
  const t = useT();
  const tab = useUi((s) => s.tab);
  const narrow = useUi((s) => s.narrow);
  const logs = useScopedLogCounts(500);
  const net = useScopedNetworkCounts(500);
  const enabledMocks = useMocks((s) => s.rules.reduce((n, r) => n + (r.enabled ? 1 : 0), 0));
  const perfLive = usePerfLive();
  const scope = useScope();
  const scopedDevice = useHub((s) => {
    if (scope.kind === 'device' || scope.kind === 'deviceApp') return s.devices[scope.deviceId];
    if (scope.kind === 'app') {
      const app = s.apps[scope.appId];
      return app ? s.devices[app.deviceId] : undefined;
    }
    return undefined;
  });
  const deviceAttention = scopedDevice?.state === 'unauthorized' || scopedDevice?.state === 'offline';
  // History replayed on (re)connect is not "new": the baseline follows the counts until we are live.
  const syncing = useConnection((s) => s.status !== 'live');
  const connectedAt = useConnection((s) => s.connectedAt);
  const scopeKey = `${JSON.stringify(scope)}|${connectedAt ?? 0}`;
  const newLogErrors = useUnseen(logs.error, syncing || tab === 'logs', scopeKey);
  const netProblems = net.failed + net.serverError;
  const newNetErrors = useUnseen(netProblems, syncing || tab === 'network', scopeKey);

  const items: TabItem<TabId>[] = [
    {
      value: 'logs',
      label: t('shell.tabs.logs'),
      icon: TAB_ICONS.logs,
      shortcut: 'Mod+1',
      title: t('shell.tabs.logs'),
      badge: <TabCount total={logs.total} alert={newLogErrors} alertTitle={t('shell.tabs.logErrorsNew', { count: newLogErrors })} />,
    },
    {
      value: 'network',
      label: t('shell.tabs.network'),
      icon: TAB_ICONS.network,
      shortcut: 'Mod+2',
      title: t('shell.tabs.network'),
      badge: <TabCount total={net.total} alert={newNetErrors} alertTitle={t('shell.tabs.netErrorsNew', { count: newNetErrors })} />,
    },
    {
      value: 'mocks',
      label: t('shell.tabs.mocks'),
      icon: TAB_ICONS.mocks,
      shortcut: 'Mod+3',
      title: t('shell.tabs.mocks'),
      badge: <CountBadge count={enabledMocks} tone="accent" title={t('shell.tabs.mocksActive', { count: enabledMocks })} />,
    },
    {
      value: 'perf',
      label: t('shell.tabs.perf'),
      icon: TAB_ICONS.perf,
      shortcut: 'Mod+4',
      title: t('shell.tabs.perf'),
      badge: perfLive ? <StatusDot tone="success" size={6} title={t('shell.tabs.perfLive')} /> : null,
    },
    {
      value: 'device',
      label: t('shell.tabs.device'),
      icon: TAB_ICONS.device,
      shortcut: 'Mod+5',
      title: t('shell.tabs.device'),
      badge: deviceAttention ? <StatusDot tone="warn" size={6} title={t('shell.tabs.deviceAttention')} /> : null,
    },
  ];

  return (
    <header className="topbar">
      {narrow ? <IconButton icon={PanelLeftOpen} label={t('shell.sidebar.expand')} onClick={toggleSidebar} /> : null}
      <ScopeBreadcrumb />
      <ScopeSourcesButton className="topbar__sources" />
      <span className="topbar__divider" aria-hidden />
      <Tabs variant="pill" items={items} value={tab} onChange={ui.setTab} idPrefix="main" aria-label={t('shell.tabs.label')} className="topbar__tabs" />
      <span className="grow" />
      <div className="topbar__actions">
        <Tooltip content={t('shell.palette.title')} shortcut="Mod+K">
          <button type="button" className="palette-trigger" onClick={ui.openPalette} aria-label={t('shell.palette.title')}>
            <Search size={14} aria-hidden />
            <span className="palette-trigger__text">{t('shell.palette.trigger')}</span>
            <Kbd combo="Mod+K" size="sm" />
          </button>
        </Tooltip>
        <span className="topbar__wide">
          <ImportExportMenu />
          <ThemeMenu />
          <LanguageButton />
        </span>
        <span className="topbar__narrow">
          <MoreMenu />
        </span>
        <IconButton icon={Settings} label={t('shell.settings.title')} shortcut="Mod+," onClick={() => ui.openSettings()} />
        <HelpMenu />
      </div>
    </header>
  );
}

function ScopeBreadcrumb() {
  const t = useT();
  const scope = useScope();
  const hint = useScopeStore((s) => s.hint);
  const { devices, apps, deviceApps } = useHub(useShallow((s) => ({ devices: s.devices, apps: s.apps, deviceApps: s.deviceApps })));
  const target = scopeTarget(scope, { devices, apps, deviceApps });
  // Before the first snapshot (or for a vanished target) show what we remember instead of "unknown".
  const pendingName =
    scope.kind === 'device' ? scope.deviceId : scope.kind === 'app' ? (hint.bundleId ?? scope.appId) : scope.kind === 'deviceApp' ? scope.bundleId : undefined;

  const menuItems = (): MenuItem[] => {
    const list: MenuItem[] = [{ label: t('shell.scope.all'), icon: LayoutGrid, checked: scope.kind === 'all', onSelect: () => setScope({ kind: 'all' }) }];
    const byDevice = groupApps(Object.values(apps), Object.values(deviceApps));
    for (const d of sortDevices(Object.values(devices))) {
      const DeviceIcon: IconType = ({ size }) => <PlatformIcon device={d} size={Number(size) || 14} />;
      list.push({ type: 'separator' });
      list.push({
        label: deviceDisplayName(d),
        icon: DeviceIcon,
        hint: d.id.startsWith('import:') ? t('shell.device.imported') : d.state !== 'online' ? t(`code.state.${d.state}`) : undefined,
        checked: scope.kind === 'device' && scope.deviceId === d.id,
        onSelect: () => setScope({ kind: 'device', deviceId: d.id }),
      });
      for (const g of byDevice.get(d.id) ?? []) {
        const selected =
          (scope.kind === 'app' && g.sessions.some((s) => s.id === scope.appId)) ||
          (scope.kind === 'deviceApp' && scope.deviceId === g.deviceId && scope.bundleId === g.bundleId);
        const latest = g.latest;
        const groupHint = { deviceId: g.deviceId, bundleId: g.bundleId };
        list.push({
          label: <span className="scope-menu__app">{appGroupName(g)}</span>,
          icon: ChevronRight,
          hint: latest ? <SdkBadge platform={latest.sdk.platform} /> : <SourceBadge badge="device-only" />,
          checked: selected,
          onSelect: () =>
            latest ? setScope({ kind: 'app', appId: latest.id }, groupHint) : setScope({ kind: 'deviceApp', deviceId: g.deviceId, bundleId: g.bundleId }, groupHint),
        });
      }
    }
    return list;
  };

  const appName = target.app ? appTitle(target.app) : target.deviceApp?.name || target.bundleId;
  const isAppScope = scope.kind === 'app' || scope.kind === 'deviceApp';
  let content: ReactNode;
  if (scope.kind === 'all') {
    content = (
      <>
        <LayoutGrid size={15} aria-hidden className="crumb__icon" />
        <span className="crumb__text">{t('shell.scope.all')}</span>
      </>
    );
  } else {
    const device = target.device;
    const input = { device, deviceApp: target.deviceApp, sessions: target.app ? Object.values(apps).filter((a) => a.deviceId === target.app!.deviceId && a.app.id === target.app!.app.id) : [] };
    const build = isAppScope ? buildBadgeOf(input) : undefined;
    content = (
      <>
        {device ? <PlatformIcon device={device} size={15} className="crumb__icon" /> : <Waypoints size={15} className="crumb__icon" aria-hidden />}
        <span className={clsx('crumb__text', isAppScope && appName && 'crumb__text--muted')}>{device ? deviceDisplayName(device) : isAppScope && appName ? t('shell.scope.unknownDevice') : pendingName}</span>
        {isAppScope && appName ? (
          <>
            <ChevronRight size={13} className="crumb__sep" aria-hidden />
            {target.app ? <SdkBadge platform={target.app.sdk.platform} /> : <SourceBadge badge={explainSources(input).badge} short />}
            <span className="crumb__text crumb__text--app">{appName}</span>
            {build ? <BuildBadgeChip badge={build} installer={target.deviceApp?.install.installer} short /> : null}
            {scope.kind === 'app' && scope.exact && target.app ? <span className="crumb__session tnum">{formatClock(target.app.connectedAt, { ms: false })}</span> : null}
          </>
        ) : null}
      </>
    );
  }

  const label = isAppScope && appName ? appName : target.device ? deviceDisplayName(target.device) : t('shell.scope.all');
  return (
    <DropdownMenu items={menuItems} align="start" minWidth={260} aria-label={t('shell.scope.pick')}>
      {(p) => (
        <button type="button" className="crumb" {...p} aria-label={`${t('shell.scope.label')}: ${label}`}>
          {content}
          <ChevronDown size={13} className="crumb__chev" aria-hidden />
        </button>
      )}
    </DropdownMenu>
  );
}

/** Display name of the scope (export menu labels). */
function useScopeName(): string | undefined {
  const scope = useScope();
  const { devices, apps, deviceApps } = useHub(useShallow((s) => ({ devices: s.devices, apps: s.apps, deviceApps: s.deviceApps })));
  const target = scopeTarget(scope, { devices, apps, deviceApps });
  if (target.app) return appTitle(target.app);
  if (scope.kind === 'deviceApp') return target.device ? deviceDisplayName(target.device) : undefined;
  return target.device ? deviceDisplayName(target.device) : undefined;
}

function ImportExportMenu() {
  const t = useT();
  const scope = useScope();
  const scopeName = useScopeName();
  return (
    <DropdownMenu
      minWidth={280}
      items={() => [
        { label: t('shell.io.exportAll'), icon: FileDown, onSelect: () => exportSession('all') },
        ...(scope.kind !== 'all' && scopeName ? [{ label: t('shell.io.exportScope', { name: scopeName }), icon: FileDown, onSelect: () => exportSession(scope) }] : []),
        { label: t('shell.io.exportHar'), icon: FileDown, onSelect: () => void exportHar() },
        { type: 'separator' },
        { label: t('shell.io.import'), icon: FileUp, hint: t('shell.io.dropHint'), onSelect: () => void pickAndImport() },
      ]}
    >
      {(p) => <IconButton icon={ArrowDownUp} label={t('shell.io.title')} {...p} />}
    </DropdownMenu>
  );
}

/** Narrow layouts: import/export, theme and language folded into one menu. */
function MoreMenu() {
  const t = useT();
  const theme = usePrefs((s) => s.theme);
  const scope = useScope();
  const scopeName = useScopeName();
  return (
    <DropdownMenu
      minWidth={260}
      items={() => [
        { label: t('shell.io.exportAll'), icon: FileDown, onSelect: () => exportSession('all') },
        ...(scope.kind !== 'all' && scopeName ? [{ label: t('shell.io.exportScope', { name: scopeName }), icon: FileDown, onSelect: () => exportSession(scope) }] : []),
        { label: t('shell.io.exportHar'), icon: FileDown, onSelect: () => void exportHar() },
        { label: t('shell.io.import'), icon: FileUp, onSelect: () => void pickAndImport() },
        { type: 'separator' },
        { type: 'label', label: t('shell.theme.title') },
        { label: t('shell.theme.system'), icon: Monitor, checked: theme === 'system', onSelect: () => setTheme('system') },
        { label: t('shell.theme.dark'), icon: Moon, checked: theme === 'dark', onSelect: () => setTheme('dark') },
        { label: t('shell.theme.light'), icon: Sun, checked: theme === 'light', onSelect: () => setTheme('light') },
        { type: 'separator' },
        { label: t('shell.language.switch'), icon: Languages, onSelect: toggleLanguage },
      ]}
    >
      {(p) => <IconButton icon={Ellipsis} label={t('common.more')} {...p} />}
    </DropdownMenu>
  );
}

function ThemeMenu() {
  const t = useT();
  const theme = usePrefs((s) => s.theme);
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <DropdownMenu
      minWidth={180}
      items={[
        { label: t('shell.theme.system'), icon: Monitor, checked: theme === 'system', onSelect: () => setTheme('system') },
        { label: t('shell.theme.dark'), icon: Moon, checked: theme === 'dark', onSelect: () => setTheme('dark') },
        { label: t('shell.theme.light'), icon: Sun, checked: theme === 'light', onSelect: () => setTheme('light') },
      ]}
    >
      {(p) => <IconButton icon={Icon} label={t('shell.theme.title')} {...p} />}
    </DropdownMenu>
  );
}

function LanguageButton() {
  const t = useT();
  const lang = usePrefs((s) => s.language);
  return (
    <Tooltip content={t('shell.language.switch')}>
      <button type="button" className="lang-btn" onClick={toggleLanguage} aria-label={t('shell.language.switch')}>
        {lang === 'tr' ? 'TR' : 'EN'}
      </button>
    </Tooltip>
  );
}

function HelpMenu() {
  const t = useT();
  const items = useMemo<MenuItem[]>(
    () => [
      { label: t('shell.shortcuts.title'), icon: Keyboard, shortcut: '?', onSelect: ui.openShortcuts },
      { label: t('shell.sdk.title'), icon: BookOpen, onSelect: () => ui.openSdkGuide() },
      { label: t('sources.explainer.title'), icon: ShieldCheck, onSelect: ui.openDataSources },
      { label: t('shell.doctor.title'), icon: Stethoscope, onSelect: ui.openDoctor },
      { type: 'separator' },
      { label: t('shell.about.title'), icon: Info, onSelect: () => ui.openSettings('about') },
    ],
    [t],
  );
  return <DropdownMenu items={items}>{(p) => <IconButton icon={CircleQuestionMark} label={t('shell.help.title')} {...p} />}</DropdownMenu>;
}
