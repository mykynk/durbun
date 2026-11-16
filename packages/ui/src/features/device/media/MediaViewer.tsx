/**
 * One screenshot or recording at full size (lazy chunk, mounted by `MediaViewerHost` in the active tab): newer /
 * older of the same device, download, copy, delete with undo, "Show in Logs". States: loading the list, the item
 * is gone (a marker of a deleted item), the file is gone from the disk, the image is still loading.
 */
import { useEffect, useMemo, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, ClipboardCopy, Download, FileX, ImageOff, ScrollText, Trash, Video } from 'lucide-react';
import { Button, Dialog, EmptyState, IconButton, Spinner, downloadUrl, formatBytes, toast, useShortcut } from '../../../components';
import { logStore, ui, useDevice } from '../../../data';
import { useT } from '../../../i18n';
import { clock, copyImage, itemTitle } from './format';
import { closeMedia, deleteMedia, ensureMedia, mediaDownloadUrl, openMedia, useMediaLibrary, useMediaViewer, visibleItems, type GalleryItem } from './store';
import './media.css';

export default function MediaViewer() {
  const t = useT();
  const open = useMediaViewer((s) => s.open);
  const lib = useMediaLibrary();
  const items = useMemo(() => visibleItems(lib), [lib]);
  const current = open && !open.missing ? items.find((i) => i.id === open.id) : undefined;
  const list = useMemo(() => (current ? items.filter((i) => i.deviceId === current.deviceId) : []), [items, current]);
  const index = current ? list.indexOf(current) : -1;
  const device = useDevice(current?.deviceId ?? open?.missing?.deviceId);
  const [failed, setFailed] = useState<{ id: string; why: 'gone' | 'unplayable' } | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => ensureMedia(), []);

  const step = (dir: 1 | -1) => {
    const next = index >= 0 ? list[index + dir] : undefined;
    if (next) openMedia(next.id);
  };
  // Newest first: left is the newer one.
  useShortcut('ArrowLeft', () => step(-1), { enabled: index > 0, allowInModal: true });
  useShortcut('ArrowRight', () => step(1), { enabled: index >= 0 && index < list.length - 1, allowInModal: true });

  if (!open) return null;
  const loading = !current && !open.missing && (lib.status === 'loading' || lib.status === 'idle');
  // Opened by id but not in the (loaded) list: the same as a marker whose item is gone.
  const missingKind = open.missing?.kind ?? (!current && !loading ? 'screenshot' : undefined);

  const download = (i: GalleryItem) => downloadUrl(mediaDownloadUrl(i), i.fileName);
  const copy = async (i: GalleryItem) => {
    const r = await copyImage(i.url);
    if (r === 'ok') toast.success(t('device.shot.copied'));
    else
      toast.error(t('device.shot.copyFailed'), {
        description: r === 'denied' ? t('device.shot.copyDenied') : r === 'unsupported' ? t('device.shot.copyUnsupported') : undefined,
        action: { label: t('media.download'), onClick: () => download(i) },
      });
  };
  const logLine = current?.logId !== undefined && logStore.getById(current.logId) ? current.logId : undefined;
  const failure = current && failed?.id === current.id ? failed.why : undefined;
  const fileGone = failure === 'gone';
  /** The image / video would not show: a missing file (404) or one this browser cannot play (e.g. HEVC). */
  const onMediaError = (i: GalleryItem) => {
    void fetch(i.url, { method: 'HEAD', credentials: 'same-origin' })
      .then((r) => setFailed({ id: i.id, why: r.status === 404 ? 'gone' : 'unplayable' }))
      .catch(() => setFailed({ id: i.id, why: 'unplayable' }));
  };

  const description = current
    ? [
        current.deviceName ?? device?.name,
        current.kind === 'recording' && current.durationSec ? t('media.duration', { duration: clock(current.durationSec) }) : null,
        current.width && current.height ? t('device.shot.dims', { width: current.width, height: current.height }) : null,
        current.bytes ? formatBytes(current.bytes) : null,
        list.length > 1 ? t('media.position', { index: index + 1, total: list.length }) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <Dialog
      open
      onClose={closeMedia}
      size="xl"
      icon={(current?.kind ?? missingKind) === 'recording' ? Video : Camera}
      title={current ? itemTitle(current) : missingKind ? t(missingKind === 'recording' ? 'media.missingRecording' : 'media.missingShot') : t('media.library')}
      description={description}
      autoFocusField={false}
      footer={
        current ? (
          <>
            <Button variant="ghost" icon={Trash} onClick={() => deleteMedia([current.id])} title={t('media.deleteHint')}>
              {t('media.delete')}
            </Button>
            {logLine !== undefined ? (
              <Button
                variant="ghost"
                icon={ScrollText}
                title={t('media.showInLogsHint')}
                onClick={() => {
                  closeMedia();
                  ui.focusLog(logLine);
                }}
              >
                {t('media.showInLogs')}
              </Button>
            ) : null}
            <span className="grow" />
            {current.kind === 'screenshot' && !fileGone ? (
              <Button icon={ClipboardCopy} onClick={() => void copy(current)}>
                {t('media.copy')}
              </Button>
            ) : null}
            <Button variant="primary" icon={Download} onClick={() => download(current)} disabled={Boolean(fileGone)}>
              {t('media.download')}
            </Button>
          </>
        ) : (
          <Button onClick={closeMedia}>{t('common.close')}</Button>
        )
      }
    >
      {loading ? (
        <div className="md-viewer__state">
          <Spinner size={20} label={t('media.loading')} />
        </div>
      ) : !current ? (
        <EmptyState
          icon={ImageOff}
          title={t(missingKind === 'recording' ? 'media.missingRecording' : 'media.missingShot')}
          description={
            <>
              {t('media.missingBody', { days: lib.policy?.maxAgeDays ?? 30 })}
              {open.missing?.deviceId?.startsWith('import:') ? <> {t('media.missingImported')}</> : null}
            </>
          }
        />
      ) : (
        <div className="md-viewer">
          <IconButton icon={ChevronLeft} label={t('media.newer')} shortcut="ArrowLeft" onClick={() => step(-1)} disabled={index <= 0} className="md-viewer__nav" />
          <div className="md-viewer__frame">
            {failure === 'unplayable' ? (
              <EmptyState
                icon={FileX}
                title={t(current.kind === 'recording' ? 'media.unplayableRecording' : 'media.unplayableShot')}
                description={t('media.unplayableBody')}
                actions={
                  <Button size="sm" icon={Download} onClick={() => download(current)}>
                    {t('media.download')}
                  </Button>
                }
              />
            ) : fileGone ? (
              <EmptyState
                icon={FileX}
                title={t('media.fileMissingTitle')}
                description={t('media.fileMissingBody')}
                actions={
                  <Button size="sm" icon={Trash} onClick={() => deleteMedia([current.id])}>
                    {t('media.removeFromList')}
                  </Button>
                }
              />
            ) : current.kind === 'screenshot' ? (
              <>
                {loaded !== current.id ? <Spinner size={20} className="md-viewer__spinner" label={t('media.loading')} /> : null}
                <img
                  key={current.id}
                  src={current.url}
                  alt={itemTitle(current)}
                  onLoad={() => setLoaded(current.id)}
                  onError={() => onMediaError(current)}
                  className={loaded === current.id ? undefined : 'is-loading'}
                />
              </>
            ) : (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video key={current.id} src={current.url} controls preload="metadata" onError={() => onMediaError(current)} />
            )}
          </div>
          <IconButton
            icon={ChevronRight}
            label={t('media.older')}
            shortcut="ArrowRight"
            onClick={() => step(1)}
            disabled={index < 0 || index >= list.length - 1}
            className="md-viewer__nav"
          />
        </div>
      )}
      {current?.local ? <p className="md-viewer__note">{t('media.localNote')}</p> : null}
    </Dialog>
  );
}
