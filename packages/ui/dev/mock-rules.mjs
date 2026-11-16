/**
 * The mock rule list of the dev mock server, saved the way the real server saves it (server config.ts
 * `validateMockRules` / `setMocks`, http/commands.ts `mocks.set`): every rule is validated and normalized (method in
 * upper case, conditions checked, ids made unique), one bad rule refuses the whole list with `config.invalid`, and a
 * save from an older revision is refused with `mocks.conflict`. `packages/server/test/http/mocksContract.test.ts`
 * compares these answers with the real server's.
 */

const MATCH_TYPES = ['contains', 'exact', 'glob', 'regex'];
const FAIL_ERRORS = ['timeout', 'connection', 'dns', 'tls', 'custom'];
const METHOD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const BASE64_RE = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;
const MAX_MOCK_RULES = 1_000;
const MAX_DELAY_MS = 10 * 60 * 1000;
// @durbun/protocol GRAPHQL_NAME_RE, MAX_GRAPHQL_OPERATION_NAME, GRAPHQL_OPERATION_TYPES, MOCK_MATCHERS.
const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;
const MAX_GRAPHQL_OPERATION_NAME = 128;
const GRAPHQL_OPERATION_TYPES = ['query', 'mutation', 'subscription'];
const MOCK_MATCHERS = ['graphql'];
const FLOW_RULE_PREFIX = 'flow-';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (problem, field, expected, extra) => ({ ok: false, problem, field, expected, ...(extra ? { extra } : {}) });
let idSeq = 0;
const newMockRuleId = () => `mock-${Date.now().toString(36)}-${(++idSeq).toString(16).padStart(6, '0')}`;

function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toBoolean(raw) {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function optionalString(v, max) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function clampDelay(v) {
  const n = toNumber(v);
  if (n === undefined) return undefined;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(n)));
}

function validateHeaders(v, where) {
  if (v === undefined || v === null) return { ok: true };
  if (!Array.isArray(v)) return bad(`${where}: headers must be a list of [name, value] pairs`, 'headers', 'headerList');
  const headers = [];
  for (const h of v) {
    if (Array.isArray(h) && h.length >= 2 && typeof h[0] === 'string' && (typeof h[1] === 'string' || typeof h[1] === 'number')) {
      const name = h[0].trim();
      if (name) headers.push([name, String(h[1])]);
    } else if (isPlainObject(h) && typeof h.name === 'string' && (typeof h.value === 'string' || typeof h.value === 'number')) {
      const name = h.name.trim();
      if (name) headers.push([name, String(h.value)]);
    } else {
      return bad(`${where}: invalid header ${JSON.stringify(h)}`, 'headers', 'headerList');
    }
  }
  return { ok: true, headers };
}

function validateAction(raw, where) {
  if (!isPlainObject(raw)) return bad(`${where}: action is missing`, 'action', 'required');
  switch (raw.type) {
    case 'respond': {
      const status = toNumber(raw.status ?? 200);
      if (status === undefined || !Number.isInteger(status) || status < 100 || status > 599) {
        return bad(`${where}: status must be an integer between 100 and 599`, 'status', 'range', { min: 100, max: 599 });
      }
      const h = validateHeaders(raw.headers, where);
      if (!h.ok) return h;
      if (raw.body !== undefined && raw.body !== null && typeof raw.body !== 'string') return bad(`${where}: body must be a string`, 'body', 'text');
      const bodyEncoding = raw.bodyEncoding === 'base64' ? 'base64' : 'utf8';
      if (raw.bodyEncoding !== undefined && raw.bodyEncoding !== 'utf8' && raw.bodyEncoding !== 'base64') {
        return bad(`${where}: bodyEncoding must be utf8 or base64`, 'bodyEncoding', 'oneOf', { options: 'utf8, base64' });
      }
      const body = typeof raw.body === 'string' ? raw.body : undefined;
      if (body !== undefined && bodyEncoding === 'base64' && !BASE64_RE.test(body)) return bad(`${where}: body is not valid base64`, 'body', 'base64');
      const action = { type: 'respond', status };
      if (h.headers) action.headers = h.headers;
      if (body !== undefined) {
        action.body = body;
        action.bodyEncoding = bodyEncoding;
      }
      const delayMs = clampDelay(raw.delayMs);
      if (delayMs) action.delayMs = delayMs;
      return { ok: true, action };
    }
    case 'delay': {
      const delayMs = clampDelay(raw.delayMs);
      if (delayMs === undefined) return bad(`${where}: delayMs must be a number`, 'delayMs', 'number');
      return { ok: true, action: { type: 'delay', delayMs } };
    }
    case 'fail': {
      const error = raw.error ?? 'connection';
      if (typeof error !== 'string' || !FAIL_ERRORS.includes(error)) {
        return bad(`${where}: error must be one of ${FAIL_ERRORS.join(', ')}`, 'error', 'oneOf', { options: FAIL_ERRORS.join(', ') });
      }
      const action = { type: 'fail', error };
      const message = optionalString(raw.message, 2_000);
      if (message) action.message = message;
      const delayMs = clampDelay(raw.delayMs);
      if (delayMs) action.delayMs = delayMs;
      return { ok: true, action };
    }
    default:
      return bad(`${where}: action type must be respond, delay or fail`, 'action', 'oneOf', { options: 'respond, delay, fail' });
  }
}

/** `when`: an unknown condition is refused (dropping it would widen the rule). */
function validateConditions(raw, where) {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isPlainObject(raw)) return bad(`${where}: when must be an object`, 'when', 'object');
  const when = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (key !== 'graphql') {
      return bad(`${where}: unknown condition "${key.slice(0, 60)}" (this version of Dürbün knows: ${MOCK_MATCHERS.join(', ')})`, `when.${key.slice(0, 60)}`, 'unknownCondition');
    }
    if (!isPlainObject(value)) return bad(`${where}: when.graphql must be an object`, 'when.graphql', 'object');
    const name = typeof value.operationName === 'string' ? value.operationName.trim() : value.operationName;
    if (typeof name !== 'string' || name === '') return bad(`${where}: the GraphQL operation name is missing`, 'when.graphql.operationName', 'required');
    if (name.length > MAX_GRAPHQL_OPERATION_NAME) {
      return bad(`${where}: the GraphQL operation name is longer than ${MAX_GRAPHQL_OPERATION_NAME} characters`, 'when.graphql.operationName', 'maxLength', { max: MAX_GRAPHQL_OPERATION_NAME });
    }
    if (!GRAPHQL_NAME_RE.test(name)) {
      return bad(`${where}: "${name.slice(0, 60)}" is not a GraphQL operation name (letters, digits and _; not starting with a digit)`, 'when.graphql.operationName', 'graphqlName');
    }
    const type = value.operationType;
    if (type !== undefined && type !== null && type !== '' && !GRAPHQL_OPERATION_TYPES.includes(type)) {
      return bad(`${where}: the GraphQL operation type must be one of ${GRAPHQL_OPERATION_TYPES.join(', ')}`, 'when.graphql.operationType', 'oneOf', { options: GRAPHQL_OPERATION_TYPES.join(', ') });
    }
    when.graphql = typeof type === 'string' && type !== '' ? { operationName: name, operationType: type } : { operationName: name };
  }
  return Object.keys(when).length > 0 ? { ok: true, when } : { ok: true };
}

export function validateMockRule(raw, index = 0, now = Date.now()) {
  const where = `rule #${index + 1}`;
  if (!isPlainObject(raw)) return bad(`${where}: must be an object`, 'rule', 'object');
  const label = typeof raw.name === 'string' && raw.name.trim() ? `${where} (${raw.name.trim().slice(0, 60)})` : where;
  if (typeof raw.url !== 'string') return bad(`${label}: url must be a string`, 'url', 'text');
  if (raw.url.length > 8_192) return bad(`${label}: url is too long`, 'url', 'maxLength', { max: 8_192 });
  const methodRaw = typeof raw.method === 'string' ? raw.method.trim() : raw.method === undefined ? '*' : null;
  if (methodRaw === null || (methodRaw !== '*' && methodRaw !== '' && !METHOD_RE.test(methodRaw))) {
    return bad(`${label}: method must be '*' or an HTTP method`, 'method', 'httpMethod');
  }
  const match = raw.match ?? 'contains';
  if (typeof match !== 'string' || !MATCH_TYPES.includes(match)) return bad(`${label}: match must be one of ${MATCH_TYPES.join(', ')}`, 'match', 'oneOf', { options: MATCH_TYPES.join(', ') });
  let apps;
  if (raw.apps !== undefined && raw.apps !== null) {
    if (!Array.isArray(raw.apps) || raw.apps.some((a) => typeof a !== 'string')) return bad(`${label}: apps must be a list of app ids`, 'apps', 'appIdList');
    apps = [...new Set(raw.apps.map((a) => a.trim()).filter(Boolean))];
  }
  const when = validateConditions(raw.when, label);
  if (!when.ok) return when;
  const action = validateAction(raw.action, label);
  if (!action.ok) return action;
  const id = typeof raw.id === 'string' && raw.id.trim() && raw.id.length <= 200 ? raw.id.trim() : newMockRuleId();
  const createdAt = toNumber(raw.createdAt);
  const rule = {
    id,
    enabled: toBoolean(raw.enabled) ?? true,
    method: methodRaw === '' || methodRaw === '*' ? '*' : methodRaw.toUpperCase(),
    url: raw.url,
    match,
    action: action.action,
    createdAt: createdAt !== undefined && createdAt > 0 ? createdAt : now,
  };
  const name = optionalString(raw.name, 200);
  if (name) rule.name = name;
  if (apps && apps.length > 0) rule.apps = apps;
  if (when.when) rule.when = when.when;
  return { ok: true, rule };
}

export function validateMockRules(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return { rules: [], problems: ['mock rules must be a list'] };
  const problems = [];
  if (raw.length > MAX_MOCK_RULES) problems.push(`too many mock rules (${raw.length}); at most ${MAX_MOCK_RULES}`);
  const rules = [];
  const seen = new Set();
  raw.slice(0, MAX_MOCK_RULES).forEach((item, index) => {
    const r = validateMockRule(item, index, now);
    if (!r.ok) {
      problems.push(r.problem);
      return;
    }
    const rule = seen.has(r.rule.id) ? { ...r.rule, id: newMockRuleId() } : r.rule;
    seen.add(rule.id);
    rules.push(rule);
  });
  return { rules, problems };
}

const userRulesKey = (rules) => JSON.stringify(rules.filter((r) => !r.id.startsWith(FLOW_RULE_PREFIX)));

/**
 * The rule store: `set(command)` answers a `mocks.set` command as `{ ok, data?, error?, code? }` (the real reply
 * without `type` / `requestId`); `onChange` runs after a successful save.
 */
export function createMockRules(initial, onChange) {
  const store = { rules: validateMockRules(initial).rules, revision: 1 };
  store.set = (command) => {
    if (typeof command?.baseRevision === 'number' && command.baseRevision !== store.revision) {
      return { ok: false, error: 'The mock rules were changed elsewhere; reload them or save again to overwrite', code: 'mocks.conflict', data: { rules: store.rules, revision: store.revision } };
    }
    const { rules, problems } = validateMockRules(command?.rules);
    if (problems.length > 0) return { ok: false, error: `Invalid mock rules: ${problems.join('; ')}`, code: 'config.invalid' };
    if (userRulesKey(store.rules) !== userRulesKey(rules)) store.revision++;
    store.rules = rules;
    onChange?.(rules, store.revision);
    return { ok: true, data: rules };
  };
  return store;
}
