import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowRunStep } from '@durbun/protocol';
import { FlowRunError } from '../../src/flows/engine';
import { appInput, device } from '../hub/helpers';
import { chain, harness, json, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const step = (steps: FlowRunStep[], nodeId: string) => steps.find((s) => s.nodeId === nodeId)!;
const statuses = (steps: FlowRunStep[]) => Object.fromEntries(steps.map((s) => [s.nodeId, s.status]));

describe('HTTP chains', () => {
  it('links responses into later requests, extracts variables and checks them', async () => {
    h.route(({ method, url, headers, body }) => {
      if (url.pathname === '/login' && method === 'POST') {
        expect(JSON.parse(body)).toEqual({ email: 'qa@example.com', password: 'hunter2' });
        return json({ token: 'tok-123456', user: { id: 77 } }, 200, { 'x-session': 'sess-abcdef' });
      }
      if (url.pathname === '/orders' && method === 'POST') {
        expect(headers.get('authorization')).toBe('Bearer tok-123456');
        expect(headers.get('x-session')).toBe('sess-abcdef');
        expect(url.searchParams.get('user')).toBe('77');
        return json({ order: { id: 'ord-9', total: 42.5 } }, 201);
      }
      return new Response('nope', { status: 404 });
    });
    await h.envs.put({ environments: [{ id: 'staging', name: 'Staging', vars: [{ key: 'baseUrl', value: 'https://api.test' }, { key: 'password', value: 'hunter2', secret: true }] }] });
    await h.save({
      id: 'order',
      name: 'Order',
      inputs: [{ name: 'email', default: 'qa@example.com' }],
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'login', type: 'http.request', params: { method: 'POST', url: '{{env.baseUrl}}/login', bodyType: 'json', body: { email: '{{input.email}}', password: '{{env.password}}' }, expectStatus: '2xx', extract: [{ name: 'userId', from: 'body', path: 'user.id' }] } },
        {
          id: 'create',
          type: 'http.request',
          params: {
            method: 'POST',
            url: '{{env.baseUrl}}/orders',
            query: [['user', '{{vars.userId}}']],
            headers: [
              ['Authorization', 'Bearer {{login.body.token}}'],
              ['X-Session', "{{login.headers['x-session']}}"],
            ],
            bodyType: 'json',
            body: { items: [1, 2] },
            expectStatus: '201',
          },
        },
        { id: 'check', type: 'check.assert', params: { assertions: [{ left: '{{create.body.order.total}}', op: 'gt', right: '40', message: 'Total is above 40' }] } },
      ],
      edges: chain('start', 'login', 'create', 'check'),
      outputs: [{ name: 'orderId', value: '{{create.body.order.id}}' }],
    });
    const run = await h.run('order');
    expect(run.status).toBe('passed');
    expect(statuses(run.steps)).toEqual({ start: 'passed', login: 'passed', create: 'passed', check: 'passed' });
    expect(run.outputs).toEqual({ orderId: 'ord-9' });
    expect(run.environment).toEqual({ id: 'staging', name: 'Staging' });
    expect(step(run.steps, 'create').summary).toContain('→ 201');
    // Requests are recorded on the desktop device with source 'flow'.
    const recorded = h.hub.getNetwork().filter((e) => e.source === 'flow');
    expect(recorded).toHaveLength(2);
    expect(step(run.steps, 'login').netId).toBe(recorded[0]!.id);
    // The secret password never appears in what is kept.
    expect(JSON.stringify(run)).not.toContain('hunter2');
    expect(h.ended.map((r) => r.id)).toEqual([run.id]);
    expect(h.deltas.at(-1)!.run.status).toBe('passed');
  });

  it('takes the error port on a wrong status and keeps the run passing', async () => {
    h.route(() => json({ error: 'boom' }, 500));
    await h.save({
      id: 'err',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'req', type: 'http.request', params: { url: 'https://x.test/a', expectStatus: '2xx' } },
        { id: 'ok', type: 'output.note', params: { text: 'fine' } },
        { id: 'recover', type: 'output.note', params: { text: 'status {{req.status}}: {{req.error}}' } },
      ],
      edges: [...chain('start', 'req', 'ok'), { from: 'req', port: 'error', to: 'recover' }],
    });
    const run = await h.run('err');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'req')).toMatchObject({ status: 'failed', handled: true, port: 'error', errorCode: 'flow.http.status' });
    expect(step(run.steps, 'recover').output).toEqual({ text: 'status 500: Expected status 2xx, got 500 (GET https://x.test/a)' });
    expect(run.steps.some((s) => s.nodeId === 'ok')).toBe(false);
  });

  it('fails the run on an unhandled failure and stops the other branches', async () => {
    h.route(() => new Response('x', { status: 503 }));
    await h.save({
      id: 'par',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'slow', type: 'logic.delay', params: { durationMs: 5000 } },
        { id: 'req', type: 'http.request', params: { url: 'https://x.test/', expectStatus: '200' } },
      ],
      edges: [
        { from: 'start', to: 'slow' },
        { from: 'start', to: 'req' },
      ],
    });
    const t0 = Date.now();
    const run = await h.run('par');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('flow.http.status');
    expect(step(run.steps, 'slow').status).toBe('cancelled');
  });

  it('retries a failing request', async () => {
    let n = 0;
    h.route(() => (++n < 3 ? new Response('no', { status: 502 }) : json({ ok: true })));
    await h.save({
      id: 'retry',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'req', type: 'http.request', params: { url: 'https://x.test/', expectStatus: '2xx' }, retry: { count: 3, delayMs: 10 } },
      ],
      edges: chain('start', 'req'),
    });
    const run = await h.run('retry');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'req').attempts).toBe(3);
  });

  it('reports a network failure with its reason', async () => {
    h.route(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' } });
    });
    await h.save({ id: 'down', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'req', type: 'http.request', params: { url: 'http://127.0.0.1:1/' } }], edges: chain('start', 'req') });
    const run = await h.run('down');
    expect(run.status).toBe('failed');
    expect(step(run.steps, 'req')).toMatchObject({ errorCode: 'flow.http.failed' });
    expect(step(run.steps, 'req').error).toContain('Connection refused');
  });
});

describe('logic', () => {
  it('routes a condition and sets variables', async () => {
    await h.save({
      id: 'cond',
      inputs: [{ name: 'n', default: 5 }],
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'set', type: 'logic.setVariables', params: { assignments: [{ name: 'big', value: '{{input.n}}' }] } },
        { id: 'if', type: 'logic.condition', params: { rules: [{ left: '{{vars.big}}', op: 'gte', right: '3' }] } },
        { id: 'yes', type: 'output.note', params: { text: 'big' } },
        { id: 'no', type: 'output.note', params: { text: 'small' } },
      ],
      edges: [...chain('start', 'set', 'if'), { from: 'if', port: 'true', to: 'yes' }, { from: 'if', port: 'false', to: 'no' }],
    });
    let run = await h.run('cond');
    expect(run.steps.map((s) => s.nodeId)).toEqual(['start', 'set', 'if', 'yes']);
    expect(step(run.steps, 'if')).toMatchObject({ port: 'true', summary: 'true', params: { explain: '' } });
    run = await h.run('cond', { inputs: { n: 1 } });
    expect(run.steps.map((s) => s.nodeId)).toEqual(['start', 'set', 'if', 'no']);
    expect(step(run.steps, 'if').summary).toBe('false: 1 — expected ≥ 3');
  });

  it('polls with repeat until a condition holds', async () => {
    let calls = 0;
    h.route(() => json({ state: ++calls >= 3 ? 'ready' : 'pending' }));
    await h.save({
      id: 'poll',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'loop', type: 'logic.repeat', params: { count: 10, until: [{ left: '{{status.body.state}}', op: 'equals', right: 'ready' }], failIfNotMet: true } },
        { id: 'status', type: 'http.request', params: { url: 'https://x.test/status' } },
        { id: 'after', type: 'output.note', params: { text: 'after {{loop.iterations}}' } },
      ],
      edges: [{ from: 'start', to: 'loop' }, { from: 'loop', port: 'loop', to: 'status' }, { from: 'status', to: 'loop' }, { from: 'loop', port: 'done', to: 'after' }],
    });
    const run = await h.run('poll');
    expect(run.status).toBe('passed');
    expect(calls).toBe(3);
    expect(step(run.steps, 'loop')).toMatchObject({ status: 'passed', port: 'done', output: { iterations: 3, met: true } });
    expect(step(run.steps, 'after').output).toEqual({ text: 'after 3' });
    const loopStep = step(run.steps, 'loop');
    expect(run.steps.filter((s) => s.nodeId === 'status').map((s) => [s.parentStepId, s.iteration])).toEqual([
      [loopStep.id, 0],
      [loopStep.id, 1],
      [loopStep.id, 2],
    ]);
  });

  it('iterates over a list with {{item}}', async () => {
    await h.save({
      id: 'each',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'set', type: 'logic.setVariables', params: { assignments: [{ name: 'list', value: '{{input.list}}' }] } },
        { id: 'loop', type: 'logic.repeat', params: { count: '{{vars.list}}' } },
        { id: 'say', type: 'output.note', params: { text: '{{loop.index}}:{{item.name}}' } },
      ],
      edges: [...chain('start', 'set', 'loop'), { from: 'loop', port: 'loop', to: 'say' }],
      inputs: [{ name: 'list' }],
    });
    const run = await h.run('each', { inputs: { list: [{ name: 'a' }, { name: 'b' }] } });
    expect(run.steps.filter((s) => s.nodeId === 'say').map((s) => (s.output as { text: string }).text)).toEqual(['0:a', '1:b']);
  });

  it('fails a repeat whose condition never held when asked to', async () => {
    await h.save({
      id: 'never',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'loop', type: 'logic.repeat', params: { count: 2, until: [{ left: 'a', op: 'equals', right: 'b' }], failIfNotMet: true } },
      ],
      edges: chain('start', 'loop'),
    });
    const run = await h.run('never');
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('flow.repeat.notMet');
  });

  it('ends a run with flow.end', async () => {
    await h.save({
      id: 'end',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'stop', type: 'flow.end', params: { status: 'failed', message: 'Not today' } },
        { id: 'never', type: 'output.note', params: { text: 'x' } },
      ],
      edges: [...chain('start', 'stop')],
    });
    const run = await h.run('end');
    expect(run).toMatchObject({ status: 'failed', error: 'Not today', errorCode: 'flow.end.failed' });
  });

  it('stops an endless cycle at the visit limit', async () => {
    await h.save({
      id: 'cycle',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'a', type: 'logic.setVariables', params: { assignments: [{ name: 'x', value: '1' }] } },
        { id: 'b', type: 'logic.setVariables', params: { assignments: [{ name: 'y', value: '2' }] } },
      ],
      edges: [...chain('start', 'a', 'b'), { from: 'b', to: 'a' }],
    });
    const run = await h.run('cycle');
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('flow.limit.visits');
  });

  it('fails a step that reads something unknown', async () => {
    await h.save({ id: 'tpl', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'n', type: 'output.note', params: { text: '{{nothing.here}}' } }], edges: chain('start', 'n') });
    const run = await h.run('tpl');
    expect(run.status).toBe('failed');
    expect(step(run.steps, 'n').errorCode).toBe('flow.template.unknownRoot');
  });
});

describe('sub-flows', () => {
  it('runs another flow with inputs and reads its outputs', async () => {
    h.route(({ url }) => json({ token: `t-${url.searchParams.get('u')}` }));
    await h.save({
      id: 'login',
      name: 'Login',
      inputs: [{ name: 'user', required: true }],
      outputs: [{ name: 'token', value: '{{req.body.token}}' }],
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'req', type: 'http.request', params: { url: 'https://x.test/login?u={{input.user}}' } },
      ],
      edges: chain('start', 'req'),
    });
    await h.save({
      id: 'main',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'call', type: 'flow.call', params: { flowId: 'login', inputs: { user: 'ayse' } } },
        { id: 'show', type: 'output.note', params: { text: '{{call.outputs.token}}' } },
      ],
      edges: chain('start', 'call', 'show'),
    });
    const run = await h.run('main');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'show').output).toEqual({ text: 't-ayse' });
    const call = step(run.steps, 'call');
    const inner = run.steps.find((s) => s.flowId === 'login' && s.nodeId === 'req')!;
    expect(inner).toMatchObject({ depth: 1, parentStepId: call.id, status: 'passed' });
  });

  it('fails the calling step when the sub-flow fails', async () => {
    await h.save({ id: 'bad', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'end', type: 'flow.end', params: { status: 'failed', message: 'no' } }], edges: chain('start', 'end') });
    await h.save({ id: 'outer', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'call', type: 'flow.call', params: { flowId: 'bad' } }], edges: chain('start', 'call') });
    const run = await h.run('outer');
    expect(run.status).toBe('failed');
    expect(step(run.steps, 'call').errorCode).toBe('flow.call.failed');
  });
});

describe('preflight and devices', () => {
  it('skips device steps without a device and says why', async () => {
    await h.save({ id: 'dev', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'shot', type: 'device.screenshot' }, { id: 'after', type: 'output.note', params: { text: 'ok' } }], edges: chain('start', 'shot', 'after') });
    const pre = await h.engine.preflight('dev', {});
    expect(pre.ok).toBe(false);
    expect(pre.issues.map((i) => i.code)).toContain('preflight.device.none');
  });

  it('runs a flow with work of its own without a device and skips its device steps', async () => {
    const nodes = [
      { id: 'start', type: 'trigger.manual' },
      { id: 'check', type: 'check.assert', params: { assertions: [{ left: '1', op: 'equals', right: '1' }] } },
      { id: 'shot', type: 'device.screenshot' },
      { id: 'after', type: 'output.note', params: { text: 'ok' } },
    ];
    await h.save({ id: 'mixed', nodes, edges: chain('start', 'check', 'shot', 'after') });
    const pre = await h.engine.preflight('mixed', {});
    expect(pre).toMatchObject({ ok: true, skipped: ['shot'] });
    expect(pre.issues.find((i) => i.code === 'preflight.device.noneSkipped')).toMatchObject({ level: 'warn', params: { count: 1 } });
    const run = await h.run('mixed');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'shot')).toMatchObject({ status: 'skipped', unsupported: 'preflight.device.missing' });

    await h.save({ id: 'mixed-strict', settings: { onUnsupported: 'fail' }, nodes, edges: chain('start', 'check', 'shot', 'after') });
    const strict = await h.engine.preflight('mixed-strict', {});
    expect(strict.ok).toBe(false);
    expect(strict.issues.map((i) => i.code)).toContain('preflight.device.none');
  });

  it('does not start a flow whose start leads nowhere, and names validation problems by code', async () => {
    await h.save({ id: 'lonely', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'req', type: 'http.request', params: { method: 'GET', url: 'https://api.test/x' } }], edges: [] });
    const pre = await h.engine.preflight('lonely', {});
    expect(pre.ok).toBe(false);
    expect(pre.issues.map((i) => i.code)).toContain('preflight.flow.empty');

    // Saved with its error (the harness throws after saving).
    await h.save({ id: 'broken', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'req', type: 'http.request', params: { method: 'GET' } }], edges: chain('start', 'req') }).catch(() => undefined);
    const invalid = (await h.engine.preflight('broken', {})).issues.find((i) => i.code === 'preflight.flow.invalid');
    expect(invalid).toMatchObject({ nodeId: 'req', params: { issue: 'flow.param.required', param: 'url', problem: 'url is required' } });
  });

  it('skips a step the device cannot do and runs the rest', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['screenshot'] }));
    await h.save({
      id: 'skip',
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'loc', type: 'device.location', params: { lat: 1, lon: 2 } }, { id: 'after', type: 'output.note', params: { text: 'ok' } }],
      edges: chain('start', 'loc', 'after'),
    });
    const pre = await h.engine.preflight('skip', {});
    expect(pre).toMatchObject({ ok: true, skipped: ['loc'] });
    expect(pre.issues.find((i) => i.nodeId === 'loc')!.code).toBe('preflight.action.emulator');
    const run = await h.run('skip');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'loc')).toMatchObject({ status: 'skipped', unsupported: 'preflight.action.emulator' });
    expect(h.actions).toHaveLength(0);
  });

  it('refuses to start with onUnsupported fail', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: [] }));
    await h.save({ id: 'strict', settings: { onUnsupported: 'fail' }, nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'shot', type: 'device.screenshot' }], edges: chain('start', 'shot') });
    await expect(h.engine.start('strict', {})).rejects.toBeInstanceOf(FlowRunError);
  });

  it('names missing environment variables', async () => {
    await h.envs.put({ environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'a', value: '1' }] }] });
    await h.save({ id: 'envs', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'n', type: 'output.note', params: { text: '{{env.a}} {{env.token}}' } }], edges: chain('start', 'n') });
    const pre = await h.engine.preflight('envs', {});
    expect(pre.ok).toBe(false);
    expect(pre.issues[0]).toMatchObject({ code: 'preflight.env.missing', params: { env: 'Dev', keys: 'token' } });
  });

  it('marks irreversible steps and passes app ids to the device', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['app-clear-data', 'app-launch', 'screenshot'] }));
    h.onAction(() => ({ ok: true, data: null }));
    await h.save({
      id: 'clean',
      target: { appId: 'com.example.app' },
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'wipe', type: 'device.clearData' }, { id: 'go', type: 'device.launchApp' }],
      edges: chain('start', 'wipe', 'go'),
    });
    const pre = await h.engine.preflight('clean', {});
    expect(pre.irreversible).toEqual(['wipe']);
    const run = await h.run('clean');
    expect(run.status).toBe('passed');
    expect(h.actions.map((a) => [a.deviceId, a.action, a.params.appId])).toEqual([
      ['android:A1', 'app-clear-data', 'com.example.app'],
      ['android:A1', 'app-launch', 'com.example.app'],
    ]);
    expect(run.target).toMatchObject({ deviceId: 'android:A1', appId: 'com.example.app', platform: 'android' });
  });

  it('turns a device refusal into a failed step with its code', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['open-url'] }));
    h.onAction(() => ({ ok: false, error: 'No activity', code: 'action.openUrl.noHandler' }));
    await h.save({ id: 'url', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'open', type: 'device.openUrl', params: { url: 'myapp://x' } }], edges: chain('start', 'open') });
    const run = await h.run('url');
    expect(step(run.steps, 'open')).toMatchObject({ status: 'failed', errorCode: 'action.openUrl.noHandler', error: 'No activity' });
  });
});

describe('waiting for the app', () => {
  it('sees the request the app sends after a deep link', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['open-url'] }));
    const app = h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    h.onAction(() => {
      setTimeout(() => {
        const ts = Date.now();
        h.hub.netRequest(app.id, { type: 'net.request', id: 'r1', ts, method: 'GET', url: 'https://api.shop/products/42', headers: [], source: 'dio' });
        h.hub.netResponse(app.id, { type: 'net.response', id: 'r1', ts: ts + 30, status: 200, headers: [['content-type', 'application/json']], body: { encoding: 'utf8', data: '{"id":42,"title":"Kalem"}', size: 25 } });
      }, 150);
      return { ok: true, data: null };
    });
    await h.save({
      id: 'deeplink',
      target: { appId: 'com.example.shop' },
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'open', type: 'device.openUrl', params: { url: 'shop://product/42' } },
        { id: 'wait', type: 'wait.network', params: { url: '/products/42', status: '2xx', timeoutMs: 5000 } },
        { id: 'check', type: 'check.assert', params: { assertions: [{ left: '{{wait.body.title}}', op: 'equals', right: 'Kalem' }] } },
      ],
      edges: chain('start', 'open', 'wait', 'check'),
    });
    const run = await h.run('deeplink');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'wait').netId).toBe(`${app.id}:r1`);
  });

  it('times out when the request never comes', async () => {
    h.hub.upsertDevice(device('android:A1'));
    h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    await h.save({
      id: 'never',
      target: { appId: 'com.example.shop' },
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'wait', type: 'wait.network', params: { url: '/never', timeoutMs: 300 } }],
      edges: chain('start', 'wait'),
    });
    const run = await h.run('never');
    expect(step(run.steps, 'wait').errorCode).toBe('flow.wait.network');
  });

  it('waits for a log line of the app', async () => {
    h.hub.upsertDevice(device('android:A1'));
    const app = h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    setTimeout(() => h.hub.pushAppLog(app.id, { ts: Date.now(), level: 'info', tag: 'cart', message: 'Cart total: 99.90' }), 100);
    await h.save({
      id: 'log',
      target: { appId: 'com.example.shop' },
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'wait', type: 'wait.log', params: { text: 'total: ([0-9.]+)', regex: true, timeoutMs: 3000 } }, { id: 'n', type: 'output.note', params: { text: '{{wait.match}} = {{wait.groups[1]}} in {{wait.groups[0]}}' } }],
      edges: chain('start', 'wait', 'n'),
    });
    const run = await h.run('log');
    expect(run.status).toBe('passed');
    expect(step(run.steps, 'n').output).toEqual({ text: '99.90 = 99.90 in total: 99.90' });
  });

  it('finds crashes with check.noErrors', async () => {
    h.hub.upsertDevice(device('android:A1'));
    const app = h.hub.registerApp(appInput('android:A1', { app: { name: 'Shop', id: 'com.example.shop', pid: 10 } }));
    await h.save({
      id: 'crash',
      target: { appId: 'com.example.shop' },
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'wait', type: 'logic.delay', params: { durationMs: 150 } }, { id: 'ok', type: 'check.noErrors' }],
      edges: chain('start', 'wait', 'ok'),
    });
    setTimeout(() => h.hub.pushAppLog(app.id, { ts: Date.now(), level: 'fatal', tag: 'crash', message: 'StateError: Bad state', kind: 'crash' }), 30);
    const run = await h.run('crash');
    expect(run.status).toBe('failed');
    expect(step(run.steps, 'ok').errorCode).toBe('flow.noErrors.found');
  });
});

describe('mocks and outputs', () => {
  it('adds a mock for the run and removes it afterwards', async () => {
    h.mocks = [{ id: 'user-rule', enabled: true, method: '*', url: '/x', match: 'contains', action: { type: 'delay', delayMs: 10 }, createdAt: 1 }];
    let during: string[] = [];
    await h.save({
      id: 'mock',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'm', type: 'mock.add', params: { url: '/checkout', status: 500, body: '{"error":"x"}', appOnly: false } },
        { id: 'off', type: 'mock.toggle', params: { rule: 'user-rule', enabled: false } },
        { id: 'peek', type: 'logic.delay', params: { durationMs: 400 } },
      ],
      edges: chain('start', 'm', 'off', 'peek'),
    });
    const run = h.engine.start('mock');
    await new Promise((r) => setTimeout(r, 60));
    during = h.mocks.map((r) => `${r.id}:${r.enabled}`);
    await h.engine.settle((await run).id);
    expect(during[0]).toMatch(/^flow-.*-m:true$/);
    expect(during[1]).toBe('user-rule:false');
    expect(h.mocks.map((r) => `${r.id}:${r.enabled}`)).toEqual(['user-rule:true']);
  });

  it('posts to Slack with the run summary', async () => {
    h.setSlack(true);
    await h.save({ id: 'slack', name: 'Smoke', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 's', type: 'output.slack', params: { text: '{{run.flowName}}: {{run.status}}' } }], edges: chain('start', 's') });
    const run = await h.run('slack');
    expect(run.status).toBe('passed');
    expect(h.slackSent[0]).toContain('Smoke: passed');
    expect(h.slackSent[0]).toContain('1 passed');
  });

  it('skips the Slack step when Slack is not connected', async () => {
    await h.save({ id: 'noslack', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 's', type: 'output.slack' }], edges: chain('start', 's') });
    const run = await h.run('noslack');
    expect(step(run.steps, 's')).toMatchObject({ status: 'skipped', unsupported: 'preflight.slack.notConfigured' });
  });
});

describe('control', () => {
  it('cancels a running run', async () => {
    await h.save({ id: 'long', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'w', type: 'logic.delay', params: { durationMs: 60_000 } }], edges: chain('start', 'w') });
    const run = await h.engine.start('long');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.engine.cancel(run.id)).toBe(true);
    await h.engine.settle(run.id);
    const saved = (await h.runs.get(run.id))!;
    expect(saved.status).toBe('cancelled');
    expect(step(saved.steps, 'w').status).toBe('cancelled');
  });

  it('runs from a step with the previous run\'s outputs', async () => {
    h.route(() => json({ id: 5 }));
    await h.save({
      id: 'from',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'a', type: 'http.request', params: { url: 'https://x.test/' } },
        { id: 'b', type: 'output.note', params: { text: 'id={{a.body.id}}' } },
      ],
      edges: chain('start', 'a', 'b'),
    });
    await h.run('from');
    h.requests.length = 0;
    const run = await h.run('from', { startNodeId: 'b' });
    expect(run.status).toBe('passed');
    expect(run.steps.map((s) => s.nodeId)).toEqual(['b']);
    expect(step(run.steps, 'b').output).toEqual({ text: 'id=5' });
    expect(h.requests).toHaveLength(0);
  });
});
