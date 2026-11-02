import type { AnyRecord } from './util.js';

export interface Patch {
  /** Disables the wrapper and restores the original when nobody wrapped it after us. */
  restore(): void;
}

/**
 * Replaces `target[key]` with a wrapper built from the original. The wrapper receives `isActive()`; after
 * `restore()` it must behave exactly like the original. If another library wrapped the method after us,
 * the original is not put back (that would remove their wrapper) — our wrapper just becomes a passthrough.
 * Returns undefined when the property cannot be replaced.
 */
export function patchMethod<F extends (...args: any[]) => any>(
  target: AnyRecord,
  key: string,
  make: (original: F, isActive: () => boolean) => F,
): Patch | undefined {
  let original: F;
  try {
    original = target[key];
  } catch {
    return undefined;
  }
  if (typeof original !== 'function') return undefined;
  let active = true;
  const wrapper = make(original, () => active);
  try {
    (wrapper as AnyRecord).__durbunOriginal = original;
  } catch {
    // frozen function objects: fine
  }
  if (!assign(target, key, wrapper)) return undefined;
  return {
    restore() {
      active = false;
      try {
        if (target[key] === wrapper) assign(target, key, original);
      } catch {
        // ignore
      }
    },
  };
}

function assign(target: AnyRecord, key: string, value: unknown): boolean {
  try {
    target[key] = value;
    if (target[key] === value) return true;
  } catch {
    // fall back to defineProperty below
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (desc && desc.configurable === false) return false;
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: desc ? desc.enumerable : true });
    return target[key] === value;
  } catch {
    return false;
  }
}

export function restoreAll(patches: Array<Patch | undefined>): void {
  for (let i = patches.length - 1; i >= 0; i--) {
    try {
      patches[i]?.restore();
    } catch {
      // ignore
    }
  }
}
