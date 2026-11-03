/**
 * What belongs to one app on one device (deviceId + bundle id): its SDK / VM sessions, the device log lines
 * of its processes, its crash records, its requests and metrics. Used by the app-scoped export of a device
 * app (audit-seams #10) and mirrors the UI's device-app scope (packages/ui/src/data/scope.ts), so the file
 * holds what the scope shows:
 *  - lines of the app's sessions (appId);
 *  - device lines whose pid is one of the app's (session pids, DeviceApp.pids, pids the process table names
 *    after the package or "package:sub"), or whose process is the bundle id / "bundleId:sub" / a process name
 *    of the app that no other app on the device uses ("Runner" shared by two Flutter apps: the pid decides);
 *  - processes of the app under another name (an iOS extension, a global-named Android process) by a live
 *    DeviceApp pid, unless another app owns that name or it is a package of another vendor;
 *  - device crash records (dropbox, .ips, ANR lines) by the package they name (data.package / data.bundleId);
 *  - device / log-stream system lines of the device and process lines of the app's processes.
 */
import type { AppSession, DeviceApp, LogEntry, MetricSample, NetworkEntry, ProcessUpdate } from '@durbun/protocol';

export interface AppScopeInput {
  deviceId: string;
  bundleId: string;
  apps: Iterable<AppSession>;
  deviceApps: Iterable<DeviceApp>;
  processes: Iterable<ProcessUpdate>;
}

export interface AppScope {
  /** Session ids of the app on the device (SDK and VM service, live and ended). */
  sessionIds: Set<string>;
  pids: Set<number>;
  logs(e: LogEntry): boolean;
  network(e: Pick<NetworkEntry, 'deviceId' | 'appId'>): boolean;
  metrics(s: Pick<MetricSample, 'deviceId' | 'appId' | 'pid'>): boolean;
}

/** "com.foo:push" → "com.foo" (Android sub-process names). */
const basePackage = (name: string) => {
  const i = name.indexOf(':');
  return i > 0 ? name.slice(0, i) : name;
};

/** "com.mykynk.kumbara" → "com.mykynk" (the vendor part of a reverse-domain id). */
function vendorPrefix(id: string): string | undefined {
  const parts = id.split('.');
  return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}.${parts[1]}`.toLowerCase() : undefined;
}

const PACKAGE_LIKE = /^[A-Za-z][\w-]*(\.[\w-]+)+(:[\w.-]+)?$/;

/** Bundle id a device crash record (dropbox / .ips / ANR line) names in its data. */
function crashPackage(e: LogEntry): string | undefined {
  const d = e.data as { package?: unknown; bundleId?: unknown; bundleID?: unknown } | null | undefined;
  if (!d || typeof d !== 'object') return undefined;
  const v = d.package ?? d.bundleId ?? d.bundleID;
  return typeof v === 'string' && v ? v : undefined;
}

export function appScope(input: AppScopeInput): AppScope {
  const { deviceId, bundleId } = input;
  const sessions: AppSession[] = [];
  const others: { id: string; processName?: string }[] = [];
  for (const a of input.apps) {
    if (a.deviceId !== deviceId) continue;
    if (a.app.id === bundleId) sessions.push(a);
    else others.push({ id: a.app.id, processName: a.app.processName });
  }
  let deviceApp: DeviceApp | undefined;
  for (const d of input.deviceApps) {
    if (d.deviceId !== deviceId) continue;
    if (d.id === bundleId) deviceApp = d;
    else others.push({ id: d.id, processName: d.processName });
  }

  const sessionIds = new Set(sessions.map((s) => s.id));
  const pids = new Set<number>();
  for (const s of sessions) if (typeof s.app.pid === 'number') pids.add(s.app.pid);
  for (const p of deviceApp?.pids ?? []) pids.add(p);
  const sub = `${bundleId}:`;
  for (const p of input.processes) if (p.deviceId === deviceId && (p.name === bundleId || p.name.startsWith(sub))) pids.add(p.pid);

  const rawNames = new Set<string>([bundleId]);
  for (const s of sessions) if (s.app.processName) rawNames.add(s.app.processName);
  if (deviceApp?.processName) rawNames.add(deviceApp.processName);
  // Names another app on the device uses too ("Runner"): they attribute a line only together with a pid.
  const shared = new Set<string>();
  for (const o of others) if (o.processName && o.processName !== bundleId && rawNames.has(o.processName)) shared.add(o.processName);
  const names = new Set([...rawNames].filter((n) => !shared.has(n)));
  const livePids = new Set(deviceApp?.pids ?? []);
  const otherNames = new Set<string>();
  if (livePids.size > 0) {
    for (const o of others) {
      otherNames.add(o.id);
      if (o.processName) otherNames.add(o.processName);
    }
  }
  const ownVendor = vendorPrefix(bundleId);

  const processMatches = (name: string) => names.has(name) || name.startsWith(sub);
  const ownProcessByPid = (name: string, pid: number | undefined): boolean => {
    if (pid === undefined || !livePids.has(pid) || otherNames.has(name) || otherNames.has(basePackage(name))) return false;
    if (PACKAGE_LIKE.test(name)) return vendorPrefix(basePackage(name)) === ownVendor;
    return true;
  };

  const logs = (e: LogEntry): boolean => {
    if (e.appId !== undefined) return sessionIds.has(e.appId);
    if (e.deviceId !== deviceId) return false;
    if (e.kind === 'marker') return true;
    if (e.source === 'device') {
      const pidOk = e.pid !== undefined && pids.has(e.pid);
      const pkg = crashPackage(e);
      if (pkg !== undefined) return basePackage(pkg) === bundleId;
      const p = e.process;
      if (p) {
        if (processMatches(p)) return true;
        if (shared.has(p)) return pidOk;
        return ownProcessByPid(p, e.pid);
      }
      return pidOk;
    }
    if (e.source === 'system') {
      const code = e.code ?? '';
      if (code.startsWith('device.') || code.startsWith('logs.')) return true;
      if (code.startsWith('process.')) {
        const pid = typeof e.params?.pid === 'number' ? e.params.pid : e.pid;
        const name = typeof e.params?.process === 'string' ? e.params.process : typeof e.params?.name === 'string' ? e.params.name : e.process;
        if (pid !== undefined && pids.has(pid)) return true;
        return name !== undefined && processMatches(name);
      }
    }
    return false;
  };

  return {
    sessionIds,
    pids,
    logs,
    network: (e) => e.appId !== undefined && sessionIds.has(e.appId),
    metrics: (s) => (s.appId !== undefined ? sessionIds.has(s.appId) : s.deviceId === deviceId && s.pid !== undefined && pids.has(s.pid)),
  };
}
