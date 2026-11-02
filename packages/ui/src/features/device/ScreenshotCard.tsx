import { useMemo } from 'react';
import { Camera, ChevronLeft, ChevronRight, ClipboardCopy, Download, Maximize2, Trash } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, Dialog, IconButton, downloadUrl, formatClock, openContextMenu, toast, useShortcut, type MenuItem } from '../../components';
import { sendCommand } from '../../data';
import { t, useT } from '../../i18n';
import { codeText, describeError } from './codes';
import { mediaFileName, mediaResult } from './model';
import { addShot, openShot, removeShot, useMedia, type Shot } from './stores';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

async function pngBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${res.status}`);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  // Clipboard images must be PNG: re-encode other formats through a canvas.
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'));
}

/** Copy an image URL to the clipboard as PNG (the promise keeps the click's user activation). */
export async function copyImage(url: string): Promise<'ok' | 'denied' | 'unsupported' | 'failed'> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return 'unsupported';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(url) })]);
    return 'ok';
  } catch (err) {
    return (err as { name?: string })?.name === 'NotAllowedError' ? 'denied' : 'failed';
  }
}

/** Store a `screenshot` reply in the gallery and confirm with a toast (shared by the card and the palette). */
export function handleScreenshotResult(deviceId: string, data: unknown): void {
  const m = mediaResult(data);
  if (!m) {
    toast.error(t('device.shot.failed'), { description: codeText('action.invalidResult') });
    return;
  }
  const shot = addShot({ deviceId, ...m, ts: Date.now() });
  toast.success(t('device.shot.done'), {
    description: m.width && m.height ? t('device.shot.dims', { width: m.width, height: m.height }) : undefined,
    action: { label: t('device.shot.show'), onClick: () => openShot(shot.id) },
  });
}

/** Palette entry point: take a screenshot without the card's pending state. */
export async function captureScreenshot(deviceId: string): Promise<void> {
  try {
    const data = await sendCommand({ name: 'device.action', deviceId, action: 'screenshot', params: {} });
    handleScreenshotResult(deviceId, data);
  } catch (err) {
    toast.error(t('device.shot.failed'), { description: describeError(err).text });
  }
}

export function ScreenshotCard({ device, canTake }: { device: DeviceInfo; canTake: boolean }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const allShots = useMedia((s) => s.shots);
  const shots = useMemo(() => allShots.filter((s) => s.deviceId === device.id), [allShots, device.id]);
  const openId = useMedia((s) => s.openShotId);
  const setOpenId = openShot;
  const openIndex = openId ? shots.findIndex((s) => s.id === openId) : -1;
  const current = openIndex >= 0 ? shots[openIndex] : undefined;

  const take = async () => {
    const r = await run({ action: 'screenshot', failure: t('device.shot.failed') });
    if (r.ok) handleScreenshotResult(device.id, r.data);
  };

  const download = (s: Shot) => downloadUrl(s.url, mediaFileName('screenshot', device, s.ts, s.file));
  const copy = async (s: Shot) => {
    const r = await copyImage(s.url);
    if (r === 'ok') toast.success(t('device.shot.copied'));
    else
      toast.error(t('device.shot.copyFailed'), {
        description: r === 'denied' ? t('device.shot.copyDenied') : r === 'unsupported' ? t('device.shot.copyUnsupported') : undefined,
        action: { label: t('device.shot.download'), onClick: () => download(s) },
      });
  };
  const remove = (s: Shot) => {
    if (s.id === openId) {
      const next = shots[openIndex + 1] ?? shots[openIndex - 1];
      setOpenId(next && next.id !== s.id ? next.id : null);
    }
    removeShot(s.id);
  };
  const menu = (s: Shot): MenuItem[] => [
    { label: t('device.shot.open'), icon: Maximize2, onSelect: () => setOpenId(s.id) },
    { label: t('device.shot.copy'), icon: ClipboardCopy, onSelect: () => void copy(s) },
    { label: t('device.shot.download'), icon: Download, onSelect: () => download(s) },
    { type: 'separator' },
    { label: t('device.shot.remove'), icon: Trash, hint: undefined, onSelect: () => remove(s) },
  ];

  const step = (dir: 1 | -1) => {
    if (openIndex < 0) return;
    const next = shots[openIndex + dir];
    if (next) setOpenId(next.id);
  };
  // Newest first in the gallery, so "previous" (left) is the newer image.
  useShortcut('ArrowLeft', () => step(-1), { enabled: Boolean(current), allowInModal: true });
  useShortcut('ArrowRight', () => step(1), { enabled: Boolean(current), allowInModal: true });

  return (
    <DeviceCard
      section="screenshot"
      title={t('device.shot.title')}
      icon={Camera}
      description={shots.length > 0 ? t('device.shot.count', { count: shots.length }) : undefined}
      actions={
        canTake ? (
          <Button variant="primary" size="sm" icon={Camera} loading={isPending('screenshot')} onClick={() => void take()}>
            {t('device.shot.take')}
          </Button>
        ) : undefined
      }
    >
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {shots.length === 0 ? (
        <p className="dv-muted">{t('device.shot.empty')}</p>
      ) : (
        <ul className="dv-shots" aria-label={t('device.shot.gallery')}>
          {shots.map((s) => {
            const time = formatClock(s.ts, { ms: false });
            return (
              <li key={s.id} className="dv-shots__item">
                <button
                  type="button"
                  className="dv-shot"
                  onClick={() => setOpenId(s.id)}
                  onContextMenu={(e) => openContextMenu(e, menu(s))}
                  aria-label={`${t('device.shot.open')} · ${time}`}
                  style={s.width && s.height ? { aspectRatio: `${s.width} / ${s.height}` } : undefined}
                >
                  <img src={s.url} alt={t('device.shot.lightbox', { time })} loading="lazy" decoding="async" draggable={false} />
                </button>
                <div className="dv-shots__meta">
                  <span className="tnum">{time}</span>
                  {s.width && s.height ? <span className="mono subtle">{`${s.width}×${s.height}`}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={Boolean(current)}
        onClose={() => setOpenId(null)}
        size="xl"
        icon={Camera}
        title={current ? t('device.shot.lightbox', { time: formatClock(current.ts, { ms: false }) }) : undefined}
        description={
          current
            ? [device.name, current.width && current.height ? t('device.shot.dims', { width: current.width, height: current.height }) : null, t('device.shot.position', { index: openIndex + 1, total: shots.length })]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        autoFocusField={false}
        footer={
          current ? (
            <>
              <Button variant="ghost" icon={Trash} onClick={() => remove(current)} title={t('device.shot.removeHint')}>
                {t('device.shot.remove')}
              </Button>
              <span className="grow" />
              <Button icon={ClipboardCopy} onClick={() => void copy(current)}>
                {t('device.shot.copy')}
              </Button>
              <Button variant="primary" icon={Download} onClick={() => download(current)}>
                {t('device.shot.download')}
              </Button>
            </>
          ) : undefined
        }
      >
        {current ? (
          <div className="dv-lightbox">
            <IconButton icon={ChevronLeft} label={t('device.shot.prev')} shortcut="ArrowLeft" onClick={() => step(-1)} disabled={openIndex <= 0} className="dv-lightbox__nav" />
            <div className="dv-lightbox__frame">
              <img src={current.url} alt={t('device.shot.lightbox', { time: formatClock(current.ts, { ms: false }) })} />
            </div>
            <IconButton
              icon={ChevronRight}
              label={t('device.shot.next')}
              shortcut="ArrowRight"
              onClick={() => step(1)}
              disabled={openIndex >= shots.length - 1}
              className="dv-lightbox__nav"
            />
          </div>
        ) : null}
      </Dialog>
    </DeviceCard>
  );
}
