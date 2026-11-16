/** Set runs ("run my smoke set"): which flows a tag picks, how a set and its flows are worded, the shared report. */
import type { FlowBatch, FlowBatchItem, FlowSummary } from '@durbun/protocol';
import { formatDateTime, formatDuration } from '../../../lib/format';
import { tCodeIn, type Lang } from '../../../i18n';
import { stepName } from './text';

/** At most this many flows in one set (the server's MAX_BATCH_FLOWS). */
export const MAX_SET_FLOWS = 100;

export interface TagCount {
  tag: string;
  count: number;
}

/** Tags of the saved flows with how many flows have each (case does not matter, the first spelling wins), most used first. */
export function tagCounts(summaries: readonly Pick<FlowSummary, 'tags'>[]): TagCount[] {
  const byKey = new Map<string, TagCount>();
  for (const f of summaries) {
    const seen = new Set<string>();
    for (const raw of f.tags ?? []) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      const c = byKey.get(key);
      if (c) c.count++;
      else byKey.set(key, { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The flows a tag runs, in the order the server runs them (by name). */
export function flowsWithTag<T extends Pick<FlowSummary, 'id' | 'name' | 'tags'>>(summaries: readonly T[], tag: string): T[] {
  const key = tag.trim().toLowerCase();
  return summaries.filter((f) => f.tags?.some((x) => x.trim().toLowerCase() === key)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export type BatchTone = 'running' | 'passed' | 'partial' | 'failed' | 'cancelled';

/** `partial`: nothing failed, but some flows did not run (a coverage gap the report must not hide). */
export function batchTone(b: Pick<FlowBatch, 'status' | 'counts'>): BatchTone {
  if (b.status === 'running') return 'running';
  if (b.status === 'failed') return 'failed';
  if (b.status === 'cancelled') return 'cancelled';
  return b.counts.skipped + b.counts.cancelled > 0 ? 'partial' : 'passed';
}

type T = (key: string, params?: Record<string, string | number>) => string;

/** "Smoke" set / "3 flows" (a hand-picked set). */
export function batchTitle(b: Pick<FlowBatch, 'tag' | 'counts'>, t: T): string {
  return b.tag ? t('flows.batch.titleTag', { tag: b.tag }) : t('flows.batch.titlePicked', { count: b.counts.total });
}

/** One line: what the set came to. */
export function batchHeadline(b: Pick<FlowBatch, 'status' | 'counts' | 'items'>, t: T): string {
  const c = b.counts;
  const notRun = c.skipped + c.cancelled;
  if (b.status === 'running') {
    const done = b.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length;
    return t('flows.batch.progress', { done, total: c.total });
  }
  if (b.status === 'cancelled') return t('flows.batch.headStopped', { done: c.passed + c.failed, total: c.total });
  if (c.failed) return t('flows.batch.headFailed', { failed: c.failed, total: c.total });
  if (notRun) return t('flows.batch.headPartial', { passed: c.passed, notRun });
  return t('flows.batch.headPassed', { count: c.passed });
}

/** The failing step's name and what went wrong, or why the flow did not run. */
export function itemDetail(item: FlowBatchItem, lang: Lang): { step?: string; text?: string } {
  const out: { step?: string; text?: string } = {};
  const fs = item.failedStep;
  if (fs) {
    out.step = stepName({ type: fs.type, ...(fs.label ? { label: fs.label } : {}) }, lang);
    if (fs.error) out.text = tCodeIn(lang, fs.errorCode, fs.params, fs.error);
  }
  if (!out.text && item.reason) out.text = tCodeIn(lang, item.reason.code, item.reason.params, item.reason.message);
  return out;
}

/** "Stopped" for a flow cut off mid-run, "Not run" for one the set never started. */
export function itemStatusKey(item: Pick<FlowBatchItem, 'status' | 'runId'>): string {
  if (item.status === 'pending') return 'flows.batch.status.pending';
  if (item.status === 'skipped') return 'flows.batch.status.skipped';
  if (item.status === 'cancelled') return item.runId ? 'flows.status.cancelled' : 'flows.batch.status.notRun';
  return `flows.status.${item.status}`;
}

const platformName = (p?: string) => (p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : '');

/** The set as light Markdown (Copy, .md, Send to Slack): one line per flow, the failing step and the reason. */
export function batchReport(b: FlowBatch, { t, lang }: { t: T; lang: Lang }): string {
  const out: string[] = [];
  const c = b.counts;
  out.push(`${batchTitle(b, t)} → ${batchHeadline(b, t)}`);
  out.push(
    [
      t('flows.batch.report.passed', { count: c.passed }),
      c.failed ? t('flows.batch.report.failed', { count: c.failed }) : '',
      c.skipped ? t('flows.batch.report.skipped', { count: c.skipped }) : '',
      c.cancelled ? t('flows.batch.report.notRun', { count: c.cancelled }) : '',
      b.durationMs !== undefined ? formatDuration(b.durationMs, { lang }) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  out.push('');
  out.push(`- ${t('flows.report.started')}: ${formatDateTime(b.startedAt, { lang, seconds: true })}`);
  const tg = b.target;
  if (tg?.deviceName || tg?.deviceId) out.push(`- ${t('flows.report.device')}: ${[tg.deviceName ?? tg.deviceId, tg.osVersion ? `${platformName(tg.platform)} ${tg.osVersion}`.trim() : ''].filter(Boolean).join(' · ')}`);
  if (tg?.appId) out.push(`- ${t('flows.report.app')}: ${[tg.appName, tg.appVersion, `(${tg.appId})`].filter(Boolean).join(' ')}`);
  if (b.environment) out.push(`- ${t('flows.report.environment')}: ${b.environment.name}`);
  if (b.onFailure === 'stop') out.push(`- ${t('flows.batch.report.stopOnFailure')}`);
  out.push('');
  out.push(`${t('flows.batch.report.flows')}:`);
  b.items.forEach((item, i) => {
    const time = item.durationMs !== undefined ? ` (${formatDuration(item.durationMs, { lang })})` : '';
    const steps = item.counts ? ` · ${t('flows.report.counts', { passed: item.counts.passed, total: item.counts.total })}` : '';
    out.push(`${i + 1}. ${t(itemStatusKey(item))} · ${item.flowName}${steps}${time}`);
    const d = itemDetail(item, lang);
    if (d.step) out.push(`   ${t('flows.batch.report.failedStep', { step: d.step })}${d.text ? ` — ${d.text}` : ''}`);
    else if (d.text) out.push(`   ${d.text}`);
  });
  if (b.reason) {
    out.push('');
    out.push(`${t('flows.report.why')}: ${tCodeIn(lang, b.reason.code, b.reason.params, b.reason.message)}`);
  }
  return out.join('\n').trimEnd();
}

export function batchFileName(b: Pick<FlowBatch, 'tag' | 'startedAt'>): string {
  const d = new Date(b.startedAt);
  const pad = (x: number) => String(x).padStart(2, '0');
  const base = (b.tag ?? 'flows').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flows';
  return `${base}-set-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.md`;
}

/** Runs of the set that ended (what a shared package can carry). */
export function finishedRunIds(b: Pick<FlowBatch, 'items'>): string[] {
  return b.items.filter((i) => i.runId && (i.status === 'passed' || i.status === 'failed' || i.status === 'cancelled')).map((i) => i.runId!);
}
