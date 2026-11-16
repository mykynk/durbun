import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, CircleAlert, Trash, Trash2 } from 'lucide-react';
import type { FlowTrashItem } from '@durbun/protocol';
import { Button, Dialog, EmptyState, IconButton, Spinner, confirm, formatDateTime, formatRelative, toast } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { flowErrorText } from '../model/errors';
import { listTrash, purgeTrashed, restoreTrashed } from '../model/setsApi';

export interface TrashDialogProps {
  open: boolean;
  onClose(): void;
  /** A flow came back (its id: the old one, or a free one when that was taken meanwhile). */
  onRestored(flowId: string, name: string): void;
  /** How many flows are in the trash (the list's "Deleted flows" link). */
  onCount?(count: number): void;
}

/** "Deleted flows": what was deleted in the last days, with its version history; restore or remove for good. */
export function TrashDialog({ open, onClose, onRestored, onCount }: TrashDialogProps) {
  const t = useT();
  const lang = useLanguage();
  const [items, setItems] = useState<FlowTrashItem[] | null>(null);
  const [keepDays, setKeepDays] = useState(30);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await listTrash();
      setItems(r.items);
      setKeepDays(r.keepDays);
      onCount?.(r.items.length);
    } catch (err) {
      setError(err);
    }
  }, [onCount]);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    void load();
  }, [open, load]);

  const restore = async (item: FlowTrashItem) => {
    setBusy(item.trashId);
    try {
      const r = await restoreTrashed(item.trashId);
      const rest = (items ?? []).filter((x) => x.trashId !== item.trashId);
      setItems(rest);
      onCount?.(rest.length);
      toast.success(t('flows.trash.restored', { name: r.flow.name }), r.flow.id !== item.id ? { description: t('flows.trash.restoredAs', { id: r.flow.id }) } : undefined);
      onRestored(r.flow.id, r.flow.name);
    } catch (err) {
      toast.error(t('flows.trash.restoreFailed'), { description: flowErrorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const purge = async (item: FlowTrashItem) => {
    const ok = await confirm({ title: t('flows.trash.purgeTitle', { name: item.name }), message: t('flows.trash.purgeMessage'), confirmLabel: t('flows.trash.purge'), danger: true });
    if (!ok) return;
    setBusy(item.trashId);
    try {
      await purgeTrashed(item.trashId);
      const rest = (items ?? []).filter((x) => x.trashId !== item.trashId);
      setItems(rest);
      onCount?.(rest.length);
    } catch (err) {
      toast.error(t('flows.trash.purgeFailed'), { description: flowErrorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      icon={Trash2}
      title={t('flows.trash.title')}
      description={t('flows.trash.description', { days: keepDays })}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {error ? (
        <EmptyState
          size="sm"
          tone="danger"
          icon={CircleAlert}
          title={t('flows.trash.loadFailed')}
          description={flowErrorText(error)}
          actions={
            <Button variant="secondary" onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !items ? (
        <div className="fl-trash__loading">
          <Spinner size={16} />
        </div>
      ) : !items.length ? (
        <EmptyState size="sm" icon={Trash2} title={t('flows.trash.emptyTitle')} description={t('flows.trash.emptyHint', { days: keepDays })} />
      ) : (
        <ul className="fl-trash">
          {items.map((item) => (
            <li key={item.trashId} className="fl-trash__row">
              <div className="fl-trash__text">
                <span className="fl-trash__name truncate">{item.name}</span>
                <span className="fl-trash__meta tnum">
                  {[
                    t('flows.list.steps', { count: item.nodeCount }),
                    item.versions ? t('flows.trash.versions', { count: item.versions }) : '',
                    t('flows.trash.deletedAgo', { when: formatRelative(item.deletedAt) }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="fl-trash__expires">{t('flows.trash.expires', { date: formatDateTime(item.expiresAt, { lang }) })}</span>
              </div>
              <Button size="sm" variant="secondary" icon={ArchiveRestore} loading={busy === item.trashId} disabled={!!busy && busy !== item.trashId} onClick={() => void restore(item)}>
                {t('flows.trash.restore')}
              </Button>
              <IconButton icon={Trash} tone="danger" label={t('flows.trash.purgeOne', { name: item.name })} disabled={!!busy} onClick={() => void purge(item)} />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
