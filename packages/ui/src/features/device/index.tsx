import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight, Camera, Images, Link as LinkIcon, Moon, Plug, RotateCcw, Smartphone, Sun, Wifi } from 'lucide-react';
import type { AppSession, DeviceActionId, DeviceInfo } from '@durbun/protocol';
import { sendCommand, useDevice, useDevices, useHub, useScope } from '../../data';
import {
  Button,
  Callout,
  CountBadge,
  EmptyState,
  PlatformIcon,
  StatusDot,
  Toolbar,
  ToolbarSpacer,
  toast,
  useCommands,
  useFeatureActive,
  usePersistentState,
} from '../../components';
import { t as tNow, useT } from '../../i18n';
import './i18n';
import './device.css';
import { appsStructureKey, canPoll } from '../perf/model';
import { describeError, stateText } from './codes';
import { AppearanceCard } from './AppearanceCard';
import { AppsCard, useAppRows } from './AppsCard';
import { AppToolsCard } from './AppToolsCard';
import { DevicePicker } from './DevicePicker';
import { InfoCard, stateTone } from './InfoCard';
import { InputCard } from './InputCard';
import { LocationCard } from './LocationCard';
import { deviceColumns, hasAction, hasAnyAction, isReadOnlyDevice, osLine, type DeviceSectionId } from './model';
import { JUMP_STRIP_MIN, JumpStrip } from './JumpStrip';
import { hiddenDeviceActions, hiddenDeviceCards, showsIphoneReportGuide, wirelessPairingAvailable } from '../../data/explain';
import { openPairDialog, PairDialogHost } from './wireless/PairDialog';
import { IphoneReportCard } from './IphoneReportCard';
import { OpenUrlCard } from './OpenUrlCard';
import { ProcessesCard } from './ProcessesCard';
import { PushCard } from './PushCard';
import { RecordCard } from './RecordCard';
import { consumeDeviceRequest, flashDeviceSection, requestDeviceSection, revealDeviceCard, useDeviceRequest } from './request';
import { ScreenshotCard, captureScreenshot } from './ScreenshotCard';
import { LogsCard, StatusBarCard } from './SmallCards';
import { useMediaLibrary, ensureMedia } from './media/store';
import { MediaViewerHost } from './media/ViewerHost';
import { LibraryDialog, openLibrary } from './media/LibraryDialog';
import { VmCard } from './VmCard';
import { HiddenCardsCard } from './HiddenCards';
import { OverridesCard } from './OverridesCard';
import {
  APP_ACCESS_ACTIONS,
  AppAccessCard,
  CONNECTION_ACTIONS,
  ConnectionCard,
  DEV_OPTION_ACTIONS,
  DevOptionsCard,
  DeviceReportCard,
  REPORT_ACTIONS,
  SCREEN_ACTIONS,
  ScreenCard,
  TESTER_ACTIONS,
  showsCard,
} from './TesterCards';

const APP_ACTIONS: DeviceActionId[] = ['list-apps', 'app-launch', 'app-stop', 'app-restart', 'app-clear-data', 'app-uninstall', 'app-install'];
const LOOK_ACTIONS: DeviceActionId[] = ['appearance', 'font-scale', 'animations'];
const INPUT_ACTIONS: DeviceActionId[] = ['input-text', 'key-event'];
const LOG_ACTIONS: DeviceActionId[] = ['logs-clear-buffer', 'logs-restart'];

/** Quick device action from the command palette (no card state; toast feedback). */
async function quickAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>, success: string, failure: string): Promise<void> {
  try {
    await sendCommand({ name: 'device.action', deviceId, action, params });
    toast.success(success);
  } catch (err) {
    toast.error(failure, { description: describeError(err).text });
  }
}

function DeviceTitle({ device }: { device: DeviceInfo }) {
  const t = useT();
  const sub = [osLine(device), t(`device.info.kindType.${device.kind}`)].filter(Boolean).join(' · ');
  return (
    <div className="dv-title">
      <span className="dv-title__icon">
        <PlatformIcon device={device} size={17} />
      </span>
      <span className="dv-title__text">
        <span className="dv-title__name truncate">{device.name}</span>
        <span className="dv-title__sub truncate">{sub}</span>
      </span>
      <span className="dv-title__state">
        <StatusDot tone={stateTone(device)} size={7} />
        <span>{stateText(device)}</span>
      </span>
    </div>
  );
}

export default function DeviceView() {
  const t = useT();
  const active = useFeatureActive();
  const scope = useScope();
  const devices = useDevices();
  // Re-render on structural app changes (sessions, actions and their values) — not on every stats bump.
  const appsKey = useHub((s) => appsStructureKey(s.apps, { actions: true }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const apps = useMemo(() => useHub.getState().apps, [appsKey]);
  const [storedChoice, setChosen] = usePersistentState<string | null>('device.chosen', null);
  const chosen = typeof storedChoice === 'string' ? storedChoice : null;
  const [picking, setPicking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mediaCount = useMediaLibrary((s) => s.items.length);
  const canPair = useHub((s) => wirelessPairingAvailable(s.drivers));
  useEffect(() => ensureMedia(), []);

  const candidates = useMemo(() => devices.filter((d) => d.id !== 'desktop'), [devices]);
  let deviceId: string | undefined;
  if (scope.kind === 'device' || scope.kind === 'deviceApp') deviceId = scope.deviceId;
  else if (scope.kind === 'app') deviceId = apps[scope.appId]?.deviceId;
  else if (chosen && candidates.some((d) => d.id === chosen)) deviceId = chosen;
  else if (candidates.length === 1) deviceId = candidates[0]!.id;
  const device = useDevice(deviceId);
  const showPicker = scope.kind === 'all' && (picking || !device);
  const preferredAppId = scope.kind === 'app' ? apps[scope.appId]?.app.id : scope.kind === 'deviceApp' ? scope.bundleId : undefined;
  const scopedDeviceAppName = useHub((s) => (scope.kind === 'deviceApp' ? s.deviceApps[`${scope.deviceId}|${scope.bundleId}`]?.name || scope.bundleId : undefined));

  // Leave the picker when the scope narrows to a device.
  useEffect(() => {
    if (scope.kind !== 'all') setPicking(false);
  }, [scope.kind]);

  // Cross-tab requests ("Dart VM Service bağla" from Performance): scroll the section into view and focus it.
  const request = useDeviceRequest((s) => s.req);
  useEffect(() => {
    if (!request || !active) return;
    const id = requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-section="${request.section}"]`);
      if (el) {
        revealDeviceCard(el, request.focus);
        flashDeviceSection(request.section);
      }
      consumeDeviceRequest(request.seq);
    });
    return () => cancelAnimationFrame(id);
  }, [request, active, device?.id, showPicker]);

  const online = Boolean(device && device.state === 'online' && !isReadOnlyDevice(device));
  const group = t('common.groups.device');
  useCommands(
    active && device && online
      ? [
          ...(hasAction(device, 'screenshot')
            ? [{ id: 'device.screenshot', title: t('device.cmd.screenshot'), group, icon: Camera, keywords: ['screenshot', 'ekran görüntüsü', 'capture'], run: () => void captureScreenshot(device.id) }]
            : []),
          ...(hasAction(device, 'open-url')
            ? [{ id: 'device.openUrl', title: t('device.cmd.openUrl'), group, icon: LinkIcon, keywords: ['url', 'deep link', 'bağlantı', 'link'], run: () => requestDeviceSection('open-url') }]
            : []),
          ...(hasAction(device, 'appearance')
            ? [
                {
                  id: 'device.dark',
                  title: t('device.cmd.dark'),
                  group,
                  icon: Moon,
                  keywords: ['dark', 'koyu', 'appearance', 'görünüm'],
                  run: () => void quickAction(device.id, 'appearance', { mode: 'dark' }, tNow('device.look.done.dark'), tNow('device.look.failed.theme')),
                },
                {
                  id: 'device.light',
                  title: t('device.cmd.light'),
                  group,
                  icon: Sun,
                  keywords: ['light', 'açık', 'appearance', 'görünüm'],
                  run: () => void quickAction(device.id, 'appearance', { mode: 'light' }, tNow('device.look.done.light'), tNow('device.look.failed.theme')),
                },
              ]
            : []),
          ...(hasAction(device, 'logs-restart')
            ? [
                {
                  id: 'device.restartLogs',
                  title: t('device.cmd.restartLogs'),
                  group,
                  icon: RotateCcw,
                  keywords: ['logs', 'log', 'restart', 'yeniden başlat', 'akış'],
                  run: () => void quickAction(device.id, 'logs-restart', {}, tNow('device.logs.restarted'), tNow('device.logs.restartFailed')),
                },
              ]
            : []),
          { id: 'device.attachVm', title: t('device.cmd.attachVm'), group, icon: Plug, keywords: ['vm', 'dart', 'flutter', 'devtools', 'observatory'], run: () => requestDeviceSection('vm') },
        ]
      : [],
  );

  return (
    <div ref={rootRef} className="dv fill col">
      <Toolbar aria-label={t('device.title')}>
        {device && !showPicker ? <DeviceTitle device={device} /> : <span className="dv-toolbar-title">{t('device.title')}</span>}
        <ToolbarSpacer />
        {canPair ? (
          <Button size="sm" variant="ghost" icon={Wifi} onClick={openPairDialog} title={t('device.wireless.buttonHint')} aria-label={t('device.wireless.button')} className="dv-media-btn">
            <span className="dv-media-btn__label">{t('device.wireless.button')}</span>
          </Button>
        ) : null}
        {mediaCount > 0 ? (
          <Button size="sm" variant="ghost" icon={Images} onClick={() => openLibrary()} title={t('media.libraryDesc')} aria-label={`${t('media.libraryButton')} · ${mediaCount}`} className="dv-media-btn">
            <span className="dv-media-btn__label">{t('media.libraryButton')}</span>
            <CountBadge count={mediaCount} />
          </Button>
        ) : null}
        {scope.kind === 'all' && candidates.length > 1 && device ? (
          <Button size="sm" variant={showPicker ? 'subtle' : 'ghost'} icon={ArrowLeftRight} onClick={() => setPicking((p) => !p)} aria-pressed={showPicker}>
            {t('device.picker.change')}
          </Button>
        ) : scope.kind !== 'all' && device ? (
          <span className="dv-scope-hint">
            {scope.kind === 'app' && apps[scope.appId]
              ? t('device.picker.appScope', { app: apps[scope.appId]!.app.name })
              : scopedDeviceAppName
                ? t('device.picker.appScope', { app: scopedDeviceAppName })
                : t('device.picker.fromScope')}
          </span>
        ) : null}
      </Toolbar>
      <div className="dv-scroll scroll-y fill">
        {showPicker ? (
          <DevicePicker
            devices={candidates}
            apps={apps}
            selectedId={device?.id}
            onPick={(id) => {
              setChosen(id);
              setPicking(false);
            }}
          />
        ) : device ? (
          <DevicePage key={device.id} device={device} apps={apps} preferredAppId={preferredAppId} active={active} />
        ) : (
          <EmptyState
            icon={Smartphone}
            size="lg"
            title={t('device.picker.noDevices')}
            description={t('device.picker.noDevicesHint')}
            actions={
              canPair || mediaCount > 0 ? (
                <>
                  {canPair ? (
                    <Button icon={Wifi} onClick={openPairDialog} title={t('device.wireless.buttonHint')}>
                      {t('device.wireless.button')}
                    </Button>
                  ) : null}
                  {mediaCount > 0 ? (
                    <Button icon={Images} onClick={() => openLibrary()}>
                      {`${t('media.libraryButton')} · ${mediaCount}`}
                    </Button>
                  ) : null}
                </>
              ) : undefined
            }
          />
        )}
      </div>
      <LibraryDialog />
      <MediaViewerHost />
      <PairDialogHost />
    </div>
  );
}

function DevicePage({ device, apps, preferredAppId, active }: { device: DeviceInfo; apps: Record<string, AppSession>; preferredAppId?: string; active: boolean }) {
  const t = useT();
  const sessions = useMemo(() => Object.values(apps).filter((a) => a.deviceId === device.id), [apps, device.id]);
  const appRows = useAppRows(device, sessions);
  const hasShots = useMediaLibrary((s) => s.items.some((x) => x.deviceId === device.id && x.kind === 'screenshot'));
  const hasRecordings = useMediaLibrary((s) => s.items.some((x) => x.deviceId === device.id && x.kind === 'recording'));
  const processesKnown = useHub((s) => Object.keys(s.processes[device.id] ?? {}).length > 0);
  const imported = device.id.startsWith('import:');
  const readOnly = isReadOnlyDevice(device);
  const online = device.state === 'online' && !readOnly;
  const can = (a: DeviceActionId) => online && hasAction(device, a);
  const canAny = (list: DeviceActionId[]) => online && hasAnyAction(device, list);
  const hiddenCount = online ? (hiddenDeviceActions(device, TESTER_ACTIONS) ?? hiddenDeviceCards(device)).length : 0;
  // Tester cards: shown when one of their actions runs here or is blocked for a reason they say.
  const shows = (list: readonly DeviceActionId[]) => online && showsCard(device, list);

  // One entry per card that is shown, in reading order; `section` is the card's own `data-section`.
  type Entry = { section: DeviceSectionId; node: ReactNode };
  const entries = (
    [
      // What the device is and holds (info, apps, processes, its logs and its own report).
      { section: 'info', node: <InfoCard device={device} /> },
      online && { section: 'tools', node: <AppToolsCard sessions={sessions} preferredAppId={preferredAppId} /> },
      canAny(APP_ACTIONS) && { section: 'apps', node: <AppsCard device={device} sessions={sessions} preferredAppId={preferredAppId} active={active} /> },
      (online || sessions.some((x) => x.transport === 'vm-service')) && !imported && { section: 'vm', node: <VmCard device={device} sessions={sessions} /> },
      processesKnown && { section: 'processes', node: <ProcessesCard device={device} sessions={sessions} canWatch={online && canPoll(device)} /> },
      canAny(LOG_ACTIONS) && { section: 'logs', node: <LogsCard device={device} /> },
      (shows(REPORT_ACTIONS) || Boolean(device.bugReport)) && { section: 'bug-report', node: <DeviceReportCard device={device} /> },
      !readOnly && showsIphoneReportGuide(device) && { section: 'bug-report', node: <IphoneReportCard device={device} /> },
      // What a tester does to the device.
      online && Boolean(device.settingOverrides?.length) && { section: 'overrides', node: <OverridesCard device={device} apps={appRows} /> },
      (can('screenshot') || hasShots) && { section: 'screenshot', node: <ScreenshotCard device={device} canTake={can('screenshot')} /> },
      can('open-url') && { section: 'open-url', node: <OpenUrlCard device={device} apps={appRows} /> },
      shows(APP_ACCESS_ACTIONS) && { section: 'app-access', node: <AppAccessCard device={device} sessions={sessions} preferredAppId={preferredAppId} /> },
      shows(CONNECTION_ACTIONS) && { section: 'connection', node: <ConnectionCard device={device} /> },
      canAny(LOOK_ACTIONS) && { section: 'appearance', node: <AppearanceCard device={device} /> },
      shows(SCREEN_ACTIONS) && { section: 'screen', node: <ScreenCard device={device} /> },
      shows(DEV_OPTION_ACTIONS) && { section: 'dev-options', node: <DevOptionsCard device={device} /> },
      canAny(INPUT_ACTIONS) && { section: 'input', node: <InputCard device={device} /> },
      can('location') && { section: 'location', node: <LocationCard device={device} /> },
      can('push-notification') && { section: 'push', node: <PushCard device={device} apps={appRows} preferredAppId={preferredAppId} /> },
      can('status-bar') && { section: 'status-bar', node: <StatusBarCard device={device} /> },
      (can('screen-record') || hasRecordings) && { section: 'record', node: <RecordCard device={device} /> },
      online && hiddenCount > 0 && { section: 'hidden', node: <HiddenCardsCard device={device} shownInline={TESTER_ACTIONS} /> },
    ] as (Entry | false)[]
  ).filter((e): e is Entry => Boolean(e));
  const columns = deviceColumns(entries.map((e) => e.section));
  const sections = [...columns.left, ...columns.right];
  const cards = (list: DeviceSectionId[]) => list.map((s) => <Fragment key={s}>{entries.find((e) => e.section === s)!.node}</Fragment>);
  // "No actions for this device" only when no card does anything to it (the logs and report cards are actions too).
  const NOT_ACTIONS: readonly DeviceSectionId[] = ['info', 'tools', 'apps', 'vm', 'processes'];
  const noActions = online && hiddenCount === 0 && sections.every((s) => NOT_ACTIONS.includes(s));

  return (
    <>
      {sections.length >= JUMP_STRIP_MIN ? <JumpStrip sections={sections} onJump={(section) => requestDeviceSection(section, 'heading')} /> : null}
      <div className="dv-page">
        <div className="dv-cols">
          <div className="dv-col" role="region" aria-label={t('device.columns.info')}>
            {cards(columns.left)}
          </div>
          <div className="dv-col" role="region" aria-label={t('device.columns.actions')}>
            {noActions ? (
              <Callout tone="info" title={t('device.noActions')}>
                {device.id.startsWith('net:') ? t('device.codes.device.networkOnly') : t('device.noActionsHint')}
              </Callout>
            ) : null}
            {cards(columns.right)}
          </div>
        </div>
      </div>
    </>
  );
}
