import { useEffect } from 'react';
import {
  Archive,
  BookOpen,
  Bookmark,
  Bug,
  Camera,
  FileDown,
  FileUp,
  FlaskConical,
  Globe,
  Info,
  Keyboard,
  Languages,
  LayoutGrid,
  ListPlus,
  Monitor,
  Moon,
  PanelLeft,
  PackageOpen,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Share2,
  Sparkles,
  Stethoscope,
  Sun,
  Trash,
  Video,
  Workflow,
} from 'lucide-react';
import type { DeviceActionId, FlowSummary } from '@durbun/protocol';
import { errorText, useT } from '../i18n';
import { translate } from '../i18n/core';
import { deviceDisplayName } from '../i18n/codes';
import {
  TAB_IDS,
  appGroupName,
  groupApps,
  isReadOnlyDevice,
  reconnectNow,
  scopeTarget,
  sendCommand,
  setScope,
  sortDevices,
  ui,
  useConnection,
  useDemoActive,
  useFlows,
  useHub,
  useMocks,
  usePrefs,
  useScope,
  useUi,
  type TabId,
} from '../data';
import { useCommands, useShortcut } from '../hooks';
import { toast } from '../components/Toast';
import type { PaletteCommand } from '../lib/commands';
import { PlatformIcon, sdkLabel, type IconType } from '../components/Icons';
import { TAB_ICONS } from './TopBar';
import { deviceSubtitle } from './labels';
import { transfer } from '../features/transfer/store';
import { bugReport } from '../features/report/store';
import { requestFlowIntent } from '../features/flows/intent';
import { automatedFlows, pauseAutomations, resumable, resumeAutomations, usePausedAutomations, type BulkResult } from '../features/flows/model/automations';
import { requestDeviceSection } from '../features/device/request';
import { addMarker, clearEverything, exportHar, exportSession, pickAndImport, setDemo, setTheme, toggleLanguage, toggleSidebar } from './actions';
import { useSidebarCompact } from './sidebarFit';

const TAB_KEYWORDS: Record<TabId, string[]> = {
  logs: ['logs', 'loglar', 'logcat', 'syslog'],
  network: ['network', 'ağ', 'requests', 'istekler', 'http'],
  mocks: ['mocks', 'mock', 'kurallar', 'rules'],
  perf: ['performance', 'performans', 'cpu', 'memory', 'bellek', 'fps'],
  device: ['device', 'cihaz', 'screenshot', 'ekran görüntüsü', 'apps'],
  flows: ['flows', 'akış', 'akışlar', 'flow', 'scenario', 'senaryo', 'test', 'graph'],
};

/** The message in both languages, so palette search works whatever the UI language is. */
function both(key: string): string[] {
  return [translate('tr', key), translate('en', key)];
}

/** Takes a screenshot from any tab: the Device view's own code stores it in its gallery (loaded on first use). */
async function screenshotFromPalette(deviceId: string): Promise<void> {
  const [shot] = await Promise.all([import('../features/device/ScreenshotCard'), import('../features/device/i18n')]);
  await shot.captureScreenshot(deviceId);
}

/** Restarts the scoped app on its device and says how it went. */
async function restartApp(deviceId: string, bundleId: string, name: string): Promise<void> {
  try {
    await sendCommand({ name: 'device.action', deviceId, action: 'app-restart', params: { appId: bundleId } });
    toast.success(translate(usePrefs.getState().language, 'shell.cmd.restarted', { app: name }));
  } catch (err) {
    toast.error(translate(usePrefs.getState().language, 'shell.cmd.restartFailed', { app: name }), { description: errorText(err) });
  }
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
  const sidebarCollapsed = useSidebarCompact(usePrefs((s) => s.sidebarCollapsed));
  const tab = useUi((s) => s.tab);
  const scope = useScope();
  const flows = useFlows((s) => s.summaries);
  const mockRules = useMocks((s) => s.rules);
  const pausedAutomations = usePausedAutomations((s) => s.ids);

  const nav = t('shell.palette.groups.navigation');
  const scopeGroup = t('shell.palette.groups.scope');
  const general = t('shell.palette.groups.general');
  const data = t('shell.palette.groups.data');

  // Device and app actions for the scoped device, from any tab (the Device tab lists its own while it is open).
  const scoped = scopeTarget(scope, { apps, devices, deviceApps });
  const device = scoped.device && scoped.device.state === 'online' && !isReadOnlyDevice(scoped.device.id) ? scoped.device : undefined;
  const can = (a: DeviceActionId) => !!device && device.actions.includes(a);
  const deviceGroup = t('common.groups.device');
  const deviceName = device ? deviceDisplayName(device) : '';
  const appName = scoped.app?.app.name ?? scoped.deviceApp?.name ?? scoped.bundleId ?? '';
  const deviceCommands: PaletteCommand[] =
    device && tab !== 'device'
      ? [
          ...(can('screenshot')
            ? [{ id: 'device.screenshot', title: t('shell.cmd.screenshot'), subtitle: deviceName, group: deviceGroup, icon: Camera, priority: 5, keywords: ['screenshot', 'ekran görüntüsü', 'görüntü al', 'capture', 'screen'], run: () => screenshotFromPalette(device.id) }]
            : []),
          ...(can('screen-record')
            ? [{ id: 'device.record', title: t('shell.cmd.record'), subtitle: deviceName, group: deviceGroup, icon: Video, keywords: ['record', 'kayıt', 'kaydı başlat', 'video', 'ekran kaydı', 'screen recording'], run: () => requestDeviceSection('record') }]
            : []),
          ...(scoped.bundleId && can('app-restart')
            ? [{ id: 'device.appRestart', title: t('shell.cmd.restart', { app: appName }), subtitle: deviceName, group: deviceGroup, icon: RotateCcw, keywords: ['restart', 'yeniden başlat', 'relaunch', 'app', 'uygulama'], run: () => restartApp(device.id, scoped.bundleId!, appName) }]
            : []),
          { id: 'device.info', title: t('shell.cmd.deviceInfo'), subtitle: deviceName, group: deviceGroup, icon: Info, keywords: ['device info', 'cihaz bilgisi', 'model', 'os', 'sürüm', 'version'], run: () => requestDeviceSection('info', 'heading') },
        ]
      : [];

  // Flows: the general commands work before the Flows tab was ever opened (its view registers the same ids once
  // it is mounted); one "open" and one "run" entry per flow, found by name or tag.
  const flowsGroup = t('common.groups.flows');
  const flowCommands: PaletteCommand[] = [
    { id: 'flows.new', title: t('shell.cmd.flowNew'), group: flowsGroup, icon: Plus, keywords: ['flow', 'akış', 'new', 'yeni', 'graph'], run: () => requestFlowIntent({ kind: 'new' }) },
    { id: 'flows.fromRequests', title: t('shell.cmd.flowFromRequests'), group: flowsGroup, icon: ListPlus, keywords: ['flow', 'akış', 'request', 'istek', 'network'], run: () => requestFlowIntent({ kind: 'requests' }) },
    { id: 'flows.ai', title: t('shell.cmd.flowAi'), group: flowsGroup, icon: Sparkles, keywords: ['ai', 'yapay zeka', 'prompt', 'flow', 'akış'], run: () => requestFlowIntent({ kind: 'ai' }) },
    { id: 'flows.import', title: t('shell.cmd.flowImport'), group: flowsGroup, icon: FileUp, keywords: ['import', 'içe aktar', 'flow', 'akış', 'json'], run: () => requestFlowIntent({ kind: 'import' }) },
    { id: 'flows.environments', title: t('shell.cmd.flowEnvironments'), group: flowsGroup, icon: Globe, keywords: ['env', 'ortam', 'environment', 'variables', 'değişken'], run: () => requestFlowIntent({ kind: 'environments' }) },
    ...automationCommands(t, flows, pausedAutomations, flowsGroup),
    ...flows.flatMap((f): PaletteCommand[] => {
      const keywords = ['flow', 'akış', f.id, ...(f.tags ?? [])];
      return [
        { id: `flows.open.${f.id}`, title: t('shell.cmd.flowOpen', { name: f.name }), group: flowsGroup, icon: Workflow, searchOnly: true, keywords: [...keywords, 'open', 'aç'], run: () => ui.focusFlow(f.id) },
        { id: `flows.runOne.${f.id}`, title: t('shell.cmd.flowRun', { name: f.name }), group: flowsGroup, icon: Play, searchOnly: true, keywords: [...keywords, 'run', 'çalıştır', 'akış çalıştır'], run: () => requestFlowIntent({ kind: 'run', flowId: f.id }) },
      ];
    }),
  ];
  const mocksGroup = t('common.groups.mocks');
  const mockCommands: PaletteCommand[] = mockRules.map((r) => ({
    id: `mocks.open.${r.id}`,
    title: t('shell.cmd.mockOpen', { name: r.name?.trim() || `${r.method === '*' ? '' : `${r.method} `}${r.url}` }),
    subtitle: r.enabled ? r.url : t('shell.cmd.mockOff'),
    group: mocksGroup,
    icon: TAB_ICONS.mocks,
    searchOnly: true,
    keywords: ['mock', 'kural', 'rule', r.url, r.method],
    run: () => ui.focusMock(r.id),
  }));

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
    {
      id: 'report.bug',
      title: t('report.cmd.open'),
      group: data,
      icon: Bug,
      keywords: ['bug', 'hata', 'report', 'rapor', 'crash', 'çökme', 'issue', 'jira', 'zip', 'screenshot', 'ekran görüntüsü', ...both('report.cmd.open')],
      priority: 8,
      run: () => bugReport.open(),
    },
    { id: 'export.all', title: t('shell.io.exportAll'), group: data, icon: FileDown, keywords: ['save', ...both('shell.io.exportAll')], run: exportSession },
    { id: 'export.har', title: t('shell.io.exportHar'), group: data, icon: FileDown, keywords: ['har', ...both('shell.io.exportHar')], run: exportHar },
    { id: 'import', title: t('shell.io.import'), group: data, icon: FileUp, keywords: ['open', ...both('shell.io.import')], run: () => void pickAndImport() },
    { id: 'package.share', title: t('transfer.menu.share'), group: data, icon: Share2, keywords: ['package', 'paket', 'export', 'team', 'takım', ...both('transfer.menu.share')], run: () => transfer.openExport('share') },
    { id: 'package.backup', title: t('transfer.menu.backup'), group: data, icon: Archive, keywords: ['package', 'paket', 'backup', 'yedek', 'mac', ...both('transfer.menu.backup')], run: () => transfer.openExport('backup') },
    { id: 'package.open', title: t('transfer.menu.open'), group: data, icon: PackageOpen, keywords: ['package', 'paket', 'restore', 'geri yükle', 'import', ...both('transfer.menu.open')], run: () => transfer.openImport() },
    { id: 'package.auto', title: t('transfer.menu.autoBackup'), group: data, icon: Archive, keywords: ['backup', 'yedek', 'icloud', 'auto', 'otomatik', ...both('transfer.menu.autoBackup')], run: () => ui.openSettings('backup') },
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
    ...deviceCommands,
    ...flowCommands,
    ...mockCommands,
  ];
  useCommands(commands);

  // App-wide shortcuts.
  const paletteOpen = useUi((s) => s.palette);
  useShortcut('Mod+K', ui.togglePalette, { allowInModal: paletteOpen });
  useShortcut('?', ui.openShortcuts);
  useShortcut('Mod+,', () => ui.openSettings());
  // The Mac app's menu (Dürbün → Settings…) sends its commands as a DOM event (apps/desktop preload).
  useEffect(() => {
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<unknown>).detail === 'settings') ui.openSettings();
    };
    window.addEventListener('durbun:command', onCommand);
    return () => window.removeEventListener('durbun:command', onCommand);
  }, []);
  useShortcut('Mod+B', toggleSidebar);
  useShortcut(['Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5', 'Mod+6'], (e) => {
    const n = Number(e.code?.startsWith('Digit') ? e.code.slice(5) : e.key) - 1;
    const id = TAB_IDS[n];
    if (!id) return false;
    ui.setTab(id);
  });
  // Fallback marker (the Logs view may register its own "M" which runs first).
  useShortcut('M', () => void addMarker(), { priority: -10 });
}

/** "Pause all automations" while any flow starts on its own; "Resume" for the set a pause switched off. */
function automationCommands(t: ReturnType<typeof useT>, flows: FlowSummary[], paused: string[], group: string): PaletteCommand[] {
  const on = automatedFlows(flows);
  const back = resumable(paused, flows);
  const names = new Map(flows.map((f) => [f.id, f.name]));
  const failures = (res: BulkResult) => res.failed.map((f) => `${names.get(f.id) ?? f.id}: ${errorText(f.error)}`).join('\n');
  const resume = async (ids: string[]) => {
    const res = await resumeAutomations(ids);
    if (res.failed.length) toast.warn(t('shell.cmd.flowResumePartial', { count: res.failed.length }), { description: failures(res) });
    else toast.success(t('shell.cmd.flowResumed', { count: res.done.length }));
  };
  const out: PaletteCommand[] = [];
  if (on.length)
    out.push({
      id: 'flows.pauseAll',
      title: t('shell.cmd.flowPauseAll'),
      subtitle: on.map((f) => f.name).join(', '),
      group,
      icon: Pause,
      keywords: ['automation', 'otomasyon', 'pause', 'duraklat', 'stop', 'durdur', 'trigger', 'tetikleyici'],
      run: async () => {
        const res = await pauseAutomations(on.map((f) => f.id));
        if (res.failed.length) toast.warn(t('shell.cmd.flowPausePartial', { count: res.failed.length }), { description: failures(res) });
        else if (res.done.length) toast.success(t('shell.cmd.flowPaused', { count: res.done.length }), { action: { label: t('shell.cmd.undo'), onClick: () => void resume(res.done) } });
      },
    });
  if (back.length)
    out.push({
      id: 'flows.resumeAll',
      title: t('shell.cmd.flowResumeAll'),
      subtitle: back.map((f) => f.name).join(', '),
      group,
      icon: Play,
      keywords: ['automation', 'otomasyon', 'resume', 'devam', 'trigger', 'tetikleyici'],
      run: () => resume(back.map((f) => f.id)),
    });
  return out;
}
