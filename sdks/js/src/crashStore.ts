/**
 * Keeps the last fatal JS error until the desktop has it. A fatal error usually ends the process before the
 * socket sends it (React Native release builds), so the report is also written to a small key-value store
 * and sent on the next launch as "Previous launch crashed — …" (same shape as the Android and iOS SDKs:
 * a `crash` log with `data.previousLaunch` and `data.crashedAt`).
 *
 * Stores, first available: the app's own `crashStorage` adapter (AsyncStorage, MMKV, …), then React Native's
 * `Settings` on iOS (the app's user defaults). Without one nothing is written. Everything is best effort:
 * a failing store is ignored.
 */
import type { Runtime } from './env.js';
import { loadReactNative } from './env.js';
import type { ErrorInfo, SdkLog } from './protocol.js';
import { isPromiseLike, type AnyRecord } from './util.js';

/** A key-value store with string values; sync or async (AsyncStorage, `localStorage`, a wrapped MMKV). */
export interface DurbunStorage {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

export const CRASH_STORAGE_KEY = 'durbun.pendingCrashes';
/** Crashes kept at most (the latest win). */
export const MAX_STORED_CRASHES = 3;
const MAX_MESSAGE = 2_000;
const MAX_STACK = 16_000;

export interface StoredCrash {
  ts: number;
  message: string;
  tag?: string;
  error?: ErrorInfo;
  data?: unknown;
}

function cap(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** The stored form of a crash log (bounded). */
export function toStoredCrash(log: SdkLog): StoredCrash {
  const out: StoredCrash = { ts: log.ts, message: cap(log.message, MAX_MESSAGE) || 'Crash' };
  if (log.tag) out.tag = log.tag;
  if (log.error) {
    const error: ErrorInfo = {};
    if (log.error.type) error.type = cap(log.error.type, 200);
    if (log.error.message) error.message = cap(log.error.message, MAX_MESSAGE);
    if (log.error.stack) error.stack = cap(log.error.stack, MAX_STACK);
    out.error = error;
  }
  if (log.data !== undefined) {
    try {
      const text = JSON.stringify(log.data);
      if (text && text.length <= 4_000) out.data = JSON.parse(text);
    } catch {
      // data left out
    }
  }
  return out;
}

/** The message sent on the next launch for a stored crash. */
export function previousLaunchLog(crash: StoredCrash): SdkLog {
  const data: AnyRecord = crash.data && typeof crash.data === 'object' && !Array.isArray(crash.data) ? { ...(crash.data as AnyRecord) } : {};
  data.previousLaunch = true;
  data.crashedAt = crash.ts;
  const msg: SdkLog = {
    type: 'log',
    ts: crash.ts,
    level: 'fatal',
    tag: crash.tag || 'uncaught',
    message: `Previous launch crashed — ${crash.message}`,
    data,
    kind: 'crash',
  };
  if (crash.error) msg.error = crash.error;
  return msg;
}

export function parseStoredCrashes(text: unknown): StoredCrash[] {
  if (typeof text !== 'string' || !text) return [];
  try {
    const parsed = JSON.parse(text) as AnyRecord;
    const list = parsed && Array.isArray(parsed.crashes) ? parsed.crashes : [];
    const out: StoredCrash[] = [];
    for (const c of list) {
      if (!c || typeof c !== 'object' || typeof c.ts !== 'number' || typeof c.message !== 'string') continue;
      const crash: StoredCrash = { ts: c.ts, message: cap(c.message, MAX_MESSAGE) as string };
      if (typeof c.tag === 'string') crash.tag = c.tag;
      if (c.error && typeof c.error === 'object') {
        const error: ErrorInfo = {};
        for (const k of ['type', 'message', 'stack'] as const) if (typeof c.error[k] === 'string') error[k] = cap(c.error[k], k === 'stack' ? MAX_STACK : MAX_MESSAGE);
        crash.error = error;
      }
      if (c.data !== undefined) crash.data = c.data;
      out.push(crash);
    }
    return out.slice(-MAX_STORED_CRASHES);
  } catch {
    return [];
  }
}

/** React Native's `Settings` (iOS user defaults; read synchronously, written in the background). */
function rnSettingsStorage(): DurbunStorage | undefined {
  const rn = loadReactNative();
  if (!rn) return undefined;
  try {
    const platform = rn.Platform as AnyRecord | undefined;
    const settings = rn.Settings as AnyRecord | undefined;
    if (!platform || platform.OS !== 'ios' || !settings || typeof settings.get !== 'function' || typeof settings.set !== 'function') return undefined;
    return {
      getItem: (key) => {
        const v = settings.get(key);
        return typeof v === 'string' ? v : null;
      },
      setItem: (key, value) => settings.set({ [key]: value }),
      removeItem: (key) => settings.set({ [key]: null }),
    };
  } catch {
    return undefined;
  }
}

function isStorage(v: unknown): v is DurbunStorage {
  return !!v && typeof v === 'object' && typeof (v as AnyRecord).getItem === 'function' && typeof (v as AnyRecord).setItem === 'function';
}

/** Swallows sync throws and async rejections of a store call. */
function settle<T>(fn: () => T | Promise<T>, onValue?: (value: T | undefined) => void): void {
  try {
    const result = fn();
    if (isPromiseLike<T>(result)) {
      result.then(
        (v) => onValue?.(v),
        () => onValue?.(undefined),
      );
    } else onValue?.(result);
  } catch {
    onValue?.(undefined);
  }
}

/** Pending crashes of this app: those read at start plus any fatal error of this launch, until delivered. */
export class CrashStore {
  private pending: StoredCrash[] = [];

  constructor(private readonly storage: DurbunStorage) {}

  static resolve(option: DurbunStorage | false | undefined, runtime: Runtime): CrashStore | undefined {
    if (option === false) return undefined;
    if (isStorage(option)) return new CrashStore(option);
    if (runtime === 'react-native') {
      const settings = rnSettingsStorage();
      if (settings) return new CrashStore(settings);
    }
    return undefined;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Reads crashes stored by an earlier launch (callback runs once, possibly synchronously). */
  load(onLoaded: (crashes: StoredCrash[]) => void): void {
    settle(
      () => this.storage.getItem(CRASH_STORAGE_KEY),
      (text) => {
        const crashes = parseStoredCrashes(text);
        if (crashes.length === 0) return;
        // A crash of this launch may already be pending: keep the order of events.
        this.pending = crashes.concat(this.pending).slice(-MAX_STORED_CRASHES);
        try {
          onLoaded(crashes);
        } catch {
          // ignore
        }
      },
    );
  }

  /** Writes a fatal error right away (the process may end as soon as this returns). */
  save(crash: StoredCrash): void {
    this.pending = this.pending.concat(crash).slice(-MAX_STORED_CRASHES);
    this.write();
  }

  /** Everything pending has reached the desktop: forget it. */
  delivered(): void {
    if (this.pending.length === 0) return;
    this.pending = [];
    const storage = this.storage;
    if (typeof storage.removeItem === 'function') settle(() => storage.removeItem!(CRASH_STORAGE_KEY));
    else settle(() => storage.setItem(CRASH_STORAGE_KEY, ''));
  }

  private write(): void {
    let text: string;
    try {
      text = JSON.stringify({ v: 1, crashes: this.pending });
    } catch {
      return;
    }
    settle(() => this.storage.setItem(CRASH_STORAGE_KEY, text));
  }
}
