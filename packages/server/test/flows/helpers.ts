/** A flow engine over a real hub with fake device actions and a scripted fetch. */
import { rm } from 'node:fs/promises';
import type { DeviceActionId, FlowDoc, FlowRun, FlowRunDelta, MockRule } from '@durbun/protocol';
import { FLOW_FORMAT, FLOW_VERSION } from '@durbun/protocol';
import type { CommandReply } from '../../src/http/commands';
import { FlowEngine } from '../../src/flows/engine';
import { EnvironmentStore } from '../../src/flows/environments';
import { RunStore } from '../../src/flows/runs';
import { FlowStore } from '../../src/flows/store';
import type { Hub } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { makeTempDir } from '../http/fakes';
import { makeHub } from '../hub/helpers';

export type Handler = (req: { method: string; url: URL; headers: Headers; body: string }) => Response | Promise<Response>;

export interface Harness {
  dir: string;
  hub: Hub;
  flows: FlowStore;
  envs: EnvironmentStore;
  runs: RunStore;
  engine: FlowEngine;
  mocks: MockRule[];
  deltas: FlowRunDelta[];
  ended: FlowRun[];
  actions: { deviceId: string; action: DeviceActionId; params: Record<string, unknown> }[];
  requests: { method: string; url: string; headers: Record<string, string>; body: string }[];
  slackSent: string[];
  route(handler: Handler): void;
  onAction(fn: (action: DeviceActionId, params: Record<string, unknown>) => CommandReply | Promise<CommandReply>): void;
  setSlack(configured: boolean): void;
  save(flow: Partial<FlowDoc> & { nodes: FlowDoc['nodes'] }): Promise<FlowDoc>;
  /** Start and wait for the end. */
  run(flowId: string, request?: Parameters<FlowEngine['start']>[1], opts?: Parameters<FlowEngine['start']>[2]): Promise<FlowRun>;
  close(): Promise<void>;
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function harness(): Promise<Harness> {
  const dir = await makeTempDir('durbun-flows-');
  const hub = makeHub();
  const flows = new FlowStore(dir, silentLogger);
  const envs = new EnvironmentStore(dir, silentLogger);
  const runs = new RunStore(dir, silentLogger);
  let handler: Handler = () => new Response('not found', { status: 404 });
  let actionFn: (action: DeviceActionId, params: Record<string, unknown>) => CommandReply | Promise<CommandReply> = () => ({ ok: true, data: null });
  let slackConfigured = false;
  const h: Partial<Harness> = { dir, hub, flows, envs, runs, mocks: [], deltas: [], ended: [], actions: [], requests: [], slackSent: [] };
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
    const body = init.body ? Buffer.from(init.body as Uint8Array).toString('utf8') : '';
    h.requests!.push({ method: String(init.method ?? 'GET'), url: url.toString(), headers: Object.fromEntries(headers.entries()), body });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return handler({ method: String(init.method ?? 'GET'), url, headers, body });
  }) as typeof fetch;
  const engine = new FlowEngine({
    hub,
    logger: silentLogger,
    flows,
    envs,
    runs,
    slackConfigured: async () => slackConfigured,
    deviceAction: async (deviceId, action, params) => {
      h.actions!.push({ deviceId, action, params });
      return actionFn(action, params);
    },
    mocks: {
      get: () => h.mocks!,
      set: (rules) => {
        h.mocks = rules;
        return rules;
      },
    },
    slack: {
      status: async () => ({ configured: slackConfigured }),
      send: async (raw) => {
        h.slackSent!.push((raw as { text: string }).text);
      },
    },
    maxBodyBytes: () => 1_000_000,
    fetchImpl,
    now: () => Date.now(),
    emit: (d) => h.deltas!.push(d),
    runEnded: (r) => h.ended!.push(r),
  });
  Object.assign(h, {
    engine,
    route: (fn: Handler) => {
      handler = fn;
    },
    onAction: (fn: typeof actionFn) => {
      actionFn = fn;
    },
    setSlack: (v: boolean) => {
      slackConfigured = v;
    },
    save: async (flow: Partial<FlowDoc> & { nodes: FlowDoc['nodes'] }) => {
      const doc = { format: FLOW_FORMAT, version: FLOW_VERSION, id: 'f', name: 'Flow', edges: [], ...flow };
      const { flow: saved, issues } = await flows.save(doc, { create: !flows.get(doc.id) });
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) throw new Error(`invalid test flow: ${errors.map((e) => e.message).join('; ')}`);
      return saved;
    },
    run: async (flowId: string, request = {}, opts = {}) => {
      const run = await engine.start(flowId, request, opts);
      await engine.settle(run.id);
      return (await runs.get(run.id))!;
    },
    close: async () => {
      await engine.dispose();
      hub.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  });
  return h as Harness;
}

/** Chain node ids with 'out' edges. */
export function chain(...ids: string[]): FlowDoc['edges'] {
  return ids.slice(1).map((to, i) => ({ from: ids[i]!, to }));
}
