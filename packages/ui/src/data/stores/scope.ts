import { create } from 'zustand';
import { readStorage, writeStorage } from '../../lib/persist';

/**
 * What the whole UI is focused on (sidebar selection).
 * - `all`: everything
 * - `device`: one device (its device logs, its apps, their traffic)
 * - `app`: an app on a device. By default the scope covers ALL sessions of that app (same device +
 *   bundle id: relaunches, hot restarts); `exact: true` narrows it to the one session `appId`.
 */
export type Scope = { kind: 'all' } | { kind: 'device'; deviceId: string } | { kind: 'app'; appId: string; exact?: boolean };

export const ALL_SCOPE: Scope = { kind: 'all' };

/** Extra identity kept for app scopes so a stale session id can be re-resolved after a server restart. */
export interface ScopeHint {
  deviceId?: string;
  bundleId?: string;
}

interface ScopeState {
  scope: Scope;
  hint: ScopeHint;
}

interface PersistedScope {
  scope: Scope;
  hint?: ScopeHint;
}

function loadScope(): ScopeState {
  const raw = readStorage<PersistedScope | null>('scope.v1', null);
  const s = raw?.scope;
  if (s && typeof s === 'object') {
    if (s.kind === 'device' && typeof s.deviceId === 'string') return { scope: { kind: 'device', deviceId: s.deviceId }, hint: {} };
    if (s.kind === 'app' && typeof s.appId === 'string')
      return { scope: { kind: 'app', appId: s.appId, exact: s.exact === true || undefined }, hint: raw?.hint ?? {} };
  }
  return { scope: ALL_SCOPE, hint: {} };
}

export const useScopeStore = create<ScopeState>()(() => loadScope());

useScopeStore.subscribe((s) => writeStorage('scope.v1', { scope: s.scope, hint: s.hint } satisfies PersistedScope));

export function useScope(): Scope {
  return useScopeStore((s) => s.scope);
}

export function getScope(): Scope {
  return useScopeStore.getState().scope;
}

export function setScope(scope: Scope, hint: ScopeHint = {}): void {
  const cur = useScopeStore.getState();
  if (scopeEquals(cur.scope, scope) && cur.hint.bundleId === hint.bundleId && cur.hint.deviceId === hint.deviceId) return;
  useScopeStore.setState({ scope, hint });
}

export function scopeEquals(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'device' && b.kind === 'device') return a.deviceId === b.deviceId;
  if (a.kind === 'app' && b.kind === 'app') return a.appId === b.appId && Boolean(a.exact) === Boolean(b.exact);
  return true;
}
