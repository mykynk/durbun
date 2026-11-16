/**
 * Store limits the UI learns, eviction counts, resuming WS /ui from the client's copy, and the revision checks
 * that keep two windows from overwriting each other's mock rules, flows and environments.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowDoc, FlowEnvironments, LogEntry, MockRule, SdkNetRequest, ServerToUi } from '@durbun/protocol';
import { createHub } from '../../src/hub/index';
import type { Hub, HubChange } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { batchFromChange, parseResumeQuery } from '../../src/http/uiSocket';
import { appInput, device, makeHub, makeSettings } from '../hub/helpers';
import { connectUi, startTestApp, type TestApp, type UiTestClient } from './fakes';

const PIXEL = 'android:pixel';

let t: TestApp | undefined;
const clients: UiTestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.close();
  t = undefined;
});

function lines(h: Hub, n: number, patch: Partial<LogEntry> = {}, prefix = 'line'): void {
  h.pushDeviceLogs(
    PIXEL,
    Array.from({ length: n }, (_, i) => ({ ts: 1_000 + i, level: 'info' as const, tag: 't', message: `${prefix} ${i}`, process: 'com.mykynk.pati', ...patch })),
  );
}

function req(id: string, ts = 10_000): SdkNetRequest {
  return { type: 'net.request', id, ts, method: 'GET', url: `https://api.example.com/${id}`, headers: [], source: 'dart:io' } as SdkNetRequest;
}

type Snapshot = Extract<ServerToUi, { type: 'snapshot' }>;
type History = Extract<ServerToUi, { type: 'history' }>;

function historyIds(c: UiTestClient, from = 0): number[] {
  return c.messages
    .slice(from)
    .filter((m): m is History => m.type === 'history')
    .flatMap((m) => m.logs.map((l) => l.id));
}

describe('eviction counts', () => {
  it('count the lines the line limit deleted, per device and process, and the oldest line still held', () => {
    const h = makeHub({ maxLogEntries: 5 });
    h.upsertDevice(device(PIXEL));
    const before = h.getLogCount();
    lines(h, 10);
    const ev = h.getEvictions!();
    const deleted = before + 10 - 5;
    expect(ev.logs).toBe(deleted);
    expect(ev.logsByBytes).toBe(0);
    expect(ev.byDevice[PIXEL]?.logs).toBe(deleted);
    expect(ev.byProcess[`${PIXEL}|com.mykynk.pati`]).toBeGreaterThan(0);
    expect(ev.oldestLogId).toBe(h.getLogs()[0]!.id);
    expect(ev.lastEvictedLogTs).toBeDefined();
    expect(h.getLimits!()).toMatchObject({ maxLogEntries: 5, maxNetworkEntries: 5_000 });
  });

  it('say when the memory budget, not the line limit, deleted them', () => {
    const h = createHub({ settings: makeSettings(), logger: silentLogger, maxLogBytes: 4_000 });
    h.upsertDevice(device(PIXEL));
    lines(h, 40, { message: 'x'.repeat(300) });
    const ev = h.getEvictions!();
    expect(ev.logs).toBeGreaterThan(0);
    expect(ev.logsByBytes).toBe(ev.logs);
    expect(h.getLimits!().maxLogBytes).toBe(4_000);
  });

  it('count deleted requests per app session, and go to the UI with the next batch only when they changed', async () => {
    const h = makeHub({ maxNetworkEntries: 100 });
    h.upsertDevice(device(PIXEL));
    h.setSettings(makeSettings({ maxNetworkEntries: 2 }));
    const app = h.registerApp(appInput(PIXEL));
    const changes: HubChange[] = [];
    h.subscribe((c) => changes.push(c));
    h.netRequest(app.id, req('1', 1));
    h.netRequest(app.id, req('2', 2));
    h.netRequest(app.id, req('3', 3));
    await new Promise((r) => setTimeout(r, 150));
    const ev = h.getEvictions!();
    expect(ev.requests).toBe(1);
    expect(ev.byApp[app.id]).toEqual({ logs: 0, requests: 1 });
    expect(ev.lastEvictedRequestTs).toBe(1);
    const withCounts = changes.filter((c) => c.evictions);
    expect(withCounts.length).toBe(1);
    expect(withCounts[0]!.evictions!.requests).toBe(1);
    expect(changes.every((c, i) => i > 0 || typeof c.netSeq === 'number')).toBe(true);
  });

  it('start again with an unscoped clear and drop a cleared device', () => {
    const h = makeHub({ maxLogEntries: 3 });
    h.upsertDevice(device(PIXEL));
    h.upsertDevice(device('android:other'));
    lines(h, 6);
    h.pushDeviceLogs('android:other', Array.from({ length: 6 }, (_, i) => ({ ts: i, level: 'info' as const, tag: 't', message: `o${i}` })));
    const before = h.getEvictions!();
    expect(before.byDevice[PIXEL]).toBeDefined();
    const epoch = h.getEpoch!();
    h.clear('logs', { deviceId: PIXEL });
    const after = h.getEvictions!();
    expect(after.byDevice[PIXEL]).toBeUndefined();
    expect(after.logs).toBe(before.logs - before.byDevice[PIXEL]!.logs);
    expect(h.getEpoch!()).not.toBe(epoch);
    h.clear('all');
    expect(h.getEvictions!()).toMatchObject({ logs: 0, requests: 0, byDevice: {} });
  });

  it('a UI batch carries the counts (alone too) and the network counter, never the counter alone', () => {
    const h = makeHub({ maxLogEntries: 2 });
    h.upsertDevice(device(PIXEL));
    lines(h, 4);
    const evictions = h.getEvictions!();
    expect(batchFromChange({ evictions, netSeq: 3 })).toEqual({ type: 'batch', evictions, netSeq: 3 });
    expect(batchFromChange({ netSeq: 3 })).toBeNull();
    expect(batchFromChange({ logs: h.getLogs(), netSeq: 3 })).toMatchObject({ netSeq: 3 });
  });

  it('a smaller line limit sends the new oldest line in a batch', async () => {
    const h = makeHub();
    h.upsertDevice(device(PIXEL));
    lines(h, 20);
    await new Promise((r) => setTimeout(r, 150));
    const changes: HubChange[] = [];
    h.subscribe((c) => changes.push(c));
    h.setSettings(makeSettings({ maxLogEntries: 5 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(changes.at(-1)?.evictions?.oldestLogId).toBe(h.getLogs()[0]!.id);
  });
});

describe('WS /ui resume', () => {
  it('parses the query and ignores malformed values', () => {
    expect(parseResumeQuery(new URLSearchParams('epoch=ab.0&afterLogId=12&netSeq=3'))).toEqual({ epoch: 'ab.0', afterLogId: 12, netSeq: 3 });
    expect(parseResumeQuery(new URLSearchParams('afterLogId=12&netSeq=3'))).toBeUndefined();
    expect(parseResumeQuery(new URLSearchParams('epoch=x&afterLogId=-1&netSeq=3'))).toBeUndefined();
    expect(parseResumeQuery(new URLSearchParams('epoch=x&afterLogId=1.5&netSeq=0'))).toBeUndefined();
  });

  async function setup(): Promise<{ h: Hub; app: string; snap: Snapshot; lastId: number }> {
    const h = makeHub();
    h.upsertDevice(device(PIXEL));
    const app = h.registerApp(appInput(PIXEL)).id;
    lines(h, 5);
    h.netRequest(app, req('a'));
    h.netRequest(app, req('b'));
    t = await startTestApp({ hub: h });
    const first = await connectUi(t.port);
    clients.push(first);
    await first.synced();
    const snap = await first.waitForType('snapshot');
    const lastId = Math.max(...historyIds(first));
    first.close();
    return { h, app, snap, lastId };
  }

  it('the hello carries the limits; the snapshot the epoch, netSeq and eviction counts', async () => {
    const { snap } = await setup();
    const c = await connectUi(t!.port);
    clients.push(c);
    const hello = await c.waitForType('hello');
    expect(hello.limits).toMatchObject({ maxLogEntries: 200_000, maxNetworkEntries: 5_000 });
    expect(typeof snap.epoch).toBe('string');
    expect(snap.netSeq).toBeGreaterThan(0);
    expect(snap.evictions).toMatchObject({ logs: 0, requests: 0 });
    expect(snap.resumed).toBeUndefined();
  });

  it('continues from the last line and request the client holds', async () => {
    const { h, app, snap, lastId } = await setup();
    lines(h, 3, {}, 'while away');
    h.netResponse(app, { type: 'net.response', id: 'b', ts: 10_500, status: 200, headers: [] } as never);
    h.netRequest(app, req('c'));
    await new Promise((r) => setTimeout(r, 150));

    const c = await connectUi(t!.port, undefined, `?epoch=${snap.epoch}&afterLogId=${lastId}&netSeq=${snap.netSeq}`);
    clients.push(c);
    await c.synced();
    const resumed = await c.waitForType('snapshot');
    expect(resumed.resumed).toEqual({ afterLogId: lastId, networkIds: expect.arrayContaining(['a', 'b', 'c'].map((id) => expect.stringContaining(id))) });
    expect(resumed.network.map((n) => n.id.split(':').pop())).toEqual(['b', 'c']);
    const ids = historyIds(c);
    expect(ids.every((id) => id > lastId)).toBe(true);
    expect(resumed.logCount).toBe(ids.length);
    const messages = c.messages
      .filter((m): m is History => m.type === 'history')
      .flatMap((m) => m.logs.map((l) => l.message));
    expect(messages).toEqual(expect.arrayContaining(['while away 0', 'while away 1', 'while away 2']));
    expect(messages).not.toContain('line 0');
  });

  it('sends everything when the epoch is another run, a clear happened, or the ids are ahead of the server', async () => {
    const { h, snap, lastId } = await setup();
    const full = (m: Snapshot) => m.resumed === undefined;

    const other = await connectUi(t!.port, undefined, `?epoch=other.0&afterLogId=${lastId}&netSeq=${snap.netSeq}`);
    clients.push(other);
    await other.synced();
    expect(full(await other.waitForType('snapshot'))).toBe(true);
    expect(historyIds(other)).toContain(1);

    const ahead = await connectUi(t!.port, undefined, `?epoch=${snap.epoch}&afterLogId=${lastId + 1_000}&netSeq=${snap.netSeq}`);
    clients.push(ahead);
    expect(full(await ahead.waitForType('snapshot'))).toBe(true);

    h.clear('network');
    const afterClear = await connectUi(t!.port, undefined, `?epoch=${snap.epoch}&afterLogId=${lastId}&netSeq=${snap.netSeq}`);
    clients.push(afterClear);
    expect(full(await afterClear.waitForType('snapshot'))).toBe(true);
  });
});

describe('revision checks', () => {
  const rule = (id: string): MockRule => ({ id, enabled: true, method: '*', url: '/x', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 1 });

  it('mocks.set with an old baseRevision is refused with the current rules; without one it overwrites', async () => {
    t = await startTestApp();
    const a = await connectUi(t.port);
    const b = await connectUi(t.port);
    clients.push(a, b);
    const base = (await a.waitForType('snapshot')).mocksRevision!;
    expect(typeof base).toBe('number');
    await b.waitForType('snapshot');

    const from = b.messages.length;
    expect(await a.command({ name: 'mocks.set', rules: [rule('one')], baseRevision: base })).toMatchObject({ ok: true });
    const pushed = await b.waitFor<Extract<ServerToUi, { type: 'mocks' }>>((m) => m.type === 'mocks', 3_000, from);
    expect(pushed.revision).toBe(base + 1);

    const refused = await b.command({ name: 'mocks.set', rules: [rule('two')], baseRevision: base });
    expect(refused).toMatchObject({ ok: false, code: 'mocks.conflict', data: { revision: base + 1, rules: [expect.objectContaining({ id: 'one' })] } });
    expect(t.config.mocks.map((r) => r.id)).toEqual(['one']);

    expect(await b.command({ name: 'mocks.set', rules: [rule('two')] })).toMatchObject({ ok: true });
    expect(t.config.mocks.map((r) => r.id)).toEqual(['two']);
  });

  it("a flow run's own rules do not change the revision", async () => {
    t = await startTestApp();
    const before = t.config.mocksRevision!;
    t.config.setMocks([...t.config.mocks, rule('flow-run1-a')]);
    t.config.setMocks(t.config.mocks.filter((r) => r.id !== 'flow-run1-a'));
    expect(t.config.mocksRevision).toBe(before);
  });

  const json = { 'Content-Type': 'application/json' };
  async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${t!.base}${url}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  }
  const flow = (name: string) => ({
    format: 'durbun-flow',
    version: 1,
    id: 'edited',
    name,
    nodes: [{ id: 'start', type: 'trigger.manual' }],
    edges: [],
  });

  it('a flow PUT based on an older copy is refused with 409 flow.conflict', async () => {
    t = await startTestApp({ flowsBackground: false });
    const created = await call<{ flow: FlowDoc }>('POST', '/api/flows', { flow: flow('First') });
    const base = created.data.flow.updatedAt!;
    const saved = await call<{ flow: FlowDoc }>('PUT', '/api/flows/edited', { flow: flow('Window A'), baseUpdatedAt: base });
    expect(saved.status).toBe(200);
    expect(saved.data.flow.updatedAt).toBeGreaterThan(base);

    const stale = await call<{ code: string }>('PUT', '/api/flows/edited', { flow: flow('Window B'), baseUpdatedAt: base });
    expect(stale).toMatchObject({ status: 409, data: { code: 'flow.conflict' } });
    expect((await call<{ flow: FlowDoc }>('GET', '/api/flows/edited')).data.flow.name).toBe('Window A');

    expect((await call('PUT', '/api/flows/edited', { flow: flow('Window B') })).status).toBe(200);
  });

  it('two saves at the same moment get different updatedAt values', async () => {
    t = await startTestApp({ flowsBackground: false });
    const created = await call<{ flow: FlowDoc }>('POST', '/api/flows', { flow: flow('First') });
    const base = created.data.flow.updatedAt!;
    const [x, y] = await Promise.all([
      call('PUT', '/api/flows/edited', { flow: flow('A'), baseUpdatedAt: base }),
      call('PUT', '/api/flows/edited', { flow: flow('B'), baseUpdatedAt: base }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });

  it('an environments PUT with an old revision is refused with 409 env.conflict', async () => {
    t = await startTestApp({ flowsBackground: false });
    const loaded = (await call<FlowEnvironments>('GET', '/api/flow-environments')).data;
    expect(typeof loaded.revision).toBe('number');
    const env = (name: string) => ({ ...loaded, environments: [{ id: 'dev', name, vars: [] }] });
    const saved = await call<FlowEnvironments>('PUT', '/api/flow-environments', env('Dev A'));
    expect(saved.status).toBe(200);
    expect(saved.data.revision).toBe(loaded.revision! + 1);
    const stale = await call<{ code: string }>('PUT', '/api/flow-environments', env('Dev B'));
    expect(stale).toMatchObject({ status: 409, data: { code: 'env.conflict' } });
    const { revision: _r, ...overwrite } = env('Dev B');
    expect((await call('PUT', '/api/flow-environments', overwrite)).status).toBe(200);
  });
});
