/**
 * Dürbün packages (`.durbun`): export, inspect and import everything a person set up — flows, mock rules,
 * environments, settings, UI preferences, the Slack connection and flow runs with their evidence.
 *
 *   share   for teammates: chosen items, never secrets (secret environment values and the default values of secret
 *           flow inputs stay out). Shared flows come in with their automation off.
 *   backup  for a new Mac: everything; secrets only encrypted with a passphrase (AES-256-GCM, key from scrypt). The
 *           SHA-256 of the contents is the GCM associated data: the passphrase opens only an unchanged package.
 *
 * An import never overwrites silently: the UI inspects the file first (what is new, what exists and differs)
 * and the user picks what to bring and what to do with the same ids (replace, keep both, skip). Items identical to
 * what is here are left alone whatever the choice. Local secret values survive a replace by a package that carries
 * none, and replacing an environment keeps this Mac's own variables.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  validateFlow,
  type DurbunPackage,
  type DurbunPackageContents,
  type EncryptedBlob,
  type FlowDoc,
  type FlowEnvironment,
  type FlowEnvironments,
  type FlowRun,
  type MockRule,
  type PackageConflict,
  type PackageExportRequest,
  type PackageImportRequest,
  type PackageImportResult,
  type PackageItemPreview,
  type PackageKind,
  type PackageManifest,
  type PackageNotice,
  type PackageRun,
  type PackageRunFile,
  type PackageSecrets,
  type ServerSettings,
} from '@durbun/protocol';
import { isPlainObject, validateMockRules, type ConfigStore } from '../config';
import { normalizeEnvironments, type EnvironmentStore } from '../flows/environments';
import { isRunId, type RunStore } from '../flows/runs';
import type { FlowStore } from '../flows/store';
import { timeId } from '../flows/util';
import type { Logger } from '../types';
import { machineName } from './machine';
import type { UiPrefsStore } from './uiPrefs';

export const PACKAGE_JSON_LIMIT_BYTES = 256 * 1024 * 1024;
/** Evidence (screenshots, videos) carried in one package. */
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const STAGE_TTL_MS = 30 * 60_000;
/** Packages read by inspect and kept for the import (each can be large). */
const MAX_STAGED = 2;
const MACHINE_KEYS: (keyof ServerSettings)[] = ['adbPath', 'idevicesyslogPath', 'allowLan'];
export const MIN_PACKAGE_PASSPHRASE = 8;

export class PackageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'PackageError';
  }
}

export interface PackageDeps {
  flows: FlowStore;
  envs: EnvironmentStore;
  runs: RunStore;
  config: Pick<ConfigStore, 'mocks' | 'setMocks' | 'storedSettings' | 'updateSettings'>;
  slack?: { secrets(): Promise<{ webhookUrl?: string; sender?: string }>; update(raw: unknown): Promise<unknown> };
  uiPrefs: UiPrefsStore;
  version: string;
  logger: Logger;
  now(): number;
}

/* ────────────────────────────── crypto ────────────────────────────── */

/** New blobs: N = 2^17 (128 MiB), r = 8, p = 1. Stored params are read back as they are, within bounds. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
/** What a crafted file may ask scrypt for. */
const MAX_SCRYPT_MEM = 256 * 1024 * 1024;
const scryptMem = (N: number, r: number, p: number) => 128 * r * (N + p + 2);
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function scrypt(passphrase: string, salt: Buffer, opts: ScryptOptions & { N: number; r: number; p: number }): Promise<Buffer> {
  const maxmem = scryptMem(opts.N, opts.r, opts.p) + 1024 * 1024;
  return new Promise((resolve, reject) =>
    scryptCb(passphrase.normalize('NFC'), salt, 32, { N: opts.N, r: opts.r, p: opts.p, maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** The associated data that binds a blob to the package contents. */
export function contentsDigest(contents: unknown): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(contents ?? {}) ?? '')
    .digest();
}

export async function encryptSecrets(secrets: PackageSecrets, passphrase: string, contents?: DurbunPackageContents): Promise<EncryptedBlob> {
  const salt = randomBytes(16);
  const iv = randomBytes(IV_BYTES);
  const key = await scrypt(passphrase, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (contents) cipher.setAAD(contentsDigest(contents));
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return {
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    ...(contents ? { aad: 'contents-sha256' as const } : {}),
  };
}

function base64Field(blob: Record<string, unknown>, key: string, bytes?: { min: number; max: number }): Buffer {
  const v = blob[key];
  if (typeof v !== 'string' || v.length % 4 !== 0 || !BASE64_RE.test(v)) throw new PackageError(`The encrypted part of the package is damaged (${key})`, 'package.crypto.invalid');
  const buf = Buffer.from(v, 'base64');
  if (bytes && (buf.length < bytes.min || buf.length > bytes.max)) throw new PackageError(`The encrypted part of the package is damaged (${key})`, 'package.crypto.invalid');
  return buf;
}

/**
 * Opens the secrets. `contents` is the package's contents: a blob made with associated data opens only together
 * with the contents it was made for. Malformed blobs are `package.crypto.*` errors, never a crash.
 */
export async function decryptSecrets(raw: EncryptedBlob, passphrase: string, contents?: unknown): Promise<PackageSecrets> {
  if (!isPlainObject(raw)) throw new PackageError('The encrypted part of the package is damaged', 'package.crypto.invalid');
  const blob = raw as unknown as Record<string, unknown>;
  if (blob.cipher !== 'aes-256-gcm' || blob.kdf !== 'scrypt' || (blob.aad !== undefined && blob.aad !== 'contents-sha256')) {
    throw new PackageError('Unknown encryption in this package', 'package.crypto.unknown');
  }
  const { N, r, p } = blob as { N: unknown; r: unknown; p: unknown };
  // A crafted file must not make scrypt eat the machine.
  const okParams =
    typeof N === 'number' &&
    typeof r === 'number' &&
    typeof p === 'number' &&
    Number.isInteger(N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    N >= 1 << 14 &&
    N <= 1 << 20 &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= 16 &&
    p >= 1 &&
    p <= 4 &&
    scryptMem(N, r, p) <= MAX_SCRYPT_MEM;
  if (!okParams) throw new PackageError('The package has unusable encryption settings', 'package.crypto.unknown');
  const salt = base64Field(blob, 'salt', { min: 8, max: 64 });
  const iv = base64Field(blob, 'iv', { min: IV_BYTES, max: IV_BYTES });
  const tag = base64Field(blob, 'tag', { min: TAG_BYTES, max: TAG_BYTES });
  const data = base64Field(blob, 'data');
  let key: Buffer;
  try {
    key = await scrypt(passphrase, salt, { N, r, p });
  } catch {
    throw new PackageError('The package has unusable encryption settings', 'package.crypto.unknown');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    if (blob.aad === 'contents-sha256') decipher.setAAD(contentsDigest(contents));
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    const value = JSON.parse(text) as unknown;
    return isPlainObject(value) ? (value as PackageSecrets) : {};
  } catch {
    throw new PackageError('The passphrase is wrong, or the file was changed after it was saved', 'package.passphrase.wrong');
  }
}

/* ────────────────────────────── helpers ────────────────────────────── */

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "Login" → "Login (2)", or (3)… when that name is taken too. */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A flow as compared for "same": no timestamps, no layout, no secret defaults; automation only for backups. */
function flowShape(f: FlowDoc, kind: PackageKind): unknown {
  return {
    ...f,
    createdAt: undefined,
    updatedAt: undefined,
    automation: kind === 'backup' ? f.automation : undefined,
    inputs: f.inputs?.map((d) => (d.secret ? { ...d, default: undefined } : d)),
    nodes: f.nodes.map((n) => ({ ...n, position: undefined })),
  };
}

/** A mock rule as compared for "same": what it matches and does (its id and creation time aside). */
const mockShape = (r: MockRule) => ({ ...r, id: undefined, createdAt: undefined, name: r.name || undefined });

/** One validated rule (or undefined), the way an import stores it. */
function validMock(raw: unknown): MockRule | undefined {
  return validateMockRules([raw]).rules[0];
}

/** Environment variables as compared for "same": secret values only when both sides have one. */
function envShape(e: FlowEnvironment): unknown {
  return { name: e.name, vars: e.vars.map((v) => ({ key: v.key, secret: !!v.secret, value: v.value })) };
}

/** Settings set on purpose, without what only makes sense on this Mac. */
export function portableSettings(stored: ServerSettings): Partial<ServerSettings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (MACHINE_KEYS.includes(k as keyof ServerSettings) || v === undefined) continue;
    if (JSON.stringify(v) !== JSON.stringify((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k])) out[k] = v;
  }
  return out as Partial<ServerSettings>;
}

const contentTypeOf = (name: string) =>
  ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime' })[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

/* ────────────────────────────── export ────────────────────────────── */

/** Flows with every flow they call (directly or deeper). */
function withCalledFlows(flows: FlowStore, ids: string[]): FlowDoc[] {
  const out = new Map<string, FlowDoc>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const f = flows.get(id);
    if (!f) continue;
    out.set(id, f);
    for (const n of f.nodes) if (n.type === 'flow.call' && typeof n.params?.flowId === 'string') stack.push(n.params.flowId);
  }
  return [...out.values()];
}

export async function buildPackage(deps: PackageDeps, req: PackageExportRequest): Promise<DurbunPackage> {
  const kind = req.kind === 'backup' ? 'backup' : 'share';
  const inc = isPlainObject(req.include) ? req.include : {};
  const contents: DurbunPackageContents = {};
  const secrets: PackageSecrets = {};
  const passphrase = kind === 'backup' && typeof req.passphrase === 'string' && req.passphrase ? req.passphrase : undefined;
  if (passphrase !== undefined && passphrase.length < MIN_PACKAGE_PASSPHRASE) {
    throw new PackageError(`Use a passphrase of at least ${MIN_PACKAGE_PASSPHRASE} characters`, 'package.passphrase.short');
  }
  const encrypt = passphrase !== undefined;

  if (inc.flows) {
    const ids = inc.flows === 'all' ? deps.flows.list().map((f) => f.id) : Array.isArray(inc.flows) ? inc.flows.filter((x): x is string => typeof x === 'string') : [];
    const flows = withCalledFlows(deps.flows, ids).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // Default values of secret inputs: never in a share, only encrypted in a backup.
    const held: Record<string, string[]> = {};
    const out = flows.map((f) => {
      if (!f.inputs?.some((d) => d.secret && d.default !== undefined)) return f;
      const inputs = f.inputs.map((d) => {
        if (!d.secret || d.default === undefined) return d;
        (held[f.id] ??= []).push(d.name);
        if (encrypt) ((secrets.inputs ??= {})[f.id] ??= {})[d.name] = d.default;
        const { default: _default, ...rest } = d;
        return rest;
      });
      return { ...f, inputs };
    });
    if (out.length) contents.flows = out;
    if (Object.keys(held).length) contents.secretInputs = held;
  }
  if (inc.mocks) {
    const own = deps.config.mocks.filter((r) => !r.id.startsWith('flow-'));
    const rules = Array.isArray(inc.mocks) ? own.filter((r) => (inc.mocks as string[]).includes(r.id)) : own;
    if (rules.length) contents.mocks = rules;
  }
  if (inc.environments) {
    const envs = deps.envs.get();
    if (envs.environments.length) {
      for (const env of envs.environments) {
        for (const v of env.vars) {
          if (!v.secret) continue;
          if (encrypt && v.value) (secrets.env ??= {})[env.id] = { ...(secrets.env?.[env.id] ?? {}), [v.key]: v.value };
          v.value = '';
        }
      }
      contents.environments = envs;
    }
  }
  if (inc.settings) {
    const s = portableSettings(deps.config.storedSettings);
    if (Object.keys(s).length) contents.settings = s;
  }
  if (inc.uiPrefs) {
    const prefs = isPlainObject(req.uiPrefs) ? req.uiPrefs : await deps.uiPrefs.get();
    if (prefs && Object.keys(prefs).length) contents.uiPrefs = prefs;
  }
  if (inc.slack && deps.slack) {
    const s = await deps.slack.secrets();
    if (s.webhookUrl || s.sender) contents.slack = { configured: !!s.webhookUrl, ...(s.sender ? { sender: s.sender } : {}) };
    if (encrypt && s.webhookUrl) secrets.slackWebhook = s.webhookUrl;
  }
  if (inc.runs) {
    const headers = Array.isArray(inc.runs) ? deps.runs.list().filter((h) => (inc.runs as string[]).includes(h.id)) : deps.runs.list();
    const runs: PackageRun[] = [];
    let budget = MAX_EVIDENCE_BYTES;
    for (const h of headers.filter((x) => x.status !== 'running')) {
      const run = await deps.runs.get(h.id);
      if (!run) continue;
      const files: PackageRunFile[] = [];
      for (const name of await deps.runs.files(run.id)) {
        const file = deps.runs.filePath(run.id, name);
        if (!file) continue;
        const stat = await fsp.stat(file).catch(() => undefined);
        if (!stat?.isFile() || stat.size > budget) continue;
        budget -= stat.size;
        files.push({ name, contentType: contentTypeOf(name), data: (await fsp.readFile(file)).toString('base64') });
      }
      runs.push(files.length ? { run, files } : { run });
    }
    if (runs.length) contents.runs = runs;
  }

  const pkg: DurbunPackage = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    kind,
    createdAt: deps.now(),
    // A share travels to other people: it names no machine. A backup says which Mac it came from.
    createdBy: { app: 'Dürbün', version: deps.version, ...(kind === 'backup' ? { host: machineName() } : {}) },
    contents,
  };
  const name = text(req.name, 200);
  const note = text(req.note, 2_000);
  if (name) pkg.name = name;
  if (note) pkg.note = note;
  if (encrypt && (secrets.env || secrets.slackWebhook || secrets.inputs)) pkg.secrets = await encryptSecrets(secrets, passphrase!, contents);
  return pkg;
}

/* ────────────────────────────── inspect ────────────────────────────── */

export function checkPackage(raw: unknown): DurbunPackage {
  if (!isPlainObject(raw)) throw new PackageError('Not a Dürbün package (expected a JSON object)', 'package.invalid');
  if (raw.format !== PACKAGE_FORMAT) {
    if (raw.format === 'durbun-flow' || Array.isArray(raw.nodes)) throw new PackageError('This is a flow file: import it in Flows', 'package.isFlow');
    if (raw.format === 'durbun-session') throw new PackageError('This is a recorded session: open it with Import session', 'package.isSession');
    throw new PackageError('Not a Dürbün package', 'package.invalid');
  }
  if (raw.version !== PACKAGE_VERSION) throw new PackageError(`This Dürbün reads package version ${PACKAGE_VERSION} (got ${String(raw.version)}); update Dürbün`, 'package.version');
  if (!isPlainObject(raw.contents)) throw new PackageError('The package has no contents', 'package.invalid');
  return raw as unknown as DurbunPackage;
}

/** The manifest's header from whatever the file says (hand-made and AI-made packages included): strings only. */
function manifestHeader(pkg: DurbunPackage): Pick<PackageManifest, 'kind' | 'name' | 'note' | 'createdAt' | 'createdBy'> {
  const by = isPlainObject(pkg.createdBy) ? (pkg.createdBy as unknown as Record<string, unknown>) : {};
  const host = text(by.host, 120);
  const name = text(pkg.name, 200);
  const note = text(pkg.note, 2_000);
  const createdAt = typeof pkg.createdAt === 'number' && Number.isFinite(pkg.createdAt) && pkg.createdAt > 0 ? pkg.createdAt : 0;
  return {
    kind: pkg.kind === 'backup' ? 'backup' : 'share',
    ...(name ? { name } : {}),
    ...(note ? { note } : {}),
    createdAt,
    createdBy: { app: text(by.app, 80) ?? 'Dürbün', version: text(by.version, 40) ?? '', ...(host ? { host } : {}) },
  };
}

export interface StagedPackage {
  pkg: DurbunPackage;
  at: number;
}

export class PackageService {
  private readonly staged = new Map<string, StagedPackage>();

  constructor(private readonly deps: PackageDeps) {}

  export(req: PackageExportRequest): Promise<DurbunPackage> {
    return buildPackage(this.deps, isPlainObject(req) ? req : ({ kind: 'share', include: {} } as PackageExportRequest));
  }

  private prune(): void {
    const now = this.deps.now();
    for (const [k, v] of this.staged) if (now - v.at > STAGE_TTL_MS) this.staged.delete(k);
  }

  private stage(pkg: DurbunPackage): string {
    this.prune();
    // Map order is insertion order: the oldest go first.
    while (this.staged.size >= MAX_STAGED) this.staged.delete(this.staged.keys().next().value!);
    const token = timeId(this.deps.now());
    this.staged.set(token, { pkg, at: this.deps.now() });
    return token;
  }

  private staging(token: string): DurbunPackage {
    this.prune();
    const s = this.staged.get(token);
    if (!s) throw new PackageError('The file is no longer open; choose it again', 'package.expired', 410);
    return s.pkg;
  }

  /** Forgets a package inspect kept (the dialog closed). */
  release(token: string): boolean {
    return this.staged.delete(token);
  }

  /**
   * What a package holds and how it compares with what is here. With `token` (from an earlier inspect) the kept
   * package is read again, e.g. to check a passphrase, and keeps its token.
   */
  async inspect(raw: unknown, passphrase?: string, token?: string): Promise<PackageManifest> {
    const pkg = token ? this.staging(token) : checkPackage(raw);
    const c = pkg.contents;
    const header = manifestHeader(pkg);
    const warnings: PackageManifest['warnings'] = [];
    const flows: PackageItemPreview[] = [];
    const known = new Set([...this.deps.flows.ids(), ...(Array.isArray(c.flows) ? c.flows : []).map((f) => (isPlainObject(f) ? String(f.id ?? '') : ''))]);
    for (const f of Array.isArray(c.flows) ? c.flows : []) {
      const { flow, issues } = validateFlow(f, { knownFlowIds: known });
      if (!flow) {
        warnings.push({ code: 'package.flow.invalid', message: `A flow could not be read: ${issues[0]?.message ?? ''}`, params: { problem: issues[0]?.message ?? '' } });
        continue;
      }
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) warnings.push({ code: 'package.flow.problems', message: `${flow.name}: ${errors.length} problem(s), e.g. ${errors[0]!.message}`, params: { flow: flow.name, count: errors.length } });
      const cur = this.deps.flows.get(flow.id);
      flows.push({
        id: flow.id,
        name: flow.name,
        exists: !!cur,
        ...(cur ? { differs: !sameJson(flowShape(cur, header.kind), flowShape(flow, header.kind)) } : {}),
        ...(flow.automation?.enabled ? { automation: true } : {}),
      });
    }
    const localMocks = this.deps.config.mocks;
    const mocks: PackageItemPreview[] = [];
    for (const [i, r] of (Array.isArray(c.mocks) ? c.mocks : []).entries()) {
      const rule = validMock(r);
      if (!rule) {
        const problem = validateMockRules([r]).problems[0] ?? `rule #${i + 1}`;
        warnings.push({ code: 'package.mock.invalid', message: `A mock rule could not be read: ${problem}`, params: { problem } });
        continue;
      }
      const cur = localMocks.find((m) => m.id === rule.id);
      const twin = localMocks.some((m) => sameJson(mockShape(m), mockShape(rule)));
      mocks.push({
        id: rule.id,
        name: rule.name || `${rule.method} ${rule.url}`,
        exists: !!cur || twin,
        ...(cur || twin ? { differs: !twin } : {}),
      });
    }
    const localEnvs = this.deps.envs.get();
    const envs = c.environments ? normalizeEnvironments(c.environments).value.environments : [];
    const environments: PackageItemPreview[] = envs.map((e) => {
      const cur = localEnvs.environments.find((x) => x.id === e.id);
      return { id: e.id, name: e.name, exists: !!cur, ...(cur ? { differs: !sameJson(envShape(this.mergeEnv(cur, e, {})), envShape(cur)) } : {}) };
    });
    let passphraseOk: boolean | undefined;
    if (pkg.secrets && passphrase) {
      try {
        await decryptSecrets(pkg.secrets, passphrase, c);
        passphraseOk = true;
      } catch (err) {
        // A damaged encrypted part is its own problem, not a wrong passphrase.
        if (err instanceof PackageError && err.code !== 'package.passphrase.wrong') throw err;
        passphraseOk = false;
      }
    }
    return {
      ...header,
      flows,
      mocks,
      environments,
      envVarCount: envs.reduce((n, e) => n + e.vars.length, 0),
      settings: isPlainObject(c.settings) && Object.keys(c.settings).length > 0,
      uiPrefs: isPlainObject(c.uiPrefs) && Object.keys(c.uiPrefs).length > 0,
      slack: isPlainObject(c.slack),
      runs: Array.isArray(c.runs) ? c.runs.length : 0,
      hasSecrets: isPlainObject(pkg.secrets),
      warnings,
      token: token ?? this.stage(pkg),
      ...(passphraseOk !== undefined ? { passphraseOk } : {}),
    };
  }

  /* ────────────────────────────── import ────────────────────────────── */

  async import(req: PackageImportRequest): Promise<PackageImportResult> {
    const pkg = isPlainObject(req) && typeof req.token === 'string' && req.token ? this.staging(req.token) : checkPackage(isPlainObject(req) ? req.package : undefined);
    const c = pkg.contents;
    const kind: PackageKind = pkg.kind === 'backup' ? 'backup' : 'share';
    const inc = isPlainObject(req.include) ? req.include : {};
    const conflict: PackageConflict = req.conflict === 'replace' || req.conflict === 'keepBoth' ? req.conflict : 'skip';
    const result: PackageImportResult = {
      flows: { added: 0, replaced: 0, skipped: 0, renamed: 0, same: 0 },
      mocks: { added: 0, replaced: 0, skipped: 0, same: 0 },
      environments: { added: 0, replaced: 0, skipped: 0, same: 0 },
      settings: false,
      slack: false,
      runs: 0,
      secretsRestored: false,
      warnings: [],
      notices: [],
      automationOff: 0,
      emptySecrets: [],
    };
    const warn = (code: string, msg: string, params?: PackageNotice['params']) => {
      result.warnings.push(msg);
      result.notices!.push({ code, message: msg, ...(params ? { params } : {}) });
    };

    let secrets: PackageSecrets = {};
    if (pkg.secrets) {
      if (typeof req.passphrase === 'string' && req.passphrase) {
        secrets = await decryptSecrets(pkg.secrets, req.passphrase, c);
        result.secretsRestored = true;
      } else if (inc.environments || inc.slack || inc.flows) {
        warn('package.secrets.notRestored', 'Secrets were not restored: the package is protected with a passphrase');
      }
    }

    if (inc.flows && Array.isArray(c.flows)) await this.importFlows(c.flows, inc.flows, kind, conflict, secrets, c.secretInputs, result, warn);
    if (inc.mocks && Array.isArray(c.mocks)) this.importMocks(c.mocks, conflict, result, warn);
    if (inc.environments && c.environments) await this.importEnvironments(c.environments, secrets, conflict, result);
    if (inc.settings && isPlainObject(c.settings)) {
      const patch: Record<string, unknown> = { ...c.settings };
      for (const k of MACHINE_KEYS) delete patch[k];
      try {
        const r = this.deps.config.updateSettings(patch);
        result.settings = true;
        if (r.ignored.length) warn('package.settings.ignored', `Unknown settings were ignored: ${r.ignored.join(', ')}`, { keys: r.ignored.join(', ') });
      } catch (err) {
        warn('package.settings.failed', `Settings were not applied: ${message(err)}`, { error: message(err) });
      }
    }
    if (inc.slack && this.deps.slack && (isPlainObject(c.slack) || secrets.slackWebhook)) {
      const slack = isPlainObject(c.slack) ? c.slack : undefined;
      const patch: Record<string, unknown> = {};
      if (typeof slack?.sender === 'string' && slack.sender) patch.sender = slack.sender;
      if (typeof secrets.slackWebhook === 'string' && secrets.slackWebhook) patch.webhookUrl = secrets.slackWebhook;
      if (Object.keys(patch).length) {
        try {
          await this.deps.slack.update(patch);
          result.slack = true;
        } catch (err) {
          warn('package.slack.failed', `Slack was not restored: ${message(err)}`, { error: message(err) });
        }
      }
      if (slack?.configured && !patch.webhookUrl) warn('package.slack.reconnect', 'Connect Slack again in Settings: the webhook travels only in an encrypted backup');
    }
    if (inc.runs && Array.isArray(c.runs)) result.runs = await this.importRuns(c.runs, warn);
    if (inc.uiPrefs && isPlainObject(c.uiPrefs)) {
      result.uiPrefs = c.uiPrefs;
      await this.deps.uiPrefs.put(c.uiPrefs).catch(() => undefined);
    }
    if (typeof req.token === 'string') this.staged.delete(req.token);
    if (!result.emptySecrets!.length) delete result.emptySecrets;
    return result;
  }

  private async importFlows(
    list: unknown[],
    which: unknown,
    kind: PackageKind,
    conflict: PackageConflict,
    secrets: PackageSecrets,
    held: unknown,
    result: PackageImportResult,
    warn: (code: string, msg: string, params?: PackageNotice['params']) => void,
  ): Promise<void> {
    const store = this.deps.flows;
    const ids = Array.isArray(which) ? new Set(which.filter((x): x is string => typeof x === 'string')) : undefined;
    const wanted = (id: string) => which === 'all' || which === true || !!ids?.has(id);
    const docs: FlowDoc[] = [];
    const known = new Set([...store.ids(), ...list.map((f) => (isPlainObject(f) ? String(f.id ?? '') : ''))]);
    for (const raw of list) {
      const { flow, issues } = validateFlow(raw, { knownFlowIds: known });
      if (!flow) {
        const problem = issues[0]?.message ?? '';
        warn('package.flow.invalid', `A flow could not be read: ${problem}`, { problem });
        continue;
      }
      if (wanted(flow.id)) docs.push(flow);
    }
    const heldInputs = isPlainObject(held) ? held : {};
    const restoredInputs = isPlainObject(secrets.inputs) ? secrets.inputs : {};

    /** Secret input defaults: from the encrypted part, else what this Mac has; the ones that stay empty are reported. */
    const withSecretDefaults = (f: FlowDoc, cur: FlowDoc | undefined): { doc: FlowDoc; empty: string[] } => {
      if (!f.inputs?.some((d) => d.secret)) return { doc: f, empty: [] };
      const restored = isPlainObject(restoredInputs[f.id]) ? (restoredInputs[f.id] as Record<string, unknown>) : {};
      const marked = Array.isArray(heldInputs[f.id]) ? (heldInputs[f.id] as unknown[]) : [];
      const empty: string[] = [];
      const inputs = f.inputs.map((d) => {
        if (!d.secret || d.default !== undefined) return d;
        const value = restored[d.name];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { ...d, default: value };
        const local = cur?.inputs?.find((x) => x.name === d.name && x.default !== undefined)?.default;
        if (local !== undefined) return { ...d, default: local };
        if (marked.includes(d.name)) empty.push(d.name);
        return d;
      });
      return { doc: { ...f, inputs }, empty };
    };

    // Identical flows are left alone whatever the choice.
    const same = new Set(docs.filter((f) => {
      const cur = store.get(f.id);
      return !!cur && sameJson(flowShape(cur, kind), flowShape(f, kind));
    }).map((f) => f.id));
    result.flows.same = same.size;

    // keepBoth: new ids first, so flow.call references between imported flows follow the rename.
    const rename = new Map<string, string>();
    if (conflict === 'keepBoth') {
      const taken = new Set(store.ids());
      for (const f of docs) {
        if (same.has(f.id)) continue;
        if (!taken.has(f.id)) {
          taken.add(f.id);
          continue;
        }
        let id = '';
        for (let n = 2; !id || taken.has(id); n++) id = `${f.id.slice(0, 60)}-${n}`;
        taken.add(id);
        rename.set(f.id, id);
      }
    }
    const names = new Set(store.list().map((f) => f.name));
    for (const f of docs) {
      if (same.has(f.id)) continue;
      const cur = store.get(f.id);
      const { doc: filled, empty } = withSecretDefaults(f, cur);
      let doc: FlowDoc = rename.size
        ? { ...filled, nodes: filled.nodes.map((n) => (n.type === 'flow.call' && typeof n.params?.flowId === 'string' && rename.has(n.params.flowId) ? { ...n, params: { ...n.params, flowId: rename.get(n.params.flowId) } } : n)) }
        : filled;
      // A shared flow does not start running here by itself: its automation comes in off.
      const switchOff = !!doc.automation?.enabled && (kind !== 'backup' || (cur !== undefined && conflict === 'keepBoth'));
      if (switchOff) doc = { ...doc, automation: { ...doc.automation!, enabled: false } };
      try {
        let saved: FlowDoc | undefined;
        if (!cur) {
          saved = (await store.save(doc, { create: true })).flow;
          result.flows.added++;
        } else if (conflict === 'replace') {
          saved = (await store.save(doc, { id: f.id })).flow;
          result.flows.replaced++;
        } else if (conflict === 'keepBoth') {
          const name = copyName(f.name, names);
          names.add(name);
          saved = (await store.save({ ...doc, id: rename.get(f.id) ?? f.id, name }, { create: true })).flow;
          result.flows.renamed++;
        } else {
          result.flows.skipped++;
        }
        if (saved) {
          if (switchOff) result.automationOff!++;
          if (empty.length) result.emptySecrets!.push({ kind: 'input', id: saved.id, name: saved.name, keys: empty });
        }
      } catch (err) {
        warn('package.flow.saveFailed', `${f.name}: ${message(err)}`, { flow: f.name, error: message(err) });
      }
    }
  }

  private importMocks(list: unknown[], conflict: PackageConflict, result: PackageImportResult, warn: (code: string, msg: string, params?: PackageNotice['params']) => void): void {
    const { rules, problems } = validateMockRules(list);
    for (const p of problems) warn('package.mock.invalid', `A mock rule could not be read: ${p}`, { problem: p });
    let next = [...this.deps.config.mocks];
    const names = new Set(next.map((r) => r.name || r.url));
    for (const rule of rules) {
      // The same rule (under any id) is already here: nothing to do whatever the choice.
      if (next.some((r) => sameJson(mockShape(r), mockShape(rule)))) {
        result.mocks.same!++;
        continue;
      }
      const i = next.findIndex((r) => r.id === rule.id);
      if (i < 0) {
        next.push(rule);
        result.mocks.added++;
      } else if (conflict === 'replace') {
        next[i] = rule;
        result.mocks.replaced++;
      } else if (conflict === 'keepBoth') {
        const name = copyName(rule.name || rule.url, names);
        names.add(name);
        next.push({ ...rule, id: `${rule.id.slice(0, 48)}-${timeId(this.deps.now())}`.slice(0, 64), name });
        result.mocks.added++;
      } else {
        result.mocks.skipped++;
      }
    }
    if (result.mocks.added || result.mocks.replaced) {
      try {
        next = this.deps.config.setMocks(next);
      } catch (err) {
        warn('package.mocks.saveFailed', `Mock rules were not saved: ${message(err)}`, { error: message(err) });
        result.mocks.added = 0;
        result.mocks.replaced = 0;
      }
    }
  }

  /**
   * `cur` with `incoming` laid over it: the package wins on the same keys, this Mac's other keys stay. A secret the
   * package carries empty keeps this Mac's value.
   */
  private mergeEnv(cur: FlowEnvironment, incoming: FlowEnvironment, restored: Record<string, string>): FlowEnvironment {
    const vars = cur.vars.map((v) => {
      const p = incoming.vars.find((x) => x.key === v.key);
      if (!p) return v;
      const value = restored[p.key] ?? (p.secret && !p.value ? v.value : p.value);
      return { ...p, value };
    });
    for (const p of incoming.vars) {
      if (!cur.vars.some((v) => v.key === p.key)) vars.push({ ...p, value: restored[p.key] ?? p.value });
    }
    return { ...cur, name: incoming.name, vars };
  }

  private async importEnvironments(raw: unknown, secrets: PackageSecrets, conflict: PackageConflict, result: PackageImportResult): Promise<void> {
    const incoming = normalizeEnvironments(raw).value;
    const local: FlowEnvironments = this.deps.envs.get();
    const names = new Set(local.environments.map((e) => e.name));
    const touched: FlowEnvironment[] = [];
    for (const env of incoming.environments) {
      const restored = isPlainObject(secrets.env?.[env.id]) ? (secrets.env![env.id] as Record<string, string>) : {};
      const restoredText: Record<string, string> = {};
      for (const [k, v] of Object.entries(restored)) if (typeof v === 'string') restoredText[k] = v;
      const cur = local.environments.find((e) => e.id === env.id);
      if (!cur) {
        const added = { ...env, vars: env.vars.map((v) => ({ ...v, value: restoredText[v.key] ?? v.value })) };
        local.environments.push(added);
        touched.push(added);
        result.environments.added++;
        continue;
      }
      const merged = this.mergeEnv(cur, env, restoredText);
      if (sameJson(envShape(merged), envShape(cur))) {
        result.environments.same!++;
      } else if (conflict === 'replace') {
        local.environments[local.environments.indexOf(cur)] = merged;
        touched.push(merged);
        result.environments.replaced++;
      } else if (conflict === 'keepBoth') {
        let id = `${env.id.slice(0, 60)}-2`;
        for (let n = 3; local.environments.some((e) => e.id === id); n++) id = `${env.id.slice(0, 60)}-${n}`;
        const name = copyName(env.name, names);
        names.add(name);
        // The copy starts from this Mac's secret values where the package has none.
        const copy = { ...merged, id, name, vars: merged.vars.filter((v) => env.vars.some((x) => x.key === v.key)) };
        local.environments.push(copy);
        touched.push(copy);
        result.environments.added++;
      } else {
        result.environments.skipped++;
      }
    }
    if (!local.activeId && incoming.activeId && local.environments.some((e) => e.id === incoming.activeId)) local.activeId = incoming.activeId;
    if (result.environments.added || result.environments.replaced) await this.deps.envs.put(local);
    for (const e of touched) {
      const keys = e.vars.filter((v) => v.secret && !v.value).map((v) => v.key);
      if (keys.length) result.emptySecrets!.push({ kind: 'env', id: e.id, name: e.name, keys });
    }
  }

  private async importRuns(list: unknown[], warn: (code: string, msg: string, params?: PackageNotice['params']) => void): Promise<number> {
    let count = 0;
    for (const item of list) {
      if (!isPlainObject(item) || !isPlainObject(item.run)) continue;
      const run = item.run as unknown as FlowRun;
      if (typeof run.id !== 'string' || !isRunId(run.id) || !Array.isArray(run.steps) || this.deps.runs.has(run.id)) continue;
      if (run.status === 'running') run.status = 'cancelled';
      const files = Array.isArray(item.files) ? (item.files as PackageRunFile[]) : [];
      try {
        for (const f of files) {
          const file = isPlainObject(f) && typeof f.name === 'string' ? this.deps.runs.filePath(run.id, f.name) : undefined;
          if (!file || typeof f.data !== 'string') continue;
          await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fsp.writeFile(file, Buffer.from(f.data, 'base64'), { mode: 0o600 });
        }
        await this.deps.runs.save(run);
        count++;
      } catch (err) {
        const name = typeof run.flowName === 'string' && run.flowName ? run.flowName : run.id;
        warn('package.run.failed', `Run ${name}: ${message(err)}`, { run: name, error: message(err) });
      }
    }
    return count;
  }
}
