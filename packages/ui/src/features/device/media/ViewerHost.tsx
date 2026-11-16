import { lazy, Suspense } from 'react';
import { useFeatureActive } from '../../../components';
import { useMediaViewer } from './store';

const MediaViewer = lazy(() => import('./MediaViewer'));

/**
 * Mount point of the media viewer. Each tab that opens media (Device, Logs) renders one; only the active tab's
 * host shows the dialog, and the viewer's code loads the first time something opens.
 */
export function MediaViewerHost() {
  const active = useFeatureActive();
  const open = useMediaViewer((s) => s.open !== null);
  if (!active || !open) return null;
  return (
    <Suspense fallback={null}>
      <MediaViewer />
    </Suspense>
  );
}
