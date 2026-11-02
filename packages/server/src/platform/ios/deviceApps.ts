/**
 * Physical iOS device apps via `xcrun devicectl` (SPEC §10.2):
 *   device info apps --device <udid>                     → developer apps (Xcode / flutter run / devicectl
 *                                                          installs): install 'xcode', buildType 'debug'
 *   device info apps --device <udid> --include-all-apps  → everything; removable third-party apps that are
 *                                                          not developer apps: 'store-or-testflight', 'release'
 *   device info processes --device <udid>                → pids (executable URL inside the app bundle URL)
 * iOS does not say whether a non-developer build came from the App Store, TestFlight or an ad-hoc
 * (Firebase) install, hence one combined source.
 */
import { posixBasename } from '../shared/text';
import type { AppSource, InstalledIosApp } from './appTracker';
import { isThirdPartyBundle } from './crashReport';
import { parseDevicectlApps, parseDevicectlProcesses, pidsForApp, type DevicectlApp, type DevicectlRunner } from './devicectl';

/** "file:///private/var/containers/Bundle/Application/X/My%20App.app/" → "My App". */
export function executableFromBundleUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let p = url.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep it encoded */
  }
  const base = posixBasename(p);
  return base.endsWith('.app') ? base.slice(0, -4) || undefined : undefined;
}

/** Combine the developer-only list and the all-apps list into installed third-party apps. */
export function classifyDevicectlApps(developer: DevicectlApp[] | null, all: DevicectlApp[] | null): InstalledIosApp[] {
  const devIds = developer ? new Set(developer.map((a) => a.bundleIdentifier)) : undefined;
  const byId = new Map<string, DevicectlApp>();
  for (const a of all ?? []) byId.set(a.bundleIdentifier, a);
  for (const a of developer ?? []) if (!byId.has(a.bundleIdentifier)) byId.set(a.bundleIdentifier, a);
  const out: InstalledIosApp[] = [];
  for (const a of byId.values()) {
    const isDev = devIds ? devIds.has(a.bundleIdentifier) : a.builtByDeveloper === true;
    if (!isThirdPartyBundle(a.bundleIdentifier)) continue;
    // System / internal / hidden apps and App Clips are not "the team's app".
    if (!isDev && (a.removable === false || a.internalApp === true || a.hidden === true || a.appClip === true)) continue;
    const executable = executableFromBundleUrl(a.url);
    out.push({
      id: a.bundleIdentifier,
      ...(a.name ? { name: a.name } : {}),
      ...(a.version ? { version: a.version } : {}),
      ...(a.bundleVersion ? { build: a.bundleVersion } : {}),
      buildType: isDev ? 'debug' : 'release',
      source: isDev ? 'xcode' : 'store-or-testflight',
      ...(executable ? { executable } : {}),
      ...(a.url ? { bundle: a.url } : {}),
    });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

export function devicectlAppSource(udid: string, devicectl: DevicectlRunner): AppSource {
  const dev = ['--device', udid];
  return {
    async listInstalled() {
      const developer = await devicectl(['device', 'info', 'apps', ...dev], 90_000);
      const all = await devicectl(['device', 'info', 'apps', ...dev, '--include-all-apps'], 90_000);
      if (!developer.ok && !all.ok) return null;
      return classifyDevicectlApps(developer.ok ? parseDevicectlApps(developer.json) : null, all.ok ? parseDevicectlApps(all.json) : null);
    },
    async listRunning(apps) {
      const r = await devicectl(['device', 'info', 'processes', ...dev], 60_000);
      if (!r.ok) return null;
      const processes = parseDevicectlProcesses(r.json);
      // Without executable paths pids cannot be matched to apps (keep what the logs told us).
      if (!processes.some((p) => p.executable)) return null;
      const out = new Map<string, number[]>();
      for (const a of apps) {
        if (!a.bundle) continue;
        const pids = pidsForApp(processes, a.bundle);
        if (pids.length) out.set(a.id, pids);
      }
      return out;
    },
  };
}
