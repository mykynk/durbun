/**
 * The UI's dev mock (`packages/ui/dev/mock-flows.mjs`) must answer the flows routes in the shapes the real handlers
 * send: a mock that drifts hides a mismatch until the real app breaks. Each case asks the real server (in process)
 * and the mock the same thing and compares the shape of the answers (keys and value types; `params` hold free keys).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowBatch } from '@durbun/protocol';
import { sampleNetwork, startTestApp, type TestApp } from '../http/fakes';

type Answer = { status: number; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type MockModule = {
  handleFlowsApi(req: unknown, res: unknown, p: string, ctx: { json: unknown; readBody: unknown; broadcast?: unknown }): Promise<boolean>;
};

let real: TestApp;
let mock: MockModule;
let netServer: Server;
let netHost = '';

const NETWORK = {
  'app:1:1': sampleNetwork('app:1:1', { method: 'POST', url: 'https://api.shop.test/v1/login', startTs: 1, status: 200 }),
  'app:1:2': sampleNetwork('app:1:2', { method: 'GET', url: 'https://api.shop.test/v1/cart', startTs: 2, status: 200 }),
};

beforeAll(async () => {
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: url.pathname.includes('photo') ? 500 : 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  real = await startTestApp({ flowsBackground: false, fetchImpl });
  for (const [id, d] of Object.entries(NETWORK)) real.hub.network.set(id, d);
  // The mock reads captured requests from its own server's GET /api/network/:id.
  netServer = createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? '').replace('/api/network/', ''));
    const d = (NETWORK as Record<string, unknown>)[id];
    res.writeHead(d ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(d ?? { error: 'Unknown network entry' }));
  });
  await new Promise<void>((r) => netServer.listen(0, '127.0.0.1', r));
  netHost = `127.0.0.1:${(netServer.address() as AddressInfo).port}`;
  const file = path.resolve(__dirname, '../../../ui/dev/mock-flows.mjs');
  mock = (await import(pathToFileURL(file).href)) as MockModule;
});
afterAll(async () => {
  await real?.close();
  await new Promise((r) => netServer?.close(r));
});

async function callReal(method: string, url: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${real.base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

function callMock(method: string, url: string, body?: unknown): Promise<Answer> {
  const req = Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { method: string; url: string; headers: Record<string, string> };
  Object.assign(req, { method, url, headers: { host: netHost } });
  return new Promise((resolve, reject) => {
    let status = 0;
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(text?: string | Buffer) {
        resolve({ status, data: text ? JSON.parse(String(text)) : undefined });
      },
    };
    const json = (r: typeof res, s: number, b: unknown) => {
      r.writeHead(s);
      r.end(JSON.stringify(b));
    };
    const readBody = (r: Readable) =>
      new Promise<Buffer>((ok) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => ok(Buffer.concat(chunks)));
      });
    mock.handleFlowsApi(req, res, new URL(url, 'http://mock').pathname, { json, readBody, broadcast: () => {} }).then((handled) => {
      if (!handled) resolve({ status: 404, data: { error: 'not handled by the mock' } });
    }, reject);
  });
}

/** Paths and leaf types of a JSON value; objects under `params` / `errorParams` / `output` / node params are free. */
function shape(value: unknown, at = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    out.add(`${at}:array`);
    for (const v of value) shape(v, `${at}[]`, out);
  } else if (value && typeof value === 'object') {
    out.add(`${at}:object`);
    for (const [k, v] of Object.entries(value)) {
      // A flow document is user content: only its identity and the graph's presence are compared.
      if (at === '.flow') {
        if (k === 'nodes' || k === 'edges') out.add(`${at}.${k}:*`);
        else if (k === 'id' || k === 'name' || k === 'format' || k === 'version') shape(v, `${at}.${k}`, out);
      } else if (/(^|\.)(params|errorParams|output|outputs|inputs|preflight|steps|position)$/.test(`${at}.${k}`)) out.add(`${at}.${k}:*`);
      else shape(v, `${at}.${k}`, out);
    }
  } else out.add(`${at}:${value === null ? 'null' : typeof value}`);
  return out;
}

/** Every path the mock sends is one the server sends too; `required` paths are in both. */
function expectSameShape(realAnswer: Answer, mockAnswer: Answer, required: string[]) {
  expect(mockAnswer.status).toBe(realAnswer.status);
  const r = shape(realAnswer.data);
  const m = shape(mockAnswer.data);
  expect([...m].filter((p) => !r.has(p)).sort()).toEqual([]);
  for (const p of required) {
    expect(r.has(p), `server sends ${p}`).toBe(true);
    expect(m.has(p), `mock sends ${p}`).toBe(true);
  }
}

async function waitBatch(call: typeof callReal, id: string): Promise<Answer> {
  for (let i = 0; i < 200; i++) {
    const a = await call('GET', `/api/flow-batches/${id}`);
    if ((a.data as FlowBatch).status !== 'running') return a;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('set did not end');
}

const flowDoc = (id: string, name: string, tags: string[], nodes: unknown[], edges: unknown[]) => ({ format: 'durbun-flow', version: 1, id, name, tags, nodes, edges });

describe('UI mock ↔ server: flows routes', () => {
  it('schema: the same document', async () => {
    const [r, m] = await Promise.all([callReal('GET', '/api/flows/schema'), callMock('GET', '/api/flows/schema')]);
    expect(r.status).toBe(200);
    expect(m.data).toEqual(r.data);
  });

  it('flow from requests: same answer and errors', async () => {
    const body = { ids: ['app:1:2', 'app:1:1'], name: 'Cart' };
    expectSameShape(await callReal('POST', '/api/flows/from-requests', body), await callMock('POST', '/api/flows/from-requests', body), ['.flow.id:string', '.flow.nodes:*', '.issues:array', '.envVars[].key:string', '.envVars[].secret:boolean', '.links:number']);
    expectSameShape(await callReal('POST', '/api/flows/from-requests', { ids: [] }), await callMock('POST', '/api/flows/from-requests', { ids: [] }), ['.code:string', '.error:string']);
    const gone = { ids: ['nope'] };
    const [rg, mg] = [await callReal('POST', '/api/flows/from-requests', gone), await callMock('POST', '/api/flows/from-requests', gone)];
    expect([mg.status, mg.data.code]).toEqual([rg.status, rg.data.code]);
  });

  it('set runs: start, list, the finished report and its errors', { timeout: 40_000 }, async () => {
    // The same kind of smoke set as the mock's seed: one that fails, one with a step that is hard to undo, one that passes.
    const http = (id: string, name: string, url: string) =>
      flowDoc(id, name, ['smoke'], [{ id: 'start', type: 'trigger.manual' }, { id: 'upload', type: 'http.request', label: 'Upload', params: { method: 'POST', url, expectStatus: '2xx' } }], [{ from: 'start', to: 'upload' }]);
    await callReal('POST', '/api/flows', { flow: http('profile-photo', 'Profile photo upload', 'https://api.test/me/photo') });
    await callReal('POST', '/api/flows', { flow: http('login', 'Log in', 'https://api.test/login') });
    await callReal('POST', '/api/flows', { flow: flowDoc('fresh-install', 'Fresh install', ['smoke'], [{ id: 'start', type: 'trigger.manual' }, { id: 'wipe', type: 'device.clearData' }], [{ from: 'start', to: 'wipe' }]) });

    await callReal('PUT', '/api/flow-environments', { activeId: 'staging', environments: [{ id: 'staging', name: 'Staging', vars: [{ key: 'baseUrl', value: 'https://api.test' }] }] });
    const req = { tag: 'smoke' };
    const [rs, ms] = [await callReal('POST', '/api/flow-batches', req), await callMock('POST', '/api/flow-batches', req)];
    expectSameShape(rs, ms, ['.id:string', '.tag:string', '.status:string', '.startedAt:number', '.request:object', '.onFailure:string', '.items[].flowId:string', '.items[].flowName:string', '.items[].status:string', '.counts.total:number', '.counts.cancelled:number']);
    // One set at a time, on both.
    const [rb, mb] = [await callReal('POST', '/api/flow-batches', req), await callMock('POST', '/api/flow-batches', req)];
    expectSameShape(rb, mb, ['.code:string', '.params:*']);
    expect(mb.data.code).toBe('flow.batch.busy');

    const [rl, ml] = [await callReal('GET', '/api/flow-batches'), await callMock('GET', '/api/flow-batches')];
    expect(shape(ml.data).has('.batches:array')).toBe(true);
    expect(shape(rl.data).has('.batches:array')).toBe(true);

    const [rd, md] = [await waitBatch(callReal, rs.data.id), await waitBatch(callMock, ms.data.id)];
    expectSameShape(rd, md, [
      '.status:string',
      '.endedAt:number',
      '.durationMs:number',
      '.items[].runId:string',
      '.items[].durationMs:number',
      '.items[].counts.passed:number',
      '.items[].failedStep.nodeId:string',
      '.items[].failedStep.errorCode:string',
      '.items[].reason.code:string',
      '.items[].reason.message:string',
    ]);
    expect(md.data.items.map((i: { status: string }) => i.status).sort()).toEqual(expect.arrayContaining(['failed', 'skipped']));
    const [rn, mn] = [await callReal('POST', `/api/flow-batches/${rs.data.id}/cancel`), await callMock('POST', `/api/flow-batches/${ms.data.id}/cancel`)];
    expectSameShape(rn, mn, ['.code:string']);
    const [r404, m404] = [await callReal('GET', '/api/flow-batches/zz-000000'), await callMock('GET', '/api/flow-batches/zz-000000')];
    expectSameShape(r404, m404, ['.code:string']);
    const [rx, mx] = [await callReal('DELETE', `/api/flow-batches/${rs.data.id}`), await callMock('DELETE', `/api/flow-batches/${ms.data.id}`)];
    expectSameShape(rx, mx, ['.ok:boolean']);
  });

  it('versions: list, read, restore', async () => {
    const base = flowDoc('versioned', 'Sign in', [], [{ id: 'start', type: 'trigger.manual' }, { id: 'note', type: 'output.note', params: { text: 'a' } }], [{ from: 'start', to: 'note' }]);
    await callReal('POST', '/api/flows', { flow: base });
    await callReal('PUT', '/api/flows/versioned', { flow: { ...base, name: 'Log in' } });
    await callReal('PUT', '/api/flows/versioned', { flow: { ...base, name: 'Log in', nodes: [base.nodes[0], { id: 'note', type: 'output.note', params: { text: 'b' } }] } });
    const [rh, mh] = [await callReal('GET', '/api/flows/versioned/history'), await callMock('GET', '/api/flows/login/history')];
    expectSameShape(rh, mh, [
      '.versions[].id:string',
      '.versions[].savedAt:number',
      '.versions[].replacedAt:number',
      '.versions[].reason:string',
      '.versions[].name:string',
      '.versions[].nodeCount:number',
      '.versions[].changes.stepsChanged:number',
      '.versions[].changes.renamedFrom:string',
      '.versions[].changes.settings:boolean',
      '.current.savedAt:number',
      '.current.changes.stepsMoved:number',
      '.maxVersions:number',
    ]);
    const rv = rh.data.versions.at(-1).id as string;
    const mv = mh.data.versions.at(-1).id as string;
    expectSameShape(await callReal('GET', `/api/flows/versioned/history/${rv}`), await callMock('GET', `/api/flows/login/history/${mv}`), ['.flow.id:string', '.flow.nodes:*']);
    expectSameShape(await callReal('POST', `/api/flows/versioned/history/${rv}/restore`, {}), await callMock('POST', `/api/flows/login/history/${mv}/restore`, {}), ['.flow.name:string', '.issues:array', '.versionId:string']);
    expectSameShape(await callReal('GET', '/api/flows/versioned/history/zz-000000'), await callMock('GET', '/api/flows/login/history/zz-000000'), ['.code:string']);
  });

  it('deleted flows: delete, list, restore, remove for good', async () => {
    const doc = flowDoc('old-onboarding', 'Old onboarding', ['onboarding'], [{ id: 'start', type: 'trigger.manual' }], []);
    await callReal('POST', '/api/flows', { flow: doc });
    await callMock('POST', '/api/flows', { flow: { ...doc, id: 'to-delete' } });
    const [rd, md] = [await callReal('DELETE', '/api/flows/old-onboarding'), await callMock('DELETE', '/api/flows/to-delete')];
    const required = ['.trash.trashId:string', '.trash.id:string', '.trash.name:string', '.trash.nodeCount:number', '.trash.deletedAt:number', '.trash.expiresAt:number', '.trash.versions:number'];
    expectSameShape(rd, md, ['.ok:boolean', ...required]);
    const [rl, ml] = [await callReal('GET', '/api/flow-trash'), await callMock('GET', '/api/flow-trash')];
    expectSameShape(rl, ml, ['.items[].trashId:string', '.items[].tags[]:string', '.keepDays:number']);
    const [rr, mr] = [await callReal('POST', `/api/flow-trash/${rd.data.trash.trashId}/restore`), await callMock('POST', `/api/flow-trash/${md.data.trash.trashId}/restore`)];
    expectSameShape(rr, mr, ['.flow.id:string', '.issues:array']);
    expect(rr.data.flow.id).toBe('old-onboarding');
    const [r2, m2] = [await callReal('DELETE', '/api/flows/old-onboarding'), await callMock('DELETE', '/api/flows/to-delete')];
    expectSameShape(await callReal('DELETE', `/api/flow-trash/${r2.data.trash.trashId}`), await callMock('DELETE', `/api/flow-trash/${m2.data.trash.trashId}`), ['.ok:boolean']);
    expectSameShape(await callReal('POST', '/api/flow-trash/zz-000000/restore'), await callMock('POST', '/api/flow-trash/zz-000000/restore'), ['.code:string']);
  });

  it('backups: version history in the manifest and the import result', async () => {
    const doc = flowDoc('kept-history', 'Kept history', [], [{ id: 'start', type: 'trigger.manual' }, { id: 'note', type: 'output.note', params: { text: 'a' } }], [{ from: 'start', to: 'note' }]);
    await callReal('POST', '/api/flows', { flow: doc });
    await callReal('PUT', '/api/flows/kept-history', { flow: { ...doc, name: 'Kept history 2' } });
    await callReal('POST', '/api/flows', { flow: { ...doc, id: 'binned', name: 'Binned' } });
    await callReal('DELETE', '/api/flows/binned');
    const pkg = (await callReal('POST', '/api/packages/export', { kind: 'backup', include: { flows: 'all', history: true } })).data;
    expect(pkg.contents.history.versions['kept-history']).toHaveLength(1);
    const [ri, mi] = [await callReal('POST', '/api/packages/inspect', { package: pkg }), await callMock('POST', '/api/packages/inspect', { package: pkg })];
    expectSameShape(ri, mi, ['.history.flows:number', '.history.versions:number', '.history.trash:number', '.runs:number', '.token:string']);
    const req = { package: pkg, include: { flows: 'all', history: true }, conflict: 'replace' };
    const [rr, mr] = [await callReal('POST', '/api/packages/import', req), await callMock('POST', '/api/packages/import', req)];
    expectSameShape(rr, mr, ['.history.versions:number', '.history.trash:number', '.history.trimmed:number', '.flows.replaced:number', '.notices:array']);
  });
});
