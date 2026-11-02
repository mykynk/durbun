import { useMemo } from 'react';
import type { AppSession, DeviceInfo, LogEntry, NetworkEntry } from '@durbun/protocol';
import { appGroupKey, useHub, type HubState } from './stores/hub';
import { useScope, type Scope } from './stores/scope';
import { emptyLogCounts, type LogCounts, type LogStore } from './logStore';
import { emptyNetworkCounts, type NetworkCounts, type NetworkStore } from './networkStore';

/** Minimal shape of a metric series for scope checks. */
export interface ScopeSeriesRef {
  deviceId: string;
  appId?: string;
  pid?: number;
}

/**
 * A scope resolved against the current devices/apps, with fast predicates. Build it once per
 * render with `useCompiledScope()` (or `compileScope`) and call the predicates per entry.
 */
export interface CompiledScope {
  scope: Scope;
  /** Device the scope is on (device and app scopes). */
  deviceId?: string;
  /** App scope: session ids covered (all sessions of the app group, or one when exact). */
  appIds?: ReadonlySet<string>;
  /** App scope: the selected session. */
  app?: AppSession;
  logs(e: LogEntry): boolean;
  network(e: NetworkEntry): boolean;
  metrics(s: ScopeSeriesRef): boolean;
}

type HubLike = Pick<HubState, 'apps'>;

const always = () => true;

/** Network entries replayed from the desktop (`deviceId: 'desktop'`) are visible in every scope. */
const DESKTOP = 'desktop';

export function compileScope(scope: Scope, hub: HubLike): CompiledScope {
  if (scope.kind === 'all') return { scope, logs: always, network: always, metrics: always };

  if (scope.kind === 'device') {
    const d = scope.deviceId;
    return {
      scope,
      deviceId: d,
      logs: (e) => e.deviceId === d || e.kind === 'marker',
      network: (e) => e.deviceId === d || e.deviceId === DESKTOP,
      metrics: (s) => s.deviceId === d,
    };
  }

  const app = hub.apps[scope.appId];
  if (!app) {
    const id = scope.appId;
    const ids = new Set([id]);
    return {
      scope,
      appIds: ids,
      logs: (e) => e.appId === id || e.kind === 'marker',
      network: (e) => e.appId === id || e.deviceId === DESKTOP,
      metrics: (s) => s.appId === id,
    };
  }

  const key = appGroupKey(app);
  const sessions = scope.exact ? [app] : Object.values(hub.apps).filter((a) => appGroupKey(a) === key);
  const ids = new Set(sessions.map((s) => s.id));
  const pids = new Set<number>();
  for (const s of sessions) if (typeof s.app.pid === 'number') pids.add(s.app.pid);
  const names = new Set<string>([app.app.id]);
  for (const s of sessions) if (s.app.processName) names.add(s.app.processName);
  const subPrefix = `${app.app.id}:`;
  const deviceId = app.deviceId;
  // In exact mode a session with a pid is matched by pid only (other runs share the process name).
  const nameFallback = !scope.exact || typeof app.app.pid !== 'number';

  const processMatches = (name: string) => names.has(name) || name.startsWith(subPrefix);

  const logs = (e: LogEntry): boolean => {
    if (e.appId !== undefined) return ids.has(e.appId);
    if (e.kind === 'marker') return true;
    if (e.deviceId !== deviceId) return false;
    if (e.source === 'device') {
      if (e.process && nameFallback) return processMatches(e.process);
      if (e.pid !== undefined) return pids.has(e.pid) && (!e.process || processMatches(e.process));
      return false;
    }
    if (e.source === 'system') {
      const code = e.code ?? '';
      if (code.startsWith('device.') || code.startsWith('logs.')) return true;
      if (code.startsWith('process.')) {
        // Server params: { process, pid } (older builds sent { name }).
        const pid = typeof e.params?.pid === 'number' ? e.params.pid : e.pid;
        const name = typeof e.params?.process === 'string' ? e.params.process : typeof e.params?.name === 'string' ? e.params.name : e.process;
        if (pid !== undefined && pids.has(pid)) return true;
        return name !== undefined && nameFallback && processMatches(name);
      }
    }
    return false;
  };

  return {
    scope,
    deviceId,
    appIds: ids,
    app,
    logs,
    network: (e) => (e.appId !== undefined && ids.has(e.appId)) || e.deviceId === DESKTOP,
    metrics: (s) => (s.appId !== undefined ? ids.has(s.appId) : s.deviceId === deviceId && s.pid !== undefined && pids.has(s.pid)),
  };
}

/** One-off check (compiles the scope each call — prefer `compileScope` in loops). */
export function entryInScope(entry: LogEntry, scope: Scope, hub: HubLike = useHub.getState()): boolean {
  return compileScope(scope, hub).logs(entry);
}

export function networkInScope(entry: NetworkEntry, scope: Scope, hub: HubLike = useHub.getState()): boolean {
  return compileScope(scope, hub).network(entry);
}

/** Current scope compiled against the current apps (stable until scope or apps change). */
export function useCompiledScope(): CompiledScope {
  const scope = useScope();
  const apps = useHub((s) => s.apps);
  return useMemo(() => compileScope(scope, { apps }), [scope, apps]);
}

/* ───────────── Counters per scope (incremental, no scanning) ───────────── */

function addLogCounts(into: LogCounts, c: LogCounts | undefined): void {
  if (!c) return;
  into.total += c.total;
  into.warn += c.warn;
  into.error += c.error;
  into.crash += c.crash;
}

/**
 * Log counters for a scope. Exact for `all`/`device`; for app scopes it counts entries carrying the
 * app's session ids (device lines are attributed by the server when the pid is known).
 */
export function scopeLogCounts(compiled: CompiledScope, store: LogStore): LogCounts {
  const s = compiled.scope;
  if (s.kind === 'all') return { ...store.counts };
  if (s.kind === 'device') return { ...(store.countsByDevice.get(s.deviceId) ?? emptyLogCounts()) };
  const out = emptyLogCounts();
  for (const id of compiled.appIds ?? []) addLogCounts(out, store.countsByApp.get(id));
  return out;
}

export function scopeNetworkCounts(compiled: CompiledScope, store: NetworkStore): NetworkCounts {
  const s = compiled.scope;
  const out = emptyNetworkCounts();
  const add = (c: NetworkCounts | undefined) => {
    if (!c) return;
    out.total += c.total;
    out.pending += c.pending;
    out.failed += c.failed;
    out.clientError += c.clientError;
    out.serverError += c.serverError;
    out.mocked += c.mocked;
  };
  if (s.kind === 'all') add(store.counts);
  else if (s.kind === 'device') {
    add(store.countsByDevice.get(s.deviceId));
    if (s.deviceId !== DESKTOP) add(store.countsByDevice.get(DESKTOP));
  } else {
    for (const id of compiled.appIds ?? []) add(store.countsByApp.get(id));
    add(store.countsByDevice.get(DESKTOP));
  }
  return out;
}

/* ───────────── Labels ───────────── */

export interface ScopeTarget {
  device?: DeviceInfo;
  app?: AppSession;
}

export function scopeTarget(scope: Scope, hub: Pick<HubState, 'apps' | 'devices'>): ScopeTarget {
  if (scope.kind === 'device') return { device: hub.devices[scope.deviceId] };
  if (scope.kind === 'app') {
    const app = hub.apps[scope.appId];
    return { app, device: app ? hub.devices[app.deviceId] : undefined };
  }
  return {};
}
