/**
 * Mock rule hit counts kept by the server: once per request, kept through clears, forgotten for deleted rules,
 * the same map in every window (snapshot + batches).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MockRule, type ServerToUi } from '@durbun/protocol';
import type { Hub } from '../../src/types';
import { createHub } from '../../src/hub';
import { MAX_APPS_PER_RULE, MockHitCounter } from '../../src/hub/mockHits';
import { silentLogger } from '../../src/util/logger';
import { connectUi, startTestApp, type TestApp } from '../http/fakes';
import { appInput, collectChanges, device, makeHub, sleep } from './helpers';

const PIXEL = 'android:R5CT1234';
let hub: Hub | undefined;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  hub?.dispose();
  hub = undefined;
});

function setup(h: Hub) {
  h.upsertDevice(device(PIXEL));
  const app = h.registerApp(appInput(PIXEL, { app: { id: 'com.example.shop', name: 'Shop', pid: 4001 } }));
  let n = 0;
  const mocked = (ruleId: string, status = 200) => {
    const id = `r${++n}`;
    const ts = Date.now();
    h.netRequest(app.id, { type: 'net.request', id, ts, method: 'GET', url: `https://api.example.com/${id}`, headers: [], source: 'dart:io' });
    h.netResponse(app.id, { type: 'net.response', id, ts: ts + 5, status, headers: [], mocked: true, mockRuleId: ruleId });
    return id;
  };
  return { app, mocked };
}

describe('mock rule hit counts', () => {
  it('counts each mocked request once, per rule and per app session; clears keep the counts', async () => {
    hub = makeHub();
    const { app, mocked } = setup(hub);
    const id = mocked('login');
    mocked('login');
    mocked('cart', 503);
    // The same response again (a retry of the message) is not a new hit.
    hub.netResponse(app.id, { type: 'net.response', id, ts: Date.now(), status: 200, headers: [], mocked: true, mockRuleId: 'login' });
    // A real (unmocked) answer counts nothing.
    hub.netRequest(app.id, { type: 'net.request', id: 'real', ts: Date.now(), method: 'GET', url: 'https://api.example.com/real', headers: [], source: 'dart:io' });
    hub.netResponse(app.id, { type: 'net.response', id: 'real', ts: Date.now(), status: 200, headers: [] });
    const hits = hub.getMockHits!();
    expect(hits.login).toMatchObject({ count: 2, byApp: { [app.id]: 2 } });
    expect(hits.cart!.count).toBe(1);
    expect(hits.login!.lastTs).toBeGreaterThan(0);
    expect(hits).not.toHaveProperty('real');

    hub.clear('network');
    hub.clear('all');
    expect(hub.getMockHits!().login!.count).toBe(2);

    hub.retainMockHits!(['cart']);
    expect(Object.keys(hub.getMockHits!())).toEqual(['cart']);
  });

  it('a failure answered by a rule counts too', () => {
    hub = makeHub();
    const { app } = setup(hub);
    hub.netRequest(app.id, { type: 'net.request', id: 'x', ts: Date.now(), method: 'GET', url: 'https://a.test/x', headers: [], source: 'dart:io' });
    hub.netError(app.id, { type: 'net.error', id: 'x', ts: Date.now(), error: 'Mocked timeout', mocked: true, mockRuleId: 'slow' });
    expect(hub.getMockHits!().slow!.count).toBe(1);
  });

  it('batches carry the whole map only when it changed; deleting a rule sends the smaller map', async () => {
    hub = makeHub();
    const { mocked } = setup(hub);
    const c = collectChanges(hub);
    mocked('login');
    await sleep(150);
    expect(c.changes.find((ch) => ch.mockHits)!.mockHits).toMatchObject({ login: { count: 1 } });
    const before = c.changes.length;
    hub.pushDeviceLogs(PIXEL, [{ ts: Date.now(), level: 'info', tag: 't', message: 'unrelated' }]);
    await sleep(150);
    expect(c.changes.slice(before).some((ch) => ch.mockHits)).toBe(false);
    hub.retainMockHits!([]);
    await sleep(150);
    expect(c.changes.at(-1)!.mockHits).toEqual({});
    c.stop();
  });

  it('bounds the sessions kept per rule; the total stays exact', () => {
    const counter = new MockHitCounter();
    for (let i = 0; i < MAX_APPS_PER_RULE + 10; i++) counter.hit('r', `app:${i}`, i);
    const snap = counter.snapshot().r!;
    expect(snap.count).toBe(MAX_APPS_PER_RULE + 10);
    expect(Object.keys(snap.byApp!)).toHaveLength(MAX_APPS_PER_RULE);
    expect(snap.byApp).not.toHaveProperty('app:0');
  });

  it('real server: every window gets the same counts; deleting the rule resets it', async () => {
    const real = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
    hub = real;
    t = await startTestApp({ hub: real });
    const rule: MockRule = { id: 'login', enabled: true, method: '*', url: '/x', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 1 };
    await t.config.setMocks([rule]);
    const { mocked } = setup(real);
    mocked('login');
    mocked('login');
    await sleep(150);
    const late = await connectUi(t.port);
    await late.synced();
    const snap = late.messages.find((m) => m.type === 'snapshot') as Extract<ServerToUi, { type: 'snapshot' }>;
    expect(snap.mockHits).toMatchObject({ login: { count: 2 } });

    const from = late.messages.length;
    await t.config.setMocks([]);
    await late.waitFor((m) => m.type === 'batch' && m.mockHits !== undefined, 2_000, from);
    const batch = late.messages.slice(from).find((m) => m.type === 'batch' && m.mockHits) as Extract<ServerToUi, { type: 'batch' }>;
    expect(batch.mockHits).toEqual({});
    late.ws.terminate();
  });
});
