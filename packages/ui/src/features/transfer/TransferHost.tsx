import './i18n';
import './transfer.css';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { ExportDialog } from './ExportDialog';
import { ImportDialog } from './ImportDialog';
import { useUiPrefsSync } from './prefsSync';
import { transfer, useTransfer } from './store';

/**
 * The package dialogs (opened from the top bar, the settings, a drop) and the UI preferences sync. A dialog that
 * crashes closes instead of blanking the window; opening one again retries.
 */
export function TransferHost() {
  useUiPrefsSync();
  const dialog = useTransfer((s) => s.dialog);
  return (
    <ErrorBoundary name="packages" resetKey={dialog} fallback={() => null}>
      <ExportDialog open={dialog?.kind === 'export'} mode={dialog?.kind === 'export' ? dialog.mode : 'share'} flows={dialog?.kind === 'export' ? dialog.flows : undefined} onClose={transfer.close} />
      <ImportDialog open={dialog?.kind === 'import'} text={dialog?.kind === 'import' ? dialog.text : null} fileName={dialog?.kind === 'import' ? dialog.fileName : undefined} onClose={transfer.close} />
    </ErrorBoundary>
  );
}
