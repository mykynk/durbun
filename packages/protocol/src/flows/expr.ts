/**
 * Condition rules (logic.condition, logic.repeat `until`, check.assert). No code is evaluated: a rule is
 * `left op right`, both sides templates or literals, compared with these operators.
 */
import { resolveTemplate, type ResolveOptions, type TemplateScope } from './template';
import type { FlowConditionOp, FlowConditionRule } from './types';

export const FLOW_CONDITION_OPS: readonly { op: FlowConditionOp; label: string; unary?: boolean }[] = [
  { op: 'equals', label: 'equals' },
  { op: 'notEquals', label: 'does not equal' },
  { op: 'contains', label: 'contains' },
  { op: 'notContains', label: 'does not contain' },
  { op: 'startsWith', label: 'starts with' },
  { op: 'endsWith', label: 'ends with' },
  { op: 'matches', label: 'matches regex' },
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'in', label: 'is one of (comma-separated)' },
  { op: 'exists', label: 'exists', unary: true },
  { op: 'notExists', label: 'does not exist', unary: true },
  { op: 'isEmpty', label: 'is empty', unary: true },
  { op: 'isNotEmpty', label: 'is not empty', unary: true },
  { op: 'isTrue', label: 'is true', unary: true },
  { op: 'isFalse', label: 'is false', unary: true },
];

export const UNARY_OPS: ReadonlySet<FlowConditionOp> = new Set(FLOW_CONDITION_OPS.filter((o) => o.unary).map((o) => o.op));

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** A canonical decimal: "0", "-12", "3.5" — no leading zeros ("007"), hex ("0x10") or exponent ("1e3"). */
const CANONICAL_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** The number an equality compares, when the value is (or is written as) a canonical decimal. */
function asEqualityNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && CANONICAL_DECIMAL.test(v.trim())) return Number(v.trim());
  return undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  return undefined;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
  return v === true || v === 1;
}

/**
 * Loose equality: canonical decimals compare as numbers ("200" equals 200, "1.50" equals 1.5), objects as JSON,
 * everything else as exact text ("007" does not equal "7", "0x10" not "16").
 */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = asEqualityNumber(a);
  const nb = asEqualityNumber(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = asBoolean(a);
    const y = asBoolean(b);
    return x !== undefined && x === y;
  }
  if ((a === null || a === undefined) && (b === '' || b === 'null' || b === undefined || b === null)) return true;
  if ((b === null || b === undefined) && (a === '' || a === 'null')) return true;
  return text(a) === text(b);
}

export interface RuleResult {
  ok: boolean;
  left: unknown;
  right?: unknown;
  /** English explanation when it did not hold ("401 does not equal 200"). */
  explain: string;
}

/** Compare already-resolved values. */
export function compareValues(left: unknown, op: FlowConditionOp, right: unknown): boolean {
  switch (op) {
    case 'equals':
      return looseEquals(left, right);
    case 'notEquals':
      return !looseEquals(left, right);
    case 'contains':
      return Array.isArray(left) ? left.some((x) => looseEquals(x, right)) : text(left).includes(text(right));
    case 'notContains':
      return Array.isArray(left) ? !left.some((x) => looseEquals(x, right)) : !text(left).includes(text(right));
    case 'startsWith':
      return text(left).startsWith(text(right));
    case 'endsWith':
      return text(left).endsWith(text(right));
    case 'matches':
      try {
        return new RegExp(text(right)).test(text(left));
      } catch {
        return false;
      }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(left);
      const b = asNumber(right);
      if (a === undefined || b === undefined) {
        const c = text(left).localeCompare(text(right));
        return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0;
      }
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'in': {
      const list = Array.isArray(right) ? right : text(right).split(',').map((s) => s.trim());
      return list.some((x) => looseEquals(left, x));
    }
    case 'exists':
      return left !== undefined && left !== null;
    case 'notExists':
      return left === undefined || left === null;
    case 'isEmpty':
      return isEmptyValue(left);
    case 'isNotEmpty':
      return !isEmptyValue(left);
    case 'isTrue':
      return truthy(left);
    case 'isFalse':
      return !truthy(left);
    default:
      return false;
  }
}

function short(v: unknown): string {
  const s = v === undefined ? 'nothing' : text(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Resolve both sides and evaluate one rule. Template errors throw (TemplateError). */
export function evaluateRule(rule: FlowConditionRule, scope: TemplateScope, opts: ResolveOptions = {}): RuleResult {
  const left = typeof rule.left === 'string' ? resolveTemplate(rule.left, scope, opts) : rule.left;
  const unary = UNARY_OPS.has(rule.op);
  const right = unary ? undefined : typeof rule.right === 'string' ? resolveTemplate(rule.right, scope, opts) : rule.right;
  const ok = compareValues(left, rule.op, right);
  const label = FLOW_CONDITION_OPS.find((o) => o.op === rule.op)?.label ?? rule.op;
  const explain = ok ? '' : unary ? `${short(left)} — expected it to ${label.replace(/^is /, 'be ').replace(/^does not /, 'not ')}` : `${short(left)} — expected ${label} ${short(right)}`;
  return unary ? { ok, left, explain } : { ok, left, right, explain };
}

export function evaluateRules(rules: readonly FlowConditionRule[], mode: 'all' | 'any', scope: TemplateScope, opts: ResolveOptions = {}): { ok: boolean; results: RuleResult[] } {
  const results = rules.map((r) => evaluateRule(r, scope, opts));
  if (results.length === 0) return { ok: mode === 'all', results };
  const ok = mode === 'any' ? results.some((r) => r.ok) : results.every((r) => r.ok);
  return { ok, results };
}

/** Does an HTTP status match '2xx', '200', '200,201', '200-299', '4xx,500'? Empty = any. */
export function statusMatches(status: number | undefined, spec: string | undefined): boolean {
  const s = (spec ?? '').trim();
  if (!s) return true;
  if (status === undefined) return false;
  return s.split(',').some((part) => {
    const p = part.trim().toLowerCase();
    if (!p) return false;
    if (/^\dxx$/.test(p)) return Math.floor(status / 100) === Number(p[0]);
    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(p);
    if (range) return status >= Number(range[1]) && status <= Number(range[2]);
    return /^\d{3}$/.test(p) && status === Number(p);
  });
}

/** Is a status filter well formed? */
export function isStatusSpec(spec: string): boolean {
  const s = spec.trim();
  if (!s) return true;
  return s.split(',').every((part) => /^\s*(\dxx|\d{3}|\d{3}\s*-\s*\d{3})\s*$/i.test(part));
}

/** URL matching with the mock-rule semantics (contains / exact / glob case-insensitive; regex as written). */
export function urlMatches(url: string, pattern: string, match: string): boolean {
  const u = url.toLowerCase();
  const p = pattern.toLowerCase();
  switch (match) {
    case 'exact':
      return u === p;
    case 'glob': {
      const re = '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      return new RegExp(re).test(u);
    }
    case 'regex':
      try {
        return new RegExp(pattern).test(url);
      } catch {
        return false;
      }
    case 'contains':
    default:
      return p.length > 0 && u.includes(p);
  }
}
