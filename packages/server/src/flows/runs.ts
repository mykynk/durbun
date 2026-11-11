/**
 * Flow run history: `<dataDir>/flow-runs/<runId>.json` (the run with its steps) and `<dataDir>/flow-runs/<runId>/`
 * (its evidence: screenshots, recordings). The newest MAX_RUNS runs are kept, within MAX_RUNS_BYTES on disk
 * (recordings add up); older ones go with their files.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FlowRun, FlowRunHeader, FlowRunStatus } from '@durbun/protocol';
import type { Logger } from '../types';
import { Queue, readJsonFile, writeJsonFile } from './util';

export const RUNS_DIR = 'flow-runs';
export const MAX_RUNS = 200;
/** Disk the run history may use (run files + evidence); the newest run always stays. */
export const MAX_RUNS_BYTES = 2 * 1024 ** 3;
const RUN_ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

export const isRunId = (id: string): boolean => RUN_ID_RE.test(id);

export function runHeader(run: FlowRun): FlowRunHeader {
  const { steps, ...rest } = run;
  return { ...rest, stepCount: steps.length };
}

export class RunStore {
  readonly dir: string;
  /** Newest first. */
  private headers: FlowRunHeader[] = [];
  /** Bytes on disk per run (run file + evidence), for MAX_RUNS_BYTES. */
  private readonly sizes = new Map<string, number>();
  private readonly queue = new Queue();

  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.dir = path.join(dataDir, RUNS_DIR);
  }

  async load(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`could not read ${this.dir}: ${(err as Error).message}`);
      return;
    }
    const headers: FlowRunHeader[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const run = (await readJsonFile(path.join(this.dir, name))) as FlowRun | undefined;
        if (!run || typeof run.id !== 'string' || !Array.isArray(run.steps)) continue;
        // A run that was still going when Dürbün quit.
        if (run.status === 'running') {
          run.status = 'cancelled';
          run.error = 'Dürbün was closed during the run';
          run.errorCode = 'flow.run.interrupted';
          await writeJsonFile(path.join(this.dir, name), run);
        }
        headers.push(runHeader(run));
        this.sizes.set(run.id, await this.diskSize(run.id));
      } catch (err) {
        this.logger.warn(`${RUNS_DIR}/${name}: ${(err as Error).message}`);
      }
    }
    this.headers = headers.sort((a, b) => b.startedAt - a.startedAt);
    await this.prune();
  }

  /** Bytes of a run's file and evidence folder. */
  private async diskSize(id: string): Promise<number> {
    let total = 0;
    try {
      total += (await fsp.stat(path.join(this.dir, `${id}.json`))).size;
    } catch {
      /* not written yet */
    }
    try {
      const dir = this.evidenceDir(id);
      for (const name of await fsp.readdir(dir)) {
        try {
          total += (await fsp.stat(path.join(dir, name))).size;
        } catch {
          /* gone meanwhile */
        }
      }
    } catch {
      /* no evidence */
    }
    return total;
  }

  /** Drop the oldest finished runs past MAX_RUNS or MAX_RUNS_BYTES. */
  private async prune(): Promise<void> {
    const finished = this.headers.filter((h) => h.status !== 'running');
    const drop = new Set(finished.slice(MAX_RUNS).map((h) => h.id));
    let bytes = 0;
    for (const h of this.headers) if (!drop.has(h.id)) bytes += this.sizes.get(h.id) ?? 0;
    // Oldest first, never the newest finished run.
    for (let i = finished.length - 1; i > 0 && bytes > MAX_RUNS_BYTES; i--) {
      const h = finished[i]!;
      if (drop.has(h.id)) continue;
      drop.add(h.id);
      bytes -= this.sizes.get(h.id) ?? 0;
    }
    for (const id of drop) await this.remove(id);
  }

  list(flowId?: string, limit = MAX_RUNS): FlowRunHeader[] {
    const list = flowId ? this.headers.filter((h) => h.flowId === flowId) : this.headers;
    return list.slice(0, limit);
  }

  /** Last finished or running run per flow. */
  lastRuns(): Map<string, FlowRunHeader> {
    const out = new Map<string, FlowRunHeader>();
    for (const h of this.headers) if (!out.has(h.flowId)) out.set(h.flowId, h);
    return out;
  }

  async get(id: string): Promise<FlowRun | undefined> {
    if (!isRunId(id)) return undefined;
    try {
      return (await readJsonFile(path.join(this.dir, `${id}.json`))) as FlowRun | undefined;
    } catch {
      return undefined;
    }
  }

  evidenceDir(id: string): string {
    return path.join(this.dir, id);
  }

  /** Path of an evidence file, or undefined for an unsafe name. */
  filePath(id: string, name: string): string | undefined {
    if (!isRunId(id) || !FILE_NAME_RE.test(name) || name.includes('..')) return undefined;
    return path.join(this.dir, id, name);
  }

  async files(id: string): Promise<string[]> {
    try {
      return (await fsp.readdir(this.evidenceDir(id))).filter((n) => FILE_NAME_RE.test(n));
    } catch {
      return [];
    }
  }

  /** Save (create or update) a run; the newest MAX_RUNS stay. */
  async save(run: FlowRun): Promise<void> {
    const header = runHeader(run);
    const i = this.headers.findIndex((h) => h.id === run.id);
    if (i >= 0) this.headers[i] = header;
    else {
      this.headers.unshift(header);
      this.headers.sort((a, b) => b.startedAt - a.startedAt);
    }
    await this.queue.run(() => writeJsonFile(path.join(this.dir, `${run.id}.json`), run));
    if (run.status === 'running') return;
    this.sizes.set(run.id, await this.diskSize(run.id));
    await this.prune();
  }

  async remove(id: string): Promise<boolean> {
    const i = this.headers.findIndex((h) => h.id === id);
    if (i < 0 || this.headers[i]!.status === 'running') return false;
    this.headers.splice(i, 1);
    this.sizes.delete(id);
    await this.queue.run(async () => {
      await fsp.rm(path.join(this.dir, `${id}.json`), { force: true });
      await fsp.rm(this.evidenceDir(id), { recursive: true, force: true });
    });
    return true;
  }

  /** Remove the finished runs of a flow (all flows without `flowId`). */
  async clear(flowId?: string): Promise<number> {
    const ids = this.headers.filter((h) => h.status !== 'running' && (!flowId || h.flowId === flowId)).map((h) => h.id);
    for (const id of ids) await this.remove(id);
    return ids.length;
  }

  /** A flow got a new id: its runs follow it (headers and files). */
  async renameFlow(from: string, to: string): Promise<number> {
    const ids = this.headers.filter((h) => h.flowId === from).map((h) => h.id);
    for (const h of this.headers) if (h.flowId === from) h.flowId = to;
    for (const id of ids) {
      await this.queue.run(async () => {
        const file = path.join(this.dir, `${id}.json`);
        try {
          const run = (await readJsonFile(file)) as FlowRun | undefined;
          if (!run || run.flowId !== from) return;
          run.flowId = to;
          await writeJsonFile(file, run);
        } catch (err) {
          this.logger.warn(`${RUNS_DIR}/${id}.json: could not move it to flow ${to}: ${(err as Error).message}`);
        }
      });
    }
    return ids.length;
  }

  /** Runs imported from a package keep their ids unless taken. */
  has(id: string): boolean {
    return this.headers.some((h) => h.id === id);
  }

  statusCounts(): Record<FlowRunStatus, number> {
    const c: Record<FlowRunStatus, number> = { running: 0, passed: 0, failed: 0, cancelled: 0 };
    for (const h of this.headers) c[h.status]++;
    return c;
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }
}
