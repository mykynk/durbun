import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowRun, FlowRunHeader } from '@durbun/protocol';
import { MAX_PINNED_RUNS, MAX_RUNS, RunPinError, RunStore } from '../../src/flows/runs';
import { silentLogger } from '../../src/util/logger';
import { startTestApp, type TestApp } from '../http/fakes';

const dirs: string[] = [];
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function store(): Promise<RunStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'durbun-pins-'));
  dirs.push(dir);
  const s = new RunStore(dir, silentLogger);
  await s.load();
  return s;
}

let seq = 0;
function run(flowId: string, startedAt: number, extra: Partial<FlowRun> = {}): FlowRun {
  const id = `r${(++seq).toString(36)}-${(0xa00000 + seq).toString(16)}`;
  return {
    id,
    flowId,
    flowName: flowId,
    status: 'passed',
    startedAt,
    endedAt: startedAt + 5,
    trigger: { kind: 'manual' },
    steps: [],
    counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
    ...extra,
  };
}

describe('pinned flow runs (store)', () => {
  it('pruning never removes a pinned run; it does not count toward the run limit', async () => {
    const s = await store();
    const old = run('login', 1);
    await s.save(old);
    await s.setPinned(old.id, true);
    for (let i = 0; i < MAX_RUNS + 5; i++) await s.save(run('login', 10 + i));
    const ids = s.list('login', 1_000).map((h) => h.id);
    expect(ids).toContain(old.id);
    expect(ids.length).toBe(MAX_RUNS + 1);
    expect((await s.get(old.id))?.pinned).toBe(true);

    // Unpinned again: past the limit, it goes at once.
    await s.setPinned(old.id, false);
    expect(s.list('login', 1_000).map((h) => h.id)).not.toContain(old.id);
  });

  it('clearing a flow keeps its pinned runs; deleting one explicitly removes it', async () => {
    const s = await store();
    const a = run('login', 1);
    const b = run('login', 2);
    const other = run('cart', 3);
    for (const r of [a, b, other]) await s.save(r);
    await s.setPinned(a.id, true);
    expect(await s.clear('login')).toBe(1);
    expect(s.pinnedCount('login')).toBe(1);
    expect(s.list().map((h) => h.id).sort()).toEqual([a.id, other.id].sort());
    expect(await s.clear()).toBe(1);
    expect(s.list().map((h) => h.id)).toEqual([a.id]);
    expect(await s.remove(a.id)).toBe(true);
    expect(s.list()).toEqual([]);
  });

  it('a running run keeps the pin through the engine’s later saves; unpinning sticks too', async () => {
    const s = await store();
    const live = run('login', 1, { status: 'running', endedAt: undefined });
    await s.save(live);
    await s.setPinned(live.id, true);
    // The engine saves its own copy (without the flag).
    const copy = { ...live, status: 'passed' as const, endedAt: 9 };
    delete copy.pinned;
    await s.save(copy);
    expect(s.list()[0]!.pinned).toBe(true);
    expect((await s.get(live.id))?.pinned).toBe(true);
    await s.setPinned(live.id, false);
    await s.save({ ...copy, pinned: true });
    expect(s.list()[0]!.pinned).toBeUndefined();
  });

  it('refuses more than MAX_PINNED_RUNS pins; an import beyond it comes in unpinned', async () => {
    const s = await store();
    const list: FlowRun[] = [];
    for (let i = 0; i < MAX_PINNED_RUNS + 1; i++) list.push(run('login', i + 1));
    for (const r of list) await s.save(r);
    for (const r of list.slice(0, MAX_PINNED_RUNS)) await s.setPinned(r.id, true);
    const refused = await s.setPinned(list[MAX_PINNED_RUNS]!.id, true).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RunPinError);
    expect(refused).toMatchObject({ status: 409, code: 'flowRun.pinLimit', params: { max: MAX_PINNED_RUNS } });
    const imported = run('login', 999, { pinned: true });
    await s.save(imported);
    expect(s.list().find((h) => h.id === imported.id)!.pinned).toBeUndefined();
    await expect(s.setPinned('nope-000000', true)).rejects.toMatchObject({ status: 404, code: 'flowRun.notFound' });
  });

  it('a restart reads the pins back from the run files', async () => {
    const s = await store();
    const r = run('login', 1);
    await s.save(r);
    await s.setPinned(r.id, true);
    await s.flush();
    const again = new RunStore(path.dirname(s.dir), silentLogger);
    await again.load();
    expect(again.list()[0]).toMatchObject({ id: r.id, pinned: true });
    expect(JSON.parse(await readFile(path.join(s.dir, `${r.id}.json`), 'utf8')).pinned).toBe(true);
  });
});

describe('pinned flow runs (API)', () => {
  const json = { 'Content-Type': 'application/json' };
  async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${t!.base}${url}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  }

  async function finished(id: string): Promise<FlowRun> {
    for (let i = 0; i < 100; i++) {
      const { data } = await call<FlowRun>('GET', `/api/flow-runs/${id}`);
      if (data.status !== 'running') return data;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('run did not end');
  }

  it('PATCH pins, DELETE ?flowId keeps pinned runs and says how many, a package export keeps the flag', async () => {
    t = await startTestApp({ flowsBackground: false });
    const flow = {
      format: 'durbun-flow',
      version: 1,
      id: 'login',
      name: 'Login',
      nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'note', type: 'output.note', params: { text: 'hi' } }],
      edges: [{ from: 'start', to: 'note' }],
    };
    expect((await call('POST', '/api/flows', { flow })).status).toBe(201);
    const a = await finished((await call<FlowRun>('POST', '/api/flows/login/run', {})).data.id);
    await finished((await call<FlowRun>('POST', '/api/flows/login/run', {})).data.id);

    const pinned = await call<FlowRunHeader>('PATCH', `/api/flow-runs/${a.id}`, { pinned: true });
    expect(pinned).toMatchObject({ status: 200, data: { id: a.id, pinned: true, stepCount: 2 } });
    expect((await call('PATCH', `/api/flow-runs/${a.id}`, { pinned: 'yes' })).status).toBe(400);
    expect((await call('PATCH', '/api/flow-runs/zzz-000000', { pinned: true })).data).toMatchObject({ code: 'flowRun.notFound' });

    const list = await call<{ runs: FlowRunHeader[] }>('GET', '/api/flow-runs?flowId=login');
    expect(list.data.runs.find((h) => h.id === a.id)!.pinned).toBe(true);

    const exported = await call<{ contents: { runs?: { run: FlowRun }[] } }>('POST', '/api/packages/export', { kind: 'backup', include: { runs: true } });
    expect(exported.status).toBe(200);
    expect(exported.data.contents.runs!.find((r) => r.run.id === a.id)!.run.pinned).toBe(true);

    const cleared = await call<{ removed: number; keptPinned: number }>('DELETE', '/api/flow-runs?flowId=login');
    expect(cleared.data).toEqual({ removed: 1, keptPinned: 1 });
    expect((await call<FlowRun>('GET', `/api/flow-runs/${a.id}`)).data.pinned).toBe(true);
  });
});
