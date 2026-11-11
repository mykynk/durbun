/**
 * Flow validation + normalization. Forgiving where intent is clear (what an AI or a hand edit commonly writes:
 * `source/target` edges, headers as an object, `==` operators, a missing trigger), strict where running would go
 * wrong. Every problem is a FlowIssue with a JSON path and an English message an AI can act on.
 */
import { FLOW_NODE_SPECS, flowNodePorts, flowNodeSpec, type FlowNodeSpec, type FlowParamSpec } from './catalog';
import { FLOW_CONDITION_OPS, isStatusSpec, UNARY_OPS } from './expr';
import { collectTemplateRoots, parsePath, renameTemplateRoot, RESERVED_ROOTS, templateSyntaxError } from './template';
import {
  FLOW_FORMAT,
  FLOW_VERSION,
  type FlowConditionOp,
  type FlowDoc,
  type FlowEdge,
  type FlowIssue,
  type FlowNode,
  type FlowPort,
  type FlowSummary,
} from './types';

export const MAX_FLOW_NODES = 500;
export const MAX_FLOW_EDGES = 2000;
export const FLOW_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NODE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Names that would reach an object's prototype; never node ids, variables, inputs or outputs. */
export const UNSAFE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export interface ValidateFlowOptions {
  /** Ids of flows that exist (flow.call targets); unknown ones become warnings. */
  knownFlowIds?: ReadonlySet<string>;
  /** Make an id for a flow without one. */
  newFlowId?: (name: string) => string;
  /** Add a manual trigger when there is none (default true). */
  addTrigger?: boolean;
  /** Flow ids fixed elsewhere in the same import (raw → fixed): `flow.call` targets follow them. */
  flowIdMap?: ReadonlyMap<string, string>;
}

export interface ValidateFlowResult {
  /** The normalized document (undefined when it is not a flow at all). */
  flow?: FlowDoc;
  issues: FlowIssue[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A flow id as written, made file-safe when it is not (`Login Flow` → `login-flow`). */
export function fixFlowId(id: string): string {
  return FLOW_ID_RE.test(id) ? id : slugifyFlowId(id);
}

/** A node id as written, made template-safe when it is not (`get-cart` → `get_cart`). */
export function fixNodeId(id: string): string {
  return NODE_ID_RE.test(id) ? id : id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1').slice(0, 64);
}

/** "Sipariş akışı" → "siparis-akisi". */
export function slugifyFlowId(name: string): string {
  const s = name
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'flow';
}

/** A node id not used yet: `<prefix><n>`. */
export function newNodeId(existing: Iterable<string>, type: string): string {
  const used = new Set(existing);
  const prefix = flowNodeSpec(type)?.idPrefix ?? 'step';
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) return id;
  }
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** The catalog type a misspelled one most likely meant. */
export function suggestNodeType(type: string): string | undefined {
  const t = type.trim().toLowerCase();
  const exact = FLOW_NODE_SPECS.find((s) => s.type.toLowerCase() === t);
  if (exact) return exact.type;
  const bySuffix = FLOW_NODE_SPECS.filter((s) => s.type.toLowerCase().endsWith(`.${t}`) || s.type.split('.')[1]!.toLowerCase() === t.split('.').pop());
  if (bySuffix.length === 1) return bySuffix[0]!.type;
  let best: { type: string; d: number } | undefined;
  for (const s of FLOW_NODE_SPECS) {
    const d = levenshtein(t, s.type.toLowerCase());
    if (!best || d < best.d) best = { type: s.type, d };
  }
  return best && best.d <= 4 ? best.type : undefined;
}

const OP_ALIASES: Record<string, FlowConditionOp> = {
  '==': 'equals',
  '===': 'equals',
  eq: 'equals',
  is: 'equals',
  '!=': 'notEquals',
  '!==': 'notEquals',
  ne: 'notEquals',
  neq: 'notEquals',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  includes: 'contains',
  regex: 'matches',
  exist: 'exists',
  empty: 'isEmpty',
  notempty: 'isNotEmpty',
};
const OPS = new Set<string>(FLOW_CONDITION_OPS.map((o) => o.op));

function normalizeOp(raw: unknown): FlowConditionOp | undefined {
  if (typeof raw !== 'string') return undefined;
  if (OPS.has(raw)) return raw as FlowConditionOp;
  const alias = OP_ALIASES[raw.trim()] ?? OP_ALIASES[raw.trim().toLowerCase()];
  if (alias) return alias;
  const ci = [...OPS].find((o) => o.toLowerCase() === raw.trim().toLowerCase());
  return ci as FlowConditionOp | undefined;
}

const toStr = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

class Ctx {
  issues: FlowIssue[] = [];
  err(code: string, message: string, path?: string, nodeId?: string, params?: FlowIssue['params']) {
    this.issues.push({ level: 'error', code, message, ...(path ? { path } : {}), ...(nodeId ? { nodeId } : {}), ...(params ? { params } : {}) });
  }
  warn(code: string, message: string, path?: string, nodeId?: string, params?: FlowIssue['params']) {
    this.issues.push({ level: 'warning', code, message, ...(path ? { path } : {}), ...(nodeId ? { nodeId } : {}), ...(params ? { params } : {}) });
  }
}

function checkTemplates(c: Ctx, value: unknown, path: string, nodeId?: string) {
  if (typeof value === 'string') {
    const e = templateSyntaxError(value);
    if (e) c.err('flow.template.syntax', `${e} in "${value.length > 80 ? value.slice(0, 77) + '…' : value}"`, path, nodeId, { detail: e });
  } else if (Array.isArray(value)) value.forEach((v, i) => checkTemplates(c, v, `${path}[${i}]`, nodeId));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) checkTemplates(c, v, `${path}.${k}`, nodeId);
}

function regexCheck(c: Ctx, pattern: string, path: string, nodeId: string | undefined, param: string) {
  try {
    new RegExp(pattern);
  } catch (err) {
    c.err('flow.regex.invalid', `Invalid regular expression "${pattern}": ${(err as Error).message}`, path, nodeId, { pattern, param });
  }
}

function reservedName(c: Ctx, name: string, path: string, nodeId?: string) {
  if (UNSAFE_NAMES.has(name)) c.err('flow.name.reserved', `"${name}" is a reserved name; pick another`, path, nodeId, { name });
}

/** Status filter params (`2xx`, `200,201`, `200-299`) by node type. */
export const FLOW_STATUS_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'http.request': ['expectStatus'],
  'wait.network': ['status'],
  'trigger.event': ['status'],
};

/** Params read as a regular expression, and when. */
const REGEX_PARAMS: Readonly<Record<string, readonly { param: string; when: (p: Record<string, unknown>) => boolean }[]>> = {
  'wait.log': [{ param: 'text', when: (p) => p.regex === true }],
  'trigger.event': [
    { param: 'text', when: (p) => p.regex === true },
    { param: 'url', when: (p) => p.match === 'regex' },
  ],
  'wait.network': [{ param: 'url', when: (p) => p.match === 'regex' }],
  'mock.add': [{ param: 'url', when: (p) => p.match === 'regex' }],
};

/** Checks of a node's params that look at more than one param, after they are normalized. */
function checkNodeParams(c: Ctx, type: string, params: Record<string, unknown>, path: string, nodeId: string) {
  for (const name of FLOW_STATUS_PARAMS[type] ?? []) {
    const v = params[name];
    if (typeof v === 'string' && !v.includes('{{') && !isStatusSpec(v)) {
      c.err('flow.param.status', `${name} "${v}" is not a status filter (use 200, 2xx, 200,201 or 200-299)`, `${path}.params.${name}`, nodeId, { param: name, value: v });
    }
  }
  for (const { param, when } of REGEX_PARAMS[type] ?? []) {
    const v = params[param];
    if (typeof v === 'string' && v && !v.includes('{{') && when(params)) regexCheck(c, v, `${path}.params.${param}`, nodeId, param);
  }
  if (type === 'mock.add' && params.action === 'delay') {
    const d = params.delayMs;
    if (d === undefined || d === 0 || d === '') c.err('flow.mock.delay', 'A delay mock needs delayMs above 0', `${path}.params.delayMs`, nodeId);
  }
}

function normalizeKeyValue(v: unknown): [string, string][] | undefined {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    const out: [string, string][] = [];
    for (const item of v) {
      if (Array.isArray(item) && item.length >= 1) out.push([toStr(item[0]), toStr(item[1])]);
      else if (isObj(item) && (item.name !== undefined || item.key !== undefined)) out.push([toStr(item.name ?? item.key), toStr(item.value)]);
      else return undefined;
    }
    return out;
  }
  if (isObj(v)) return Object.entries(v).map(([k, val]) => [k, toStr(val)]);
  return undefined;
}

function normalizeParam(c: Ctx, spec: FlowParamSpec, raw: unknown, path: string, nodeId: string, allParams: Record<string, unknown>): unknown {
  switch (spec.kind) {
    case 'text':
    case 'longText': {
      if (raw === null) return '';
      if (typeof raw === 'object') {
        // A JSON body written as an object (common in AI answers and hand edits): keep its text.
        const s = JSON.stringify(raw, null, spec.kind === 'longText' ? 2 : undefined);
        c.warn('flow.param.jsonText', `${spec.name} was written as JSON; it is kept as its text`, path, nodeId, { param: spec.name });
        checkTemplates(c, s, path, nodeId);
        return s;
      }
      const s = toStr(raw);
      checkTemplates(c, s, path, nodeId);
      return s;
    }
    case 'number': {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) c.err('flow.param.type', `${spec.name} must be a number`, path, nodeId, { param: spec.name, expected: 'number' });
        else if ((spec.min !== undefined && raw < spec.min) || (spec.max !== undefined && raw > spec.max)) {
          c.err('flow.param.range', `${spec.name} must be between ${spec.min ?? '−∞'} and ${spec.max ?? '∞'}`, path, nodeId, { param: spec.name, min: spec.min ?? '', max: spec.max ?? '' });
        }
        return raw;
      }
      if (typeof raw === 'string') {
        if (raw.includes('{{')) {
          checkTemplates(c, raw, path, nodeId);
          return raw;
        }
        const n = Number(raw.trim());
        if (raw.trim() !== '' && Number.isFinite(n)) return normalizeParam(c, spec, n, path, nodeId, allParams);
      }
      c.err('flow.param.type', `${spec.name} must be a number`, path, nodeId, { param: spec.name, expected: 'number' });
      return raw;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      if (raw === 1 || raw === 0) return raw === 1;
      if (typeof raw === 'string' && raw.includes('{{')) return raw;
      c.err('flow.param.type', `${spec.name} must be true or false`, path, nodeId, { param: spec.name, expected: 'boolean' });
      return raw;
    }
    case 'select': {
      const s = toStr(raw);
      const opt = spec.options?.find((o) => o.value === s) ?? spec.options?.find((o) => o.value.toLowerCase() === s.toLowerCase());
      if (opt) return opt.value;
      if (s.includes('{{')) return s;
      c.err('flow.param.option', `${spec.name} must be one of ${spec.options?.map((o) => o.value).join(', ')} (got "${s}")`, path, nodeId, {
        param: spec.name,
        value: s,
        options: spec.options?.map((o) => o.value).join(', ') ?? '',
      });
      return raw;
    }
    case 'keyValue': {
      const kv = normalizeKeyValue(raw);
      if (!kv) {
        c.err('flow.param.type', `${spec.name} must be a list of [name, value] pairs`, path, nodeId, { param: spec.name, expected: 'keyValue' });
        return raw;
      }
      kv.forEach(([, v], i) => checkTemplates(c, v, `${path}[${i}][1]`, nodeId));
      return kv;
    }
    case 'json': {
      if (allParams.bodyType === 'text' && spec.name === 'body' && typeof raw !== 'string') return toStr(raw);
      checkTemplates(c, raw, path, nodeId);
      return raw;
    }
    case 'conditions':
    case 'assertions': {
      if (!Array.isArray(raw)) {
        c.err('flow.param.type', `${spec.name} must be a list of { left, op, right } rules`, path, nodeId, { param: spec.name, expected: 'rules' });
        return raw;
      }
      return raw.map((r, i) => {
        const p = `${path}[${i}]`;
        if (!isObj(r)) {
          c.err('flow.param.type', 'A rule must be { left, op, right }', p, nodeId, { param: spec.name, expected: 'rule' });
          return r;
        }
        const op = normalizeOp(r.op ?? r.operator);
        if (!op) c.err('flow.rule.op', `Unknown operator "${toStr(r.op ?? r.operator)}" (use ${[...OPS].join(', ')})`, `${p}.op`, nodeId, { op: toStr(r.op ?? r.operator) });
        const out: Record<string, unknown> = { left: toStr(r.left ?? r.value ?? r.actual), op: op ?? r.op };
        const right = r.right !== undefined ? r.right : r.expected;
        // `in` reads a comma-separated list; a JSON list (what AIs write) becomes one.
        if (right !== undefined) out.right = op === 'in' && Array.isArray(right) ? right.map(toStr).join(', ') : toStr(right);
        if (spec.kind === 'assertions' && r.message !== undefined) out.message = toStr(r.message);
        checkTemplates(c, out.left, `${p}.left`, nodeId);
        if (out.right !== undefined) checkTemplates(c, out.right, `${p}.right`, nodeId);
        if (!String(out.left).trim()) c.err('flow.rule.left', 'A rule needs a left side', `${p}.left`, nodeId);
        if (op && !UNARY_OPS.has(op) && out.right === undefined) {
          c.err('flow.rule.right', `"${op}" compares with a right side; add "right" (use "" for empty text)`, `${p}.right`, nodeId, { op });
        }
        if (op === 'matches' && typeof out.right === 'string' && !out.right.includes('{{')) regexCheck(c, out.right, `${p}.right`, nodeId, spec.name);
        return out;
      });
    }
    case 'extracts': {
      if (!Array.isArray(raw)) {
        c.err('flow.param.type', `${spec.name} must be a list of { name, from, path } rules`, path, nodeId, { param: spec.name, expected: 'extracts' });
        return raw;
      }
      return raw.map((r, i) => {
        const p = `${path}[${i}]`;
        if (!isObj(r)) {
          c.err('flow.param.type', 'An extract rule must be { name, from, path }', p, nodeId, { param: spec.name, expected: 'extract' });
          return r;
        }
        const name = toStr(r.name ?? r.variable);
        if (!VAR_NAME_RE.test(name)) c.err('flow.extract.name', `Variable name "${name}" must be letters, digits or _`, `${p}.name`, nodeId, { name });
        else reservedName(c, name, `${p}.name`, nodeId);
        let from = toStr(r.from ?? r.source ?? 'body');
        if (!['body', 'header', 'status', 'bodyText'].includes(from)) {
          if (from === 'headers') from = 'header';
          else c.err('flow.extract.from', `from must be body, header, status or bodyText (got "${from}")`, `${p}.from`, nodeId, { value: from });
        }
        const out: Record<string, unknown> = { name, from };
        const pathValue = r.path ?? r.jsonPath ?? r.header;
        if (pathValue !== undefined) out.path = toStr(pathValue);
        // JSONPath style ("$.data.token", what AIs often write) reads the same value without the "$".
        if (from === 'body' && typeof out.path === 'string' && /^\$(\.|\[|$)/.test(out.path.trim())) {
          const fixed = out.path.trim().replace(/^\$\.?/, '');
          c.warn('flow.extract.pathFixed', `The path "${out.path}" was read as "${fixed}" (paths start at the body, without "$")`, `${p}.path`, nodeId, { from: out.path, to: fixed });
          out.path = fixed;
        }
        if (typeof out.path === 'string' && out.path.includes('{{')) {
          c.err('flow.param.fixed', `${spec.name} path is read as written: it cannot hold a {{template}}`, `${p}.path`, nodeId, { param: `${spec.name}.path` });
        } else if (from === 'body' && typeof out.path === 'string') {
          try {
            parsePath(out.path);
          } catch (err) {
            c.err('flow.extract.pathSyntax', `${(err as Error).message} (a body path looks like items[0].id)`, `${p}.path`, nodeId, { detail: (err as Error).message });
          }
        }
        if (r.regex !== undefined) {
          out.regex = toStr(r.regex);
          if ((out.regex as string).includes('{{')) {
            c.err('flow.param.fixed', `${spec.name} regex is read as written: it cannot hold a {{template}}`, `${p}.regex`, nodeId, { param: `${spec.name}.regex` });
          } else {
            try {
              new RegExp(out.regex as string);
            } catch {
              c.err('flow.extract.regex', `Invalid regular expression "${out.regex}"`, `${p}.regex`, nodeId);
            }
          }
        }
        if (from === 'header' && !out.path) c.err('flow.extract.path', 'A header extract needs the header name in path', `${p}.path`, nodeId);
        return out;
      });
    }
    case 'assignments': {
      const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.entries(raw).map(([name, value]) => ({ name, value })) : undefined;
      if (!list) {
        c.err('flow.param.type', `${spec.name} must be a list of { name, value }`, path, nodeId, { param: spec.name, expected: 'assignments' });
        return raw;
      }
      return list.map((a, i) => {
        const p = `${path}[${i}]`;
        const item = isObj(a) ? a : {};
        const name = toStr(item.name);
        if (!VAR_NAME_RE.test(name)) c.err('flow.assign.name', `Variable name "${name}" must be letters, digits or _`, `${p}.name`, nodeId, { name });
        else reservedName(c, name, `${p}.name`, nodeId);
        const value = toStr(item.value);
        checkTemplates(c, value, `${p}.value`, nodeId);
        return { name, value };
      });
    }
    case 'flowRef':
      return toStr(raw);
    case 'mapping': {
      if (raw === undefined || raw === null) return {};
      if (!isObj(raw)) {
        c.err('flow.param.type', `${spec.name} must be an object { name: value }`, path, nodeId, { param: spec.name, expected: 'mapping' });
        return raw;
      }
      for (const k of Object.keys(raw)) reservedName(c, k, `${path}.${k}`, nodeId);
      checkTemplates(c, raw, path, nodeId);
      return raw;
    }
    default:
      return raw;
  }
}

function normalizeNode(c: Ctx, raw: unknown, index: number, usedIds: Set<string>, idMap: ReadonlyMap<string, string>): FlowNode | undefined {
  const path = `nodes[${index}]`;
  if (!isObj(raw)) {
    c.err('flow.node.invalid', 'A node must be an object', path);
    return undefined;
  }
  let type = toStr(raw.type);
  let spec = flowNodeSpec(type);
  if (!spec) {
    const suggestion = type ? suggestNodeType(type) : undefined;
    if (suggestion && suggestion.toLowerCase() === type.toLowerCase()) {
      type = suggestion;
      spec = flowNodeSpec(type);
    } else {
      c.err(
        'flow.node.unknownType',
        `Unknown node type "${type}"${suggestion ? ` — did you mean "${suggestion}"?` : ''} (see the node catalog)`,
        `${path}.type`,
        typeof raw.id === 'string' ? raw.id : undefined,
        { type, suggestion: suggestion ?? '' },
      );
    }
  }
  let id = toStr(raw.id);
  if (!id) {
    id = newNodeId(usedIds, type);
    c.warn('flow.node.idGenerated', `Node ${index + 1} had no id; it is now "${id}"`, `${path}.id`, id, { id });
  } else if (!NODE_ID_RE.test(id)) {
    const fixed = fixNodeId(id);
    c.warn('flow.node.idFixed', `Node id "${id}" may only use letters, digits and _; it is now "${fixed}" (edges and templates too)`, `${path}.id`, fixed, { from: id, to: fixed });
    id = fixed;
  }
  if (usedIds.has(id)) {
    c.err('flow.node.duplicateId', `Two nodes use the id "${id}"`, `${path}.id`, id, { id });
  } else if (RESERVED_ROOTS.has(id) || UNSAFE_NAMES.has(id)) {
    c.err('flow.node.reservedId', `"${id}" is reserved for templates; pick another node id`, `${path}.id`, id, { id });
  }
  usedIds.add(id);

  const node: FlowNode = { id, type };
  if (raw.label !== undefined && raw.label !== null && raw.label !== '') node.label = toStr(raw.label).slice(0, 200);
  if (raw.note !== undefined && raw.note !== '') node.note = toStr(raw.note).slice(0, 5000);
  if (isObj(raw.position) && Number.isFinite(Number(raw.position.x)) && Number.isFinite(Number(raw.position.y))) {
    node.position = { x: Math.round(Number(raw.position.x)), y: Math.round(Number(raw.position.y)) };
  }
  if (raw.disabled === true) node.disabled = true;
  if (raw.continueOnError === true) node.continueOnError = true;
  if (raw.timeoutMs !== undefined) {
    const t = Number(raw.timeoutMs);
    if (Number.isFinite(t) && t >= 100 && t <= 24 * 3_600_000) node.timeoutMs = Math.round(t);
    else c.err('flow.node.timeout', 'timeoutMs must be between 100 and 86 400 000', `${path}.timeoutMs`, id);
  }
  if (raw.retry !== undefined && raw.retry !== null) {
    if (isObj(raw.retry) && Number.isInteger(Number(raw.retry.count)) && Number(raw.retry.count) >= 0 && Number(raw.retry.count) <= 100) {
      node.retry = { count: Number(raw.retry.count) };
      if (raw.retry.delayMs !== undefined) node.retry.delayMs = Math.max(0, Math.min(Number(raw.retry.delayMs) || 0, 600_000));
    } else c.err('flow.node.retry', 'retry must be { count: 0–100, delayMs? }', `${path}.retry`, id);
  }

  const params: Record<string, unknown> = {};
  let rawParams = isObj(raw.params) ? raw.params : raw.params === undefined ? {} : null;
  if (rawParams === null) c.err('flow.node.params', 'params must be an object', `${path}.params`, id);
  // Templates follow node ids that were fixed (`{{get-cart.status}}` → `{{get_cart.status}}`).
  if (rawParams && idMap.size) for (const [from, to] of idMap) rawParams = renameTemplateRoot(rawParams, from, to) as Record<string, unknown>;
  if (spec && rawParams) {
    const known = new Set(spec.params.map((p) => p.name));
    for (const p of spec.params) {
      const value = rawParams[p.name];
      if (value === undefined) {
        const visible = !p.showIf || p.showIf.values.includes(rawParams[p.showIf.param] ?? spec.params.find((q) => q.name === p.showIf!.param)?.default);
        // A required list (rules, assertions, assignments) is required even though its default is empty.
        const noDefault = p.default === undefined || p.default === '' || (Array.isArray(p.default) && p.default.length === 0);
        if (p.required && noDefault && visible) c.err('flow.param.required', `${p.name} is required`, `${path}.params.${p.name}`, id, { param: p.name });
        continue;
      }
      if (p.fixed && typeof value === 'string' && value.includes('{{')) {
        c.err('flow.param.fixed', `${p.name} is read as written: it must be a fixed value, not a {{template}}`, `${path}.params.${p.name}`, id, { param: p.name });
        params[p.name] = value;
        continue;
      }
      params[p.name] = normalizeParam(c, p, value, `${path}.params.${p.name}`, id, rawParams);
      if (p.required && (params[p.name] === '' || (Array.isArray(params[p.name]) && p.kind !== 'keyValue' && (params[p.name] as unknown[]).length === 0))) {
        c.err('flow.param.required', `${p.name} is required`, `${path}.params.${p.name}`, id, { param: p.name });
      }
    }
    for (const [k, v] of Object.entries(rawParams)) {
      if (known.has(k)) continue;
      c.warn('flow.param.unknown', `Unknown parameter "${k}" for ${type} (ignored)`, `${path}.params.${k}`, id, { param: k, type });
      void v;
    }
    checkNodeParams(c, type, params, path, id);
  } else if (rawParams) {
    Object.assign(params, rawParams);
  }
  if (Object.keys(params).length > 0) node.params = params;
  return node;
}

function normalizeEdge(c: Ctx, raw: unknown, index: number, idMap: ReadonlyMap<string, string>): FlowEdge | undefined {
  const path = `edges[${index}]`;
  if (!isObj(raw)) {
    c.err('flow.edge.invalid', 'An edge must be { from, port, to }', path);
    return undefined;
  }
  const rawFrom = toStr(raw.from ?? raw.source);
  const rawTo = toStr(raw.to ?? raw.target);
  const from = idMap.get(rawFrom) ?? rawFrom;
  const to = idMap.get(rawTo) ?? rawTo;
  const portRaw = raw.port ?? raw.sourceHandle ?? raw.handle ?? raw.output ?? 'out';
  const port = toStr(portRaw || 'out') as FlowPort;
  if (!from || !to) {
    c.err('flow.edge.invalid', 'An edge needs from and to', path);
    return undefined;
  }
  const edge: FlowEdge = { from, to };
  if (port !== 'out') edge.port = port;
  return edge;
}

/** Validate and normalize a flow document. */
export function validateFlow(raw: unknown, opts: ValidateFlowOptions = {}): ValidateFlowResult {
  const c = new Ctx();
  if (!isObj(raw)) {
    c.err('flow.invalid', 'A flow must be a JSON object');
    return { issues: c.issues };
  }
  if (raw.format !== undefined && raw.format !== FLOW_FORMAT) {
    c.err('flow.format', `format must be "${FLOW_FORMAT}" (got "${toStr(raw.format)}")`, 'format', undefined, { format: toStr(raw.format) });
    return { issues: c.issues };
  }
  if (raw.version !== undefined && raw.version !== FLOW_VERSION) {
    c.err('flow.version', `This Dürbün reads flow version ${FLOW_VERSION} (got ${toStr(raw.version)}); update Dürbün`, 'version', undefined, { version: toStr(raw.version) });
    return { issues: c.issues };
  }
  if (!Array.isArray(raw.nodes)) {
    c.err('flow.nodes', 'nodes must be a list', 'nodes');
    return { issues: c.issues };
  }

  let name = toStr(raw.name).trim();
  if (!name) {
    name = 'Untitled flow';
    c.warn('flow.name.missing', 'The flow had no name', 'name');
  }
  let id = toStr(raw.id).trim();
  if (!id || !FLOW_ID_RE.test(id)) {
    const fixed = id ? fixFlowId(id) : opts.newFlowId ? opts.newFlowId(name) : slugifyFlowId(name);
    if (id) c.warn('flow.id.fixed', `Flow id "${id}" may only use a-z, 0-9, - and _; it is now "${fixed}"`, 'id', undefined, { from: id, to: fixed });
    id = fixed;
  }

  if (raw.nodes.length > MAX_FLOW_NODES) c.err('flow.nodes.tooMany', `A flow can have at most ${MAX_FLOW_NODES} nodes`, 'nodes', undefined, { max: MAX_FLOW_NODES });
  // Ids that are fixed (`get-cart` → `get_cart`): edges and templates that use them follow.
  const idMap = new Map<string, string>();
  for (const n of raw.nodes.slice(0, MAX_FLOW_NODES)) {
    const rawId = isObj(n) ? toStr(n.id) : '';
    if (rawId && !NODE_ID_RE.test(rawId)) idMap.set(rawId, fixNodeId(rawId));
  }
  const usedIds = new Set<string>();
  const nodes: FlowNode[] = [];
  raw.nodes.slice(0, MAX_FLOW_NODES).forEach((n, i) => {
    const node = normalizeNode(c, n, i, usedIds, idMap);
    if (node) nodes.push(node);
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const rawEdges = Array.isArray(raw.edges) ? raw.edges : raw.edges === undefined ? [] : null;
  if (rawEdges === null) c.err('flow.edges', 'edges must be a list', 'edges');
  if ((rawEdges?.length ?? 0) > MAX_FLOW_EDGES) c.err('flow.edges.tooMany', `A flow can have at most ${MAX_FLOW_EDGES} edges`, 'edges', undefined, { max: MAX_FLOW_EDGES });
  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  (rawEdges ?? []).slice(0, MAX_FLOW_EDGES).forEach((e, i) => {
    const edge = normalizeEdge(c, e, i, idMap);
    if (!edge) return;
    const path = `edges[${i}]`;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from) {
      c.err('flow.edge.unknownNode', `Edge from unknown node "${edge.from}"`, `${path}.from`, undefined, { node: edge.from });
      return;
    }
    if (!to) {
      c.err('flow.edge.unknownNode', `Edge to unknown node "${edge.to}"`, `${path}.to`, edge.from, { node: edge.to });
      return;
    }
    const port = edge.port ?? 'out';
    if (flowNodeSpec(from.type) && !flowNodePorts(from.type).includes(port)) {
      c.err('flow.edge.port', `${from.type} has no "${port}" port (ports: ${flowNodePorts(from.type).join(', ')})`, `${path}.port`, from.id, {
        port,
        ports: flowNodePorts(from.type).join(', '),
      });
      return;
    }
    if (flowNodeSpec(to.type) && !flowNodeSpec(to.type)!.acceptsInput) {
      c.err('flow.edge.intoTrigger', `"${to.id}" is a trigger; nothing can lead into it`, `${path}.to`, to.id, { node: to.id });
      return;
    }
    const key = `${edge.from}\u0000${port}\u0000${edge.to}`;
    if (seen.has(key)) {
      c.warn('flow.edge.duplicate', `Duplicate edge ${edge.from} → ${edge.to} removed`, path, edge.from, { from: edge.from, to: edge.to });
      return;
    }
    seen.add(key);
    edges.push(edge);
  });

  // Triggers: add a manual start when there is none, wired to every entry node.
  let triggers = nodes.filter((n) => flowNodeSpec(n.type)?.group === 'trigger');
  if (triggers.length === 0 && nodes.length > 0 && opts.addTrigger !== false) {
    const startId = newNodeId(usedIds, 'trigger.manual');
    usedIds.add(startId);
    const incoming = new Set(edges.map((e) => e.to));
    const entries = nodes.filter((n) => !incoming.has(n.id) && flowNodeSpec(n.type)?.acceptsInput !== false);
    nodes.unshift({ id: startId, type: 'trigger.manual' });
    for (const e of entries) edges.push({ from: startId, to: e.id });
    c.warn('flow.trigger.added', `The flow had no trigger; added "${startId}" (Manual start) before ${entries.map((e) => e.id).join(', ') || 'nothing'}`, 'nodes', startId, { id: startId });
    triggers = [nodes[0]!];
  } else if (triggers.length === 0) {
    c.err('flow.trigger.missing', 'A flow needs a trigger node (trigger.manual or trigger.event)', 'nodes');
  }

  // Template roots: node ids, reserved roots, helpers.
  nodes.forEach((n, i) => {
    const roots = collectTemplateRoots(n.params ?? {});
    for (const r of roots) {
      if (RESERVED_ROOTS.has(r) || byId.has(r)) continue;
      c.warn('flow.template.unknownRoot', `{{${r}…}} reads nothing: no node is called "${r}" (use a node id, vars, env, input, target, trigger or run)`, `nodes[${i}].params`, n.id, { root: r });
    }
    const spec = flowNodeSpec(n.type);
    if (n.type === 'flow.call') {
      const rawTarget = toStr(n.params?.flowId);
      const mapped = opts.flowIdMap?.get(rawTarget);
      if (mapped && n.params) n.params.flowId = mapped;
      const target = mapped ?? rawTarget;
      if (target && target === id) c.err('flow.call.self', 'A flow cannot call itself', `nodes[${i}].params.flowId`, n.id);
      else if (target && opts.knownFlowIds && !opts.knownFlowIds.has(target)) {
        c.warn('flow.call.unknown', `No flow with id "${target}" (import it too, or fix flowId)`, `nodes[${i}].params.flowId`, n.id, { flowId: target });
      }
    }
    if (spec?.group === 'trigger' && edges.every((e) => e.from !== n.id) && nodes.length > 1) {
      c.warn('flow.trigger.unconnected', `Trigger "${n.id}" leads nowhere`, `nodes[${i}]`, n.id);
    }
  });

  // Reachability.
  const reach = new Set<string>();
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const stack = triggers.map((t) => t.id);
  while (stack.length) {
    const cur = stack.pop()!;
    if (reach.has(cur)) continue;
    reach.add(cur);
    for (const next of out.get(cur) ?? []) stack.push(next);
  }
  nodes.forEach((n, i) => {
    if (!reach.has(n.id)) c.warn('flow.node.unreachable', `"${n.label ?? n.id}" is never reached from a trigger`, `nodes[${i}]`, n.id, { node: n.label ?? n.id });
  });

  const flow: FlowDoc = { format: FLOW_FORMAT, version: FLOW_VERSION, id, name: name.slice(0, 200), nodes, edges };
  if (raw.description !== undefined && raw.description !== '') flow.description = toStr(raw.description).slice(0, 5000);
  if (Array.isArray(raw.tags)) flow.tags = raw.tags.map(toStr).filter(Boolean).slice(0, 20);

  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs)) c.err('flow.inputs', 'inputs must be a list of { name, default?, description? }', 'inputs');
    else {
      const names = new Set<string>();
      flow.inputs = [];
      raw.inputs.forEach((v, i) => {
        if (!isObj(v)) return c.err('flow.inputs', 'An input must be { name, default?, description? }', `inputs[${i}]`);
        const n = toStr(v.name);
        if (!VAR_NAME_RE.test(n)) c.err('flow.input.name', `Input name "${n}" must be letters, digits or _`, `inputs[${i}].name`, undefined, { name: n });
        else reservedName(c, n, `inputs[${i}].name`);
        if (names.has(n)) c.err('flow.input.duplicate', `Two inputs are called "${n}"`, `inputs[${i}].name`, undefined, { name: n });
        names.add(n);
        const def: NonNullable<FlowDoc['inputs']>[number] = { name: n };
        if (v.description !== undefined) def.description = toStr(v.description);
        if (typeof v.default === 'string' || typeof v.default === 'number' || typeof v.default === 'boolean') def.default = v.default;
        if (v.required === true) def.required = true;
        if (v.secret === true) def.secret = true;
        flow.inputs!.push(def);
      });
    }
  }
  if (raw.outputs !== undefined) {
    if (!Array.isArray(raw.outputs)) c.err('flow.outputs', 'outputs must be a list of { name, value }', 'outputs');
    else {
      flow.outputs = [];
      raw.outputs.forEach((v, i) => {
        if (!isObj(v)) return c.err('flow.outputs', 'An output must be { name, value }', `outputs[${i}]`);
        const n = toStr(v.name);
        if (!VAR_NAME_RE.test(n)) c.err('flow.output.name', `Output name "${n}" must be letters, digits or _`, `outputs[${i}].name`, undefined, { name: n });
        else reservedName(c, n, `outputs[${i}].name`);
        let value = toStr(v.value);
        for (const [from, to] of idMap) value = renameTemplateRoot(value, from, to) as string;
        checkTemplates(c, value, `outputs[${i}].value`);
        const def: NonNullable<FlowDoc['outputs']>[number] = { name: n, value };
        if (v.description !== undefined) def.description = toStr(v.description);
        flow.outputs!.push(def);
      });
    }
  }
  if (isObj(raw.target)) {
    flow.target = {};
    const p = toStr(raw.target.platform);
    if (p) {
      if (['android', 'ios', 'other', 'any'].includes(p)) flow.target.platform = p as 'android';
      else c.warn('flow.target.platform', `target.platform must be android, ios or any (got "${p}")`, 'target.platform');
    }
    if (raw.target.appId) flow.target.appId = toStr(raw.target.appId);
  }
  if (isObj(raw.settings)) {
    flow.settings = {};
    if (raw.settings.onUnsupported === 'skip' || raw.settings.onUnsupported === 'fail') flow.settings.onUnsupported = raw.settings.onUnsupported;
    else if (raw.settings.onUnsupported !== undefined) c.warn('flow.settings.onUnsupported', 'settings.onUnsupported must be skip or fail', 'settings.onUnsupported');
    if (raw.settings.timeoutMs !== undefined) {
      const t = Number(raw.settings.timeoutMs);
      if (Number.isFinite(t) && t >= 1000 && t <= 24 * 3_600_000) flow.settings.timeoutMs = Math.round(t);
      else c.err('flow.settings.timeout', 'settings.timeoutMs must be between 1 000 and 86 400 000', 'settings.timeoutMs');
    }
    if (typeof raw.settings.recordRequests === 'boolean') flow.settings.recordRequests = raw.settings.recordRequests;
  }
  if (isObj(raw.automation)) {
    flow.automation = { enabled: raw.automation.enabled === true };
    const th = Number(raw.automation.throttleMs);
    if (raw.automation.throttleMs !== undefined && Number.isFinite(th) && th >= 1000) flow.automation.throttleMs = Math.round(th);
  }
  if (typeof raw.createdAt === 'number') flow.createdAt = raw.createdAt;
  if (typeof raw.updatedAt === 'number') flow.updatedAt = raw.updatedAt;

  if (flow.automation?.enabled && !nodes.some((n) => n.type === 'trigger.event')) {
    c.warn('flow.automation.noEvent', 'Automation is on but the flow has no "When something happens" trigger', 'automation');
  }
  return { flow, issues: c.issues };
}

export function hasErrors(issues: readonly FlowIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

/** List entry of a flow (without its last run). */
export function summarizeFlow(flow: FlowDoc, issues: readonly FlowIssue[] = []): FlowSummary {
  const triggers = new Set<'manual' | 'event'>();
  for (const n of flow.nodes) {
    if (n.type === 'trigger.manual') triggers.add('manual');
    if (n.type === 'trigger.event') triggers.add('event');
  }
  const calls = [...new Set(flow.nodes.filter((n) => n.type === 'flow.call' && typeof n.params?.flowId === 'string').map((n) => n.params!.flowId as string))];
  const s: FlowSummary = {
    id: flow.id,
    name: flow.name,
    nodeCount: flow.nodes.length,
    triggers: [...triggers],
    automation: !!flow.automation?.enabled,
    calls,
    issues: { errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level === 'warning').length },
  };
  if (flow.description) s.description = flow.description;
  if (flow.tags?.length) s.tags = flow.tags;
  if (flow.createdAt) s.createdAt = flow.createdAt;
  if (flow.updatedAt) s.updatedAt = flow.updatedAt;
  if (flow.target) s.target = flow.target;
  return s;
}

/** The effective value of a param: the node's, else the catalog default. */
export function paramOf(node: FlowNode, name: string, spec: FlowNodeSpec | undefined = flowNodeSpec(node.type)): unknown {
  const v = node.params?.[name];
  if (v !== undefined) return v;
  return spec?.params.find((p) => p.name === name)?.default;
}

/** Ids of flows a flow calls, directly. */
export function calledFlowIds(flow: FlowDoc): string[] {
  return [...new Set(flow.nodes.filter((n) => n.type === 'flow.call').map((n) => toStr(n.params?.flowId)).filter(Boolean))];
}
