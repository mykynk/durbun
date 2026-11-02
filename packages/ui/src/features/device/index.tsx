import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Camera, Link as LinkIcon, Moon, Plug, RotateCcw, Smartphone, Sun } from 'lucide-react';
import type { AppSession, DeviceActionId, DeviceInfo } from '@durbun/protocol';
import { sendCommand, useDevice, useDevices, useHub, useScope } from '../../data';
import {
  Button,
  Callout,
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
import { hasAction, hasAnyAction, isReadOnlyDevice, osLine } from './model';
import { OpenUrlCard } from './OpenUrlCard';
import { ProcessesCard } from './ProcessesCard';
import { PushCard } from './PushCard';
import { RecordCard } from './RecordCard';
import { consumeDeviceRequest, requestDeviceSection, useDeviceRequest } from './request';
import { ScreenshotCard, captureScreenshot } from './ScreenshotCard';
import { LogsCard, StatusBarCard } from './SmallCards';
import { useMedia } from './stores';
import { VmCard } from './VmCard';

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

  const candidates = useMemo(() => devices.filter((d) => d.id !== 'desktop'), [devices]);
  let deviceId: string | undefined;
  if (scope.kind === 'device') deviceId = scope.deviceId;
  else if (scope.kind === 'app') deviceId = apps[scope.appId]?.deviceId;
  else if (chosen && candidates.some((d) => d.id === chosen)) deviceId = chosen;
  else if (candidates.length === 1) deviceId = candidates[0]!.id;
  const device = useDevice(deviceId);
  const showPicker = scope.kind === 'all' && (picking || !device);
  const preferredAppId = scope.kind === 'app' ? apps[scope.appId]?.app.id : undefined;

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
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        el.querySelector<HTMLElement>('textarea, input:not([type="checkbox"]):not([type="range"])')?.focus({ preventScroll: true });
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
        {scope.kind === 'all' && candidates.length > 1 && device ? (
          <Button size="sm" variant={showPicker ? 'subtle' : 'ghost'} icon={ArrowLeftRight} onClick={() => setPicking((p) => !p)} aria-pressed={showPicker}>
            {t('device.picker.change')}
          </Button>
        ) : scope.kind !== 'all' && device ? (
          <span className="dv-scope-hint">{scope.kind === 'app' && apps[scope.appId] ? t('device.picker.appScope', { app: apps[scope.appId]!.app.name }) : t('device.picker.fromScope')}</span>
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
          <EmptyState icon={Smartphone} size="lg" title={t('device.picker.noDevices')} description={t('device.picker.noDevicesHint')} />
        )}
      </div>
    </div>
  );
}

function DevicePage({ device, apps, preferredAppId, active }: { device: DeviceInfo; apps: Record<string, AppSession>; preferredAppId?: string; active: boolean }) {
  const t = useT();
  const sessions = useMemo(() => Object.values(apps).filter((a) => a.deviceId === device.id), [apps, device.id]);
  const appRows = useAppRows(device, sessions);
  const hasShots = useMedia((s) => s.shots.some((x) => x.deviceId === device.id));
  const hasRecordings = useMedia((s) => s.recordings.some((x) => x.deviceId === device.id));
  const processesKnown = useHub((s) => Object.keys(s.processes[device.id] ?? {}).length > 0);
  const imported = device.id.startsWith('import:');
  const readOnly = isReadOnlyDevice(device);
  const online = device.state === 'online' && !readOnly;
  const can = (a: DeviceActionId) => online && hasAction(device, a);
  const canAny = (list: DeviceActionId[]) => online && hasAnyAction(device, list);

  const actionCards = [
    can('screenshot') || hasShots ? <ScreenshotCard key="shot" device={device} canTake={can('screenshot')} /> : null,
    can('open-url') ? <OpenUrlCard key="url" device={device} apps={appRows} /> : null,
    canAny(LOOK_ACTIONS) ? <AppearanceCard key="look" device={device} /> : null,
    canAny(INPUT_ACTIONS) ? <InputCard key="input" device={device} /> : null,
    can('location') ? <LocationCard key="loc" device={device} /> : null,
    can('push-notification') ? <PushCard key="push" device={device} apps={appRows} preferredAppId={preferredAppId} /> : null,
    can('status-bar') ? <StatusBarCard key="bar" device={device} /> : null,
    can('screen-record') || hasRecordings ? <RecordCard key="rec" device={device} /> : null,
    canAny(LOG_ACTIONS) ? <LogsCard key="logs" device={device} /> : null,
  ].filter(Boolean);

  return (
    <div className="dv-page">
      <div className="dv-cols">
        <div className="dv-col" role="region" aria-label={t('device.columns.info')}>
          <InfoCard device={device} />
          {online ? <AppToolsCard sessions={sessions} preferredAppId={preferredAppId} /> : null}
          {canAny(APP_ACTIONS) ? <AppsCard device={device} sessions={sessions} preferredAppId={preferredAppId} active={active} /> : null}
          {(online || sessions.some((x) => x.transport === 'vm-service')) && !imported ? <VmCard device={device} sessions={sessions} /> : null}
          {processesKnown ? <ProcessesCard device={device} sessions={sessions} canWatch={online && canPoll(device)} /> : null}
        </div>
        <div className="dv-col" role="region" aria-label={t('device.columns.actions')}>
          {actionCards.length > 0 ? (
            actionCards
          ) : online ? (
            <Callout tone="info" title={t('device.noActions')}>
              {device.id.startsWith('net:') ? t('device.codes.device.networkOnly') : t('device.noActionsHint')}
            </Callout>
          ) : null}
        </div>
      </div>
    </div>
  );
}
