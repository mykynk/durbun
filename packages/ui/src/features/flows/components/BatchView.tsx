import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Ban, CircleAlert, CircleCheck, CircleSlash, CircleX, Clock, Copy, FileDown, History, ListChecks, RotateCcw, Share2, Square, Trash, X } from 'lucide-react';
import type { FlowBatch, FlowBatchItem } from '@durbun/protocol';
import { Button, Callout, EmptyState, IconButton, Popover, SlackButton, Spinner, Tooltip, confirm, copyText, downloadText, formatDuration, formatRelative, toast } from '../../../components';
import { useFlows, useNow } from '../../../data';
import { tCode, useLanguage, useT } from '../../../i18n';
import { transfer } from '../../transfer/store';
import { batchFileName, batchHeadline, batchReport, batchTitle, batchTone, finishedRunIds, itemDetail, itemStatusKey, type BatchTone } from '../model/batch';
import { flowErrorText } from '../model/errors';
import { forgetSet, refreshSet, refreshSets, useSets } from '../model/sets';
import { cancelBatch, deleteBatch } from '../model/setsApi';

export interface BatchViewProps {
  batchId: string;
  onOpenFlow(flowId: string): void;
  onOpenRun(flowId: string, runId: string): void;
  onRunAgain(batch: FlowBatch): void;
  onShowSet(id: string): void;
  onClose(): void;
}

const CALLOUT_TONE: Record<BatchTone, 'info' | 'success' | 'warn' | 'danger'> = { running: 'info', passed: 'success', partial: 'warn', failed: 'danger', cancelled: 'info' };

/** One set run: its progress while it runs, then one line per flow (what failed where, what did not run and why). */
export function BatchView({ batchId, onOpenFlow, onOpenRun, onRunAgain, onShowSet, onClose }: BatchViewProps) {
  const t = useT();
  const lang = useLanguage();
  const batch = useSets((s) => s.byId[batchId]);
  const [state, setState] = useState<'loading' | 'missing' | 'ready'>(batch ? 'ready' : 'loading');
  const [stopping, setStopping] = useState(false);
  const running = batch?.status === 'running';
  const now = useNow(running ? 1000 : 60_000);

  useEffect(() => {
    let alive = true;
    void refreshSet(batchId).then((b) => {
      if (alive) setState(b ? 'ready' : useSets.getState().byId[batchId] ? 'ready' : 'missing');
    });
    return () => {
      alive = false;
    };
  }, [batchId]);

  if (!batch) {
    return state === 'missing' ? (
      <EmptyState
        size="md"
        icon={ListChecks}
        title={t('flows.batch.view.missing')}
        description={t('flows.batch.view.missingHint')}
        actions={
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        }
      />
    ) : (
      <div className="fl-main__loading">
        <Spinner size={18} />
      </div>
    );
  }

  const tone = batchTone(batch);
  const report = () => batchReport(batch, { t: (k, p) => t(k, p), lang });
  const duration = batch.durationMs ?? (running ? now - batch.startedAt : undefined);
  const done = batch.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length;
  const tg = batch.target;
  const stop = async () => {
    setStopping(true);
    try {
      await cancelBatch(batch.id);
      await refreshSet(batch.id);
    } catch (err) {
      toast.error(t('flows.batch.stopFailed'), { description: flowErrorText(err) });
    } finally {
      setStopping(false);
    }
  };
  const remove = async () => {
    const ok = await confirm({ title: t('flows.batch.view.removeTitle'), message: t('flows.batch.view.removeMessage'), confirmLabel: t('flows.batch.view.remove'), danger: true });
    if (!ok) return;
    try {
      await deleteBatch(batch.id);
      forgetSet(batch.id);
      onClose();
      void refreshSets();
    } catch (err) {
      toast.error(t('flows.batch.view.removeFailed'), { description: flowErrorText(err) });
    }
  };
  const runIds = finishedRunIds(batch);

  return (
    <section className="fl-batch" aria-label={batchTitle(batch, t)}>
      <header className="fl-batch__head">
        <ToneIcon tone={tone} />
        <div className="fl-batch__title">
          <h2 className="fl-batch__name">{batchTitle(batch, t)}</h2>
          <span className="fl-batch__meta tnum">
            {[
              tg?.deviceName ? [tg.deviceName, tg.appName ?? tg.appId].filter(Boolean).join(' · ') : t('flows.batch.view.autoTarget'),
              batch.environment?.name ?? '',
              formatRelative(batch.startedAt, now),
              duration !== undefined ? formatDuration(duration) : '',
              batch.onFailure === 'stop' ? t('flows.batch.view.stopsOnFailure') : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <span className="grow" />
        <div className="fl-batch__actions">
          {running ? (
            <Button size="sm" variant="danger" icon={Square} loading={stopping} onClick={() => void stop()}>
              {t('flows.batch.view.stop')}
            </Button>
          ) : (
            <>
              <Tooltip content={t('flows.batch.view.copy')}>
                <IconButton
                  icon={Copy}
                  label={t('flows.batch.view.copy')}
                  noTooltip
                  onClick={async () => {
                    if (await copyText(report())) toast.success(t('flows.batch.view.copied'));
                  }}
                />
              </Tooltip>
              <IconButton icon={FileDown} label={t('flows.batch.view.download')} onClick={() => downloadText(report(), batchFileName(batch), 'text/markdown;charset=utf-8')} />
              <SlackButton report={report()} />
              <Tooltip content={runIds.length ? t('flows.batch.view.shareHint') : t('flows.batch.view.shareNoRuns')}>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Share2}
                  disabled={!runIds.length}
                  onClick={() => transfer.openExport('share', [...new Set(batch.items.filter((i) => i.runId).map((i) => i.flowId))], { runs: runIds, name: batchTitle(batch, t) })}
                >
                  {t('flows.batch.view.share')}
                </Button>
              </Tooltip>
              <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => onRunAgain(batch)}>
                {t('flows.batch.view.runAgain')}
              </Button>
            </>
          )}
          <EarlierSets current={batch.id} onPick={onShowSet} />
          {!running ? <IconButton icon={Trash} label={t('flows.batch.view.remove')} onClick={() => void remove()} /> : null}
          <IconButton icon={X} label={t('flows.batch.view.close')} onClick={onClose} />
        </div>
      </header>

      <div className="fl-batch__body">
        {running ? (
          <div className="fl-batch__progress" role="progressbar" aria-valuemin={0} aria-valuemax={batch.counts.total} aria-valuenow={done} aria-label={batchHeadline(batch, t)}>
            <span className="fl-batch__bar" style={{ width: `${batch.counts.total ? (done / batch.counts.total) * 100 : 0}%` }} />
          </div>
        ) : null}
        <Callout tone={CALLOUT_TONE[tone]} compact icon={null} className="fl-batch__headline">
          <strong>{batchHeadline(batch, t)}</strong>
          {/* The full count when the headline names only one part of it (failed / stopped). */}
          {tone === 'failed' || tone === 'cancelled' ? (
            <span className="fl-batch__why tnum">
              {[
                t('flows.batch.report.passed', { count: batch.counts.passed }),
                batch.counts.failed ? t('flows.batch.report.failed', { count: batch.counts.failed }) : '',
                batch.counts.skipped ? t('flows.batch.report.skipped', { count: batch.counts.skipped }) : '',
                batch.counts.cancelled ? t('flows.batch.report.notRun', { count: batch.counts.cancelled }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : null}
          {batch.reason ? <span className="fl-batch__why">{tCode(batch.reason.code, batch.reason.params, batch.reason.message)}</span> : null}
        </Callout>
        <ol className="fl-batch__items">
          {batch.items.map((item, i) => (
            <ItemRow key={`${item.flowId}:${i}`} item={item} index={i} onOpenFlow={onOpenFlow} onOpenRun={onOpenRun} />
          ))}
        </ol>
        <p className="fl-batch__note">{running ? t('flows.batch.view.runningNote') : t('flows.batch.view.keptNote')}</p>
      </div>
    </section>
  );
}

function ToneIcon({ tone }: { tone: BatchTone }) {
  if (tone === 'running') return <Spinner size={16} className="fl-batch__icon" />;
  if (tone === 'passed') return <CircleCheck size={18} className="fl-batch__icon fl-status is-passed" aria-hidden />;
  if (tone === 'failed') return <CircleX size={18} className="fl-batch__icon fl-status is-failed" aria-hidden />;
  if (tone === 'partial') return <CircleAlert size={18} className="fl-batch__icon fl-status is-skipped" aria-hidden />;
  return <Ban size={18} className="fl-batch__icon fl-status is-cancelled" aria-hidden />;
}

function ItemIcon({ item }: { item: FlowBatchItem }) {
  if (item.status === 'running') return <Spinner size={12} className="fl-status is-running" />;
  if (item.status === 'pending') return <Clock size={14} className="fl-status is-pending" aria-hidden />;
  if (item.status === 'passed') return <CircleCheck size={14} className="fl-status is-passed" aria-hidden />;
  if (item.status === 'failed') return <CircleX size={14} className="fl-status is-failed" aria-hidden />;
  if (item.status === 'skipped') return <CircleSlash size={14} className="fl-status is-skipped" aria-hidden />;
  return <Ban size={14} className="fl-status is-cancelled" aria-hidden />;
}

function ItemRow({ item, index, onOpenFlow, onOpenRun }: { item: FlowBatchItem; index: number; onOpenFlow(id: string): void; onOpenRun(flowId: string, runId: string): void }) {
  const t = useT();
  const lang = useLanguage();
  // The flow running now: its live step count from the socket.
  const live = useFlows((s) => (item.status === 'running' && item.runId ? s.runs[item.runId] : undefined));
  const exists = useFlows((s) => s.summaries.some((f) => f.id === item.flowId));
  const d = itemDetail(item, lang);
  const counts = live?.counts ?? item.counts;
  const meta = [
    counts && (counts.total > 0 || item.status === 'passed') ? t('flows.runPanel.counts', { passed: counts.passed, total: counts.total }) : '',
    item.durationMs !== undefined ? formatDuration(item.durationMs) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (item.status === 'running') rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [item.status]);
  return (
    <li ref={rowRef} className={clsx('fl-batch__item', `is-${item.status}`)}>
      <span className="fl-batch__num tnum" aria-hidden>
        {index + 1}
      </span>
      <ItemIcon item={item} />
      <div className="fl-batch__main">
        <div className="fl-batch__line">
          {exists ? (
            <button type="button" className="fl-link fl-batch__flow" onClick={() => onOpenFlow(item.flowId)} title={t('flows.batch.view.openFlow')}>
              {item.flowName}
            </button>
          ) : (
            <span className="fl-batch__flow">{item.flowName}</span>
          )}
          <span className={clsx('fl-chip', `is-${item.status === 'cancelled' && !item.runId ? 'skipped' : item.status}`)}>{t(itemStatusKey(item))}</span>
          {meta ? <span className="fl-batch__itemmeta tnum">{meta}</span> : null}
        </div>
        {d.step || d.text ? (
          <div className="fl-batch__detail">
            {d.step ? <span className="fl-batch__step">{t('flows.batch.view.failedAt', { step: d.step })}</span> : null}
            {d.text ? <span className="fl-batch__text">{d.text}</span> : null}
          </div>
        ) : null}
      </div>
      {item.runId && exists ? (
        <Button size="sm" variant="ghost" onClick={() => onOpenRun(item.flowId, item.runId!)}>
          {item.status === 'running' ? t('flows.batch.view.watch') : t('flows.batch.view.openRun')}
        </Button>
      ) : null}
    </li>
  );
}

/** Earlier set runs (kept on the server, newest first). */
function EarlierSets({ current, onPick }: { current: string; onPick(id: string): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const recent = useSets((s) => s.recent);
  useEffect(() => {
    if (open) void refreshSets();
  }, [open]);
  return (
    <>
      <IconButton ref={ref} icon={History} label={t('flows.batch.view.earlier')} active={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} side="bottom" align="end" width={340} aria-label={t('flows.batch.view.earlier')}>
        <div className="fl-batch__earlier">
          <div className="fl-batch__earlier-head">{t('flows.batch.view.earlier')}</div>
          {!recent ? (
            <div className="fl-batch__earlier-empty">
              <Spinner size={14} />
            </div>
          ) : !recent.length ? (
            <div className="fl-batch__earlier-empty">{t('flows.batch.menu.noneYet')}</div>
          ) : (
            <ul>
              {recent.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={clsx('fl-batch__earlier-row', b.id === current && 'is-current')}
                    onClick={() => {
                      setOpen(false);
                      onPick(b.id);
                    }}
                  >
                    <span className={clsx('fl-batch__dot', `is-${batchTone(b)}`)} aria-hidden />
                    <span className="fl-batch__earlier-text">
                      <span className="truncate">{batchTitle(b, t)}</span>
                      <span className="fl-batch__earlier-meta">{`${batchHeadline(b, t)} · ${formatRelative(b.startedAt)}`}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Popover>
    </>
  );
}
