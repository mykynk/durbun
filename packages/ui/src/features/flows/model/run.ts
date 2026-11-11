/** Runs in the editor: node states on the canvas, step texts and the shareable report. */
import type { FlowRun, FlowRunStep, FlowStepStatus } from '@durbun/protocol';
import { formatDateTime, formatDuration } from '../../../lib/format';
import { tCode, type Lang } from '../../../i18n';
import type { NodeRunState } from '../components/Canvas';
import { stepName } from './text';

/** Status of each node of the started flow (sub-flow steps are left out: their nodes are on another canvas). */
export function runOverlay(run: FlowRun | undefined): Map<string, NodeRunState> {
  const out = new Map<string, NodeRunState>();
  if (!run) return out;
  for (const s of run.steps) {
    if (s.depth !== 0 || s.flowId !== run.flowId) continue;
    const prev = out.get(s.nodeId);
    out.set(s.nodeId, {
      status: s.status,
      count: (prev?.count ?? 0) + 1,
      handled: s.handled,
      unsupported: !!s.unsupported,
    });
  }
  return out;
}

/** Latest step of each node (the inspector's "last run"). */
export function lastSteps(run: FlowRun | undefined): Map<string, FlowRunStep> {
  const out = new Map<string, FlowRunStep>();
  if (!run) return out;
  for (const s of run.steps) if (s.depth === 0 && s.flowId === run.flowId) out.set(s.nodeId, s);
  return out;
}

/** Outputs of the last run by node id (template suggestions). */
export function lastOutputs(run: FlowRun | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, s] of lastSteps(run)) if (s.output !== undefined) out[id] = s.output;
  return out;
}

export function stepText(step: FlowRunStep): string {
  return tCode(step.code, step.params, step.summary ?? step.error ?? '');
}

export function stepError(step: FlowRunStep): string | undefined {
  if (!step.error) return undefined;
  return tCode(step.errorCode, step.params, step.error);
}

export function runErrorText(run: Pick<FlowRun, 'error' | 'errorCode' | 'errorParams'>): string | undefined {
  if (!run.error) return undefined;
  return tCode(run.errorCode, run.errorParams, run.error);
}

export function statusKey(status: FlowStepStatus | FlowRun['status'], handled?: boolean): string {
  if (status === 'failed' && handled) return 'flows.status.handled';
  return `flows.status.${status}`;
}

export interface ReportLabels {
  t(key: string, params?: Record<string, string | number>): string;
  lang: Lang;
}

/** The run as light Markdown (Copy, .md, Send to Slack). Secrets are already masked by the server. */
export function runReport(run: FlowRun, { t, lang }: ReportLabels): string {
  const out: string[] = [];
  const c = run.counts;
  const duration = run.durationMs !== undefined ? formatDuration(run.durationMs, { lang }) : '';
  out.push(`${t('flows.report.flow')}: ${run.flowName} → ${t(statusKey(run.status))}`);
  out.push(
    [t('flows.report.counts', { passed: c.passed, total: c.total }), c.failed ? t('flows.report.failedCount', { count: c.failed }) : '', c.skipped ? t('flows.report.skippedCount', { count: c.skipped }) : '', duration]
      .filter(Boolean)
      .join(' · '),
  );
  out.push('');
  out.push(`- ${t('flows.report.started')}: ${formatDateTime(run.startedAt, { lang, seconds: true })}`);
  const tg = run.target;
  if (tg?.deviceName || tg?.deviceId) out.push(`- ${t('flows.report.device')}: ${[tg.deviceName ?? tg.deviceId, tg.osVersion ? `${tg.platform === 'ios' ? 'iOS' : tg.platform === 'android' ? 'Android' : ''} ${tg.osVersion}`.trim() : ''].filter(Boolean).join(' · ')}`);
  if (tg?.appId) out.push(`- ${t('flows.report.app')}: ${[tg.appName, tg.appVersion, `(${tg.appId})`].filter(Boolean).join(' ')}`);
  if (run.environment) out.push(`- ${t('flows.report.environment')}: ${run.environment.name}`);
  out.push(`- ${t('flows.report.trigger')}: ${run.trigger.kind === 'event' ? `${t('flows.report.event')}${run.trigger.detail ? ` — ${run.trigger.detail}` : ''}` : t('flows.report.manual')}`);
  if (run.inputs && Object.keys(run.inputs).length) {
    out.push(`- ${t('flows.report.inputs')}: ${Object.entries(run.inputs).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}`);
  }
  out.push('');
  out.push(`${t('flows.report.steps')}:`);
  let n = 0;
  for (const s of run.steps) {
    n++;
    const indent = '  '.repeat(Math.min(s.depth + (s.iteration !== undefined ? 1 : 0), 4));
    const name = stepName(s, lang);
    const time = s.durationMs !== undefined && s.durationMs >= 50 ? ` (${formatDuration(s.durationMs, { lang })})` : '';
    const what = stepText(s);
    out.push(`${indent}${n}. ${t(statusKey(s.status, s.handled))} · ${name} [${s.nodeId}]${what ? ` — ${what}` : ''}${time}`);
    const err = stepError(s);
    if (err && err !== what) out.push(`${indent}   ${err}`);
    if (s.evidence?.length) out.push(`${indent}   ${t('flows.report.evidence', { count: s.evidence.length })}`);
  }
  const err = runErrorText(run);
  if (err) {
    out.push('');
    out.push(`${t('flows.report.why')}:`);
    out.push('```');
    out.push(err);
    out.push('```');
  }
  if (run.outputs && Object.keys(run.outputs).length) {
    out.push('');
    out.push(`${t('flows.report.outputs')}:`);
    for (const [k, v] of Object.entries(run.outputs)) out.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return out.join('\n').trimEnd();
}

export function reportFileName(run: FlowRun): string {
  const d = new Date(run.startedAt);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${run.flowId}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.md`;
}
