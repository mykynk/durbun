/**
 * Flows and Dürbün packages inside the server: the stores, the engine, automatic triggers, packages, backups
 * and their REST routes. createHttpApp builds it next to the command router and mounts the routes in api.ts.
 *
 *   GET    /api/flows                         FlowSummary[]
 *   POST   /api/flows                         { flow } → { flow, issues } (a new flow)
 *   GET    /api/flows/schema                  JSON Schema of a flow document
 *   POST   /api/flows/ai-pack                 AiPackRequest → { markdown }
 *   POST   /api/flows/import/preview          { text } → { items, problems }
 *   POST   /api/flows/import                  { flows, conflict } → { saved, skipped, problems }
 *   POST   /api/flows/from-requests           { ids, name, saveEnv?, environmentId? } → { flow, issues, envVars, links }
 *   GET    /api/flows/:id                     { flow, issues }
 *   PUT    /api/flows/:id                     { flow } → { flow, issues }
 *   DELETE /api/flows/:id
 *   POST   /api/flows/:id/duplicate           { name? } → { flow, issues }
 *   GET    /api/flows/:id/export              the flow file (download)
 *   POST   /api/flows/:id/preflight           FlowRunRequest → FlowPreflight
 *   POST   /api/flows/:id/run                 FlowRunRequest → FlowRun (409 + preflight when it cannot start)
 *   GET    /api/flow-runs?flowId=&limit=      { running, runs } (headers)
 *   DELETE /api/flow-runs?flowId=             remove finished runs
 *   GET    /api/flow-runs/:id                 FlowRun
 *   DELETE /api/flow-runs/:id
 *   POST   /api/flow-runs/:id/cancel
 *   GET    /api/flow-runs/:id/files/:name     evidence file
 *   GET|PUT /api/flow-environments            FlowEnvironments
 *   POST   /api/packages/export               PackageExportRequest → .durbun download
 *   POST   /api/packages/inspect              { package | token, passphrase? } → PackageManifest (a token reads the kept package again)
 *   POST   /api/packages/import               PackageImportRequest → PackageImportResult
 *   POST   /api/packages/release              { token } → { released } (the import dialog closed)
 *   GET|PUT /api/backup, POST /api/backup/run, GET /api/backup/suggestions, GET /api/backup/files[/:name]
 *   GET|PUT /api/ui-prefs
 */
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  flowFromRequests,
  flowJsonSchema,
  type CapturedRequest,
  type DeviceActionId,
  type FlowRun,
  type FlowRunRequest,
  type FlowSummary,
  type MockRule,
  type ServerToUi,
  type UiNotice,
  type WireBody,
} from '@durbun/protocol';
import { isPlainObject, type ConfigStore } from '../config';
import { BackupService, ownMocksWatcher } from '../backup/scheduler';
import { PACKAGE_JSON_LIMIT_BYTES, PackageError, PackageService } from '../backup/package';
import { UI_PREFS_LIMIT_BYTES, UiPrefsStore } from '../backup/uiPrefs';
import type { CommandRouter } from '../http/commands';
import type { SlackStore } from '../http/slack';
import { isInside, sendFile, statFile } from '../http/static';
import { contentDisposition, errorMessage, fileTimestamp, HttpError, queryString, readJson, sendJson } from '../http/util';
import type { Hub, Logger } from '../types';
import { buildAiPack, extractFlowDocs, previewImport, type AiPackRequest } from './aiPack';
import { FlowEngine, FlowRunError } from './engine';
import { EnvironmentStore } from './environments';
import { RunStore } from './runs';
import { FlowStore, FlowStoreError } from './store';
import { FlowTriggers } from './triggers';

const JSON_LIMIT = 16 * 1024 * 1024;

export interface FlowsModuleDeps {
  hub: Hub;
  config: ConfigStore;
  logger: Logger;
  router: Pick<CommandRouter, 'handle'>;
  slack?: SlackStore;
  fetchImpl?: typeof fetch;
  broadcast(message: ServerToUi): void;
  notice(n: UiNotice): void;
  version: string;
  now?: () => number;
  /** Automatic backups and triggers (off in tests that do not need them). */
  background?: boolean;
}

export interface ApiModule {
  readonly prefixes: readonly string[];
  handle(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void>;
}

export interface FlowsModule extends ApiModule {
  readonly ready: Promise<void>;
  summaries(): FlowSummary[];
  runningRuns(): FlowRun[];
  readonly engine: FlowEngine;
  readonly flows: FlowStore;
  dispose(): Promise<void>;
}

function requireMethod(req: IncomingMessage, ...methods: string[]): void {
  const m = req.method ?? 'GET';
  if (methods.includes(m) || (m === 'HEAD' && methods.includes('GET'))) return;
  const err = new HttpError(405, `Method ${m} not allowed`, 'api.method') as HttpError & { allow: string };
  err.allow = methods.join(', ');
  throw err;
}

const notFound = () => new HttpError(404, 'Not found', 'api.notFound');

function wireText(b: WireBody | undefined): string | undefined {
  if (!b) return undefined;
  return b.encoding === 'base64' ? Buffer.from(b.data, 'base64').toString('utf8') : b.data;
}

export function createFlowsModule(deps: FlowsModuleDeps): FlowsModule {
  const { hub, config, logger } = deps;
  const now = deps.now ?? Date.now;
  const flows = new FlowStore(config.dataDir, logger.child('flows'), now);
  const envs = new EnvironmentStore(config.dataDir, logger.child('flows'));
  const runs = new RunStore(config.dataDir, logger.child('flows'));
  const uiPrefs = new UiPrefsStore(config.dataDir);
  const flowClient = { id: -1, notice: (n: UiNotice) => deps.notice(n) };

  const summaries = (): FlowSummary[] => {
    const last = runs.lastRuns();
    return flows.summaries().map((s) => {
      const r = last.get(s.id);
      return r ? { ...s, lastRun: { id: r.id, status: r.status, startedAt: r.startedAt, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) } } : s;
    });
  };
  let broadcastTimer: NodeJS.Timeout | undefined;
  const broadcastFlows = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      deps.broadcast({ type: 'flows', flows: summaries() });
    }, 50);
    broadcastTimer.unref?.();
  };

  const engine = new FlowEngine({
    hub,
    logger: logger.child('flows'),
    flows,
    envs,
    runs,
    slackConfigured: async () => (deps.slack ? (await deps.slack.status()).configured : false),
    deviceAction: (deviceId: string, action: DeviceActionId, params: Record<string, unknown>) => deps.router.handle({ name: 'device.action', deviceId, action, params }, flowClient),
    mocks: { get: () => config.mocks, set: (rules: MockRule[]) => config.setMocks(rules) },
    slack: deps.slack,
    maxBodyBytes: () => config.settings.maxBodyBytes,
    fetchImpl: deps.fetchImpl,
    now,
    emit: (delta) => deps.broadcast({ type: 'flowRun', ...delta }),
    runEnded: () => broadcastFlows(),
  });

  const packages = new PackageService({ flows, envs, runs, config, slack: deps.slack, uiPrefs, version: deps.version, logger: logger.child('packages'), now });
  const backup = new BackupService({ dataDir: config.dataDir, logger: logger.child('backup'), build: (req) => packages.export(req), notice: deps.notice, now });
  let triggers: FlowTriggers | undefined;
  const unsubscribers: (() => void)[] = [];

  const ready = (async () => {
    await Promise.all([flows.load(), envs.load(), runs.load(), backup.load()]);
    for (const p of flows.loadProblems) {
      deps.notice({ level: 'warn', message: `The flow file ${p.file} could not be read: ${p.message}`, code: 'flow.file.unreadable', params: { file: p.file, problem: p.message } });
    }
    const dirty = () => backup.markDirty();
    unsubscribers.push(
      flows.onChange(() => {
        broadcastFlows();
        dirty();
      }),
      envs.onChange(dirty),
      uiPrefs.onChange(dirty),
      // Rules a flow adds while it runs are not backed up: they do not make a backup due.
      config.onMocks(ownMocksWatcher(config.mocks, dirty)),
      config.onSettings(dirty),
    );
    if (deps.background !== false) {
      triggers = new FlowTriggers({ hub, flows, engine, logger: logger.child('automation'), notice: deps.notice, now });
      backup.start();
    }
    if (flows.list().length) broadcastFlows();
  })().catch((err) => logger.error(`flows could not start: ${errorMessage(err)}`));

  /* ───────────── handlers ───────────── */

  async function body(req: IncomingMessage, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
    const raw = await readJson(req, limit);
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) throw new HttpError(400, 'Expected a JSON object', 'body.invalid');
    return raw;
  }

  function runRequest(b: Record<string, unknown>): FlowRunRequest {
    const r: FlowRunRequest = {};
    if (isPlainObject(b.target)) {
      r.target = {};
      if (typeof b.target.deviceId === 'string' && b.target.deviceId) r.target.deviceId = b.target.deviceId;
      if (typeof b.target.appId === 'string' && b.target.appId.trim()) r.target.appId = b.target.appId.trim();
    }
    if (b.environmentId === null) r.environmentId = null;
    else if (typeof b.environmentId === 'string' && b.environmentId) r.environmentId = b.environmentId;
    if (isPlainObject(b.inputs)) r.inputs = b.inputs;
    if (typeof b.startNodeId === 'string' && b.startNodeId) r.startNodeId = b.startNodeId;
    return r;
  }

  async function fromRequests(b: Record<string, unknown>) {
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
    if (ids.length === 0) throw new HttpError(400, 'Choose at least one request', 'flow.fromRequests.empty');
    const picked: { at: number; c: CapturedRequest }[] = [];
    let appId: string | undefined;
    for (const id of ids) {
      const d = hub.getNetworkDetail(id);
      if (!d || d.method === '?') continue;
      appId ??= d.appId ? hub.getApp(d.appId)?.app.id : undefined;
      const c: CapturedRequest = { method: d.method, url: d.url, requestHeaders: d.requestHeaders ?? [] };
      const reqText = d.requestBody?.encoding === 'utf8' ? d.requestBody.data : undefined;
      if (reqText !== undefined) c.requestBody = reqText;
      if (d.requestContentType) c.requestContentType = d.requestContentType;
      if (d.status !== undefined) c.status = d.status;
      if (d.responseHeaders) c.responseHeaders = d.responseHeaders;
      if (d.responseBody?.encoding === 'utf8') c.responseBody = wireText(d.responseBody);
      if (d.responseContentType) c.responseContentType = d.responseContentType;
      picked.push({ at: d.startTs, c });
    }
    if (picked.length === 0) throw new HttpError(400, 'The chosen requests are no longer available', 'flow.fromRequests.gone');
    // The order they happened in is the order of the steps.
    const captured = picked.sort((x, y) => x.at - y.at).map((x) => x.c);
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'Requests';
    const made = flowFromRequests(captured, { id: flows.freeId(name), name, ...(appId ? { appId } : {}) });
    const saved = await flows.save(made.flow, { create: true });
    if (b.saveEnv !== false && made.envVars.length) {
      await envs.upsertVars(typeof b.environmentId === 'string' ? b.environmentId : undefined, made.envVars, 'Default');
    }
    return { flow: saved.flow, issues: saved.issues, envVars: made.envVars.map((v) => ({ key: v.key, secret: v.secret })), links: made.links.length };
  }

  async function importFlows(b: Record<string, unknown>) {
    const list = Array.isArray(b.flows) ? b.flows : [];
    const conflict = b.conflict === 'replace' || b.conflict === 'keepBoth' ? b.conflict : 'skip';
    const { items, problems } = previewImport(list, flows);
    const saved: { id: string; name: string; created: boolean }[] = [];
    let skipped = 0;
    for (const item of items) {
      let doc = item.flow;
      try {
        if (!item.exists) {
          const r = await flows.save(doc, { create: true });
          saved.push({ id: r.flow.id, name: r.flow.name, created: true });
        } else if (conflict === 'replace') {
          const r = await flows.save(doc, { id: doc.id });
          saved.push({ id: r.flow.id, name: r.flow.name, created: false });
        } else if (conflict === 'keepBoth') {
          doc = { ...doc, id: flows.freeId(doc.id), name: `${doc.name} (2)` };
          const r = await flows.save(doc, { create: true });
          saved.push({ id: r.flow.id, name: r.flow.name, created: true });
        } else skipped++;
      } catch (err) {
        problems.push(`${doc.name}: ${errorMessage(err)}`);
      }
    }
    return { saved, skipped, problems };
  }

  async function evidence(req: IncomingMessage, res: ServerResponse, runId: string, name: string, query: URLSearchParams) {
    const file = runs.filePath(runId, name);
    if (!file) throw notFound();
    const stat = await statFile(file);
    if (!stat?.isFile()) throw notFound();
    const [real, root] = await Promise.all([fsp.realpath(file), fsp.realpath(runs.dir)]).catch(() => {
      throw notFound();
    });
    if (!isInside(root, real)) throw notFound();
    const headers: Record<string, string> = {};
    if (query.get('download') === '1') headers['Content-Disposition'] = contentDisposition(name);
    sendFile(req, res, real, stat, { cacheControl: 'no-cache', sandboxActive: true, headers });
  }

  async function flowsRoute(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void> {
    const [, second, third] = segs;
    const method = req.method ?? 'GET';
    if (!second) {
      if (method === 'POST') {
        const b = await body(req);
        const r = await flows.save(b.flow ?? b, { create: true });
        return sendJson(res, 201, { flow: r.flow, issues: r.issues });
      }
      requireMethod(req, 'GET', 'POST');
      return sendJson(res, 200, summaries());
    }
    if (segs.length === 2) {
      switch (second) {
        case 'schema':
          requireMethod(req, 'GET');
          return sendJson(res, 200, flowJsonSchema(), query.get('download') === '1' ? { 'Content-Disposition': contentDisposition('durbun-flow.schema.json') } : {});
        case 'ai-pack': {
          requireMethod(req, 'POST');
          const b = (await body(req)) as AiPackRequest;
          return sendJson(res, 200, buildAiPack({ hub, flows, environments: () => envs.get() }, b));
        }
        case 'from-requests':
          requireMethod(req, 'POST');
          return sendJson(res, 201, await fromRequests(await body(req)));
        case 'import':
          requireMethod(req, 'POST');
          return sendJson(res, 200, await importFlows(await body(req)));
        default:
          break;
      }
    }
    if (segs.length === 3 && second === 'import' && third === 'preview') {
      requireMethod(req, 'POST');
      const b = await body(req, PACKAGE_JSON_LIMIT_BYTES);
      const text = typeof b.text === 'string' ? b.text : JSON.stringify(b.flows ?? b.flow ?? '');
      const { docs, problems } = extractFlowDocs(text);
      const preview = previewImport(docs, flows);
      return sendJson(res, 200, { items: preview.items, problems: [...problems, ...preview.problems] });
    }
    const id = second;
    if (segs.length === 2) {
      if (method === 'PUT') {
        const b = await body(req);
        const r = await flows.save(b.flow ?? b, {
          id,
          // A run in progress writes its result under the old id: rename once it has ended.
          beforeRename: (from) => {
            if (engine.runningCount(from) > 0) throw new HttpError(409, 'The flow is running; stop it first', 'flow.running');
          },
        });
        // The run history follows the new id.
        if (r.flow.id !== id) {
          await runs.renameFlow(id, r.flow.id);
          broadcastFlows();
        }
        return sendJson(res, 200, { flow: r.flow, issues: r.issues });
      }
      if (method === 'DELETE') {
        if (engine.runningCount(id) > 0) throw new HttpError(409, 'The flow is running; stop it first', 'flow.running');
        if (!(await flows.remove(id))) throw new HttpError(404, `Flow ${id} does not exist`, 'flow.notFound');
        return sendJson(res, 200, { ok: true });
      }
      requireMethod(req, 'GET', 'PUT', 'DELETE');
      const flow = flows.get(id);
      if (!flow) throw new HttpError(404, `Flow ${id} does not exist`, 'flow.notFound');
      return sendJson(res, 200, { flow, issues: flows.issues(id) });
    }
    if (segs.length === 3) {
      switch (third) {
        case 'duplicate': {
          requireMethod(req, 'POST');
          const b = await body(req);
          const r = await flows.duplicate(id, typeof b.name === 'string' ? b.name : undefined);
          return sendJson(res, 201, { flow: r.flow, issues: r.issues });
        }
        case 'export': {
          requireMethod(req, 'GET');
          const flow = flows.get(id);
          if (!flow) throw new HttpError(404, `Flow ${id} does not exist`, 'flow.notFound');
          return sendJson(res, 200, flow, { 'Content-Disposition': contentDisposition(`${flow.id}.durbun-flow.json`) });
        }
        case 'preflight':
          requireMethod(req, 'POST');
          return sendJson(res, 200, await engine.preflight(id, runRequest(await body(req))));
        case 'run':
          requireMethod(req, 'POST');
          return sendJson(res, 202, await engine.start(id, runRequest(await body(req))));
        default:
          break;
      }
    }
    throw notFound();
  }

  async function runsRoute(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void> {
    const [, id, third, name] = segs;
    const method = req.method ?? 'GET';
    if (!id) {
      const flowId = queryString(query, 'flowId');
      if (method === 'DELETE') return sendJson(res, 200, { removed: await runs.clear(flowId) });
      requireMethod(req, 'GET', 'DELETE');
      const limit = Math.max(1, Math.min(500, Number(query.get('limit')) || 100));
      const running = engine.running().filter((r) => !flowId || r.flowId === flowId);
      const list = runs.list(flowId, limit).filter((h) => !running.some((r) => r.id === h.id));
      return sendJson(res, 200, { running, runs: list });
    }
    if (segs.length === 2) {
      if (method === 'DELETE') {
        if (!(await runs.remove(id))) throw new HttpError(404, 'No such finished run', 'flowRun.notFound');
        broadcastFlows();
        return sendJson(res, 200, { ok: true });
      }
      requireMethod(req, 'GET', 'DELETE');
      const run = engine.activeRun(id) ?? (await runs.get(id));
      if (!run) throw new HttpError(404, 'No such run', 'flowRun.notFound');
      return sendJson(res, 200, run);
    }
    if (segs.length === 3 && third === 'cancel') {
      requireMethod(req, 'POST');
      if (!engine.cancel(id)) throw new HttpError(409, 'The run is not running', 'flowRun.notRunning');
      return sendJson(res, 200, { ok: true });
    }
    if (segs.length === 4 && third === 'files' && name) {
      requireMethod(req, 'GET');
      return evidence(req, res, id, name, query);
    }
    throw notFound();
  }

  async function backupRoute(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<void> {
    const [, second, third] = segs;
    if (!second) {
      if (req.method === 'PUT') return sendJson(res, 200, await backup.update(await readJson(req, JSON_LIMIT)));
      requireMethod(req, 'GET', 'PUT');
      return sendJson(res, 200, backup.status());
    }
    if (second === 'run' && segs.length === 2) {
      requireMethod(req, 'POST');
      const r = await backup.runNow({ manual: true });
      return sendJson(res, 200, { ...r, settings: backup.status() });
    }
    if (second === 'suggestions' && segs.length === 2) {
      requireMethod(req, 'GET');
      return sendJson(res, 200, await BackupService.suggestions());
    }
    if (second === 'files') {
      requireMethod(req, 'GET');
      if (segs.length === 2) return sendJson(res, 200, await backup.list());
      if (segs.length === 3 && third) return sendJson(res, 200, await backup.read(third));
    }
    throw notFound();
  }

  async function packagesRoute(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<void> {
    const [, second] = segs;
    requireMethod(req, 'POST');
    const b = await body(req, PACKAGE_JSON_LIMIT_BYTES);
    switch (second) {
      case 'export': {
        const pkg = await packages.export(b as never);
        const label = pkg.kind === 'backup' ? 'backup' : 'share';
        const base = (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : `Durbun-${label}`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
        return sendJson(res, 200, pkg, { 'Content-Disposition': contentDisposition(`${base}-${fileTimestamp()}.durbun`) });
      }
      case 'inspect': {
        const token = b.package === undefined && typeof b.token === 'string' && b.token ? b.token : undefined;
        return sendJson(res, 200, await packages.inspect(b.package ?? b, typeof b.passphrase === 'string' ? b.passphrase : undefined, token));
      }
      case 'import':
        return sendJson(res, 200, await packages.import(b as never));
      case 'release':
        return sendJson(res, 200, { released: typeof b.token === 'string' ? packages.release(b.token) : false });
      default:
        throw notFound();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void> {
    await ready;
    try {
      switch (segs[0]) {
        case 'flows':
          return await flowsRoute(req, res, segs, query);
        case 'flow-runs':
          return await runsRoute(req, res, segs, query);
        case 'flow-environments':
          if (segs.length !== 1) throw notFound();
          // The answer is the saved document, as GET returns it (the UI keeps it as is).
          if (req.method === 'PUT') return sendJson(res, 200, (await envs.put(await readJson(req, JSON_LIMIT))).value);
          requireMethod(req, 'GET', 'PUT');
          return sendJson(res, 200, envs.get());
        case 'packages':
          return await packagesRoute(req, res, segs);
        case 'backup':
          return await backupRoute(req, res, segs);
        case 'ui-prefs':
          if (segs.length !== 1) throw notFound();
          if (req.method === 'PUT') {
            await uiPrefs.put(await readJson(req, UI_PREFS_LIMIT_BYTES));
            return sendJson(res, 200, { ok: true });
          }
          requireMethod(req, 'GET', 'PUT');
          return sendJson(res, 200, await uiPrefs.get());
        default:
          throw notFound();
      }
    } catch (err) {
      if (err instanceof FlowRunError) {
        if (err.preflight) return sendJson(res, err.status, { error: err.message, code: err.code, preflight: err.preflight });
        throw new HttpError(err.status, err.message, err.code);
      }
      if (err instanceof FlowStoreError) {
        if (err.issues) return sendJson(res, err.status, { error: err.message, code: err.code, issues: err.issues });
        throw new HttpError(err.status, err.message, err.code);
      }
      if (err instanceof PackageError) throw new HttpError(err.status, err.message, err.code);
      throw err;
    }
  }

  return {
    prefixes: ['flows', 'flow-runs', 'flow-environments', 'packages', 'backup', 'ui-prefs'],
    handle,
    ready,
    engine,
    flows,
    summaries,
    runningRuns: () => engine.running().map((h) => engine.activeRun(h.id)!).filter(Boolean).map((r) => structuredClone(r)),
    dispose: async () => {
      if (broadcastTimer) clearTimeout(broadcastTimer);
      for (const u of unsubscribers) u();
      triggers?.dispose();
      backup.dispose();
      await engine.dispose();
      await Promise.all([flows.flush(), envs.flush(), runs.flush()]);
    },
  };
}
