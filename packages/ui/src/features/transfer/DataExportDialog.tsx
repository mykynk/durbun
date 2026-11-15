import './i18n';
import { useMemo, useState } from 'react';
import { FileDown, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, Callout, Checkbox, Dialog, SegmentedControl, downloadUrl, toast } from '../../components';
import { api, scopeDisplayName, useHub, useLogVersion, useNetworkVersion, useScope, type Scope } from '../../data';
import { errorText, useT } from '../../i18n';
import { harFileStamp, scopeExportCounts, scopeHarIds, sessionExportUrl } from './dataExport';
import type { DataExportFormat } from './store';

type ScopeChoice = 'scope' | 'all';

/**
 * "Export session" / "Export HAR": before the file is saved the user sees what goes in (scope, counts, what the
 * recipient opens it with) and whether secrets are masked. Masking is on every time the dialog opens; a raw file is
 * a deliberate choice that says in one sentence what the file then holds.
 */
export interface DataExportProps {
  open: boolean;
  format: DataExportFormat;
  /** Fixed requests (the Network tab's visible rows, one request): HAR only, no scope choice. */
  ids?: string[];
  label?: string;
  fileName?: string;
  onClose(): void;
}

/** Mounted only while open: the body follows the stores (counts), which costs nothing while it is closed. */
export function DataExportDialog(props: DataExportProps) {
  return props.open ? <DataExportBody {...props} /> : null;
}

function DataExportBody({ open, format: initialFormat, ids, label, fileName, onClose }: DataExportProps) {
  const t = useT();
  const current = useScope();
  // A fresh dialog every time: masking on, the focused scope (the file holds what the user is looking at, not
  // every phone's data).
  const [format, setFormat] = useState<DataExportFormat>(ids ? 'har' : initialFormat);
  const [choice, setChoice] = useState<ScopeChoice>('scope');
  const [mask, setMask] = useState(true);
  const [busy, setBusy] = useState(false);

  // Counts stay current while the dialog is open (data keeps arriving).
  const lv = useLogVersion({ throttleMs: 1000 });
  const nv = useNetworkVersion({ throttleMs: 1000 });
  // Names and memberships change rarely; the version hooks re-render often enough to pick them up.
  const devices = useHub((s) => s.devices);
  const scope: Scope = useMemo(() => (choice === 'all' || current.kind === 'all' ? { kind: 'all' } : current), [choice, current]);
  const counts = useMemo(() => (ids ? null : scopeExportCounts(scope, useHub.getState())), [ids, scope, devices, lv, nv]); // eslint-disable-line react-hooks/exhaustive-deps
  const fixed = !!ids;
  const har = format === 'har';
  const requestCount = fixed ? ids!.length : (counts?.requests ?? 0);
  const empty = har ? requestCount === 0 : !!counts && counts.logs === 0 && counts.requests === 0;
  const scopeName = scopeDisplayName(current, useHub.getState());

  const save = async () => {
    if (empty) return;
    if (har) {
      setBusy(true);
      try {
        await api.downloadHar(fixed ? ids : scopeHarIds(scope, useHub.getState()), fileName ?? harFileStamp(), { mask });
        toast.success(t('transfer.data.harReady', { count: requestCount }), { description: mask ? t('transfer.data.doneMasked') : t('transfer.data.doneRaw') });
        onClose();
      } catch (err) {
        toast.error(t('transfer.data.harFailed'), { description: errorText(err) });
      } finally {
        setBusy(false);
      }
      return;
    }
    // The server streams the recording as a download (it can be hundreds of megabytes).
    downloadUrl(sessionExportUrl(scope, mask));
    toast.info(t('transfer.data.sessionStarted'), { description: mask ? t('transfer.data.doneMasked') : t('transfer.data.doneRaw') });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={FileDown}
      title={har ? t('transfer.data.titleHar') : t('transfer.data.titleSession')}
      description={har ? t('transfer.data.descHar') : t('transfer.data.descSession')}
      size="md"
      footer={
        <>
          {empty ? <span className="tx-footnote">{har ? t('transfer.data.emptyHar') : t('transfer.data.emptySession')}</span> : null}
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={mask ? 'primary' : 'danger'} icon={FileDown} loading={busy} disabled={empty} onClick={() => void save()}>
            {mask ? t('transfer.data.save') : t('transfer.data.saveRaw')}
          </Button>
        </>
      }
    >
      <div className="tx-export">
        {fixed ? null : (
          <SegmentedControl
            value={format}
            onChange={setFormat}
            aria-label={t('transfer.data.format')}
            options={[
              { value: 'session', label: t('transfer.data.formatSession') },
              { value: 'har', label: t('transfer.data.formatHar') },
            ]}
          />
        )}

        <section className="tx-section">
          <h3 className="tx-section__title">{t('transfer.export.what')}</h3>
          {fixed ? (
            <p className="tx-hint tx-data__fixed">{label}</p>
          ) : current.kind === 'all' ? null : (
            <SegmentedControl
              value={choice}
              onChange={setChoice}
              aria-label={t('transfer.data.scope')}
              options={[
                { value: 'scope', label: <span className="truncate">{scopeName}</span> },
                { value: 'all', label: t('shell.scope.all') },
              ]}
            />
          )}
          <p className="tx-data__counts tnum">
            {har
              ? t('transfer.data.countHar', { count: requestCount })
              : counts
                ? [
                    t('transfer.data.countLogs', { count: counts.logs }),
                    t('transfer.data.countRequests', { count: counts.requests }),
                    ...(scope.kind === 'all' ? [t('transfer.data.countDevices', { count: counts.devices })] : []),
                  ].join(' · ')
                : null}
          </p>
          <p className="tx-hint">{har ? t('transfer.data.openHar') : t('transfer.data.openSession')}</p>
        </section>

        <section className="tx-section">
          <Checkbox checked={mask} onChange={setMask} label={t('transfer.data.mask')} />
          {mask ? (
            <p className="tx-hint tx-data__maskhint">
              <ShieldCheck size={13} aria-hidden /> {t('transfer.data.maskOn')}
            </p>
          ) : (
            <Callout compact tone="warn" icon={ShieldAlert}>
              {har ? t('transfer.data.maskOffHar') : t('transfer.data.maskOffSession')}
            </Callout>
          )}
        </section>
      </div>
    </Dialog>
  );
}
