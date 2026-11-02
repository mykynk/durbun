/**
 * Store-facing side of the source explanations: gather `ExplainInput`s for an app group / the current scope
 * and pick what an empty state should say. The decision logic stays in `data/explain.ts`; this file only joins
 * and summarizes (pure helpers are exported for tests).
 */
import { useMemo } from 'react';
import type { AppSession, DeviceApp, DeviceInfo } from '@durbun/protocol';
import {
  explainSources,
  type ExplainAction,
  type ExplainCapability,
  type ExplainInput,
  type ExplainReason,
  type ExplainResult,
  type ExplainRow,
  type ExplainStatus,
} from '../data/explain';
import { appGroupKey, deviceAppKey, groupApps, useHub, type AppGroup, type HubState } from '../data/stores/hub';
import { useScope, type Scope } from '../data/stores/scope';
import { scopeDeviceId } from '../data/scope';

type HubLike = Pick<HubState, 'apps' | 'devices'> & Partial<Pick<HubState, 'deviceApps'>>;

export interface ExplainedApp {
  key: string;
  group: AppGroup;
  input: ExplainInput;
  result: ExplainResult;
}

/** Explain one app group (device + bundle id). */
export function explainGroup(group: AppGroup, device: DeviceInfo | undefined): ExplainedApp {
  const input: ExplainInput = { device, deviceApp: group.deviceApp, sessions: group.sessions };
  return { key: group.key, group, input, result: explainSources(input) };
}

/** The app group for a key, from the hub (sessions + device report). */
export function groupFor(hub: HubLike, key: string): AppGroup | undefined {
  const sessions = Object.values(hub.apps).filter((a) => appGroupKey(a) === key);
  const deviceApp = hub.deviceApps?.[key];
  if (sessions.length === 0 && !deviceApp) return undefined;
  const deviceId = deviceApp?.deviceId ?? sessions[0]!.deviceId;
  return groupApps(sessions, deviceApp ? [deviceApp] : []).get(deviceId)?.[0];
}

/** Group keys a scope is about: one app, every app of a device, or none ('all'). */
export function scopeGroupKeys(scope: Scope, hub: HubLike): { kind: 'none' | 'app' | 'device'; deviceId?: string; keys: string[] } {
  if (scope.kind === 'all') return { kind: 'none', keys: [] };
  if (scope.kind === 'deviceApp') return { kind: 'app', deviceId: scope.deviceId, keys: [deviceAppKey(scope.deviceId, scope.bundleId)] };
  if (scope.kind === 'app') {
    const a = hub.apps[scope.appId];
    return a ? { kind: 'app', deviceId: a.deviceId, keys: [appGroupKey(a)] } : { kind: 'app', keys: [] };
  }
  const keys = new Set<string>();
  for (const a of Object.values(hub.apps)) if (a.deviceId === scope.deviceId) keys.add(appGroupKey(a));
  for (const d of Object.values(hub.deviceApps ?? {})) if (d.deviceId === scope.deviceId) keys.add(d.key);
  return { kind: 'device', deviceId: scope.deviceId, keys: [...keys].sort() };
}

/* ───────────── signatures (re-render only when an explanation can change) ───────────── */

function sessionSig(s: AppSession): string {
  return `${s.id}:${s.connected ? 1 : 0}:${s.connectedAt}:${s.transport}:${s.sdk.platform}:${s.capabilities.join(',')}:${s.actions.length}:${s.app.name}:${s.app.version ?? ''}:${s.app.build ?? ''}:${s.app.debug === undefined ? '' : s.app.debug ? 1 : 0}:${s.app.pid ?? ''}`;
}

function deviceAppSig(d: DeviceApp | undefined): string {
  if (!d) return '';
  return `${d.key}:${d.name ?? ''}:${d.version ?? ''}:${d.build ?? ''}:${d.buildType}:${d.install.source}:${d.install.installer ?? ''}:${d.running ? 1 : 0}:${d.pids.join(',')}:${d.processName ?? ''}:${d.crashReports ?? 0}`;
}

function deviceSig(d: DeviceInfo | undefined): string {
  if (!d) return '';
  return `${d.id}:${d.name}:${d.platform}:${d.kind}:${d.state}:${d.logs.status}:${d.logs.code ?? ''}:${d.logs.via ?? ''}`;
}

/** Everything an app group's explanation depends on (no stats, no lastActivity). */
export function explainSignature(hub: HubLike, keys: readonly string[]): string {
  let out = '';
  const devicesSeen = new Set<string>();
  for (const key of keys) {
    const deviceId = key.slice(0, key.indexOf('|'));
    if (!devicesSeen.has(deviceId)) {
      devicesSeen.add(deviceId);
      out += `D${deviceSig(hub.devices[deviceId])}\n`;
    }
    out += `A${deviceAppSig(hub.deviceApps?.[key])}\n`;
    for (const a of Object.values(hub.apps)) if (appGroupKey(a) === key) out += `S${sessionSig(a)}\n`;
  }
  return out;
}

/** Explanation of one app group, recomputed only when its inputs change. */
export function useAppExplain(key: string | undefined): ExplainedApp | null {
  const sig = useHub((s) => (key ? explainSignature(s, [key]) : ''));
  return useMemo(() => {
    if (!key) return null;
    const hub = useHub.getState();
    const g = groupFor(hub, key);
    if (!g) return null;
    return explainGroup(g, hub.devices[g.deviceId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sig]);
}

export interface ScopeExplain {
  kind: 'none' | 'app' | 'device';
  deviceId?: string;
  device?: DeviceInfo;
  items: ExplainedApp[];
}

export function explainScope(scope: Scope, hub: HubLike): ScopeExplain {
  const { kind, deviceId, keys } = scopeGroupKeys(scope, hub);
  const items: ExplainedApp[] = [];
  for (const key of keys) {
    const g = groupFor(hub, key);
    if (g) items.push(explainGroup(g, hub.devices[g.deviceId]));
  }
  return { kind, deviceId, device: deviceId ? hub.devices[deviceId] : undefined, items };
}

/** Explanations for the apps the current scope is about. */
export function useScopeExplain(): ScopeExplain {
  const scope = useScope();
  const sig = useHub((s) => {
    const { keys, deviceId } = scopeGroupKeys(scope, s);
    return `${deviceId ?? ''}|${keys.join(',')}\n${explainSignature(s, keys)}`;
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => explainScope(scope, useHub.getState()), [scope, sig]);
}

/* ───────────── empty states ───────────── */

export interface EmptyExplanation {
  /** The capability cannot work for the scoped app(s) — say why instead of "nothing yet". */
  structural: boolean;
  /** 'no' when no app can have it, 'partial' when it works only in part (only with `includePartial`). */
  status?: ExplainStatus;
  /** Rows of the apps in scope, in scope order. */
  rows: { item: ExplainedApp; row: ExplainRow }[];
  /** Union of the reasons (ordered by first appearance). */
  reasons: ExplainReason[];
  /** Union of the actions (ordered by first appearance). */
  actions: ExplainAction[];
  /** Exactly one app in scope. */
  single?: ExplainedApp;
}

/**
 * What an empty Network / Performance / Mocks / tools view should say for the scoped apps:
 * - no app in scope → generic ("nothing yet");
 * - any app has the capability → generic (the app simply has not sent anything yet);
 * - otherwise structural: the reasons and actions of the rows. `includePartial` also treats 'partial'
 *   (e.g. Android metrics from outside the app) as worth explaining when nothing is 'yes'.
 */
export function pickEmptyReason(capability: ExplainCapability, scope: Pick<ScopeExplain, 'items'>, opts: { includePartial?: boolean } = {}): EmptyExplanation {
  const rows: EmptyExplanation['rows'] = [];
  for (const item of scope.items) {
    const row = item.result.rows.find((r) => r.capability === capability);
    if (row) rows.push({ item, row });
  }
  const single = scope.items.length === 1 ? scope.items[0] : undefined;
  if (rows.length === 0 || rows.some((r) => r.row.status === 'yes')) return { structural: false, rows, reasons: [], actions: [], single };
  const partial = rows.some((r) => r.row.status === 'partial');
  if (partial && !opts.includePartial) return { structural: false, rows, reasons: [], actions: [], single };
  const reasons: ExplainReason[] = [];
  const actions: ExplainAction[] = [];
  for (const { row } of rows) {
    if (partial && row.status !== 'partial') continue;
    for (const r of row.reasons) if (!reasons.includes(r)) reasons.push(r);
    for (const a of row.actions) if (!actions.includes(a)) actions.push(a);
  }
  return { structural: true, status: partial ? 'partial' : 'no', rows, reasons, actions, single };
}

/* ───────────── crash records: "none yet" vs "cannot be read" ───────────── */

export interface CrashRecordsState {
  /** Online devices in scope whose own crash / ANR records cannot be read right now (reader reported down). */
  unreadable: DeviceInfo[];
  /** Online devices in scope whose records are read (reader reported 'ok'): an empty list really means none yet. */
  readable: DeviceInfo[];
}

/** Devices of a scope ('all' = every device) split by whether the server can read their crash records. */
export function crashRecordsState(scope: Scope, hub: Pick<HubState, 'apps' | 'devices'>): CrashRecordsState {
  const one = scope.kind === 'all' ? undefined : scopeDeviceId(scope, hub);
  const devices = scope.kind === 'all' ? Object.values(hub.devices) : one && hub.devices[one] ? [hub.devices[one]!] : [];
  const out: CrashRecordsState = { unreadable: [], readable: [] };
  for (const d of devices) {
    const r = d.readers?.crashReports;
    if (!r || d.state !== 'online') continue;
    (r.status === 'ok' ? out.readable : out.unreadable).push(d);
  }
  return out;
}

/** `crashRecordsState` for the current scope; re-renders only when a reader of a scoped device changes. */
export function useCrashRecordsState(): CrashRecordsState {
  const scope = useScope();
  const sig = useHub((s) => {
    const st = crashRecordsState(scope, s);
    return [...st.unreadable.map((d) => `u:${d.id}:${d.name}:${d.readers?.crashReports?.code ?? ''}:${d.readers?.crashReports?.detail ?? ''}`), ...st.readable.map((d) => `r:${d.id}:${d.name}`)].join('|');
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => crashRecordsState(scope, useHub.getState()), [scope, sig]);
}
