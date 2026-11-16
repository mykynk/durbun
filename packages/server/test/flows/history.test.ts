import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_FORMAT, FLOW_VERSION, type FlowDoc } from '@durbun/protocol';
import { CHECKPOINT_MS, IDLE_MS, MAX_TRASH, MAX_VERSIONS, TRASH_MS, versionChanges } from '../../src/flows/history';
import { FlowStore } from '../../src/flows/store';
import { silentLogger } from '../../src/util/logger';
import { makeTempDir } from '../http/fakes';

let dir: string;
let clock: number;
let store: FlowStore;
const now = () => clock;

beforeEach(async () => {
  dir = await makeTempDir('durbun-history-');
  clock = 1_700_000_000_000;
  store = new FlowStore(dir, silentLogger, now);
  await store.load();
});
afterEach(async () => {
  await store.flush();
});

const doc = (patch: Partial<FlowDoc> = {}): FlowDoc => ({
  format: FLOW_FORMAT,
  version: FLOW_VERSION,
  id: 'login',
  name: 'Log in',
  nodes: [
    { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
    { id: 'note', type: 'output.note', params: { text: 'one' }, position: { x: 260, y: 0 } },
  ],
  edges: [{ from: 'start', to: 'note' }],
  ...patch,
});
const withText = (text: string, patch: Partial<FlowDoc> = {}) => doc({ nodes: [doc().nodes[0]!, { ...doc().nodes[1]!, params: { text } }], ...patch });

/** An editor save: based on the copy it loaded. */
async function edit(next: FlowDoc, after = 1_000, id = next.id): Promise<FlowDoc> {
  clock += after;
  const base = store.get(id)!.updatedAt;
  return (await store.save(next, { id, baseUpdatedAt: base })).flow;
}

describe('flow versions', () => {
  it('keeps the content an editing session started from, not every autosave', async () => {
    await store.save(doc(), { create: true });
    for (const text of ['a', 'ab', 'abc']) await edit(withText(text));
    let h = await store.history.list(store.get('login')!);
    // The first edit keeps the original; quick saves after it keep nothing.
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0]).toMatchObject({ reason: 'edit', name: 'Log in', nodeCount: 2 });
    expect(h.current.changes).toMatchObject({ stepsChanged: 1, stepsAdded: 0 });

    // Left alone for a while, then edited again: the state it had is a version.
    await edit(withText('later'), IDLE_MS + 1);
    h = await store.history.list(store.get('login')!);
    expect(h.versions).toHaveLength(2);
    expect(h.versions[0]!.changes).toMatchObject({ stepsChanged: 1 });

    // A long session gets a checkpoint every CHECKPOINT_MS.
    for (let i = 0; i < 5; i++) await edit(withText(`burst ${i}`), CHECKPOINT_MS / 4);
    h = await store.history.list(store.get('login')!);
    expect(h.versions).toHaveLength(3);
  });

  it('always keeps what an unchecked overwrite or an import replaced', async () => {
    await store.save(doc(), { create: true });
    clock += 10;
    await store.save(withText('mine'), { id: 'login' });
    clock += 10;
    await store.save(withText('imported'), { id: 'login', reason: 'import' });
    const h = await store.history.list(store.get('login')!);
    expect(h.versions.map((v) => v.reason)).toEqual(['import', 'edit']);
  });

  it('restores a version, keeps the replaced content, and that restore can be undone', async () => {
    await store.save(doc(), { create: true });
    await edit(withText('second', { name: 'Sign in' }));
    const [original] = (await store.history.list(store.get('login')!)).versions;
    clock += 5_000;
    const restored = await store.restoreVersion('login', original!.id);
    expect(restored.flow).toMatchObject({ id: 'login', name: 'Log in' });
    expect(restored.versionId).toBeTruthy();
    const h = await store.history.list(store.get('login')!);
    expect(h.versions[0]).toMatchObject({ id: restored.versionId, reason: 'restore', name: 'Sign in', changes: { renamedFrom: 'Log in', stepsChanged: 1 } });
    // Undo = restore the version the restore kept.
    clock += 5_000;
    const undone = await store.restoreVersion('login', restored.versionId!);
    expect(undone.flow.name).toBe('Sign in');
    expect((undone.flow.nodes[1]!.params as { text: string }).text).toBe('second');
    await expect(store.restoreVersion('login', 'zzzz-000000')).rejects.toMatchObject({ code: 'flow.version.notFound', status: 404 });
  });

  it('refuses a restore based on an older copy (another window saved)', async () => {
    await store.save(doc(), { create: true });
    const first = store.get('login')!.updatedAt!;
    await edit(withText('x'));
    const [v] = (await store.history.list(store.get('login')!)).versions;
    await expect(store.restoreVersion('login', v!.id, first)).rejects.toMatchObject({ code: 'flow.conflict', status: 409 });
  });

  it('stays bounded and follows a rename', async () => {
    await store.save(doc(), { create: true });
    for (let i = 0; i < MAX_VERSIONS + 5; i++) {
      clock += 10;
      await store.save(withText(`v${i}`), { id: 'login' });
    }
    expect((await store.history.list(store.get('login')!)).versions).toHaveLength(MAX_VERSIONS);
    await edit({ ...withText('renamed'), id: 'sign-in' }, 1_000, 'login');
    expect(store.get('login')).toBeUndefined();
    const h = await store.history.list(store.get('sign-in')!);
    expect(h.versions).toHaveLength(MAX_VERSIONS);
    expect(await readdir(path.join(dir, 'flows', '.history'))).toEqual(['sign-in']);
  });

  it('words what changed step by step', () => {
    const a = doc();
    const b: FlowDoc = {
      ...a,
      name: 'Renamed',
      tags: ['smoke'],
      nodes: [{ ...a.nodes[0]!, position: { x: 20, y: 0 } }, { id: 'wait', type: 'logic.delay', params: { ms: 10 } }],
      edges: [{ from: 'start', to: 'wait' }],
    };
    expect(versionChanges(a, b)).toEqual({ stepsAdded: 1, stepsRemoved: 1, stepsChanged: 0, stepsMoved: 1, connections: 2, renamedFrom: 'Log in', settings: true });
  });
});

describe('deleted flows', () => {
  it('keeps a deleted flow with its versions and brings both back', async () => {
    await store.save(doc(), { create: true });
    clock += 10;
    await store.save(withText('kept'), { id: 'login' });
    const item = await store.trash('login');
    expect(item).toMatchObject({ id: 'login', name: 'Log in', nodeCount: 2, versions: 1, expiresAt: clock + TRASH_MS });
    expect(store.get('login')).toBeUndefined();
    expect(store.history.trash()).toHaveLength(1);

    // Kept across a restart.
    const again = new FlowStore(dir, silentLogger, now);
    await again.load();
    expect(again.history.trash()).toEqual(store.history.trash());

    const back = await again.restoreTrashed(item!.trashId);
    expect(back.flow.id).toBe('login');
    expect((await again.history.list(back.flow)).versions).toHaveLength(1);
    expect(again.history.trash()).toEqual([]);
    await expect(again.restoreTrashed(item!.trashId)).rejects.toMatchObject({ code: 'flow.trash.notFound' });
    await again.flush();
  });

  it('restores under a free id when the old one was taken meanwhile', async () => {
    await store.save(doc(), { create: true });
    const item = await store.trash('login');
    await store.save(doc({ name: 'New login' }), { create: true });
    const back = await store.restoreTrashed(item!.trashId);
    expect(back.flow.id).toBe('login-2');
    expect(back.flow.name).toBe('Log in');
  });

  it('forgets deleted flows after their time and beyond the limit', async () => {
    for (let i = 0; i < MAX_TRASH + 2; i++) {
      await store.save(doc({ id: `f${i}`, name: `F${i}` }), { create: true });
      await store.trash(`f${i}`);
    }
    expect(store.history.trash()).toHaveLength(MAX_TRASH);
    clock += TRASH_MS + 1;
    const later = new FlowStore(dir, silentLogger, now);
    await later.load();
    expect(later.history.trash()).toEqual([]);
  });
});
