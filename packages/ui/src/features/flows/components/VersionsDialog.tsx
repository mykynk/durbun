import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { CircleAlert, History, RotateCcw } from 'lucide-react';
import type { FlowHistory, FlowVersionInfo } from '@durbun/protocol';
import { Button, Dialog, EmptyState, Spinner, formatDateTime, formatRelative, toast } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { flowErrorText } from '../model/errors';
import { flowHistory, restoreVersion } from '../model/setsApi';
import { changesText, replacedByKey } from '../model/versions';

export interface VersionsDialogProps {
  open: boolean;
  flowId: string | null;
  flowName: string;
  onClose(): void;
  /** Saves pending edits first (they become a version too); returns the flow's id after the save. */
  beforeRestore(): Promise<string | null>;
  /** The flow changed on the server: the editor reads it again. */
  onRestored(): void;
}

/** Earlier saved versions of a flow: when, what changed, and "Restore" (itself undone from the toast). */
export function VersionsDialog({ open, flowId, flowName, onClose, beforeRestore, onRestored }: VersionsDialogProps) {
  const t = useT();
  const lang = useLanguage();
  const [history, setHistory] = useState<FlowHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (id: string) => {
      setError(null);
      try {
        setHistory(await flowHistory(id));
      } catch (err) {
        setError(err);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || !flowId) return;
    setHistory(null);
    void load(flowId);
  }, [open, flowId, load]);

  const restore = async (v: FlowVersionInfo) => {
    if (!flowId) return;
    setBusy(v.id);
    try {
      const id = (await beforeRestore()) ?? flowId;
      const r = await restoreVersion(id, v.id);
      onRestored();
      onClose();
      const when = formatDateTime(v.savedAt, { lang });
      const undoId = r.versionId;
      toast.success(t('flows.versions.restored', { when }), {
        description: t('flows.versions.restoredHint'),
        duration: 10_000,
        ...(undoId
          ? {
              action: {
                label: t('flows.versions.undo'),
                onClick: () =>
                  void restoreVersion(id, undoId).then(
                    () => {
                      onRestored();
                      toast.info(t('flows.versions.undone'));
                    },
                    (err: unknown) => toast.error(t('flows.versions.undoFailed'), { description: flowErrorText(err) }),
                  ),
              },
            }
          : {}),
      });
    } catch (err) {
      toast.error(t('flows.versions.restoreFailed'), { description: flowErrorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const current = history?.current;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      icon={History}
      title={t('flows.versions.title', { name: flowName })}
      description={history ? t('flows.versions.description', { max: history.maxVersions }) : undefined}
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
          title={t('flows.versions.loadFailed')}
          description={flowErrorText(error)}
          actions={
            flowId ? (
              <Button variant="secondary" onClick={() => void load(flowId)}>
                {t('common.retry')}
              </Button>
            ) : null
          }
        />
      ) : !history ? (
        <div className="fl-trash__loading">
          <Spinner size={16} />
        </div>
      ) : (
        <ol className="fl-versions">
          <li className="fl-versions__row is-current">
            <span className="fl-versions__dot" aria-hidden />
            <div className="fl-versions__text">
              <span className="fl-versions__when">
                {t('flows.versions.now')}
                {current?.savedAt ? <span className="fl-versions__ago">{t('flows.versions.savedAgo', { when: formatRelative(current.savedAt) })}</span> : null}
              </span>
              <span className="fl-versions__changes">{changesText(current?.changes, t) || (history.versions.length ? t('flows.versions.noChange') : t('flows.versions.original'))}</span>
            </div>
          </li>
          {history.versions.map((v, i) => {
            const why = replacedByKey(v.reason);
            const changes = changesText(v.changes, t);
            const renamed = v.name !== (history.versions[i - 1]?.name ?? flowName);
            return (
              <li key={v.id} className="fl-versions__row">
                <span className="fl-versions__dot" aria-hidden />
                <div className="fl-versions__text">
                  <span className="fl-versions__when tnum">
                    {formatDateTime(v.savedAt, { lang })}
                    <span className="fl-versions__ago">{formatRelative(v.savedAt)}</span>
                    {why ? <span className="fl-chip">{t(why)}</span> : null}
                  </span>
                  <span className={clsx('fl-versions__changes', !changes && 'is-quiet')}>
                    {[renamed ? t('flows.versions.named', { name: v.name }) : '', changes || (v.changes ? t('flows.versions.noChange') : t('flows.versions.oldest')), t('flows.list.steps', { count: v.nodeCount })]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy === v.id} disabled={!!busy && busy !== v.id} onClick={() => void restore(v)}>
                  {t('flows.versions.restore')}
                </Button>
              </li>
            );
          })}
          {!history.versions.length ? <li className="fl-versions__empty">{t('flows.versions.empty')}</li> : null}
        </ol>
      )}
    </Dialog>
  );
}
