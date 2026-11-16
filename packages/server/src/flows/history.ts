/**
 * Earlier versions of each flow and the flows deleted lately, next to the flows on disk:
 *
 *   <dataDir>/flows/.history/<flowId>/<versionId>.json   { format: 'durbun-flow-version', recordedAt, reason, flow }
 *   <dataDir>/flows/.trash/<trashId>/item.json           { format: 'durbun-flow-trash', deletedAt, flow }
 *   <dataDir>/flows/.trash/<trashId>/history/…           the deleted flow's versions (they come back with it)
 *
 * The editor saves 700 ms after each change, so not every save is a version: the content a save replaces is kept
 * when it had been left alone for IDLE_MS (a new editing session starts), when the newest kept version is older than
 * CHECKPOINT_MS (a long session gets checkpoints), when the save overwrote without checking the copy it was based on
 * (no `baseUpdatedAt`: "save mine", a package or import replace) and when it is a restore. A flow keeps MAX_VERSIONS
 * within MAX_VERSION_BYTES; deleted flows stay TRASH_DAYS (at most MAX_TRASH of them). Both folders start with a dot:
 * the flow loader and the backups skip them on purpose (a backup restores flows, not their history).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FlowDoc, FlowHistory, FlowTrashItem, FlowVersionChanges, FlowVersionInfo, FlowVersionReason } from '@durbun/protocol';
import type { Logger } from '../types';
import { readJsonFile, timeId, writeJsonFile } from './util';

export const HISTORY_DIR = '.history';
export const TRASH_DIR = '.trash';
export const MAX_VERSIONS = 30;
export const MAX_VERSION_BYTES = 4 * 1024 * 1024;
export const IDLE_MS = 5 * 60_000;
export const CHECKPOINT_MS = 15 * 60_000;
export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * 24 * 3_600_000;
export const MAX_TRASH = 100;

const ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;
export const isHistoryId = (id: string): boolean => ID_RE.test(id);

interface VersionMeta {
  id: string;
  recordedAt: number;
  reason: FlowVersionReason;
  size: number;
  sig: string;
}

interface VersionFile {
  format: 'durbun-flow-version';
  recordedAt: number;
  reason: FlowVersionReason;
  flow: FlowDoc;
}

interface TrashFile {
  format: 'durbun-flow-trash';
  deletedAt: number;
  flow: FlowDoc;
}

/** The content that makes a version (save stamps and the editor's `$schema` excluded). */
export function contentSig(flow: FlowDoc): string {
  const { updatedAt: _u, createdAt: _c, $schema: _s, ...rest } = flow;
  return JSON.stringify(rest);
}

const SETTINGS_KEYS = ['description', 'tags', 'inputs', 'outputs', 'target', 'settings', 'automation'] as const;

/** What `next` changed against `prev`, step by step (ids are the identity of a step). */
export function versionChanges(prev: FlowDoc, next: FlowDoc): FlowVersionChanges {
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const after = new Map(next.nodes.map((n) => [n.id, n]));
  const out: FlowVersionChanges = { stepsAdded: 0, stepsRemoved: 0, stepsChanged: 0, stepsMoved: 0, connections: 0, settings: false };
  for (const [id, n] of after) {
    const o = before.get(id);
    if (!o) {
      out.stepsAdded++;
      continue;
    }
    const { position: p1, ...a } = o;
    const { position: p2, ...b } = n;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.stepsChanged++;
    else if (JSON.stringify(p1 ?? null) !== JSON.stringify(p2 ?? null)) out.stepsMoved++;
  }
  for (const id of before.keys()) if (!after.has(id)) out.stepsRemoved++;
  const edge = (e: FlowDoc['edges'][number]) => `${e.from}\u0000${e.port ?? 'out'}\u0000${e.to}`;
  const e1 = new Set(prev.edges.map(edge));
  const e2 = new Set(next.edges.map(edge));
  for (const e of e1) if (!e2.has(e)) out.connections++;
  for (const e of e2) if (!e1.has(e)) out.connections++;
  if (prev.name !== next.name) out.renamedFrom = prev.name;
  out.settings = SETTINGS_KEYS.some((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null));
  return out;
}

export class FlowHistoryStore {
  private readonly historyRoot: string;
  private readonly trashRoot: string;
  /** Versions per flow id, newest first; read from disk the first time a flow needs them. */
  private readonly index = new Map<string, VersionMeta[]>();
  /** Newest first. */
  private trashItems: (FlowTrashItem & { flow: FlowDoc })[] = [];

  constructor(
    flowsDir: string,
    private readonly logger: Logger,
    private readonly now: () => number,
  ) {
    this.historyRoot = path.join(flowsDir, HISTORY_DIR);
    this.trashRoot = path.join(flowsDir, TRASH_DIR);
  }

  private dirOf(flowId: string): string {
    return path.join(this.historyRoot, flowId);
  }

  /** Reads the deleted flows (and removes the ones past their time). */
  async load(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.trashRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`could not read ${this.trashRoot}: ${(err as Error).message}`);
    }
    const items: (FlowTrashItem & { flow: FlowDoc })[] = [];
    for (const trashId of names) {
      if (!isHistoryId(trashId)) continue;
      try {
        const raw = (await readJsonFile(path.join(this.trashRoot, trashId, 'item.json'))) as TrashFile | undefined;
        if (!raw || raw.format !== 'durbun-flow-trash' || !raw.flow || typeof raw.deletedAt !== 'number') continue;
        items.push(this.trashItem(trashId, raw.deletedAt, raw.flow, await this.countFiles(path.join(this.trashRoot, trashId, 'history'))));
      } catch (err) {
        this.logger.warn(`flows/${TRASH_DIR}/${trashId}: ${(err as Error).message}`);
      }
    }
    this.trashItems = items.sort((a, b) => b.deletedAt - a.deletedAt);
    await this.pruneTrash();
  }

  private async countFiles(dir: string): Promise<number> {
    try {
      return (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  private trashItem(trashId: string, deletedAt: number, flow: FlowDoc, versions: number): FlowTrashItem & { flow: FlowDoc } {
    return {
      trashId,
      id: flow.id,
      name: flow.name,
      nodeCount: flow.nodes.length,
      ...(flow.tags?.length ? { tags: flow.tags } : {}),
      deletedAt,
      expiresAt: deletedAt + TRASH_MS,
      versions,
      flow,
    };
  }

  /* ───────────── versions ───────────── */

  private async versions(flowId: string): Promise<VersionMeta[]> {
    const cached = this.index.get(flowId);
    if (cached) return cached;
    const list: VersionMeta[] = [];
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dirOf(flowId));
    } catch {
      /* none yet */
    }
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !isHistoryId(id)) continue;
      try {
        const file = path.join(this.dirOf(flowId), name);
        const raw = (await readJsonFile(file)) as VersionFile | undefined;
        if (!raw?.flow || typeof raw.recordedAt !== 'number') continue;
        const size = (await fsp.stat(file)).size;
        list.push({ id, recordedAt: raw.recordedAt, reason: raw.reason ?? 'edit', size, sig: contentSig(raw.flow) });
      } catch (err) {
        this.logger.warn(`flows/${HISTORY_DIR}/${flowId}/${name}: ${(err as Error).message}`);
      }
    }
    list.sort((a, b) => b.recordedAt - a.recordedAt || b.id.localeCompare(a.id));
    this.index.set(flowId, list);
    return list;
  }

  /**
   * A save is about to replace `prev` with `next`: keep `prev` when it is worth a version (see the header).
   * `checked`: the save was based on the copy it replaces (`baseUpdatedAt`); an unchecked overwrite always keeps one.
   * Returns the new version's id, or undefined when none was kept.
   */
  async record(prev: FlowDoc, next: FlowDoc, opts: { reason?: FlowVersionReason; checked?: boolean } = {}): Promise<string | undefined> {
    const reason = opts.reason ?? 'edit';
    const sig = contentSig(prev);
    if (sig === contentSig(next)) return undefined;
    const list = await this.versions(prev.id);
    const newest = list[0];
    if (newest?.sig === sig) return undefined;
    const now = this.now();
    if (reason === 'edit' && opts.checked && newest) {
      const idleFor = now - (prev.updatedAt ?? 0);
      const sinceNewest = now - newest.recordedAt;
      if (idleFor < IDLE_MS && sinceNewest < CHECKPOINT_MS) return undefined;
    }
    const id = timeId(Math.max(now, (newest?.recordedAt ?? 0) + 1));
    const file: VersionFile = { format: 'durbun-flow-version', recordedAt: now, reason, flow: prev };
    const target = path.join(this.dirOf(prev.id), `${id}.json`);
    await writeJsonFile(target, file, 0o644);
    const size = await fsp.stat(target).then((s) => s.size, () => 0);
    list.unshift({ id, recordedAt: now, reason, size, sig });
    await this.prune(prev.id, list);
    return id;
  }

  private async prune(flowId: string, list: VersionMeta[]): Promise<void> {
    let bytes = 0;
    let keep = 0;
    for (const v of list) {
      if (keep >= MAX_VERSIONS || (keep > 0 && bytes + v.size > MAX_VERSION_BYTES)) break;
      bytes += v.size;
      keep++;
    }
    for (const v of list.splice(keep)) await fsp.rm(path.join(this.dirOf(flowId), `${v.id}.json`), { force: true });
  }

  /** The version list with what each version changed. `current` = the flow as it is now. */
  async list(current: FlowDoc): Promise<FlowHistory> {
    const metas = await this.versions(current.id);
    const docs: { meta: VersionMeta; flow: FlowDoc }[] = [];
    for (const meta of metas) {
      const flow = await this.read(current.id, meta.id);
      if (flow) docs.push({ meta, flow });
    }
    const versions: FlowVersionInfo[] = docs.map(({ meta, flow }, i) => {
      const older = docs[i + 1]?.flow;
      return {
        id: meta.id,
        savedAt: flow.updatedAt ?? meta.recordedAt,
        replacedAt: meta.recordedAt,
        reason: meta.reason,
        name: flow.name,
        nodeCount: flow.nodes.length,
        ...(older ? { changes: versionChanges(older, flow) } : {}),
      };
    });
    const newest = docs[0]?.flow;
    return {
      versions,
      current: { ...(current.updatedAt !== undefined ? { savedAt: current.updatedAt } : {}), ...(newest ? { changes: versionChanges(newest, current) } : {}) },
      maxVersions: MAX_VERSIONS,
    };
  }

  async read(flowId: string, versionId: string): Promise<FlowDoc | undefined> {
    if (!isHistoryId(versionId)) return undefined;
    try {
      const raw = (await readJsonFile(path.join(this.dirOf(flowId), `${versionId}.json`))) as VersionFile | undefined;
      return raw?.flow ? { ...raw.flow, id: flowId } : undefined;
    } catch {
      return undefined;
    }
  }

  /** A flow got a new id: its versions follow it. */
  async rename(from: string, to: string): Promise<void> {
    const list = this.index.get(from);
    this.index.delete(from);
    this.index.delete(to);
    await fsp.rm(this.dirOf(to), { recursive: true, force: true });
    try {
      await fsp.mkdir(this.historyRoot, { recursive: true });
      await fsp.rename(this.dirOf(from), this.dirOf(to));
      if (list) this.index.set(to, list);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`could not move the history of ${from} to ${to}: ${(err as Error).message}`);
    }
  }

  /** Forget a flow's versions for good (a flow removed without the trash). */
  async drop(flowId: string): Promise<void> {
    this.index.delete(flowId);
    await fsp.rm(this.dirOf(flowId), { recursive: true, force: true });
  }

  /* ───────────── deleted flows ───────────── */

  trash(): FlowTrashItem[] {
    return this.trashItems.map(({ flow: _f, ...item }) => ({ ...item }));
  }

  /** Keep a deleted flow (and its versions) for TRASH_DAYS. */
  async put(flow: FlowDoc): Promise<FlowTrashItem> {
    const deletedAt = this.now();
    let trashId = timeId(deletedAt);
    while (this.trashItems.some((x) => x.trashId === trashId)) trashId = timeId(deletedAt);
    const dir = path.join(this.trashRoot, trashId);
    const file: TrashFile = { format: 'durbun-flow-trash', deletedAt, flow };
    await writeJsonFile(path.join(dir, 'item.json'), file, 0o644);
    const versions = (await this.versions(flow.id)).length;
    this.index.delete(flow.id);
    try {
      await fsp.rename(this.dirOf(flow.id), path.join(dir, 'history'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`could not keep the history of ${flow.id}: ${(err as Error).message}`);
    }
    const item = this.trashItem(trashId, deletedAt, flow, versions);
    this.trashItems.unshift(item);
    await this.pruneTrash();
    const { flow: _f, ...out } = item;
    return out;
  }

  /** The deleted flow, still in the trash (restore takes it out with `release`). */
  trashed(trashId: string): FlowDoc | undefined {
    return this.trashItems.find((x) => x.trashId === trashId)?.flow;
  }

  /** The flow came back as `flowId`: its versions go back with it and the trash entry goes. */
  async release(trashId: string, flowId: string): Promise<void> {
    const dir = path.join(this.trashRoot, trashId);
    this.index.delete(flowId);
    try {
      await fsp.rm(this.dirOf(flowId), { recursive: true, force: true });
      await fsp.mkdir(this.historyRoot, { recursive: true });
      await fsp.rename(path.join(dir, 'history'), this.dirOf(flowId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`could not bring back the history of ${flowId}: ${(err as Error).message}`);
    }
    await this.purge(trashId);
  }

  /** Remove a deleted flow for good. */
  async purge(trashId: string): Promise<boolean> {
    const i = this.trashItems.findIndex((x) => x.trashId === trashId);
    if (i < 0) return false;
    this.trashItems.splice(i, 1);
    await fsp.rm(path.join(this.trashRoot, trashId), { recursive: true, force: true });
    return true;
  }

  private async pruneTrash(): Promise<void> {
    const now = this.now();
    const drop = this.trashItems.filter((x, i) => i >= MAX_TRASH || x.expiresAt <= now).map((x) => x.trashId);
    for (const id of drop) await this.purge(id);
  }
}
