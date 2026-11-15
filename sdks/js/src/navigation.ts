/**
 * Screen changes as `navigation` events, from a React Navigation container ref (Expo Router's
 * `useNavigationContainerRef()` returns the same kind of ref). Route params are never sent: they often
 * carry ids, tokens or personal data.
 */

interface RouteLike {
  name?: unknown;
  key?: unknown;
}

/** The parts of React Navigation's `NavigationContainerRef` this uses. */
export interface NavigationContainerRefLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- React Navigation's typed listener must fit.
  addListener?(event: 'state', callback: (...args: any[]) => void): unknown;
  getCurrentRoute?(): unknown;
  isReady?(): boolean;
  /** A `useRef()` / `createRef()` holder whose `current` is the container ref. */
  current?: unknown;
}

type Emit = (name: string, props: Record<string, unknown>) => void;

function containerOf(ref: NavigationContainerRefLike | undefined | null): NavigationContainerRefLike | undefined {
  if (!ref || (typeof ref !== 'object' && typeof ref !== 'function')) return undefined;
  if (typeof ref.addListener === 'function') return ref;
  const inner = ref.current as NavigationContainerRefLike | undefined | null;
  if (inner && typeof inner.addListener === 'function') return inner;
  return undefined;
}

export function trackNavigation(ref: NavigationContainerRefLike, emit: Emit): () => void {
  const nav = containerOf(ref);
  if (!nav) return () => undefined;
  let lastKey: string | undefined;
  let lastName: string | undefined;
  let stopped = false;

  const check = () => {
    if (stopped) return;
    try {
      if (typeof nav.isReady === 'function' && !nav.isReady()) return;
      const route = (typeof nav.getCurrentRoute === 'function' ? nav.getCurrentRoute() : undefined) as RouteLike | undefined;
      if (!route || typeof route.name !== 'string') return;
      const key = typeof route.key === 'string' ? route.key : route.name;
      if (key === lastKey) return;
      const from = lastName;
      lastKey = key;
      lastName = route.name;
      emit('navigation', from !== undefined ? { from, to: route.name } : { to: route.name });
    } catch {
      // never throw into navigation
    }
  };

  let unsubscribe: unknown;
  try {
    unsubscribe = nav.addListener?.('state', check);
  } catch {
    return () => undefined;
  }
  check();
  return () => {
    stopped = true;
    try {
      if (typeof unsubscribe === 'function') unsubscribe();
    } catch {
      // ignore
    }
  };
}
