/**
 * Before a run: which device and app, which environment and inputs, and what each step will do there —
 * steps the device cannot run (skipped or failing, per `settings.onUnsupported`), steps that are hard to undo,
 * missing environment variables and inputs. The same checks run again per step while the run goes.
 */
import {
  flowNodeSpec,
  parsePath,
  resolveTemplate,
  templateExpressions,
  validateFlow,
  type FlowDoc,
  type FlowEnvironment,
  type FlowNode,
  type FlowPreflight,
  type FlowPreflightIssue,
  type FlowRunRequest,
} from '@durbun/protocol';
import type { Hub } from '../types';
import type { EnvironmentStore } from './environments';
import type { FlowStore } from './store';
import { flowNeedsDevice, resolveTarget, unsupportedReason, type ResolvedTarget } from './target';
import { expandSecrets } from './util';

export const MAX_CALL_DEPTH = 8;

export interface PrepareDeps {
  hub: Pick<Hub, 'getDevices' | 'getDevice' | 'getApps' | 'getDeviceApps'>;
  flows: Pick<FlowStore, 'get' | 'ids'>;
  envs: Pick<EnvironmentStore, 'resolve'>;
  slackConfigured(): Promise<boolean>;
}

export interface PreparedRun {
  flow: FlowDoc;
  preflight: FlowPreflight;
  target: ResolvedTarget;
  environment?: FlowEnvironment;
  inputs: Record<string, unknown>;
  /** Values masked in step outputs and reports. */
  secrets: string[];
  startNodes: string[];
  slackConfigured: boolean;
}

/** Where a run starts: `startNodeId`, the event trigger that fired, else the manual triggers (else every root). */
export function startNodes(flow: FlowDoc, opts: { startNodeId?: string; triggerNodeId?: string } = {}): string[] {
  if (opts.startNodeId && flow.nodes.some((n) => n.id === opts.startNodeId)) return [opts.startNodeId];
  if (opts.triggerNodeId && flow.nodes.some((n) => n.id === opts.triggerNodeId)) return [opts.triggerNodeId];
  const live = flow.nodes.filter((n) => !n.disabled);
  const manual = live.filter((n) => n.type === 'trigger.manual').map((n) => n.id);
  if (manual.length) return manual;
  const triggers = live.filter((n) => n.type === 'trigger.event').map((n) => n.id);
  if (triggers.length) return triggers;
  const incoming = new Set(flow.edges.map((e) => e.to));
  return live.filter((n) => !incoming.has(n.id)).map((n) => n.id);
}

/** Nodes a run can reach from `starts` (any port). */
export function reachable(flow: FlowDoc, starts: string[]): FlowNode[] {
  const out = new Map<string, string[]>();
  for (const e of flow.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const to of out.get(id) ?? []) stack.push(to);
  }
  return flow.nodes.filter((n) => seen.has(n.id));
}

/**
 * An input's default as the run gets it: templates resolved with the helpers ({{$timestamp}}), the environment
 * and the inputs before it, non-strictly ("qa+{{$timestamp}}@example.com" → a fresh address per run).
 */
export function resolveInputDefault(value: unknown, env: Record<string, unknown>, inputs: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  try {
    return resolveTemplate(value, { env, input: inputs }, { strict: false });
  } catch {
    return value;
  }
}

/** `env.<key>` names the node's parameters read. */
export function envKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const expr of templateExpressions(value)) {
      const head = expr.split('|')[0]!.trim();
      if (!/^env\b/.test(head)) continue;
      try {
        const seg = parsePath(head.slice(3))[0];
        if (typeof seg === 'string') into.add(seg);
      } catch {
        /* syntax problems are validation's business */
      }
    }
  } else if (Array.isArray(value)) value.forEach((v) => envKeys(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => envKeys(v, into));
  return into;
}

export async function prepareRun(
  deps: PrepareDeps,
  flow: FlowDoc,
  request: FlowRunRequest,
  opts: { triggerNodeId?: string } = {},
): Promise<PreparedRun> {
  const issues: FlowPreflightIssue[] = [];
  const irreversible: string[] = [];
  const skipped: string[] = [];
  // A sub-flow called from several steps is checked once per call path; its issues are listed once.
  const seenIssues = new Set<string>();
  const addIssue = (i: FlowPreflightIssue) => {
    const key = [i.level, i.code, i.flowId ?? '', i.nodeId ?? '', i.message].join('\u0000');
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push(i);
  };
  const addOnce = (list: string[], ref: string) => {
    if (!list.includes(ref)) list.push(ref);
  };

  const { issues: flowIssues } = validateFlow(flow, { knownFlowIds: deps.flows.ids(), addTrigger: false });
  for (const i of flowIssues.filter((x) => x.level === 'error').slice(0, 20)) {
    // `issue` + its params let the UI word the problem itself; `problem` is the English fallback.
    issues.push({ level: 'error', code: 'preflight.flow.invalid', message: i.message, nodeId: i.nodeId, params: { ...i.params, problem: i.message, issue: i.code } });
  }

  // "Run from here" on a step that is gone (an older editor state) must not run the whole flow instead.
  const unknownStart = !!request.startNodeId && !flow.nodes.some((n) => n.id === request.startNodeId);
  const starts = unknownStart ? [] : startNodes(flow, { startNodeId: request.startNodeId, triggerNodeId: opts.triggerNodeId });
  if (unknownStart) {
    issues.push({ level: 'error', code: 'preflight.start.unknown', message: `The step ${request.startNodeId} to start from is not in the flow`, params: { node: request.startNodeId ?? '' } });
  } else if (starts.length === 0) issues.push({ level: 'error', code: 'preflight.flow.noStart', message: 'The flow has no step to start from' });

  const needs = flowNeedsDevice(flow, (id) => deps.flows.get(id));
  const { target, issues: targetIssues } = resolveTarget(deps.hub, flow, request.target, needs);
  issues.push(...targetIssues);
  const slackConfigured = await deps.slackConfigured().catch(() => false);

  // Environment
  const environment = deps.envs.resolve(request.environmentId);
  if (request.environmentId && !environment) {
    issues.push({ level: 'error', code: 'preflight.env.unknown', message: `The environment ${request.environmentId} does not exist`, params: { env: request.environmentId } });
  }

  // Inputs
  const usedEnv = new Set<string>();
  const envValues: Record<string, unknown> = Object.fromEntries((environment?.vars ?? []).map((v) => [v.key, v.value]));
  const inputs: Record<string, unknown> = {};
  for (const def of flow.inputs ?? []) {
    const given = request.inputs?.[def.name];
    const useDefault = given === undefined || given === '';
    if (useDefault) envKeys(def.default, usedEnv);
    const v = useDefault ? resolveInputDefault(def.default, envValues, inputs) : given;
    if (v === undefined || v === '') {
      if (def.required) issues.push({ level: 'error', code: 'preflight.input.missing', message: `Input "${def.name}" is required`, params: { name: def.name } });
      continue;
    }
    inputs[def.name] = v;
  }
  for (const [k, v] of Object.entries(request.inputs ?? {})) if (!(k in inputs) && v !== undefined) inputs[k] = v;
  // Each secret also in the forms it takes on the way out (URL-encoded, base64, JSON-escaped).
  const secrets = expandSecrets([
    ...(environment?.vars.filter((v) => v.secret && v.value).map((v) => v.value) ?? []),
    ...(flow.inputs ?? []).filter((d) => d.secret && typeof inputs[d.name] === 'string').map((d) => inputs[d.name] as string),
  ]);

  // Steps of this flow and of the flows it calls
  const policy = flow.settings?.onUnsupported ?? 'skip';
  let deviceSkipped = 0;
  let worksWithoutDevice = 0;
  const visit = (doc: FlowDoc, from: string[], depth: number, seen: Set<string>) => {
    const sub = depth > 0;
    for (const node of reachable(doc, from)) {
      if (node.disabled) continue;
      const spec = flowNodeSpec(node.type);
      const ref = sub ? `${doc.id}:${node.id}` : node.id;
      envKeys(node.params, usedEnv);
      const reason = unsupportedReason(node, target, slackConfigured);
      if (reason) {
        const withFlow = sub ? { ...reason, flowId: doc.id, message: `${doc.name} › ${reason.message}` } : reason;
        if (policy === 'fail') addIssue({ ...withFlow, level: 'error' });
        else {
          addIssue(withFlow);
          if (!skipped.includes(ref)) {
            skipped.push(ref);
            if (reason.code === 'preflight.device.missing') deviceSkipped++;
          }
        }
        continue;
      }
      if (spec && (spec.group === 'http' || spec.group === 'mock' || node.type === 'check.assert' || node.type === 'output.slack')) worksWithoutDevice++;
      if (spec?.irreversible) addOnce(irreversible, ref);
      if (spec?.needs?.sdk && target.device) {
        const has = deps.hub.getApps().some((a) => a.connected && a.deviceId === target.device!.id && (!target.appId || a.app.id === target.appId) && a.capabilities.includes(spec.needs!.sdk!));
        if (!has) {
          addIssue({
            level: 'info',
            code: 'preflight.sdk.notConnected',
            message: `${spec.title} needs the app to be connected with the Dürbün SDK; it waits for it when the step starts`,
            nodeId: node.id,
            ...(sub ? { flowId: doc.id } : {}),
            params: { step: spec.title, capability: spec.needs.sdk },
          });
        }
      }
      if (node.type === 'flow.call') {
        const calledId = typeof node.params?.flowId === 'string' ? node.params.flowId : '';
        const called = deps.flows.get(calledId);
        const at = sub ? { flowId: doc.id } : {};
        if (!called) {
          addIssue({ level: 'error', code: 'preflight.call.unknown', message: `Step ${node.id} runs the flow "${calledId}", which does not exist`, nodeId: node.id, ...at, params: { flow: calledId } });
        } else if (seen.has(called.id)) {
          // A call cycle would only end at the depth limit, after running the same steps over and over.
          addIssue({ level: 'error', code: 'preflight.call.recursive', message: `${called.name} calls itself (directly or through other flows); remove the call that closes the circle`, nodeId: node.id, ...at, params: { flow: called.name } });
        } else if (depth + 1 >= MAX_CALL_DEPTH) {
          addIssue({ level: 'error', code: 'preflight.call.depth', message: `Sub-flows nest deeper than ${MAX_CALL_DEPTH} levels at ${called.name}`, nodeId: node.id, ...at, params: { flow: called.name, max: MAX_CALL_DEPTH } });
        } else {
          visit(called, startNodes(called), depth + 1, new Set([...seen, called.id]));
        }
      }
    }
  };
  visit(flow, starts, 0, new Set([flow.id]));
  // A start that leads nowhere would "pass" without doing anything.
  if (starts.length && !reachable(flow, starts).some((n) => !n.disabled && !n.type.startsWith('trigger.'))) {
    issues.push({ level: 'error', code: 'preflight.flow.empty', message: 'The start is not connected to any step, so there is nothing to run' });
  }

  // No device: a flow that still has work of its own (requests, checks, mocks, Slack) runs with its device steps
  // skipped; one that would only skip steps does not start.
  const noDevice = issues.findIndex((i) => i.level === 'error' && (i.code === 'preflight.device.none' || i.code === 'preflight.device.nonePlatform'));
  if (noDevice >= 0 && policy === 'skip' && worksWithoutDevice > 0) {
    issues[noDevice] = {
      level: 'warn',
      code: 'preflight.device.noneSkipped',
      message: `No device is connected; ${deviceSkipped} device step${deviceSkipped === 1 ? '' : 's'} will be skipped`,
      params: { count: deviceSkipped },
    };
  }

  if (usedEnv.size > 0) {
    if (!environment) {
      issues.push({
        level: 'error',
        code: 'preflight.env.none',
        message: `The flow reads environment variables (${[...usedEnv].join(', ')}) but no environment is chosen`,
        params: { keys: [...usedEnv].join(', ') },
      });
    } else {
      const missing = [...usedEnv].filter((k) => !environment.vars.some((v) => v.key === k));
      const empty = [...usedEnv].filter((k) => environment.vars.some((v) => v.key === k && v.value === ''));
      if (missing.length) {
        issues.push({
          level: 'error',
          code: 'preflight.env.missing',
          message: `${environment.name} has no ${missing.join(', ')}`,
          params: { env: environment.name, keys: missing.join(', ') },
        });
      }
      if (empty.length) issues.push({ level: 'warn', code: 'preflight.env.empty', message: `${empty.join(', ')} is empty in ${environment.name}`, params: { env: environment.name, keys: empty.join(', ') } });
    }
  }

  const preflight: FlowPreflight = { ok: !issues.some((i) => i.level === 'error'), issues, irreversible, skipped, target: target.info };
  return { flow, preflight, target, environment, inputs, secrets, startNodes: starts, slackConfigured };
}
