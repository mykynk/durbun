/**
 * The Logs timeline's "a screenshot / recording was taken here" marker (`media.screenshot` / `media.recording`
 * lines): its icon and an "Open" button that shows the item over the current tab (`MediaViewerHost`).
 * Light on purpose: no Device tab code comes with it.
 */
import type { LogEntry } from '@durbun/protocol';
import { Camera, Video } from 'lucide-react';
import { useT } from '../../../i18n';
import { mediaRefOf, openMediaRef } from './store';
import './marker.css';

export { mediaRefOf };
export { MediaViewerHost } from './ViewerHost';

/** Camera / video icon of a media marker, or null for any other marker. */
export function MediaMarkerIcon({ entry }: { entry: Pick<LogEntry, 'code' | 'data'> }) {
  const ref = mediaRefOf(entry);
  if (!ref) return null;
  const Icon = ref.kind === 'recording' ? Video : Camera;
  return <Icon size={12} aria-hidden />;
}

/** "Open" on a media marker; nothing on other markers. */
export function MediaMarkerOpen({ entry }: { entry: Pick<LogEntry, 'code' | 'data' | 'ts' | 'deviceId'> }) {
  const t = useT();
  const ref = mediaRefOf(entry);
  if (!ref) return null;
  return (
    <button
      type="button"
      className="md-marker-open"
      onClick={(ev) => {
        ev.stopPropagation();
        void openMediaRef(ref, { ts: entry.ts, deviceId: entry.deviceId });
      }}
      onMouseDown={(ev) => ev.stopPropagation()}
    >
      {t(ref.kind === 'recording' ? 'media.markerOpenRecording' : 'media.markerOpenShot')}
    </button>
  );
}
