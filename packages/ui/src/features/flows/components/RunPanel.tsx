import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { ArrowLeft, Ban, ChevronDown, CircleAlert, CircleCheck, CircleSlash, CircleX, Clock, Copy, ExternalLink, FileDown, Globe, Play, RotateCcw, Smartphone, Square, Trash, X } from 'lucide-react';
import type { FlowDoc, FlowRun, FlowRunHeader, FlowRunStep } from '@durbun/protocol';
import { Button, Callout, CopyButton, DropdownMenu, IconButton, JsonTree, SlackButton, Spinner, Tooltip, confirm, copyText, downloadText, formatDuration, formatRelative, toast, type MenuItem } from '../../../components';
import { api, rememberFlowRun, ui, useFlows, useNow } from '../../../data';
import { forgetFlowRuns } from '../../../data/stores/flows';
import { tCode, useLanguage, useT } from '../../../i18n';
import { flowErrorText } from '../model/errors';
import { reportFileName, runErrorText, runReport, statusKey, stepError, stepText } from '../model/run';
import { stepName } from '../model/text';
import { Evidence } from './Evidence';
import { PreflightDetails } from './RunControls';

export interface RunPanelProps {
  flow: FlowDoc;
  runId: string | null;
  onRunId(id: string | null): void;
  onSelectNode(nodeId: string): void;
  onRerun(): void;
  onClose(): void;
  /** Opens the run target picker (a run that stopped for want of a device). */
  onPickTarget?(): void;
  onManageEnvironments?(): void;
}

/** The run under the canvas: live steps, the selected step's details, the report and the history of this flow. */
export function RunPanel({ flow, runId, onRunId, onSelectNode, onRerun, onClose, onPickTarget, onManageEnvironments }: RunPanelProps) {
  const t = useT();
  const lang = useLanguage();
  const run = useFlows((s) => (runId ? s.runs[runId] : undefined));
  const [stepId, setStepId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  // A run this window did not see live (history, another window) is read once.
  useEffect(() => {
    if (!runId || run) return;
    const ctrl = new AbortController();
    setLoading(true);
    api.getFlowRun(runId, ctrl.signal).then(
      (r) => rememberFlowRun(r),
      (err: unknown) => {
        if ((err as { name?: string })?.name !== 'AbortError') toast.error(t('flows.history.loadFailed'), { description: flowErrorText(err) });
      },
    ).finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [runId, run, t]);

  // A running run that was fetched over REST still gets its steps from the live deltas.
  useEffect(() => setStepId(null), [runId]);

  const steps = run?.steps ?? [];
  const failedStep = useMemo(() => steps.find((s) => s.status === 'failed' && !s.handled), [steps]);
  const selected = steps.find((s) => s.id === stepId) ?? (run?.status !== 'running' ? (failedStep ?? null) : null);

  // Keep the newest step visible while running (unless the user scrolled up).
  useEffect(() => {
    const el = listRef.current;
    if (!el || run?.status !== 'running' || !follow.current) return;
    el.scrollTop = el.scrollHeight;
  }, [steps.length, run?.status]);

  if (!runId) return null;
  if (!run) {
    return (
      <div className="fl-runpanel">
        <div className="fl-runpanel__loading">{loading ? <Spinner size={16} /> : t('flows.history.missing')}</div>
      </div>
    );
  }
  const report = () => runReport(run, { t: (k, p) => t(k, p), lang });
  // Stopped before any step ran (an error at the start, an interrupted run): the reason, not an empty list.
  const beforeFirst = steps.length === 0 && (run.status === 'failed' || run.status === 'cancelled');
  const pick = (s: FlowRunStep) => {
    setStepId(s.id);
    if (s.depth === 0 && s.flowId === flow.id) onSelectNode(s.nodeId);
  };
  // One tab stop for the list; the arrows move through the steps.
  const tabStop = selected?.id ?? steps[0]?.id;
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !steps.length) return;
    e.preventDefault();
    const i = Math.max(0, steps.findIndex((s) => s.id === tabStop));
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? steps.length - 1 : Math.min(steps.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
    const s = steps[next]!;
    pick(s);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-step="${s.id}"]`)?.focus({ preventScroll: false }));
  };

  return (
    <div className="fl-runpanel" aria-label={t('flows.runPanel.label')}>
      <RunHeader run={run} flow={flow} onRunId={onRunId} onRerun={onRerun} onClose={onClose} report={report} />
      {beforeFirst ? (
        <BeforeFirstStep run={run} onRerun={onRerun} onPickTarget={onPickTarget} onManageEnvironments={onManageEnvironments} />
      ) : run.status === 'failed' || run.status === 'cancelled' ? (
        <RunErrorLine run={run} onSelectStep={(s) => setStepId(s.id)} failedStep={failedStep} />
      ) : null}
      {beforeFirst && !run.preflight?.length ? null : (
        <div className={clsx('fl-runpanel__body', stepId !== null && selected && 'has-pick', beforeFirst && 'is-empty')}>
          <div
            className="fl-steps"
            ref={listRef}
            role="listbox"
            aria-label={t('flows.runPanel.steps')}
            onKeyDown={onListKey}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {steps.length === 0 && !beforeFirst ? <div className="fl-steps__empty">{run.status === 'running' ? t('flows.runPanel.starting') : t('flows.runPanel.noSteps')}</div> : null}
            {steps.map((s, i) => (
              <StepRow key={s.id} step={s} n={i + 1} selected={selected?.id === s.id} tabStop={tabStop === s.id} onClick={() => pick(s)} />
            ))}
          </div>
          <div className="fl-stepdetail">
            {/* Narrow panels show the list or one step; this goes back to the list. */}
            <button type="button" className="fl-stepdetail__back fl-link" onClick={() => setStepId(null)}>
              <ArrowLeft size={13} aria-hidden />
              {t('flows.runPanel.allSteps')}
            </button>
            {selected ? (
              <StepDetail step={selected} flow={flow} />
            ) : run.preflight?.length ? (
              <div className="fl-stepdetail__pre">
                <h3>{t('flows.runPanel.preflight')}</h3>
                <PreflightDetails preflight={{ ok: true, issues: run.preflight, irreversible: [], skipped: [] }} flow={flow} />
              </div>
            ) : (
              <div className="fl-stepdetail__hint">{t('flows.runPanel.pickStep')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status, handled, size = 14 }: { status: FlowRunStep['status'] | FlowRun['status']; handled?: boolean; size?: number }) {
  if (status === 'running') return <Spinner size={size - 2} className="fl-status is-running" />;
  if (status === 'passed') return <CircleCheck size={size} className="fl-status is-passed" aria-hidden />;
  if (status === 'failed') return handled ? <CircleAlert size={size} className="fl-status is-handled" aria-hidden /> : <CircleX size={size} className="fl-status is-failed" aria-hidden />;
  if (status === 'skipped') return <CircleSlash size={size} className="fl-status is-skipped" aria-hidden />;
  return <Ban size={size} className="fl-status is-cancelled" aria-hidden />;
}

function RunHeader({ run, flow, onRunId, onRerun, onClose, report }: { run: FlowRun; flow: FlowDoc; onRunId(id: string | null): void; onRerun(): void; onClose(): void; report(): string }) {
  const t = useT();
  const now = useNow(run.status === 'running' ? 1000 : 60_000);
  const duration = run.durationMs ?? (run.status === 'running' ? now - run.startedAt : undefined);
  const [stopping, setStopping] = useState(false);
  const c = run.counts;
  const tg = run.target;
  return (
    <div className="fl-runpanel__head">
      <StatusIcon status={run.status} size={16} />
      <div className="fl-runpanel__title">
        <span className={clsx('fl-chip', `is-${run.status}`)}>{t(statusKey(run.status))}</span>
        <span className="fl-runpanel__meta tnum">
          {[
            // "0/0 steps passed" says nothing about a run that stopped before its first step.
            c.total > 0 || run.status === 'running' || run.status === 'passed' ? t('flows.runPanel.counts', { passed: c.passed, total: c.total }) : '',
            c.failed ? t('flows.report.failedCount', { count: c.failed }) : '',
            c.skipped ? t('flows.report.skippedCount', { count: c.skipped }) : '',
            duration !== undefined ? formatDuration(duration) : '',
            formatRelative(run.startedAt, now),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {tg?.deviceName || tg?.appId ? <span className="fl-runpanel__target">{[tg.deviceName, tg.appName ?? tg.appId].filter(Boolean).join(' · ')}</span> : null}
        {run.environment ? <span className="fl-runpanel__target">{run.environment.name}</span> : null}
        {run.trigger.kind === 'event' ? <span className="fl-chip is-accent">{t('flows.runPanel.automatic')}</span> : null}
      </div>
      <span className="grow" />
      {run.status === 'running' ? (
        <Button
          size="sm"
          variant="danger"
          icon={Square}
          loading={stopping}
          onClick={async () => {
            setStopping(true);
            try {
              await api.cancelFlowRun(run.id);
            } catch (err) {
              toast.error(t('flows.run.stopFailed'), { description: flowErrorText(err) });
            } finally {
              setStopping(false);
            }
          }}
        >
          {t('flows.run.stop')}
        </Button>
      ) : (
        <>
          <Tooltip content={t('flows.runPanel.copyReport')}>
            <IconButton
              icon={Copy}
              label={t('flows.runPanel.copyReport')}
              noTooltip
              onClick={async () => {
                if (await copyText(report())) toast.success(t('flows.runPanel.reportCopied'));
              }}
            />
          </Tooltip>
          <IconButton icon={FileDown} label={t('flows.runPanel.downloadReport')} onClick={() => downloadText(report(), reportFileName(run), 'text/markdown;charset=utf-8')} />
          <SlackButton report={report()} />
          <Button size="sm" variant="secondary" icon={RotateCcw} onClick={onRerun}>
            {t('flows.runPanel.rerun')}
          </Button>
        </>
      )}
      <History flow={flow} current={run.id} onPick={onRunId} />
      <IconButton icon={X} label={t('flows.runPanel.close')} onClick={onClose} />
    </div>
  );
}

function RunErrorLine({ run, failedStep, onSelectStep }: { run: FlowRun; failedStep?: FlowRunStep; onSelectStep(s: FlowRunStep): void }) {
  const t = useT();
  const text = runErrorText(run) ?? (failedStep ? stepError(failedStep) : undefined);
  if (!text) return null;
  return (
    <div className={clsx('fl-runpanel__error', run.status === 'cancelled' && 'is-cancelled')} role="alert">
      <CircleAlert size={14} aria-hidden />
      <span>{text}</span>
      {failedStep ? (
        <button type="button" className="fl-link" onClick={() => onSelectStep(failedStep)}>
          {t('flows.runPanel.showFailed')}
        </button>
      ) : null}
    </div>
  );
}

/** What fits a run that never reached its first step: pick a device, fill the inputs, fix the environment, or rerun. */
function BeforeFirstStep({ run, onRerun, onPickTarget, onManageEnvironments }: { run: FlowRun; onRerun(): void; onPickTarget?(): void; onManageEnvironments?(): void }) {
  const t = useT();
  const codes = [run.errorCode ?? '', ...(run.preflight ?? []).filter((i) => i.level !== 'info').map((i) => i.code)];
  const has = (re: RegExp) => codes.some((c) => re.test(c));
  const action =
    onPickTarget && has(/^(preflight|flow)\.(device|app|action)\./) ? (
      <Button size="sm" variant="secondary" icon={Smartphone} onClick={onPickTarget}>
        {t('flows.runPanel.pickTarget')}
      </Button>
    ) : has(/^(preflight\.input\.|flow\.inputs$)/) ? (
      <Button size="sm" variant="secondary" icon={Play} onClick={onRerun}>
        {t('flows.runPanel.fillInputs')}
      </Button>
    ) : onManageEnvironments && has(/^preflight\.env\./) ? (
      <Button size="sm" variant="secondary" icon={Globe} onClick={onManageEnvironments}>
        {t('flows.env.manage')}
      </Button>
    ) : (
      <Button size="sm" variant="secondary" icon={RotateCcw} onClick={onRerun}>
        {t('flows.runPanel.rerun')}
      </Button>
    );
  return (
    <div className="fl-runpanel__before">
      <Callout tone={run.status === 'cancelled' ? 'info' : 'danger'} compact title={t('flows.runPanel.beforeFirst')} actions={action}>
        {runErrorText(run) ?? t('flows.runPanel.beforeFirstHint')}
      </Callout>
    </div>
  );
}

function StepRow({ step, n, selected, tabStop, onClick }: { step: FlowRunStep; n: number; selected: boolean; tabStop: boolean; onClick(): void }) {
  const t = useT();
  const lang = useLanguage();
  const text = stepText(step);
  const name = stepName(step, lang);
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      data-step={step.id}
      className={clsx('fl-step', selected && 'is-selected', `is-${step.status}`, step.handled && 'is-handled')}
      style={{ paddingLeft: 8 + Math.min(step.depth, 4) * 14 }}
      onClick={onClick}
    >
      <span className="fl-step__n tnum">{n}</span>
      <StatusIcon status={step.status} handled={step.handled} />
      <span className="fl-step__name">{name}</span>
      {step.depth > 0 ? <span className="fl-step__flow">{step.flowId}</span> : null}
      {step.iteration !== undefined ? <span className="fl-step__iter">{t('flows.runPanel.iteration', { n: step.iteration + 1 })}</span> : null}
      <span className="fl-step__text">{text}</span>
      {step.evidence?.length ? <span className="fl-step__ev">{t('flows.runPanel.evidence', { count: step.evidence.length })}</span> : null}
      <span className="fl-step__time tnum">{step.durationMs !== undefined ? formatDuration(step.durationMs) : ''}</span>
    </div>
  );
}

function StepDetail({ step, flow }: { step: FlowRunStep; flow: FlowDoc }) {
  const t = useT();
  const lang = useLanguage();
  const text = stepText(step);
  const err = stepError(step);
  const name = stepName(step, lang);
  return (
    <div className="fl-stepdetail__content">
      <div className="fl-stepdetail__head">
        <StatusIcon status={step.status} handled={step.handled} />
        <h3>{name}</h3>
        <code>{step.flowId !== flow.id ? `${step.flowId} › ${step.nodeId}` : step.nodeId}</code>
        <span className="grow" />
        {step.attempts && step.attempts > 1 ? <span className="fl-chip">{t('flows.runPanel.attempts', { count: step.attempts })}</span> : null}
        {step.port && step.port !== 'out' ? <span className="fl-chip">{t(`flows.port.${step.port}`)}</span> : null}
      </div>
      {text ? <p className="fl-stepdetail__text">{text}</p> : null}
      {err && err !== text ? <p className="fl-insp__error">{err}</p> : null}
      {step.unsupported ? <p className="fl-insp__hint">{tCode(step.unsupported, step.params, step.unsupported)}</p> : null}
      {step.handled ? <p className="fl-insp__hint">{t('flows.runPanel.handledHint')}</p> : null}
      {step.outputTrimmed ? <p className="fl-insp__hint">{t('flows.runPanel.outputTrimmed')}</p> : null}
      <div className="fl-stepdetail__actions">
        {step.netId ? (
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => ui.focusNetwork(step.netId!)}>
            {t('flows.inspector.openRequest')}
          </Button>
        ) : null}
        {step.output !== undefined && !step.outputTrimmed ? <CopyButton value={() => JSON.stringify(step.output, null, 2)} label={t('flows.inspector.copyOutput')} text={t('flows.inspector.copyOutput')} size="sm" /> : null}
      </div>
      {step.evidence?.length ? <Evidence items={step.evidence} /> : null}
      {step.output !== undefined && !step.outputTrimmed ? <JsonTree data={step.output} rootLabel={step.nodeId} defaultExpandDepth={2} className="fl-stepdetail__json" /> : null}
    </div>
  );
}

/* ───────────── history ───────────── */

function History({ flow, current, onPick }: { flow: FlowDoc; current: string; onPick(id: string | null): void }) {
  const t = useT();
  const [runs, setRuns] = useState<FlowRunHeader[] | null>(null);
  const lastRunId = useFlows((s) => s.summaries.find((f) => f.id === flow.id)?.lastRun?.id);
  // The list is fetched when a run starts; the store keeps that run's status and counts current.
  const live = useFlows((s) => s.runs);
  const load = () =>
    api.listFlowRuns({ flowId: flow.id, limit: 40 }).then(
      (r) => setRuns([...r.running, ...r.runs]),
      () => setRuns([]),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.id, lastRunId]);
  const items = (): MenuItem[] => {
    const list: MenuItem[] = (runs ?? []).map((h) => {
      const now = live[h.id];
      return now ? { ...h, status: now.status, counts: now.counts, durationMs: now.durationMs } : h;
    }).map((r) => ({
      label: (
        <span className="fl-history__item">
          <StatusIcon status={r.status} size={13} />
          <span>{formatRelative(r.startedAt)}</span>
          <span className="fl-history__meta tnum">
            {t('flows.runPanel.counts', { passed: r.counts.passed, total: r.counts.total })}
            {r.durationMs !== undefined ? ` · ${formatDuration(r.durationMs)}` : ''}
          </span>
        </span>
      ),
      hint: r.trigger.kind === 'event' ? t('flows.runPanel.automatic') : r.target?.deviceName,
      checked: r.id === current,
      onSelect: () => onPick(r.id),
    }));
    if (!list.length) list.push({ type: 'label', label: t('flows.history.empty') });
    else {
      list.push({ type: 'separator' });
      list.push({
        label: t('flows.history.clear'),
        icon: Trash,
        danger: true,
        onSelect: async () => {
          const ok = await confirm({ title: t('flows.history.clearTitle'), message: t('flows.history.clearMessage', { name: flow.name }), confirmLabel: t('flows.history.clearConfirm'), danger: true });
          if (!ok) return;
          try {
            const n = await api.clearFlowRuns(flow.id);
            // The canvas and "last run" must not keep showing what was deleted.
            forgetFlowRuns(flow.id);
            toast.success(t('flows.history.cleared', { count: n }));
            onPick(null);
            void load();
          } catch (err) {
            toast.error(t('flows.history.clearFailed'), { description: flowErrorText(err) });
          }
        },
      });
    }
    return list;
  };
  return (
    <DropdownMenu items={items} minWidth={320} align="end" aria-label={t('flows.history.title')}>
      {(p) => (
        <Button size="sm" variant="ghost" icon={Clock} iconRight={ChevronDown} {...p}>
          {t('flows.history.title')}
        </Button>
      )}
    </DropdownMenu>
  );
}

export { Play as RunIcon };
