import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import { Activity, BookOpen, ChevronRight, CirclePause, CloudOff, FlaskConical, LayoutGrid, PanelLeftClose, PanelLeftOpen, Stethoscope, TriangleAlert } from 'lucide-react';
import type { AppSession, DeviceInfo } from '@durbun/protocol';
import { useT } from '../i18n';
import { deviceDisplayName, deviceStateText, logStatusText } from '../i18n/codes';
import {
  deviceGroup,
  logStore,
  networkStore,
  setScope,
  ui,
  useAppGroups,
  useDemoActive,
  useDevices,
  useLogVersion,
  useNetworkVersion,
  usePrefs,
  useScope,
  useUi,
  type AppGroup,
  type DeviceGroup,
  type Scope,
} from '../data';
import { DurbunMark, PlatformIcon, SdkBadge } from '../components/Icons';
import { IconButton } from '../components/Button';
import { StatusDot } from '../components/Badges';
import { Spinner } from '../components/Spinner';
import { Tooltip } from '../components/Tooltip';
import { usePersistentState } from '../hooks';
import { formatClock, formatCompact } from '../lib/format';
import { appTitle, appVersion, connectionLabel, deviceSubtitle, importLabel, isNetworkOnly, stateTone } from './labels';
import { setDemo, toggleSidebar } from './actions';

const SECTION_ORDER: DeviceGroup[] = ['live', 'demo', 'import', 'other'];

/** Left navigation: "All devices", devices with their app sessions, footer links. */
export function Sidebar() {
  const t = useT();
  const collapsedPref = usePrefs((s) => s.sidebarCollapsed);
  const { narrow, overlay } = useUi(useShallow((s) => ({ narrow: s.narrow, overlay: s.sidebarOverlay })));
  const compact = narrow ? !overlay : collapsedPref;
  const devices = useDevices();
  const groups = useAppGroups();
  const scope = useScope();
  const demo = useDemoActive();
  const [collapsedDevices, setCollapsedDevices] = usePersistentState<string[]>('sidebar.collapsedDevices', []);
  useLogVersion({ throttleMs: 1000 });
  useNetworkVersion({ throttleMs: 1000 });

  const sections = useMemo(() => {
    const by = new Map<DeviceGroup, DeviceInfo[]>();
    for (const d of devices) {
      const g = deviceGroup(d.id);
      let list = by.get(g);
      if (!list) by.set(g, (list = []));
      list.push(d);
    }
    return SECTION_ORDER.filter((g) => by.has(g)).map((g) => ({ group: g, devices: by.get(g)! }));
  }, [devices, groups]);

  const toggleDevice = (id: string) =>
    setCollapsedDevices((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-sb-item]')];
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = items[e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const allSelected = scope.kind === 'all';
  const totalLogs = logStore.counts.total;

  return (
    <>
      <nav className={clsx('sidebar', compact && 'is-compact', narrow && overlay && 'is-overlay')} aria-label={t('shell.sidebar.label')}>
        <div className="sb-header">
          <div className="sb-brand">
            <DurbunMark tile size={24} />
            {!compact ? <span className="sb-wordmark">Dürbün</span> : null}
          </div>
          {!compact ? <IconButton icon={PanelLeftClose} label={t('shell.sidebar.collapse')} shortcut="Mod+B" size="sm" onClick={toggleSidebar} /> : null}
        </div>

        <div
          className="sb-scroll"
          role="tree"
          aria-label={t('shell.sidebar.devices')}
          onKeyDown={onTreeKeyDown}
          onClick={(e) => {
            // Picking a scope in the narrow overlay closes it.
            if (narrow && overlay && (e.target as HTMLElement).closest('[data-sb-item]')) ui.setSidebarOverlay(false);
          }}
        >
          <SidebarRow
            compact={compact}
            selected={allSelected}
            icon={<LayoutGrid size={16} aria-hidden />}
            title={t('shell.scope.all')}
            meta={totalLogs > 0 ? formatCompact(totalLogs) : undefined}
            onSelect={() => setScope({ kind: 'all' })}
          />

          {sections.map((section) => (
            <div key={section.group} className="sb-section" role="group">
              {!compact ? <div className="sb-section__label">{t(`shell.sidebar.section.${section.group}`)}</div> : <div className="sb-section__rule" />}
              {section.devices.map((d) => (
                <DeviceNode
                  key={d.id}
                  device={d}
                  groups={groups.get(d.id) ?? []}
                  scope={scope}
                  compact={compact}
                  expanded={!collapsedDevices.includes(d.id)}
                  onToggle={() => toggleDevice(d.id)}
                />
              ))}
            </div>
          ))}

          {devices.length === 0 && !compact ? <p className="sb-empty">{t('shell.sidebar.noDevices')}</p> : null}
        </div>

        <div className="sb-footer">
          {compact && !narrow ? <IconButton icon={PanelLeftOpen} label={t('shell.sidebar.expand')} shortcut="Mod+B" tooltipSide="right" onClick={toggleSidebar} /> : null}
          <FooterLink compact={compact} icon={<BookOpen size={15} aria-hidden />} label={t('shell.sdk.title')} onClick={() => ui.openSdkGuide()} />
          <FooterLink compact={compact} icon={<Stethoscope size={15} aria-hidden />} label={t('shell.doctor.title')} onClick={() => ui.openDoctor()} />
          {demo ? (
            <FooterLink
              compact={compact}
              icon={<FlaskConical size={15} aria-hidden />}
              label={t('shell.demo.active')}
              hint={t('shell.demo.turnOff')}
              accent
              onClick={() => void setDemo(false)}
            />
          ) : null}
        </div>
      </nav>
      {narrow && overlay ? <div className="sb-scrim" onClick={() => ui.setSidebarOverlay(false)} aria-hidden /> : null}
    </>
  );
}

function FooterLink({ compact, icon, label, hint, accent, onClick }: { compact: boolean; icon: ReactNode; label: string; hint?: string; accent?: boolean; onClick: () => void }) {
  const btn = (
    <button type="button" className={clsx('sb-link', accent && 'sb-link--accent')} onClick={onClick} aria-label={compact ? label : undefined}>
      {icon}
      {!compact ? <span className="truncate">{label}</span> : null}
      {!compact && hint ? <span className="sb-link__hint">{hint}</span> : null}
    </button>
  );
  return compact ? (
    <Tooltip content={hint ? `${label} · ${hint}` : label} side="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

interface RowProps {
  compact: boolean;
  selected: boolean;
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  tooltip?: string;
  onSelect: () => void;
  level?: number;
  expanded?: boolean;
  onToggle?: () => void;
  dim?: boolean;
  className?: string;
}

function SidebarRow({ compact, selected, icon, title, subtitle, meta, tooltip, onSelect, level = 1, expanded, onToggle, dim, className }: RowProps) {
  const t = useT();
  const main = (
    <button
      type="button"
      data-sb-item
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      aria-expanded={onToggle ? expanded : undefined}
      aria-label={compact && typeof title === 'string' ? title : undefined}
      className="sb-row__main"
      onClick={onSelect}
      onKeyDown={(e) => {
        if (!onToggle) return;
        if (e.key === 'ArrowRight' && !expanded) {
          e.preventDefault();
          onToggle();
        } else if (e.key === 'ArrowLeft' && expanded) {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="sb-row__icon">{icon}</span>
      {!compact ? (
        <span className="sb-row__text">
          <span className="sb-row__title">{title}</span>
          {subtitle ? <span className="sb-row__subtitle">{subtitle}</span> : null}
        </span>
      ) : null}
      {!compact && meta ? <span className="sb-row__meta">{meta}</span> : null}
    </button>
  );
  return (
    <div className={clsx('sb-row', selected && 'is-selected', dim && 'is-dim', compact && 'is-compact', className)}>
      {compact ? (
        <Tooltip content={tooltip ?? (typeof title === 'string' ? title : undefined)} side="right">
          {main}
        </Tooltip>
      ) : (
        main
      )}
      {!compact && onToggle ? (
        <button type="button" className={clsx('sb-row__chevron', expanded && 'is-open')} aria-label={expanded ? t('common.collapse') : t('common.expand')} tabIndex={-1} onClick={onToggle}>
          <ChevronRight size={13} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function LogStatusIcon({ device }: { device: DeviceInfo }) {
  const status = device.logs.status;
  const text = logStatusText(device);
  // The server's English detail only adds something when the UI has no localized text for the code.
  const detail = [text, device.logs.via, !device.logs.code && device.logs.detail && device.logs.detail !== text ? device.logs.detail : undefined].filter(Boolean).join(' · ');
  if (device.state === 'disconnected') return null;
  let icon: ReactNode;
  if (isNetworkOnly(device)) icon = <CloudOff size={12} className="sb-logstat" aria-hidden />;
  else if (status === 'streaming') icon = <Activity size={12} className="sb-logstat sb-logstat--ok" aria-hidden />;
  else if (status === 'starting') icon = <Spinner size={11} />;
  else if (status === 'unavailable' || status === 'error') icon = <TriangleAlert size={12} className="sb-logstat sb-logstat--warn" aria-hidden />;
  else icon = <CirclePause size={12} className="sb-logstat" aria-hidden />;
  return (
    <Tooltip content={detail}>
      <span className="sb-logstat-wrap" role="img" aria-label={text}>
        {icon}
      </span>
    </Tooltip>
  );
}

function DeviceNode({
  device,
  groups,
  scope,
  compact,
  expanded,
  onToggle,
}: {
  device: DeviceInfo;
  groups: AppGroup[];
  scope: Scope;
  compact: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const appOnDevice = scope.kind === 'app' && groups.some((g) => g.sessions.some((s) => s.id === scope.appId));
  // Collapsed sidebar hides app rows: highlight the device that holds the selected app instead.
  const selected = (scope.kind === 'device' && scope.deviceId === device.id) || (compact && appOnDevice);
  const imported = device.id.startsWith('import:');
  const desktop = device.id === 'desktop';
  const networkOnly = isNetworkOnly(device);
  const conn = connectionLabel(device);
  const tone = stateTone(device);
  const requests = desktop ? (networkStore.countsByDevice.get(device.id)?.total ?? 0) : 0;
  const count = logStore.countsByDevice.get(device.id)?.total ?? 0;
  const attention = device.state === 'unauthorized' || device.state === 'offline';
  // Imported sessions are recordings, not unplugged devices: keep them readable.
  const disconnected = device.state === 'disconnected' && !imported;
  const name = deviceDisplayName(device);
  const source = importLabel(device);
  let subtitle = deviceSubtitle(device, { origin: false });
  if (desktop) subtitle = t('shell.device.requests', { count: requests });
  else if (networkOnly && device.state === 'online') subtitle = [subtitle, t('shell.device.networkOnlyShort')].filter(Boolean).join(' · ');
  const stateText = imported ? [t('shell.device.importedRecording'), source].filter(Boolean).join(': ') : desktop ? t('shell.device.desktopHint') : deviceStateText(device);

  const icon = (
    <span className="sb-device-icon">
      <PlatformIcon device={device} size={16} />
      <StatusDot tone={tone} size={7} className={clsx('sb-device-icon__dot', (imported || desktop) && 'dot--hollow')} />
    </span>
  );

  return (
    <div className="sb-node">
      <SidebarRow
        compact={compact}
        selected={selected}
        icon={icon}
        dim={disconnected}
        title={
          <>
            <span className="truncate" title={name}>
              {name}
            </span>
            {conn ? <span className="sb-conn">{conn}</span> : null}
          </>
        }
        subtitle={
          subtitle || !disconnected || imported ? (
            <>
              {imported ? <span className="sb-conn sb-conn--import">{t('shell.device.imported')}</span> : null}
              <span className="truncate" title={imported ? stateText : undefined}>
                {disconnected ? t('code.state.disconnected') : subtitle}
              </span>
              {device.state === 'online' && !desktop ? <LogStatusIcon device={device} /> : null}
            </>
          ) : undefined
        }
        meta={count > 0 && !desktop ? formatCompact(count) : undefined}
        tooltip={[name, subtitle, stateText].filter(Boolean).join(' · ')}
        onSelect={() => setScope({ kind: 'device', deviceId: device.id })}
        expanded={groups.length > 0 ? expanded : undefined}
        onToggle={groups.length > 0 ? onToggle : undefined}
      />
      {attention && !compact ? (
        <div className="sb-hint" role="note">
          <TriangleAlert size={12} aria-hidden />
          <span>{deviceStateText(device)}</span>
        </div>
      ) : null}
      {expanded && groups.length > 0 && !compact ? (
        <div role="group" className="sb-apps">
          {groups.map((g) => (
            <AppNode key={g.key} group={g} scope={scope} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AppNode({ group, scope }: { group: AppGroup; scope: Scope }) {
  const t = useT();
  const [showSessions, setShowSessions] = useState(false);
  const latest = group.latest;
  const ids = group.sessions.map((s) => s.id);
  const selected = scope.kind === 'app' && !scope.exact && ids.includes(scope.appId);
  const exactSelected = scope.kind === 'app' && scope.exact ? scope.appId : null;
  const hint = { deviceId: group.deviceId, bundleId: group.bundleId };
  const version = appVersion(latest);
  const older = group.sessions.length - 1;
  const selectSession = (s: AppSession) => setScope({ kind: 'app', appId: s.id, exact: true }, hint);

  return (
    <div className="sb-app-node">
      <div className={clsx('sb-row', 'sb-row--app', selected && 'is-selected', !group.connected && 'is-dim')}>
        <button
          type="button"
          data-sb-item
          role="treeitem"
          aria-level={2}
          aria-selected={selected}
          className="sb-row__main"
          onClick={() => setScope({ kind: 'app', appId: latest.id }, hint)}
          aria-label={`${appTitle(latest)}${version ? ` ${version}` : ''} · ${group.connected ? t('shell.sidebar.appLive') : t('shell.sidebar.appGone')}`}
          title={`${latest.app.id}${version ? ` · ${version}` : ''}`}
        >
          <SdkBadge platform={latest.sdk.platform} />
          <span className="sb-row__text">
            <span className="sb-row__title">
              <span className="truncate">{appTitle(latest)}</span>
              {version ? <span className="sb-app__ver">{version}</span> : null}
            </span>
          </span>
          <StatusDot tone={group.connected ? 'success' : 'neutral'} pulse={group.connected} size={7} title={group.connected ? t('shell.sidebar.appLive') : t('shell.sidebar.appGone')} className={clsx(!group.connected && 'dot--hollow')} />
        </button>
      </div>
      {older > 0 ? (
        <button type="button" className="sb-older" aria-expanded={showSessions} onClick={() => setShowSessions((v) => !v)}>
          <ChevronRight size={11} className={clsx('sb-older__chev', showSessions && 'is-open')} aria-hidden />
          {t('shell.sidebar.olderSessions', { count: older })}
        </button>
      ) : null}
      {showSessions ? (
        <div className="sb-sessions" role="group">
          {group.sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              data-sb-item
              role="treeitem"
              aria-level={3}
              aria-selected={exactSelected === s.id}
              className={clsx('sb-session', exactSelected === s.id && 'is-selected')}
              onClick={() => selectSession(s)}
            >
              <StatusDot tone={s.connected ? 'success' : 'neutral'} size={6} className={clsx(!s.connected && 'dot--hollow')} />
              <span className="tnum">{formatClock(s.connectedAt, { ms: false })}</span>
              <span className="sb-session__meta truncate">
                {appVersion(s) ?? ''} {s.connected ? `· ${t('shell.sidebar.thisSession')}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
