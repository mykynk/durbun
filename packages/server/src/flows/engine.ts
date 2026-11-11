/**
 * Runs flows. A run walks the graph from its start nodes: each node runs when the run reaches it, then the
 * run follows every edge of the port the node left through — several edges run in parallel, a node reached
 * twice runs twice. `error` edges catch a step's failure; without one (and without continueOnError) a failure
 * fails the run and stops its other branches. Repeat runs what hangs off `loop` once per iteration (coming
 * back to the repeat node ends an iteration), sub-flows run as nested frames with their own inputs and
 * variables. Limits keep a cyclic or runaway flow from running forever.
 *
 * Progress goes to the UI as deltas (the run header plus the steps that changed), at most every 120 ms.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  evaluateRules,
  flowNodeSpec,
  resolveDeep,
  resolveTemplate,
  resolveText,
  TemplateError,
  type FlowConditionRule,
  type FlowDoc,
  type FlowEdge,
  type FlowEvidence,
  type FlowNode,
  type FlowPort,
  type FlowPreflight,
  type FlowRun,
  type FlowRunDelta,
  type FlowRunHeader,
  type FlowRunRequest,
  type FlowRunStep,
  type FlowRunTrigger,
  type I18nParams,
  type SdkCapability,
  type TemplateScope,
} from '@durbun/protocol';
import type { CommandReply } from '../http/commands';
import type { Logger } from '../types';
import { EXECUTORS, StepError, TEMP_MOCK_PREFIX, type FlowServices, type StepApi, type StepResult } from './nodes';
import { MAX_CALL_DEPTH, prepareRun, resolveInputDefault, startNodes, type PrepareDeps, type PreparedRun } from './preflight';
import { runHeader, type RunStore } from './runs';
import { sdkSession, unsupportedReason, type ResolvedTarget } from './target';
import { AbortedError, expandSecrets, isAbortError, jsonSize, maskSecrets, raceSignal, safeFileName, shortText, sleep, storedOutput, timeId, trimOutput } from './util';

export const MAX_RUN_STEPS = 10_000;
export const MAX_NODE_VISITS = 1_000;
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;
export const MAX_ACTIVE_RUNS = 10;
export const MAX_AUTOMATIC_RUNS = 3;
const EMIT_INTERVAL_MS = 120;
const SDK_WAIT_MS = 10_000;
/** Step outputs a run file keeps (characters of JSON); past it, older outputs of steps that ran again are dropped. */
export const MAX_RUN_OUTPUT_CHARS = 8_000_000;
/** The latest step outputs are always kept, whatever their size. */
const KEEP_RECENT_OUTPUTS = 50;
/** What a dropped output reads in the run file. */
export const DROPPED_OUTPUT = '… (dropped to keep the run small; the latest runs of this step kept theirs)';
/** Flows whose latest scope "run from here" can reuse in this session. */
const MAX_LAST_SCOPES = 20;

export class FlowRunError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly preflight?: FlowPreflight,
  ) {
    super(message);
    this.name = 'FlowRunError';
  }
}

export interface EngineDeps extends FlowServices, Omit<PrepareDeps, 'hub'> {
  logger: Logger;
  runs: RunStore;
  emit(delta: FlowRunDelta): void;
  /** A run finished (saved): the flow list shows its last run. */
  runEnded(run: FlowRun): void;
}

export interface StartOptions {
  trigger?: FlowRunTrigger;
  /** trigger.event node that fired (automation). */
  triggerNodeId?: string;
  /** What templates read as {{trigger.…}}. */
  triggerData?: Record<string, unknown>;
  automatic?: boolean;
}

interface Token {
  nodeId: string;
  /** When / at which log the step that led here started. */
  previousAt: number;
  previousLogId: number;
  /** Repeat nodes whose `loop` this branch runs inside (coming back to one ends the iteration). */
  loops: string[];
  iteration?: number;
  parentStepId?: number;
  /** Which repeat iterations this branch runs in ("repeat#2/inner#0"): visits are counted per iteration. */
  loopKey?: string;
}

interface Failure {
  message: string;
  code: string;
  params?: I18nParams;
  nodeId: string;
}

interface Frame {
  /** Unique within the run (each sub-flow call is a new frame). */
  uid: number;
  flow: FlowDoc;
  depth: number;
  parentStepId?: number;
  nodes: Map<string, FlowNode>;
  edges: Map<string, FlowEdge[]>;
  scope: TemplateScope;
  controller: AbortController;
  failure?: Failure;
  end?: { status: 'passed' | 'failed'; message?: string };
}

interface RunCtx {
  run: FlowRun;
  prepared: PreparedRun;
  controller: AbortController;
  automatic: boolean;
  logIdAtStart: number;
  stepSeq: number;
  frameSeq: number;
  /** Steps that failed so far, handled ones included ({{run.status}}). */
  failedSteps: number;
  visits: Map<string, number>;
  dirty: Map<number, FlowRunStep>;
  flushTimer?: NodeJS.Timeout;
  cleanups: Map<string, () => Promise<void>>;
  /** Cleanups are running / have run: a cleanup registered later (an abandoned step finishing) runs at once. */
  cleaning: boolean;
  cleanedUp: boolean;
  cleanupDone?: Promise<void>;
  recordings: Map<string, Promise<CommandReply>>;
  /** Step outputs kept in the run, oldest first, for the output budget. */
  outputs: { step: FlowRunStep; chars: number; key: string }[];
  outputChars: number;
  /** How many kept outputs each step (frame flow + node) has. */
  outputKeys: Map<string, number>;
  /** Run-level stop reason (cancel, timeout, limits). */
  stop?: { status: 'failed' | 'cancelled'; message: string; code: string; params?: I18nParams };
  top?: Frame;
  done: Promise<void>;
}

const edgeKey = (from: string, port: FlowPort) => `${from}\u0000${port}`;

function defaultPort(node: FlowNode): FlowPort | undefined {
  if (node.type === 'logic.condition') return 'true';
  if (node.type === 'logic.repeat') return 'done';
  if (node.type === 'flow.end') return undefined;
  return 'out';
}

export class FlowEngine {
  private readonly active = new Map<string, RunCtx>();
  /** Runs between start() and their first save: they hold a slot so parallel starts cannot pass the limits. */
  private readonly starting = new Map<symbol, { flowId: string; automatic: boolean }>();
  private readonly endListeners = new Set<(run: FlowRun) => void>();
  private lastLogId = 0;
  /** Full scope of each flow's latest run in this session ("run from here" reads earlier outputs from it). */
  private readonly lastScopes = new Map<string, TemplateScope>();
  /** When this server first saw each request (device clocks differ from the Mac's; waits compare arrival). */
  private readonly netSeen = new Map<string, number>();
  private readonly unsubscribers: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly deps: EngineDeps) {
    this.lastLogId = this.findLastLogId();
    this.removeLeftoverMocks();
    this.unsubscribers.push(
      deps.hub.onLogs((entries) => {
        const last = entries[entries.length - 1];
        if (last && last.id > this.lastLogId) this.lastLogId = last.id;
      }),
      deps.hub.subscribe((change) => {
        if (change.network.length === 0) return;
        const now = deps.now();
        for (const e of change.network) if (!this.netSeen.has(e.id)) this.netSeen.set(e.id, now);
        if (this.netSeen.size > 50_000) {
          let drop = 10_000;
          for (const id of this.netSeen.keys()) {
            this.netSeen.delete(id);
            if (--drop === 0) break;
          }
        }
      }),
    );
  }

  /** Temporary rules of runs that never reached their cleanup (Dürbün quit or crashed mid-run). */
  private removeLeftoverMocks(): void {
    try {
      const rules = this.deps.mocks.get();
      const kept = rules.filter((r) => !r.id.startsWith(TEMP_MOCK_PREFIX));
      if (kept.length === rules.length) return;
      this.deps.mocks.set(kept);
      this.deps.logger.info(`removed ${rules.length - kept.length} mock rule(s) left by an interrupted flow run`);
    } catch (err) {
      this.deps.logger.warn(`could not remove leftover flow mock rules: ${(err as Error).message}`);
    }
  }

  /** Server time a request first arrived (0 = before the engine started). */
  netSeenAt(id: string): number {
    return this.netSeen.get(id) ?? 0;
  }

  private findLastLogId(): number {
    // Ids only grow; find the newest with an exponential then binary search over getLogs({ afterId }).
    const hub = this.deps.hub;
    if (hub.getLogCount() === 0) return 0;
    let lo = 0;
    let hi = 1;
    while (hub.getLogs({ afterId: hi, limit: 1 }).length > 0 && hi < Number.MAX_SAFE_INTEGER / 2) {
      lo = hi;
      hi *= 2;
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (hub.getLogs({ afterId: mid, limit: 1 }).length > 0) lo = mid;
      else hi = mid;
    }
    return hub.getLogs({ afterId: lo, limit: 1 })[0]?.id ?? lo;
  }

  latestLogId(): number {
    return this.lastLogId;
  }

  /* ───────────── public ───────────── */

  async preflight(flowId: string, request: FlowRunRequest): Promise<FlowPreflight> {
    const flow = this.flow(flowId);
    return (await prepareRun(this.deps, flow, request)).preflight;
  }

  private flow(flowId: string): FlowDoc {
    const flow = this.deps.flows.get(flowId);
    if (!flow) throw new FlowRunError(`Flow ${flowId} does not exist`, 'flow.notFound', 404);
    return flow;
  }

  running(): FlowRunHeader[] {
    return [...this.active.values()].map((c) => runHeader(c.run));
  }

  activeRun(runId: string): FlowRun | undefined {
    return this.active.get(runId)?.run;
  }

  /** Runs going (and starting) — of one flow, automatic ones only. */
  runningCount(flowId?: string, automaticOnly = false): number {
    let n = 0;
    for (const c of this.active.values()) if ((!flowId || c.run.flowId === flowId) && (!automaticOnly || c.automatic)) n++;
    for (const s of this.starting.values()) if ((!flowId || s.flowId === flowId) && (!automaticOnly || s.automatic)) n++;
    return n;
  }

  /** Called the moment a run ends (before it is saved); returns the unsubscribe. */
  onRunEnded(listener: (run: FlowRun) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /** Start a run; it goes on in the background. Rejects when the preflight finds a blocking problem. */
  async start(flowId: string, request: FlowRunRequest = {}, opts: StartOptions = {}): Promise<FlowRun> {
    if (this.disposed) throw new FlowRunError('Dürbün is shutting down', 'flow.engine.closed', 503);
    // The limits count runs that are still preparing, and the slot is taken before the first await: starts
    // in the same tick (a burst of events, parallel requests) cannot all pass the check.
    if (this.runningCount() >= MAX_ACTIVE_RUNS) throw new FlowRunError(`At most ${MAX_ACTIVE_RUNS} runs at once`, 'flow.run.tooMany', 429);
    if (opts.automatic && (this.runningCount(flowId) > 0 || this.runningCount(undefined, true) >= MAX_AUTOMATIC_RUNS)) {
      throw new FlowRunError('The flow is running already, or too many automatic runs are going', 'flow.automation.busy', 429);
    }
    const flow = this.flow(flowId);
    const slot = Symbol(flowId);
    this.starting.set(slot, { flowId, automatic: !!opts.automatic });
    try {
      return await this.begin(flow, request, opts, () => this.starting.delete(slot));
    } finally {
      this.starting.delete(slot);
    }
  }

  /** `release` frees the start slot the moment the run counts as active. */
  private async begin(flow: FlowDoc, request: FlowRunRequest, opts: StartOptions, release: () => void): Promise<FlowRun> {
    const prepared = await prepareRun(this.deps, flow, request, { triggerNodeId: opts.triggerNodeId });
    if (!prepared.preflight.ok) {
      const first = prepared.preflight.issues.find((i) => i.level === 'error');
      throw new FlowRunError(first?.message ?? 'The flow cannot run', 'flow.preflight.failed', 409, prepared.preflight);
    }
    const now = this.deps.now();
    const run: FlowRun = {
      id: timeId(now),
      flowId: flow.id,
      flowName: flow.name,
      status: 'running',
      startedAt: now,
      trigger: opts.trigger ?? { kind: 'manual' },
      steps: [],
      counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
    };
    if (prepared.target.info.deviceId || prepared.target.info.appId) run.target = prepared.target.info;
    if (prepared.environment) run.environment = { id: prepared.environment.id, name: prepared.environment.name };
    if (Object.keys(prepared.inputs).length) run.inputs = maskSecrets(trimOutput(prepared.inputs) as Record<string, unknown>, prepared.secrets);
    const notes = prepared.preflight.issues.filter((i) => i.level !== 'info' || i.code === 'preflight.device.auto');
    if (notes.length) run.preflight = notes;

    const ctx: RunCtx = {
      run,
      prepared,
      controller: new AbortController(),
      automatic: !!opts.automatic,
      logIdAtStart: this.lastLogId,
      stepSeq: 0,
      frameSeq: 0,
      failedSteps: 0,
      visits: new Map(),
      dirty: new Map(),
      cleanups: new Map(),
      cleaning: false,
      cleanedUp: false,
      recordings: new Map(),
      outputs: [],
      outputChars: 0,
      outputKeys: new Map(),
      done: Promise.resolve(),
    };
    this.active.set(run.id, ctx);
    release();
    await this.deps.runs.save(run).catch((err) => this.deps.logger.warn(`could not save run ${run.id}: ${(err as Error).message}`));
    this.flush(ctx);
    ctx.done = this.execute(ctx, request, opts).catch((err) => this.deps.logger.error(`run ${run.id} crashed: ${(err as Error).stack ?? err}`));
    return structuredClone(run);
  }

  /** Stop a run: running steps are cancelled, cleanups run. */
  cancel(runId: string): boolean {
    const ctx = this.active.get(runId);
    if (!ctx) return false;
    ctx.stop ??= { status: 'cancelled', message: 'Stopped', code: 'flow.run.cancelled' };
    ctx.controller.abort();
    return true;
  }

  /** Wait for a run to end (tests, shutdown). */
  async settle(runId?: string): Promise<void> {
    const list = runId ? [this.active.get(runId)] : [...this.active.values()];
    await Promise.all(list.map((c) => c?.done));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const u of this.unsubscribers) u();
    const runs = [...this.active.values()];
    for (const ctx of runs) {
      ctx.stop ??= { status: 'cancelled', message: 'Dürbün was closed during the run', code: 'flow.run.interrupted' };
      ctx.controller.abort();
    }
    // Cleanups run here, not after the runs wind down: a step stuck in a device action must not keep a mock
    // rule active (or a recording going) past shutdown. Mock rules go first, they are instant.
    await Promise.race([Promise.all(runs.map((ctx) => this.cleanup(ctx))), sleep(5_000)]);
    await Promise.race([this.settle(), sleep(2_000)]);
  }

  /* ───────────── run ───────────── */

  private async execute(ctx: RunCtx, request: FlowRunRequest, opts: StartOptions): Promise<void> {
    const { run, prepared } = ctx;
    const flow = prepared.flow;
    const timeoutMs = flow.settings?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      ctx.stop ??= { status: 'failed', message: `The run did not finish within ${Math.round(timeoutMs / 60_000)} min`, code: 'flow.run.timeout' };
      ctx.controller.abort();
    }, timeoutMs);
    timer.unref?.();

    const runInfo: Record<string, unknown> = { id: run.id, flowId: flow.id, flowName: flow.name, startedAt: run.startedAt };
    // The result so far: "failed" once any step failed (also one an error edge or continueOnError handled).
    Object.defineProperty(runInfo, 'status', {
      enumerable: true,
      get: () => ctx.stop?.status ?? (ctx.failedSteps > 0 || ctx.top?.failure || ctx.top?.end?.status === 'failed' ? 'failed' : 'passed'),
    });
    const target = prepared.target.info;
    const shared: TemplateScope = {
      env: Object.fromEntries((prepared.environment?.vars ?? []).map((v) => [v.key, v.value])),
      target: { ...target, deviceId: target.deviceId ?? '', appId: target.appId ?? '' },
      trigger: opts.triggerData ?? { kind: run.trigger.kind },
      run: runInfo,
    };
    let seed: TemplateScope = {};
    if (request.startNodeId) {
      seed = { ...(this.lastScopes.get(flow.id) ?? (await this.storedOutputs(flow.id))) };
      for (const k of ['env', 'target', 'trigger', 'run', 'input', 'item']) delete seed[k];
      // A copy: two "run from here" runs must not share (and change) the same vars and outputs.
      seed = cloneScope(seed);
    }
    const top = this.frame(ctx, flow, 0, undefined, { ...seed, ...shared, input: prepared.inputs, vars: isRecord(seed.vars) ? seed.vars : {} }, ctx.controller.signal);
    ctx.top = top;

    try {
      await Promise.all(
        prepared.startNodes.map((id) => this.visit(ctx, top, { nodeId: id, previousAt: run.startedAt, previousLogId: ctx.logIdAtStart, loops: [] })),
      );
    } catch (err) {
      this.deps.logger.error(`run ${run.id}: ${(err as Error).stack ?? err}`);
      ctx.stop ??= { status: 'failed', message: `Internal error: ${(err as Error).message}`, code: 'flow.run.internal', params: { error: (err as Error).message } };
      ctx.controller.abort(); // branches still going stop too
    } finally {
      clearTimeout(timer);
    }
    await this.cleanup(ctx);

    const end = this.deps.now();
    run.endedAt = end;
    run.durationMs = end - run.startedAt;
    if (ctx.stop) {
      run.status = ctx.stop.status;
      run.error = ctx.stop.message;
      run.errorCode = ctx.stop.code;
      if (ctx.stop.params) run.errorParams = ctx.stop.params;
    } else if (top.end) {
      run.status = top.end.status;
      if (top.end.message) run.error = top.end.message;
      if (top.end.status === 'failed') {
        run.errorCode = 'flow.end.failed';
        if (top.end.message) run.errorParams = { message: top.end.message };
      }
    } else if (top.failure) {
      run.status = 'failed';
      run.error = top.failure.message;
      run.errorCode = top.failure.code;
      if (top.failure.params) run.errorParams = top.failure.params;
    } else {
      run.status = 'passed';
    }
    // The end message and failure texts may repeat a secret the run used.
    if (run.error !== undefined) run.error = maskSecrets(run.error, ctx.prepared.secrets);
    if (run.errorParams) run.errorParams = maskSecrets(run.errorParams, ctx.prepared.secrets);
    for (const s of run.steps) {
      if (s.status === 'running') {
        s.status = 'cancelled';
        s.endedAt = end;
        s.durationMs = end - s.startedAt;
        ctx.dirty.set(s.id, s);
      }
    }
    if (flow.outputs?.length) {
      const outputs: Record<string, unknown> = {};
      for (const o of flow.outputs) {
        try {
          outputs[o.name] = resolveTemplate(o.value, top.scope, { strict: false });
        } catch {
          outputs[o.name] = undefined;
        }
      }
      run.outputs = maskSecrets(trimOutput(outputs) as Record<string, unknown>, prepared.secrets);
    }
    this.count(run);
    this.keepScope(flow.id, top.scope);
    this.active.delete(run.id);
    // Automation measures its throttle from here; nothing may slip in between the end and the listeners.
    for (const l of this.endListeners) {
      try {
        l(run);
      } catch (err) {
        this.deps.logger.error(`run end listener failed: ${(err as Error).message}`);
      }
    }
    try {
      await this.deps.runs.save(run);
    } catch (err) {
      this.deps.logger.warn(`could not save run ${run.id}: ${(err as Error).message}`);
    }
    this.flush(ctx);
    try {
      this.deps.runEnded(run); // saved and no longer changed: no copy needed
    } catch (err) {
      this.deps.logger.error(`runEnded listener failed: ${(err as Error).message}`);
    }
  }

  /** The latest scope per flow for "run from here", for at most MAX_LAST_SCOPES flows that still exist. */
  private keepScope(flowId: string, scope: TemplateScope): void {
    this.lastScopes.delete(flowId);
    this.lastScopes.set(flowId, scope);
    for (const id of this.lastScopes.keys()) if (!this.deps.flows.get(id)) this.lastScopes.delete(id);
    while (this.lastScopes.size > MAX_LAST_SCOPES) this.lastScopes.delete(this.lastScopes.keys().next().value!);
  }

  private async storedOutputs(flowId: string): Promise<TemplateScope> {
    const last = this.deps.runs.list(flowId, 5).find((h) => h.status !== 'running');
    if (!last) return {};
    const run = await this.deps.runs.get(last.id);
    const scope: TemplateScope = {};
    for (const s of run?.steps ?? []) if (s.depth === 0 && s.output !== undefined) scope[s.nodeId] = s.output;
    return scope;
  }

  private frame(ctx: RunCtx, flow: FlowDoc, depth: number, parentStepId: number | undefined, scope: TemplateScope, parentSignal: AbortSignal): Frame {
    const edges = new Map<string, FlowEdge[]>();
    for (const e of flow.edges) {
      const k = edgeKey(e.from, e.port ?? 'out');
      edges.set(k, [...(edges.get(k) ?? []), e]);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
    return { uid: ++ctx.frameSeq, flow, depth, parentStepId, nodes: new Map(flow.nodes.map((n) => [n.id, n])), edges, scope, controller };
  }

  private count(run: FlowRun): void {
    const c = { passed: 0, failed: 0, skipped: 0, total: run.steps.length };
    for (const s of run.steps) {
      if (s.status === 'passed') c.passed++;
      else if (s.status === 'failed') c.failed++;
      else if (s.status === 'skipped') c.skipped++;
    }
    run.counts = c;
  }

  /* ───────────── emitting ───────────── */

  private touch(ctx: RunCtx, step: FlowRunStep): void {
    ctx.dirty.set(step.id, step);
    if (ctx.flushTimer) return;
    ctx.flushTimer = setTimeout(() => this.flush(ctx), EMIT_INTERVAL_MS);
    ctx.flushTimer.unref?.();
  }

  private flush(ctx: RunCtx): void {
    if (ctx.flushTimer) clearTimeout(ctx.flushTimer);
    ctx.flushTimer = undefined;
    this.count(ctx.run);
    const steps = [...ctx.dirty.values()].map((s) => structuredClone(s));
    ctx.dirty.clear();
    try {
      this.deps.emit({ run: runHeader(ctx.run), steps });
    } catch (err) {
      this.deps.logger.error(`flow run emit failed: ${(err as Error).message}`);
    }
  }

  /* ───────────── graph walk ───────────── */

  private stopRun(ctx: RunCtx, message: string, code: string, params?: I18nParams): void {
    ctx.stop ??= { status: 'failed', message, code, ...(params ? { params } : {}) };
    ctx.controller.abort();
  }

  private newStep(ctx: RunCtx, frame: Frame, node: FlowNode, token: Token): FlowRunStep {
    const spec = flowNodeSpec(node.type);
    const step: FlowRunStep = {
      id: ++ctx.stepSeq,
      nodeId: node.id,
      type: node.type,
      label: node.label || spec?.title || node.type,
      flowId: frame.flow.id,
      depth: frame.depth,
      status: 'running',
      startedAt: this.deps.now(),
    };
    const parent = token.parentStepId ?? frame.parentStepId;
    if (parent !== undefined) step.parentStepId = parent;
    if (token.iteration !== undefined) step.iteration = token.iteration;
    ctx.run.steps.push(step);
    this.touch(ctx, step);
    return step;
  }

  private finish(ctx: RunCtx, step: FlowRunStep, status: FlowRunStep['status'], result: Partial<StepResult> & { error?: string; errorCode?: string } = {}): void {
    const secrets = ctx.prepared.secrets;
    if (status === 'failed' && step.status !== 'failed') ctx.failedSteps++;
    step.status = status;
    step.endedAt = this.deps.now();
    step.durationMs = step.endedAt - step.startedAt;
    if (result.port) step.port = result.port;
    if (result.summary !== undefined) step.summary = maskSecrets(result.summary, secrets);
    if (result.code) step.code = result.code;
    if (result.params) step.params = maskSecrets(result.params, secrets);
    if (result.netId) step.netId = result.netId;
    if (result.output !== undefined) {
      step.output = maskSecrets(storedOutput(result.output), secrets);
      this.budgetOutput(ctx, step);
    }
    if (result.error !== undefined) step.error = maskSecrets(result.error, secrets);
    if (result.errorCode) step.errorCode = result.errorCode;
    this.touch(ctx, step);
  }

  /**
   * Keeps a run file small when a loop runs a step many times (300 polls of a large response): past
   * MAX_RUN_OUTPUT_CHARS, the outputs of earlier runs of steps that ran again are dropped, oldest first; the
   * latest KEEP_RECENT_OUTPUTS outputs and each step's latest output stay. Templates read the live scope, not these.
   */
  private budgetOutput(ctx: RunCtx, step: FlowRunStep): void {
    const chars = jsonSize(step.output);
    const key = `${step.flowId ?? ''}\u0000${step.nodeId}`;
    ctx.outputs.push({ step, chars, key });
    ctx.outputChars += chars;
    ctx.outputKeys.set(key, (ctx.outputKeys.get(key) ?? 0) + 1);
    if (ctx.outputChars <= MAX_RUN_OUTPUT_CHARS) return;
    const target = MAX_RUN_OUTPUT_CHARS * 0.8;
    const keepFrom = ctx.outputs.length - KEEP_RECENT_OUTPUTS;
    const kept: RunCtx['outputs'] = [];
    for (let i = 0; i < ctx.outputs.length; i++) {
      const o = ctx.outputs[i]!;
      const count = ctx.outputKeys.get(o.key) ?? 0;
      if (ctx.outputChars > target && i < keepFrom && count > 1) {
        o.step.output = DROPPED_OUTPUT;
        o.step.outputTrimmed = true;
        ctx.outputChars -= o.chars;
        ctx.outputKeys.set(o.key, count - 1);
        continue;
      }
      kept.push(o);
    }
    ctx.outputs = kept;
  }

  private async follow(ctx: RunCtx, frame: Frame, node: FlowNode, port: FlowPort | undefined, token: Token, step: FlowRunStep, logId: number, extra: Partial<Token> = {}): Promise<void> {
    if (!port || frame.controller.signal.aborted) return;
    const edges = frame.edges.get(edgeKey(node.id, port)) ?? [];
    if (edges.length === 0) return;
    const next: Omit<Token, 'nodeId'> = {
      previousAt: step.startedAt,
      previousLogId: logId,
      loops: token.loops,
      iteration: token.iteration,
      parentStepId: token.parentStepId,
      loopKey: token.loopKey,
      ...extra,
    };
    await Promise.all(edges.map((e) => this.visit(ctx, frame, { ...next, nodeId: e.to })));
  }

  private async visit(ctx: RunCtx, frame: Frame, token: Token): Promise<void> {
    if (frame.controller.signal.aborted) return;
    const node = frame.nodes.get(token.nodeId);
    if (!node) return;
    if (token.loops.includes(node.id)) return; // back at an active repeat: this iteration is over
    const spec = flowNodeSpec(node.type);

    if (ctx.run.steps.length >= MAX_RUN_STEPS) {
      this.stopRun(ctx, `The run reached ${MAX_RUN_STEPS} steps; check the flow for an endless loop`, 'flow.limit.steps', { count: MAX_RUN_STEPS });
      return;
    }
    // Per frame and repeat iteration: a cycle of edges is capped, nested repeats are not (MAX_RUN_STEPS caps the run).
    const visitKey = `${frame.uid}\u0000${token.loopKey ?? ''}\u0000${node.id}`;
    const visits = (ctx.visits.get(visitKey) ?? 0) + 1;
    ctx.visits.set(visitKey, visits);
    if (visits > MAX_NODE_VISITS) {
      this.stopRun(ctx, `Step ${node.id} ran ${MAX_NODE_VISITS} times; check the flow for an endless loop`, 'flow.limit.visits', { node: node.id, count: MAX_NODE_VISITS });
      return;
    }

    const logId = this.lastLogId;
    const step = this.newStep(ctx, frame, node, token);

    if (node.disabled) {
      // A later step reading this one gets empty values, not an "unknown name" failure.
      frame.scope[node.id] = { skipped: true };
      this.finish(ctx, step, 'skipped', { summary: 'Turned off', code: 'flow.step.disabled' });
      await this.follow(ctx, frame, node, defaultPort(node), token, step, logId);
      return;
    }
    if (!spec) {
      this.fail(ctx, frame, node, step, new StepError(`Unknown step type ${node.type}`, 'flow.node.unknownType', { type: node.type }));
      return;
    }

    const reason = unsupportedReason(node, this.liveTarget(ctx), ctx.prepared.slackConfigured);
    if (reason) {
      if ((ctx.prepared.flow.settings?.onUnsupported ?? 'skip') === 'skip') {
        frame.scope[node.id] = { skipped: true };
        step.unsupported = reason.code;
        this.finish(ctx, step, 'skipped', { summary: reason.message, code: reason.code, params: reason.params });
        await this.follow(ctx, frame, node, defaultPort(node), token, step, logId);
      } else {
        this.fail(ctx, frame, node, step, new StepError(reason.message, reason.code, reason.params));
      }
      return;
    }

    if (node.type === 'logic.repeat') return this.repeat(ctx, frame, node, step, token, logId);
    if (node.type === 'flow.end') {
      const status = String(node.params?.status ?? 'passed') === 'failed' ? 'failed' : 'passed';
      let message: string | undefined;
      try {
        message = resolveText(node.params?.message ?? '', frame.scope, { strict: false }).trim() || undefined;
      } catch {
        message = undefined;
      }
      this.finish(ctx, step, status === 'failed' ? 'failed' : 'passed', {
        summary: message ?? (status === 'passed' ? 'Ended: passed' : 'Ended: failed'),
        code: status === 'passed' ? 'flow.step.endPassed' : 'flow.step.endFailed',
        ...(message ? { params: { message } } : {}),
        ...(status === 'failed' ? { error: message ?? 'The flow ended as failed', errorCode: 'flow.end.failed' } : {}),
      });
      frame.end ??= { status, message };
      frame.controller.abort();
      return;
    }

    const exec = node.type === 'flow.call' ? (api: StepApi) => this.callFlow(ctx, frame, node, step, api) : EXECUTORS[node.type];
    if (!exec) {
      this.fail(ctx, frame, node, step, new StepError(`Unknown step type ${node.type}`, 'flow.node.unknownType', { type: node.type }));
      return;
    }

    const attempts = 1 + Math.max(0, Math.min(Math.floor(node.retry?.count ?? 0), 100));
    const timeoutMs = node.timeoutMs ?? spec.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempts > 1) step.attempts = attempt;
      const stepController = new AbortController();
      let timedOut = false;
      const onFrameAbort = () => stepController.abort();
      frame.controller.signal.addEventListener('abort', onFrameAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        stepController.abort();
      }, timeoutMs);
      timer.unref?.();
      const state = { abandoned: false };
      try {
        const api = this.api(ctx, frame, node, step, token, logId, stepController.signal, state);
        // A device action or a fetch that ignores the signal must not hold the step past its timeout or a stop:
        // the step ends at once and the action finishes in the background (its result is dropped). Sub-flows
        // stop through their own steps.
        const running = (async () => exec(api))();
        const result = node.type === 'flow.call' ? await running : await raceSignal(running, stepController.signal);
        if (stepController.signal.aborted && !timedOut) throw new AbortedError();
        if (timedOut) throw new StepError(`Did not finish within ${Math.round(timeoutMs / 1000)} s`, 'flow.step.timeout', { seconds: Math.round(timeoutMs / 1000) });
        frame.scope[node.id] = result.output ?? {};
        this.finish(ctx, step, 'passed', { ...result, port: result.port ?? 'out' });
        await this.follow(ctx, frame, node, result.port ?? 'out', token, step, logId);
        return;
      } catch (err) {
        if (stepController.signal.aborted) state.abandoned = true;
        if (frame.controller.signal.aborted) {
          this.finish(ctx, step, 'cancelled', { summary: 'Stopped', code: 'flow.step.cancelled' });
          return;
        }
        lastError = timedOut && !(err instanceof StepError && err.code === 'flow.step.timeout') ? new StepError(`Did not finish within ${Math.round(timeoutMs / 1000)} s`, 'flow.step.timeout', { seconds: Math.round(timeoutMs / 1000) }) : err;
        if (attempt < attempts) {
          const e = toStepError(lastError);
          step.summary = maskSecrets(`Attempt ${attempt} failed: ${e.message}`, ctx.prepared.secrets);
          step.code = 'flow.step.retrying';
          step.params = { attempt, error: maskSecrets(e.message, ctx.prepared.secrets) };
          this.touch(ctx, step);
          try {
            await sleep(node.retry?.delayMs ?? 1_000, frame.controller.signal);
          } catch {
            this.finish(ctx, step, 'cancelled', { summary: 'Stopped', code: 'flow.step.cancelled' });
            return;
          }
        }
      } finally {
        clearTimeout(timer);
        frame.controller.signal.removeEventListener('abort', onFrameAbort);
      }
    }
    await this.handleFailure(ctx, frame, node, step, token, logId, toStepError(lastError));
  }

  private async handleFailure(ctx: RunCtx, frame: Frame, node: FlowNode, step: FlowRunStep, token: Token, logId: number, err: StepError): Promise<void> {
    const errorEdges = frame.edges.get(edgeKey(node.id, 'error')) ?? [];
    const output = { ...(isRecord(err.output) ? err.output : {}), error: err.message, errorCode: err.code };
    if (errorEdges.length > 0 || node.continueOnError) {
      step.handled = true;
      frame.scope[node.id] = output;
      // A condition that could not be evaluated did not hold.
      const port: FlowPort | undefined = errorEdges.length > 0 ? 'error' : node.type === 'logic.condition' ? 'false' : defaultPort(node);
      this.finish(ctx, step, 'failed', { port, output, error: err.message, errorCode: err.code, params: err.params, netId: err.netId, summary: err.message, code: err.code });
      await this.follow(ctx, frame, node, port, token, step, logId);
      return;
    }
    frame.scope[node.id] = output;
    this.fail(ctx, frame, node, step, err);
  }

  /** An unhandled failure: the step fails and its frame (the run, or the sub-flow) stops. */
  private fail(ctx: RunCtx, frame: Frame, node: FlowNode, step: FlowRunStep, err: StepError): void {
    const output = err.output !== undefined ? { ...(isRecord(err.output) ? err.output : { value: err.output }), error: err.message } : undefined;
    this.finish(ctx, step, 'failed', { error: err.message, errorCode: err.code, params: err.params, netId: err.netId, summary: err.message, code: err.code, ...(output ? { output } : {}) });
    frame.failure ??= { message: err.message, code: err.code, params: err.params, nodeId: node.id };
    frame.controller.abort();
  }

  /* ───────────── special nodes ───────────── */

  private async repeat(ctx: RunCtx, frame: Frame, node: FlowNode, step: FlowRunStep, token: Token, logId: number): Promise<void> {
    let countValue: unknown;
    let until: FlowConditionRule[] = [];
    let delayMs = 0;
    try {
      countValue = resolveDeep(node.params?.count ?? 3, frame.scope);
      until = Array.isArray(node.params?.until) ? (node.params!.until as FlowConditionRule[]) : [];
      delayMs = Math.max(0, Number(resolveDeep(node.params?.delayMs ?? 0, frame.scope)) || 0);
    } catch (err) {
      await this.handleFailure(ctx, frame, node, step, token, logId, toStepError(err));
      return;
    }
    const count = repeatCount(countValue);
    if ('error' in count) {
      await this.handleFailure(ctx, frame, node, step, token, logId, count.error);
      return;
    }
    const { items, n } = count;

    // The loop body runs in a view of the frame with its own stop: the repeat's time limit ends the loop, not
    // the frame. A failure or an end inside the body still reaches (and stops) the frame.
    const timeoutMs = node.timeoutMs ?? flowNodeSpec(node.type)?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const loopController = new AbortController();
    const onFrameAbort = () => loopController.abort();
    frame.controller.signal.addEventListener('abort', onFrameAbort, { once: true });
    if (frame.controller.signal.aborted) loopController.abort();
    const body: Frame = Object.create(frame, {
      controller: { value: loopController },
      failure: {
        get: () => frame.failure,
        set: (v: Failure) => {
          frame.failure ??= v;
          frame.controller.abort();
        },
      },
      end: {
        get: () => frame.end,
        set: (v: Frame['end']) => {
          frame.end ??= v;
          frame.controller.abort();
        },
      },
    }) as Frame;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      loopController.abort();
    }, timeoutMs);
    timer.unref?.();

    // {{item}} of an enclosing list repeat comes back after this one.
    const hadItem = Object.prototype.hasOwnProperty.call(frame.scope, 'item');
    const outerItem = frame.scope.item;
    const restoreItem = () => {
      if (!items) return;
      if (hadItem) frame.scope.item = outerItem;
      else delete frame.scope.item;
    };

    let met = false;
    let i = 0;
    try {
      for (; i < n; i++) {
        if (loopController.signal.aborted) break;
        frame.scope[node.id] = { index: i, iterations: i, met: false, ...(items ? { item: items[i] } : {}) };
        if (items) frame.scope.item = items[i];
        step.summary = `Iteration ${i + 1} of ${n}`;
        step.code = 'flow.step.iteration';
        step.params = { index: i + 1, count: n };
        this.touch(ctx, step);
        const loopKey = `${token.loopKey ?? ''}/${node.id}#${i}`;
        await this.follow(ctx, body, node, 'loop', token, step, logId, { loops: [...token.loops, node.id], iteration: i, parentStepId: step.id, loopKey });
        if (loopController.signal.aborted) break;
        if (until.length > 0) {
          let ok = false;
          try {
            ok = evaluateRules(until, 'all', frame.scope, { strict: false }).ok;
          } catch {
            ok = false;
          }
          if (ok) {
            met = true;
            i++;
            break;
          }
        }
        if (delayMs > 0 && i < n - 1) {
          try {
            await sleep(delayMs, loopController.signal);
          } catch {
            break;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      frame.controller.signal.removeEventListener('abort', onFrameAbort);
      restoreItem();
    }
    if (frame.controller.signal.aborted) {
      this.finish(ctx, step, 'cancelled', { summary: `Stopped at iteration ${Math.min(i + 1, n)} of ${n}`, code: 'flow.step.iterationStopped', params: { index: Math.min(i + 1, n), count: n } });
      return;
    }
    const output = { index: Math.max(0, i - 1), iterations: i, met };
    frame.scope[node.id] = output;
    if (timedOut) {
      const seconds = Math.round(timeoutMs / 1000);
      await this.handleFailure(ctx, frame, node, step, token, logId, new StepError(`Did not finish within ${seconds} s`, 'flow.step.timeout', { seconds }, output));
      return;
    }
    if (node.params?.failIfNotMet === true && until.length > 0 && !met) {
      await this.handleFailure(ctx, frame, node, step, token, logId, new StepError(`The condition did not hold within ${n} iterations`, 'flow.repeat.notMet', { count: n }, output));
      return;
    }
    this.finish(ctx, step, 'passed', {
      port: 'done',
      output,
      summary: until.length ? `${i} iteration${i === 1 ? '' : 's'} · ${met ? 'condition met' : 'condition not met'}` : `${i} iteration${i === 1 ? '' : 's'}`,
      code: until.length ? (met ? 'flow.step.repeatMet' : 'flow.step.repeatNotMet') : 'flow.step.repeated',
      params: { count: i },
    });
    await this.follow(ctx, frame, node, 'done', token, step, logId);
  }

  private async callFlow(ctx: RunCtx, frame: Frame, node: FlowNode, step: FlowRunStep, api: StepApi): Promise<StepResult> {
    const flowId = api.text('flowId').trim();
    const sub = this.deps.flows.get(flowId);
    if (!sub) throw new StepError(`The flow "${flowId}" does not exist`, 'flow.call.unknown', { flow: flowId });
    if (frame.depth + 1 >= MAX_CALL_DEPTH) throw new StepError(`Sub-flows go at most ${MAX_CALL_DEPTH} levels deep`, 'flow.call.depth', { max: MAX_CALL_DEPTH });
    const mapping = (api.value('inputs') ?? {}) as Record<string, unknown>;
    const inputs: Record<string, unknown> = {};
    const env = isRecord(frame.scope.env) ? frame.scope.env : {};
    for (const def of sub.inputs ?? []) {
      const given = mapping[def.name] !== undefined && mapping[def.name] !== '';
      const v = given ? mapping[def.name] : resolveInputDefault(def.default, env, inputs);
      if (v === undefined || v === '') {
        if (def.required) throw new StepError(`${sub.name} needs the input "${def.name}"`, 'flow.call.input', { flow: sub.name, name: def.name });
        continue;
      }
      inputs[def.name] = v;
      // A secret input of the sub-flow is masked like the run's own secrets.
      if (def.secret && typeof v === 'string') {
        for (const s of expandSecrets([v])) if (!ctx.prepared.secrets.includes(s)) ctx.prepared.secrets.push(s);
      }
    }
    for (const [k, v] of Object.entries(mapping)) if (!(k in inputs)) inputs[k] = v;
    const shared = { env: frame.scope.env, target: frame.scope.target, trigger: frame.scope.trigger, run: frame.scope.run };
    const child = this.frame(ctx, sub, frame.depth + 1, step.id, { ...shared, input: inputs, vars: {} }, api.signal);
    const starts = startNodes(sub);
    const logId = this.lastLogId;
    await Promise.all(starts.map((id) => this.visit(ctx, child, { nodeId: id, previousAt: api.since.previousAt, previousLogId: logId, loops: [] })));
    if (api.signal.aborted && !child.end && !child.failure) throw new AbortedError();
    const outputs: Record<string, unknown> = {};
    for (const o of sub.outputs ?? []) {
      try {
        outputs[o.name] = resolveTemplate(o.value, child.scope, { strict: false });
      } catch {
        outputs[o.name] = undefined;
      }
    }
    if (child.failure) {
      throw new StepError(`${sub.name}: ${child.failure.message}`, 'flow.call.failed', { flow: sub.name, error: child.failure.message }, { status: 'failed', outputs, error: child.failure.message });
    }
    if (child.end?.status === 'failed') {
      throw new StepError(`${sub.name} ended as failed${child.end.message ? `: ${child.end.message}` : ''}`, 'flow.call.failed', { flow: sub.name, error: child.end.message ?? '' }, { status: 'failed', outputs });
    }
    return { output: { status: 'passed', outputs }, summary: `${sub.name}: passed`, code: 'flow.step.subflowPassed', params: { flow: sub.name } };
  }

  /* ───────────── step api ───────────── */

  /** The run's target with the device as it is now (devices come and go during a run). */
  private liveTarget(ctx: RunCtx): ResolvedTarget {
    const t = ctx.prepared.target;
    if (!t.device) return t;
    const now = this.deps.hub.getDevice(t.device.id);
    return { ...t, device: now ?? { ...t.device, state: 'disconnected' } };
  }

  /** `state.abandoned`: the step already ended (timeout, stop) while its work goes on; what it does then is dropped. */
  private api(ctx: RunCtx, frame: Frame, node: FlowNode, step: FlowRunStep, token: Token, logId: number, signal: AbortSignal, state: { abandoned: boolean }): StepApi {
    const spec = flowNodeSpec(node.type)!;
    const deps = this.deps;
    const engine = this;
    const paramSpec = (name: string) => spec.params.find((p) => p.name === name);
    const raw = (name: string) => (node.params?.[name] !== undefined ? node.params[name] : paramSpec(name)?.default);
    const resolve = (v: unknown) => resolveDeep(v, frame.scope);
    const target = ctx.prepared.target;
    return {
      node,
      spec,
      signal,
      services: deps,
      run: ctx.run,
      scope: frame.scope,
      flowRecordRequests: ctx.prepared.flow.settings?.recordRequests !== false,
      since: { previousAt: token.previousAt, previousLogId: token.previousLogId, stepAt: step.startedAt, stepLogId: logId, runAt: ctx.run.startedAt, runLogId: ctx.logIdAtStart },
      param: raw,
      value: (name) => resolve(raw(name)),
      text: (name) => {
        const v = resolve(raw(name));
        return v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      },
      num: (name, fallback) => {
        const v = resolve(raw(name));
        const n = typeof v === 'number' ? v : Number(v);
        if (v === undefined || v === '' || !Number.isFinite(n)) {
          if (v === undefined || v === '') return fallback;
          throw new StepError(`${name} must be a number (got ${shortText(v, 40)})`, 'flow.param.type', { param: name, expected: 'number' });
        }
        return n;
      },
      bool: (name, fallback) => {
        const v = resolve(raw(name));
        if (typeof v === 'boolean') return v;
        if (v === 'true' || v === 1) return true;
        if (v === 'false' || v === 0) return false;
        return fallback;
      },
      resolve,
      setVar: (name, value) => {
        if (state.abandoned) return;
        (frame.scope.vars as Record<string, unknown>)[name] = value;
      },
      deviceId: () => {
        const d = target.device?.id;
        if (!d) throw new StepError('This step needs a device; choose one for the run', 'flow.device.missing');
        return d;
      },
      appId: () => target.appId,
      waitSdk: async (cap: SdkCapability, maxWaitMs = SDK_WAIT_MS) => {
        const deviceId = target.device?.id;
        const started = Date.now();
        for (;;) {
          const s = sdkSession(deps.hub, deviceId, target.appId, cap);
          if (s || Date.now() - started >= maxWaitMs || signal.aborted) return s;
          await sleep(250, signal).catch(() => undefined);
        }
      },
      latestLogId: () => engine.lastLogId,
      netSeenAt: (id) => engine.netSeenAt(id),
      addEvidence: (file, kind, name) => {
        // Cleanups (a recording stopped at the end) may still attach files; an abandoned step's late result may not.
        if (state.abandoned && !ctx.cleaning) return Promise.reject(new AbortedError());
        return engine.addEvidence(ctx, step, file, kind, name);
      },
      addCleanup: (key, fn) => {
        if (ctx.cleanedUp) {
          // An abandoned step got this far after the run's cleanup: undo its work now.
          void fn().catch((err: unknown) => deps.logger.warn(`run ${ctx.run.id}: late cleanup ${key} failed: ${(err as Error).message}`));
          return;
        }
        if (!ctx.cleanups.has(key)) ctx.cleanups.set(key, fn);
      },
      recordings: ctx.recordings,
      summarySoFar: () => engine.summaryLine(ctx),
      mask: (value) => maskSecrets(value, ctx.prepared.secrets),
    };
  }

  private async addEvidence(ctx: RunCtx, step: FlowRunStep, file: string, kind: FlowEvidence['kind'], name: string): Promise<FlowEvidence> {
    const dir = this.deps.runs.evidenceDir(ctx.run.id);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const ext = path.extname(file).slice(0, 10) || (kind === 'video' ? '.mp4' : '.png');
    let fileName = `${step.id}-${safeFileName(name, kind)}${ext}`;
    for (let n = 2; await exists(path.join(dir, fileName)); n++) fileName = `${step.id}-${safeFileName(name, kind)}-${n}${ext}`;
    await fsp.copyFile(file, path.join(dir, fileName));
    const ev: FlowEvidence = { kind, name, url: `/api/flow-runs/${ctx.run.id}/files/${encodeURIComponent(fileName)}` };
    step.evidence = [...(step.evidence ?? []), ev];
    this.touch(ctx, step);
    return ev;
  }

  private summaryLine(ctx: RunCtx): string {
    this.count(ctx.run);
    const c = ctx.run.counts;
    const t = ctx.run.target;
    const failed = ctx.run.steps.filter((s) => s.status === 'failed' && !s.handled).map((s) => s.label ?? s.nodeId);
    const parts = [`${c.passed} passed`, `${c.failed} failed`, `${c.skipped} skipped`];
    const where = t ? [t.deviceName, t.appName ?? t.appId].filter(Boolean).join(' · ') : '';
    return [`${ctx.run.flowName}: ${parts.join(', ')}`, where, failed.length ? `Failed: ${failed.join(', ')}` : ''].filter(Boolean).join('\n');
  }

  /** Undo what the run set up (once, whoever asks first: the run's end or shutdown). */
  private cleanup(ctx: RunCtx): Promise<void> {
    ctx.cleanupDone ??= this.runCleanups(ctx);
    return ctx.cleanupDone;
  }

  /** Newest first; mock rules before anything slow (a recording to stop and copy). */
  private async runCleanups(ctx: RunCtx): Promise<void> {
    const list = [...ctx.cleanups.entries()].reverse();
    ctx.cleanups.clear();
    const isMock = (key: string) => key.startsWith('mock');
    list.sort((a, b) => Number(isMock(b[0])) - Number(isMock(a[0])));
    ctx.cleaning = true;
    try {
      for (const [key, fn] of list) {
        try {
          await Promise.race([fn(), sleep(4 * 60_000)]);
        } catch (err) {
          this.deps.logger.warn(`run ${ctx.run.id}: cleanup ${key} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      ctx.cleaning = false;
      ctx.cleanedUp = true;
    }
  }
}

/**
 * Iterations of a repeat: a list runs once per element (also a JSON list in text, as a template of a text
 * field gives it), a number that many times (0 = none, at most 1000); anything else is a mistake in the flow.
 */
function repeatCount(value: unknown): { items?: unknown[]; n: number } | { error: StepError } {
  let v = value;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) v = parsed;
    } catch {
      /* not a list: checked as a number below */
    }
  }
  if (Array.isArray(v)) {
    const items = v.slice(0, 1_000);
    return { items, n: items.length };
  }
  const num = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(num)) {
    return { error: new StepError(`count must be a number or a list (got ${shortText(v, 40)})`, 'flow.param.type', { param: 'count', expected: 'numberOrList' }) };
  }
  return { n: Math.max(0, Math.min(1_000, Math.floor(num))) };
}

/** A scope copy that shares nothing with the original (plain JSON when a value cannot be cloned). */
function cloneScope(scope: TemplateScope): TemplateScope {
  try {
    return structuredClone(scope);
  } catch {
    try {
      return JSON.parse(JSON.stringify(scope)) as TemplateScope;
    } catch {
      return { ...scope };
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toStepError(err: unknown): StepError {
  if (err instanceof StepError) return err;
  if (err instanceof TemplateError) {
    const code = err.code === 'template.unknownRoot' ? 'flow.template.unknownRoot' : err.code === 'template.syntax' ? 'flow.template.syntax' : `flow.${err.code}`;
    return new StepError(`${err.message} in {{${err.ref}}}`, code, { ref: err.ref });
  }
  if (isAbortError(err)) return new StepError('Stopped', 'flow.step.cancelled');
  const e = err as { message?: string; code?: unknown };
  const message = e?.message ?? String(err);
  const code = typeof e?.code === 'string' && /^[a-z][\w-]*\.[\w.-]+$/.test(e.code) ? e.code : 'flow.step.error';
  return new StepError(message, code, code === 'flow.step.error' ? { error: message } : undefined);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
