/** Gallery pieces shared by the Device tab's cards and the library dialog. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClipboardCopy, Download, FileX, Maximize2, Play, ScrollText, Trash } from 'lucide-react';
import type { MediaKind } from '@durbun/protocol';
import { Button, Callout, Spinner, downloadUrl, formatBytes, formatClock, openContextMenu, toast, type MenuItem } from '../../../components';
import { logStore, ui } from '../../../data';
import { errorText, t, useT } from '../../../i18n';
import { clock, copyImage, itemTitle, mediaTime } from './format';
import { deleteMedia, ensureMedia, loadMedia, mediaDownloadUrl, openMedia, useMediaLibrary, visibleItems, type GalleryItem } from './store';
import './media.css';

/** A device's items of one kind (newest first) and the library's load state. */
export function useDeviceMedia(deviceId: string | undefined, kind?: MediaKind) {
  const lib = useMediaLibrary();
  useEffect(() => ensureMedia(), []);
  const items = useMemo(() => visibleItems(lib).filter((i) => (!deviceId || i.deviceId === deviceId) && (!kind || i.kind === kind)), [lib, deviceId, kind]);
  return { items, status: lib.status, error: lib.error, policy: lib.policy, usedBytes: lib.usedBytes, total: lib.total };
}

export function itemMenu(i: GalleryItem): MenuItem[] {
  const download = () => downloadUrl(mediaDownloadUrl(i), i.fileName);
  const logId = i.logId !== undefined && logStore.getById(i.logId) ? i.logId : undefined;
  return [
    { label: t('media.open'), icon: Maximize2, onSelect: () => openMedia(i.id) },
    ...(i.kind === 'screenshot'
      ? [
          {
            label: t('media.copy'),
            icon: ClipboardCopy,
            onSelect: () =>
              void copyImage(i.url).then((r) => {
                if (r === 'ok') toast.success(t('device.shot.copied'));
                else toast.error(t('device.shot.copyFailed'), { action: { label: t('media.download'), onClick: download } });
              }),
          },
        ]
      : []),
    { label: t('media.download'), icon: Download, onSelect: download },
    ...(logId !== undefined ? [{ label: t('media.showInLogs'), icon: ScrollText, onSelect: () => ui.focusLog(logId) }] : []),
    { type: 'separator' } as MenuItem,
    { label: t('media.delete'), icon: Trash, danger: true, onSelect: () => deleteMedia([i.id]) },
  ];
}

/** Sets `true` once the element came near the viewport (video thumbnails load their first frame only then). */
function useNearView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** One tile: the image (or the recording's first frame + its length), its time and size; click opens the viewer. */
export function MediaThumb({ item, showDevice, now, timeOnly }: { item: GalleryItem; showDevice?: boolean; now?: number; timeOnly?: boolean }) {
  const t = useT();
  const [gone, setGone] = useState(false);
  const [ref, near] = useNearView<HTMLButtonElement>();
  const title = itemTitle(item, now);
  const ratio = item.width && item.height ? `${item.width} / ${item.height}` : undefined;
  return (
    <li className="md-thumbs__item">
      <button
        ref={ref}
        type="button"
        className={gone ? 'md-thumb is-gone' : 'md-thumb'}
        onClick={() => openMedia(item.id)}
        onContextMenu={(e) => openContextMenu(e, itemMenu(item))}
        aria-label={item.kind === 'recording' ? t('media.playRecording', { duration: clock(item.durationSec) }) + ` · ${title}` : t('media.openItem', { title })}
        style={ratio ? { aspectRatio: ratio } : undefined}
      >
        {gone ? (
          <span className="md-thumb__gone">
            <FileX size={18} aria-hidden />
            <span>{t('media.fileGone')}</span>
          </span>
        ) : item.kind === 'screenshot' ? (
          <img src={item.url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setGone(true)} />
        ) : (
          <>
            {near ? <video src={`${item.url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden onError={() => setGone(true)} /> : null}
            <span className="md-thumb__play" aria-hidden>
              <Play size={14} />
            </span>
            {item.durationSec ? <span className="md-thumb__badge tnum">{clock(item.durationSec)}</span> : null}
          </>
        )}
      </button>
      <div className={showDevice ? 'md-thumbs__meta md-thumbs__meta--stack' : 'md-thumbs__meta'}>
        <span className="tnum truncate">{timeOnly ? formatClock(item.ts, { ms: false, seconds: false }) : mediaTime(item.ts, now)}</span>
        {showDevice ? (
          <span className="subtle truncate" title={item.deviceName}>
            {item.deviceName ?? item.deviceId}
          </span>
        ) : item.bytes ? (
          <span className="subtle tnum">{formatBytes(item.bytes)}</span>
        ) : null}
      </div>
    </li>
  );
}

export function MediaGrid({ items, label, showDevice, wide, timeOnly }: { items: readonly GalleryItem[]; label: string; showDevice?: boolean; wide?: boolean; timeOnly?: boolean }) {
  const now = Date.now();
  return (
    <ul className={wide ? 'md-thumbs md-thumbs--wide' : 'md-thumbs'} aria-label={label}>
      {items.map((i) => (
        <MediaThumb key={i.id} item={i} showDevice={showDevice} now={now} timeOnly={timeOnly} />
      ))}
    </ul>
  );
}

/** First load / failed load of the list (a list already on screen stays and shows neither). */
export function GalleryStatus({ status, error, hasItems, children }: { status: string; error?: unknown; hasItems: boolean; children: ReactNode }) {
  const t = useT();
  if (hasItems) return <>{children}</>;
  if (status === 'loading' || status === 'idle')
    return (
      <p className="dv-muted md-loading">
        <Spinner size={14} /> {t('media.loading')}
      </p>
    );
  if (status === 'error')
    return (
      <Callout
        tone="danger"
        compact
        title={t('media.loadFailed')}
        actions={
          <Button size="sm" onClick={() => void loadMedia()}>
            {t('media.retry')}
          </Button>
        }
      >
        {errorText(error)}
      </Callout>
    );
  return <>{children}</>;
}

/** "Kept for 30 days, up to 2 GB…" (only when the server says so). */
export function PolicyNote({ policy }: { policy?: { maxAgeDays: number; maxBytes: number } }) {
  const t = useT();
  if (!policy) return null;
  return <p className="md-policy">{t('media.policy', { days: policy.maxAgeDays, size: formatBytes(policy.maxBytes) })}</p>;
}
