import { useMemo } from 'react';
import type { AppSession, DeviceApp, DeviceInfo, LogEntry, NetworkEntry } from '@durbun/protocol';
import { appGroupKey, deviceAppKey, useHub, type HubState } from './stores/hub';
import { useScope, type Scope } from './stores/scope';
import { emptyLogCounts, isCrashEntry, isProtectedEntry, type LogCounts, type LogStore } from './logStore';
import { emptyNetworkCounts, type NetworkCounts, type NetworkStore } from './networkStore';
import { bundlePrefix } from './ownApps';
import { fnv1a } from '../lib/hash';

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
  /**
   * Membership signature: changes only when what the predicates match changes (sessions of the app, its pids
   * and process names) — not on stats churn. Use it as a memo key for scans.
   */
  key: string;
  /** Device the scope is on (device and app scopes). */
  deviceId?: string;
  /** App / device-app scope: bundle id of the app. */
  bundleId?: string;
  /** App scope: session ids covered (all sessions of the app group, or one when exact). */
  appIds?: ReadonlySet<string>;
  /** App scope: the selected session (device-app scope: the newest session of the app, when there is one). */
  app?: AppSession;
  /** App / device-app scope: what the device reports about the app, when it does. */
  deviceApp?: DeviceApp;
  logs(e: LogEntry): boolean;
  network(e: NetworkEntry): boolean;
  metrics(s: ScopeSeriesRef): boolean;
}

type HubLike = Pick<HubState, 'apps'> & Partial<Pick<HubState, 'deviceApps' | 'processes'>>;

const always = () => true;

/** Network entries replayed from the desktop (`deviceId: 'desktop'`) are visible in every scope. */
const DESKTOP = 'desktop';

/** What an app / device-app scope matches, resolved from the hub (pure). */
interface ResolvedApp {
  deviceId: string;
  bundleId: string;
  sessions: AppSession[];
  app?: AppSession;
  deviceApp?: DeviceApp;
  pids: Set<number>;
  names: Set<string>;
  /** The app's own process names that another app on the device shares: they match only together with a pid. */
  pidNames: Set<string>;
  nameFallback: boolean;
  /**
   * Live pids the device reports for the app (`DeviceApp.pids`): every process of it, extensions and
   * global-named processes included, so they decide even when the line's process name is another one.
   */
  livePids: Set<number>;
  /** Bundle ids and process names of the OTHER apps on the device (a line named after one is never this app's). */
  otherNames: Set<string>;
}

/**
 * Process names that also belong to ANOTHER app on the same device (iOS Flutter apps are all "Runner"): those
 * names cannot attribute a line, the pid has to.
 */
function sharedNames(hub: HubLike, deviceId: string, bundleId: string, candidates: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const wanted = new Set([...candidates].filter((n) => n !== bundleId));
  if (wanted.size === 0) return out;
  for (const a of Object.values(hub.apps)) {
    if (a.deviceId === deviceId && a.app.id !== bundleId && a.app.processName && wanted.has(a.app.processName)) out.add(a.app.processName);
  }
  for (const d of Object.values(hub.deviceApps ?? {})) {
    if (d.deviceId === deviceId && d.id !== bundleId && d.processName && wanted.has(d.processName)) out.add(d.processName);
  }
  return out;
}

/** Bundle ids and process names of every other app on the device. */
function otherAppNames(hub: HubLike, deviceId: string, bundleId: string): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(hub.apps)) {
    if (a.deviceId !== deviceId || a.app.id === bundleId) continue;
    out.add(a.app.id);
    if (a.app.processName) out.add(a.app.processName);
  }
  for (const d of Object.values(hub.deviceApps ?? {})) {
    if (d.deviceId !== deviceId || d.id === bundleId) continue;
    out.add(d.id);
    if (d.processName) out.add(d.processName);
  }
  return out;
}

function resolveApp(hub: HubLike, deviceId: string, bundleId: string, opts: { exact?: AppSession } = {}): ResolvedApp {
  const key = deviceAppKey(deviceId, bundleId);
  const group = Object.values(hub.apps)
    .filter((a) => appGroupKey(a) === key)
    .sort((a, b) => Number(b.connected) - Number(a.connected) || b.connectedAt - a.connectedAt);
  const sessions = opts.exact ? [opts.exact] : group;
  // Exact mode follows one session: the device's report (current pids) belongs to whichever run is live now.
  const deviceApp = opts.exact ? undefined : hub.deviceApps?.[key];
  const pids = new Set<number>();
  for (const s of sessions) if (typeof s.app.pid === 'number') pids.add(s.app.pid);
  for (const p of deviceApp?.pids ?? []) pids.add(p);
  const rawNames = new Set<string>([bundleId]);
  for (const s of sessions) if (s.app.processName) rawNames.add(s.app.processName);
  if (deviceApp?.processName) rawNames.add(deviceApp.processName);
  const shared = sharedNames(hub, deviceId, bundleId, rawNames);
  const names = new Set([...rawNames].filter((n) => !shared.has(n)));
  if (!opts.exact) {
    // Earlier runs of the app: pids the process list attributed to it (lines that arrived without a name).
    const procs = hub.processes?.[deviceId];
    if (procs) {
      const sub = `${bundleId}:`;
      for (const p of Object.values(procs)) if (p.name === bundleId || p.name.startsWith(sub)) pids.add(p.pid);
    }
  }
  const exact = opts.exact;
  return {
    deviceId,
    bundleId,
    sessions,
    app: exact ?? group[0],
    deviceApp,
    pids,
    names,
    pidNames: shared,
    // In exact mode a session with a pid is matched by pid only (other runs share the process name).
    nameFallback: !exact || typeof exact.app.pid !== 'number',
    livePids: new Set(deviceApp?.pids ?? []),
    otherNames: deviceApp?.pids.length ? otherAppNames(hub, deviceId, bundleId) : new Set(),
  };
}

function signatureOf(scope: Scope, r?: ResolvedApp): string {
  if (scope.kind === 'all') return 'all';
  if (scope.kind === 'device') return `d:${scope.deviceId}`;
  if (!r) return scope.kind === 'app' ? `a?:${scope.appId}` : `da?:${scope.deviceId}|${scope.bundleId}`;
  const ids = r.sessions.map((s) => s.id).sort().join(',');
  const pids = [...r.pids].sort((a, b) => a - b).join(',');
  const names = [...r.names].sort().join(',') + (r.pidNames.size ? `~${[...r.pidNames].sort().join(',')}` : '');
  const head = scope.kind === 'app' ? `a:${scope.appId}:${scope.exact ? 1 : 0}` : `da:${r.deviceId}|${r.bundleId}`;
  const live = [...r.livePids].sort((a, b) => a - b).join(',');
  const others = r.otherNames.size ? fnv1a([...r.otherNames].sort().join('\n')).toString(36) : '';
  return `${head}|${ids}|${pids}|${names}|${r.nameFallback ? 1 : 0}|${r.app?.id ?? ''}|${live}|${others}`;
}

/** Bundle id a device crash record (dropbox / .ips) names in its data. */
function crashPackage(e: LogEntry): string | undefined {
  const d = e.data as { package?: unknown; bundleId?: unknown; bundleID?: unknown } | null | undefined;
  if (!d || typeof d !== 'object') return undefined;
  const v = d.package ?? d.bundleId ?? d.bundleID;
  return typeof v === 'string' && v ? v : undefined;
}

/** "com.foo:push" → "com.foo" (Android sub-process names). */
function basePackage(name: string): string {
  const i = name.indexOf(':');
  return i > 0 ? name.slice(0, i) : name;
}

function resolveScope(scope: Scope, hub: HubLike): ResolvedApp | undefined {
  if (scope.kind === 'app') {
    const app = hub.apps[scope.appId];
    if (!app) return undefined;
    return resolveApp(hub, app.deviceId, app.app.id, scope.exact ? { exact: app } : {});
  }
  if (scope.kind === 'deviceApp') return resolveApp(hub, scope.deviceId, scope.bundleId);
  return undefined;
}

/** Membership signature of a scope (cheap enough for a zustand selector). */
export function scopeSignature(scope: Scope, hub: HubLike): string {
  return signatureOf(scope, resolveScope(scope, hub));
}

export function compileScope(scope: Scope, hub: HubLike): CompiledScope {
  if (scope.kind === 'all') return { scope, key: 'all', logs: always, network: always, metrics: always };

  if (scope.kind === 'device') {
    const d = scope.deviceId;
    return {
      scope,
      key: signatureOf(scope),
      deviceId: d,
      logs: (e) => e.deviceId === d || e.kind === 'marker',
      network: (e) => e.deviceId === d || e.deviceId === DESKTOP,
      metrics: (s) => s.deviceId === d,
    };
  }

  const r = resolveScope(scope, hub);
  if (!r) {
    if (scope.kind === 'app') {
      const id = scope.appId;
      const ids = new Set([id]);
      return {
        scope,
        key: signatureOf(scope),
        appIds: ids,
        logs: (e) => e.appId === id || e.kind === 'marker',
        network: (e) => e.appId === id || e.deviceId === DESKTOP,
        metrics: (s) => s.appId === id,
      };
    }
    // deviceApp scopes always resolve (an app nobody reports yet simply matches nothing but its name).
  }
  const res = r ?? resolveApp(hub, (scope as { deviceId: string }).deviceId, (scope as { bundleId: string }).bundleId);
  const ids = new Set(res.sessions.map((s) => s.id));
  const { pids, names, pidNames, nameFallback, deviceId, bundleId, livePids, otherNames } = res;
  const subPrefix = `${bundleId}:`;
  const ownPrefix = bundlePrefix(bundleId);

  const processMatches = (name: string) => names.has(name) || name.startsWith(subPrefix);
  /**
   * A process of the app under another name, matched by one of its live pids: an iOS extension
   * ("KumbaraWidgetExtension", inside the .app), an Android process with a global name ("com.foo.remote").
   * Never a name another app on the device owns, and a package-like name only within the app's own
   * reverse-domain prefix — an old line of "com.android.vending" whose pid the app got later stays out.
   */
  const ownProcessByPid = (name: string, pid: number | undefined): boolean => {
    if (pid === undefined || !livePids.has(pid) || otherNames.has(name) || otherNames.has(basePackage(name))) return false;
    if (/^[A-Za-z][\w-]*(\.[\w-]+)+(:[\w.-]+)?$/.test(name)) return bundlePrefix(basePackage(name)) === ownPrefix;
    return true;
  };

  const logs = (e: LogEntry): boolean => {
    if (e.appId !== undefined) return ids.has(e.appId);
    if (e.kind === 'marker') return true;
    if (e.deviceId !== deviceId) return false;
    if (e.source === 'device') {
      const p = e.process;
      const pidOk = e.pid !== undefined && pids.has(e.pid);
      // Device crash / ANR records (dropbox, .ips, ActivityManager ANR lines) name the app they are about: the
      // package decides. By then the crashed pid is dead, and "Runner" may be any Flutter app on an iPhone.
      const pkg = crashPackage(e);
      if (pkg !== undefined) return basePackage(pkg) === bundleId && (nameFallback || pidOk);
      if (p) {
        // Exact mode: other runs share the name, the pid decides.
        if (processMatches(p)) return nameFallback || pidOk;
        // A name other apps share ("Runner"): only together with one of this app's pids.
        if (pidNames.has(p)) return pidOk;
        return ownProcessByPid(p, e.pid);
      } else if (e.pid !== undefined) return pidOk;
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
    key: signatureOf(scope, res),
    deviceId,
    bundleId,
    appIds: ids,
    app: res.app,
    deviceApp: res.deviceApp,
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

/**
 * Current scope compiled against the current hub. Stable until what the scope MATCHES changes (scope, the app's
 * sessions, pids, process names) — app stats churn (every batch) does not produce a new object.
 */
export function useCompiledScope(): CompiledScope {
  const scope = useScope();
  const key = useHub((s) => scopeSignature(scope, s));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => compileScope(scope, useHub.getState()), [scope, key]);
}

/* ───────────── Counters per scope (incremental, no scanning) ───────────── */

function addLogCounts(into: LogCounts, c: LogCounts | undefined): void {
  if (!c) return;
  into.total += c.total;
  into.warn += c.warn;
  into.error += c.error;
  into.crash += c.crash;
}

const F_WARN = 1;
const F_ERROR = 2;
const F_CRASH = 4;
/** The ring moves this entry to `store.kept` instead of dropping it (crash record). */
const F_KEPT = 8;

interface ScanCache {
  gen: number;
  lastId: number;
  /** Matched entries (id + count flags), oldest first, so head trimming can be subtracted. */
  ids: number[];
  flags: number[];
  head: number;
  /** Matched entries that now sit in `store.kept` (oldest first), subtracted when the store lets them go. */
  keptIds: number[];
  keptFlags: number[];
  counts: LogCounts;
}

const scanCaches = new WeakMap<CompiledScope, ScanCache>();

function entryFlags(e: LogEntry): number {
  let f = 0;
  if (e.level === 'warn') f |= F_WARN;
  else if (e.level === 'error' || e.level === 'fatal') f |= F_ERROR;
  if (isCrashEntry(e)) f |= F_CRASH;
  if (isProtectedEntry(e)) f |= F_KEPT;
  return f;
}

function applyFlags(c: LogCounts, f: number, sign: 1 | -1): void {
  c.total += sign;
  if (f & F_WARN) c.warn += sign;
  if (f & F_ERROR) c.error += sign;
  if (f & F_CRASH) c.crash += sign;
}

/**
 * Counters by predicate for device-app scopes (their device lines carry no `appId`): scans only entries that
 * arrived since the last call and subtracts what the ring trimmed (crash records the store keeps stay counted).
 */
function scannedLogCounts(compiled: CompiledScope, store: LogStore): LogCounts {
  let c = scanCaches.get(compiled);
  if (!c || c.gen !== store.generation) {
    c = { gen: store.generation, lastId: 0, ids: [], flags: [], head: 0, keptIds: [], keptFlags: [], counts: emptyLogCounts() };
    scanCaches.set(compiled, c);
  }
  const entries = store.entries;
  const kept = store.kept;
  // 1. What the ring trimmed since the last call: dropped, or (crash records) moved to `kept`.
  const first = entries[0]?.id ?? Infinity;
  while (c.head < c.ids.length && c.ids[c.head]! < first) {
    const f = c.flags[c.head]!;
    if (f & F_KEPT) {
      c.keptIds.push(c.ids[c.head]!);
      c.keptFlags.push(f);
    } else applyFlags(c.counts, f, -1);
    c.head++;
  }
  if (c.head > 4096 && c.head * 2 > c.ids.length) {
    c.ids = c.ids.slice(c.head);
    c.flags = c.flags.slice(c.head);
    c.head = 0;
  }
  // 2. Entries that arrived since the last call: kept ones first (they may have left the ring in the same batch).
  const scan = (list: readonly LogEntry[], from: number, ids: number[], flags: number[]) => {
    for (let i = from; i < list.length; i++) {
      const e = list[i]!;
      if (!compiled.logs(e)) continue;
      const f = entryFlags(e);
      ids.push(e.id);
      flags.push(f);
      applyFlags(c.counts, f, 1);
    }
  };
  let k = kept.length;
  while (k > 0 && kept[k - 1]!.id > c.lastId) k--;
  scan(kept, k, c.keptIds, c.keptFlags);
  scan(entries, store.lowerBound(c.lastId + 1), c.ids, c.flags);
  c.lastId = Math.max(c.lastId, store.lastId);
  // 3. The store lets kept entries go oldest first: ids before its oldest kept one are gone.
  const keptFirst = kept[0]?.id ?? Infinity;
  let gone = 0;
  while (gone < c.keptIds.length && c.keptIds[gone]! < keptFirst) applyFlags(c.counts, c.keptFlags[gone++]!, -1);
  if (gone > 0) {
    c.keptIds.splice(0, gone);
    c.keptFlags.splice(0, gone);
  }
  return { ...c.counts };
}

/**
 * Log counters for a scope. Exact for `all`/`device`; for app scopes it counts entries carrying the
 * app's session ids (device lines are attributed by the server when the pid is known); device-app scopes
 * count what their predicate matches (incrementally).
 */
export function scopeLogCounts(compiled: CompiledScope, store: LogStore): LogCounts {
  const s = compiled.scope;
  if (s.kind === 'all') return { ...store.counts };
  if (s.kind === 'device') return { ...(store.countsByDevice.get(s.deviceId) ?? emptyLogCounts()) };
  if (s.kind === 'deviceApp') return scannedLogCounts(compiled, store);
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
  /** App / device-app scopes: what the device reports about the app. */
  deviceApp?: DeviceApp;
  /** App / device-app scopes: bundle id (also when neither a session nor the device knows the app any more). */
  bundleId?: string;
}

export function scopeTarget(scope: Scope, hub: Pick<HubState, 'apps' | 'devices'> & Partial<Pick<HubState, 'deviceApps'>>): ScopeTarget {
  if (scope.kind === 'device') return { device: hub.devices[scope.deviceId] };
  if (scope.kind === 'app') {
    const app = hub.apps[scope.appId];
    return {
      app,
      device: app ? hub.devices[app.deviceId] : undefined,
      deviceApp: app ? hub.deviceApps?.[appGroupKey(app)] : undefined,
      bundleId: app?.app.id,
    };
  }
  if (scope.kind === 'deviceApp') {
    const key = deviceAppKey(scope.deviceId, scope.bundleId);
    const sessions = Object.values(hub.apps)
      .filter((a) => appGroupKey(a) === key)
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.connectedAt - a.connectedAt);
    return { device: hub.devices[scope.deviceId], app: sessions[0], deviceApp: hub.deviceApps?.[key], bundleId: scope.bundleId };
  }
  return {};
}

/** Device + bundle id of an app / device-app scope (undefined for all / device scopes or an unknown session). */
export function scopeAppRef(scope: Scope, hub: Pick<HubState, 'apps'>): { deviceId: string; bundleId: string } | undefined {
  if (scope.kind === 'deviceApp') return { deviceId: scope.deviceId, bundleId: scope.bundleId };
  if (scope.kind === 'app') {
    const a = hub.apps[scope.appId];
    return a ? { deviceId: a.deviceId, bundleId: a.app.id } : undefined;
  }
  return undefined;
}

/** Device a scope is on (device, app and device-app scopes). */
export function scopeDeviceId(scope: Scope, hub: Pick<HubState, 'apps'>): string | undefined {
  if (scope.kind === 'device' || scope.kind === 'deviceApp') return scope.deviceId;
  if (scope.kind === 'app') return hub.apps[scope.appId]?.deviceId;
  return undefined;
}
