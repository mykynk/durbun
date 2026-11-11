/**
 * What a `{{template}}` in a node can read, for the autocomplete of template fields: outputs of the steps that run
 * before it (JSON paths from the last run when there is one), variables, flow inputs, environment keys, the run and
 * the target, event data, `item` inside a repeat, and the helpers.
 */
import { flowNodeSpec, TEMPLATE_HELPERS, TEMPLATE_PIPES, type FlowDoc, type FlowNode } from '@durbun/protocol';
import { getLanguage, translateOr } from '../../../i18n';
import { upstream } from './graph';
import { outputText } from './text';

export type SuggestionKind = 'step' | 'var' | 'input' | 'env' | 'run' | 'target' | 'trigger' | 'item' | 'helper' | 'pipe';

export interface TemplateSuggestion {
  /** Text between `{{` and `}}`. */
  expr: string;
  kind: SuggestionKind;
  /** Short description in the UI language. */
  detail?: string;
  /** Example value from the last run. */
  sample?: string;
}

export interface SuggestionContext {
  flow: FlowDoc;
  /** The node being edited (its own outputs are not offered; upstream ones are). Undefined = flow outputs. */
  nodeId?: string;
  envKeys: readonly string[];
  /** Outputs of the last run by node id (JSON paths are offered from them). */
  lastOutputs?: Readonly<Record<string, unknown>>;
}

const TARGET_FIELDS = ['appId', 'appName', 'appVersion', 'deviceId', 'deviceName', 'platform', 'kind', 'osVersion'];
const RUN_FIELDS = ['flowName', 'flowId', 'id', 'status', 'startedAt'];

function sampleText(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return undefined;
  }
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return SAFE_KEY.test(key) ? `${base}.${key}` : `${base}['${key.replace(/'/g, "\\'")}']`;
}

/** Paths into a sample value, breadth first (lists: first element only). */
function samplePaths(base: string, value: unknown, depth: number, out: TemplateSuggestion[], limit: number): void {
  if (depth <= 0 || out.length >= limit || value === null || typeof value !== 'object') return;
  const entries: [string | number, unknown][] = Array.isArray(value) ? (value.length ? [[0, value[0]]] : []) : Object.entries(value as Record<string, unknown>).slice(0, 40);
  const children: [string, unknown][] = [];
  for (const [k, v] of entries) {
    if (out.length >= limit) return;
    const expr = joinPath(base, k);
    out.push({ expr, kind: 'step', sample: sampleText(v) });
    children.push([expr, v]);
  }
  for (const [expr, v] of children) samplePaths(expr, v, depth - 1, out, limit);
}

function inRepeatLoop(flow: FlowDoc, nodeId: string | undefined): boolean {
  if (!nodeId) return false;
  const repeats = flow.nodes.filter((n) => n.type === 'logic.repeat');
  if (!repeats.length) return false;
  const ups = upstream(flow, nodeId);
  return repeats.some((r) => ups.has(r.id) || r.id === nodeId);
}

function varNames(flow: FlowDoc): string[] {
  const names = new Set<string>();
  for (const n of flow.nodes) {
    if (n.type === 'logic.setVariables' && Array.isArray(n.params?.assignments)) {
      for (const a of n.params!.assignments as { name?: unknown }[]) if (typeof a?.name === 'string' && a.name) names.add(a.name);
    }
    if ((n.type === 'http.request' || n.type === 'wait.network') && Array.isArray(n.params?.extract)) {
      for (const x of n.params!.extract as { name?: unknown }[]) if (typeof x?.name === 'string' && x.name) names.add(x.name);
    }
  }
  return [...names].sort();
}

/** A text of the `flows.tpl.detail` family in the UI language, the catalog's English when missing. */
function detail(key: string, english: string): string {
  return translateOr(getLanguage(), `flows.tpl.detail.${key}`, undefined, english);
}

function nodeOutputs(node: FlowNode): { name: string; description: string }[] {
  const spec = flowNodeSpec(node.type);
  if (!spec) return [];
  if (node.type === 'logic.setVariables') {
    const list = Array.isArray(node.params?.assignments) ? (node.params!.assignments as { name?: unknown }[]) : [];
    return list.filter((a) => typeof a?.name === 'string' && a.name).map((a) => ({ name: a.name as string, description: detail('assigned', 'Assigned value') }));
  }
  return spec.outputs.filter((o) => !o.name.startsWith('<')).map((o) => ({ name: o.name, description: outputText(node.type, o.name) }));
}

export function templateSuggestions(ctx: SuggestionContext): TemplateSuggestion[] {
  const { flow, nodeId } = ctx;
  const out: TemplateSuggestion[] = [];
  const before = nodeId ? upstream(flow, nodeId) : new Set(flow.nodes.map((n) => n.id));
  // Steps first, in the order they appear on the canvas (left to right).
  const steps = flow.nodes.filter((n) => before.has(n.id) && flowNodeSpec(n.type)?.group !== 'trigger');
  steps.sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0));
  for (const n of steps) {
    const last = ctx.lastOutputs?.[n.id] as Record<string, unknown> | undefined;
    for (const o of nodeOutputs(n)) {
      const expr = `${n.id}.${o.name}`;
      out.push({ expr, kind: 'step', detail: o.description, sample: sampleText(last?.[o.name]) });
      if ((o.name === 'body' || o.name === 'outputs' || o.name === 'props' || o.name === 'data') && last && typeof last[o.name] === 'object') {
        samplePaths(expr, last[o.name], 3, out, out.length + 60);
      }
    }
  }
  for (const v of varNames(flow)) out.push({ expr: `vars.${v}`, kind: 'var' });
  for (const i of flow.inputs ?? []) out.push({ expr: `input.${i.name}`, kind: 'input', detail: i.description });
  for (const k of ctx.envKeys) out.push({ expr: `env.${k}`, kind: 'env' });
  if (inRepeatLoop(flow, nodeId)) out.push({ expr: 'item', kind: 'item', detail: detail('item', 'Current list element (repeat over a list)') });
  for (const r of flow.nodes.filter((n) => n.type === 'logic.repeat' && (!nodeId || before.has(n.id)))) {
    out.push({ expr: `${r.id}.index`, kind: 'step', detail: detail('index', 'Current iteration (0-based)') });
  }
  const event = flow.nodes.find((n) => n.type === 'trigger.event');
  if (event) for (const o of flowNodeSpec('trigger.event')!.outputs) out.push({ expr: `trigger.${o.name}`, kind: 'trigger', detail: outputText('trigger.event', o.name) });
  for (const f of TARGET_FIELDS) out.push({ expr: `target.${f}`, kind: 'target' });
  for (const f of RUN_FIELDS) out.push({ expr: `run.${f}`, kind: 'run' });
  for (const [name, h] of Object.entries(TEMPLATE_HELPERS)) {
    const call = name === '$randomInt' ? '$randomInt(1, 100)' : name === '$randomString' ? '$randomString(8)' : name;
    out.push({ expr: call, kind: 'helper', detail: detail(`helper.${name.slice(1)}`, h.description) });
  }
  return dedupe(out);
}

/** Pipes that can follow a value (`{{x | length}}`). */
export function pipeSuggestions(): TemplateSuggestion[] {
  return Object.entries(TEMPLATE_PIPES).map(([name, p]) => ({ expr: name === 'default' ? "default('')" : name, kind: 'pipe' as const, detail: detail(`pipe.${name}`, p.description) }));
}

function dedupe(list: TemplateSuggestion[]): TemplateSuggestion[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.expr) ? false : (seen.add(s.expr), true)));
}

/**
 * The template being typed at the caret: text after the last unclosed `{{` before the caret.
 * Returns null outside a template. `pipe` = the caret is after a `|`.
 */
export function openTemplateAt(text: string, caret: number): { start: number; query: string; pipe: boolean } | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('{{');
  if (open < 0) return null;
  const close = before.lastIndexOf('}}');
  if (close > open) return null;
  const inner = before.slice(open + 2);
  const bar = inner.lastIndexOf('|');
  if (bar >= 0) return { start: open + 2 + bar + 1, query: inner.slice(bar + 1).trimStart(), pipe: true };
  return { start: open + 2, query: inner.trimStart(), pipe: false };
}

/** Inserts a suggestion at the open template; closes it with `}}` when needed. Returns the new text + caret. */
export function applySuggestion(text: string, caret: number, open: { start: number; pipe: boolean }, expr: string): { text: string; caret: number } {
  const head = text.slice(0, open.start) + (open.pipe ? ' ' : '');
  let tail = text.slice(caret);
  // Drop the rest of a word the caret was inside.
  tail = tail.replace(/^[\w.$[\]'"()-]*/, '');
  const closes = /^\s*}}/.test(tail);
  const insert = open.pipe ? expr : expr;
  const next = `${head}${insert}${closes ? '' : '}}'}${tail}`;
  const pos = head.length + insert.length + (closes ? (tail.match(/^\s*}}/)?.[0].length ?? 0) : 2);
  return { text: next, caret: pos };
}

export function filterSuggestions(list: readonly TemplateSuggestion[], query: string, limit = 50): TemplateSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const starts: TemplateSuggestion[] = [];
  const contains: TemplateSuggestion[] = [];
  for (const s of list) {
    const e = s.expr.toLowerCase();
    if (e.startsWith(q)) starts.push(s);
    else if (e.includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, limit);
}
