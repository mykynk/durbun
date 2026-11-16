import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowBatch } from '@durbun/protocol';
import { BatchService, FlowBatchError, MAX_BATCH_FLOWS, batchRequest } from '../../src/flows/batches';
import { silentLogger } from '../../src/util/logger';
import { device } from '../hub/helpers';
import { chain, harness, json, type Harness } from './helpers';

let h: Harness;
let svc: BatchService;
beforeEach(async () => {
  h = await harness();
  svc = new BatchService({ dataDir: h.dir, logger: silentLogger, flows: h.flows, engine: h.engine, now: () => Date.now() });
});
afterEach(async () => {
  await svc.dispose();
  await h.close();
});

/** A flow that asks /<path> and expects 2xx. */
const httpFlow = (id: string, p: string, tags: string[] = ['smoke']) =>
  h.save({
    id,
    name: `Flow ${id}`,
    tags,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      { id: 'call', type: 'http.request', label: `Call ${p}`, params: { method: 'GET', url: `https://api.example.test/${p}`, expectStatus: '2xx' } },
    ],
    edges: chain('start', 'call'),
  });

async function finish(started: FlowBatch): Promise<FlowBatch> {
  await svc.settle();
  return svc.get(started.id)!;
}

describe('set runs', () => {
  beforeEach(() => {
    h.route(({ url }) => (url.pathname === '/broken' ? json({ error: 'nope' }, 500) : json({ ok: true })));
  });

  it('runs every flow of a tag one after another and reports each', async () => {
    await httpFlow('b-login', 'login');
    await httpFlow('a-cart', 'broken');
    await httpFlow('c-other', 'other', ['nightly']);
    const started = await svc.start({ tag: 'SMOKE' });
    expect(started.status).toBe('running');
    expect(started.tag).toBe('SMOKE');
    // By name: "Flow a-cart" first.
    expect(started.items.map((i) => i.flowId)).toEqual(['a-cart', 'b-login']);

    const done = await finish(started);
    expect(done.status).toBe('failed');
    expect(done.counts).toEqual({ passed: 1, failed: 1, skipped: 0, cancelled: 0, total: 2 });
    const [cart, login] = done.items;
    expect(cart).toMatchObject({ status: 'failed', failedStep: { nodeId: 'call', label: 'Call broken', errorCode: 'flow.http.status' }, reason: { code: 'flow.http.status' } });
    expect(login).toMatchObject({ status: 'passed', counts: { passed: 2, failed: 0 } });
    expect(login!.durationMs).toBeTypeOf('number');
    // The runs are ordinary runs that know their set, one after the other.
    const runs = await Promise.all(done.items.map((i) => h.runs.get(i.runId!)));
    expect(runs.map((r) => r?.batchId)).toEqual([done.id, done.id]);
    expect(runs[1]!.startedAt).toBeGreaterThanOrEqual(runs[0]!.endedAt!);
  });

  it('stops after the first failure when asked, and skips the rest with the reason', async () => {
    await httpFlow('one', 'broken');
    await httpFlow('two', 'ok');
    const done = await finish(await svc.start({ flowIds: ['one', 'two'], onFailure: 'stop' }));
    expect(done.status).toBe('failed');
    expect(done.items.map((i) => i.status)).toEqual(['failed', 'skipped']);
    expect(done.items[1]!.reason).toMatchObject({ code: 'flow.batch.afterFailure', params: { flow: 'Flow one' } });
    expect(done.reason).toMatchObject({ code: 'flow.batch.stoppedAfterFailure' });
    expect(h.requests.map((r) => new URL(r.url).pathname)).toEqual(['/broken']);
  });

  it('skips a flow the device cannot run and goes on', async () => {
    await h.save({ id: 'shot', name: 'Screenshot', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'snap', type: 'device.screenshot' }], edges: chain('start', 'snap') });
    await httpFlow('api', 'ok');
    const done = await finish(await svc.start({ flowIds: ['shot', 'api', 'gone'] }));
    expect(done.items.map((i) => i.status)).toEqual(['skipped', 'passed', 'skipped']);
    expect(done.items[0]!.reason?.code).toMatch(/^preflight\./);
    expect(done.items[0]!.runId).toBeUndefined();
    expect(done.items[2]).toMatchObject({ flowName: 'gone', reason: { code: 'flow.notFound' } });
    expect(done.status).toBe('passed');
    expect(done.counts.skipped).toBe(2);
  });

  it('skips steps that are hard to undo unless the person confirmed them', async () => {
    h.hub.upsertDevice(device('android:A1', { actions: ['app-clear-data'] }));
    await h.save({
      id: 'wipe',
      name: 'Wipe',
      target: { appId: 'com.example.app' },
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'clear', type: 'device.clearData', label: 'Clear data' }],
      edges: chain('start', 'clear'),
    });
    const refused = await finish(await svc.start({ flowIds: ['wipe'] }));
    expect(refused.items[0]).toMatchObject({ status: 'skipped', reason: { code: 'flow.batch.irreversible', params: { steps: 'Clear data' } } });
    expect(h.actions).toEqual([]);
    const allowed = await finish(await svc.start({ flowIds: ['wipe'], allowIrreversible: true }));
    expect(allowed.items[0]!.status).toBe('passed');
    expect(allowed.target).toMatchObject({ deviceId: 'android:A1' });
  });

  it('cancels the running flow and does not start the rest; one set at a time', async () => {
    let release: () => void = () => {};
    h.route(() => new Promise((resolve) => (release = () => resolve(json({ ok: true })))));
    await httpFlow('slow', 'slow');
    await httpFlow('next', 'next');
    const started = await svc.start({ flowIds: ['slow', 'next'] });
    await expect(svc.start({ flowIds: ['next'] })).rejects.toMatchObject({ code: 'flow.batch.busy', status: 409 });
    for (let i = 0; i < 50 && !svc.get(started.id)?.items[0]?.runId; i++) await new Promise((r) => setTimeout(r, 10));
    expect(svc.cancel(started.id)).toBe(true);
    release();
    const done = await finish(started);
    expect(done.status).toBe('cancelled');
    expect(done.items.map((i) => i.status)).toEqual(['cancelled', 'cancelled']);
    expect(done.items[1]!.reason?.code).toBe('flow.batch.notRun');
    expect(svc.cancel(started.id)).toBe(false);
  });

  it('refuses empty and oversized sets with codes the UI words', async () => {
    await expect(svc.start({})).rejects.toMatchObject({ code: 'flow.batch.empty' });
    await expect(svc.start({ tag: 'none' })).rejects.toMatchObject({ code: 'flow.batch.noTagged', params: { tag: 'none' } });
    const ids = Array.from({ length: MAX_BATCH_FLOWS + 1 }, (_, i) => `f${i}`);
    await expect(svc.start({ flowIds: ids })).rejects.toBeInstanceOf(FlowBatchError);
  });

  it('keeps the set on disk and marks one that was running when Dürbün quit', async () => {
    await httpFlow('one', 'ok');
    const done = await finish(await svc.start({ flowIds: ['one'] }));
    const file = path.join(h.dir, 'flow-batches', `${done.id}.json`);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as FlowBatch;
    expect(onDisk.status).toBe('passed');
    // Pretend it was cut off mid-run.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ ...onDisk, status: 'running', items: [{ ...onDisk.items[0], status: 'running' }] }));
    const again = new BatchService({ dataDir: h.dir, logger: silentLogger, flows: h.flows, engine: h.engine, now: () => Date.now() });
    await again.load();
    expect(again.get(done.id)).toMatchObject({ status: 'cancelled', reason: { code: 'flow.batch.interrupted' }, items: [{ status: 'cancelled' }] });
  });

  it('reads requests defensively', () => {
    expect(batchRequest({ flowIds: ['a', 'a', 3, ''], tag: '  ', target: { deviceId: 'd', appId: ' ' }, onFailure: 'nope', allowIrreversible: 'yes' })).toEqual({ flowIds: ['a'], target: { deviceId: 'd' } });
    expect(batchRequest(null)).toEqual({});
    expect(batchRequest({ environmentId: null, onFailure: 'stop' })).toEqual({ environmentId: null, onFailure: 'stop' });
  });
});
