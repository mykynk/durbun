import type { AppSession, DeviceApp, LogEntry } from '@durbun/protocol';

/**
 * Which app a log line belongs to. App lines carry their session (`appId`); device lines (logcat, the iOS
 * syslog, dropbox / tombstone / .ips crash records) carry none and are matched by process, by the package the
 * record names, or by the pid of an app the device reports. Shared by the row display, the share report and the
 * crash notification.
 */

/** The package / bundle id a device line names: an ANR headline, a crash record's data, else the process. */
export function entryPackage(e: LogEntry): string | undefined {
  const data = e.data as { package?: unknown; bundleId?: unknown; bundleID?: unknown } | undefined;
  const named = [data?.package, data?.bundleId, data?.bundleID].find((v): v is string => typeof v === 'string' && v.length > 0);
  return (e.kind === 'anr' ? /ANR in (\S+)/.exec(e.message)?.[1] : undefined) ?? named ?? e.process ?? undefined;
}

/** The SDK session of a line: its own, else the newest session on the device whose process it is. */
export function sessionForEntry(e: LogEntry, apps: Readonly<Record<string, AppSession>>): AppSession | undefined {
  if (e.appId && apps[e.appId]) return apps[e.appId];
  const proc = entryPackage(e);
  if (!proc) return undefined;
  let best: AppSession | undefined;
  for (const a of Object.values(apps)) {
    if (a.deviceId !== e.deviceId) continue;
    if (a.app.id === proc || a.app.processName === proc || proc.startsWith(`${a.app.id}:`)) {
      if (!best || a.connectedAt > best.connectedAt) best = a;
    }
  }
  return best;
}

/**
 * The app the device reports for a line (SDK-less store / Firebase / TestFlight builds, and SDK apps on devices
 * that report their apps): by its session's bundle id, the named package, or the executable plus a live pid
 * (iOS lines name "Runner", which several apps share).
 */
export function deviceAppForEntry(e: LogEntry, deviceApps: Readonly<Record<string, DeviceApp>>, session?: AppSession): DeviceApp | undefined {
  if (session) {
    const own = deviceApps[`${session.deviceId}|${session.app.id}`];
    if (own) return own;
  }
  const pkg = entryPackage(e);
  if (!pkg) return undefined;
  const base = pkg.includes(':') ? pkg.slice(0, pkg.indexOf(':')) : pkg;
  const direct = deviceApps[`${e.deviceId}|${base}`];
  if (direct) return direct;
  if (e.pid !== undefined) {
    for (const d of Object.values(deviceApps)) if (d.deviceId === e.deviceId && d.processName === e.process && d.pids.includes(e.pid)) return d;
  }
  return undefined;
}

/** The app's display name for a line: the SDK's name, else the name the device reports, else its bundle id. */
export function entryAppName(e: LogEntry, apps: Readonly<Record<string, AppSession>>, deviceApps: Readonly<Record<string, DeviceApp>>): string | undefined {
  const session = sessionForEntry(e, apps);
  if (session?.app.name) return session.app.name;
  const da = deviceAppForEntry(e, deviceApps);
  return da ? da.name || da.id : undefined;
}
