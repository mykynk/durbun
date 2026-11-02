import { memo } from 'react';
import { ArrowDown, Hourglass, OctagonX, Pause, Play, TriangleAlert, X } from 'lucide-react';
import type { LogEntry } from '@durbun/protocol';
import { Button, IconButton, formatClock } from '../../../components';
import { t, useT } from '../../../i18n';
import { analyzeEntry } from '../model/analyze';

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
  onGoto(e: LogEntry): void;
  onDismiss(lastId: number): void;
}

/** Loud, dismissible banner for live crashes / ANRs / Flutter errors in scope (SPEC §1.1-7). */
export const CrashBanner = memo(function CrashBanner({ crashes, appName, onGoto, onDismiss }: CrashBannerProps) {
  useT(); // re-render on language change (memoized)
  const latest = crashes[crashes.length - 1];
  if (!latest) return null;
  const a = analyzeEntry(latest);
  const kind = a.crash?.kind ?? 'crash';
  const Icon = kind === 'anr' ? Hourglass : kind === 'flutter-error' ? TriangleAlert : OctagonX;
  const more = crashes.length - 1;
  return (
    <div className={`lg-banner lg-banner--${kind}`} role="alert">
      <Icon size={16} className="lg-banner__icon" aria-hidden />
      <div className="lg-banner__text">
        <span className="lg-banner__title">{crashTitle(latest, appName(latest))}</span>
        <span className="lg-banner__sep" aria-hidden>
          ·
        </span>
        <span className="lg-banner__headline mono" title={a.crash?.title}>
          {a.crash?.title ?? latest.message}
        </span>
        <span className="lg-banner__time tnum">{formatClock(latest.ts, { ms: false })}</span>
        {more > 0 ? <span className="lg-banner__more">{t('logs.crash.more', { count: more })}</span> : null}
      </div>
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
