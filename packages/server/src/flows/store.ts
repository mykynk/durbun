/**
 * Flows on disk: one `durbun-flow` document per file, `<dataDir>/flows/<id>.json`. The same document is what
 * the editor saves, a teammate imports and an AI writes. Files are validated on load; a file that cannot be
 * read is reported once and left alone (never overwritten or deleted).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  FLOW_FORMAT,
  FLOW_ID_RE,
  FLOW_VERSION,
  renameTemplateRoot,
  slugifyFlowId,
  summarizeFlow,
  validateFlow,
  type FlowDoc,
  type FlowIssue,
  type FlowSummary,
} from '@durbun/protocol';
import type { Logger } from '../types';
import { Queue, readJsonFile, writeJsonFile } from './util';

export const FLOWS_DIR = 'flows';
export const MAX_FLOWS = 1000;
/** Fixed paths under /api/flows/: a flow with one of these ids could not be opened, saved or deleted. */
export const RESERVED_FLOW_IDS: ReadonlySet<string> = new Set(['schema', 'ai-pack', 'import', 'from-requests']);

export class FlowStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly issues?: FlowIssue[],
  ) {
    super(message);
    this.name = 'FlowStoreError';
  }
}

interface Entry {
  flow: FlowDoc;
  issues: FlowIssue[];
}

export interface SaveResult {
  flow: FlowDoc;
  issues: FlowIssue[];
  created: boolean;
}

export class FlowStore {
  readonly dir: string;
  private readonly entries = new Map<string, Entry>();
  private readonly queue = new Queue();
  private readonly listeners = new Set<() => void>();
  /** Ids of new flows (and renames) whose file is being written: taken before the first await. */
  private readonly reserved = new Set<string>();
  /** Problems found while loading (file → message). */
  readonly loadProblems: { file: string; message: string }[] = [];

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = path.join(dataDir, FLOWS_DIR);
  }

  async load(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`could not read ${this.dir}: ${(err as Error).message}`);
      return;
    }
    const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    const docs: { file: string; raw: unknown }[] = [];
    for (const name of files) {
      try {
        docs.push({ file: name, raw: await readJsonFile(path.join(this.dir, name)) });
      } catch (err) {
        this.problem(name, `not valid JSON (${(err as Error).message})`);
      }
    }
    // Ids first, so flow.call references between loaded flows validate.
    const known = new Set(docs.map((d) => path.basename(d.file, '.json')));
    for (const { file, raw } of docs) {
      const fileId = path.basename(file, '.json');
      const { flow, issues } = validateFlow(raw, { knownFlowIds: known, addTrigger: false });
      if (!flow) {
        this.problem(file, issues.map((i) => i.message).join('; ') || 'not a flow');
        continue;
      }
      if (flow.id !== fileId) flow.id = fileId; // the file name is the id
      this.entries.set(flow.id, { flow, issues });
    }
    if (this.entries.size > 0) this.logger.debug(`loaded ${this.entries.size} flow(s)`);
  }

  private problem(file: string, message: string): void {
    this.loadProblems.push({ file, message });
    this.logger.warn(`flows/${file}: ${message}; it was left as it is`);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        this.logger.error(`flow change listener failed: ${(err as Error).message}`);
      }
    }
  }

  ids(): Set<string> {
    return new Set(this.entries.keys());
  }

  list(): FlowDoc[] {
    return [...this.entries.values()].map((e) => e.flow);
  }

  get(id: string): FlowDoc | undefined {
    return this.entries.get(id)?.flow;
  }

  issues(id: string): FlowIssue[] {
    return this.entries.get(id)?.issues ?? [];
  }

  summaries(): FlowSummary[] {
    return [...this.entries.values()]
      .map((e) => summarizeFlow(e.flow, e.issues))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name));
  }

  /** Used by a flow, being saved right now, or a fixed API path. */
  private taken(id: string): boolean {
    return this.entries.has(id) || this.reserved.has(id) || RESERVED_FLOW_IDS.has(id);
  }

  /** A free id based on `base` (name or id). */
  freeId(base: string): string {
    const root = slugifyFlowId(base).slice(0, 56) || 'flow';
    if (!this.taken(root)) return root;
    for (let n = 2; ; n++) {
      const id = `${root}-${n}`;
      if (!this.taken(id)) return id;
    }
  }

  /** Re-validate every flow (another flow was added or removed: flow.call references). */
  private revalidate(): void {
    const known = this.ids();
    for (const [id, e] of this.entries) {
      const { flow, issues } = validateFlow(e.flow, { knownFlowIds: known, addTrigger: false });
      if (flow) this.entries.set(id, { flow: e.flow, issues });
    }
  }

  /**
   * Validate and write a flow. `create`: a new flow (a taken id gets a free one). Otherwise `id` must exist;
   * the document's own id may differ (a rename: the old file goes, flow.call references follow).
   * Drafts with errors are saved too (the editor shows them; a run refuses them).
   */
  async save(raw: unknown, opts: { create?: boolean; id?: string; beforeRename?: (from: string, to: string) => void } = {}): Promise<SaveResult> {
    const existing = opts.id ? this.entries.get(opts.id) : undefined;
    if (opts.id && !existing) throw new FlowStoreError(`Flow ${opts.id} does not exist`, 'flow.notFound', 404);
    if (opts.create && this.entries.size + this.reserved.size >= MAX_FLOWS) throw new FlowStoreError(`At most ${MAX_FLOWS} flows`, 'flow.tooMany', 409);
    // An update without an id is the flow at that path (not a new id made from its name).
    if (opts.id && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const id = (raw as { id?: unknown }).id;
      if (id === undefined || id === null || id === '') raw = { ...(raw as object), id: opts.id };
    }
    const known = this.ids();
    const { flow, issues } = validateFlow(raw, { knownFlowIds: known, newFlowId: (name) => this.freeId(name), addTrigger: !!opts.create });
    if (!flow) throw new FlowStoreError(issues[0]?.message ?? 'Not a flow', issues[0]?.code ?? 'flow.invalid', 400, issues);
    flow.format = FLOW_FORMAT;
    flow.version = FLOW_VERSION;
    const now = this.now();
    if (opts.create) {
      if (this.taken(flow.id)) flow.id = this.freeId(flow.id);
      flow.createdAt = flow.createdAt ?? now;
    } else if (existing) {
      flow.createdAt = existing.flow.createdAt ?? flow.createdAt ?? now;
      if (flow.id !== opts.id) {
        if (!FLOW_ID_RE.test(flow.id)) throw new FlowStoreError(`Invalid flow id "${flow.id}"`, 'flow.id.invalid');
        if (RESERVED_FLOW_IDS.has(flow.id)) throw new FlowStoreError(`"${flow.id}" is reserved; choose another flow id`, 'flow.id.reserved', 409);
        if (this.taken(flow.id)) throw new FlowStoreError(`A flow with id "${flow.id}" already exists`, 'flow.id.taken', 409);
        opts.beforeRename?.(opts.id!, flow.id);
      }
    }
    flow.updatedAt = now;
    const oldId = existing && flow.id !== opts.id ? opts.id! : undefined;
    // Taken now, before the write: a second save in the same moment gets another id.
    const reservedId = opts.create || oldId ? flow.id : undefined;
    if (reservedId) this.reserved.add(reservedId);
    try {
      await this.queue.run(async () => {
        await writeJsonFile(path.join(this.dir, `${flow.id}.json`), flow, 0o644);
        if (oldId) await fsp.rm(path.join(this.dir, `${oldId}.json`), { force: true });
      });
      this.entries.set(flow.id, { flow, issues });
      if (oldId) {
        this.entries.delete(oldId);
        await this.rewriteCalls(oldId, flow.id);
      }
    } finally {
      if (reservedId) this.reserved.delete(reservedId);
    }
    this.revalidate();
    this.changed();
    return { flow, issues: this.entries.get(flow.id)!.issues, created: !!opts.create };
  }

  /** Flows calling `from` call `to` after a rename. */
  private async rewriteCalls(from: string, to: string): Promise<void> {
    for (const [id, e] of this.entries) {
      if (!e.flow.nodes.some((n) => n.type === 'flow.call' && n.params?.flowId === from)) continue;
      const flow: FlowDoc = {
        ...e.flow,
        nodes: e.flow.nodes.map((n) => (n.type === 'flow.call' && n.params?.flowId === from ? { ...n, params: { ...n.params, flowId: to } } : n)),
      };
      this.entries.set(id, { flow, issues: e.issues });
      await this.queue.run(() => writeJsonFile(path.join(this.dir, `${id}.json`), flow, 0o644));
    }
  }

  async remove(id: string): Promise<boolean> {
    if (!this.entries.has(id)) return false;
    await this.queue.run(() => fsp.rm(path.join(this.dir, `${id}.json`), { force: true }));
    this.entries.delete(id);
    this.revalidate();
    this.changed();
    return true;
  }

  /** A copy under a new id and name ("… (copy)"). */
  async duplicate(id: string, name?: string): Promise<SaveResult> {
    const src = this.entries.get(id);
    if (!src) throw new FlowStoreError(`Flow ${id} does not exist`, 'flow.notFound', 404);
    const copyName = name?.trim() || `${src.flow.name} (copy)`;
    const copy: FlowDoc = { ...structuredClone(src.flow), id: this.freeId(`${src.flow.id}-copy`), name: copyName };
    delete copy.createdAt;
    if (copy.automation) copy.automation = { ...copy.automation, enabled: false };
    return this.save(copy, { create: true });
  }

  /** Node ids renamed inside one flow keep templates working (the editor's rename). */
  static renameNode(flow: FlowDoc, from: string, to: string): FlowDoc {
    return {
      ...flow,
      nodes: flow.nodes.map((n) => ({ ...(renameTemplateRoot(n, from, to) as typeof n), id: n.id === from ? to : n.id })),
      edges: flow.edges.map((e) => ({ ...e, from: e.from === from ? to : e.from, to: e.to === from ? to : e.to })),
      outputs: flow.outputs?.map((o) => ({ ...o, value: renameTemplateRoot(o.value, from, to) as string })),
    };
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }
}
