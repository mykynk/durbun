import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CircleAlert, CircleDot, FolderClock, Undo2, X } from 'lucide-react';
import { useLanguage, useT } from '../../i18n';
import { ui, useConnection } from '../../data';
import { Button, IconButton } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { formatBytes, formatNumber } from '../../lib/format';
import { offerSeen, pauseText, recordingCounts, recordingDuration, recordingSpan, recordingWhen, recordingWho } from './model';
import { initRecordings, recordings, useRecordings } from './store';
import { RecordingsDialog } from './RecordingsDialog';
import './recordings.css';

/**
 * At launch, when the previous run left a recording: a small card in the corner (not a modal, nothing is in the
 * way) that says when, how long, which devices and apps and what it holds; one click opens it. Closing it, or
 * opening it, is remembered per recording.
 */
export function LaunchOffer() {
  const t = useT();
  const lang = useLanguage();
  const { list, closed, viewing, opening } = useRecordings(useShallow((s) => ({ list: s.list, closed: s.offerClosed, viewing: s.viewing, opening: s.opening })));
  const live = useConnection((s) => s.status === 'live');
  const previous = useMemo(() => (list?.previous ? list.recordings.find((r) => r.id === list.previous) : undefined), [list]);
  if (!previous || closed || viewing || !live || offerSeen(previous.id)) return null;
  const crashed = previous.state === 'interrupted';
  return (
    <aside className="rec-offer" role="complementary" aria-label={t('recordings.offer.label')}>
      <div className="rec-offer__icon" aria-hidden>
        <FolderClock size={16} />
      </div>
      <div className="rec-offer__body">
        <div className="rec-offer__title">{t('recordings.offer.title')}</div>
        <div className="rec-offer__meta tnum">
          {recordingWhen(previous.startedAt, lang)} · {recordingSpan(recordingDuration(previous), lang)}
          {crashed ? <span className="rec-offer__warn"> · {t('recordings.state.interrupted')}</span> : null}
        </div>
        <div className="rec-offer__who">{recordingWho(previous, lang)}</div>
        <div className="rec-offer__counts tnum">{recordingCounts(previous, lang)}</div>
        <div className="rec-offer__actions">
          <Button size="sm" variant="primary" loading={opening === previous.id} onClick={() => void recordings.open(previous.id)}>
            {t('recordings.offer.open')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => (recordings.closeOffer(previous.id), recordings.openDialog())}>
            {t('recordings.offer.all')}
          </Button>
        </div>
      </div>
      <IconButton className="rec-offer__close" icon={X} size="sm" label={t('recordings.offer.dismiss')} onClick={() => recordings.closeOffer(previous.id)} />
    </aside>
  );
}

/**
 * While a recording is shown: a banner that stays above every tab, so the window never passes for live data.
 * "Back to live" leaves it; live capture went on meanwhile.
 */
export function RecordingBanner() {
  const t = useT();
  const lang = useLanguage();
  const viewing = useRecordings((s) => s.viewing);
  if (!viewing) return null;
  const { recording: r, opened } = viewing;
  const notes: string[] = [];
  if (opened.left.logs > 0 || opened.left.requests > 0) notes.push(t('recordings.banner.partial', { logs: formatNumber(opened.loaded.logs), requests: formatNumber(opened.loaded.requests) }));
  if (opened.damaged) notes.push(t('recordings.banner.damaged'));
  return (
    <div className="banner banner--recording" role="status" aria-live="polite">
      <FolderClock size={14} aria-hidden />
      <span className="banner__text">
        <b className="tnum">{t('recordings.banner.label', { when: recordingWhen(r.startedAt, lang) })}</b>
        <span className="rec-banner__notlive"> · {t('recordings.banner.notLive')}</span>
        <span className="subtle">
          {' · '}
          {recordingSpan(recordingDuration(r), lang)} · {recordingWho(r, lang)}
          {r.state === 'interrupted' ? ` · ${t('recordings.state.interrupted')}` : ''}
          {notes.length ? ` · ${notes.join(' · ')}` : ''}
        </span>
      </span>
      <Button size="sm" variant="ghost" onClick={recordings.openDialog}>
        {t('recordings.actions.list')}
      </Button>
      <Tooltip content={t('recordings.banner.liveGoesOn')}>
        <Button size="sm" variant="primary" icon={Undo2} onClick={recordings.backToLive}>
          {t('recordings.actions.backToLive')}
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * Status bar: "Kayıt" while a recording is shown (back to live on click), a warning while recording is paused,
 * else a quiet icon that says this session is being recorded (opens the list).
 */
export function RecorderStatusItem() {
  const t = useT();
  const lang = useLanguage();
  const viewing = useRecordings((s) => s.viewing !== null);
  const status = useRecordings((s) => s.list?.status);
  const live = useRecordings((s) => s.list?.recordings.find((r) => r.state === 'recording'));
  if (viewing) {
    return (
      <Tooltip content={t('recordings.statusBar.viewingHint')}>
        <button type="button" className="st-badge st-badge--recording" onClick={recordings.backToLive}>
          <FolderClock size={11} aria-hidden />
          {t('recordings.statusBar.viewing')}
        </button>
      </Tooltip>
    );
  }
  if (!status) return null;
  if (status.state === 'paused') {
    const why = status.paused ? pauseText(status.paused, lang) : '';
    return (
      <Tooltip content={why || t('recordings.statusBar.paused')}>
        <button type="button" className="st-item st-warn st-button" onClick={() => ui.openSettings('recordings')}>
          <CircleAlert size={12} aria-hidden />
          {t('recordings.statusBar.paused')}
        </button>
      </Tooltip>
    );
  }
  if (status.state !== 'recording') return null;
  const label = t('recordings.statusBar.recording', { size: formatBytes(live?.bytes ?? 0) });
  return (
    <Tooltip content={label}>
      <button type="button" className="st-icon st-rec" onClick={recordings.openDialog} aria-label={label}>
        <CircleDot size={13} />
      </button>
    </Tooltip>
  );
}

/** Mounted once in App: follows the server and hosts the list dialog (the launch offer sits in the main area). */
export function RecordingsHost() {
  useEffect(() => initRecordings(), []);
  return <RecordingsDialog />;
}
