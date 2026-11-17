/**
 * Flows, packages and backups for the UI mock: an in-memory store that answers the same REST shapes as the real
 * server, enough to design the Flows tab, the package dialogs and Settings → Backup without a device. It does not
 * validate flows; a run is pretend (see `startRun`), and so is a set run (`startBatch`). The shapes are checked
 * against the real handlers by `packages/server/test/flows/mockContract.test.ts`.
 */
import { readFileSync } from 'node:fs';

const now = () => Date.now();

const flows = new Map();
/** Earlier versions per flow id, newest first: `{ id, recordedAt, reason, flow }` (server: flows/history.ts). */
const versions = new Map();
/** Deleted flows, newest first: `{ trashId, deletedAt, flow, versions }`. */
const trash = [];
/** Set runs, newest first (server: flows/batches.ts). */
const batches = [];
let activeBatch = null;
let histSeq = 0;
const MAX_VERSIONS = 30;
const IDLE_MS = 5 * 60_000;
const CHECKPOINT_MS = 15 * 60_000;
const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 86_400_000;
/** Ids shaped like the server's (`<time base 36>-<6 hex>`). */
const histId = (at) => `${Math.floor(at).toString(36)}-${(++histSeq).toString(16).padStart(6, '0')}`;
/** Newest first, with their steps. */
const runs = [];
let runSeq = 0;
/** Pinned runs allowed at once (small here, so the limit can be seen; the server allows more). */
const MAX_PINNED = 3;
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
  // More of the smoke set: one that fails on purpose and one with a step that is hard to undo.
  flows.set('profile-photo', {
    format: 'durbun-flow',
    version: 1,
    id: 'profile-photo',
    name: 'Profile photo upload',
    tags: ['smoke'],
    nodes: [
      { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'upload', type: 'http.request', label: 'Upload fails on purpose', params: { method: 'POST', url: '{{env.baseUrl}}/me/photo' }, position: { x: 260, y: 0 } },
    ],
    edges: [{ from: 'start', to: 'upload' }],
    createdAt: at,
    updatedAt: at,
  });
  flows.set('fresh-install', {
    format: 'durbun-flow',
    version: 1,
    id: 'fresh-install',
    name: 'First launch after a clean install',
    tags: ['smoke', 'onboarding'],
    target: { appId: 'com.example.pati' },
    nodes: [
      { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'wipe', type: 'device.clearData', label: 'Clear app data', position: { x: 260, y: 0 } },
      { id: 'launch', type: 'device.launchApp', position: { x: 520, y: 0 } },
    ],
    edges: [
      { from: 'start', to: 'wipe' },
      { from: 'wipe', to: 'launch' },
    ],
    createdAt: at,
    updatedAt: at,
  });
}

/** Earlier versions of "Log in" and one deleted flow, so the history and the trash have something to show. */
function seedHistory() {
  const login = flows.get('login');
  const day = 86_400_000;
  const v1 = { ...login, name: 'Sign in', nodes: login.nodes.slice(0, 2), edges: login.edges.slice(0, 1), updatedAt: now() - 6 * day };
  const v2 = { ...login, name: 'Sign in', updatedAt: now() - 2 * day };
  const v3 = { ...login, nodes: login.nodes.map((n) => (n.id === 'signIn' ? { ...n, position: { x: 280, y: 20 } } : n)), updatedAt: now() - 3 * 3_600_000 };
  versions.set('login', [
    { id: histId(now() - 2 * 3_600_000), recordedAt: now() - 2 * 3_600_000, reason: 'edit', flow: v3 },
    { id: histId(now() - 4 * 3_600_000), recordedAt: now() - 4 * 3_600_000, reason: 'import', flow: v2 },
    { id: histId(now() - 5 * day), recordedAt: now() - 5 * day, reason: 'edit', flow: v1 },
  ]);
  const deletedAt = now() - 3 * day;
  trash.push({
    trashId: histId(deletedAt),
    deletedAt,
    versions: [],
    flow: {
      format: 'durbun-flow',
      version: 1,
      id: 'old-onboarding',
      name: 'Old onboarding',
      tags: ['onboarding'],
      nodes: [
        { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'open', type: 'device.openUrl', params: { url: 'pati://welcome' }, position: { x: 260, y: 0 } },
      ],
      edges: [{ from: 'start', to: 'open' }],
      createdAt: deletedAt - 20 * day,
      updatedAt: deletedAt - day,
    },
  });
}

/** One finished smoke set in the history: the report view has something to show before anything ran. */
function seedBatches() {
  const at = now() - 25 * 60_000;
  const checkout = runs.find((r) => r.flowId === 'checkout');
  const login = runs.find((r) => r.flowId === 'login');
  const items = [
    { flowId: 'checkout', flowName: 'Checkout smoke', status: 'failed', runId: checkout?.id, startedAt: at + 2_600, durationMs: 3_100, counts: { passed: 2, failed: 1, skipped: 0, total: 3 }, failedStep: { nodeId: 'cart', type: 'http.request', label: 'Get cart', flowId: 'checkout', error: checkout?.error, errorCode: 'flow.http.status', params: checkout?.errorParams }, reason: { code: 'flow.http.status', message: checkout?.error ?? '', params: checkout?.errorParams } },
    { flowId: 'fresh-install', flowName: 'First launch after a clean install', status: 'skipped', reason: { code: 'flow.batch.irreversible', message: 'Not run: it has steps that are hard to undo (Clear app data)', params: { steps: 'Clear app data' } } },
    { flowId: 'login', flowName: 'Log in', status: 'passed', runId: login?.id, startedAt: at, durationMs: 2_400, counts: { passed: 3, failed: 0, skipped: 0, total: 3 } },
  ];
  batches.push({
    id: histId(at),
    tag: 'smoke',
    status: 'failed',
    startedAt: at,
    endedAt: at + 6_100,
    durationMs: 6_100,
    request: {},
    target: { deviceId: 'android:R5CT20XK9QM', deviceName: 'Pixel 8', platform: 'android', osVersion: '15', appId: 'com.example.pati', appName: 'Pati' },
    environment: { id: 'staging', name: 'Staging' },
    onFailure: 'continue',
    items,
    counts: batchCounts(items),
  });
}

// `--no-flows`: an empty Flows tab, to see its welcome page and starter flows.
if (!process.argv.includes('--no-flows')) {
  seed();
  seedRuns();
  seedHistory();
  seedBatches();
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
    // Coded like the engine's: the UI words it from the code (never the English text inside Turkish).
    error: 'Expected status 2xx, got 401 (GET https://api.example.com/cart)',
    errorCode: 'flow.http.status',
    errorParams: { method: 'GET', url: 'https://api.example.com/cart', status: 401, expected: '2xx' },
    steps: [
      { id: 1, nodeId: 'start', type: 'trigger.manual', flowId: 'checkout', depth: 0, status: 'passed', startedAt: at2, endedAt: at2 + 5, durationMs: 5, port: 'out' },
      { id: 2, nodeId: 'login', type: 'flow.call', label: 'Log in', flowId: 'checkout', depth: 0, status: 'passed', startedAt: at2 + 5, endedAt: at2 + 2_400, durationMs: 2_395, port: 'out' },
      { id: 3, nodeId: 'cart', type: 'http.request', label: 'Get cart', flowId: 'checkout', depth: 0, status: 'failed', startedAt: at2 + 2_400, endedAt: at2 + 3_100, durationMs: 700, error: 'Expected status 2xx, got 401 (GET https://api.example.com/cart)', errorCode: 'flow.http.status', params: { method: 'GET', url: 'https://api.example.com/cart', status: 401, expected: '2xx' } },
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

/* ───────────── versions and deleted flows (like server/src/flows/history.ts) ───────────── */

const contentSig = ({ updatedAt: _u, createdAt: _c, $schema: _s, ...rest }) => JSON.stringify(rest);
const SETTINGS_KEYS = ['description', 'tags', 'inputs', 'outputs', 'target', 'settings', 'automation'];

function versionChanges(prev, next) {
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const after = new Map(next.nodes.map((n) => [n.id, n]));
  const out = { stepsAdded: 0, stepsRemoved: 0, stepsChanged: 0, stepsMoved: 0, connections: 0, settings: false };
  for (const [id, n] of after) {
    const o = before.get(id);
    if (!o) {
      out.stepsAdded++;
      continue;
    }
    const { position: p1, ...a } = o;
    const { position: p2, ...b } = n;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.stepsChanged++;
    else if (JSON.stringify(p1 ?? null) !== JSON.stringify(p2 ?? null)) out.stepsMoved++;
  }
  for (const id of before.keys()) if (!after.has(id)) out.stepsRemoved++;
  const edge = (e) => `${e.from}|${e.port ?? 'out'}|${e.to}`;
  const e1 = new Set(prev.edges.map(edge));
  const e2 = new Set(next.edges.map(edge));
  for (const e of e1) if (!e2.has(e)) out.connections++;
  for (const e of e2) if (!e1.has(e)) out.connections++;
  if (prev.name !== next.name) out.renamedFrom = prev.name;
  out.settings = SETTINGS_KEYS.some((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null));
  return out;
}

/** The content a save replaces becomes a version by the server's rules; returns its id. */
function keepVersion(prev, next, { reason = 'edit', checked = false } = {}) {
  if (!prev || contentSig(prev) === contentSig(next)) return undefined;
  const list = versions.get(prev.id) ?? [];
  const newest = list[0];
  if (newest && contentSig(newest.flow) === contentSig(prev)) return undefined;
  const at = now();
  if (reason === 'edit' && checked && newest && at - (prev.updatedAt ?? 0) < IDLE_MS && at - newest.recordedAt < CHECKPOINT_MS) return undefined;
  const id = histId(at);
  list.unshift({ id, recordedAt: at, reason, flow: prev });
  versions.set(prev.id, list.slice(0, MAX_VERSIONS));
  return id;
}

function historyOf(flow) {
  const list = versions.get(flow.id) ?? [];
  return {
    versions: list.map((v, i) => ({
      id: v.id,
      savedAt: v.flow.updatedAt ?? v.recordedAt,
      replacedAt: v.recordedAt,
      reason: v.reason,
      name: v.flow.name,
      nodeCount: v.flow.nodes.length,
      ...(list[i + 1] ? { changes: versionChanges(list[i + 1].flow, v.flow) } : {}),
    })),
    current: { ...(flow.updatedAt !== undefined ? { savedAt: flow.updatedAt } : {}), ...(list[0] ? { changes: versionChanges(list[0].flow, flow) } : {}) },
    maxVersions: MAX_VERSIONS,
  };
}

const trashItem = (t) => ({
  trashId: t.trashId,
  id: t.flow.id,
  name: t.flow.name,
  nodeCount: t.flow.nodes.length,
  ...(t.flow.tags?.length ? { tags: t.flow.tags } : {}),
  deletedAt: t.deletedAt,
  expiresAt: t.deletedAt + TRASH_MS,
  versions: t.versions.length,
});

/* ───────────── set runs (like server/src/flows/batches.ts) ───────────── */

function batchCounts(items) {
  const c = { passed: 0, failed: 0, skipped: 0, cancelled: 0, total: items.length };
  for (const i of items) if (i.status in c && i.status !== 'total') c[i.status]++;
  return c;
}

const IRREVERSIBLE = new Set(['device.clearData', 'device.installApp', 'device.uninstallApp']);
const notRun = { code: 'flow.batch.notRun', message: 'Not run: the set was stopped' };

/** A pretend set run: each flow is a pretend run (`startRun`), one after another; same rules as the server. */
function startBatch(req, broadcast) {
  if (activeBatch) return [409, { error: 'Another set of flows is running; stop it first', code: 'flow.batch.busy', params: { id: activeBatch.batch.id, ...(activeBatch.batch.tag ? { tag: activeBatch.batch.tag } : {}) } }];
  const flowIds = Array.isArray(req.flowIds) ? [...new Set(req.flowIds.filter((x) => typeof x === 'string' && x))] : [];
  const tag = typeof req.tag === 'string' && req.tag.trim() ? req.tag.trim() : undefined;
  let ids = flowIds;
  if (!ids.length && tag) {
    ids = [...flows.values()].filter((f) => f.tags?.some((x) => x.trim().toLowerCase() === tag.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)).map((f) => f.id);
    if (!ids.length) return [400, { error: `No flow has the tag "${tag}"`, code: 'flow.batch.noTagged', params: { tag } }];
  }
  if (!ids.length) return [400, { error: 'Choose at least one flow', code: 'flow.batch.empty' }];
  if (ids.length > 100) return [400, { error: 'At most 100 flows in one set', code: 'flow.batch.tooMany', params: { max: 100 } }];
  const target = req.target && (req.target.deviceId || req.target.appId) ? req.target : undefined;
  const batch = {
    id: histId(now()),
    ...(tag && !flowIds.length ? { tag } : {}),
    status: 'running',
    startedAt: now(),
    request: { ...(target ? { target } : {}), ...(req.environmentId !== undefined ? { environmentId: req.environmentId } : {}) },
    onFailure: req.onFailure === 'stop' ? 'stop' : 'continue',
    items: ids.map((id) => (flows.has(id) ? { flowId: id, flowName: flows.get(id).name, status: 'pending' } : { flowId: id, flowName: id, status: 'skipped', reason: { code: 'flow.notFound', message: `Flow ${id} does not exist`, params: { id } } })),
  };
  batch.counts = batchCounts(batch.items);
  batches.unshift(batch);
  activeBatch = { batch, cancel: null, runId: null };
  // Like the server, the answer comes before the first flow starts.
  const active = activeBatch;
  setTimeout(() => void runBatch(active, req, broadcast), 0);
  return [202, structuredClone(batch)];
}

async function runBatch(active, req, broadcast) {
  const { batch } = active;
  let stoppedBy = null;
  for (const item of batch.items) {
    if (item.status !== 'pending') continue;
    if (active.cancel) {
      Object.assign(item, { status: 'cancelled', reason: notRun });
      continue;
    }
    if (stoppedBy) {
      Object.assign(item, { status: 'skipped', reason: { code: 'flow.batch.afterFailure', message: `Not run: ${stoppedBy.flowName} failed first`, params: { flow: stoppedBy.flowName } } });
      continue;
    }
    const flow = flows.get(item.flowId);
    const hard = flow?.nodes.filter((n) => IRREVERSIBLE.has(n.type)) ?? [];
    if (!flow || (hard.length && !req.allowIrreversible)) {
      const steps = hard.map((n) => n.label ?? n.id).join(', ');
      item.status = 'skipped';
      item.reason = flow ? { code: 'flow.batch.irreversible', message: `Not run: it has steps that are hard to undo (${steps})`, params: { steps } } : { code: 'flow.notFound', message: `Flow ${item.flowId} does not exist`, params: { id: item.flowId } };
      batch.counts = batchCounts(batch.items);
      continue;
    }
    const run = startRun(flow, { ...(req.target ? { target: req.target } : {}), ...(req.environmentId !== undefined ? { environmentId: req.environmentId } : {}) }, broadcast);
    run.batchId = batch.id;
    if (!batch.environment && run.environment) batch.environment = { id: run.environment.id, name: run.environment.name };
    Object.assign(item, { status: 'running', runId: run.id, startedAt: run.startedAt });
    active.runId = run.id;
    while (run.status === 'running') await new Promise((r) => setTimeout(r, 150));
    active.runId = null;
    item.status = run.status === 'passed' ? 'passed' : run.status === 'failed' ? 'failed' : 'cancelled';
    item.durationMs = run.durationMs ?? now() - run.startedAt;
    item.counts = { ...run.counts };
    if (run.status !== 'passed' && run.error) item.reason = { code: run.errorCode ?? 'flow.batch.runFailed', message: run.error, ...(run.errorParams ? { params: run.errorParams } : {}) };
    const failed = run.steps.find((st) => st.status === 'failed' && !st.handled);
    if (failed) item.failedStep = { nodeId: failed.nodeId, type: failed.type, flowId: failed.flowId, ...(failed.label ? { label: failed.label } : {}), ...(failed.error ? { error: failed.error } : {}), ...(failed.errorCode ? { errorCode: failed.errorCode } : {}), ...(failed.params ? { params: failed.params } : {}) };
    batch.counts = batchCounts(batch.items);
    if (item.status === 'failed' && batch.onFailure === 'stop') stoppedBy = item;
  }
  for (const i of batch.items) if (i.status === 'pending' || i.status === 'running') Object.assign(i, { status: 'cancelled', reason: i.reason ?? notRun });
  batch.counts = batchCounts(batch.items);
  const reason = active.cancel ?? (stoppedBy ? { code: 'flow.batch.stoppedAfterFailure', message: `Stopped after ${stoppedBy.flowName} failed`, params: { flow: stoppedBy.flowName } } : null);
  batch.status = active.cancel ? 'cancelled' : batch.counts.failed ? 'failed' : 'passed';
  if (reason) batch.reason = reason;
  batch.endedAt = now();
  batch.durationMs = batch.endedAt - batch.startedAt;
  activeBatch = null;
  batches.splice(50);
  broadcast?.({ type: 'flows', flows: flowSummaries() });
}

/** The flow JSON Schema the server generates (kept in the repo, a server test keeps it current). */
let schemaText = null;
function flowSchema() {
  schemaText ??= readFileSync(new URL('../../../docs/flows/durbun-flow.schema.json', import.meta.url), 'utf8');
  return JSON.parse(schemaText);
}

/**
 * A flow made of captured requests, shaped like the server's (`flowFromRequests`): one HTTP step per request in the
 * order they happened, the common origin as {{env.baseUrl}} (saved to the active environment unless `saveEnv: false`).
 * The mock reads the requests from its own `GET /api/network/:id`.
 */
async function fromRequests(req, b) {
  const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').slice(0, 200) : [];
  if (!ids.length) return [400, { error: 'Choose at least one request', code: 'flow.fromRequests.empty' }];
  const picked = [];
  for (const id of ids) {
    try {
      const r = await fetch(`http://${req.headers.host}/api/network/${encodeURIComponent(id)}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (d && d.method && d.method !== '?') picked.push(d);
    } catch {
      /* gone */
    }
  }
  if (!picked.length) return [400, { error: 'The chosen requests are no longer available', code: 'flow.fromRequests.gone' }];
  picked.sort((x, y) => x.startTs - y.startTs);
  const origins = picked.map((d) => {
    try {
      return new URL(d.url).origin;
    } catch {
      return '';
    }
  });
  const origin = origins.filter(Boolean).sort((a, z) => origins.filter((o) => o === z).length - origins.filter((o) => o === a).length)[0] ?? '';
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'Requests';
  const id = freeId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'requests');
  const nodes = [{ id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } }];
  const edges = [];
  picked.forEach((d, i) => {
    let path = d.url;
    try {
      const u = new URL(d.url);
      path = u.origin === origin ? `{{env.baseUrl}}${u.pathname}${u.search}` : d.url;
    } catch {
      /* keep */
    }
    const nodeId = `req${i + 1}`;
    nodes.push({ id: nodeId, type: 'http.request', label: `${d.method} ${path.replace('{{env.baseUrl}}', '')}`, params: { method: d.method, url: path, ...(d.status ? { expectStatus: String(d.status) } : {}) }, position: { x: (i + 1) * 260, y: 0 } });
    edges.push({ from: i ? `req${i}` : 'start', to: nodeId });
  });
  const saved = saveFlow({ format: 'durbun-flow', version: 1, id, name, nodes, edges }, id);
  const envVars = origin ? [{ key: 'baseUrl', secret: false }] : [];
  if (origin && b.saveEnv !== false) {
    const env = environments.environments.find((e) => e.id === (b.environmentId ?? environments.activeId)) ?? environments.environments[0];
    if (env && !env.vars.some((v) => v.key === 'baseUrl')) env.vars.push({ key: 'baseUrl', value: origin });
  }
  return [201, { ...saved, envVars, links: 0 }];
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
  // As the server: a backup asked for its history carries the flows' versions and the deleted flows.
  if (kind === 'backup' && inc.history) {
    const v = Object.fromEntries(picked.filter((f) => versions.get(f.id)?.length).map((f) => [f.id, versions.get(f.id)]));
    const t = trash.map(({ trashId, deletedAt, flow, versions: list }) => ({ trashId, deletedAt, flow, ...(list?.length ? { versions: list } : {}) }));
    if (Object.keys(v).length || t.length) contents.history = { ...(Object.keys(v).length ? { versions: v } : {}), ...(t.length ? { trash: t } : {}) };
  }
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
    createdBy: { app: 'Dürbün', version: '0.3.1', ...(kind === 'backup' ? { host: 'Mock Mac' } : {}) },
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
    ...historyCounts(pkg),
    hasSecrets: !!pkg.secrets,
    warnings: [],
    token,
  };
}

/** `{ history: { flows, versions, trash } }` for a backup that carries version history, else nothing. */
function historyCounts(pkg) {
  const h = pkg.kind === 'backup' ? pkg.contents?.history : undefined;
  const lists = Object.values(h?.versions ?? {}).filter((l) => Array.isArray(l) && l.length);
  const count = lists.reduce((n, l) => n + l.length, 0);
  const trashed = (h?.trash ?? []).length;
  return count || trashed ? { history: { flows: lists.length, versions: count, trash: trashed } } : {};
}

/** Like the server: versions join by id (this side's copy wins), newest first, within the limit; deleted flows by trash id. */
function mergeHistory(h, landed, pkgFlows) {
  const out = { versions: 0, trash: 0, trimmed: 0 };
  // Where versions go: where the flow landed, else the same id when it is here unchanged (picked or not).
  const target = (id) => {
    if (landed.has(id)) return landed.get(id);
    const here = flows.get(id);
    const theirs = pkgFlows.find((f) => f.id === id);
    return here && theirs && contentSig(here) === contentSig(theirs) ? id : undefined;
  };
  for (const [from, list] of Object.entries(h.versions ?? {})) {
    const to = target(from);
    if (!to) continue;
    const mine = versions.get(to) ?? [];
    const fresh = list.filter((v) => !mine.some((x) => x.id === v.id)).map((v) => ({ ...v, flow: { ...v.flow, id: to } }));
    const all = [...mine, ...fresh].sort((a, b) => b.recordedAt - a.recordedAt);
    out.trimmed += Math.max(0, all.length - MAX_VERSIONS);
    out.versions += fresh.filter((v) => all.indexOf(v) < MAX_VERSIONS).length;
    versions.set(to, all.slice(0, MAX_VERSIONS));
  }
  for (const t of h.trash ?? []) {
    if (trash.some((x) => x.trashId === t.trashId)) continue;
    if (t.deletedAt + TRASH_MS <= now()) {
      out.trimmed++;
      continue;
    }
    trash.push({ trashId: t.trashId, deletedAt: t.deletedAt, flow: t.flow, versions: t.versions ?? [] });
    out.trash++;
  }
  trash.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

function importPackage(req) {
  const pkg = req.token ? inspected.get(req.token) : req.package;
  if (!pkg) return [410, { error: 'The package is no longer kept: send it again', code: 'package.expired' }];
  const inc = req.include ?? {};
  const result = { flows: { added: 0, replaced: 0, skipped: 0, renamed: 0 }, mocks: { added: 0, replaced: 0, skipped: 0 }, environments: { added: 0, replaced: 0, skipped: 0 }, settings: false, slack: false, runs: 0, secretsRestored: false, warnings: [], notices: [] };
  const landed = new Map();
  for (const f of pkg.contents?.flows ?? []) {
    if (inc.flows !== 'all' && !(inc.flows ?? []).includes(f.id)) continue;
    if (!flows.has(f.id)) {
      saveFlow(f);
      landed.set(f.id, f.id);
      result.flows.added++;
    } else if (req.conflict === 'replace') {
      // As the server: the replaced content is kept as "before an import".
      keepVersion(flows.get(f.id), f, { reason: 'import' });
      saveFlow(f);
      landed.set(f.id, f.id);
      result.flows.replaced++;
    } else if (req.conflict === 'keepBoth') {
      const id = freeId(f.id);
      saveFlow({ ...f, name: `${f.name} (2)` }, id);
      landed.set(f.id, id);
      result.flows.renamed++;
    } else result.flows.skipped++;
  }
  if (inc.history && pkg.kind === 'backup' && pkg.contents?.history) {
    result.history = mergeHistory(pkg.contents.history, landed, pkg.contents.flows ?? []);
    if (result.history.trimmed) {
      const message = `${result.history.trimmed} older version(s) or deleted flow(s) were left out to stay within the history limits`;
      result.warnings.push(message);
      result.notices.push({ code: 'package.history.trimmed', message, params: { count: result.history.trimmed } });
    }
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
  const changed = req.method !== 'GET' && (/^\/api\/flows(\/|$)/.test(p) || /^\/api\/flow-trash\/[^/]+\/restore$/.test(p) || p === '/api/packages/import') && !/\/(preflight|run|import\/preview|ai-pack)$/.test(p);
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
      else if (conflict === 'replace') {
        keepVersion(flows.get(doc.id), { ...doc }, { reason: 'import' });
        saved.push({ id: saveFlow(doc, doc.id).flow.id, name: doc.name, created: false });
      }
      else if (conflict === 'keepBoth') {
        const id = freeId(doc.id);
        saved.push({ id: saveFlow({ ...doc, name: `${doc.name} (2)` }, id).flow.id, name: `${doc.name} (2)`, created: true });
      } else skipped++;
    }
    return json(res, 200, { saved, skipped, problems: [] }), true;
  }
  if (p === '/api/flows/schema' && m === 'GET') {
    const download = new URL(req.url, 'http://mock').searchParams.get('download') === '1';
    return json(res, 200, flowSchema(), download ? { 'Content-Disposition': 'attachment; filename="durbun-flow.schema.json"' } : {}), true;
  }
  if (p === '/api/flows/from-requests' && m === 'POST') {
    const [status, out] = await fromRequests(req, await body());
    return json(res, status, out), true;
  }
  if (p === '/api/flow-batches') {
    if (m === 'POST') {
      const [status, out] = startBatch(await body(), broadcast);
      return json(res, status, out), true;
    }
    const limit = Math.max(1, Math.min(50, Number(new URL(req.url, 'http://mock').searchParams.get('limit')) || 20));
    return json(res, 200, { ...(activeBatch ? { running: structuredClone(activeBatch.batch) } : {}), batches: batches.slice(0, limit) }), true;
  }
  const batchRoute = /^\/api\/flow-batches\/([^/]+)(\/cancel)?$/.exec(p);
  if (batchRoute) {
    const batch = batches.find((b) => b.id === decodeURIComponent(batchRoute[1]));
    if (batchRoute[2] && m === 'POST') {
      if (!batch || activeBatch?.batch !== batch) return json(res, 409, { error: 'The set is not running', code: 'flow.batch.notRunning' }), true;
      activeBatch.cancel ??= { code: 'flow.batch.cancelled', message: 'Stopped' };
      const run = runs.find((r) => r.id === activeBatch.runId);
      if (run && run.status === 'running') {
        Object.assign(run, { status: 'cancelled', endedAt: now(), durationMs: now() - run.startedAt, error: 'Stopped', errorCode: 'flow.run.cancelled' });
        broadcast?.({ type: 'flowRun', run: runHeader(run), steps: [] });
      }
      return json(res, 200, { ok: true }), true;
    }
    if (!batch) return json(res, 404, { error: 'No such set run', code: 'flow.batch.notFound' }), true;
    if (m === 'DELETE') {
      if (activeBatch?.batch === batch) return json(res, 409, { error: 'The set is running; stop it first', code: 'flow.batch.running' }), true;
      batches.splice(batches.indexOf(batch), 1);
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 200, batch), true;
  }
  if (p === '/api/flow-trash' && m === 'GET') return json(res, 200, { items: trash.filter((t) => t.deletedAt + TRASH_MS > now()).map(trashItem), keepDays: TRASH_DAYS }), true;
  const trashRoute = /^\/api\/flow-trash\/([^/]+)(\/restore)?$/.exec(p);
  if (trashRoute) {
    const i = trash.findIndex((t) => t.trashId === decodeURIComponent(trashRoute[1]));
    if (i < 0) return json(res, 404, { error: 'This deleted flow is no longer kept', code: 'flow.trash.notFound' }), true;
    const [t] = trash.splice(i, 1);
    if (!trashRoute[2]) return json(res, 200, { ok: true }), true;
    const id = freeId(t.flow.id);
    const out = saveFlow({ ...t.flow, id }, id);
    if (t.versions.length) versions.set(id, t.versions);
    return json(res, 200, out), true;
  }
  const historyRoute = /^\/api\/flows\/([^/]+)\/history(?:\/([^/]+)(\/restore)?)?$/.exec(p);
  if (historyRoute) {
    const id = decodeURIComponent(historyRoute[1]);
    const flow = flows.get(id);
    if (!flow) return json(res, 404, { error: `Flow ${id} does not exist`, code: 'flow.notFound' }), true;
    if (!historyRoute[2]) return json(res, 200, historyOf(flow)), true;
    const v = (versions.get(id) ?? []).find((x) => x.id === historyRoute[2]);
    if (!v) return json(res, 404, { error: 'This version is no longer kept', code: 'flow.version.notFound' }), true;
    if (!historyRoute[3]) return json(res, 200, { flow: { ...v.flow, id } }), true;
    const b = await body();
    if (typeof b.baseUpdatedAt === 'number' && b.baseUpdatedAt !== flow.updatedAt) return json(res, 409, { error: `Flow ${id} was changed elsewhere; reload it or save again to overwrite`, code: 'flow.conflict' }), true;
    const { createdAt: _c, updatedAt: _u, ...content } = v.flow;
    const versionId = keepVersion(flow, { ...content, id }, { reason: 'restore' });
    const out = saveFlow({ ...content, id }, id);
    return json(res, 200, { ...out, ...(versionId ? { versionId } : {}) }), true;
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
      keepVersion(flow, { ...req.flow, id }, { checked: typeof req.baseUpdatedAt === 'number' });
      return json(res, 200, saveFlow(req.flow, id)), true;
    }
    if (!action && m === 'DELETE') {
      // Like the server: kept in the trash with its versions (30 days), not gone.
      flows.delete(id);
      const t = { trashId: histId(now()), deletedAt: now(), flow, versions: versions.get(id) ?? [] };
      versions.delete(id);
      trash.unshift(t);
      return json(res, 200, { ok: true, trash: trashItem(t) }), true;
    }
    if (action === 'duplicate') {
      const { name } = await body();
      return json(res, 201, saveFlow({ ...flow, name: name || `${flow.name} (copy)` }, freeId(`${id}-copy`))), true;
    }
    if (action === 'preflight') return json(res, 200, { ok: true, issues: tlsIssues(flow, await body()), irreversible: flow.nodes.filter((n) => IRREVERSIBLE.has(n.type) && !n.disabled).map((n) => n.id), skipped: [] }), true;
    if (action === 'run' && m === 'POST') return json(res, 202, { ...startRun(flow, await body(), broadcast), steps: [] }), true;
    if (action === 'export') return json(res, 200, flow, { 'Content-Disposition': `attachment; filename="${id}.durbun-flow.json"` }), true;
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
      // Like the server: pinned runs stay, and the answer says how many of this flow's did.
      const keep = runs.filter((r) => !mine(r) || r.status === 'running' || r.pinned);
      const removed = runs.length - keep.length;
      const keptPinned = keep.filter((r) => mine(r) && r.pinned).length;
      runs.splice(0, runs.length, ...keep);
      return json(res, 200, { removed, keptPinned }), true;
    }
    const runRoute = /^\/api\/flow-runs\/([^/]+)(\/cancel)?$/.exec(p);
    const run = runRoute && runs.find((r) => r.id === decodeURIComponent(runRoute[1]));
    if (!run) return json(res, 404, { error: 'No such run' }), true;
    if (runRoute[2] && m === 'POST') {
      if (run.status === 'running') Object.assign(run, { status: 'cancelled', endedAt: now(), durationMs: now() - run.startedAt });
      broadcast?.({ type: 'flowRun', run: runHeader(run), steps: [] });
      return res.writeHead(204).end(), true;
    }
    if (m === 'PATCH') {
      const { pinned } = await body();
      if (pinned === true && !run.pinned && runs.filter((r) => r.pinned).length >= MAX_PINNED) {
        return json(res, 409, { error: `At most ${MAX_PINNED} runs can be pinned`, code: 'flowRun.pinLimit', params: { max: MAX_PINNED } }), true;
      }
      if (pinned === true) run.pinned = true;
      else delete run.pinned;
      return json(res, 200, runHeader(run)), true;
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
