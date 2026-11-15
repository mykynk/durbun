import { memo, type CSSProperties } from 'react';
import { ArrowDown, Archive, Bug, Hourglass, Info, LocateFixed, OctagonX, Pause, Play, Settings2, TriangleAlert, Undo2, X } from 'lucide-react';
import type { LogEntry } from '@durbun/protocol';
import { Button, IconButton, formatClock } from '../../../components';
import { t, useT } from '../../../i18n';
import { analyzeEntry } from '../model/analyze';
import type { DeviceMark } from './LogRow';

/** "Pati çöktü · <headline>" for a crash-like entry. */
export function crashTitle(e: LogEntry, appName: string | undefined): string {
  const a = analyzeEntry(e);
  const app = appName ?? t('logs.crash.appFallback');
  const c = a.crash;
  if (!c) return e.message;
  if (c.previousLaunch) return t('logs.crash.previous', { app });
  if (c.kind === 'anr') return t('logs.crash.anr', { app });
  if (c.kind === 'flutter-error') return t('logs.crash.flutter', { app });
  return t('logs.crash.crashed', { app });
}

export interface CrashBannerProps {
  crashes: readonly LogEntry[];
  appName(e: LogEntry): string | undefined;
  /** Several devices in the list: which one crashed (the same app may run on more than one). */
  device?: (e: LogEntry) => DeviceMark | undefined;
  onGoto(e: LogEntry): void;
  /** "Report a bug" anchored to the crash. */
  onReport?(e: LogEntry): void;
  onDismiss(lastId: number): void;
}

/** Loud, dismissible banner for live crashes / ANRs / Flutter errors in scope (SPEC §1.1-7). */
export const CrashBanner = memo(function CrashBanner({ crashes, appName, device, onGoto, onReport, onDismiss }: CrashBannerProps) {
  useT(); // re-render on language change (memoized)
  const latest = crashes[crashes.length - 1];
  if (!latest) return null;
  const a = analyzeEntry(latest);
  const kind = a.crash?.kind ?? 'crash';
  const Icon = kind === 'anr' ? Hourglass : kind === 'flutter-error' ? TriangleAlert : OctagonX;
  const more = crashes.length - 1;
  const dev = device?.(latest);
  return (
    <div className={`lg-banner lg-banner--${kind}`} role="alert">
      <Icon size={16} className="lg-banner__icon" aria-hidden />
      <div className="lg-banner__text">
        <span className="lg-banner__title">{crashTitle(latest, appName(latest))}</span>
        {dev ? (
          <span className="lg-dev lg-dev--inline lg-banner__dev" style={{ '--dev-h': dev.hue } as CSSProperties} title={dev.name}>
            <span className="lg-dev__name">{dev.short ?? dev.name}</span>
          </span>
        ) : null}
        <span className="lg-banner__sep" aria-hidden>
          ·
        </span>
        <span className="lg-banner__headline mono" title={a.crash?.title}>
          {a.crash?.title ?? latest.message}
        </span>
        <span className="lg-banner__time tnum">{formatClock(latest.ts, { ms: false })}</span>
        {more > 0 ? <span className="lg-banner__more">{t('logs.crash.more', { count: more })}</span> : null}
      </div>
      {onReport ? (
        <Button size="sm" variant="secondary" icon={Bug} title={t('report.openHint')} onClick={() => onReport(latest)}>
          {t('report.open')}
        </Button>
      ) : null}
      <Button size="sm" variant="danger" icon={ArrowDown} onClick={() => onGoto(latest)}>
        {t('logs.crash.goto')}
      </Button>
      <IconButton icon={X} label={t('logs.crash.dismiss')} size="sm" onClick={() => onDismiss(latest.id)} />
    </div>
  );
});

/** Explicit pause: "Duraklatıldı · 312 yeni satır  [Devam et]". */
export const PausedBar = memo(function PausedBar({ pending, onResume }: { pending: number; onResume(): void }) {
  useT(); // re-render on language change (memoized)
  return (
    <div className="lg-paused" role="status">
      <Pause size={13} aria-hidden />
      <span className="lg-paused__title">{t('logs.paused.title')}</span>
      <span className="lg-paused__sep" aria-hidden>
        ·
      </span>
      <span className="tnum">{t('logs.paused.newLines', { count: pending })}</span>
      <Button size="sm" variant="primary" icon={Play} kbd="Space" onClick={onResume}>
        {t('logs.resume')}
      </Button>
    </div>
  );
});

/** Floating "↓ 57 yeni" pill shown while scrolled up (not following). */
export const NewLinesPill = memo(function NewLinesPill({ count, onClick }: { count: number; onClick(): void }) {
  useT(); // re-render on language change (memoized)
  return (
    <button type="button" className="lg-pill" onClick={onClick} title={t('logs.follow.jump')}>
      <ArrowDown size={13} aria-hidden />
      {count > 0 ? <span className="tnum">{t('logs.newPill', { count })}</span> : <span>{t('logs.backToLive')}</span>}
      <kbd className="lg-pill__kbd">G</kbd>
    </button>
  );
});

/**
 * Physical iPhones with `iosDeviceLogScope: 'apps'` (the server's default): their daemons' lines are left out on
 * purpose. Said once, calmly, with the way to see everything (dismissal is remembered).
 */
export const IosScopeNote = memo(function IosScopeNote({ device, onOpenSettings, onDismiss }: { device?: string; onOpenSettings(): void; onDismiss(): void }) {
  useT(); // re-render on language change (memoized)
  return (
    <div className="lg-note" role="note">
      <Info size={13} aria-hidden />
      <p className="lg-note__text">
        <strong>{device ? t('sources.iosScope.titleFor', { device }) : t('sources.iosScope.title')}.</strong> {t('sources.iosScope.body')}
      </p>
      <Button size="sm" variant="ghost" icon={Settings2} onClick={onOpenSettings}>
        {t('sources.iosScope.open')}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        {t('logs.iosScope.dismiss')}
      </Button>
    </div>
  );
});

/**
 * A line was shown that the user's filters hide ("Show in context", a jump from another tab, a notification): the
 * filters that hid it are suspended for this view only. Says which, and offers the way back. Editing a filter
 * keeps the view (the bar goes away).
 */
export const ContextBar = memo(function ContextBar({ parts, scopeName, onBack }: { parts: readonly string[]; scopeName?: string; onBack(): void }) {
  useT(); // re-render on language change (memoized)
  const names = parts.filter((p) => p !== 'scope').map((p) => t(`logs.context.part.${p}`));
  const list = names.join(', ');
  const text =
    names.length && scopeName
      ? t('logs.context.textScope', { parts: list, scope: scopeName })
      : names.length
        ? t('logs.context.text', { parts: list })
        : t('logs.context.scopeOnly', { scope: scopeName ?? '' });
  return (
    <div className="lg-paused lg-context" role="status">
      <LocateFixed size={13} aria-hidden />
      <span className="lg-context__text">{text}</span>
      <Button size="sm" variant="primary" icon={Undo2} onClick={onBack}>
        {t('logs.context.back')}
      </Button>
    </div>
  );
});

/**
 * The oldest lines were dropped by the memory limit (or are about to be): said where the user looks for them, at
 * the top of the list, with how many, since when the list starts, and the setting that moves the limit.
 */
export const DroppedNote = memo(function DroppedNote({ dropped, limit, since, onOpenSettings }: { dropped: number; limit: number; since?: number; onOpenSettings(): void }) {
  useT(); // re-render on language change (memoized)
  return (
    <div className="lg-note lg-dropped" role="note">
      <Archive size={13} aria-hidden />
      <p className="lg-note__text">
        <strong>{dropped > 0 ? t('logs.dropped.title', { count: dropped }) : t('logs.dropped.titleFull')}</strong>{' '}
        {t('logs.dropped.body', { limit })}
        {since !== undefined ? ` ${t('logs.dropped.since', { time: formatClock(since, { ms: false }) })}` : ''}
      </p>
      <Button size="sm" variant="ghost" icon={Settings2} onClick={onOpenSettings}>
        {t('logs.dropped.settings')}
      </Button>
    </div>
  );
});
