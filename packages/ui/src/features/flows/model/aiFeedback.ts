/**
 * The "give it back to the AI" half of writing flows with an AI: the problems an import found, as plain English text
 * the AI can act on (step id, JSON path, rule code; every problem, no cap), and what an imported flow changes in the
 * flow it replaces, step by step.
 */
import type { FlowDoc, FlowIssue, FlowNode } from '@durbun/protocol';

export interface AiFeedbackItem {
  flow: Pick<FlowDoc, 'id' | 'name'>;
  issues: readonly FlowIssue[];
}

function issueLine(i: FlowIssue): string {
  const where = [i.nodeId ? `step "${i.nodeId}"` : '', i.path ? `at ${i.path}` : ''].filter(Boolean).join(' ');
  return `- ${i.level} ${i.code}${where ? ` (${where})` : ''}: ${i.message}`;
}

/** Plain text for the AI, in English whatever the UI language; '' when there is nothing to fix. */
export function issuesForAi(items: readonly AiFeedbackItem[], problems: readonly string[]): string {
  const withIssues = items.filter((it) => it.issues.length > 0);
  if (!problems.length && !withIssues.length) return '';
  const out: string[] = ['Dürbün checked the flow JSON you wrote and found these problems. Fix them and send the whole corrected flow JSON again.'];
  if (problems.length) {
    out.push('', 'Problems reading the answer:');
    for (const p of problems) out.push(`- ${p}`);
  }
  for (const it of withIssues) {
    const errors = it.issues.filter((i) => i.level === 'error');
    const warnings = it.issues.filter((i) => i.level !== 'error');
    out.push('', `Flow "${it.flow.id}" (${it.flow.name}): ${errors.length} error(s), ${warnings.length} warning(s)`);
    // Errors first: they block the run.
    for (const i of [...errors, ...warnings]) out.push(issueLine(i));
  }
  return out.join('\n');
}

export interface FlowDiff {
  added: FlowNode[];
  removed: FlowNode[];
  /** Steps kept with other settings: which top-level fields and params changed. */
  changed: { node: FlowNode; fields: string[] }[];
  /** Connections added / removed (counted by from, port, to). */
  linksAdded: number;
  linksRemoved: number;
  renamed: boolean;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What replacing [before] with [after] changes, step by step (positions on the canvas are not a change). */
export function flowDiff(before: FlowDoc, after: FlowDoc): FlowDiff {
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const changed: FlowDiff['changed'] = [];
  for (const n of after.nodes) {
    const o = old.get(n.id);
    if (!o) continue;
    const fields: string[] = [];
    if (o.type !== n.type) fields.push('type');
    for (const key of ['label', 'disabled', 'continueOnError', 'retry', 'timeoutMs', 'note'] as const) {
      if (!same(o[key], n[key])) fields.push(key);
    }
    const params = new Set([...Object.keys(o.params ?? {}), ...Object.keys(n.params ?? {})]);
    for (const p of params) if (!same(o.params?.[p], n.params?.[p])) fields.push(p);
    if (fields.length) changed.push({ node: n, fields });
  }
  const linkKey = (e: FlowDoc['edges'][number]) => `${e.from}\u0000${e.port ?? 'out'}\u0000${e.to}`;
  const oldLinks = new Set(before.edges.map(linkKey));
  const newLinks = new Set(after.edges.map(linkKey));
  return {
    added: after.nodes.filter((n) => !old.has(n.id)),
    removed: before.nodes.filter((n) => !next.has(n.id)),
    changed,
    linksAdded: [...newLinks].filter((k) => !oldLinks.has(k)).length,
    linksRemoved: [...oldLinks].filter((k) => !newLinks.has(k)).length,
    renamed: before.name !== after.name,
  };
}

export function isEmptyDiff(d: FlowDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length && !d.linksAdded && !d.linksRemoved && !d.renamed;
}
