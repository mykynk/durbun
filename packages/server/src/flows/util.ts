/** Small helpers shared by the flow stores and the engine. */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { slugifyFlowId } from '@durbun/protocol';
import { writeFileAtomic } from '../config';

/** Read and parse a JSON file; undefined when it does not exist. Throws on invalid JSON. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text);
}

export async function writeJsonFile(file: string, value: unknown, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', mode);
}

/** Serializes async work (file writes) in call order; a failure does not block later work. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

/** Sortable, unique id: time in base 36 + random hex ("lq3k2d1a-4f9c2e"). */
export function timeId(now = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

export class AbortedError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError();
}

/** setTimeout as a promise that rejects with AbortError when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const isAbortError = (err: unknown): boolean => (err as { name?: string } | undefined)?.name === 'AbortError';

/**
 * `promise`, or an AbortError as soon as `signal` aborts. The promise keeps going in the background (its late
 * rejection is swallowed): a device action cannot be taken back, but the run does not wait for it.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new AbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Short stable hash (hex) of a text. */
export function shortHash(text: string, length = 8): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

export const MASK = '••••';

/**
 * The forms a secret takes on the way out: as typed, URL-encoded (query, path), form-encoded, base64 (`| base64`)
 * and JSON-escaped (inside a JSON body or a stringified value). Masking all of them keeps the secret out of
 * run records whichever way a step used it.
 */
export function expandSecrets(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 3) continue;
    out.add(s);
    out.add(encodeURIComponent(s));
    out.add(new URLSearchParams([['', s]]).toString().slice(1));
    const b64 = Buffer.from(s, 'utf8').toString('base64');
    out.add(b64);
    out.add(b64.replace(/=+$/, ''));
    out.add(JSON.stringify(s).slice(1, -1));
  }
  return [...out].filter((s) => s.length >= 3);
}

/** Replace every secret value in the strings of `value` with ••••. */
export function maskSecrets<T>(value: T, secrets: readonly string[]): T {
  const list = secrets.filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
  if (list.length === 0) return value;
  const maskText = (s: string) => {
    let out = s;
    for (const secret of list) if (out.includes(secret)) out = out.split(secret).join(MASK);
    return out;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return maskText(v);
    if (depth > 20) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
      return out;
    }
    return v;
  };
  return walk(value, 0) as T;
}

export const MAX_OUTPUT_TEXT = 20_000;
const MAX_OUTPUT_ITEMS = 200;
const MAX_OUTPUT_DEPTH = 10;

/** A copy of a step output small enough to keep in a run file and send to the UI. */
export function trimOutput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_OUTPUT_TEXT ? `${value.slice(0, MAX_OUTPUT_TEXT)}… (${value.length} characters)` : value;
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (depth >= MAX_OUTPUT_DEPTH) return '…';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_OUTPUT_ITEMS).map((v) => trimOutput(v, depth + 1));
    if (value.length > MAX_OUTPUT_ITEMS) items.push(`… ${value.length - MAX_OUTPUT_ITEMS} more`);
    return items;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, MAX_OUTPUT_ITEMS)) {
    if (typeof v === 'function' || v === undefined) continue;
    out[k] = trimOutput(v, depth + 1);
  }
  if (entries.length > MAX_OUTPUT_ITEMS) out['…'] = `${entries.length - MAX_OUTPUT_ITEMS} more`;
  return out;
}

/**
 * What a run record keeps of a step output: trimmed, and without `bodyText` when `body` holds the parsed JSON (the
 * same data twice). Templates still read the full output during the run.
 */
export function storedOutput(value: unknown): unknown {
  return trimOutput(dropParsedText(value));
}

function dropParsedText(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  let out = o;
  if (typeof o.bodyText === 'string' && o.body !== undefined && o.body !== null && typeof o.body !== 'string') {
    out = { ...o };
    delete out.bodyText;
  }
  if (o.request && typeof o.request === 'object') {
    const req = dropParsedText(o.request);
    if (req !== o.request) out = { ...out, request: req };
  }
  return out;
}

/** Characters of a value as JSON (0 when it cannot be written). */
export function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** "a" for 'a', a short JSON for other values (summaries, error texts). */
export function shortText(value: unknown, max = 120): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else if (value === undefined) s = 'undefined';
  else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** File-name-safe text ("Ödeme sonrası" → "Odeme_sonrasi"). */
export function safeFileName(name: string, fallback = 'file'): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/\.{2,}/g, '.') // ".." is refused when the file is served
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

/** Id from a name, with the flow id rules (a-z, 0-9, -, _). */
export function slugId(name: string): string {
  return slugifyFlowId(name);
}
