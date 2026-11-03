import { create } from 'zustand';
import { useMemo } from 'react';
import type { AppSession, DeviceApp, DeviceInfo, DriverStatus, ProcessUpdate } from '@durbun/protocol';
import { useConnection } from './connection';

/** Devices, app sessions, drivers and processes as last reported by the server. */
export interface HubState {
  devices: Record<string, DeviceInfo>;
  apps: Record<string, AppSession>;
  drivers: DriverStatus[];
  /** deviceId → pid → latest process info */
  processes: Record<string, Record<number, ProcessUpdate>>;
  /** Apps the devices report, with or without an SDK (SPEC §10), by `DeviceApp.key` ('<deviceId>|<bundle id>'). */
  deviceApps: Record<string, DeviceApp>;
}

export const useHub = create<HubState>()(() => ({ devices: {}, apps: {}, drivers: [], processes: {}, deviceApps: {} }));

/** '<deviceId>|<bundle id>' — the key of a DeviceApp and of an app group. */
export function deviceAppKey(deviceId: string, bundleId: string): string {
  return `${deviceId}|${bundleId}`;
}

/**
 * The server bumps `lastActivity` whenever a log line of the app arrives. Those updates only matter for the
 * "recently active" order, so they are coalesced: a change that touches nothing but `lastActivity` (by less
 * than this) keeps the stored object and does not re-render subscribers.
 */
const ACTIVITY_COALESCE_MS = 10_000;

function sameArray(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Equal in everything but `lastActivity`. */
export function sameDeviceAppIgnoringActivity(a: DeviceApp, b: DeviceApp): boolean {
  return (
    a.key === b.key &&
    a.name === b.name &&
    a.version === b.version &&
    a.build === b.build &&
    a.buildType === b.buildType &&
    a.install.source === b.install.source &&
    a.install.installer === b.install.installer &&
    a.install.firstInstall === b.install.firstInstall &&
    a.install.lastUpdate === b.install.lastUpdate &&
    a.processName === b.processName &&
    a.running === b.running &&
    a.crashReports === b.crashReports &&
    sameArray(a.pids ?? [], b.pids ?? [])
  );
}

/** Invisible direction marks some tools put around names (devicectl: "\u200eWhatsApp"): they break sorting and matching. */
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A display name without bidi control marks and outer spaces; undefined when nothing is left. */
export function cleanAppName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const clean = name.replace(BIDI_MARKS, '').trim();
  return clean || undefined;
}

/** Defensive copy of a wire DeviceApp (older / odd servers: missing arrays or install info never crash the UI). */
function normalizeDeviceApp(d: DeviceApp): DeviceApp | null {
  if (!d || typeof d.deviceId !== 'string' || typeof d.id !== 'string' || !d.id) return null;
  const key = typeof d.key === 'string' && d.key ? d.key : deviceAppKey(d.deviceId, d.id);
  const pids = Array.isArray(d.pids) ? d.pids.filter((p) => typeof p === 'number' && Number.isFinite(p)) : [];
  const install = d.install && typeof d.install === 'object' ? d.install : { source: 'unknown' as const };
  return {
    ...d,
    name: cleanAppName(d.name),
    key,
    pids,
    install: { ...install, source: install.source ?? 'unknown' },
    buildType: d.buildType ?? 'unknown',
    running: d.running === true,
    lastActivity: typeof d.lastActivity === 'number' ? d.lastActivity : 0,
  };
}

export const hubActions = {
  replaceAll(input: { devices: DeviceInfo[]; apps: AppSession[]; drivers: DriverStatus[]; processes: ProcessUpdate[]; deviceApps?: DeviceApp[] }): void {
    const devices: Record<string, DeviceInfo> = {};
    for (const d of input.devices) devices[d.id] = d;
    const apps: Record<string, AppSession> = {};
    for (const a of input.apps) apps[a.id] = a;
    const deviceApps: Record<string, DeviceApp> = {};
    for (const raw of input.deviceApps ?? []) {
      const d = normalizeDeviceApp(raw);
      if (d) deviceApps[d.key] = d;
    }
    useHub.setState({ devices, apps, drivers: input.drivers, processes: mergeProcesses({}, input.processes), deviceApps });
  },
  /** Inserted / changed device apps (`batch.deviceApps`, full objects). Activity-only bumps are coalesced. */
  upsertDeviceApps(list: DeviceApp[]): void {
    if (!list || list.length === 0) return;
    const cur = useHub.getState().deviceApps;
    let next: Record<string, DeviceApp> | null = null;
    for (const raw of list) {
      const d = normalizeDeviceApp(raw);
      if (!d) continue;
      const old = (next ?? cur)[d.key];
      if (old && sameDeviceAppIgnoringActivity(old, d) && d.lastActivity - old.lastActivity < ACTIVITY_COALESCE_MS) continue;
      if (!next) next = { ...cur };
      next[d.key] = d;
    }
    if (next) useHub.setState({ deviceApps: next });
  },
  /** DeviceApp keys that are gone (`batch.removedDeviceApps`). */
  removeDeviceApps(keys: string[]): void {
    if (!keys || keys.length === 0) return;
    const cur = useHub.getState().deviceApps;
    if (!keys.some((k) => k in cur)) return;
    const next = { ...cur };
    for (const k of keys) delete next[k];
    useHub.setState({ deviceApps: next });
  },
  upsertDevices(list: DeviceInfo[]): void {
    if (list.length === 0) return;
    useHub.setState((s) => {
      const devices = { ...s.devices };
      for (const d of list) devices[d.id] = d;
      return { devices };
    });
  },
  /**
   * Devices removed by the server (`batch.removedDevices`, e.g. after `clear('all')` dropped disconnected,
   * imported or desktop devices). Their app sessions, device apps and processes go with them, as on the server.
   */
  removeDevices(ids: string[]): void {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    useHub.setState((s) => {
      const devices = { ...s.devices };
      const processes = { ...s.processes };
      for (const id of gone) {
        delete devices[id];
        delete processes[id];
      }
      let apps = s.apps;
      for (const [appId, app] of Object.entries(s.apps)) {
        if (!gone.has(app.deviceId)) continue;
        if (apps === s.apps) apps = { ...s.apps };
        delete apps[appId];
      }
      let deviceApps = s.deviceApps;
      for (const [key, d] of Object.entries(s.deviceApps)) {
        if (!gone.has(d.deviceId)) continue;
        if (deviceApps === s.deviceApps) deviceApps = { ...s.deviceApps };
        delete deviceApps[key];
      }
      return { devices, processes, apps, deviceApps };
    });
  },
  upsertApps(list: AppSession[]): void {
    if (list.length === 0) return;
    useHub.setState((s) => {
      const apps = { ...s.apps };
      for (const a of list) apps[a.id] = a;
      return { apps };
    });
  },
  setDrivers(drivers: DriverStatus[]): void {
    useHub.setState({ drivers });
  },
  applyProcesses(updates: ProcessUpdate[]): void {
    if (updates.length === 0) return;
    useHub.setState((s) => ({ processes: mergeProcesses(s.processes, updates) }));
  },
  reset(): void {
    useHub.setState({ devices: {}, apps: {}, drivers: [], processes: {}, deviceApps: {} });
  },
};

function mergeProcesses(base: HubState['processes'], updates: ProcessUpdate[]): HubState['processes'] {
  const out = { ...base };
  const touched = new Set<string>();
  for (const u of updates) {
    if (!touched.has(u.deviceId)) {
      out[u.deviceId] = { ...(out[u.deviceId] ?? {}) };
      touched.add(u.deviceId);
    }
    out[u.deviceId]![u.pid] = u;
  }
  return out;
}

/* ───────────── Derived helpers ───────────── */

export type DeviceGroup = 'live' | 'demo' | 'import' | 'other';

/** Virtual device that owns requests replayed from the desktop ("Masaüstü · yeniden gönderilenler"). */
export const DESKTOP_DEVICE_ID = 'desktop';

/** `import:<n>`: a session imported from a `.durbun.json` file (read-only recording, name starts with "📁 "). */
export function isImportedDevice(id: string): boolean {
  return id.startsWith('import:');
}

/** `net:<key>`: an app connected over the network without a known device (SDK data only, no device logs/actions). */
export function isNetworkDevice(id: string): boolean {
  return id.startsWith('net:');
}

/** Imported recordings and the desktop entry: nothing live to act on (no device actions, no app commands). */
export function isReadOnlyDevice(id: string): boolean {
  return isImportedDevice(id) || id === DESKTOP_DEVICE_ID;
}

export function deviceGroup(id: string): DeviceGroup {
  if (id.startsWith('demo:')) return 'demo';
  if (id.startsWith('import:')) return 'import';
  if (id === 'desktop') return 'other';
  return 'live';
}

const GROUP_ORDER: Record<DeviceGroup, number> = { live: 0, demo: 1, import: 2, other: 3 };
const STATE_ORDER: Record<DeviceInfo['state'], number> = { online: 0, unauthorized: 1, offline: 2, disconnected: 3 };

/**
 * Stable device order: live → demo → imported → other; connected before disconnected; then first seen.
 * `gone` decides what counts as disconnected (the sidebar keeps a device that just dropped in place).
 */
export function sortDevices(devices: Iterable<DeviceInfo>, opts: { gone?: (d: DeviceInfo) => boolean } = {}): DeviceInfo[] {
  const gone = opts.gone ?? ((d: DeviceInfo) => d.state === 'disconnected');
  return [...devices].sort(
    (a, b) =>
      GROUP_ORDER[deviceGroup(a.id)] - GROUP_ORDER[deviceGroup(b.id)] ||
      (gone(a) ? 1 : 0) - (gone(b) ? 1 : 0) ||
      a.firstSeen - b.firstSeen ||
      a.name.localeCompare(b.name),
  );
}

export function isDeviceUsable(d: DeviceInfo): boolean {
  return d.state === 'online';
}

/**
 * One app on one device: its SDK / VM-service sessions (same bundle id, newest first) joined with what the
 * device itself reports about it (`DeviceApp`, SPEC §10). Either side may be missing: SDK-only apps (no device
 * report yet, `net:` devices) have no `deviceApp`, SDK-less apps have no sessions.
 */
export interface AppGroup {
  /** `${deviceId}|${bundleId}` (= `DeviceApp.key`) */
  key: string;
  deviceId: string;
  /** Bundle id / package name. */
  bundleId: string;
  /** The session to show/select: the connected one, else the most recent. Undefined for SDK-less apps. */
  latest?: AppSession;
  /** All sessions, newest first (latest first). */
  sessions: AppSession[];
  /** An SDK / VM-service session is connected. */
  connected: boolean;
  /** What the device reports (install source, build type, pids), when it does. */
  deviceApp?: DeviceApp;
  /** Connected session, or the device reports a live process. */
  running: boolean;
  /** Newest sign of life (device activity, session connect / disconnect), epoch ms. */
  lastActivity: number;
}

export function appGroupKey(app: Pick<AppSession, 'deviceId' | 'app'>): string {
  return deviceAppKey(app.deviceId, app.app.id);
}

/** Display name of a group: the SDK's app name, the device's label, else the bundle id. */
export function appGroupName(g: Pick<AppGroup, 'latest' | 'deviceApp' | 'bundleId'>): string {
  return g.latest?.app.name || g.deviceApp?.name || g.bundleId;
}

function sessionActivity(s: AppSession): number {
  return Math.max(s.connectedAt || 0, s.disconnectedAt ?? 0);
}

/**
 * deviceId → app groups. Order: running apps first (by name, so rows do not jump while logs stream), then
 * the rest by most recent activity.
 */
export function groupApps(apps: Iterable<AppSession>, deviceApps: Iterable<DeviceApp> = []): Map<string, AppGroup[]> {
  const groups = new Map<string, AppGroup>();
  const ensure = (deviceId: string, bundleId: string): AppGroup => {
    const key = deviceAppKey(deviceId, bundleId);
    let g = groups.get(key);
    if (!g) {
      g = { key, deviceId, bundleId, sessions: [], connected: false, running: false, lastActivity: 0 };
      groups.set(key, g);
    }
    return g;
  };
  for (const a of apps) ensure(a.deviceId, a.app.id).sessions.push(a);
  for (const d of deviceApps) ensure(d.deviceId, d.id).deviceApp = d;
  const byDevice = new Map<string, AppGroup[]>();
  for (const g of groups.values()) {
    g.sessions.sort((x, y) => Number(y.connected) - Number(x.connected) || y.connectedAt - x.connectedAt);
    g.latest = g.sessions[0];
    g.connected = g.sessions.some((s) => s.connected);
    g.running = g.connected || g.deviceApp?.running === true;
    g.lastActivity = Math.max(g.deviceApp?.lastActivity ?? 0, ...g.sessions.map(sessionActivity));
    let list = byDevice.get(g.deviceId);
    if (!list) byDevice.set(g.deviceId, (list = []));
    list.push(g);
  }
  for (const list of byDevice.values()) {
    list.sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        Number(b.connected) - Number(a.connected) ||
        (a.running ? 0 : b.lastActivity - a.lastActivity) ||
        appGroupName(a).localeCompare(appGroupName(b)),
    );
  }
  return byDevice;
}

/** All sessions belonging to the same app group as `appId` (same device + bundle id). */
export function appGroupOf(apps: Record<string, AppSession>, appId: string): AppSession[] {
  const a = apps[appId];
  if (!a) return [];
  const key = appGroupKey(a);
  return Object.values(apps).filter((x) => appGroupKey(x) === key);
}

/* ───────────── Hooks ───────────── */

export function useDevices(): DeviceInfo[] {
  const devices = useHub((s) => s.devices);
  return useMemo(() => sortDevices(Object.values(devices)), [devices]);
}

export function useDevice(id: string | undefined): DeviceInfo | undefined {
  return useHub((s) => (id ? s.devices[id] : undefined));
}

export function useApps(): AppSession[] {
  const apps = useHub((s) => s.apps);
  return useMemo(() => Object.values(apps).sort((a, b) => b.connectedAt - a.connectedAt), [apps]);
}

export function useApp(id: string | undefined): AppSession | undefined {
  return useHub((s) => (id ? s.apps[id] : undefined));
}

/** deviceId → app groups: SDK / VM sessions joined with the apps the device reports (running first). */
export function useAppGroups(): Map<string, AppGroup[]> {
  const apps = useHub((s) => s.apps);
  const deviceApps = useHub((s) => s.deviceApps);
  return useMemo(() => groupApps(Object.values(apps), Object.values(deviceApps)), [apps, deviceApps]);
}

export function useDeviceApp(key: string | undefined): DeviceApp | undefined {
  return useHub((s) => (key ? s.deviceApps[key] : undefined));
}

export function useDrivers(): DriverStatus[] {
  return useHub((s) => s.drivers);
}

/**
 * Demo mode on right now. Follows the demo driver's live status (`drivers` broadcasts); `ServerInfo.demo`
 * is only the value at connect time.
 */
export function useDemoActive(): boolean {
  const fromDrivers = useHub((s) => s.drivers.find((d) => d.id === 'demo')?.active);
  const fromHello = useConnection((s) => s.server?.demo ?? false);
  return fromDrivers ?? fromHello;
}

export function useProcessName(deviceId: string | undefined, pid: number | undefined): string | undefined {
  return useHub((s) => (deviceId && pid !== undefined ? s.processes[deviceId]?.[pid]?.name : undefined));
}

/** True when there is nothing to show yet (no devices except the virtual desktop, and no apps). */
export function useIsEmpty(): boolean {
  return useHub((s) => Object.keys(s.apps).length === 0 && Object.keys(s.devices).every((id) => id === 'desktop'));
}
