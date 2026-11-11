/** Limits, cleanups and edge cases of the flow engine, triggers and stores (runaway flows, stuck actions, races). */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowRunStep, MockRule, UiNotice } from '@durbun/protocol';
import { FlowEngine, FlowRunError, MAX_ACTIVE_RUNS } from '../../src/flows/engine';
import { FlowTriggers, LOOP_RUNS, triggerMatches } from '../../src/flows/triggers';
import { silentLogger } from '../../src/util/logger';
import { appInput, device } from '../hub/helpers';
import { chain, harness, json, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const step = (steps: FlowRunStep[], nodeId: string, i = 0) => steps.filter((s) => s.nodeId === nodeId)[i]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => undefined);

describe('run limits', () => {
  it('counts runs that are still starting, so a burst of starts cannot pass the limit', async () => {
    h.route(async () => {
      await sleep(300);
      return json({});
    });
    await h.save({ id: 'slow', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'req', type: 'http.request', params: { url: 'https://api.test/x' } }], edges: chain('start', 'req') });
    const results = await Promise.allSettled(Array.from({ length: MAX_ACTIVE_RUNS + 4 }, () => h.engine.start('slow')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_ACTIVE_RUNS);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused.map((r) => (r.reason as FlowRunError).code)).toEqual(Array(4).fill('flow.run.tooMany'));
    await h.engine.settle();
  });

  it('does not start a second automatic run of a flow that is starting or running', async () => {
    await h.save({ id: 'n', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'wait', type: 'logic.delay', params: { durationMs: 200 } }], edges: chain('start', 'wait') });
    const first = h.engine.start('n', {}, { automatic: true });
    await expect(h.engine.start('n', {}, { automatic: true })).rejects.toMatchObject({ code: 'flow.automation.busy' });
    await h.engine.settle((await first).id);
  });
});

describe('stuck steps and cleanups', () => {
  it('ends a step at its timeout even when the device action never answers', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['open-url'] }));
    h.onAction(never);
    await h.save({ id: 'n', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'open', type: 'device.openUrl', timeoutMs: 300, params: { url: 'shop://cart' } }], edges: chain('start', 'open') });
    const t0 = Date.now();
    const run = await h.run('n');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('flow.step.timeout');
  });

  it('removes its mock rules when Dürbün closes during a stuck step, and leftovers at the next start', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['app-restart'] }));
    h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    h.onAction(never);
    h.mocks = [{ id: 'mine', enabled: true, method: '*', url: '/mine', match: 'contains', action: { type: 'fail', error: 'timeout' }, createdAt: 1 }];
    await h.save({
      id: 'm',
      target: { appId: 'com.example.shop' },
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'mock', type: 'mock.add', params: { url: '/v1/profile', status: 500 } },
        { id: 'restart', type: 'device.restartApp' },
      ],
      edges: chain('start', 'mock', 'restart'),
    });
    const run = await h.engine.start('m');
    await sleep(150);
    expect(h.mocks.map((m) => m.id)).toContain(`flow-${run.id}-mock`);
    const t0 = Date.now();
    await h.engine.dispose();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(h.mocks.map((m) => m.id)).toEqual(['mine']);
    await h.runs.flush();
    expect((await h.runs.get(run.id))?.status).toBe('cancelled');

    // A crash left a temporary rule (and a kept one) behind: the next engine removes only the temporary one.
    const rule = (id: string): MockRule => ({ id, enabled: true, method: '*', url: '/x', match: 'contains', action: { type: 'delay', delayMs: 1 }, createdAt: 1 });
    let rules: MockRule[] = [rule('flow-abc-mock'), rule('flowkeep-abc-mock'), rule('mine')];
    const next = new FlowEngine({
      hub: h.hub,
      logger: silentLogger,
      flows: h.flows,
      envs: h.envs,
      runs: h.runs,
      slackConfigured: async () => false,
      deviceAction: async () => ({ ok: true, data: null }),
      mocks: { get: () => rules, set: (r) => (rules = r) },
      maxBodyBytes: () => 1_000_000,
      now: Date.now,
      emit: () => undefined,
      runEnded: () => undefined,
    });
    expect(rules.map((r) => r.id)).toEqual(['flowkeep-abc-mock', 'mine']);
    await next.dispose();
  });

  it('gives kept mock rules an id the cleanup leaves alone', async () => {
    await h.save({
      id: 'k',
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'mock', type: 'mock.add', params: { url: '/v1/cart', status: 503, keep: true } }],
      edges: chain('start', 'mock'),
    });
    const run = await h.run('k');
    expect(h.mocks.map((m) => m.id)).toEqual([`flowkeep-${run.id}-mock`]);
  });

  it('stops a recording when the run is stopped while the recording starts', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['screen-record', 'screen-record-stop'] }));
    h.onAction((action) => (action === 'screen-record' ? never() : { ok: true, data: { file: '/nonexistent.mp4' } }));
    await h.save({
      id: 'r',
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'rec', type: 'device.startRecording', params: { maxSeconds: 600 } }],
      edges: chain('start', 'rec'),
    });
    const run = await h.engine.start('r');
    await sleep(200);
    h.engine.cancel(run.id);
    await h.engine.settle(run.id);
    expect(h.actions.map((a) => a.action)).toEqual(['screen-record', 'screen-record-stop']);
  });
});

describe('graph walk', () => {
  it('lets later steps read a skipped or turned-off step as empty', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: [] })); // cannot take screenshots
    await h.save({
      id: 's',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'shot', type: 'device.screenshot' },
        { id: 'off', type: 'output.note', disabled: true, params: { text: 'x' } },
        { id: 'n', type: 'output.note', params: { text: 'shot={{shot.name}} off={{off.text}}' } },
      ],
      edges: chain('start', 'shot', 'off', 'n'),
    });
    const run = await h.run('s');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'shot').status).toBe('skipped');
    expect(step(run.steps, 'n').output).toEqual({ text: 'shot= off=' });
  });

  it('counts step visits per repeat iteration, so nested repeats are not taken for an endless loop', async () => {
    await h.save({
      id: 'nested',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'outer', type: 'logic.repeat', params: { count: 40 } },
        { id: 'inner', type: 'logic.repeat', params: { count: 30 } },
        { id: 'body', type: 'logic.setVariables', params: { assignments: [{ name: 'x', value: '1' }] } },
      ],
      edges: [
        { from: 'start', to: 'outer' },
        { from: 'outer', port: 'loop', to: 'inner' },
        { from: 'inner', port: 'loop', to: 'body' },
      ],
    });
    const run = await h.run('nested');
    expect(run.status).toBe('passed');
    expect(run.steps.filter((s) => s.nodeId === 'body')).toHaveLength(1200);
  });

  it('gives an outer list repeat its item back after an inner one', async () => {
    h.route(({ url }) => json(url.pathname === '/outer' ? ['a', 'b'] : [1, 2]));
    await h.save({
      id: 'items',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'o', type: 'http.request', params: { url: 'https://x.test/outer' } },
        { id: 'i', type: 'http.request', params: { url: 'https://x.test/inner' } },
        { id: 'outer', type: 'logic.repeat', params: { count: '{{o.body}}' } },
        { id: 'inner', type: 'logic.repeat', params: { count: '{{i.body}}' } },
        { id: 'innerBody', type: 'output.note', params: { text: 'inner {{item}}' } },
        { id: 'after', type: 'output.note', params: { text: 'outer {{item}}' } },
      ],
      edges: [
        ...chain('start', 'o', 'i', 'outer'),
        { from: 'outer', port: 'loop', to: 'inner' },
        { from: 'inner', port: 'loop', to: 'innerBody' },
        { from: 'inner', port: 'done', to: 'after' },
      ],
    });
    const run = await h.run('items');
    expect(run.steps.filter((s) => s.nodeId === 'after').map((s) => s.output)).toEqual([{ text: 'outer a' }, { text: 'outer b' }]);
  });

  it('reads the repeat count: 0 runs nothing, a JSON list in text is a list, anything else fails', async () => {
    const save = (id: string, count: unknown) =>
      h.save({
        id,
        nodes: [
          { id: 'start', type: 'trigger.manual' },
          { id: 'v', type: 'logic.setVariables', params: { assignments: [{ name: 'c', value: String(count) }] } },
          { id: 'rep', type: 'logic.repeat', params: { count: '{{vars.c}}' } },
          { id: 'body', type: 'output.note', params: { text: '{{item}}' } },
        ],
        edges: [...chain('start', 'v', 'rep'), { from: 'rep', port: 'loop', to: 'body' }],
      });
    await save('zero', 0);
    const zero = await h.run('zero');
    expect(zero.status).toBe('passed');
    expect(zero.steps.filter((s) => s.nodeId === 'body')).toHaveLength(0);
    await save('list', '["x","y"]');
    const list = await h.run('list');
    expect(list.steps.filter((s) => s.nodeId === 'body').map((s) => s.output)).toEqual([{ text: 'x' }, { text: 'y' }]);
    await save('bad', 'many');
    const bad = await h.run('bad');
    expect(bad.status).toBe('failed');
    expect(step(bad.steps, 'rep')).toMatchObject({ errorCode: 'flow.param.type', params: { param: 'count', expected: 'numberOrList' } });
  });

  it('applies the repeat step’s time limit', async () => {
    await h.save({
      id: 'slowloop',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'rep', type: 'logic.repeat', timeoutMs: 300, params: { count: 10 } },
        { id: 'wait', type: 'logic.delay', params: { durationMs: 100 } },
      ],
      edges: [{ from: 'start', to: 'rep' }, { from: 'rep', port: 'loop', to: 'wait' }],
    });
    const run = await h.run('slowloop');
    expect(run.status).toBe('failed');
    expect(step(run.steps, 'rep').errorCode).toBe('flow.step.timeout');
  });

  it('leaves a condition that cannot be evaluated through false when it continues on error', async () => {
    await h.save({
      id: 'cond',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'cond', type: 'logic.condition', continueOnError: true, params: { rules: [{ left: '{{nothing.here}}', op: 'equals', right: '1' }] } },
        { id: 'yes', type: 'output.note', params: { text: 'yes' } },
        { id: 'no', type: 'output.note', params: { text: 'no' } },
      ],
      edges: [{ from: 'start', to: 'cond' }, { from: 'cond', port: 'true', to: 'yes' }, { from: 'cond', port: 'false', to: 'no' }],
    });
    const run = await h.run('cond');
    expect(run.steps.map((s) => s.nodeId)).toEqual(['start', 'cond', 'no']);
  });

  it('says {{run.status}} failed once a step failed, even a handled one', async () => {
    h.route(() => json({}, 500));
    await h.save({
      id: 'st',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'req', type: 'http.request', continueOnError: true, params: { url: 'https://api.test/x', expectStatus: '2xx' } },
        { id: 'n', type: 'output.note', params: { text: '{{run.status}}' } },
      ],
      edges: chain('start', 'req', 'n'),
    });
    const run = await h.run('st');
    expect(step(run.steps, 'n').output).toEqual({ text: 'failed' });
  });

  it('refuses to start from a step that is not in the flow', async () => {
    h.route(() => json({}));
    await h.save({ id: 'from', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'del', type: 'http.request', params: { method: 'DELETE', url: 'https://api.test/all' } }], edges: chain('start', 'del') });
    await expect(h.engine.start('from', { startNodeId: 'gone' })).rejects.toMatchObject({ code: 'flow.preflight.failed' });
    const pre = await h.engine.preflight('from', { startNodeId: 'gone' });
    expect(pre.issues.map((i) => i.code)).toContain('preflight.start.unknown');
    expect(h.requests).toHaveLength(0);
  });

  it('refuses sub-flows that call each other in a circle', async () => {
    const call = (id: string, to: string) =>
      h.save({ id, name: id.toUpperCase(), nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'c', type: 'flow.call', params: { flowId: to } }], edges: chain('start', 'c') });
    await call('a', 'a2');
    await call('b', 'a');
    await call('a2', 'b');
    const pre = await h.engine.preflight('a', {});
    expect(pre.ok).toBe(false);
    expect(pre.issues.filter((i) => i.code === 'preflight.call.recursive')).toHaveLength(1);
  });
});

describe('what a run keeps and sends', () => {
  it('masks a secret in its encoded forms, also in the Network tab copy and on Slack', async () => {
    h.route(() => json({ ok: true }));
    h.setSlack(true);
    await h.envs.put({ environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'pw', value: 'p@ss w0rd!', secret: true }] }] });
    await h.save({
      id: 'sec',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'req', type: 'http.request', params: { url: 'https://x.test/login', query: [['password', '{{env.pw}}']], headers: [['Authorization', 'Basic {{env.pw | base64}}']] } },
        { id: 'slack', type: 'output.slack', params: { text: 'Logged in with {{req.url}}', includeSummary: false } },
      ],
      edges: chain('start', 'req', 'slack'),
    });
    const run = await h.run('sec', { environmentId: 'dev' });
    const req = step(run.steps, 'req');
    expect(req.summary).toContain('password=••••');
    const recorded = h.hub.getNetworkDetail(req.netId!)!;
    expect(recorded.url).toBe('https://x.test/login?password=••••');
    expect(recorded.requestHeaders).toContainEqual(['Authorization', 'Basic ••••']);
    expect(h.slackSent[0]).toBe('Logged in with https://x.test/login?password=••••');
    expect(JSON.stringify(run)).not.toContain(encodeURIComponent('p@ss w0rd!'));
  });

  it('keeps a polling run file small: older outputs of a step that ran again are dropped', async () => {
    const big = { items: Array.from({ length: 150 }, (_, i) => ({ id: i, description: 'x'.repeat(1000) })) }; // ~150 KB
    h.route(() => json(big));
    await h.save({
      id: 'poll',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'rep', type: 'logic.repeat', params: { count: 120 } },
        { id: 'req', type: 'http.request', params: { url: 'https://x.test/list' } },
      ],
      edges: [{ from: 'start', to: 'rep' }, { from: 'rep', port: 'loop', to: 'req' }],
    });
    const run = await h.run('poll');
    expect(run.status).toBe('passed');
    const size = (await readFile(path.join(h.runs.dir, `${run.id}.json`))).length;
    expect(size).toBeLessThan(12_000_000);
    const reqs = run.steps.filter((s) => s.nodeId === 'req');
    expect(reqs[reqs.length - 1]!.output).toMatchObject({ status: 200 });
    expect(reqs[0]!.output).toBeTypeOf('string');
    expect((reqs[reqs.length - 1]!.output as Record<string, unknown>).bodyText).toBeUndefined();
  });

  it('sends a body without a body type as JSON and says so', async () => {
    h.route(() => json({ ok: true }));
    await h.save({
      id: 'body',
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'req', type: 'http.request', params: { method: 'POST', url: 'https://x.test/orders', body: { sku: 'A1', qty: 2 } } }],
      edges: chain('start', 'req'),
    });
    const run = await h.run('body');
    expect(JSON.parse(h.requests[0]!.body)).toEqual({ sku: 'A1', qty: 2 });
    expect(h.requests[0]!.headers['content-type']).toContain('application/json');
    expect(step(run.steps, 'req')).toMatchObject({ code: 'flow.step.httpBodyInferred', params: { bodyType: 'json' } });
  });

  it('reports the URL a request ended at after redirects', async () => {
    h.route(() => {
      const res = json({ ok: true });
      Object.defineProperty(res, 'url', { value: 'https://x.test/v2/orders' });
      return res;
    });
    await h.save({ id: 'redir', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'req', type: 'http.request', params: { url: 'https://x.test/orders' } }], edges: chain('start', 'req') });
    const run = await h.run('redir');
    expect(step(run.steps, 'req').output).toMatchObject({ url: 'https://x.test/v2/orders' });
  });

  it('resolves templates in input defaults for each run', async () => {
    await h.save({
      id: 'inp',
      inputs: [{ name: 'email', default: 'qa+{{$timestamp}}@example.com' }],
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'n', type: 'output.note', params: { text: '{{input.email}}' } }],
      edges: chain('start', 'n'),
    });
    const run = await h.run('inp');
    expect((step(run.steps, 'n').output as { text: string }).text).toMatch(/^qa\+\d+@example\.com$/);
  });

  it('gives wait steps the step time limit when they have none of their own', async () => {
    h.hub.upsertDevice(device('android:A1'));
    h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    await h.save({
      id: 'w',
      target: { appId: 'com.example.shop' },
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'wait', type: 'wait.log', timeoutMs: 600, params: { text: 'never comes' } }],
      edges: chain('start', 'wait'),
    });
    const t0 = Date.now();
    const run = await h.run('w');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(step(run.steps, 'wait').errorCode).toBe('flow.wait.log');
  });

  it('does not count failures a mock rule made as problems of the app', async () => {
    h.hub.upsertDevice(device('android:A1'));
    const app = h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    await h.save({
      id: 'mocked',
      target: { appId: 'com.example.shop' },
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'wait', type: 'logic.delay', params: { durationMs: 150 } }, { id: 'ok', type: 'check.noErrors' }],
      edges: chain('start', 'wait', 'ok'),
    });
    setTimeout(() => {
      const ts = Date.now();
      // A 503 a mock rule answered on purpose, and a real one.
      h.hub.netRequest(app.id, { type: 'net.request', id: 'm1', ts, method: 'GET', url: 'https://api.shop/cart', headers: [], source: 'dio' });
      h.hub.netResponse(app.id, { type: 'net.response', id: 'm1', ts: ts + 5, status: 503, headers: [], mocked: true, mockRuleId: 'flow-x-mock' });
    }, 30);
    const passed = await h.run('mocked');
    expect(passed.status).toBe('passed');
    setTimeout(() => {
      const ts = Date.now();
      h.hub.netRequest(app.id, { type: 'net.request', id: 'r2', ts, method: 'GET', url: 'https://api.shop/cart', headers: [], source: 'dio' });
      h.hub.netResponse(app.id, { type: 'net.response', id: 'r2', ts: ts + 5, status: 503, headers: [] });
    }, 30);
    const failed = await h.run('mocked');
    expect(failed.status).toBe('failed');
    expect(step(failed.steps, 'ok').errorCode).toBe('flow.noErrors.found');
  });
});

describe('device that went away', () => {
  it('only warns about a gone device when the flow has no device steps', async () => {
    await h.save({ id: 'nodev', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'n', type: 'output.note', params: { text: 'hi' } }], edges: chain('start', 'n') });
    const pre = await h.engine.preflight('nodev', { target: { deviceId: 'android:GONE' } });
    expect(pre.ok).toBe(true);
    expect(pre.issues.find((i) => i.code === 'preflight.device.gone')?.level).toBe('warn');
  });

  it('skips device steps once the device is unplugged during the run', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['open-url'] }));
    await h.save({
      id: 'unplug',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'wait', type: 'logic.delay', params: { durationMs: 100 } },
        { id: 'open', type: 'device.openUrl', params: { url: 'shop://cart' } },
      ],
      edges: chain('start', 'wait', 'open'),
    });
    const started = await h.engine.start('unplug');
    h.hub.upsertDevice(device('android:A1', { actions: ['open-url'], state: 'offline' }));
    await h.engine.settle(started.id);
    const run = (await h.runs.get(started.id))!;
    expect(step(run.steps, 'open')).toMatchObject({ status: 'skipped', code: 'preflight.device.missing' });
    expect(h.actions).toHaveLength(0);
  });
});

describe('flow store', () => {
  it('gives parallel copies different ids', async () => {
    await h.save({ id: 'base', nodes: [{ id: 'start', type: 'trigger.manual' }] });
    const [a, b] = await Promise.all([h.flows.duplicate('base'), h.flows.duplicate('base')]);
    expect(new Set([a.flow.id, b.flow.id]).size).toBe(2);
    expect(h.flows.get(a.flow.id) && h.flows.get(b.flow.id)).toBeTruthy();
  });

  it('keeps the path id when a saved flow has no id, and keeps API paths free', async () => {
    const saved = await h.save({ id: 'login', name: 'Login', nodes: [{ id: 'start', type: 'trigger.manual' }] });
    const { id: _id, ...noId } = saved;
    const r = await h.flows.save(noId, { id: 'login' });
    expect(r.flow.id).toBe('login');
    expect([...h.flows.ids()]).toEqual(['login']);
    expect(h.flows.freeId('Import')).toBe('import-2');
    await expect(h.flows.save({ ...saved, id: 'schema' }, { id: 'login' })).rejects.toMatchObject({ code: 'flow.id.reserved' });
  });
});

describe('automation loops', () => {
  let notices: UiNotice[];
  let clock: number;
  let triggers: FlowTriggers;
  beforeEach(() => {
    notices = [];
    clock = 1_000_000;
    triggers = new FlowTriggers({ hub: h.hub, flows: h.flows, engine: h.engine, logger: silentLogger, notice: (n) => notices.push(n), now: () => clock });
  });
  afterEach(() => triggers.dispose());

  async function saveLooping() {
    h.hub.upsertDevice(device('android:A1'));
    await h.save({
      id: 'loop',
      name: 'Restarts itself',
      automation: { enabled: true, throttleMs: 1000 },
      nodes: [{ id: 'on', type: 'trigger.event', params: { event: 'deviceConnected' } }, { id: 'n', type: 'output.note', params: { text: 'hi' } }],
      edges: chain('on', 'n'),
    });
  }
  const connected = () => triggers.fire({ event: 'deviceConnected', device: device('android:A1') });
  const waitEnded = async (n: number) => {
    for (let i = 0; i < 150 && h.ended.length < n; i++) await sleep(20);
    expect(h.ended).toHaveLength(n);
  };

  it('ignores events during its own run and measures the throttle from the run’s end', async () => {
    await saveLooping();
    await h.save({ ...h.flows.get('loop')!, nodes: [...h.flows.get('loop')!.nodes, { id: 'w', type: 'logic.delay', params: { durationMs: 150 } }], edges: chain('on', 'n', 'w') });
    connected();
    clock += 5_000; // past the trigger's own throttle, but the run is still going
    connected();
    await waitEnded(1);
    clock += 500; // within the throttle after the run ended
    connected();
    await sleep(100);
    expect(h.ended).toHaveLength(1);
  });

  it(`switches automation off after ${LOOP_RUNS} runs in a row that start right after the previous one`, async () => {
    await saveLooping();
    for (let i = 1; i <= LOOP_RUNS + 1; i++) {
      connected();
      await waitEnded(Math.min(i, LOOP_RUNS));
      clock += 1_500; // past the throttle, within twice the throttle
    }
    expect(h.ended).toHaveLength(LOOP_RUNS);
    expect(notices).toEqual([expect.objectContaining({ code: 'flow.automation.loop', params: { flow: 'Restarts itself', count: LOOP_RUNS } })]);
    for (let i = 0; i < 50 && h.flows.get('loop')!.automation?.enabled; i++) await sleep(20);
    expect(h.flows.get('loop')!.automation?.enabled).toBe(false);
  });

  it('watches the flow’s app when the trigger names none (not for a device connecting)', () => {
    const crash = { id: 't', type: 'trigger.event', params: { event: 'crash' } };
    const log = { id: 1, ts: 0, deviceId: 'android:A1', source: 'app' as const, level: 'fatal' as const, tag: 'x', message: 'boom' };
    expect(triggerMatches(crash, { event: 'crash', log, appId: 'com.other' }, 'com.example.shop')).toBe(false);
    expect(triggerMatches(crash, { event: 'crash', log, appId: 'com.example.shop' }, 'com.example.shop')).toBe(true);
    const dev = { id: 't', type: 'trigger.event', params: { event: 'deviceConnected' } };
    expect(triggerMatches(dev, { event: 'deviceConnected', device: device('android:A1') }, 'com.example.shop')).toBe(true);
  });
});

