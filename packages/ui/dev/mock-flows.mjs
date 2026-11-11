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
  environments: [{ id: 'staging', name: 'Staging', vars: [{ key: 'baseUrl', value: 'https://staging.example.com' }, { key: 'token', value: 'mock-token', secret: true }] }],
  activeId: 'staging',
};
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
}
seed();

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
    automation: false,
    calls: f.nodes.filter((n) => n.type === 'flow.call' && n.params?.flowId).map((n) => n.params.flowId),
    issues: { errors: 0, warnings: 0 },
  };
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
  if (p === '/api/flows/import/preview' && m === 'POST') return json(res, 200, { items: [], problems: ['The mock server does not read flow files'] }), true;
  if (p === '/api/flows/ai-pack' && m === 'POST') return json(res, 200, { markdown: '# Dürbün flow pack (mock)\n\nThe real server writes the full pack here.\n' }), true;
  const flowRoute = /^\/api\/flows\/([^/]+)(?:\/(duplicate|preflight|run|export))?$/.exec(p);
  if (flowRoute) {
    const id = decodeURIComponent(flowRoute[1]);
    const action = flowRoute[2];
    const flow = flows.get(id);
    if (!flow) return json(res, 404, { error: 'No such flow', code: 'flow.notFound', params: { id } }), true;
    if (!action && m === 'GET') return json(res, 200, { flow, issues: [] }), true;
    if (!action && m === 'PUT') return json(res, 200, saveFlow((await body()).flow, id)), true;
    if (!action && m === 'DELETE') return flows.delete(id), res.writeHead(204).end(), true;
    if (action === 'duplicate') {
      const { name } = await body();
      return json(res, 201, saveFlow({ ...flow, name: name || `${flow.name} (copy)` }, freeId(`${id}-copy`))), true;
    }
    if (action === 'preflight') return json(res, 200, { ok: true, issues: [], irreversible: [], skipped: [] }), true;
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
    if (m === 'PUT') environments = { format: 'durbun-environments', version: 1, ...(await body()) };
    return json(res, 200, environments), true;
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
