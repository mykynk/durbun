/**
 * Flow environments ("Staging", "Prod"…): named sets of variables read as {{env.<key>}}.
 * `<dataDir>/environments.json`, mode 0600 (it holds tokens and passwords). Secret values stay on this Mac:
 * AI packs and shared packages carry the keys only; an encrypted backup carries the values.
 */
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import {
  FLOW_ENVIRONMENTS_FORMAT,
  VAR_NAME_RE,
  type FlowEnvironment,
  type FlowEnvironments,
  type FlowEnvironmentTls,
  type FlowEnvVar,
} from '@durbun/protocol';
import { isPlainObject } from '../config';
import { pemCertificates } from '../http/tlsFetch';
import type { Logger } from '../types';
import { FlowStoreError } from './store';
import { Queue, readJsonFile, slugId, writeJsonFile } from './util';

export const ENVIRONMENTS_FILE = 'environments.json';
const MAX_ENVIRONMENTS = 50;
const MAX_VARS = 500;
const MAX_VALUE_CHARS = 100_000;

export function emptyEnvironments(): FlowEnvironments {
  return { format: FLOW_ENVIRONMENTS_FORMAT, version: 1, environments: [] };
}

/** Most trusted certificates one environment may add (an internal CA chain is a handful). */
const MAX_CA_CERTS = 20;
export const MAX_CA_CHARS = 64 * 1024;

/**
 * An environment's certificate setting: the certificates of `ca` that parse (a pasted key or any other text is
 * dropped, so no private key is ever stored), `skipVerify` only when exactly true. Nothing set = undefined.
 */
function normalizeTls(raw: unknown, envName: string, problems: string[]): FlowEnvironmentTls | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: FlowEnvironmentTls = {};
  if (typeof raw.ca === 'string' && raw.ca.trim()) {
    const certs = pemCertificates(raw.ca.slice(0, MAX_CA_CHARS)).filter((pem) => {
      try {
        new X509Certificate(pem);
        return true;
      } catch {
        return false;
      }
    });
    if (certs.length) out.ca = certs.slice(0, MAX_CA_CERTS).join('\n') + '\n';
    else problems.push(`${envName}: ${CA_PROBLEM}`);
  }
  if (raw.skipVerify === true) out.skipVerify = true;
  return out.ca || out.skipVerify ? out : undefined;
}

const CA_PROBLEM = 'the trusted certificate text holds no PEM certificate (-----BEGIN CERTIFICATE-----)';

/** Validate a whole environments document (from the UI, a package or the file). */
export function normalizeEnvironments(raw: unknown): { value: FlowEnvironments; problems: string[] } {
  const problems: string[] = [];
  const value = emptyEnvironments();
  if (!isPlainObject(raw)) return { value, problems: ['Expected an object'] };
  const list = Array.isArray(raw.environments) ? raw.environments : [];
  const ids = new Set<string>();
  for (const [i, item] of list.slice(0, MAX_ENVIRONMENTS).entries()) {
    if (!isPlainObject(item)) {
      problems.push(`environments[${i}] is not an object`);
      continue;
    }
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 100) : `Environment ${i + 1}`;
    let id = typeof item.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id) ? item.id : slugId(name);
    for (let n = 2; ids.has(id); n++) id = `${slugId(name)}-${n}`;
    ids.add(id);
    const vars: FlowEnvVar[] = [];
    const keys = new Set<string>();
    const rawVars = Array.isArray(item.vars) ? item.vars : isPlainObject(item.vars) ? Object.entries(item.vars).map(([key, v]) => ({ key, value: v })) : [];
    for (const v of rawVars.slice(0, MAX_VARS)) {
      if (!isPlainObject(v)) continue;
      const key = typeof v.key === 'string' ? v.key.trim() : '';
      if (!VAR_NAME_RE.test(key)) {
        if (key) problems.push(`${name}: "${key}" is not a valid variable name (letters, digits, _)`);
        continue;
      }
      if (keys.has(key)) continue;
      keys.add(key);
      const text = v.value === undefined || v.value === null ? '' : typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
      const out: FlowEnvVar = { key, value: text.slice(0, MAX_VALUE_CHARS) };
      if (v.secret === true) out.secret = true;
      vars.push(out);
    }
    const env: FlowEnvironment = { id, name, vars };
    const tls = normalizeTls(item.tls, name, problems);
    if (tls) env.tls = tls;
    value.environments.push(env);
  }
  if (typeof raw.activeId === 'string' && ids.has(raw.activeId)) value.activeId = raw.activeId;
  else if (value.environments.length > 0 && raw.activeId !== null) value.activeId = value.environments[0]!.id;
  return { value, problems };
}

export class EnvironmentStore {
  readonly file: string;
  private data: FlowEnvironments = emptyEnvironments();
  private readonly queue = new Queue();
  private readonly listeners = new Set<() => void>();

  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.file = path.join(dataDir, ENVIRONMENTS_FILE);
  }

  async load(): Promise<void> {
    try {
      const raw = await readJsonFile(this.file);
      if (raw === undefined) return;
      const { value, problems } = normalizeEnvironments(raw);
      this.data = value;
      for (const p of problems) this.logger.warn(`${ENVIRONMENTS_FILE}: ${p}`);
    } catch (err) {
      this.logger.warn(`could not read ${ENVIRONMENTS_FILE}: ${(err as Error).message}; starting without environments`);
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(): FlowEnvironments {
    return structuredClone(this.data);
  }

  /** The environment a run uses: `id` (null = none, undefined = the active one). */
  resolve(id: string | null | undefined): FlowEnvironment | undefined {
    if (id === null) return undefined;
    const wanted = id ?? this.data.activeId;
    return this.data.environments.find((e) => e.id === wanted);
  }

  async put(raw: unknown): Promise<{ value: FlowEnvironments; problems: string[] }> {
    if (!isPlainObject(raw)) throw new FlowStoreError('Expected an environments object', 'env.invalid');
    const result = normalizeEnvironments(raw);
    // A certificate that does not parse would silently leave the HTTPS steps failing: refuse the save instead.
    const badCa = result.problems.find((p) => p.endsWith(CA_PROBLEM));
    if (badCa) throw new FlowStoreError(badCa, 'env.tls.invalidCa');
    this.data = result.value;
    await this.queue.run(() => writeJsonFile(this.file, this.data, 0o600));
    for (const l of this.listeners) l();
    return { value: this.get(), problems: result.problems };
  }

  /** Add or update variables in one environment (create-from-requests saves what it found). */
  async upsertVars(envId: string | undefined, vars: FlowEnvVar[], newName = 'Default'): Promise<FlowEnvironment> {
    const next = this.get();
    let env = envId ? next.environments.find((e) => e.id === envId) : next.environments.find((e) => e.id === next.activeId);
    if (!env) {
      env = { id: slugId(newName), name: newName, vars: [] };
      for (let n = 2; next.environments.some((e) => e.id === env!.id); n++) env.id = `${slugId(newName)}-${n}`;
      next.environments.push(env);
      next.activeId ??= env.id;
    }
    for (const v of vars) {
      const old = env.vars.find((x) => x.key === v.key);
      if (old) {
        old.value = v.value;
        if (v.secret) old.secret = true;
      } else env.vars.push({ ...v });
    }
    await this.put(next);
    return this.resolve(env.id)!;
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }
}
