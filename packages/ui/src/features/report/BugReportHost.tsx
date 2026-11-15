import './i18n';
import { Suspense, lazy } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { bugReport, useBugReport } from './store';

// The dialog pulls in the log and request report code: loaded the first time a report opens.
const BugReportDialog = lazy(() => import('./BugReportDialog').then((m) => ({ default: m.BugReportDialog })));

/** "Report a bug" (mounted once in App): every entry point opens it through `bugReport.open(anchor)`. */
export function BugReportHost() {
  const open = useBugReport((s) => s.open);
  return (
    <ErrorBoundary name="bug report" resetKey={open?.seq} fallback={() => null}>
      {open ? (
        <Suspense fallback={null}>
          <BugReportDialog key={open.seq} anchor={open} onClose={bugReport.close} />
        </Suspense>
      ) : null}
    </ErrorBoundary>
  );
}
