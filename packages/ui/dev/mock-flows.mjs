/**
 * Flows, packages and backups for the UI mock: an in-memory store that answers the same REST shapes as the real
 * server, enough to design the Flows tab, the package dialogs and Settings → Backup without a device. It does not
 * validate flows; a run is pretend (see `startRun`).
 */

const now = () => Date.now();

const flows = new Map();
/** Newest first, with their steps. */
const runs = [];
let runSeq = 0;
let environments = {
  format: 'durbun-environments',
  version: 1,
  environments: [
    { id: 'staging', name: 'Staging', vars: [{ key: 'baseUrl', value: 'https://staging.example.com' }, { key: 'token', value: 'mock-token', secret: true }] },
    // A test server with a self-signed certificate: runs warn and the history marks them unverified.
    { id: 'qa', name: 'QA (self-signed)', vars: [{ key: 'baseUrl', value: 'https://qa.internal.example' }], tls: { skipVerify: true } },
  ],
  activeId: 'staging',
};
let envRevision = 1;
let uiPrefs = null;
const backup = { enabled: false, keep: 10, intervalHours: 24, includeRuns: false, hasPassphrase: false };
const backupFiles = [];
const inspected = new Map();

function seed() {
  const at = now() - 3_600_000;
  flows.set('login', {
    format: 'durbun-flow',
    version: 1,
    id: 'login',
    name: 'Log in',
    description: 'Signs in and keeps the token for the next steps.',
    tags: ['smoke'],
    inputs: [{ name: 'email', default: 'qa@example.com', required: true }],
    nodes: [
      { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'signIn', type: 'http.request', label: 'Sign in', params: { method: 'POST', url: '{{env.baseUrl}}/auth', bodyType: 'json', body: { email: '{{input.email}}' } }, position: { x: 260, y: 0 } },
      { id: 'ok', type: 'check.assert', params: { assertions: [{ left: '{{signIn.status}}', op: 'equals', right: '200' }] }, position: { x: 520, y: 0 } },
    ],
    edges: [
      { from: 'start', to: 'signIn' },
      { from: 'signIn', to: 'ok' },
    ],
    createdAt: at,
    updatedAt: at,
  });
  flows.set('checkout', {
    format: 'durbun-flow',
    version: 1,
    id: 'checkout',
    name: 'Checkout smoke',
    tags: ['smoke', 'checkout'],
    nodes: [
      { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'login', type: 'flow.call', params: { flowId: 'login' }, position: { x: 260, y: 0 } },
      { id: 'cart', type: 'http.request', label: 'Get cart', params: { method: 'GET', url: '{{env.baseUrl}}/cart' }, position: { x: 520, y: 0 } },
    ],
    edges: [
      { from: 'start', to: 'login' },
      { from: 'login', to: 'cart' },
    ],
    createdAt: at,
    updatedAt: at,
  });
  // Two flows that start on their own: the automations bar under the list, pause all / resume.
  flows.set('crash-shot', {
    format: 'durbun-flow',
    version: 1,
    id: 'crash-shot',
    name: 'Screenshot on crash',
    automation: { enabled: true },
    nodes: [
      { id: 'onCrash', type: 'trigger.event', params: { event: 'crash' }, position: { x: 0, y: 0 } },
      { id: 'crashScreen', type: 'device.screenshot', params: { name: 'crash' }, position: { x: 260, y: 0 } },
    ],
    edges: [{ from: 'onCrash', to: 'crashScreen' }],
    createdAt: at,
    updatedAt: at,
  });
  flows.set('server-errors', {
    format: 'durbun-flow',
    version: 1,
    id: 'server-errors',
    name: 'Report 500 responses',
    tags: ['alerts'],
    automation: { enabled: true, throttleMs: 60_000 },
    nodes: [
      { id: 'on500', type: 'trigger.event', params: { event: 'networkError' }, position: { x: 0, y: 0 } },
      { id: 'shot', type: 'device.screenshot', params: { name: 'server-error' }, position: { x: 260, y: 0 } },
    ],
    edges: [{ from: 'on500', to: 'shot' }],
    createdAt: at,
    updatedAt: at,
  });
}
// `--no-flows`: an empty Flows tab, to see its welcome page and starter flows.
if (!process.argv.includes('--no-flows')) {
  seed();
  seedRuns();
}

/** One finished run in the history against the self-signed QA server (TLS chip "unverified"). */
function seedRuns() {
  const at = now() - 1_800_000;
  runs.push({
    id: `run-${++runSeq}`,
    flowId: 'login',
    flowName: 'Log in',
    status: 'passed',
    startedAt: at,
    endedAt: at + 2_400,
    durationMs: 2_400,
    trigger: { kind: 'manual' },
    environment: { id: 'qa', name: 'QA (self-signed)', tls: 'unverified' },
    preflight: [{ level: 'warn', code: 'preflight.env.insecureTls', message: 'QA (self-signed) does not verify server certificates: HTTP steps accept any server, also one pretending to be yours', params: { env: 'QA (self-signed)' } }],
    steps: [
      { id: 1, nodeId: 'start', type: 'trigger.manual', flowId: 'login', depth: 0, status: 'passed', startedAt: at, endedAt: at + 5, durationMs: 5, port: 'out' },
      { id: 2, nodeId: 'signIn', type: 'http.request', label: 'Sign in', flowId: 'login', depth: 0, status: 'passed', startedAt: at + 5, endedAt: at + 2_300, durationMs: 2_295, port: 'out' },
      { id: 3, nodeId: 'ok', type: 'check.assert', flowId: 'login', depth: 0, status: 'passed', startedAt: at + 2_300, endedAt: at + 2_400, durationMs: 100, port: 'out' },
    ],
    counts: { passed: 3, failed: 0, skipped: 0, total: 3 },
  });
  // A failed checkout run: the run panel and the More menu offer the AI pack to fix it.
  const at2 = now() - 600_000;
  runs.push({
    id: `run-${++runSeq}`,
    flowId: 'checkout',
    flowName: 'Checkout smoke',
    status: 'failed',
    startedAt: at2,
    endedAt: at2 + 3_100,
    durationMs: 3_100,
    trigger: { kind: 'manual' },
    error: 'Step "Get cart" failed: HTTP 401',
    steps: [
      { id: 1, nodeId: 'start', type: 'trigger.manual', flowId: 'checkout', depth: 0, status: 'passed', startedAt: at2, endedAt: at2 + 5, durationMs: 5, port: 'out' },
      { id: 2, nodeId: 'login', type: 'flow.call', label: 'Log in', flowId: 'checkout', depth: 0, status: 'passed', startedAt: at2 + 5, endedAt: at2 + 2_400, durationMs: 2_395, port: 'out' },
      { id: 3, nodeId: 'cart', type: 'http.request', label: 'Get cart', flowId: 'checkout', depth: 0, status: 'failed', startedAt: at2 + 2_400, endedAt: at2 + 3_100, durationMs: 700, error: 'HTTP 401 Unauthorized' },
    ],
    counts: { passed: 2, failed: 1, skipped: 0, total: 3 },
  });
}

/** The environment a run uses (the request's, else the active one) as the engine records it. */
function runEnvironment(req) {
  const wanted = req.environmentId === null ? undefined : (req.environmentId ?? environments.activeId);
  const env = environments.environments.find((e) => e.id === wanted);
  if (!env) return undefined;
  const tls = env.tls?.skipVerify ? 'unverified' : env.tls?.ca ? 'customCa' : undefined;
  return { id: env.id, name: env.name, ...(tls ? { tls } : {}) };
}

/** Preflight notes about the environment's certificates, worded like the server's preflight. */
function tlsIssues(flow, req) {
  const wanted = req.environmentId === null ? undefined : (req.environmentId ?? environments.activeId);
  const env = environments.environments.find((e) => e.id === wanted);
  if (!env?.tls || !flow.nodes.some((n) => n.type === 'http.request')) return [];
  if (env.tls.skipVerify) {
    return [{ level: 'warn', code: 'preflight.env.insecureTls', message: `${env.name} does not verify server certificates: HTTP steps accept any server, also one pretending to be yours`, params: { env: env.name } }];
  }
  return env.tls.ca ? [{ level: 'info', code: 'preflight.env.customCa', message: `${env.name} trusts its own certificates for HTTPS steps`, params: { env: env.name } }] : [];
}

function summary(f) {
  return {
    id: f.id,
    name: f.name,
    ...(f.description ? { description: f.description } : {}),
    ...(f.tags ? { tags: f.tags } : {}),
    nodeCount: f.nodes.length,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    triggers: f.nodes.some((n) => n.type === 'trigger.event') ? ['event'] : ['manual'],
    automation: !!f.automation?.enabled,
    calls: f.nodes.filter((n) => n.type === 'flow.call' && n.params?.flowId).map((n) => n.params.flowId),
    issues: { errors: 0, warnings: 0 },
    ...lastRunOf(f.id),
  };
}

function lastRunOf(flowId) {
  const r = runs.filter((x) => x.flowId === flowId).sort((a, b) => b.startedAt - a.startedAt)[0];
  return r ? { lastRun: { id: r.id, status: r.status, startedAt: r.startedAt, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) } } : {};
}

const runHeader = ({ steps, ...run }) => ({ ...run, stepCount: steps.length });

/**
 * A pretend run for the run panel and the canvas overlay: it walks the graph from the trigger (or `startNodeId`) along
 * the `out` edges, one step every 600 ms, and announces each change like the engine does (`flowRun` deltas). A step
 * whose label contains "fail" fails, so the error states can be designed too.
 */
function startRun(flow, req, broadcast) {
  const order = [];
  let cur = req.startNodeId ?? flow.nodes.find((n) => n.type.startsWith('trigger.'))?.id;
  while (cur && !order.includes(cur)) {
    order.push(cur);
    const from = cur;
    cur = flow.edges.find((e) => e.from === from && (e.port ?? 'out') === 'out')?.to;
  }
  const run = {
    id: `run-${++runSeq}`,
    flowId: flow.id,
    flowName: flow.name,
    status: 'running',
    startedAt: now(),
    trigger: { kind: 'manual' },
    ...(runEnvironment(req) ? { environment: runEnvironment(req) } : {}),
    ...(tlsIssues(flow, req).length ? { preflight: tlsIssues(flow, req).filter((i) => i.level === 'warn' || i.code === 'preflight.env.customCa') } : {}),
    ...(req.inputs ? { inputs: req.inputs } : {}),
    steps: [],
    counts: { passed: 0, failed: 0, skipped: 0, total: order.length },
  };
  runs.unshift(run);
  const send = (steps) => broadcast?.({ type: 'flowRun', run: runHeader(run), steps });
  const tick = () => {
    const changed = [];
    const last = run.steps.at(-1);
    if (last) {
      const node = flow.nodes.find((n) => n.id === last.nodeId);
      const failed = /fail/i.test(node?.label ?? '');
      Object.assign(last, { status: failed ? 'failed' : 'passed', endedAt: now(), durationMs: now() - last.startedAt, port: failed ? 'error' : 'out' });
      if (failed) Object.assign(last, { error: 'Failed on purpose (mock)', errorCode: 'flow.assert.failed', params: { count: 1, first: 'Failed on purpose (mock)' } });
      run.counts[failed ? 'failed' : 'passed']++;
      changed.push(last);
      if (failed) order.length = run.steps.length;
    }
    const nodeId = order[run.steps.length];
    if (nodeId) {
      const node = flow.nodes.find((n) => n.id === nodeId);
      const step = { id: run.steps.length + 1, nodeId, type: node?.type ?? '', ...(node?.label ? { label: node.label } : {}), flowId: flow.id, depth: 0, status: 'running', startedAt: now() };
      run.steps.push(step);
      changed.push(step);
    } else {
      run.status = run.counts.failed ? 'failed' : 'passed';
      run.endedAt = now();
      run.durationMs = run.endedAt - run.startedAt;
      if (run.counts.failed) Object.assign(run, { error: 'Failed on purpose (mock)', errorCode: 'flow.assert.failed', errorParams: { count: 1, first: 'Failed on purpose (mock)' } });
    }
    send(changed.map((s) => ({ ...s })));
    if (run.status === 'running') setTimeout(tick, 600);
  };
  setTimeout(tick, 300);
  return run;
}

/**
 * The flow documents in an AI answer: the whole text as JSON, else every ```json block (a flow, a list of flows or
 * `{ flows }`). A shorter copy of the server's `extractFlowDocs`; it does not validate.
 */
function flowDocsOf(text) {
  const problems = [];
  const docs = [];
  const add = (v) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (v && Array.isArray(v.flows)) v.flows.forEach(add);
    else if (v && typeof v === 'object' && Array.isArray(v.nodes)) docs.push(v);
    else problems.push('A JSON block is not a flow');
  };
  try {
    add(JSON.parse(text));
  } catch {
    const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    if (!blocks.length) problems.push('No flow JSON found in the text');
    for (const [, block] of blocks) {
      try {
        add(JSON.parse(block));
      } catch (err) {
        problems.push(`A JSON block could not be read: ${err.message}`);
      }
    }
  }
  return { docs, problems };
}

/** Steps without a type the editor knows are reported like the server's validation does. */
function previewItem(raw) {
  const flow = { format: 'durbun-flow', version: 1, ...raw, edges: raw.edges ?? [] };
  flow.nodes = flow.nodes.map((n, i) => (n.position ? n : { ...n, position: flows.get(flow.id)?.nodes.find((o) => o.id === n.id)?.position ?? { x: i * 260, y: 0 } }));
  const issues = flow.nodes
    .filter((n) => typeof n.type !== 'string' || !/^(check|device|flow|http|logic|mock|output|trigger|wait)\./.test(n.type))
    .map((n) => ({ level: 'error', code: 'flow.node.unknownType', message: `Unknown node type "${n.type}" (see the node catalog)`, nodeId: n.id, path: `nodes[${flow.nodes.indexOf(n)}].type`, params: { type: String(n.type), suggestion: '' } }));
  const current = flows.get(flow.id);
  const comparable = (f) => JSON.stringify({ name: f.name, nodes: f.nodes.map(({ position: _p, ...n }) => n), edges: f.edges });
  return { flow, issues, exists: !!current, differs: !!current && comparable(current) !== comparable(flow), nodes: flow.nodes.length };
}

/** Summaries for the WS snapshot and the `flows` message (the Flows tab lists them from there). */
export function flowSummaries() {
  return [...flows.values()].map(summary);
}

function freeId(base) {
  if (!flows.has(base)) return base;
  for (let i = 2; ; i++) if (!flows.has(`${base}-${i}`)) return `${base}-${i}`;
}

function saveFlow(raw, id = raw?.id) {
  const old = flows.get(id);
  const flow = { ...raw, id, format: 'durbun-flow', version: 1, nodes: raw.nodes ?? [], edges: raw.edges ?? [], createdAt: old?.createdAt ?? now(), updatedAt: now() };
  flows.set(id, flow);
  return { flow, issues: [] };
}

function packageOf(req) {
  const inc = req.include ?? {};
  const kind = req.kind === 'backup' ? 'backup' : 'share';
  const picked = kind === 'backup' || inc.flows === 'all' ? [...flows.values()] : [...flows.values()].filter((f) => (inc.flows ?? []).includes(f.id));
  const contents = { flows: picked };
  if (kind === 'backup' || inc.environments) contents.environments = { ...environments, environments: environments.environments.map((e) => ({ ...e, vars: e.vars.map((v) => (v.secret ? { ...v, value: '' } : v)) })) };
  if ((kind === 'backup' || inc.uiPrefs) && uiPrefs) contents.uiPrefs = uiPrefs;
  // As the server: `runs: true` packs every finished run, a list packs those ids only.
  if (inc.runs) {
    const done = runs.filter((r) => r.status !== 'running' && (inc.runs === true || (Array.isArray(inc.runs) && inc.runs.includes(r.id))));
    if (done.length) contents.runs = done.map((run) => ({ run }));
  }
  return {
    format: 'durbun-package',
    version: 1,
    kind,
    createdAt: now(),
    createdBy: { app: 'Dürbün', version: '0.2.0', ...(kind === 'backup' ? { host: 'Mock Mac' } : {}) },
    contents,
    ...(req.name ? { name: req.name } : {}),
    ...(req.note ? { note: req.note } : {}),
  };
}

function manifestOf(pkg) {
  const c = pkg.contents ?? {};
  const token = `mock-${now()}`;
  inspected.set(token, pkg);
  return {
    kind: pkg.kind,
    ...(pkg.name ? { name: pkg.name } : {}),
    ...(pkg.note ? { note: pkg.note } : {}),
    createdAt: pkg.createdAt,
    createdBy: pkg.createdBy,
    flows: (c.flows ?? []).map((f) => {
      const existing = flows.get(f.id);
      return { id: f.id, name: f.name, exists: !!existing, differs: !!existing && (existing.name !== f.name || existing.nodes.length !== f.nodes.length) };
    }),
    mocks: (c.mocks ?? []).map((r) => ({ id: String(r.id), name: r.name || `${r.method} ${r.url}`, exists: false })),
    environments: (c.environments?.environments ?? []).map((e) => ({ id: e.id, name: e.name, exists: environments.environments.some((x) => x.id === e.id), differs: false })),
    envVarCount: (c.environments?.environments ?? []).reduce((n, e) => n + e.vars.length, 0),
    settings: !!c.settings,
    uiPrefs: !!c.uiPrefs,
    slack: !!c.slack,
    runs: (c.runs ?? []).length,
    hasSecrets: !!pkg.secrets,
    warnings: [],
    token,
  };
}

function importPackage(req) {
  const pkg = req.token ? inspected.get(req.token) : req.package;
  if (!pkg) return [410, { error: 'The package is no longer kept: send it again', code: 'package.expired' }];
  const inc = req.include ?? {};
  const result = { flows: { added: 0, replaced: 0, skipped: 0, renamed: 0 }, mocks: { added: 0, replaced: 0, skipped: 0 }, environments: { added: 0, replaced: 0, skipped: 0 }, settings: false, slack: false, runs: 0, secretsRestored: false, warnings: [] };
  for (const f of pkg.contents?.flows ?? []) {
    if (inc.flows !== 'all' && !(inc.flows ?? []).includes(f.id)) continue;
    if (!flows.has(f.id)) {
      saveFlow(f);
      result.flows.added++;
    } else if (req.conflict === 'replace') {
      saveFlow(f);
      result.flows.replaced++;
    } else if (req.conflict === 'keepBoth') {
      saveFlow({ ...f, name: `${f.name} (2)` }, freeId(f.id));
      result.flows.renamed++;
    } else result.flows.skipped++;
  }
  if (inc.environments && pkg.contents?.environments) {
    for (const e of pkg.contents.environments.environments) {
      const i = environments.environments.findIndex((x) => x.id === e.id);
      if (i < 0) {
        environments.environments.push(e);
        result.environments.added++;
      } else if (req.conflict !== 'skip') {
        environments.environments[i] = e;
        result.environments.replaced++;
      } else result.environments.skipped++;
    }
  }
  if (inc.uiPrefs && pkg.contents?.uiPrefs) result.uiPrefs = pkg.contents.uiPrefs;
  return [200, result];
}

/**
 * Answers the flows, packages, backup and UI preference routes; false when `p` is none of them. A change to the flows
 * is announced like the real server does: `{ type: 'flows', flows }` to every UI.
 */
export async function handleFlowsApi(req, res, p, { json, readBody, broadcast }) {
  const handled = await route(req, res, p, { json, readBody, broadcast });
  const changed = req.method !== 'GET' && (/^\/api\/flows(\/|$)/.test(p) || p === '/api/packages/import') && !/\/(preflight|run|import\/preview|ai-pack)$/.test(p);
  if (handled && changed) broadcast?.({ type: 'flows', flows: flowSummaries() });
  return handled;
}

async function route(req, res, p, { json, readBody, broadcast }) {
  const body = async () => JSON.parse((await readBody(req)).toString() || '{}');
  const m = req.method;

  if (p === '/api/flows' && m === 'GET') return json(res, 200, [...flows.values()].map(summary)), true;
  if (p === '/api/flows' && m === 'POST') {
    const { flow } = await body();
    return json(res, 201, saveFlow(flow, freeId(flow?.id || 'new-flow'))), true;
  }
  if (p === '/api/flows/import/preview' && m === 'POST') {
    const b = await body();
    const { docs, problems } = flowDocsOf(typeof b.text === 'string' ? b.text : JSON.stringify(b.flows ?? b.flow ?? ''));
    return json(res, 200, { items: docs.map(previewItem), problems }), true;
  }
  if (p === '/api/flows/import' && m === 'POST') {
    const b = await body();
    const conflict = b.conflict === 'replace' || b.conflict === 'keepBoth' ? b.conflict : 'skip';
    const saved = [];
    let skipped = 0;
    for (const doc of Array.isArray(b.flows) ? b.flows : []) {
      if (!doc?.id) continue;
      if (!flows.has(doc.id)) saved.push({ id: saveFlow(doc, doc.id).flow.id, name: doc.name, created: true });
      else if (conflict === 'replace') saved.push({ id: saveFlow(doc, doc.id).flow.id, name: doc.name, created: false });
      else if (conflict === 'keepBoth') {
        const id = freeId(doc.id);
        saved.push({ id: saveFlow({ ...doc, name: `${doc.name} (2)` }, id).flow.id, name: `${doc.name} (2)`, created: true });
      } else skipped++;
    }
    return json(res, 200, { saved, skipped, problems: [] }), true;
  }
  if (p === '/api/flows/ai-pack' && m === 'POST') {
    // The real server writes the whole pack; the mock echoes what decides its "What is wrong now" part.
    const b = await body();
    const issues = b.include?.issues === false || !Array.isArray(b.issues) ? [] : b.issues.slice(0, 200);
    const lines = ['# Dürbün flow pack (mock)', '', 'The real server writes the full pack here.', ''];
    if (issues.length) lines.push('## What is wrong now', '', ...issues.map((i) => `- ${i.level} ${i.code}${i.nodeId ? ` (step "${i.nodeId}")` : ''}: ${i.message}`), '');
    if (b.flowId && b.include?.lastRun !== false) lines.push(`(last failed run of ${b.flowId} added when there is one)`);
    return json(res, 200, { markdown: lines.join('\n') }), true;
  }
  const flowRoute = /^\/api\/flows\/([^/]+)(?:\/(duplicate|preflight|run|export))?$/.exec(p);
  if (flowRoute) {
    const id = decodeURIComponent(flowRoute[1]);
    const action = flowRoute[2];
    const flow = flows.get(id);
    if (!flow) return json(res, 404, { error: 'No such flow', code: 'flow.notFound', params: { id } }), true;
    if (!action && m === 'GET') return json(res, 200, { flow, issues: [] }), true;
    if (!action && m === 'PUT') {
      // Like the server: a save based on an older copy than the stored one is refused (another window saved).
      const req = await body();
      if (typeof req.baseUpdatedAt === 'number' && (flow.updatedAt ?? 0) > req.baseUpdatedAt + 1) {
        return json(res, 409, { error: 'This flow was changed in another window', code: 'flow.conflict' }), true;
      }
      return json(res, 200, saveFlow(req.flow, id)), true;
    }
    if (!action && m === 'DELETE') return flows.delete(id), res.writeHead(204).end(), true;
    if (action === 'duplicate') {
      const { name } = await body();
      return json(res, 201, saveFlow({ ...flow, name: name || `${flow.name} (copy)` }, freeId(`${id}-copy`))), true;
    }
    if (action === 'preflight') return json(res, 200, { ok: true, issues: tlsIssues(flow, await body()), irreversible: [], skipped: [] }), true;
    if (action === 'run' && m === 'POST') return json(res, 201, { ...startRun(flow, await body(), broadcast), steps: [] }), true;
    if (action === 'export') return json(res, 200, flow, { 'Content-Disposition': `attachment; filename="${id}.flow.json"` }), true;
  }
  if (p.startsWith('/api/flow-runs')) {
    const url = new URL(req.url, 'http://mock');
    const flowId = url.searchParams.get('flowId');
    const mine = (r) => !flowId || r.flowId === flowId;
    if (p === '/api/flow-runs' && m === 'GET') {
      const list = runs.filter(mine).map(runHeader);
      return json(res, 200, { running: list.filter((r) => r.status === 'running'), runs: list.filter((r) => r.status !== 'running') }), true;
    }
    if (p === '/api/flow-runs' && m === 'DELETE') {
      const keep = runs.filter((r) => !mine(r) || r.status === 'running');
      const removed = runs.length - keep.length;
      runs.splice(0, runs.length, ...keep);
      return json(res, 200, { removed }), true;
    }
    const runRoute = /^\/api\/flow-runs\/([^/]+)(\/cancel)?$/.exec(p);
    const run = runRoute && runs.find((r) => r.id === decodeURIComponent(runRoute[1]));
    if (!run) return json(res, 404, { error: 'No such run' }), true;
    if (runRoute[2] && m === 'POST') {
      if (run.status === 'running') Object.assign(run, { status: 'cancelled', endedAt: now(), durationMs: now() - run.startedAt });
      broadcast?.({ type: 'flowRun', run: runHeader(run), steps: [] });
      return res.writeHead(204).end(), true;
    }
    if (m === 'DELETE') return runs.splice(runs.indexOf(run), 1), res.writeHead(204).end(), true;
    return json(res, 200, run), true;
  }
  if (p === '/api/flow-environments') {
    if (m === 'PUT') {
      const next = { format: 'durbun-environments', version: 1, ...(await body()) };
      // Like the server: a CA that is not a PEM certificate is refused, nothing is saved.
      const bad = next.environments?.find((e) => e.tls?.ca && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(e.tls.ca));
      if (bad) return json(res, 400, { error: `${bad.name}: the certificate is not a PEM certificate (-----BEGIN CERTIFICATE-----)`, code: 'env.tls.invalidCa' }), true;
      // Like the server: a document read before another window's save is refused; without `revision` it overwrites.
      if (next.revision !== undefined && next.revision !== envRevision) {
        return json(res, 409, { error: 'The environments were changed in another window', code: 'env.conflict' }), true;
      }
      delete next.revision;
      environments = next;
      envRevision++;
    }
    return json(res, 200, { ...environments, revision: envRevision }), true;
  }

  if (p === '/api/packages/export' && m === 'POST') {
    const pkg = packageOf(await body());
    return json(res, 200, pkg, { 'Content-Disposition': `attachment; filename="Durbun-${pkg.kind}-mock.durbun"` }), true;
  }
  if (p === '/api/packages/inspect' && m === 'POST') {
    const raw = await body();
    if (raw.package === undefined && typeof raw.token === 'string') {
      const held = inspected.get(raw.token);
      if (!held) return json(res, 410, { error: 'The package is no longer open; pick the file again', code: 'package.expired' }), true;
      const again = manifestOf(held);
      inspected.delete(again.token);
      return json(res, 200, { ...again, token: raw.token, ...(raw.passphrase ? { passphraseOk: raw.passphrase.length >= 8 } : {}) }), true;
    }
    const pkg = raw.package ?? raw;
    if (pkg?.format !== 'durbun-package') return json(res, 400, { error: 'This is not a Dürbün package', code: 'package.invalid' }), true;
    return json(res, 200, manifestOf(pkg)), true;
  }
  if (p === '/api/packages/release' && m === 'POST') {
    const raw = await body();
    return json(res, 200, { released: inspected.delete(raw.token) }), true;
  }
  if (p === '/api/packages/import' && m === 'POST') {
    const [status, out] = importPackage(await body());
    return json(res, status, out), true;
  }

  if (p === '/api/backup') {
    if (m === 'PUT') {
      const patch = await body();
      if (patch.enabled && !(patch.folder ?? backup.folder)) return json(res, 400, { error: 'Choose a folder for the backups first', code: 'backup.folder.missing' }), true;
      if ('passphrase' in patch) backup.hasPassphrase = !!patch.passphrase;
      for (const k of ['enabled', 'folder', 'keep', 'intervalHours', 'includeRuns']) if (k in patch) backup[k] = patch[k] ?? undefined;
    }
    return json(res, 200, backup), true;
  }
  if (p === '/api/backup/run' && m === 'POST') {
    if (!backup.folder) return json(res, 400, { error: 'Choose a folder for the backups first', code: 'backup.folder.missing' }), true;
    const at = now();
    const name = `Durbun-backup-Mock_Mac-${new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.durbun`;
    const file = `${backup.folder}/${name}`;
    backupFiles.unshift({ file, name, size: 8_400, modifiedAt: at, text: JSON.stringify(packageOf({ kind: 'backup' })) });
    backupFiles.splice(backup.keep);
    Object.assign(backup, { lastBackupAt: at, lastBackupFile: file, lastError: undefined });
    return json(res, 200, { file, size: 8_400, settings: backup }), true;
  }
  if (p === '/api/backup/suggestions') {
    return json(res, 200, [
      { id: 'icloud', label: 'iCloud Drive', path: '/Users/you/Library/Mobile Documents/com~apple~CloudDocs/Dürbün' },
      { id: 'documents', label: 'Documents', path: '/Users/you/Documents/Dürbün Backups' },
    ]), true;
  }
  if (p === '/api/backup/files') return json(res, 200, backupFiles.map(({ text: _t, ...f }) => f)), true;
  const backupFile = /^\/api\/backup\/files\/(.+)$/.exec(p);
  if (backupFile) {
    const f = backupFiles.find((x) => x.name === decodeURIComponent(backupFile[1]));
    if (!f) return json(res, 404, { error: 'No such backup', code: 'backup.notFound' }), true;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(f.text), true;
  }

  if (p === '/api/ui-prefs') {
    if (m === 'PUT') {
      uiPrefs = await body();
      return res.writeHead(204).end(), true;
    }
    return json(res, 200, uiPrefs), true;
  }
  return false;
}
