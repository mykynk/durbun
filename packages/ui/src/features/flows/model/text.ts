/**
 * Words of the node catalog in the UI language: Turkish from catalogText.ts, English from the catalog itself
 * (FLOW_NODE_SPECS) plus the short English param labels. Unknown types fall back to the raw type.
 */
import { flowNodeSpec, type FlowConditionOp, type FlowNode, type FlowNodeGroup, type I18nParams } from '@durbun/protocol';
import { getLanguage, hasMessage, tCodeIn, translate, type Lang } from '../../../i18n';
import { GROUP_TEXT, NODE_TEXT_TR, PARAM_LABELS_EN } from '../catalogText';

export function nodeTitle(type: string, lang: Lang = getLanguage()): string {
  if (lang === 'tr') {
    const tr = NODE_TEXT_TR[type]?.title;
    if (tr) return tr;
  }
  return flowNodeSpec(type)?.title ?? type;
}

/** The node's own label, else the type title. */
export function nodeName(node: Pick<FlowNode, 'type' | 'label'>, lang: Lang = getLanguage()): string {
  return node.label?.trim() || nodeTitle(node.type, lang);
}

/** A run step's name: its own label, else its type's title in the UI language (the engine records the English title). */
export function stepName(step: { type: string; label?: string }, lang: Lang = getLanguage()): string {
  const label = step.label?.trim();
  return label && label !== flowNodeSpec(step.type)?.title ? label : nodeTitle(step.type, lang);
}

export function nodeDescription(type: string, lang: Lang = getLanguage()): string {
  if (lang === 'tr') {
    const tr = NODE_TEXT_TR[type]?.description;
    if (tr) return tr;
  }
  return flowNodeSpec(type)?.description ?? '';
}

function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function paramLabel(type: string, name: string, lang: Lang = getLanguage()): string {
  if (lang === 'tr') {
    const tr = NODE_TEXT_TR[type]?.params[name]?.label;
    if (tr) return tr;
  }
  return PARAM_LABELS_EN[type]?.[name] ?? humanize(name);
}

export function paramHint(type: string, name: string, lang: Lang = getLanguage()): string {
  if (lang === 'tr') {
    const tr = NODE_TEXT_TR[type]?.params[name]?.hint;
    if (tr) return tr;
  }
  return flowNodeSpec(type)?.params.find((p) => p.name === name)?.description ?? '';
}

export function paramPlaceholder(type: string, name: string, lang: Lang = getLanguage()): string | undefined {
  if (lang === 'tr') {
    const tr = NODE_TEXT_TR[type]?.params[name]?.placeholder;
    if (tr) return tr;
  }
  return flowNodeSpec(type)?.params.find((p) => p.name === name)?.placeholder;
}

export function optionLabel(type: string, param: string, value: string, lang: Lang = getLanguage()): string {
  if (lang === 'tr') {
    const tr = NODE_TEXT_TR[type]?.params[param]?.options?.[value];
    if (tr) return tr;
  }
  return flowNodeSpec(type)?.params.find((p) => p.name === param)?.options?.find((o) => o.value === value)?.label ?? value;
}

export function outputText(type: string, name: string, lang: Lang = getLanguage()): string {
  if (lang === 'tr') {
    const tr = NODE_TEXT_TR[type]?.outputs[name];
    if (tr) return tr;
  }
  return flowNodeSpec(type)?.outputs.find((o) => o.name === name)?.description ?? '';
}

export function groupTitle(group: FlowNodeGroup, lang: Lang = getLanguage()): string {
  return GROUP_TEXT[lang]?.[group] ?? GROUP_TEXT.en[group] ?? group;
}

const OPS: Record<Lang, Record<FlowConditionOp, string>> = {
  tr: {
    equals: 'eşittir',
    notEquals: 'eşit değildir',
    contains: 'içerir',
    notContains: 'içermez',
    startsWith: 'ile başlar',
    endsWith: 'ile biter',
    matches: 'regex’e uyar',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    in: 'şunlardan biri',
    exists: 'var',
    notExists: 'yok',
    isEmpty: 'boş',
    isNotEmpty: 'boş değil',
    isTrue: 'doğru (true)',
    isFalse: 'yanlış (false)',
  },
  en: {
    equals: 'equals',
    notEquals: 'does not equal',
    contains: 'contains',
    notContains: 'does not contain',
    startsWith: 'starts with',
    endsWith: 'ends with',
    matches: 'matches regex',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    in: 'is one of',
    exists: 'exists',
    notExists: 'does not exist',
    isEmpty: 'is empty',
    isNotEmpty: 'is not empty',
    isTrue: 'is true',
    isFalse: 'is false',
  },
};

export function opLabel(op: FlowConditionOp, lang: Lang = getLanguage()): string {
  return OPS[lang][op] ?? op;
}

/**
 * A condition as a sentence. Turkish puts the verb last ("x, abc ile başlar"), so each operator has its own
 * template; `{l}` is the left value, `{r}` the right one.
 */
const RULE_TR: Partial<Record<FlowConditionOp, string>> = {
  equals: '{l} = {r}',
  notEquals: '{l} ≠ {r}',
  contains: '{l}, {r} içerir',
  notContains: '{l}, {r} içermez',
  startsWith: '{l}, {r} ile başlar',
  endsWith: '{l}, {r} ile biter',
  matches: '{l}, {r} regex’ine uyar',
  gt: '{l} > {r}',
  gte: '{l} ≥ {r}',
  lt: '{l} < {r}',
  lte: '{l} ≤ {r}',
  in: '{l} şunlardan biri: {r}',
  exists: '{l} var',
  notExists: '{l} yok',
  isEmpty: '{l} boş',
  isNotEmpty: '{l} boş değil',
  isTrue: '{l} doğru',
  isFalse: '{l} yanlış',
};

export function ruleText(rule: { left?: string; op: string; right?: string }, lang: Lang = getLanguage()): string {
  const left = rule.left ?? '';
  const right = rule.right ?? '';
  const op = rule.op as FlowConditionOp;
  const tpl = lang === 'tr' ? RULE_TR[op] : undefined;
  // A half-filled rule (no value to compare with yet) reads better without the template.
  if (tpl && left && (right || !tpl.includes('{r}'))) return tpl.replace('{l}', left).replace('{r}', right);
  return [left, opLabel(op, lang), right].filter(Boolean).join(' ');
}

/** "10 dk", "1 sa", "1 sa 30 dk", "45 sn", "1,5 sn", "250 ms": whole units, without "0 sn" tails. */
export function formatSpan(ms: number, lang: Lang = getLanguage()): string {
  const num = (n: number) => new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 1 }).format(n);
  const u = (unit: 'ms' | 's' | 'min' | 'h', n: number) => translate(lang, `flows.unit.${unit}`, { n: num(n) });
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return u('ms', Math.round(ms));
  if (ms < 60_000) return u('s', Math.round(ms / 100) / 10);
  const secs = Math.round(ms / 1000);
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s ? `${u('min', m)} ${u('s', s)}` : u('min', m);
  }
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${u('h', h)} ${u('min', m)}` : u('h', h);
}

/** A port's name in the UI language ("loop" → "Her turda"); unknown ones stay as they are. */
export function portLabel(port: string, lang: Lang = getLanguage()): string {
  const key = `flows.port.${port}`;
  return hasMessage(key, lang) ? translate(lang, key) : port;
}

/** Group → color token (canvas accents). */
export const GROUP_COLOR: Record<FlowNodeGroup, string> = {
  trigger: 'var(--accent)',
  http: 'var(--pick-blue)',
  logic: 'var(--pick-orange)',
  device: 'var(--pick-green)',
  wait: 'var(--pick-pink)',
  mock: 'var(--pick-violet)',
  output: 'var(--pick-yellow)',
};

/** A validation or preflight issue as the server or validator reports it. */
export interface IssueLike {
  code: string;
  message: string;
  nodeId?: string;
  params?: I18nParams;
}

/**
 * An issue in the UI language: the step's field label instead of the param's JSON name ("URL is required", not
 * "url is required"); a preflight "the flow has an error" issue words the validation problem it carries.
 */
export function issueText(issue: IssueLike, nodes: readonly Pick<FlowNode, 'id' | 'type'>[] = [], lang: Lang = getLanguage()): string {
  const p = issue.params;
  if (issue.code === 'preflight.flow.invalid' && typeof p?.issue === 'string') {
    const problem = issueText({ code: p.issue, message: String(p.problem ?? issue.message), nodeId: issue.nodeId, params: p }, nodes, lang);
    return tCodeIn(lang, issue.code, { ...p, problem }, issue.message);
  }
  const node = issue.nodeId ? nodes.find((n) => n.id === issue.nodeId) : undefined;
  const param = p?.param;
  const named = node && typeof param === 'string' && flowNodeSpec(node.type)?.params.some((s) => s.name === param);
  let params = named ? { ...p, param: paramLabel(node.type, param, lang) } : p;
  // Ports by their names on the canvas ("Her turda", not "loop").
  if (params && (typeof params.port === 'string' || typeof params.ports === 'string')) {
    params = { ...params };
    if (typeof params.port === 'string') params.port = portLabel(params.port, lang);
    if (typeof params.ports === 'string')
      params.ports = params.ports
        .split(/,\s*/)
        .map((x) => portLabel(x.trim(), lang))
        .join(', ');
  }
  return tCodeIn(lang, issue.code, params, issue.message);
}
