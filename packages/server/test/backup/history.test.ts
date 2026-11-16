import { afterEach, describe, expect, it } from 'vitest';
import type { DurbunPackage, FlowDoc, FlowHistory, FlowTrashItem, PackageImportResult, PackageManifest } from '@durbun/protocol';
import { MAX_VERSIONS, TRASH_MS } from '../../src/flows/history';
import { startTestApp, type TestApp } from '../http/fakes';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const json = { 'Content-Type': 'application/json' };
async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${t!.base}${url}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

const flow = (id: string, text: string, extra: Partial<FlowDoc> = {}) => ({
  format: 'durbun-flow',
  version: 1,
  id,
  name: `Flow ${id}`,
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'note', type: 'output.note', params: { text } },
  ],
  edges: [{ from: 'start', to: 'note' }],
  ...extra,
});

/** A flow saved `edits` more times without a base copy: every save keeps the content it replaces as a version. */
async function flowWithVersions(id: string, edits: number, tag = id, extra: Partial<FlowDoc> = {}): Promise<void> {
  await call('POST', '/api/flows', { flow: flow(id, `${tag} 0`, extra) });
  for (let i = 1; i <= edits; i++) expect((await call('PUT', `/api/flows/${id}`, { flow: flow(id, `${tag} ${i}`, extra) })).status).toBe(200);
}

const history = async (id: string) => (await call<FlowHistory>('GET', `/api/flows/${id}/history`)).data;
const trash = async () => (await call<{ items: FlowTrashItem[] }>('GET', '/api/flow-trash')).data.items;
const backup = async (extra: Record<string, unknown> = {}) => (await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'backup', include: { flows: 'all', history: true }, ...extra })).data;

async function restore(pkg: unknown, conflict = 'replace', extra: Record<string, unknown> = {}) {
  const m = await call<PackageManifest>('POST', '/api/packages/inspect', { package: pkg });
  expect(m.status).toBe(200);
  const r = await call<PackageImportResult>('POST', '/api/packages/import', { token: m.data.token, include: { flows: 'all', history: true }, conflict, ...extra });
  expect(r.status).toBe(200);
  return { manifest: m.data, result: r.data };
}

describe('backups carry the version history and the deleted flows', () => {
  it('round trip: versions and trash come back on a new Mac', async () => {
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 3);
    await flowWithVersions('gone', 2);
    expect((await call('DELETE', '/api/flows/gone')).status).toBe(200);
    const before = await history('login');
    expect(before.versions).toHaveLength(3);
    const pkg = await backup();
    expect(Object.keys(pkg.contents.history?.versions ?? {})).toEqual(['login']);
    expect(pkg.contents.history?.trash).toHaveLength(1);
    expect(pkg.contents.history?.trash?.[0]?.versions).toHaveLength(2);
    // A share never carries the past, even when asked.
    const share = (await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all', history: true } })).data;
    expect(share.contents.history).toBeUndefined();
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    const { manifest, result } = await restore(pkg);
    expect(manifest.history).toEqual({ flows: 1, versions: 3, trash: 1 });
    expect(result.history).toEqual({ versions: 3, trash: 1, trimmed: 0 });
    const after = await history('login');
    expect(after.versions.map((v) => v.id)).toEqual(before.versions.map((v) => v.id));
    const items = await trash();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'gone', versions: 2 });
    // The deleted flow comes back with its versions.
    expect((await call('POST', `/api/flow-trash/${items[0]!.trashId}/restore`)).status).toBe(200);
    expect((await history('gone')).versions).toHaveLength(2);

    // The same backup again: nothing doubles.
    const again = await restore(pkg);
    expect(again.result.history).toEqual({ versions: 0, trash: 1, trimmed: 0 });
    expect((await history('login')).versions).toHaveLength(3);
  });

  it('versions reach a flow that is here unchanged even when it was not picked (the dialog leaves those unticked)', async () => {
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 2, 'a');
    await flowWithVersions('other', 1, 'a');
    const pkg = await backup();
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    // This Mac has "login" exactly as the backup does, without its versions; "other" differs here.
    await call('POST', '/api/flows', { flow: pkg.contents.flows!.find((f) => f.id === 'login') });
    await call('POST', '/api/flows', { flow: flow('other', 'mine') });
    const { result } = await restore(pkg, 'replace', { include: { flows: [], history: true } });
    expect(result.flows).toMatchObject({ added: 0, replaced: 0 });
    expect(result.history).toEqual({ versions: 2, trash: 0, trimmed: 0 });
    expect((await history('login')).versions).toHaveLength(2);
    expect((await history('other')).versions).toHaveLength(0);
  });

  it('merges onto a Mac with its own history: both sides kept, the replaced content labelled as before an import', async () => {
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 2, 'mac-a');
    const pkg = await backup();
    const fromA = (await history('login')).versions.map((v) => v.id);
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 2, 'mac-b');
    const fromB = (await history('login')).versions.map((v) => v.id);
    const { result } = await restore(pkg);
    expect(result.flows.replaced).toBe(1);
    expect(result.history).toEqual({ versions: 2, trash: 0, trimmed: 0 });
    const h = await history('login');
    // Mac B's current content went in as "before an import", the newest version.
    expect(h.versions[0]).toMatchObject({ reason: 'import' });
    expect(h.versions.map((v) => v.id)).toEqual(expect.arrayContaining([...fromA, ...fromB]));
    expect(h.versions).toHaveLength(5);
    // Ordered by when each one was replaced, whichever Mac kept it.
    const replaced = h.versions.map((v) => v.replacedAt);
    expect([...replaced].sort((a, b) => b - a)).toEqual(replaced);
  });

  it('keeps the store limits after a merge and says how much it left out', async () => {
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 20, 'a');
    const pkg = await backup();
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 20, 'b');
    const { result } = await restore(pkg);
    // 20 here + 1 before the import + 20 from the backup = 41: the newest 30 stay.
    expect(result.history?.trimmed).toBe(41 - MAX_VERSIONS);
    expect(result.notices?.find((n) => n.code === 'package.history.trimmed')?.params).toEqual({ count: 41 - MAX_VERSIONS });
    expect((await history('login')).versions).toHaveLength(MAX_VERSIONS);
  });

  it('leaves out deleted flows older than the trash keeps them', async () => {
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('old', 1);
    await call('DELETE', '/api/flows/old');
    const pkg = await backup();
    pkg.contents.history!.trash![0]!.deletedAt = Date.now() - TRASH_MS - 1;
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    const { result } = await restore(pkg);
    expect(result.history).toEqual({ versions: 0, trash: 0, trimmed: 1 });
    expect(await trash()).toEqual([]);
  });

  it('history follows a flow kept as a copy, and not a skipped one', async () => {
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 2, 'a');
    const pkg = await backup();
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 1, 'b');
    const skipped = await restore(pkg, 'skip');
    expect(skipped.result.history).toEqual({ versions: 0, trash: 0, trimmed: 0 });
    expect((await history('login')).versions).toHaveLength(1);
    const copied = await restore(pkg, 'keepBoth');
    expect(copied.result.flows.renamed).toBe(1);
    expect(copied.result.history?.versions).toBe(2);
    expect((await history('login-2')).versions).toHaveLength(2);
    expect((await history('login')).versions).toHaveLength(1);
  });

  it('holds secret input defaults of versions back unless a passphrase encrypts them', async () => {
    const extra = { inputs: [{ name: 'password', default: 'Hunter2-pass', secret: true }] } as Partial<FlowDoc>;
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 1, 'a', extra);
    await call('DELETE', '/api/flows/login');
    const open = await backup();
    const locked = await backup({ passphrase: 'correct horse' });
    expect(JSON.stringify(open)).not.toContain('Hunter2-pass');
    expect(JSON.stringify(locked)).not.toContain('Hunter2-pass');
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    await restore(locked, 'replace', { passphrase: 'correct horse' });
    const [item] = await trash();
    await call('POST', `/api/flow-trash/${item!.trashId}/restore`);
    const [v] = (await history('login')).versions;
    const version = (await call<{ flow: FlowDoc }>('GET', `/api/flows/login/history/${v!.id}`)).data.flow;
    expect(version.inputs?.[0]?.default).toBe('Hunter2-pass');
    expect((await call<{ flow: FlowDoc }>('GET', '/api/flows/login')).data.flow.inputs?.[0]?.default).toBe('Hunter2-pass');
  });

  it('an older backup without the part restores exactly as before; unknown parts are ignored', async () => {
    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 2, 'a');
    const pkg = await backup();
    delete pkg.contents.history;
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    await flowWithVersions('login', 2, 'b');
    const own = (await history('login')).versions.map((v) => v.id);
    const newer = { ...pkg, contents: { ...pkg.contents, somethingNewer: { any: 'thing' } } };
    const { manifest, result } = await restore(newer);
    expect(manifest.history).toBeUndefined();
    expect(result.history).toBeUndefined();
    expect(result.flows.replaced).toBe(1);
    const h = await history('login');
    expect(h.versions.slice(1).map((v) => v.id)).toEqual(own);
    expect(h.versions[0]).toMatchObject({ reason: 'import' });
  });
});

describe('shared packages', () => {
  it('a flow replaced by a package import gets a version labelled before an import, so the import can be undone', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: flow('login', 'theirs') });
    const share = (await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all' } })).data;
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: flow('login', 'mine') });
    const m = await call<PackageManifest>('POST', '/api/packages/inspect', { package: share });
    expect(m.data.history).toBeUndefined();
    const r = await call<PackageImportResult>('POST', '/api/packages/import', { token: m.data.token, include: { flows: 'all', history: true }, conflict: 'replace' });
    expect(r.data.flows.replaced).toBe(1);
    expect(r.data.history).toBeUndefined();
    const h = await history('login');
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0]).toMatchObject({ reason: 'import' });
    // Restoring that version brings this Mac's flow back.
    expect((await call('POST', `/api/flows/login/history/${h.versions[0]!.id}/restore`)).status).toBe(200);
    expect((await call<{ flow: FlowDoc }>('GET', '/api/flows/login')).data.flow.nodes[1]?.params?.text).toBe('mine');
  });
});
