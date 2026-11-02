/**
 * Persistent configuration in the data directory (default ~/.durbun):
 *   settings.json  ServerSettings — only explicitly set keys are written, merged over DEFAULT_SETTINGS on load
 *   mocks.json     MockRule[]
 *   tmp/           uploads, screenshots, recordings (entries older than 24 h are removed at start)
 *
 * Everything read from disk or received from the UI is validated: wrong types fall back to the default
 * (on load) or are rejected (UI patches), out-of-range numbers are clamped. Writes are atomic
 * (tmp file + fsync + rename) and serialized through one queue; `flush()` waits for pending writes.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  type Header,
  type MockAction,
  type MockRule,
  type ServerSettings,
  type UrlMatchType,
} from '@durbun/protocol';
import type { Logger } from './types';
import { silentLogger } from './util/logger';

export const SETTINGS_FILE = 'settings.json';
export const MOCKS_FILE = 'mocks.json';
export const TEMP_DIR_NAME = 'tmp';
/** Temp entries older than this are deleted at start. */
export const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Inclusive ranges for numeric settings (values outside are clamped). */
export const SETTINGS_LIMITS = {
  maxLogEntries: { min: 1_000, max: 1_000_000 },
  maxNetworkEntries: { min: 100, max: 100_000 },
  // A base64 body of 10 MiB still fits in one 16 MiB wire frame (MAX_FRAME_BYTES).
  maxBodyBytes: { min: 1_024, max: 10 * 1024 * 1024 },
  maxBodyStoreMB: { min: 16, max: 8_192 },
  logcatTail: { min: 0, max: 100_000 },
  metricsIntervalMs: { min: 250, max: 60_000 },
} as const;

type NumericKey = keyof typeof SETTINGS_LIMITS;
type BooleanKey = 'captureBodies' | 'autoAttachVmService' | 'allowLan';
type PathKey = 'adbPath' | 'idevicesyslogPath';
type SettingsKey = keyof ServerSettings;

const NUMERIC_KEYS = Object.keys(SETTINGS_LIMITS) as NumericKey[];
const BOOLEAN_KEYS: BooleanKey[] = ['captureBodies', 'autoAttachVmService', 'allowLan'];
const PATH_KEYS: PathKey[] = ['adbPath', 'idevicesyslogPath'];
const ENUMS = {
  iosSimLogScope: ['apps', 'all'],
  iosSimLogLevel: ['default', 'info', 'debug'],
} as const;
const ENUM_KEYS = Object.keys(ENUMS) as (keyof typeof ENUMS)[];

/** Every key a ServerSettings object may carry, in a stable order (used when writing settings.json). */
export const SETTINGS_KEYS: SettingsKey[] = [
  ...NUMERIC_KEYS,
  ...BOOLEAN_KEYS,
  ...ENUM_KEYS,
  'watchedApps',
  ...PATH_KEYS,
];

const MAX_WATCHED_APPS = 500;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_MOCK_RULES = 1_000;
const MAX_DELAY_MS = 10 * 60 * 1000;

export class ConfigValidationError extends Error {
  readonly code = 'config.invalid';
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/* ────────────────────────────── paths ────────────────────────────── */

/** `~` / `~/x` → home directory. Other paths are returned unchanged. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.durbun');
}

/** Show a path with the home directory abbreviated to `~` (banner, notices). */
export function tildify(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + path.sep))) return '~' + p.slice(home.length);
  return p;
}

/* ────────────────────────────── settings validation ────────────────────────────── */

type FieldResult = { ok: true; value: unknown; adjusted?: string } | { ok: false; problem: string };

function toNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function validateField(key: SettingsKey, raw: unknown): FieldResult {
  if ((NUMERIC_KEYS as string[]).includes(key)) {
    const { min, max } = SETTINGS_LIMITS[key as NumericKey];
    const n = toNumber(raw);
    if (n === undefined) return { ok: false, problem: `${key} must be a number` };
    const v = Math.min(max, Math.max(min, Math.round(n)));
    return v === n ? { ok: true, value: v } : { ok: true, value: v, adjusted: `${key} ${n} → ${v} (allowed ${min}–${max})` };
  }
  if ((BOOLEAN_KEYS as string[]).includes(key)) {
    const b = toBoolean(raw);
    return b === undefined ? { ok: false, problem: `${key} must be true or false` } : { ok: true, value: b };
  }
  if ((ENUM_KEYS as string[]).includes(key)) {
    const allowed = ENUMS[key as keyof typeof ENUMS] as readonly string[];
    return typeof raw === 'string' && allowed.includes(raw)
      ? { ok: true, value: raw }
      : { ok: false, problem: `${key} must be one of ${allowed.join(', ')}` };
  }
  if (key === 'watchedApps') {
    const list = typeof raw === 'string' ? raw.split(/[,\n]/) : raw;
    if (!Array.isArray(list)) return { ok: false, problem: 'watchedApps must be a list of app ids' };
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string') return { ok: false, problem: 'watchedApps must contain only strings' };
      const id = item.trim();
      if (id && id.length <= MAX_ID_LENGTH && !out.includes(id)) out.push(id);
    }
    const value = out.slice(0, MAX_WATCHED_APPS);
    const changed = value.length !== list.length;
    return changed ? { ok: true, value, adjusted: 'watchedApps normalized (trimmed, de-duplicated)' } : { ok: true, value };
  }
  if ((PATH_KEYS as string[]).includes(key)) {
    if (raw === null || raw === undefined) return { ok: true, value: undefined };
    if (typeof raw !== 'string') return { ok: false, problem: `${key} must be a file path` };
    const trimmed = raw.trim();
    if (trimmed.length > MAX_PATH_LENGTH || trimmed.includes('\0')) return { ok: false, problem: `${key} is not a valid path` };
    return { ok: true, value: trimmed === '' ? undefined : expandHome(trimmed) };
  }
  return { ok: false, problem: `unknown setting ${key}` };
}

export interface SettingsPatchValidation {
  /** Validated values for the keys present in the patch (path keys may be `undefined` = unset). */
  values: Partial<ServerSettings>;
  /** Present keys (validated), including unset path keys. */
  keys: SettingsKey[];
  /** Type errors; such keys are excluded from `values`. */
  problems: string[];
  /** Values that were clamped or normalized. */
  adjusted: string[];
  /** Keys that are not settings (ignored). */
  unknown: string[];
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a (partial) settings object without applying it. */
export function validateSettingsPatch(raw: unknown): SettingsPatchValidation {
  const result: SettingsPatchValidation = { values: {}, keys: [], problems: [], adjusted: [], unknown: [] };
  if (!isPlainObject(raw)) {
    result.problems.push('settings must be an object');
    return result;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(SETTINGS_KEYS as string[]).includes(key)) {
      result.unknown.push(key);
      continue;
    }
    const k = key as SettingsKey;
    const r = validateField(k, value);
    if (!r.ok) {
      result.problems.push(r.problem);
      continue;
    }
    (result.values as Record<string, unknown>)[k] = r.value;
    result.keys.push(k);
    if (r.adjusted) result.adjusted.push(r.adjusted);
  }
  return result;
}

/** Lenient load: merge `raw` over `base`; invalid fields keep the base value (reported as warnings). */
export function normalizeSettings(raw: unknown, base: ServerSettings = DEFAULT_SETTINGS): { settings: ServerSettings; keys: SettingsKey[]; warnings: string[] } {
  const v = validateSettingsPatch(raw);
  const settings: ServerSettings = { ...base, watchedApps: [...base.watchedApps] };
  for (const k of v.keys) {
    const value = (v.values as Record<string, unknown>)[k];
    if (value === undefined) delete (settings as unknown as Record<string, unknown>)[k];
    else (settings as unknown as Record<string, unknown>)[k] = value;
  }
  const warnings = [
    ...v.problems.map((p) => `${p} — using the default`),
    ...v.adjusted,
    ...v.unknown.map((k) => `unknown setting "${k}" ignored`),
  ];
  return { settings, keys: v.keys, warnings };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/* ────────────────────────────── mock rule validation ────────────────────────────── */

const MATCH_TYPES: UrlMatchType[] = ['contains', 'exact', 'glob', 'regex'];
const FAIL_ERRORS = ['timeout', 'connection', 'dns', 'tls', 'custom'] as const;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const BASE64_RE = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;

export function newMockRuleId(): string {
  return `mock-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function optionalString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function clampDelay(v: unknown): number | undefined {
  const n = toNumber(v);
  if (n === undefined) return undefined;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(n)));
}

function validateHeaders(v: unknown, where: string): { ok: true; headers?: Header[] } | { ok: false; problem: string } {
  if (v === undefined || v === null) return { ok: true };
  if (!Array.isArray(v)) return { ok: false, problem: `${where}: headers must be a list of [name, value] pairs` };
  const headers: Header[] = [];
  for (const h of v) {
    if (Array.isArray(h) && h.length >= 2 && typeof h[0] === 'string' && (typeof h[1] === 'string' || typeof h[1] === 'number')) {
      const name = h[0].trim();
      if (name) headers.push([name, String(h[1])]);
    } else if (isPlainObject(h) && typeof h.name === 'string' && (typeof h.value === 'string' || typeof h.value === 'number')) {
      const name = h.name.trim();
      if (name) headers.push([name, String(h.value)]);
    } else {
      return { ok: false, problem: `${where}: invalid header ${JSON.stringify(h)}` };
    }
  }
  return { ok: true, headers };
}

function validateAction(raw: unknown, where: string): { ok: true; action: MockAction } | { ok: false; problem: string } {
  if (!isPlainObject(raw)) return { ok: false, problem: `${where}: action is missing` };
  switch (raw.type) {
    case 'respond': {
      const status = toNumber(raw.status ?? 200);
      if (status === undefined || !Number.isInteger(status) || status < 100 || status > 599) {
        return { ok: false, problem: `${where}: status must be an integer between 100 and 599` };
      }
      const h = validateHeaders(raw.headers, where);
      if (!h.ok) return h;
      if (raw.body !== undefined && raw.body !== null && typeof raw.body !== 'string') {
        return { ok: false, problem: `${where}: body must be a string` };
      }
      const bodyEncoding = raw.bodyEncoding === 'base64' ? 'base64' : 'utf8';
      if (raw.bodyEncoding !== undefined && raw.bodyEncoding !== 'utf8' && raw.bodyEncoding !== 'base64') {
        return { ok: false, problem: `${where}: bodyEncoding must be utf8 or base64` };
      }
      const body = typeof raw.body === 'string' ? raw.body : undefined;
      if (body !== undefined && bodyEncoding === 'base64' && !BASE64_RE.test(body)) {
        return { ok: false, problem: `${where}: body is not valid base64` };
      }
      const action: MockAction = { type: 'respond', status };
      if (h.headers) action.headers = h.headers;
      if (body !== undefined) {
        action.body = body;
        action.bodyEncoding = bodyEncoding;
      }
      const delayMs = clampDelay(raw.delayMs);
      if (delayMs) action.delayMs = delayMs;
      return { ok: true, action };
    }
    case 'delay': {
      const delayMs = clampDelay(raw.delayMs);
      if (delayMs === undefined) return { ok: false, problem: `${where}: delayMs must be a number` };
      return { ok: true, action: { type: 'delay', delayMs } };
    }
    case 'fail': {
      const error = raw.error ?? 'connection';
      if (typeof error !== 'string' || !(FAIL_ERRORS as readonly string[]).includes(error)) {
        return { ok: false, problem: `${where}: error must be one of ${FAIL_ERRORS.join(', ')}` };
      }
      const action: MockAction = { type: 'fail', error: error as (typeof FAIL_ERRORS)[number] };
      const message = optionalString(raw.message, 2_000);
      if (message) action.message = message;
      const delayMs = clampDelay(raw.delayMs);
      if (delayMs) action.delayMs = delayMs;
      return { ok: true, action };
    }
    default:
      return { ok: false, problem: `${where}: action type must be respond, delay or fail` };
  }
}

export function validateMockRule(raw: unknown, index = 0, now = Date.now()): { ok: true; rule: MockRule } | { ok: false; problem: string } {
  const where = `rule #${index + 1}`;
  if (!isPlainObject(raw)) return { ok: false, problem: `${where}: must be an object` };
  const label = typeof raw.name === 'string' && raw.name.trim() ? `${where} (${raw.name.trim().slice(0, 60)})` : where;
  if (typeof raw.url !== 'string') return { ok: false, problem: `${label}: url must be a string` };
  if (raw.url.length > 8_192) return { ok: false, problem: `${label}: url is too long` };
  const methodRaw = typeof raw.method === 'string' ? raw.method.trim() : raw.method === undefined ? '*' : null;
  if (methodRaw === null || (methodRaw !== '*' && methodRaw !== '' && !METHOD_RE.test(methodRaw))) {
    return { ok: false, problem: `${label}: method must be '*' or an HTTP method` };
  }
  const match = raw.match ?? 'contains';
  if (typeof match !== 'string' || !(MATCH_TYPES as string[]).includes(match)) {
    return { ok: false, problem: `${label}: match must be one of ${MATCH_TYPES.join(', ')}` };
  }
  let apps: string[] | undefined;
  if (raw.apps !== undefined && raw.apps !== null) {
    if (!Array.isArray(raw.apps) || raw.apps.some((a) => typeof a !== 'string')) {
      return { ok: false, problem: `${label}: apps must be a list of app ids` };
    }
    apps = [...new Set((raw.apps as string[]).map((a) => a.trim()).filter(Boolean))];
  }
  const action = validateAction(raw.action, label);
  if (!action.ok) return action;
  const id = typeof raw.id === 'string' && raw.id.trim() && raw.id.length <= 200 ? raw.id.trim() : newMockRuleId();
  const createdAt = toNumber(raw.createdAt);
  const rule: MockRule = {
    id,
    enabled: toBoolean(raw.enabled) ?? true,
    method: methodRaw === '' || methodRaw === '*' ? '*' : methodRaw.toUpperCase(),
    url: raw.url,
    match: match as UrlMatchType,
    action: action.action,
    createdAt: createdAt !== undefined && createdAt > 0 ? createdAt : now,
  };
  const name = optionalString(raw.name, 200);
  if (name) rule.name = name;
  if (apps && apps.length > 0) rule.apps = apps;
  return { ok: true, rule };
}

/** Validate a rule list. Valid rules are kept (duplicate ids get a fresh id); `problems` lists the rest. */
export function validateMockRules(raw: unknown, now = Date.now()): { rules: MockRule[]; problems: string[] } {
  if (!Array.isArray(raw)) return { rules: [], problems: ['mock rules must be a list'] };
  const problems: string[] = [];
  if (raw.length > MAX_MOCK_RULES) problems.push(`too many mock rules (${raw.length}); at most ${MAX_MOCK_RULES}`);
  const rules: MockRule[] = [];
  const seen = new Set<string>();
  raw.slice(0, MAX_MOCK_RULES).forEach((item, index) => {
    const r = validateMockRule(item, index, now);
    if (!r.ok) {
      problems.push(r.problem);
      return;
    }
    const rule = seen.has(r.rule.id) ? { ...r.rule, id: newMockRuleId() } : r.rule;
    seen.add(rule.id);
    rules.push(rule);
  });
  return { rules, problems };
}

/* ────────────────────────────── file helpers ────────────────────────────── */

/** Write a file atomically: temp file in the same directory → fsync → rename. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(tmp, 'w', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Remove entries (files or folders) of `dir` whose mtime is older than `maxAgeMs`. Returns the count. */
export async function cleanTempDir(dir: string, maxAgeMs = TEMP_MAX_AGE_MS, now = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = await fsp.lstat(p);
      if (now - st.mtimeMs > maxAgeMs) {
        await fsp.rm(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Raced with another remover or permission problem: leave it.
    }
  }
  return removed;
}

/** Leftovers of interrupted atomic writes (".settings.json.<pid>.<hex>.tmp") older than a minute. */
async function removeStaleWriteTemps(dataDir: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dataDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/^\.(settings|mocks)\.json\.\d+\.[0-9a-f]+\.tmp$/.test(name)) continue;
    const p = path.join(dataDir, name);
    try {
      const st = await fsp.lstat(p);
      if (now - st.mtimeMs > 60_000) await fsp.rm(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

type ReadJsonResult = { kind: 'missing' } | { kind: 'ok'; value: unknown } | { kind: 'corrupt'; error: string };

async function readJsonFile(file: string): Promise<ReadJsonResult> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupt', error: (err as Error).message };
  }
  if (text.trim() === '') return { kind: 'missing' };
  try {
    return { kind: 'ok', value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    return { kind: 'corrupt', error: (err as Error).message };
  }
}

/** Keep a copy of an unreadable file so the next save does not silently destroy the user's edits. */
async function backupCorrupt(file: string, now: number): Promise<string | undefined> {
  const backup = `${file}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  try {
    await fsp.copyFile(file, backup);
    return backup;
  } catch {
    return undefined;
  }
}

/* ────────────────────────────── store ────────────────────────────── */

export interface SettingsUpdateResult {
  /** New effective settings. */
  settings: ServerSettings;
  /** Keys whose effective value changed. */
  changed: SettingsKey[];
  /** Human-readable notes about clamped/normalized values. */
  adjusted: string[];
  /** Unknown keys in the patch (ignored). */
  ignored: string[];
}

export interface ConfigStore {
  readonly dataDir: string;
  readonly tempDir: string;
  readonly settingsPath: string;
  readonly mocksPath: string;
  /** Effective settings: stored settings with the per-run LAN override (CLI --lan) applied. */
  readonly settings: ServerSettings;
  /** Settings as persisted (merged over the defaults). */
  readonly storedSettings: ServerSettings;
  readonly mocks: MockRule[];
  /** Problems found while loading (corrupt files, invalid values). */
  readonly warnings: string[];
  /** Validate, apply and persist a partial settings object. Throws ConfigValidationError on type errors. */
  updateSettings(patch: unknown): SettingsUpdateResult;
  /** Validate and persist the full mock rule list. Throws ConfigValidationError when any rule is invalid. */
  setMocks(rules: unknown): MockRule[];
  onSettings(listener: (settings: ServerSettings, previous: ServerSettings) => void): () => void;
  onMocks(listener: (rules: MockRule[]) => void): () => void;
  onWriteError(listener: (error: Error, file: string) => void): () => void;
  /** Resolves when every queued write has finished. */
  flush(): Promise<void>;
}

export interface LoadConfigOptions {
  /** CLI --lan / --no-lan: overrides settings.allowLan for this run until the user changes it. */
  lanOverride?: boolean;
  logger?: Logger;
  /** Remove temp entries older than 24 h (default true). */
  cleanTemp?: boolean;
  now?: () => number;
}

class FileConfigStore implements ConfigStore {
  readonly settingsPath: string;
  readonly mocksPath: string;
  private stored: ServerSettings;
  private effective: ServerSettings;
  private rules: MockRule[];
  private readonly explicitKeys: Set<SettingsKey>;
  private lanOverride: boolean | undefined;
  private readonly settingsListeners = new Set<(s: ServerSettings, prev: ServerSettings) => void>();
  private readonly mocksListeners = new Set<(rules: MockRule[]) => void>();
  private readonly errorListeners = new Set<(error: Error, file: string) => void>();
  private writeQueue: Promise<void> = Promise.resolve();
  private settingsDirty = false;
  private mocksDirty = false;

  constructor(
    readonly dataDir: string,
    readonly tempDir: string,
    init: { stored: ServerSettings; explicitKeys: SettingsKey[]; rules: MockRule[]; lanOverride?: boolean },
    readonly warnings: string[],
    private readonly logger: Logger,
  ) {
    this.settingsPath = path.join(dataDir, SETTINGS_FILE);
    this.mocksPath = path.join(dataDir, MOCKS_FILE);
    this.stored = init.stored;
    this.explicitKeys = new Set(init.explicitKeys);
    this.rules = init.rules;
    this.lanOverride = init.lanOverride;
    this.effective = this.computeEffective();
  }

  get settings(): ServerSettings {
    return this.effective;
  }

  get storedSettings(): ServerSettings {
    return this.stored;
  }

  get mocks(): MockRule[] {
    return this.rules;
  }

  private computeEffective(): ServerSettings {
    if (this.lanOverride === undefined || this.lanOverride === this.stored.allowLan) return this.stored;
    return { ...this.stored, allowLan: this.lanOverride };
  }

  updateSettings(patch: unknown): SettingsUpdateResult {
    const v = validateSettingsPatch(patch);
    if (v.problems.length > 0) {
      throw new ConfigValidationError(`Invalid settings: ${v.problems.join('; ')}`, v.problems);
    }
    const previous = this.effective;
    const next: ServerSettings = { ...this.stored };
    let storedChanged = false;
    for (const key of v.keys) {
      const value = (v.values as Record<string, unknown>)[key];
      if (key === 'allowLan') {
        // Re-sending the value currently in effect (e.g. the UI echoing settings) must not persist a CLI --lan override.
        if (value === previous.allowLan) continue;
        this.lanOverride = undefined;
      }
      if (!sameValue((next as unknown as Record<string, unknown>)[key], value) || !this.explicitKeys.has(key)) storedChanged = true;
      if (value === undefined) {
        delete (next as unknown as Record<string, unknown>)[key];
        this.explicitKeys.delete(key);
      } else {
        (next as unknown as Record<string, unknown>)[key] = value;
        this.explicitKeys.add(key);
      }
    }
    this.stored = next;
    this.effective = this.computeEffective();
    const changed = SETTINGS_KEYS.filter((k) => !sameValue(previous[k], this.effective[k]));
    if (storedChanged) this.scheduleWrite('settings');
    if (changed.length > 0) this.emitSettings(previous);
    return { settings: this.effective, changed, adjusted: v.adjusted, ignored: v.unknown };
  }

  setMocks(raw: unknown): MockRule[] {
    const { rules, problems } = validateMockRules(raw);
    if (problems.length > 0) {
      throw new ConfigValidationError(`Invalid mock rules: ${problems.join('; ')}`, problems);
    }
    this.rules = rules;
    this.scheduleWrite('mocks');
    for (const l of this.mocksListeners) {
      try {
        l(rules);
      } catch (err) {
        this.logger.error('mocks listener failed', err);
      }
    }
    return rules;
  }

  onSettings(listener: (settings: ServerSettings, previous: ServerSettings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  onMocks(listener: (rules: MockRule[]) => void): () => void {
    this.mocksListeners.add(listener);
    return () => this.mocksListeners.delete(listener);
  }

  onWriteError(listener: (error: Error, file: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private emitSettings(previous: ServerSettings): void {
    for (const l of this.settingsListeners) {
      try {
        l(this.effective, previous);
      } catch (err) {
        this.logger.error('settings listener failed', err);
      }
    }
  }

  private serializeSettings(): string {
    const out: Record<string, unknown> = {};
    for (const k of SETTINGS_KEYS) {
      const value = this.stored[k];
      if (this.explicitKeys.has(k) && value !== undefined) out[k] = value;
    }
    return JSON.stringify(out, null, 2) + '\n';
  }

  private scheduleWrite(kind: 'settings' | 'mocks'): void {
    if (kind === 'settings') this.settingsDirty = true;
    else this.mocksDirty = true;
    this.writeQueue = this.writeQueue.then(() => this.writePending());
  }

  /** Writes the latest state of every dirty file; never rejects (errors go to listeners + log). */
  private async writePending(): Promise<void> {
    if (this.settingsDirty) {
      this.settingsDirty = false;
      await this.safeWrite(this.settingsPath, this.serializeSettings());
    }
    if (this.mocksDirty) {
      this.mocksDirty = false;
      await this.safeWrite(this.mocksPath, JSON.stringify(this.rules, null, 2) + '\n');
    }
  }

  private async safeWrite(file: string, data: string): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, data);
    } catch (err) {
      this.logger.error(`could not write ${file}: ${(err as Error).message}`);
      for (const l of this.errorListeners) {
        try {
          l(err as Error, file);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

async function ensureWritableDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.access(dir, fsConstants.W_OK);
}

/**
 * Load settings.json + mocks.json from `dataDir` (created when missing). Never throws for bad file contents;
 * throws only when neither the data directory nor a fallback temp directory can be created.
 */
export async function loadConfig(dataDirInput: string, opts: LoadConfigOptions = {}): Promise<ConfigStore> {
  const logger = opts.logger ?? silentLogger;
  const now = opts.now ?? Date.now;
  const warnings: string[] = [];

  let dataDir = path.resolve(expandHome(dataDirInput || defaultDataDir()));
  try {
    await ensureWritableDir(dataDir);
  } catch (err) {
    let user = 'user';
    try {
      user = os.userInfo().username || user;
    } catch {
      /* no passwd entry (containers) */
    }
    const fallback = path.join(os.tmpdir(), `durbun-${user}`);
    warnings.push(`data directory ${dataDir} is not writable (${(err as Error).message}); using ${fallback} for this run`);
    dataDir = fallback;
    await ensureWritableDir(dataDir);
  }

  const settingsPath = path.join(dataDir, SETTINGS_FILE);
  const mocksPath = path.join(dataDir, MOCKS_FILE);

  let stored: ServerSettings = { ...DEFAULT_SETTINGS, watchedApps: [...DEFAULT_SETTINGS.watchedApps] };
  let explicitKeys: SettingsKey[] = [];
  const settingsFile = await readJsonFile(settingsPath);
  if (settingsFile.kind === 'ok') {
    if (isPlainObject(settingsFile.value)) {
      const normalized = normalizeSettings(settingsFile.value);
      stored = normalized.settings;
      explicitKeys = normalized.keys;
      warnings.push(...normalized.warnings.map((w) => `${SETTINGS_FILE}: ${w}`));
    } else {
      warnings.push(`${SETTINGS_FILE}: expected an object — using defaults`);
    }
  } else if (settingsFile.kind === 'corrupt') {
    const backup = await backupCorrupt(settingsPath, now());
    warnings.push(`${SETTINGS_FILE} could not be read (${settingsFile.error}) — using defaults${backup ? `; copy kept at ${backup}` : ''}`);
  }

  let rules: MockRule[] = [];
  const mocksFile = await readJsonFile(mocksPath);
  if (mocksFile.kind === 'ok') {
    const validated = validateMockRules(mocksFile.value, now());
    rules = validated.rules;
    warnings.push(...validated.problems.map((p) => `${MOCKS_FILE}: ${p} — rule skipped`));
  } else if (mocksFile.kind === 'corrupt') {
    const backup = await backupCorrupt(mocksPath, now());
    warnings.push(`${MOCKS_FILE} could not be read (${mocksFile.error}) — starting without mock rules${backup ? `; copy kept at ${backup}` : ''}`);
  }

  let tempDir = path.join(dataDir, TEMP_DIR_NAME);
  try {
    await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });
    if (opts.cleanTemp !== false) {
      const removed = await cleanTempDir(tempDir, TEMP_MAX_AGE_MS, now());
      if (removed > 0) logger.debug(`removed ${removed} temp entr${removed === 1 ? 'y' : 'ies'} older than 24 h`);
    }
  } catch (err) {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'durbun-tmp-'));
    warnings.push(`temp directory could not be created (${(err as Error).message}); using ${tempDir}`);
  }
  await removeStaleWriteTemps(dataDir, now());

  for (const w of warnings) logger.warn(w);
  return new FileConfigStore(dataDir, tempDir, { stored, explicitKeys, rules, lanOverride: opts.lanOverride }, warnings, logger);
}
