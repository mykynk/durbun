import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { registerShortcut, type ShortcutHandler, type ShortcutOptions } from '../lib/shortcuts';
import { registerCommands, type PaletteCommand } from '../lib/commands';
import { readStorage, writeStorage } from '../lib/persist';

/** Stable function identity that always calls the latest `fn`. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * Global keyboard shortcut while the component is mounted.
 *   useShortcut('Mod+K', () => openPalette())
 *   useShortcut(['ArrowDown', 'J'], next, { allowRepeat: true })
 *   useShortcut('Space', togglePause, { enabled: active })
 * See `ShortcutOptions` for input/modal/repeat behavior. Return `false` from the handler to pass.
 */
export function useShortcut(combo: string | readonly string[], handler: ShortcutHandler, opts: ShortcutOptions = {}): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = typeof combo === 'string' ? combo : combo.join('|');
  const { enabled, allowInInputs, allowInModal, allowRepeat, preventDefault, priority } = opts;
  useEffect(() => {
    const combos = key.split('|');
    const reg = registerShortcut(combos, (e) => handlerRef.current(e), {
      enabled,
      allowInInputs,
      allowInModal,
      allowRepeat,
      preventDefault,
      priority,
    });
    return () => reg.dispose();
  }, [key, enabled, allowInInputs, allowInModal, allowRepeat, preventDefault, priority]);
}

/**
 * Register command palette commands while mounted. The palette reads the latest array each time it
 * opens, so pass fresh closures freely (no memoization needed).
 */
export function useCommands(commands: readonly PaletteCommand[]): void {
  const ref = useRef(commands);
  ref.current = commands;
  useEffect(() => registerCommands(() => ref.current), []);
}

/** `useState` persisted to localStorage (`durbun.state.<key>`); never throws on storage errors. */
export function usePersistentState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const storageKey = `state.${key}`;
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === 'function' ? (initial as () => T)() : initial;
    return readStorage<T>(storageKey, fallback);
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    writeStorage(storageKey, value);
  }, [storageKey, value]);
  return [value, setValue];
}

/** Element size via ResizeObserver (0×0 until measured). */
export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** `window.matchMedia` as state. */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Calls `onOutside` for pointer downs outside all given elements. */
export function useOutsidePointerDown(refs: RefObject<HTMLElement | null>[], onOutside: (e: PointerEvent) => void, enabled = true): void {
  const cb = useEvent(onOutside);
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (refs.some((r) => r.current && t && r.current.contains(t))) return;
      cb(e);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
    // refs are stable RefObjects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cb]);
}
