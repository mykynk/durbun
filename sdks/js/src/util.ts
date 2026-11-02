/* Small runtime helpers shared by every module. Everything here must work on Hermes, browsers and Node. */

declare const global: unknown;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyRecord = Record<string, any>;

function resolveGlobal(): AnyRecord {
  if (typeof globalThis === 'object' && globalThis) return globalThis as unknown as AnyRecord;
  if (typeof global === 'object' && global) return global as AnyRecord;
  if (typeof self === 'object' && self) return self as unknown as AnyRecord;
  if (typeof window === 'object' && window) return window as unknown as AnyRecord;
  return {};
}

/** The global object of the current runtime (globalThis / global / self / window). */
export const g: AnyRecord = resolveGlobal();

export type TimerHandle = unknown;

/** setTimeout that never keeps a Node process alive (no-op difference on RN / browsers). */
export function setTimer(fn: () => void, ms: number): TimerHandle {
  const handle: any = g.setTimeout(fn, ms);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

export function clearTimer(handle: TimerHandle | undefined): void {
  if (handle !== undefined && handle !== null) g.clearTimeout(handle);
}

export function setRepeating(fn: () => void, ms: number): TimerHandle {
  const handle: any = g.setInterval(fn, ms);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

export function clearRepeating(handle: TimerHandle | undefined): void {
  if (handle !== undefined && handle !== null) g.clearInterval(handle);
}

/** Random alphanumeric id; uses crypto.getRandomValues when present. */
export function randomId(length = 20): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  const crypto = g.crypto;
  let filled = false;
  if (crypto && typeof crypto.getRandomValues === 'function') {
    try {
      crypto.getRandomValues(bytes);
      filled = true;
    } catch {
      filled = false;
    }
  }
  if (!filled) for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Runs `fn`, returning `fallback` when it throws (getters of foreign objects may throw). */
export function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function isPromiseLike<T = unknown>(v: unknown): v is PromiseLike<T> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as AnyRecord).then === 'function';
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as AnyRecord).message === 'string') return (err as AnyRecord).message;
  return attempt(() => String(err), 'Unknown error');
}

/** Resolves a possibly relative URL against the page location (web); returns the input when impossible. */
export function resolveUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const loc = g.location;
  const URLCtor = g.URL;
  if (loc && typeof loc.href === 'string' && typeof URLCtor === 'function') {
    try {
      const base = g.document && typeof g.document.baseURI === 'string' ? g.document.baseURI : loc.href;
      return new URLCtor(url, base).href;
    } catch {
      return url;
    }
  }
  return url;
}

/** Host part of an absolute URL (no URL constructor needed: Hermes' URL support is partial). */
export function hostOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
  return m ? m[1] : '';
}

/** Origin (`scheme://host[:port]`) of an absolute URL, lower-cased; '' when not absolute. */
export function originOfUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?[^/?#]*)/i.exec(url);
  return m ? m[1].replace(/\/\/[^@/?#]*@/, '//').toLowerCase() : '';
}

/** Query parameter lookup without relying on URLSearchParams (missing on old Hermes). */
export function queryParam(url: string, name: string): string | undefined {
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  const hashAt = url.indexOf('#', q);
  const query = url.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (safeDecode(key) === name) return eq < 0 ? '' : safeDecode(part.slice(eq + 1).replace(/\+/g, ' '));
  }
  return undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
