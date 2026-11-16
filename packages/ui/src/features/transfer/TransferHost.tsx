import './i18n';
import './transfer.css';
import { DialogBoundary } from '../../components/ErrorBoundary';
import { ExportDialog } from './ExportDialog';
import { DataExportDialog } from './DataExportDialog';
import { ImportDialog } from './ImportDialog';
import { useUiPrefsSync } from './prefsSync';
import { transfer, useTransfer } from './store';

/**
 * The package dialogs (opened from the top bar, the settings, a drop) and the UI preferences sync. A dialog that
 * crashes closes (with a toast to copy the details) instead of blanking the window; opening one again retries.
 */
export function TransferHost() {
  useUiPrefsSync();
  const dialog = useTransfer((s) => s.dialog);
  return (
    <DialogBoundary name="packages" resetKey={dialog}>
      <ExportDialog
        open={dialog?.kind === 'export'}
        mode={dialog?.kind === 'export' ? dialog.mode : 'share'}
        flows={dialog?.kind === 'export' ? dialog.flows : undefined}
        runs={dialog?.kind === 'export' ? dialog.runs : undefined}
        name={dialog?.kind === 'export' ? dialog.name : undefined}
        onClose={transfer.close}
      />
      <DataExportDialog
        open={dialog?.kind === 'data'}
        format={dialog?.kind === 'data' ? dialog.format : 'session'}
        ids={dialog?.kind === 'data' ? dialog.ids : undefined}
        label={dialog?.kind === 'data' ? dialog.label : undefined}
        fileName={dialog?.kind === 'data' ? dialog.fileName : undefined}
        onClose={transfer.close}
      />
      <ImportDialog open={dialog?.kind === 'import'} text={dialog?.kind === 'import' ? dialog.text : null} fileName={dialog?.kind === 'import' ? dialog.fileName : undefined} onClose={transfer.close} />
    </DialogBoundary>
  );
}
