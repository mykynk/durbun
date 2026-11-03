import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { clsx } from 'clsx';
import { BookOpen, CircleCheck, CircleDashed, CircleMinus, Info, Lightbulb, Play, Settings2, Stethoscope, type LucideIcon } from 'lucide-react';
import { useT } from '../i18n';
import { deviceDisplayName, logStatusText } from '../i18n/codes';
import type { DeviceInfo } from '@durbun/protocol';
import type { BuildBadge, ExplainAction, ExplainBadge, ExplainCapability, ExplainReason, ExplainRow, ExplainStatus } from '../data/explain';
import { buildBadgeOf } from '../data/explain';
import { ui } from '../data/stores/ui';
import { useHub } from '../data/stores/hub';
import { Button, IconButton } from '../components/Button';
import { Callout, EmptyState } from '../components/Layout';
import { Popover } from '../components/Popover';
import { Tooltip } from '../components/Tooltip';
import type { IconType } from '../components/Icons';
import { formatRelative } from '../lib/format';
import {
  TIP_ACTIONS,
  actionLabel,
  badgeHint,
  badgeLabel,
  badgeTooltip,
  buildBadgeHint,
  buildBadgeLabel,
  capabilityLabel,
  crashReaderText,
  frameReaderText,
  reasonText,
  sourceHint,
  sourceLabel,
  statusLabel,
  summaryText,
  tipText,
  type ReasonTextOptions,
} from './text';
import { idleApp, pickEmptyReason, useAppExplain, useCrashRecordsState, useIdleApp, useIosSystemLinesHidden, useScopeExplain, type EmptyExplanation, type ExplainedApp } from './model';
import { actionAvailable, runExplainAction } from './actions';
import './sources.css';

/* ───────────── badges ───────────── */

/** SDK / VM Service / Yalnızca cihaz logu — where the app's data comes from (`short` for narrow sidebar rows). */
export function SourceBadge({ badge, short, className }: { badge: ExplainBadge; short?: boolean; className?: string }) {
  return (
    <Tooltip content={short ? badgeTooltip(badge) : badgeHint(badge)}>
      <span className={clsx('src-badge', `src-badge--${badge}`, className)} tabIndex={-1} aria-label={badgeLabel(badge)}>
        {badgeLabel(badge, { short })}
      </span>
    </Tooltip>
  );
}

/** Debug · Firebase · Play · Xcode · Store / TestFlight / ad-hoc · Simülatör · Galaxy Store… · APK. */
export function BuildBadgeChip({ badge, installer, short, className }: { badge: BuildBadge; installer?: string; short?: boolean; className?: string }) {
  const label = buildBadgeLabel(badge, installer, { short });
  const full = buildBadgeLabel(badge, installer);
  return (
    <Tooltip content={label === full ? buildBadgeHint(badge, installer) : `${full} · ${buildBadgeHint(badge, installer)}`}>
      <span className={clsx('build-badge', `build-badge--${badge}`, className)} tabIndex={-1} aria-label={full}>
        {label}
      </span>
    </Tooltip>
  );
}

const STATUS_ICON: Record<ExplainStatus, LucideIcon> = { yes: CircleCheck, partial: CircleDashed, no: CircleMinus };

export function StatusIcon({ status, size = 15 }: { status: ExplainStatus; size?: number }) {
  const Icon = STATUS_ICON[status];
  return <Icon size={size} className={clsx('src-status', `src-status--${status}`)} aria-label={statusLabel(status)} role="img" />;
}

/* ───────────── reason / action rendering ───────────── */

/** Commands and code inside sentences (flags, the interceptor line, flutter run) render as code, unbroken. */
const CODE_TOKENS = /(--dart-define=[^\s,;)]+|\.addInterceptor\(DurbunInterceptor\(\)\)|flutter run|split-debug-info|dSYM)/g;

export function RichText({ text }: { text: string }) {
  const parts = text.split(CODE_TOKENS);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <code key={i} className="src-code">
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

function reasonOptions(device: DeviceInfo | undefined): ReasonTextOptions {
  return { device: device ? deviceDisplayName(device) : undefined, logs: device ? logStatusText(device) : undefined };
}

export function ReasonList({ item, reasons, capability, device, className }: { item: ExplainedApp | undefined; reasons: readonly ExplainReason[]; capability?: ExplainCapability; device?: DeviceInfo; className?: string }) {
  const opts = reasonOptions(device ?? item?.input.device);
  const texts = [...new Set(reasons.map((r) => reasonText(r, item?.result.context, capability, opts)))];
  if (texts.length === 0) return null;
  return (
    <ul className={clsx('src-reasons', className)}>
      {texts.map((x) => (
        <li key={x}>
          <RichText text={x} />
        </li>
      ))}
    </ul>
  );
}

/** Buttons for actions (tips render as a lightbulb line instead). `seen` dedupes across rows of one panel. */
export function ActionButtons({
  actions,
  item,
  seen,
  onAction,
  size = 'sm',
  primary,
  show = 'both',
}: {
  actions: readonly ExplainAction[];
  item: ExplainedApp | undefined;
  seen?: Set<ExplainAction>;
  onAction?: (a: ExplainAction) => boolean | void;
  size?: 'sm' | 'md';
  primary?: boolean;
  /** Empty states put the tips under the reasons and the buttons in their action row. */
  show?: 'both' | 'tips' | 'buttons';
}) {
  const fresh = actions.filter((a) => {
    if (seen?.has(a)) return false;
    seen?.add(a);
    return true;
  });
  const tips = fresh.filter((a) => TIP_ACTIONS.has(a));
  const buttons = fresh.filter((a) => !TIP_ACTIONS.has(a) && actionAvailable(a, item));
  const tipLines = show === 'buttons' ? [] : [...tips, ...buttons.filter((a) => tipText(a))].map((a) => ({ a, text: tipText(a)! })).filter((x) => x.text);
  if (show === 'tips') buttons.length = 0;
  if (buttons.length === 0 && tipLines.length === 0) return null;
  return (
    <div className="src-actions">
      {tipLines.map(({ a, text }) => (
        <p key={a} className="src-tip">
          <Lightbulb size={13} aria-hidden />
          <span>
            <RichText text={text} />
          </span>
        </p>
      ))}
      {buttons.length > 0 ? (
        <div className="src-actions__buttons">
          {buttons.map((a, i) => (
            <Button key={a} size={size} variant={primary && i === 0 ? 'primary' : 'secondary'} onClick={() => runExplainAction(a, item, onAction)}>
              {actionLabel(a)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ───────────── "Neler görünüyor?" panel ───────────── */

function MatrixRow({ row, item, seen }: { row: ExplainRow; item: ExplainedApp; seen: Set<ExplainAction> }) {
  return (
    <li className={clsx('src-row', `src-row--${row.status}`)}>
      <StatusIcon status={row.status} />
      <div className="src-row__body">
        <div className="src-row__head">
          <span className="src-row__cap">{capabilityLabel(row.capability)}</span>
          <span className={clsx('src-row__status', `src-row__status--${row.status}`)}>{statusLabel(row.status)}</span>
        </div>
        {row.sources.length > 0 ? (
          <div className="src-row__sources">
            {row.sources.map((s) => (
              <Tooltip key={s} content={sourceHint(s)}>
                <span className="src-source" tabIndex={0}>
                  {sourceLabel(s)}
                </span>
              </Tooltip>
            ))}
          </div>
        ) : null}
        <ReasonList item={item} reasons={row.reasons} capability={row.capability} />
        <ActionButtons actions={row.actions} item={item} seen={seen} />
      </div>
    </li>
  );
}

/** Header of an app: name, version (build), build + source badges, device · bundle id. */
function PanelHeader({ item }: { item: ExplainedApp }) {
  const t = useT();
  const ctx = item.result.context;
  const device = item.input.device;
  const build = buildBadgeOf(item.input);
  const name = ctx?.appName || item.group.bundleId;
  const version = ctx?.version ? (ctx.buildNumber && ctx.buildNumber !== ctx.version ? `${ctx.version} (${ctx.buildNumber})` : ctx.version) : undefined;
  const da = item.group.deviceApp;
  return (
    <div className="src-panel__head">
      <div className="src-panel__title">
        <span className="src-panel__name">{name}</span>
        {version ? <span className="src-panel__ver tnum">{version}</span> : null}
      </div>
      <div className="src-panel__badges">
        <SourceBadge badge={item.result.badge} />
        {build ? <BuildBadgeChip badge={build} installer={da?.install.installer} /> : null}
        <span className={clsx('src-panel__run', item.group.running && 'is-on')}>
          {item.group.running ? t('sources.running') : item.group.lastActivity ? t('sources.lastSeen', { ago: formatRelative(item.group.lastActivity) }) : t('sources.notRunningShort')}
        </span>
      </div>
      <div className="src-panel__sub">
        {device ? <span className="truncate">{deviceDisplayName(device)}</span> : null}
        <span className="mono truncate selectable">{item.group.bundleId}</span>
        {da?.crashReports ? <span>{t('sources.crashReports', { count: da.crashReports })}</span> : null}
      </div>
    </div>
  );
}

/** The matrix for one app, in plain language (popover body; also usable inline). */
export function SourcesPanel({ item, onNavigate }: { item: ExplainedApp; onNavigate?: () => void }) {
  const t = useT();
  const seen = new Set<ExplainAction>();
  const notes = item.result.notes ?? [];
  const ctx = item.result.context;
  return (
    <div className="src-panel" onClick={(e) => (e.target as HTMLElement).closest('button') && onNavigate?.()}>
      <PanelHeader item={item} />
      <p className="src-panel__summary">{summaryText(item.result.badge, ctx)}</p>
      {notes.map((n) => (
        <Callout key={n} tone="info" compact className="src-note">
          <RichText text={reasonText(n, ctx, undefined, reasonOptions(item.input.device))} />
          {/* A closed app: starting it is the one thing that makes its data come (shown once per panel). */}
          {n === 'notRunning' ? <ActionButtons actions={['launchApp']} item={item} seen={seen} /> : null}
        </Callout>
      ))}
      <ul className="src-matrix">
        {item.result.rows.map((r) => (
          <MatrixRow key={r.capability} row={r} item={item} seen={seen} />
        ))}
      </ul>
      <div className="src-panel__foot">
        <button type="button" className="src-link" onClick={() => ui.openDataSources()}>
          <BookOpen size={13} aria-hidden />
          {t('sources.general')}
        </button>
        <button type="button" className="src-link" onClick={() => ui.openDoctor()}>
          <Stethoscope size={13} aria-hidden />
          {t('sources.doctor')}
        </button>
      </div>
    </div>
  );
}

/** ⓘ button that opens "Neler görünüyor?" for an app group. */
export function WhatCanISeeButton({ groupKey, size = 'xs', className, label }: { groupKey: string; size?: 'xs' | 'sm'; className?: string; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={ref}
        icon={Info}
        size={size}
        label={label ?? t('sources.title')}
        className={clsx('src-info-btn', open && 'is-open', className)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      />
      {open ? <SourcesPopover groupKey={groupKey} anchor={ref} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SourcesPopover({ groupKey, anchor, onClose }: { groupKey: string; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const t = useT();
  const item = useAppExplain(groupKey);
  return (
    <Popover open anchor={anchor} onClose={onClose} side="right" align="start" width={400} aria-label={t('sources.title')} className="src-popover">
      {item ? <SourcesPanel item={item} onNavigate={onClose} /> : <p className="src-panel__summary">{t('sources.notRunningShort')}</p>}
    </Popover>
  );
}

/* ───────────── empty states / callouts ───────────── */

export interface ExplainEmptyProps {
  capability: ExplainCapability;
  icon?: IconType;
  /** Shown when the reason is not structural (the app simply has not sent anything yet). */
  fallback: ReactNode;
  /** Treat 'partial' as worth explaining too (Performance: CPU/memory only from outside). */
  includePartial?: boolean;
  /** Handle an action in place (return true to skip the default). */
  onAction?: (a: ExplainAction) => boolean | void;
  size?: 'sm' | 'md' | 'lg';
  /** Extra content under the reasons. */
  children?: ReactNode;
}

/**
 * Reasons that belong to the device, not to an app's build: every app of the device has them. Several apps with
 * only these get one sentence about the device instead of "none of the apps has the SDK" (an iPhone waiting for
 * «Güven», an unplugged phone, a device log that does not come).
 */
const DEVICE_REASONS: ReadonlySet<ExplainReason> = new Set<ExplainReason>(['readOnly', 'deviceLogsUnavailable', 'toolMissing', 'networkOnly']);

function deviceWide(pick: EmptyExplanation): boolean {
  return !pick.single && pick.reasons.length > 0 && pick.reasons.every((r) => DEVICE_REASONS.has(r));
}

/**
 * Scope-specific empty state: when the scoped app(s) cannot have this capability, say why (naming the app and
 * build) with the actions that would enable it; otherwise render `fallback`.
 */
export function ExplainEmpty({ capability, icon, fallback, includePartial, onAction, size = 'lg', children }: ExplainEmptyProps) {
  const t = useT();
  const scope = useScopeExplain();
  const pick = pickEmptyReason(capability, scope, { includePartial });
  // The app is simply closed: say so (and offer to start it) instead of "nothing yet" or an SDK setup hint.
  // A capability the app can never have still says why first.
  const idle = idleApp(scope);
  if (idle && (!pick.structural || pick.status === 'partial')) {
    return (
      <NotRunningEmpty item={idle} capability={capability} icon={icon} size={size}>
        {children}
      </NotRunningEmpty>
    );
  }
  // 'partial' over several apps (e.g. CPU/memory by polling on a whole device) is better served by the view's own empty state.
  if (!pick.structural || scope.kind === 'none' || (pick.status === 'partial' && !pick.single)) return <>{fallback}</>;
  const single = pick.single;
  const ctx = single?.result.context;
  const app = ctx?.appName || single?.group.bundleId;
  const titleKey = capability === 'metrics' && pick.status === 'no' ? 'sources.empty.metrics.noTitle' : `sources.empty.${capability}.title`;
  const title = single ? t(titleKey, { app }) : t(`sources.empty.${capability}.deviceTitle`);
  const items = single ? [single] : pick.rows.filter((r) => r.row.status !== 'yes').map((r) => r.item).slice(0, 4);
  // The device itself is the reason (waiting for «Güven», unplugged…): say it once, not per app.
  const wide = deviceWide(pick);
  const perApp = single ? null : wide ? (
    <ReasonList item={items[0]} reasons={pick.reasons} capability={capability} />
  ) : (
    <p className="src-empty__lead">{t(`sources.empty.${capability}.device`)}</p>
  );
  return (
    <EmptyState
      size={size}
      icon={icon}
      title={title}
      description={
        <div className="src-empty">
          {perApp}
          {single ? (
            <ReasonList item={single} reasons={pick.reasons} capability={capability} />
          ) : wide ? null : (
            <ul className="src-empty__apps">
              {items.map((it) => {
                const row = it.result.rows.find((r) => r.capability === capability);
                return (
                  <li key={it.key}>
                    <span className="src-empty__app">{it.result.context?.appName || it.group.bundleId}</span>
                    <SourceBadge badge={it.result.badge} />
                    <ReasonList item={it} reasons={(row?.reasons ?? []).filter((r) => r !== 'noOutsideNetwork')} capability={capability} />
                  </li>
                );
              })}
            </ul>
          )}
          {!single && pick.reasons.includes('noOutsideNetwork') ? <ReasonList item={items[0]} reasons={['noOutsideNetwork']} capability={capability} /> : null}
          <ActionButtons actions={pick.actions} item={single ?? items[0]} show="tips" />
        </div>
      }
      actions={<ActionButtons actions={pick.actions} item={single ?? items[0]} onAction={onAction} size="md" primary show="buttons" />}
    >
      {children}
      <button type="button" className="src-link" onClick={() => ui.openDataSources()}>
        <BookOpen size={13} aria-hidden />
        {t('sources.general')}
      </button>
    </EmptyState>
  );
}

/**
 * Empty state of a scoped app that is not running: "{app} şu an açık değil" + what shows up once it opens, with a
 * launch button when the device can start it. `ExplainEmpty` renders it by itself; views can use it directly.
 */
export function NotRunningEmpty({ item, capability, icon, size = 'lg', children }: { item: ExplainedApp; capability: ExplainCapability; icon?: IconType; size?: 'sm' | 'md' | 'lg'; children?: ReactNode }) {
  const t = useT();
  const app = item.result.context?.appName || item.group.bundleId;
  const launchable = actionAvailable('launchApp', item);
  return (
    <EmptyState
      size={size}
      icon={icon}
      title={t('sources.idle.title', { app })}
      description={<p className="src-empty__lead">{t(`sources.idle.body.${capability}`, { app })}</p>}
      actions={
        launchable ? (
          <Button variant="primary" size="md" icon={Play} onClick={() => runExplainAction('launchApp', item)}>
            {actionLabel('launchApp')}
          </Button>
        ) : undefined
      }
    >
      {children}
      <button type="button" className="src-link" onClick={() => ui.openDataSources()}>
        <BookOpen size={13} aria-hidden />
        {t('sources.general')}
      </button>
    </EmptyState>
  );
}

/**
 * Compact form for a list that is not empty (the device's own system rows are there): "{app} şu an açık değil",
 * what shows up once it opens, and the launch button. Null when the scoped app is running or not online.
 */
export function NotRunningNote({ capability, className }: { capability: ExplainCapability; className?: string }) {
  const t = useT();
  const item = useIdleApp();
  if (!item) return null;
  const app = item.result.context?.appName || item.group.bundleId;
  return (
    <Callout
      tone="info"
      compact
      title={t('sources.idle.title', { app })}
      className={clsx('src-idle-note', className)}
      actions={
        actionAvailable('launchApp', item) ? (
          <Button size="sm" icon={Play} onClick={() => runExplainAction('launchApp', item)}>
            {actionLabel('launchApp')}
          </Button>
        ) : undefined
      }
    >
      <p>{t(`sources.idle.body.${capability}`, { app })}</p>
    </Callout>
  );
}

/**
 * Above the log list of a scope with a live iPhone: its system processes are left out by the server
 * (`iosDeviceLogScope` 'apps'), and where to change that. Null when nothing is hidden.
 */
export function IosLogScopeNote({ className }: { className?: string }) {
  const t = useT();
  const hidden = useIosSystemLinesHidden();
  if (hidden.length === 0) return null;
  const one = hidden.length === 1 ? hidden[0] : undefined;
  return (
    <Callout
      tone="info"
      compact
      title={one ? t('sources.iosScope.titleFor', { device: deviceDisplayName(one) }) : t('sources.iosScope.title')}
      className={clsx('src-ios-scope', className)}
      actions={
        <Button size="sm" icon={Settings2} onClick={() => ui.openSettings('logs')}>
          {t('sources.iosScope.open')}
        </Button>
      }
    >
      <p>{t('sources.iosScope.body')}</p>
    </Callout>
  );
}

/** Compact callout variant (Mocks list, tools card) — null when nothing structural to say. */
export function ExplainCallout({ capability, onAction, className }: { capability: ExplainCapability; onAction?: (a: ExplainAction) => boolean | void; className?: string }) {
  const t = useT();
  const scope = useScopeExplain();
  const pick = pickEmptyReason(capability, scope);
  const devices = useHub((s) => s.devices);
  if (!pick.structural || scope.kind === 'none') return null;
  const single = pick.single;
  const app = single?.result.context?.appName || single?.group.bundleId;
  const title = single ? t(`sources.empty.${capability}.title`, { app }) : t(`sources.empty.${capability}.deviceTitle`);
  return (
    <Callout tone="info" compact title={title} className={clsx('src-callout', className)}>
      {single ? (
        <ReasonList item={single} reasons={pick.reasons} capability={capability} device={devices[single.group.deviceId]} />
      ) : deviceWide(pick) && pick.rows[0] ? (
        <ReasonList item={pick.rows[0].item} reasons={pick.reasons} capability={capability} device={devices[pick.rows[0].item.group.deviceId]} />
      ) : (
        <p>{t(`sources.empty.${capability}.device`)}</p>
      )}
      <ActionButtons actions={pick.actions} item={single ?? pick.rows[0]?.item} onAction={onAction} />
    </Callout>
  );
}

/** "Neler görünüyor?" for the current scope (top bar): the scoped app's panel in a popover. */
export function ScopeSourcesButton({ className }: { className?: string }) {
  const t = useT();
  const scope = useScopeExplain();
  if (scope.kind !== 'app' || scope.items.length !== 1) return null;
  const item = scope.items[0]!;
  return <WhatCanISeeButton groupKey={item.key} size="sm" className={className} label={t('sources.titleFor', { app: item.result.context?.appName || item.group.bundleId })} />;
}

/* ───────────── crash empty states ───────────── */

/**
 * Under an empty crash list: whether "no crash" really means none yet (the device's own records are read) or
 * the records of a device in scope cannot be read (why + how). `onlyProblems`: nothing in the first case.
 */
export function CrashRecordsNote({ onlyProblems, className }: { onlyProblems?: boolean; className?: string }) {
  const t = useT();
  const st = useCrashRecordsState();
  if (st.unreadable.length > 0) {
    const one = st.unreadable.length === 1 ? st.unreadable[0] : undefined;
    const title = one ? t('sources.crashEmpty.unreadableTitle', { device: deviceDisplayName(one) }) : t('sources.crashEmpty.unreadableMany');
    const needsXcode = st.unreadable.some((d) => /\.devicectlMissing$/.test(d.readers?.crashReports?.code ?? ''));
    return (
      <Callout
        tone="info"
        compact
        title={title}
        className={clsx('src-crash-note', className)}
        actions={
          needsXcode ? (
            <Button size="sm" onClick={() => ui.openDoctor()}>
              {actionLabel('openDoctor')}
            </Button>
          ) : undefined
        }
      >
        <p>{t('sources.crashEmpty.unreadableLead')}</p>
        <ul className="src-reasons">
          {st.unreadable.map((d) => (
            <li key={d.id}>
              {one ? null : <strong>{deviceDisplayName(d)}: </strong>}
              <RichText text={crashReaderText(d)} />
            </li>
          ))}
        </ul>
      </Callout>
    );
  }
  if (onlyProblems || st.readable.length === 0) return null;
  const one = st.readable.length === 1 ? st.readable[0] : undefined;
  return (
    <p className={clsx('src-crash-note src-crash-note--ok', className)}>
      <strong>{t('sources.crashEmpty.noneTitle')}.</strong> {t('sources.crashEmpty.none', { device: one ? deviceDisplayName(one) : undefined })}
    </p>
  );
}

/** Performance of a process measured from outside: why FPS is missing when the device gives no frame stats. */
export function FrameStatsNote({ deviceId, className }: { deviceId: string; className?: string }) {
  const t = useT();
  const device = useHub((s) => s.devices[deviceId]);
  const text = device && device.platform === 'android' && device.state === 'online' ? frameReaderText(device) : '';
  if (!text) return null;
  return (
    <Callout tone="info" compact title={t('sources.framesNote.title')} className={clsx('src-frames-note', className)}>
      <RichText text={text} />
    </Callout>
  );
}
