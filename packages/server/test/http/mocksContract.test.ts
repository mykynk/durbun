/**
 * The UI's dev mock (`packages/ui/dev/mock-rules.mjs`, used by `mock-server.mjs`) must save mock rules the way the
 * real server does: the same normalized rules, the same refusals (`config.invalid` with the same English text) and the
 * same conflict reply. A mock that accepts what the server refuses hides a broken editor until the real app runs.
 * Each case sends the same `mocks.set` to the real server (WS /ui, in process) and to the mock, and compares replies.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectUi, startTestApp, type TestApp, type UiTestClient } from './fakes';

type Reply = { ok: boolean; data?: unknown; error?: string; code?: string };
type MockStore = { rules: unknown[]; revision: number; set(command: object): Reply };
type MockModule = { createMockRules(initial: unknown[]): MockStore };

let real: TestApp;
let ui: UiTestClient;
let mod: MockModule;

beforeAll(async () => {
  real = await startTestApp();
  ui = await connectUi(real.port);
  await ui.synced();
  const file = path.resolve(__dirname, '../../../ui/dev/mock-rules.mjs');
  mod = (await import(pathToFileURL(file).href)) as MockModule;
});
afterAll(async () => {
  ui?.ws.terminate();
  await real?.close();
});

async function both(command: object, store: MockStore): Promise<{ real: Reply; mock: Reply }> {
  const r = (await ui.command({ name: 'mocks.set', ...command })) as Reply & { type?: string; requestId?: string };
  const { type: _t, requestId: _id, ...realReply } = r;
  // Generated ids differ by construction (time + random): compare the rest.
  return { real: realReply as Reply, mock: JSON.parse(JSON.stringify(store.set(command))) as Reply };
}

const respond = { type: 'respond', status: 200, headers: [['Content-Type', 'application/json']], body: '{"data":{}}' };
const gql = (when: unknown, extra: object = {}) => ({ id: 'g1', enabled: true, method: 'post', url: 'https://api.test/graphql', match: 'exact', when, action: respond, createdAt: 10, ...extra });

describe('mocks.set: dev mock vs real server', () => {
  it('normalizes the same way (method case, trimmed operation name, empty type dropped, null conditions)', async () => {
    const store = mod.createMockRules([]);
    const rules = [
      gql({ graphql: { operationName: '  GetUser ', operationType: '' } }),
      gql({ graphql: { operationName: 'LikeStory', operationType: 'mutation' } }, { id: 'g2', name: ' Like ' }),
      gql({ graphql: null }, { id: 'g3' }),
      gql({}, { id: 'g4', method: '', apps: [' com.pati ', 'com.pati'] }),
      { id: 'p1', url: '/v1/login', action: { type: 'delay', delayMs: '250' }, createdAt: 5 },
    ];
    const { real: r, mock: m } = await both({ rules }, store);
    expect(r.ok).toBe(true);
    expect(m).toEqual(r);
    expect((r.data as Array<{ when?: unknown }>).map((x) => x.when)).toEqual([
      { graphql: { operationName: 'GetUser' } },
      { graphql: { operationName: 'LikeStory', operationType: 'mutation' } },
      undefined,
      undefined,
      undefined,
    ]);
  });

  const refused: Array<[string, unknown]> = [
    ['when is not an object', gql('graphql')],
    ['unknown condition', gql({ header: { name: 'x-op' } })],
    ['graphql is not an object', gql({ graphql: 'GetUser' })],
    ['missing name', gql({ graphql: { operationType: 'query' } })],
    ['blank name', gql({ graphql: { operationName: '   ' } })],
    ['name with a space', gql({ graphql: { operationName: 'Get User' } })],
    ['name starting with a digit', gql({ graphql: { operationName: '1GetUser' } })],
    ['name too long', gql({ graphql: { operationName: 'A'.repeat(129) } })],
    ['bad type', gql({ graphql: { operationName: 'GetUser', operationType: 'Query' } })],
    ['bad status', { url: '/x', action: { type: 'respond', status: 99 } }],
    ['bad method', { url: '/x', method: 'GET POST', action: { type: 'delay', delayMs: 1 } }],
  ];
  it.each(refused)('refuses the list the same way: %s', async (_label, rule) => {
    const store = mod.createMockRules([]);
    const { real: r, mock: m } = await both({ rules: [{ id: 'ok', url: '/fine', action: { type: 'delay', delayMs: 5 }, createdAt: 1 }, rule] }, store);
    expect(r).toMatchObject({ ok: false, code: 'config.invalid' });
    expect(m).toEqual(r);
  });

  it('refuses a list that is not a list', async () => {
    const { real: r, mock: m } = await both({ rules: { id: 'x' } }, mod.createMockRules([]));
    expect(r).toMatchObject({ ok: false, code: 'config.invalid' });
    expect(m).toEqual(r);
  });

  it('answers a save from an older revision with the same conflict shape', async () => {
    const rules = [gql({ graphql: { operationName: 'GetUser' } })];
    const store = mod.createMockRules([]);
    await both({ rules }, store);
    // Revision 0 is older than any list on both sides (both start at 1).
    const { real: r, mock: m } = await both({ rules: [], baseRevision: 0 }, store);
    expect(r).toMatchObject({ ok: false, code: 'mocks.conflict' });
    expect(Object.keys(m).sort()).toEqual(Object.keys(r).sort());
    expect(m).toMatchObject({ ok: false, code: r.code, error: r.error });
    expect((m.data as { rules: unknown }).rules).toEqual((r.data as { rules: unknown }).rules);
    expect(typeof (m.data as { revision: unknown }).revision).toBe('number');
  });

  it('gives duplicate ids a fresh id in both', async () => {
    const dup = { id: 'same', url: '/a', action: { type: 'delay', delayMs: 1 }, createdAt: 1 };
    const { real: r, mock: m } = await both({ rules: [dup, { ...dup, url: '/b' }] }, mod.createMockRules([]));
    const ids = (x: Reply) => (x.data as Array<{ id: string }>).map((v) => v.id);
    expect(ids(r)[0]).toBe('same');
    expect(ids(m)[0]).toBe('same');
    expect(ids(r)[1]).toMatch(/^mock-/);
    expect(ids(m)[1]).toMatch(/^mock-/);
    expect(ids(m)[1]).not.toBe('same');
  });
});
