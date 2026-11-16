/**
 * Set runs ("run my smoke set"): several flows run one after another on one device / app and environment, with one
 * report. `<dataDir>/flow-batches/<id>.json`; the newest MAX_BATCHES are kept (a set holds no evidence: its runs do,
 * in the run history). One set runs at a time; each flow's run is an ordinary run with `batchId`.
 *
 * A flow that cannot start is `skipped` with the reason (its preflight: no device for its device steps, a missing
 * input, an invalid flow; steps that are hard to undo without `allowIrreversible`), and the set goes on. With
 * `onFailure: 'stop'` the first failed flow ends the set and the rest are skipped. Cancelling stops the running flow
 * and marks the rest `cancelled`. A set still running when Dürbün quit is `cancelled` (`flow.batch.interrupted`).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FlowBatch, FlowBatchCounts, FlowBatchItem, FlowBatchReason, FlowBatchRequest, FlowRun, FlowRunRequest } from '@durbun/protocol';
import { isPlainObject } from '../config';
import type { Logger } from '../types';
import { FlowRunError, type FlowEngine } from './engine';
import type { FlowStore } from './store';
import { Queue, readJsonFile, timeId, writeJsonFile } from './util';

export const BATCHES_DIR = 'flow-batches';
export const MAX_BATCHES = 50;
export const MAX_BATCH_FLOWS = 100;
const BATCH_ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;

export class FlowBatchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'FlowBatchError';
  }
}

export interface BatchDeps {
  dataDir: string;
  logger: Logger;
  flows: Pick<FlowStore, 'get' | 'list'>;
  engine: Pick<FlowEngine, 'start' | 'preflight' | 'cancel' | 'onRunEnded'>;
  now: () => number;
  /** A set started, changed or ended (the module tells the UIs). */
  changed?: (batch: FlowBatch) => void;
}

interface Active {
  batch: FlowBatch;
  cancel?: FlowBatchReason;
  runId?: string;
  done: Promise<void>;
}

export function batchCounts(items: readonly FlowBatchItem[]): FlowBatchCounts {
  const c: FlowBatchCounts = { passed: 0, failed: 0, skipped: 0, cancelled: 0, total: items.length };
  for (const i of items) if (i.status === 'passed' || i.status === 'failed' || i.status === 'skipped' || i.status === 'cancelled') c[i.status]++;
  return c;
}

/** The request as the service takes it (anything malformed is left out). */
export function batchRequest(raw: unknown): FlowBatchRequest {
  const b = isPlainObject(raw) ? raw : {};
  const r: FlowBatchRequest = {};
  if (Array.isArray(b.flowIds)) r.flowIds = [...new Set(b.flowIds.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (typeof b.tag === 'string' && b.tag.trim()) r.tag = b.tag.trim();
  if (isPlainObject(b.target)) {
    const t: NonNullable<FlowBatchRequest['target']> = {};
    if (typeof b.target.deviceId === 'string' && b.target.deviceId) t.deviceId = b.target.deviceId;
    if (typeof b.target.appId === 'string' && b.target.appId.trim()) t.appId = b.target.appId.trim();
    if (t.deviceId || t.appId) r.target = t;
  }
  if (b.environmentId === null) r.environmentId = null;
  else if (typeof b.environmentId === 'string' && b.environmentId) r.environmentId = b.environmentId;
  if (b.onFailure === 'stop') r.onFailure = 'stop';
  if (b.allowIrreversible === true) r.allowIrreversible = true;
  return r;
}

export class BatchService {
  readonly dir: string;
  /** Newest first. */
  private batches: FlowBatch[] = [];
  private active: Active | undefined;
  private readonly queue = new Queue();
  private disposed = false;

  constructor(private readonly deps: BatchDeps) {
    this.dir = path.join(deps.dataDir, BATCHES_DIR);
  }

  async load(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.logger.warn(`could not read ${this.dir}: ${(err as Error).message}`);
      return;
    }
    const list: FlowBatch[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !BATCH_ID_RE.test(name.slice(0, -5))) continue;
      try {
        const b = (await readJsonFile(path.join(this.dir, name))) as FlowBatch | undefined;
        if (!b || typeof b.id !== 'string' || !Array.isArray(b.items)) continue;
        // A set that was going when Dürbün quit.
        if (b.status === 'running') {
          this.end(b, { code: 'flow.batch.interrupted', message: 'Dürbün was closed during the set run' });
          await writeJsonFile(path.join(this.dir, name), b);
        }
        list.push(b);
      } catch (err) {
        this.deps.logger.warn(`${BATCHES_DIR}/${name}: ${(err as Error).message}`);
      }
    }
    this.batches = list.sort((a, b) => b.startedAt - a.startedAt);
    await this.prune();
  }

  list(limit = MAX_BATCHES): FlowBatch[] {
    return this.batches.slice(0, Math.max(1, limit)).map((b) => structuredClone(b));
  }

  get(id: string): FlowBatch | undefined {
    const b = this.batches.find((x) => x.id === id);
    return b ? structuredClone(b) : undefined;
  }

  running(): FlowBatch | undefined {
    return this.active ? structuredClone(this.active.batch) : undefined;
  }

  /** Starts a set; it goes on in the background. Throws FlowBatchError for an empty or too big set, or while one runs. */
  async start(raw: FlowBatchRequest): Promise<FlowBatch> {
    if (this.disposed) throw new FlowBatchError('Dürbün is shutting down', 'flow.engine.closed', 503);
    const req = batchRequest(raw);
    if (this.active) {
      throw new FlowBatchError('Another set of flows is running; stop it first', 'flow.batch.busy', 409, { id: this.active.batch.id, ...(this.active.batch.tag ? { tag: this.active.batch.tag } : {}) });
    }
    let ids: string[];
    if (req.flowIds?.length) ids = req.flowIds;
    else if (req.tag) {
      const tag = req.tag.toLowerCase();
      ids = this.deps.flows
        .list()
        .filter((f) => f.tags?.some((x) => x.trim().toLowerCase() === tag))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((f) => f.id);
      if (!ids.length) throw new FlowBatchError(`No flow has the tag "${req.tag}"`, 'flow.batch.noTagged', 400, { tag: req.tag });
    } else ids = [];
    if (!ids.length) throw new FlowBatchError('Choose at least one flow', 'flow.batch.empty');
    if (ids.length > MAX_BATCH_FLOWS) throw new FlowBatchError(`At most ${MAX_BATCH_FLOWS} flows in one set`, 'flow.batch.tooMany', 400, { max: MAX_BATCH_FLOWS });

    const now = this.deps.now();
    const batch: FlowBatch = {
      id: timeId(now),
      ...(req.tag && !req.flowIds?.length ? { tag: req.tag } : {}),
      status: 'running',
      startedAt: now,
      request: { ...(req.target ? { target: req.target } : {}), ...(req.environmentId !== undefined ? { environmentId: req.environmentId } : {}) },
      onFailure: req.onFailure ?? 'continue',
      items: ids.map((id): FlowBatchItem => {
        const f = this.deps.flows.get(id);
        return f
          ? { flowId: id, flowName: f.name, status: 'pending' }
          : { flowId: id, flowName: id, status: 'skipped', reason: { code: 'flow.notFound', message: `Flow ${id} does not exist`, params: { id } } };
      }),
      counts: { passed: 0, failed: 0, skipped: 0, cancelled: 0, total: ids.length },
    };
    batch.counts = batchCounts(batch.items);
    this.batches.unshift(batch);
    const active: Active = { batch, done: Promise.resolve() };
    this.active = active;
    await this.save(batch);
    active.done = this.execute(active, req).catch((err) => this.deps.logger.error(`set run ${batch.id} crashed: ${(err as Error).stack ?? err}`));
    return structuredClone(batch);
  }

  /** Stops a running set: the flow running now is cancelled, the rest do not run. */
  cancel(id: string, reason: FlowBatchReason = { code: 'flow.batch.cancelled', message: 'Stopped' }): boolean {
    const a = this.active;
    if (!a || a.batch.id !== id) return false;
    a.cancel ??= reason;
    if (a.runId) this.deps.engine.cancel(a.runId);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (this.active?.batch.id === id) throw new FlowBatchError('The set is running; stop it first', 'flow.batch.running', 409);
    const i = this.batches.findIndex((b) => b.id === id);
    if (i < 0) return false;
    this.batches.splice(i, 1);
    await this.queue.run(() => fsp.rm(path.join(this.dir, `${id}.json`), { force: true }));
    return true;
  }

  /** Waits for the running set (tests, shutdown). */
  async settle(): Promise<void> {
    await this.active?.done;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const a = this.active;
    if (!a) return;
    this.cancel(a.batch.id, { code: 'flow.batch.interrupted', message: 'Dürbün was closed during the set run' });
    await Promise.race([a.done, new Promise((r) => setTimeout(r, 2_500))]);
  }

  /* ───────────── running ───────────── */

  private async execute(active: Active, req: FlowBatchRequest): Promise<void> {
    const { batch } = active;
    const ended = new Map<string, FlowRun>();
    let waiting: { runId: string; resolve(run: FlowRun): void } | undefined;
    const off = this.deps.engine.onRunEnded((run) => {
      if (run.batchId !== batch.id) return;
      if (waiting?.runId === run.id) waiting.resolve(run);
      else ended.set(run.id, run);
    });
    const runReq: FlowRunRequest = {
      ...(req.target ? { target: req.target } : {}),
      ...(req.environmentId !== undefined ? { environmentId: req.environmentId } : {}),
    };
    let stoppedBy: FlowBatchItem | undefined;
    try {
      for (const item of batch.items) {
        if (item.status !== 'pending') continue;
        if (active.cancel) {
          item.status = 'cancelled';
          item.reason = { code: 'flow.batch.notRun', message: 'Not run: the set was stopped' };
          continue;
        }
        if (stoppedBy) {
          item.status = 'skipped';
          item.reason = { code: 'flow.batch.afterFailure', message: `Not run: ${stoppedBy.flowName} failed first`, params: { flow: stoppedBy.flowName } };
          continue;
        }
        const flow = this.deps.flows.get(item.flowId);
        if (!flow) {
          item.status = 'skipped';
          item.reason = { code: 'flow.notFound', message: `Flow ${item.flowId} does not exist`, params: { id: item.flowId } };
          await this.update(batch);
          continue;
        }
        item.flowName = flow.name;
        let run: FlowRun;
        try {
          if (!req.allowIrreversible) {
            const pf = await this.deps.engine.preflight(item.flowId, runReq);
            if (pf.ok && pf.irreversible.length) {
              item.status = 'skipped';
              const steps = pf.irreversible.map((id) => flow.nodes.find((n) => n.id === id)?.label ?? id).join(', ');
              item.reason = { code: 'flow.batch.irreversible', message: `Not run: it has steps that are hard to undo (${steps})`, params: { steps } };
              await this.update(batch);
              continue;
            }
          }
          if (active.cancel) {
            item.status = 'cancelled';
            item.reason = { code: 'flow.batch.notRun', message: 'Not run: the set was stopped' };
            continue;
          }
          run = await this.deps.engine.start(item.flowId, runReq, { batchId: batch.id });
        } catch (err) {
          item.status = 'skipped';
          item.reason = startReason(err);
          await this.update(batch);
          continue;
        }
        active.runId = run.id;
        item.status = 'running';
        item.runId = run.id;
        item.startedAt = run.startedAt;
        if (!batch.target && run.target) batch.target = run.target;
        if (!batch.environment && run.environment) batch.environment = { id: run.environment.id, name: run.environment.name };
        await this.update(batch);
        // A cancel that came while the run was starting.
        if (active.cancel) this.deps.engine.cancel(run.id);
        const done =
          ended.get(run.id) ??
          (await new Promise<FlowRun>((resolve) => {
            waiting = { runId: run.id, resolve };
          }));
        waiting = undefined;
        ended.delete(run.id);
        active.runId = undefined;
        const status = applyRun(item, done);
        await this.update(batch);
        if (status === 'failed' && batch.onFailure === 'stop') stoppedBy = item;
      }
    } finally {
      off();
    }
    this.end(batch, active.cancel ?? (stoppedBy ? { code: 'flow.batch.stoppedAfterFailure', message: `Stopped after ${stoppedBy.flowName} failed`, params: { flow: stoppedBy.flowName } } : undefined));
    this.active = undefined;
    await this.update(batch);
    await this.prune();
  }

  /** Final status and counts; pending / running items of a set that will not go on are cancelled. */
  private end(batch: FlowBatch, reason?: FlowBatchReason): void {
    const now = this.deps.now();
    for (const i of batch.items) {
      if (i.status === 'pending' || i.status === 'running') {
        i.status = 'cancelled';
        i.reason ??= { code: 'flow.batch.notRun', message: 'Not run: the set was stopped' };
      }
    }
    batch.counts = batchCounts(batch.items);
    const cancelled = reason && reason.code !== 'flow.batch.stoppedAfterFailure';
    batch.status = cancelled ? 'cancelled' : batch.counts.failed ? 'failed' : 'passed';
    if (reason) batch.reason = reason;
    batch.endedAt = Math.max(now, batch.startedAt);
    batch.durationMs = batch.endedAt - batch.startedAt;
  }

  private async update(batch: FlowBatch): Promise<void> {
    batch.counts = batchCounts(batch.items);
    await this.save(batch);
    try {
      this.deps.changed?.(structuredClone(batch));
    } catch (err) {
      this.deps.logger.error(`set run listener failed: ${(err as Error).message}`);
    }
  }

  private save(batch: FlowBatch): Promise<void> {
    return this.queue.run(() => writeJsonFile(path.join(this.dir, `${batch.id}.json`), batch)).catch((err) => this.deps.logger.warn(`could not save set run ${batch.id}: ${(err as Error).message}`));
  }

  private async prune(): Promise<void> {
    const drop = this.batches.filter((b) => b.status !== 'running').slice(MAX_BATCHES);
    for (const b of drop) {
      this.batches.splice(this.batches.indexOf(b), 1);
      await this.queue.run(() => fsp.rm(path.join(this.dir, `${b.id}.json`), { force: true }));
    }
  }
}

/** Why a flow could not start: its preflight's first blocking problem, else the engine's error. */
function startReason(err: unknown): FlowBatchReason {
  if (err instanceof FlowRunError) {
    const first = err.preflight?.issues.find((i) => i.level === 'error');
    if (first) return { code: first.code, message: first.message, ...(first.params ? { params: first.params } : {}) };
    return { code: err.code, message: err.message };
  }
  return { code: 'flow.batch.startFailed', message: `The flow could not start: ${(err as Error)?.message ?? String(err)}`, params: { error: (err as Error)?.message ?? String(err) } };
}

function applyRun(item: FlowBatchItem, run: FlowRun): FlowBatchItem['status'] {
  item.status = run.status === 'passed' ? 'passed' : run.status === 'failed' ? 'failed' : 'cancelled';
  item.durationMs = run.durationMs ?? (run.endedAt ?? run.startedAt) - run.startedAt;
  item.counts = { ...run.counts };
  if (run.status !== 'passed' && run.error) {
    item.reason = { code: run.errorCode ?? 'flow.batch.runFailed', message: run.error, ...(run.errorParams ? { params: run.errorParams } : {}) };
  }
  const failed = run.steps.find((s) => s.status === 'failed' && !s.handled);
  if (failed) {
    item.failedStep = {
      nodeId: failed.nodeId,
      type: failed.type,
      flowId: failed.flowId,
      ...(failed.label ? { label: failed.label } : {}),
      ...(failed.error ? { error: failed.error } : {}),
      ...(failed.errorCode ? { errorCode: failed.errorCode } : {}),
      ...(failed.params ? { params: failed.params } : {}),
    };
  }
  return item.status;
}
