import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowNode, LogEntry, NetworkEntry, UiNotice } from '@durbun/protocol';
import { FlowTriggers, triggerMatches } from '../../src/flows/triggers';
import { silentLogger } from '../../src/util/logger';
import { appInput, device } from '../hub/helpers';
import { chain, harness, type Harness } from './helpers';

let h: Harness;
let triggers: FlowTriggers | undefined;
let notices: UiNotice[] = [];
let clock = 1_000_000;
beforeEach(async () => {
  h = await harness();
  notices = [];
  clock = 1_000_000;
});
afterEach(async () => {
  triggers?.dispose();
  triggers = undefined;
  await h.close();
});

const node = (params: Record<string, unknown>): FlowNode => ({ id: 't', type: 'trigger.event', params });
const log = (patch: Partial<LogEntry>): LogEntry => ({ id: 1, ts: 0, deviceId: 'android:A1', source: 'app', level: 'info', tag: 'x', message: 'hello', ...patch });
const req = (patch: Partial<NetworkEntry>): NetworkEntry =>
  ({ id: 'r', deviceId: 'android:A1', source: 'dio', method: 'GET', url: 'https://api.test/v1/cart', host: 'api.test', path: '/v1/cart', startTs: 0, state: 'complete', status: 200, ...patch }) as NetworkEntry;

describe('triggerMatches', () => {
  it('matches log text, levels, regexes and apps', () => {
    expect(triggerMatches(node({ event: 'logMatch', text: 'PAYMENT' }), { event: 'logMatch', log: log({ message: 'payment failed' }) })).toBe(true);
    expect(triggerMatches(node({ event: 'logMatch', text: 'x', level: 'error' }), { event: 'logMatch', log: log({ message: 'x', level: 'warn' }) })).toBe(false);
    expect(triggerMatches(node({ event: 'logMatch', text: '^order \\d+$', regex: true }), { event: 'logMatch', log: log({ message: 'order 42' }) })).toBe(true);
    expect(triggerMatches(node({ event: 'crash', appId: 'com.a' }), { event: 'crash', log: log({}), appId: 'com.b' })).toBe(false);
    expect(triggerMatches(node({ event: 'crash' }), { event: 'logMatch', log: log({}) })).toBe(false);
  });

  it('matches requests by method, URL and status', () => {
    const n = node({ event: 'networkMatch', method: 'POST', url: '/checkout', status: '5xx' });
    expect(triggerMatches(n, { event: 'networkMatch', request: req({ method: 'POST', url: 'https://x/checkout', status: 503 }) })).toBe(true);
    expect(triggerMatches(n, { event: 'networkMatch', request: req({ method: 'POST', url: 'https://x/checkout', status: 200 }) })).toBe(false);
    expect(triggerMatches(node({ event: 'networkError' }), { event: 'networkError', request: req({ state: 'failed' }) })).toBe(true);
  });
});

describe('automatic runs', () => {
  async function setup() {
    h.hub.upsertDevice(device('android:A1'));
    const app = h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    await h.save({
      id: 'oncrash',
      name: 'On crash',
      automation: { enabled: true, throttleMs: 60_000 },
      nodes: [
        { id: 'crashed', type: 'trigger.event', params: { event: 'crash', appId: 'com.example.shop' } },
        { id: 'say', type: 'output.note', params: { text: 'crash: {{trigger.message}} on {{target.appId}}' } },
      ],
      edges: chain('crashed', 'say'),
    });
    triggers = new FlowTriggers({ hub: h.hub, flows: h.flows, engine: h.engine, logger: silentLogger, notice: (n) => notices.push(n), now: () => clock });
    return app;
  }

  it('starts a flow on a crash of the app, once per throttle window', async () => {
    const app = await setup();
    h.hub.pushAppLog(app.id, { ts: Date.now(), level: 'fatal', tag: 'flutter', message: 'Null check operator used on a null value', kind: 'crash' });
    await waitFor(() => h.ended.length === 1);
    const run = (await h.runs.get(h.ended[0]!.id))!;
    expect(run.trigger).toMatchObject({ kind: 'event', event: 'crash' });
    expect(run.steps.find((s) => s.nodeId === 'say')!.output).toEqual({ text: 'crash: Null check operator used on a null value on com.example.shop' });
    expect(run.target).toMatchObject({ deviceId: 'android:A1', appId: 'com.example.shop' });

    h.hub.pushAppLog(app.id, { ts: Date.now(), level: 'fatal', tag: 'flutter', message: 'again', kind: 'crash' });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.ended).toHaveLength(1);
    clock += 61_000;
    h.hub.pushAppLog(app.id, { ts: Date.now(), level: 'fatal', tag: 'flutter', message: 'later', kind: 'crash' });
    await waitFor(() => h.ended.length === 2);
  });

  it('ignores flows with automation off', async () => {
    const app = await setup();
    const flow = h.flows.get('oncrash')!;
    await h.flows.save({ ...flow, automation: { enabled: false } }, { id: 'oncrash' });
    h.hub.pushAppLog(app.id, { ts: Date.now(), level: 'fatal', tag: 'x', message: 'boom', kind: 'crash' });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.ended).toHaveLength(0);
  });

  it('tells the user when an automatic run cannot start', async () => {
    const app = await setup();
    const flow = h.flows.get('oncrash')!;
    await h.flows.save({ ...flow, nodes: [...flow.nodes, { id: 'n2', type: 'output.note', params: { text: '{{env.missing}}' } }], edges: [...flow.edges, { from: 'say', to: 'n2' }] }, { id: 'oncrash' });
    h.hub.pushAppLog(app.id, { ts: Date.now(), level: 'fatal', tag: 'x', message: 'boom', kind: 'crash' });
    await waitFor(() => notices.length === 1);
    expect(notices[0]).toMatchObject({ level: 'warn', code: 'flow.automation.failed', params: { flow: 'On crash', reason: 'flow.preflight.failed' } });
  });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
