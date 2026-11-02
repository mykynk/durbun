/**
 * Converts arbitrary app values into bounded, JSON-serializable snapshots: cycles, BigInt, Errors,
 * Maps/Sets, React elements, DOM nodes, getters that throw and giant graphs never break (or stall)
 * the host app. Snapshots are taken at log time, so later mutations of the object do not leak in.
 */
import type { ErrorInfo } from './protocol.js';
import { g, type AnyRecord } from './util.js';

export interface SafeLimits {
  maxDepth: number;
  maxNodes: number;
  maxArrayItems: number;
  maxKeys: number;
  maxStringLength: number;
}

export const DEFAULT_LIMITS: SafeLimits = {
  maxDepth: 10,
  maxNodes: 10_000,
  maxArrayItems: 1_000,
  maxKeys: 500,
  maxStringLength: 100_000,
};

export function isErrorLike(v: unknown): v is { name?: string; message: string; stack?: string } {
  if (!v || typeof v !== 'object') return false;
  if (v instanceof Error) return true;
  const e = v as AnyRecord;
  return typeof e.message === 'string' && (typeof e.stack === 'string' || (typeof e.name === 'string' && /Error$/.test(e.name)));
}

function safeGet(obj: AnyRecord, key: string): unknown {
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

/** `{ type, message, stack }` for anything thrown or logged as an error (`cause` chains are appended to the stack). */
export function errorInfo(err: unknown): ErrorInfo {
  return errorInfoAt(err, []);
}

function errorInfoAt(err: unknown, seen: unknown[]): ErrorInfo {
  if (isErrorLike(err)) {
    const info: ErrorInfo = {};
    const name = safeGet(err as AnyRecord, 'name');
    const ctor = safeGet(err as AnyRecord, 'constructor') as AnyRecord | undefined;
    info.type = typeof name === 'string' && name ? name : ctor && typeof ctor.name === 'string' && ctor.name ? ctor.name : 'Error';
    info.message = previewPrimitive(safeGet(err as AnyRecord, 'message') ?? '');
    const stack = safeGet(err as AnyRecord, 'stack');
    if (typeof stack === 'string' && stack) info.stack = stack;
    const cause = safeGet(err as AnyRecord, 'cause');
    if (cause !== undefined && cause !== null && cause !== err && seen.length < 5 && seen.indexOf(cause) < 0) {
      seen.push(err);
      const c = isErrorLike(cause) ? errorInfoAt(cause, seen) : { message: previewValue(cause, 500) };
      const causeText = `Caused by: ${c.type ? c.type + ': ' : ''}${c.message ?? ''}${c.stack ? '\n' + stripFirstLine(c.stack) : ''}`;
      info.stack = info.stack ? `${info.stack}\n${causeText}` : causeText;
    }
    return info;
  }
  return { type: typeof err === 'object' && err !== null ? 'Object' : typeof err, message: previewValue(err, 2000) };
}

function stripFirstLine(stack: string): string {
  const nl = stack.indexOf('\n');
  return nl >= 0 ? stack.slice(nl + 1) : '';
}

function previewPrimitive(v: unknown): string {
  try {
    return typeof v === 'string' ? v : String(v);
  } catch {
    return '[Unprintable]';
  }
}

function typeName(v: unknown): string {
  if (typeof v === 'function') return (v as AnyRecord).displayName || (v as AnyRecord).name || 'Anonymous';
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const t = v as AnyRecord;
    if (typeof t.displayName === 'string') return t.displayName;
    if (t.render && typeof t.render === 'function') return typeName(t.render);
    if (t.type) return typeName(t.type);
  }
  return 'Unknown';
}

function constructorName(v: object): string {
  try {
    const proto = Object.getPrototypeOf(v);
    if (!proto) return 'Object';
    const ctor = proto.constructor;
    return ctor && typeof ctor.name === 'string' && ctor.name ? ctor.name : 'Object';
  } catch {
    return 'Object';
  }
}

interface Ctx {
  limits: SafeLimits;
  nodes: number;
  ancestors: unknown[];
}

function convert(v: unknown, depth: number, ctx: Ctx): unknown {
  switch (typeof v) {
    case 'string':
      return v.length > ctx.limits.maxStringLength ? v.slice(0, ctx.limits.maxStringLength) + `… (${v.length} chars)` : v;
    case 'number':
      return isFinite(v) ? v : String(v);
    case 'boolean':
      return v;
    case 'undefined':
      return undefined;
    case 'bigint':
      return `${String(v)}n`;
    case 'symbol':
      return previewPrimitive(v);
    case 'function':
      return `[Function: ${(v as AnyRecord).name || 'anonymous'}]`;
    default:
      break;
  }
  if (v === null) return null;
  const obj = v as AnyRecord;
  if (ctx.ancestors.indexOf(obj) >= 0) return '[Circular]';
  if (++ctx.nodes > ctx.limits.maxNodes) return '[…]';
  try {
    if (isErrorLike(obj)) {
      const info = errorInfo(obj);
      const out: AnyRecord = { name: info.type, message: info.message };
      if (info.stack) out.stack = info.stack;
      ctx.ancestors.push(obj);
      try {
        for (const key of Object.keys(obj)) {
          if (key === 'name' || key === 'message' || key === 'stack') continue;
          const converted = depth + 1 > ctx.limits.maxDepth ? '[…]' : convert(safeGet(obj, key), depth + 1, ctx);
          if (converted !== undefined) out[key] = converted;
        }
      } finally {
        ctx.ancestors.pop();
      }
      return out;
    }
    if (obj instanceof Date) return isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (obj instanceof RegExp) return String(obj);
    const $$typeof = obj.$$typeof;
    if (typeof $$typeof === 'symbol') {
      return `[React ${(($$typeof as symbol).toString().match(/react\.([a-z_.]+)/) || ['', 'element'])[1]}: ${typeName(obj.type)}]`;
    }
    if (obj._reactInternals || obj._reactInternalFiber) return `[React component: ${constructorName(obj)}]`;
    if (typeof obj.nodeType === 'number' && typeof obj.nodeName === 'string') {
      const id = typeof obj.id === 'string' && obj.id ? `#${obj.id}` : '';
      return `<${String(obj.nodeName).toLowerCase()}${id}>`;
    }
    if (typeof ArrayBuffer !== 'undefined') {
      if (obj instanceof ArrayBuffer) return `[ArrayBuffer(${obj.byteLength})]`;
      if (ArrayBuffer.isView(obj)) return `[${constructorName(obj)}(${(obj as AnyRecord).length ?? obj.byteLength})]`;
    }
    const BlobCtor = g.Blob;
    if (typeof BlobCtor === 'function' && obj instanceof BlobCtor) {
      return `[Blob ${obj.type || 'application/octet-stream'} · ${obj.size} bytes]`;
    }
    if (typeof Promise !== 'undefined' && obj instanceof Promise) return '[Promise]';
    if (typeof WeakMap !== 'undefined' && obj instanceof WeakMap) return '[WeakMap]';
    if (typeof WeakSet !== 'undefined' && obj instanceof WeakSet) return '[WeakSet]';
    if (depth >= ctx.limits.maxDepth) {
      return Array.isArray(obj) ? `[Array(${obj.length})]` : `[${constructorName(obj)}]`;
    }
    if (typeof obj.toJSON === 'function' && !Array.isArray(obj)) {
      let json: unknown = obj;
      try {
        json = obj.toJSON();
      } catch {
        json = obj;
      }
      if (json !== obj) {
        ctx.ancestors.push(obj);
        try {
          return convert(json, depth, ctx);
        } finally {
          ctx.ancestors.pop();
        }
      }
    }
    ctx.ancestors.push(obj);
    try {
      if (Array.isArray(obj)) return convertList(obj, obj.length, depth, ctx);
      if (typeof Map !== 'undefined' && obj instanceof Map) {
        const simpleKeys = Array.from(obj.keys()).every((k) => typeof k === 'string' || typeof k === 'number');
        if (simpleKeys) {
          const out: AnyRecord = {};
          let n = 0;
          obj.forEach((value: unknown, key: unknown) => {
            if (n++ >= ctx.limits.maxKeys) return;
            const converted = convert(value, depth + 1, ctx);
            if (converted !== undefined) out[String(key)] = converted;
          });
          if (obj.size > ctx.limits.maxKeys) out['…'] = `${obj.size - ctx.limits.maxKeys} more entries`;
          return out;
        }
        return convertList(Array.from(obj.entries()), obj.size, depth, ctx);
      }
      if (typeof Set !== 'undefined' && obj instanceof Set) return convertList(Array.from(obj.values()), obj.size, depth, ctx);
      const out: AnyRecord = {};
      const keys = Object.keys(obj);
      const limit = Math.min(keys.length, ctx.limits.maxKeys);
      for (let i = 0; i < limit; i++) {
        const key = keys[i];
        let value: unknown;
        try {
          value = obj[key];
        } catch (e) {
          value = `[Getter threw: ${e && typeof e === 'object' && 'message' in e ? String((e as AnyRecord).message) : String(e)}]`;
        }
        const converted = convert(value, depth + 1, ctx);
        if (converted !== undefined) out[key] = converted;
      }
      if (keys.length > limit) out['…'] = `${keys.length - limit} more keys`;
      return out;
    } finally {
      ctx.ancestors.pop();
    }
  } catch {
    return '[Unserializable]';
  }
}

function convertList(list: ArrayLike<unknown>, total: number, depth: number, ctx: Ctx): unknown[] {
  const limit = Math.min(list.length, ctx.limits.maxArrayItems);
  const out: unknown[] = new Array(limit);
  for (let i = 0; i < limit; i++) {
    let item: unknown;
    try {
      item = list[i];
    } catch {
      item = '[Getter threw]';
    }
    const converted = convert(item, depth + 1, ctx);
    out[i] = converted === undefined ? null : converted;
  }
  if (total > limit) out.push(`… ${total - limit} more items`);
  return out;
}

/** JSON-safe deep snapshot of `value` (see module doc). */
export function toJsonSafe(value: unknown, limits: Partial<SafeLimits> = {}): unknown {
  const ctx: Ctx = { limits: { ...DEFAULT_LIMITS, ...limits }, nodes: 0, ancestors: [] };
  return convert(value, 0, ctx);
}

const PREVIEW_LIMITS: Partial<SafeLimits> = { maxDepth: 6, maxNodes: 500, maxArrayItems: 100, maxKeys: 100, maxStringLength: 2_000 };

/** Compact one-line rendering used inside log messages (`{"id":1,"name":"Ali"}`), capped at `maxChars`. */
export function previewValue(value: unknown, maxChars = 1_000): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === undefined) text = 'undefined';
  else {
    const safe = toJsonSafe(value, PREVIEW_LIMITS);
    if (typeof safe === 'string') text = safe;
    else {
      try {
        text = JSON.stringify(safe) ?? String(safe);
      } catch {
        text = '[Unserializable]';
      }
    }
  }
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}
