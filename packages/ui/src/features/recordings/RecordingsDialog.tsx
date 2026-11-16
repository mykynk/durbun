import { useEffect } from 'react';
import { clsx } from 'clsx';
import { CircleDot, Download, Ellipsis, FileLock2, FolderClock, RefreshCw, Settings2, Trash2, Undo2 } from 'lucide-react';
import type { RecorderStatus, SessionRecording } from '@durbun/protocol';
import { useLanguage, useT } from '../../i18n';
import { api, ui, updateServerSettings } from '../../data';
import { Dialog, confirm } from '../../components/Dialog';
import { Button, IconButton } from '../../components/Button';
import { Chip, StatusDot, type Tone } from '../../components/Badges';
import { Callout, EmptyState } from '../../components/Layout';
import { DropdownMenu } from '../../components/Menu';
import { Spinner } from '../../components/Spinner';
import { downloadUrl } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { isClosed, pauseText, recordingCounts, recordingDuration, recordingSpan, recordingWhen, recordingWho } from './model';
import { recordings, useRecordings } from './store';
import './recordings.css';

/** Refresh the list every few seconds while something shows it (sizes and counts of the live one move). */
export function useRecordingsPoll(active: boolean, ms = 5000): void {
  useEffect(() => {
    if (!active) return;
    void recordings.refresh();
    const timer = setInterval(() => void recordings.refresh(), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
}

const STATUS_TONE: Record<RecorderStatus['state'], Tone> = { recording: 'success', waiting: 'neutral', paused: 'warn', off: 'neutral' };

/** "Bu oturum kaydediliyor · 312 MB / 1 GB kullanılıyor" with the reason when paused. */
export function RecorderStatusLine({ status, compact }: { status: RecorderStatus; compact?: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const text = t(`recordings.status.${status.state}`);
  return (
    <div className={clsx('rec-status', compact && 'rec-status--compact')} role="status">
      <StatusDot tone={STATUS_TONE[status.state]} pulse={status.state === 'recording'} size={7} />
      <span className="rec-status__state">{text}</span>
      {status.state === 'paused' && status.paused && !compact ? <span className="rec-status__why">{pauseText(status.paused, lang)}</span> : null}
      <span className="rec-status__used tnum">
        {status.enabled
          ? t('recordings.status.used', { used: formatBytes(status.usedBytes), max: formatBytes(status.maxBytes) })
          : t('recordings.status.usedShort', { used: formatBytes(status.usedBytes) })}
      </span>
    </div>
  );
}

function exportRecording(id: string, mask: boolean): void {
  downloadUrl(api.recordingExportUrl(id, { mask }));
}

async function askDelete(r: SessionRecording, lang: ReturnType<typeof useLanguage>, t: ReturnType<typeof useT>): Promise<void> {
  const ok = await confirm({
    title: t('recordings.confirmDelete.title'),
    message: t('recordings.confirmDelete.message', { when: recordingWhen(r.startedAt, lang), size: formatBytes(r.bytes) }),
    confirmLabel: t('recordings.actions.delete'),
    danger: true,
  });
  if (ok) await recordings.remove(r.id);
}

/** Ask, then delete every recording but the one being written. */
export async function askDeleteAll(t: ReturnType<typeof useT>): Promise<void> {
  const list = useRecordings.getState().list;
  const closed = list?.recordings.filter(isClosed) ?? [];
  if (!closed.length) return;
  const live = list?.recordings.some((r) => r.state === 'recording');
  const size = formatBytes(closed.reduce((s, r) => s + r.bytes, 0));
  const ok = await confirm({
    title: t('recordings.confirmDeleteAll.title'),
    message: t(live ? 'recordings.confirmDeleteAll.messageLive' : 'recordings.confirmDeleteAll.message', { count: closed.length, size }),
    confirmLabel: t('recordings.actions.deleteAll'),
    danger: true,
  });
  if (ok) await recordings.removeAll();
}

function RecordingRow({ r, shown, opening }: { r: SessionRecording; shown: boolean; opening: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const live = r.state === 'recording';
  return (
    <li className={clsx('rec-row', live && 'rec-row--live', shown && 'rec-row--shown')}>
      <div className="rec-row__main">
        <div className="rec-row__head">
          <span className="rec-row__when tnum">{recordingWhen(r.startedAt, lang)}</span>
          <span className="rec-row__span tnum">{recordingSpan(recordingDuration(r), lang)}</span>
          {live ? (
            <Chip size="sm" tone="success" icon={CircleDot}>
              {t('recordings.state.recording')}
            </Chip>
          ) : null}
          {shown ? (
            <Chip size="sm" tone="accent">
              {t('recordings.state.shown')}
            </Chip>
          ) : null}
          {r.state === 'interrupted' ? (
            <Chip size="sm" tone="warn" title={t('recordings.state.interruptedHint')}>
              {t('recordings.state.interrupted')}
            </Chip>
          ) : null}
          {r.trimmed ? (
            <Chip size="sm" title={t('recordings.state.trimmedHint', { size: formatBytes(r.bytes) })}>
              {t('recordings.state.trimmed')}
            </Chip>
          ) : null}
          {r.gaps ? (
            <Chip size="sm" tone="warn" title={t('recordings.state.gapsHint')}>
              {t('recordings.state.gaps', { count: r.gaps })}
            </Chip>
          ) : null}
        </div>
        <div className="rec-row__who" title={recordingWho(r, lang, 50)}>
          {recordingWho(r, lang)}
        </div>
        <div className="rec-row__counts tnum">
          {recordingCounts(r, lang)}
          <span className="rec-row__size"> · {formatBytes(r.bytes)}</span>
        </div>
      </div>
      {live ? null : (
        <div className="rec-row__actions">
          {shown ? (
            <Button size="sm" variant="secondary" icon={Undo2} onClick={() => (recordings.closeDialog(), recordings.backToLive())}>
              {t('recordings.actions.backToLive')}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" loading={opening} onClick={() => void recordings.open(r.id)} aria-label={`${t('recordings.actions.open')} · ${recordingWhen(r.startedAt, lang)}`}>
              {opening ? t('recordings.actions.opening') : t('recordings.actions.open')}
            </Button>
          )}
          <DropdownMenu
            align="end"
            minWidth={250}
            aria-label={t('recordings.actions.more')}
            items={() => [
              { label: t('recordings.actions.exportMasked'), icon: Download, description: t('recordings.actions.exportMaskedHint'), onSelect: () => exportRecording(r.id, true) },
              { label: t('recordings.actions.exportRaw'), icon: FileLock2, description: t('recordings.actions.exportRawHint'), onSelect: () => exportRecording(r.id, false) },
              { type: 'separator' },
              { label: t('recordings.actions.delete'), icon: Trash2, danger: true, onSelect: () => void askDelete(r, lang, t) },
            ]}
          >
            {(p) => <IconButton icon={Ellipsis} size="sm" label={t('recordings.actions.more')} {...p} />}
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

/** Body of the list: loading, error, empty (on / off) or the recordings. */
function RecordingsBody() {
  const t = useT();
  const { list, loading, error, opening, viewing } = useRecordings();
  if (!list) {
    if (error) {
      return (
        <Callout tone="danger" title={t('recordings.loadFailed')} actions={<Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void recordings.refresh()}>{t('recordings.actions.retry')}</Button>}>
          {error}
        </Callout>
      );
    }
    return (
      <div className="rec-loading" role="status">
        <Spinner size={16} />
        <span>{t('common.loading')}</span>
      </div>
    );
  }
  if (!list.recordings.length) {
    const off = !list.status.enabled;
    return (
      <EmptyState
        icon={FolderClock}
        title={off ? t('recordings.empty.offTitle') : t('recordings.empty.title')}
        description={off ? t('recordings.empty.offBody') : t('recordings.empty.body')}
        actions={
          off ? (
            <Button variant="primary" onClick={() => void updateServerSettings({ recordSessions: true }).then(() => recordings.refresh())}>
              {t('recordings.actions.turnOn')}
            </Button>
          ) : null
        }
      />
    );
  }
  return (
    <>
      {error ? (
        <Callout tone="warn" compact>
          {t('recordings.loadFailed')} · {error}
        </Callout>
      ) : null}
      <ul className={clsx('rec-list', loading && 'rec-list--loading')} aria-label={t('recordings.title')}>
        {list.recordings.map((r) => (
          <RecordingRow key={r.id} r={r} shown={viewing?.recording.id === r.id} opening={opening === r.id} />
        ))}
      </ul>
    </>
  );
}

/** "Oturum kayıtları": every recording on this Mac, newest first (top bar, ⌘K, Settings, the launch offer). */
export function RecordingsDialog() {
  const t = useT();
  const open = useRecordings((s) => s.dialog);
  const list = useRecordings((s) => s.list);
  useRecordingsPoll(open);
  const status = list?.status;
  const closed = list?.recordings.filter(isClosed).length ?? 0;
  const description = status
    ? status.enabled
      ? t('recordings.description', { days: status.maxDays, size: formatBytes(status.maxBytes) })
      : t('recordings.descriptionOff')
    : undefined;
  return (
    <Dialog
      open={open}
      onClose={recordings.closeDialog}
      size="lg"
      icon={FolderClock}
      title={t('recordings.title')}
      description={description}
      bodyClassName="rec-dialog"
      footer={
        <>
          <Button variant="ghost" icon={Trash2} disabled={!closed} onClick={() => void askDeleteAll(t)} className="rec-danger-text">
            {t('recordings.actions.deleteAll')}
          </Button>
          <span className="grow" />
          <Button variant="ghost" icon={Settings2} onClick={() => (recordings.closeDialog(), ui.openSettings('recordings'))}>
            {t('recordings.actions.settings')}
          </Button>
          <Button variant="secondary" onClick={recordings.closeDialog}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {status ? <RecorderStatusLine status={status} /> : null}
      <RecordingsBody />
    </Dialog>
  );
}
