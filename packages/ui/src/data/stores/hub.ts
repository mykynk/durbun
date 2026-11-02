import { create } from 'zustand';
import { useMemo } from 'react';
import type { AppSession, DeviceInfo, DriverStatus, ProcessUpdate } from '@durbun/protocol';
import { useConnection } from './connection';

/** Devices, app sessions, drivers and processes as last reported by the server. */
export interface HubState {
  devices: Record<string, DeviceInfo>;
  apps: Record<string, AppSession>;
  drivers: DriverStatus[];
  /** deviceId → pid → latest process info */
  processes: Record<string, Record<number, ProcessUpdate>>;
}

export const useHub = create<HubState>()(() => ({ devices: {}, apps: {}, drivers: [], processes: {} }));

export const hubActions = {
  replaceAll(input: { devices: DeviceInfo[]; apps: AppSession[]; drivers: DriverStatus[]; processes: ProcessUpdate[] }): void {
    const devices: Record<string, DeviceInfo> = {};
    for (const d of input.devices) devices[d.id] = d;
    const apps: Record<string, AppSession> = {};
    for (const a of input.apps) apps[a.id] = a;
    useHub.setState({ devices, apps, drivers: input.drivers, processes: mergeProcesses({}, input.processes) });
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
   * imported or desktop devices). Their app sessions and processes go with them, as on the server.
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
      return { devices, processes, apps };
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
    useHub.setState({ devices: {}, apps: {}, drivers: [], processes: {} });
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

/** Stable device order: live → demo → imported → other; connected before disconnected; then first seen. */
export function sortDevices(devices: Iterable<DeviceInfo>): DeviceInfo[] {
  return [...devices].sort(
    (a, b) =>
      GROUP_ORDER[deviceGroup(a.id)] - GROUP_ORDER[deviceGroup(b.id)] ||
      (a.state === 'disconnected' ? 1 : 0) - (b.state === 'disconnected' ? 1 : 0) ||
      a.firstSeen - b.firstSeen ||
      a.name.localeCompare(b.name),
  );
}

export function isDeviceUsable(d: DeviceInfo): boolean {
  return d.state === 'online';
}

/** Sessions of the same app (bundle id) on the same device, newest first. */
export interface AppGroup {
  /** `${deviceId}|${app.id}` */
  key: string;
  deviceId: string;
  /** Bundle id / package name. */
  bundleId: string;
  /** The session to show/select: the connected one, else the most recent. */
  latest: AppSession;
  /** All sessions, newest first (latest first). */
  sessions: AppSession[];
  connected: boolean;
}

export function appGroupKey(app: Pick<AppSession, 'deviceId' | 'app'>): string {
  return `${app.deviceId}|${app.app.id}`;
}

export function groupApps(apps: Iterable<AppSession>): Map<string, AppGroup[]> {
  const groups = new Map<string, AppGroup>();
  for (const a of apps) {
    const key = appGroupKey(a);
    let g = groups.get(key);
    if (!g) {
      g = { key, deviceId: a.deviceId, bundleId: a.app.id, latest: a, sessions: [], connected: false };
      groups.set(key, g);
    }
    g.sessions.push(a);
  }
  const byDevice = new Map<string, AppGroup[]>();
  for (const g of groups.values()) {
    g.sessions.sort((x, y) => Number(y.connected) - Number(x.connected) || y.connectedAt - x.connectedAt);
    g.latest = g.sessions[0]!;
    g.connected = g.sessions.some((s) => s.connected);
    let list = byDevice.get(g.deviceId);
    if (!list) byDevice.set(g.deviceId, (list = []));
    list.push(g);
  }
  for (const list of byDevice.values()) {
    list.sort((a, b) => Number(b.connected) - Number(a.connected) || a.latest.app.name.localeCompare(b.latest.app.name));
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

/** deviceId → app groups (sorted: connected first, then name). */
export function useAppGroups(): Map<string, AppGroup[]> {
  const apps = useHub((s) => s.apps);
  return useMemo(() => groupApps(Object.values(apps)), [apps]);
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
