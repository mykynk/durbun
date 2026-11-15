import { exportUrl } from '../../data/api';
import { compileScope, scopeLogTotal, scopeNetworkCounts } from '../../data/scope';
import { logStore } from '../../data/logStore';
import { networkStore } from '../../data/networkStore';
import { DESKTOP_DEVICE_ID, useHub, type HubState } from '../../data/stores/hub';
import type { Scope } from '../../data/stores/scope';

/**
 * Session recordings and HAR files leave the Mac (a Jira ticket, a chat): they are masked by default — the server
 * writes `••••` for credential headers, cookies, token / password / session fields and query keys, and marks the
 * file (`masked: true`, HAR `log._durbun.masked`). A raw file is a deliberate choice in the export dialog.
 */

/**
 * What the server exports for a scope: a device; one app on its device (`deviceId` + `bundleId`: every session of
 * the app plus its device lines, as the app scope shows them); one session only (an "earlier session" scope, exact).
 */
export function scopeExportParams(scope: Scope, hub: Pick<HubState, 'apps'> = useHub.getState()): { deviceId?: string; appId?: string; bundleId?: string } {
  if (scope.kind === 'device') return { deviceId: scope.deviceId };
  if (scope.kind === 'app') {
    const app = hub.apps[scope.appId];
    if (!scope.exact && app) return { deviceId: app.deviceId, bundleId: app.app.id };
    return { deviceId: app?.deviceId, appId: scope.appId };
  }
  // An SDK-less app has no session id on the server: the device + bundle id name it ("Export “Kumbara”" holds
  // Kumbara only, never the other apps' lines of that phone).
  if (scope.kind === 'deviceApp') return { deviceId: scope.deviceId, bundleId: scope.bundleId };
  return {};
}

/** `GET /api/export` for a scope; `mask: false` only when the user chose a raw file. */
export function sessionExportUrl(scope: Scope, mask: boolean): string {
  return exportUrl({ ...(scope.kind === 'all' ? {} : scopeExportParams(scope)), ...(mask ? {} : { mask: false }) });
}

export interface ExportCounts {
  logs: number;
  requests: number;
  /** Devices in the file (virtual ones aside). */
  devices: number;
}

/** What a session export of this scope holds, from the UI's copy of the server's buffers. */
export function scopeExportCounts(scope: Scope, hub: Pick<HubState, 'apps' | 'devices' | 'deviceApps' | 'processes'> = useHub.getState()): ExportCounts {
  const compiled = compileScope(scope, hub);
  const devices = scope.kind === 'all' ? Object.keys(hub.devices).filter((id) => id !== DESKTOP_DEVICE_ID).length : 1;
  // Every scope's file holds what the scope shows, the device's connect / log-stream lines included.
  return { logs: scopeLogTotal(compiled, logStore), requests: scopeNetworkCounts(compiled, networkStore).total, devices };
}

/** Request ids a HAR of this scope holds; undefined = every request (the "all" scope). */
export function scopeHarIds(scope: Scope, hub: Pick<HubState, 'apps' | 'devices' | 'deviceApps' | 'processes'> = useHub.getState()): string[] | undefined {
  if (scope.kind === 'all') return undefined;
  const compiled = compileScope(scope, hub);
  const ids: string[] = [];
  for (const e of networkStore.list()) if (compiled.network(e)) ids.push(e.id);
  return ids;
}

export function harFileStamp(now = new Date()): string {
  return `durbun-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.har`;
}

/**
 * Whether a session file says it was masked. The server writes `masked` as the last member of the file (after the
 * logs and requests), so the tail is read; a head check covers a writer that puts it first. Reads at most 8 KB.
 */
export async function isMaskedSessionFile(file: Blob): Promise<boolean> {
  try {
    const tail = await file.slice(Math.max(0, file.size - 4096)).text();
    if (/"masked"\s*:\s*true\s*\}\s*$/.test(tail)) return true;
    const head = await file.slice(0, 4096).text();
    // Before the first list only top-level members appear.
    const top = head.split(/"(?:devices|apps|logs|network)"\s*:/)[0] ?? '';
    return /"masked"\s*:\s*true/.test(top);
  } catch {
    return false;
  }
}
