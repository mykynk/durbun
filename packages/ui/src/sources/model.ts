/**
 * Store-facing side of the source explanations: gather `ExplainInput`s for an app group / the current scope
 * and pick what an empty state should say. The decision logic stays in `data/explain.ts`; this file only joins
 * and summarizes (pure helpers are exported for tests).
 */
import { useMemo } from 'react';
import type { AppSession, DeviceApp, DeviceInfo, ServerSettings } from '@durbun/protocol';
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
import { useServerSettings } from '../data/stores/server';
import { scopeDeviceId } from '../data/scope';
import { isOwnApp, ownAppIndex, type OwnAppIndex } from '../data/ownApps';

type HubLike = Pick<HubState, 'apps' | 'devices'> & Partial<Pick<HubState, 'deviceApps'>>;

/* ───────────── own apps (build advice only for the team's apps) ───────────── */

let ownCache: { apps: unknown; deviceApps: unknown; index: OwnAppIndex } | undefined;

/** Own-app index of the hub (cached per apps / deviceApps object: the selectors below run on every hub change). */
export function hubOwnIndex(hub: HubLike): OwnAppIndex {
  const deviceApps = hub.deviceApps ?? {};
  if (ownCache && ownCache.apps === hub.apps && ownCache.deviceApps === deviceApps) return ownCache.index;
  const index = ownAppIndex(Object.values(hub.apps), Object.values(deviceApps));
  ownCache = { apps: hub.apps, deviceApps, index };
  return index;
}

/** Whether an app group is plausibly the team's own (`data/ownApps.ts`): sessions count as proof on their own. */
export function groupIsOwn(group: Pick<AppGroup, 'bundleId' | 'sessions'>, index: OwnAppIndex): boolean {
  return group.sessions.length > 0 || isOwnApp(group.bundleId, index);
}

export interface ExplainedApp {
  key: string;
  group: AppGroup;
  input: ExplainInput;
  result: ExplainResult;
}

/**
 * Explain one app group (device + bundle id). `own: false` = probably not the team's app (no build advice);
 * omitted = own.
 */
export function explainGroup(group: AppGroup, device: DeviceInfo | undefined, own?: boolean): ExplainedApp {
  const input: ExplainInput = { device, deviceApp: group.deviceApp, sessions: group.sessions, ...(own === false ? { own: false } : {}) };
  return { key: group.key, group, input, result: explainSources(input) };
}

/** Explain a group with its ownership taken from the hub. */
function explainInHub(hub: HubLike, g: AppGroup): ExplainedApp {
  return explainGroup(g, hub.devices[g.deviceId], groupIsOwn(g, hubOwnIndex(hub)));
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

function readerSig(r: DeviceInfo['readers']): string {
  if (!r) return '';
  return `${r.crashReports?.status ?? ''}/${r.crashReports?.code ?? ''}/${r.crashReports?.detail ?? ''}|${r.frameStats?.status ?? ''}/${r.frameStats?.code ?? ''}/${r.frameStats?.detail ?? ''}`;
}

function deviceSig(d: DeviceInfo | undefined): string {
  if (!d) return '';
  // Readers decide the crash / metrics rows; actions decide what can be offered (e.g. launching the app).
  return `${d.id}:${d.name}:${d.platform}:${d.kind}:${d.state}:${d.logs.status}:${d.logs.code ?? ''}:${d.logs.via ?? ''}:${readerSig(d.readers)}:${d.actions.join(',')}`;
}

/** Everything an app group's explanation depends on (no stats, no lastActivity). */
export function explainSignature(hub: HubLike, keys: readonly string[]): string {
  let out = '';
  const devicesSeen = new Set<string>();
  const index = keys.length > 0 ? hubOwnIndex(hub) : undefined;
  for (const key of keys) {
    const deviceId = key.slice(0, key.indexOf('|'));
    if (!devicesSeen.has(deviceId)) {
      devicesSeen.add(deviceId);
      out += `D${deviceSig(hub.devices[deviceId])}\n`;
    }
    out += `A${deviceAppSig(hub.deviceApps?.[key])}\n`;
    let sessions = 0;
    for (const a of Object.values(hub.apps)) {
      if (appGroupKey(a) !== key) continue;
      sessions++;
      out += `S${sessionSig(a)}\n`;
    }
    // Ownership follows other apps too (a debug build of a sibling app makes this one "own").
    out += `O${sessions > 0 || isOwnApp(key.slice(key.indexOf('|') + 1), index!) ? 1 : 0}\n`;
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
    return explainInHub(hub, g);
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
    if (g) items.push(explainInHub(hub, g));
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

/* ───────────── a scoped app that is not running ───────────── */

/**
 * The one app of an app scope when it is not running on a device that is online: its views are empty because
 * it is closed, not because something is missing (the Logs view says "{app} şu an açık değil" and offers to
 * launch it). Undefined for device / all scopes, running apps and offline devices.
 */
export function idleApp(scope: Pick<ScopeExplain, 'kind' | 'items'>): ExplainedApp | undefined {
  if (scope.kind !== 'app' || scope.items.length !== 1) return undefined;
  const item = scope.items[0]!;
  const notes = item.result.notes ?? [];
  return notes.includes('notRunning') && item.result.context?.deviceOnline ? item : undefined;
}

/** `idleApp` of the current scope. */
export function useIdleApp(): ExplainedApp | undefined {
  return idleApp(useScopeExplain());
}

/* ───────────── iPhone log scope (ServerSettings.iosDeviceLogScope) ───────────── */

/** Physical iPhones whose device log is streamed live by the server (not demo, imported or `net:` devices). */
function isLiveIphone(d: DeviceInfo): boolean {
  return d.platform === 'ios' && d.kind === 'physical' && d.state === 'online' && !/^(demo|import|net):/.test(d.id);
}

/**
 * iPhones in scope whose system-process lines the server leaves out (`iosDeviceLogScope` 'apps', the default):
 * the Logs view can say so and point to Ayarlar › Loglar › iPhone log kapsamı. Empty when the server does not
 * report the setting (older servers stream everything) or it is 'all'. An iPhone whose stream reports
 * `logs.scopeNotApplied` (no devicectl, app list unreadable) shows every line, so it is left out.
 */
export function iosSystemLinesHidden(
  scope: Scope,
  hub: Pick<HubState, 'apps' | 'devices'>,
  settings: Pick<ServerSettings, 'iosDeviceLogScope'>,
  reported: ReadonlySet<string> | undefined,
): DeviceInfo[] {
  if (!reported?.has('iosDeviceLogScope') || (settings.iosDeviceLogScope ?? 'apps') !== 'apps') return [];
  const one = scope.kind === 'all' ? undefined : scopeDeviceId(scope, hub);
  const devices = scope.kind === 'all' ? Object.values(hub.devices) : one && hub.devices[one] ? [hub.devices[one]!] : [];
  return devices.filter((d) => isLiveIphone(d) && d.logs.code !== 'logs.scopeNotApplied');
}

/** `iosSystemLinesHidden` for the current scope; re-renders only when the answer changes. */
export function useIosSystemLinesHidden(): DeviceInfo[] {
  const scope = useScope();
  const settings = useServerSettings((s) => s.settings);
  const reported = useServerSettings((s) => s.reported);
  const sig = useHub((s) => iosSystemLinesHidden(scope, s, settings, reported).map((d) => `${d.id}:${d.name}`).join('|'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => iosSystemLinesHidden(scope, useHub.getState(), settings, reported), [scope, sig, settings, reported]);
}
