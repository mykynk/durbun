import { Camera, Images } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, toast } from '../../components';
import { sendCommand } from '../../data';
import { t, useT } from '../../i18n';
import { codeText, describeError } from './codes';
import { GalleryStatus, MediaGrid, PolicyNote, useDeviceMedia } from './media/Gallery';
import { openLibrary } from './media/LibraryDialog';
import { copyImage } from './media/format';
import { addFromReply, openMedia } from './media/store';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

export { copyImage };

/** Screenshots shown on the card; the rest are one click away in the library. */
export const CARD_SHOTS = 8;

/** Put a `screenshot` reply in the gallery and confirm with a toast (shared by the card and the palette). */
export function handleScreenshotResult(deviceId: string, data: unknown): void {
  const item = addFromReply(deviceId, 'screenshot', data);
  if (!item) {
    toast.error(t('device.shot.failed'), { description: codeText('action.invalidResult') });
    return;
  }
  toast.success(t('device.shot.done'), {
    description: item.width && item.height ? t('device.shot.dims', { width: item.width, height: item.height }) : undefined,
    action: { label: t('device.shot.show'), onClick: () => openMedia(item.id) },
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
  const media = useDeviceMedia(device.id, 'screenshot');
  const shots = media.items;

  const take = async () => {
    const r = await run({ action: 'screenshot', failure: t('device.shot.failed') });
    if (r.ok) handleScreenshotResult(device.id, r.data);
  };

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
      <GalleryStatus status={media.status} error={media.error} hasItems={shots.length > 0}>
        {shots.length === 0 ? (
          <p className="dv-muted">{t('media.shotsEmpty', { days: media.policy?.maxAgeDays ?? 30 })}</p>
        ) : (
          <>
            <MediaGrid items={shots.slice(0, CARD_SHOTS)} label={t('device.shot.gallery')} />
            <div className="md-foot">
              <PolicyNote policy={media.policy} />
              <Button size="sm" variant="ghost" icon={Images} onClick={() => openLibrary({ deviceId: device.id, kind: 'screenshot' })}>
                {shots.length > CARD_SHOTS ? t('media.showAll', { count: shots.length }) : t('media.libraryButton')}
              </Button>
            </div>
          </>
        )}
      </GalleryStatus>
    </DeviceCard>
  );
}
