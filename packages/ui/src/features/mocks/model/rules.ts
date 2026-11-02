import type { Header, MockAction, MockRule, NetworkEntry, UrlMatchType } from '@durbun/protocol';
import type { MockRuleDraft } from '../../../data';
import { getLanguage, type Lang, type TFunction } from '../../../i18n';
import { formatShortDuration } from './format';

/**
 * Mock rule logic shared by the Mocks view and the Network view: editor form ↔ rule conversion,
 * validation, action summaries, ordering, master switch, import/export and hit counts. Pure.
 */

export const MATCH_TYPES: readonly UrlMatchType[] = ['contains', 'exact', 'glob', 'regex'];
export const FAIL_ERRORS = ['timeout', 'connection', 'dns', 'tls', 'custom'] as const;
export type FailError = (typeof FAIL_ERRORS)[number];
export type ActionType = MockAction['type'];
export const ACTION_TYPES: readonly ActionType[] = ['respond', 'delay', 'fail'];
export const STATUS_PRESETS: readonly number[] = [200, 201, 204, 301, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503];
export const DELAY_PRESETS: readonly number[] = [300, 1000, 3000, 10_000];
export const METHOD_OPTIONS: readonly string[] = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const CONTENT_TYPE_PRESETS: readonly string[] = [
  'application/json; charset=utf-8',
  'text/plain; charset=utf-8',
  'text/html; charset=utf-8',
  'application/xml',
  'application/x-www-form-urlencoded',
  'application/octet-stream',
  'image/png',
  'image/jpeg',
];
/** Server limit (config.ts MAX_DELAY_MS). */
export const MAX_DELAY_MS = 600_000;
export const MAX_RULES = 1000;

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;

let idSeq = 0;
/** Client-side rule id (the server keeps valid ids). */
export function newRuleId(now = Date.now()): string {
  idSeq = (idSeq + 1) % 1_000_000;
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `mock-${now.toString(36)}-${rand}${idSeq.toString(36)}`;
}

/* ───────────── Header rows (shared with the network replay editor) ───────────── */

export interface HeaderRow {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

let rowSeq = 0;
export function headerRow(name = '', value = '', enabled = true): HeaderRow {
  return { id: `h${++rowSeq}`, name, value, enabled };
}

export function rowsFromHeaders(headers: readonly Header[] | undefined): HeaderRow[] {
  return (headers ?? []).map(([n, v]) => headerRow(n, v));
}

/** Enabled rows with a name, as protocol headers. */
export function headersFromRows(rows: readonly HeaderRow[]): Header[] {
  return rows.filter((r) => r.enabled && r.name.trim()).map((r) => [r.name.trim(), r.value] as Header);
}

export function isValidHeaderName(name: string): boolean {
  return TOKEN_RE.test(name);
}

/* ───────────── Editor form ───────────── */

export interface RuleForm {
  enabled: boolean;
  name: string;
  method: string;
  url: string;
  match: UrlMatchType;
  /** Bundle ids; empty = all apps. */
  apps: string[];
  type: ActionType;
  status: string;
  headers: HeaderRow[];
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  respondDelayMs: string;
  delayMs: string;
  failError: FailError;
  failMessage: string;
  failDelayMs: string;
}

export function emptyForm(): RuleForm {
  return {
    enabled: true,
    name: '',
    method: '*',
    url: '',
    match: 'contains',
    apps: [],
    type: 'respond',
    status: '200',
    headers: [headerRow('content-type', 'application/json; charset=utf-8')],
    body: '',
    bodyEncoding: 'utf8',
    respondDelayMs: '',
    delayMs: '1000',
    failError: 'timeout',
    failMessage: '',
    failDelayMs: '',
  };
}

export function ruleToForm(rule: MockRule | MockRuleDraft): RuleForm {
  const f = emptyForm();
  f.enabled = rule.enabled;
  f.name = rule.name ?? '';
  f.method = rule.method && rule.method !== '*' ? rule.method.toUpperCase() : '*';
  f.url = rule.url;
  f.match = rule.match;
  f.apps = [...(rule.apps ?? [])];
  const a = rule.action;
  f.type = a.type;
  if (a.type === 'respond') {
    f.status = String(a.status);
    f.headers = rowsFromHeaders(a.headers);
    f.body = a.body ?? '';
    f.bodyEncoding = a.bodyEncoding === 'base64' ? 'base64' : 'utf8';
    f.respondDelayMs = a.delayMs ? String(a.delayMs) : '';
  } else if (a.type === 'delay') {
    f.delayMs = String(a.delayMs);
  } else {
    f.failError = a.error;
    f.failMessage = a.message ?? '';
    f.failDelayMs = a.delayMs ? String(a.delayMs) : '';
  }
  return f;
}

export type FormField = 'name' | 'url' | 'method' | 'status' | 'headers' | 'body' | 'respondDelayMs' | 'delayMs' | 'failDelayMs' | 'failMessage' | 'apps';

export interface FormIssue {
  field: FormField;
  /** i18n key suffix under `mocks.validation.` */
  code: string;
  params?: Record<string, string | number>;
}

function parseDelay(s: string): number | null {
  const t = s.trim();
  if (t === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t));
}

export function regexError(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function jsonContentType(rows: readonly HeaderRow[]): boolean {
  const ct = rows.find((r) => r.enabled && r.name.trim().toLowerCase() === 'content-type')?.value ?? '';
  return /json/i.test(ct);
}

/** Errors block saving; warnings are shown but allowed. */
export function validateForm(form: RuleForm): { errors: FormIssue[]; warnings: FormIssue[] } {
  const errors: FormIssue[] = [];
  const warnings: FormIssue[] = [];
  const url = form.url;
  if (!url.trim()) errors.push({ field: 'url', code: 'urlRequired' });
  else if (url.length > 8192) errors.push({ field: 'url', code: 'urlTooLong' });
  else if (form.match === 'regex') {
    const err = regexError(url);
    if (err) errors.push({ field: 'url', code: 'regexInvalid', params: { message: err } });
  } else if (form.match === 'contains' && url.trim().length < 3) {
    warnings.push({ field: 'url', code: 'containsShort' });
  } else if (form.match === 'glob' && !/[*?]/.test(url)) {
    warnings.push({ field: 'url', code: 'globNoWildcard' });
  }
  if (url !== url.trim() && url.trim()) warnings.push({ field: 'url', code: 'urlSpaces' });
  const method = form.method.trim();
  if (method !== '*' && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(method)) errors.push({ field: 'method', code: 'methodInvalid' });

  const checkDelay = (field: FormField, value: string) => {
    const d = parseDelay(value);
    if (d === null) errors.push({ field, code: 'delayInvalid' });
    else if (d > MAX_DELAY_MS) errors.push({ field, code: 'delayTooLong', params: { max: MAX_DELAY_MS / 60_000 } });
  };

  if (form.type === 'respond') {
    const st = form.status.trim();
    const n = Number(st);
    if (!/^\d{3}$/.test(st) || n < 100 || n > 599) errors.push({ field: 'status', code: 'statusInvalid' });
    const bad = form.headers.find((r) => r.enabled && r.name.trim() && !isValidHeaderName(r.name.trim()));
    if (bad) errors.push({ field: 'headers', code: 'headerNameInvalid', params: { name: bad.name.trim() } });
    const missingName = form.headers.find((r) => r.enabled && !r.name.trim() && r.value.trim());
    if (missingName) errors.push({ field: 'headers', code: 'headerNameMissing' });
    if (form.bodyEncoding === 'base64' && form.body && !BASE64_RE.test(form.body)) errors.push({ field: 'body', code: 'base64Invalid' });
    if (form.bodyEncoding === 'utf8' && form.body.trim() && jsonContentType(form.headers)) {
      try {
        JSON.parse(form.body);
      } catch (err) {
        warnings.push({ field: 'body', code: 'jsonInvalid', params: { message: err instanceof Error ? err.message : String(err) } });
      }
    }
    if ((n === 204 || n === 304) && form.body.trim()) warnings.push({ field: 'body', code: 'bodyIgnored', params: { status: n } });
    checkDelay('respondDelayMs', form.respondDelayMs);
  } else if (form.type === 'delay') {
    if (!form.delayMs.trim()) errors.push({ field: 'delayMs', code: 'delayRequired' });
    else checkDelay('delayMs', form.delayMs);
  } else {
    checkDelay('failDelayMs', form.failDelayMs);
    if (form.failError === 'custom' && !form.failMessage.trim()) warnings.push({ field: 'failMessage', code: 'customMessage' });
  }
  return { errors, warnings };
}

/** Rule from a (valid) form. `base` keeps id/createdAt of an existing rule. */
export function formToRule(form: RuleForm, base: { id: string; createdAt: number }): MockRule {
  let action: MockAction;
  if (form.type === 'respond') {
    const headers = headersFromRows(form.headers);
    const delay = parseDelay(form.respondDelayMs) ?? 0;
    action = { type: 'respond', status: Number(form.status.trim()) };
    if (headers.length > 0) action.headers = headers;
    if (form.body !== '') {
      action.body = form.bodyEncoding === 'base64' ? form.body.replace(/\s+/g, '') : form.body;
      action.bodyEncoding = form.bodyEncoding;
    }
    if (delay > 0) action.delayMs = delay;
  } else if (form.type === 'delay') {
    action = { type: 'delay', delayMs: parseDelay(form.delayMs) ?? 0 };
  } else {
    action = { type: 'fail', error: form.failError };
    if (form.failMessage.trim()) action.message = form.failMessage.trim();
    const delay = parseDelay(form.failDelayMs) ?? 0;
    if (delay > 0) action.delayMs = delay;
  }
  const rule: MockRule = {
    id: base.id,
    enabled: form.enabled,
    method: form.method.trim() === '*' || !form.method.trim() ? '*' : form.method.trim().toUpperCase(),
    url: form.match === 'regex' ? form.url : form.url.trim(),
    match: form.match,
    action,
    createdAt: base.createdAt,
  };
  if (form.name.trim()) rule.name = form.name.trim();
  if (form.apps.length > 0) rule.apps = [...new Set(form.apps)];
  return rule;
}

/** Comparable snapshot of a form (header row ids ignored) for dirty checks. */
export function formSignature(form: RuleForm): string {
  return JSON.stringify({ ...form, headers: form.headers.map((h) => [h.name, h.value, h.enabled]) });
}

/* ───────────── Summaries ───────────── */

/** Short body type for summaries: JSON, HTML, XML, Text, PNG, Binary… (null when there is no body). */
export function bodyTypeLabel(action: Extract<MockAction, { type: 'respond' }>): string | null {
  if (!action.body) return null;
  const ct = (action.headers?.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? '').toLowerCase();
  if (ct.includes('json')) return 'JSON';
  if (ct.includes('html')) return 'HTML';
  if (ct.includes('xml')) return 'XML';
  if (ct.startsWith('image/')) return ct.slice(6).split(/[;+]/)[0]!.toUpperCase();
  if (ct.startsWith('text/')) return 'TEXT';
  if (action.bodyEncoding === 'base64' || ct.includes('octet-stream')) return 'BINARY';
  return ct ? ct.split(';')[0]!.split('/').pop()!.toUpperCase() : 'TEXT';
}

/** "200 · JSON · 300 ms", "Gecikme 2 sn", "Hata: zaman aşımı" (localized through `t`). */
export function actionSummary(action: MockAction, t: TFunction, lang: Lang = getLanguage()): string {
  const dur = (ms: number) => formatShortDuration(ms, lang);
  if (action.type === 'respond') {
    const parts = [String(action.status)];
    const type = bodyTypeLabel(action);
    if (type) parts.push(type === 'TEXT' ? t('mocks.summary.text') : type === 'BINARY' ? t('mocks.summary.binary') : type);
    else parts.push(t('mocks.summary.noBody'));
    if (action.delayMs) parts.push(dur(action.delayMs));
    return parts.join(' · ');
  }
  if (action.type === 'delay') return t('mocks.summary.delay', { duration: dur(action.delayMs) });
  const what = action.error === 'custom' && action.message ? truncate(action.message, 48) : t(`mocks.errors.${action.error}`);
  const base = t('mocks.summary.fail', { error: what });
  return action.delayMs ? `${base} · ${dur(action.delayMs)}` : base;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ───────────── Ordering ───────────── */

/** Move the item at `from` so that it ends up at index `to` (indexes of the resulting list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list.slice();
  const out = list.slice();
  const [item] = out.splice(from, 1);
  const target = Math.max(0, Math.min(out.length, to));
  out.splice(target, 0, item as T);
  return out;
}

/** Final index for a drag of `from` dropped before/after the row at `over`. */
export function dropTarget(from: number, over: number, position: 'before' | 'after'): number {
  let to = position === 'before' ? over : over + 1;
  if (from < to) to -= 1;
  return to;
}

/** Move a rule one step up (-1) or down (+1); unchanged list when it cannot move. */
export function moveRuleBy(rules: readonly MockRule[], id: string, delta: -1 | 1): MockRule[] {
  const from = rules.findIndex((r) => r.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= rules.length) return rules.slice();
  return moveItem(rules, from, to);
}

/** Copy of a rule inserted right after it (new id, disabled copies stay disabled). */
export function duplicateRule(rules: readonly MockRule[], id: string, opts: { id: string; now: number; nameSuffix: string }): MockRule[] {
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) return rules.slice();
  const src = rules[i]!;
  const copy: MockRule = structuredCloneRule(src);
  copy.id = opts.id;
  copy.createdAt = opts.now;
  copy.name = `${src.name || `${src.method === '*' ? '' : `${src.method} `}${src.url}`}${opts.nameSuffix}`.trim();
  const out = rules.slice();
  out.splice(i + 1, 0, copy);
  return out;
}

function structuredCloneRule(r: MockRule): MockRule {
  return JSON.parse(JSON.stringify(r)) as MockRule;
}

/* ───────────── Master switch ───────────── */

/** Disable every rule, remembering which were enabled. */
export function disableAll(rules: readonly MockRule[]): { rules: MockRule[]; remembered: string[] } {
  return { rules: rules.map((r) => (r.enabled ? { ...r, enabled: false } : r)), remembered: rules.filter((r) => r.enabled).map((r) => r.id) };
}

/** Re-enable the remembered rules (all rules when nothing remembered still exists). */
export function restoreEnabled(rules: readonly MockRule[], remembered: readonly string[]): MockRule[] {
  const keep = new Set(remembered.filter((id) => rules.some((r) => r.id === id)));
  if (keep.size === 0) return rules.map((r) => (r.enabled ? r : { ...r, enabled: true }));
  return rules.map((r) => (keep.has(r.id) && !r.enabled ? { ...r, enabled: true } : r));
}

/* ───────────── Hit counts ───────────── */

/** Requests answered by each rule (`mocked && mockRuleId`). */
export function hitCounts(entries: Iterable<NetworkEntry>): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (!e.mocked || !e.mockRuleId) continue;
    out.set(e.mockRuleId, (out.get(e.mockRuleId) ?? 0) + 1);
  }
  return out;
}

/* ───────────── Import / export ───────────── */

export interface MocksFile {
  format: 'durbun-mocks';
  version: 1;
  exportedAt: number;
  rules: MockRule[];
}

export function exportRules(rules: readonly MockRule[], now = Date.now()): string {
  const file: MocksFile = { format: 'durbun-mocks', version: 1, exportedAt: now, rules: rules.map(structuredCloneRule) };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export interface ImportIssue {
  /** 1-based rule number in the file (0 = the file itself). */
  index: number;
  code: string;
  params?: Record<string, string | number>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Validate one imported rule (mirrors the server's validation, with i18n-friendly issue codes). */
export function normalizeImportedRule(raw: unknown, index: number, now: number): { rule: MockRule } | { issue: ImportIssue } {
  const bad = (code: string, params?: Record<string, string | number>) => ({ issue: { index, code, params } });
  if (!isObj(raw)) return bad('notObject');
  if (typeof raw.url !== 'string' || !raw.url.trim()) return bad('urlRequired');
  const match = (raw.match ?? 'contains') as UrlMatchType;
  if (!MATCH_TYPES.includes(match)) return bad('matchInvalid');
  if (match === 'regex' && regexError(raw.url)) return bad('regexInvalid');
  const method = typeof raw.method === 'string' && raw.method.trim() ? raw.method.trim() : '*';
  if (method !== '*' && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(method)) return bad('methodInvalid');
  if (raw.apps !== undefined && raw.apps !== null && (!Array.isArray(raw.apps) || raw.apps.some((a) => typeof a !== 'string'))) return bad('appsInvalid');
  const a = raw.action;
  if (!isObj(a)) return bad('actionInvalid');
  const delay = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_DELAY_MS, Math.round(n)) : undefined;
  };
  let action: MockAction;
  if (a.type === 'respond') {
    const status = Number(a.status ?? 200);
    if (!Number.isInteger(status) || status < 100 || status > 599) return bad('statusInvalid');
    const headers: Header[] = [];
    if (a.headers !== undefined && a.headers !== null) {
      if (!Array.isArray(a.headers)) return bad('headersInvalid');
      for (const h of a.headers) {
        if (!Array.isArray(h) || typeof h[0] !== 'string' || (typeof h[1] !== 'string' && typeof h[1] !== 'number')) return bad('headersInvalid');
        if (h[0].trim()) headers.push([h[0].trim(), String(h[1])]);
      }
    }
    if (a.body !== undefined && a.body !== null && typeof a.body !== 'string') return bad('bodyInvalid');
    const enc = a.bodyEncoding === 'base64' ? 'base64' : 'utf8';
    if (typeof a.body === 'string' && enc === 'base64' && !BASE64_RE.test(a.body)) return bad('base64Invalid');
    action = { type: 'respond', status };
    if (headers.length) action.headers = headers;
    if (typeof a.body === 'string') {
      action.body = a.body;
      action.bodyEncoding = enc;
    }
    const d = delay(a.delayMs);
    if (d) action.delayMs = d;
  } else if (a.type === 'delay') {
    const n = Number(a.delayMs);
    if (!Number.isFinite(n) || n < 0) return bad('delayInvalid');
    action = { type: 'delay', delayMs: Math.min(MAX_DELAY_MS, Math.round(n)) };
  } else if (a.type === 'fail') {
    const error = (a.error ?? 'connection') as FailError;
    if (!FAIL_ERRORS.includes(error)) return bad('failInvalid');
    action = { type: 'fail', error };
    if (typeof a.message === 'string' && a.message.trim()) action.message = a.message.trim().slice(0, 2000);
    const d = delay(a.delayMs);
    if (d) action.delayMs = d;
  } else return bad('actionInvalid');
  const rule: MockRule = {
    id: typeof raw.id === 'string' && raw.id.trim() && raw.id.length <= 200 ? raw.id.trim() : newRuleId(now),
    enabled: raw.enabled !== false,
    method: method === '*' ? '*' : method.toUpperCase(),
    url: raw.url,
    match,
    action,
    createdAt: Number.isFinite(Number(raw.createdAt)) && Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now,
  };
  if (typeof raw.name === 'string' && raw.name.trim()) rule.name = raw.name.trim().slice(0, 200);
  const apps = Array.isArray(raw.apps) ? [...new Set((raw.apps as string[]).map((s) => s.trim()).filter(Boolean))] : [];
  if (apps.length) rule.apps = apps;
  return { rule };
}

/** Parse an exported file (`{format:'durbun-mocks', rules}`) or a plain rule array. */
export function parseRulesFile(text: string, now = Date.now()): { rules: MockRule[]; issues: ImportIssue[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { rules: [], issues: [{ index: 0, code: 'notJson' }] };
  }
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.rules) ? data.rules : null;
  if (!list) return { rules: [], issues: [{ index: 0, code: 'noRules' }] };
  const rules: MockRule[] = [];
  const issues: ImportIssue[] = [];
  list.forEach((raw, i) => {
    const r = normalizeImportedRule(raw, i + 1, now);
    if ('rule' in r) rules.push(r.rule);
    else issues.push(r.issue);
  });
  if (list.length === 0) issues.push({ index: 0, code: 'noRules' });
  return { rules, issues };
}

/** Combine imported rules with the current list; duplicate ids get fresh ids. */
export function mergeImported(existing: readonly MockRule[], imported: readonly MockRule[], mode: 'append' | 'replace', now = Date.now()): MockRule[] {
  const base = mode === 'replace' ? [] : existing.slice();
  const ids = new Set(base.map((r) => r.id));
  for (const r of imported) {
    const id = ids.has(r.id) ? newRuleId(now) : r.id;
    ids.add(id);
    base.push(id === r.id ? r : { ...r, id });
  }
  return base.slice(0, MAX_RULES);
}

/** Readable label for a rule (name, else "GET …/pets"). */
export function ruleLabel(rule: Pick<MockRule, 'name' | 'method' | 'url'>): string {
  return rule.name || `${rule.method === '*' ? '' : `${rule.method} `}${rule.url}`;
}
