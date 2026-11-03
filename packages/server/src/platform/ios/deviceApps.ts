/**
 * Physical iOS device apps via `xcrun devicectl` (SPEC §10.2):
 *   device info apps --device <udid>                     → developer apps (Xcode / flutter run / devicectl
 *                                                          installs): install 'xcode', buildType 'debug'
 *   device info apps --device <udid> --include-all-apps  → everything; removable third-party apps that are
 *                                                          not developer apps: 'store-or-testflight', 'release'
 *   device info processes --device <udid>                → pids (executable URL inside the app bundle URL;
 *                                                          app extensions live in <App>.app/PlugIns/X.appex/)
 * iOS does not say whether a non-developer build came from the App Store, TestFlight or an ad-hoc
 * (Firebase) install, hence one combined source.
 *
 * A process whose executable lies in an app container (/private/var/containers/Bundle/Application/<UUID>/X.app/)
 * that no app of the last listing owns belongs to an app installed since then (Apple's removable apps are in
 * the listing too): `unlistedApps` names it, so the tracker can relist and keep its lines meanwhile. Every
 * other process (outside app containers, or in an Apple app's) is a system process: `systemNames`.
 */
import { posixBasename } from '../shared/text';
import type { AppSource, InstalledIosApp, UnlistedAppProcess } from './appTracker';
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

/** "file:///…/Runner.app/PlugIns/My%20Widget.appex/My%20Widget" → "My Widget" (the process name in logs). */
export function processNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let p = url.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep it encoded */
  }
  return posixBasename(p.replace(/\/+$/, '')) || undefined;
}

/** Decoded file URL / path without "file://" and "/private" ("/var/containers/…"). */
function plainPath(url: string): string {
  let p = url.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep it encoded */
  }
  return p.replace(/^\/private\//, '/');
}

const APP_CONTAINER = /^(\/var\/containers\/Bundle\/Application\/[^/]+\/[^/]+\.app)(?:\/|$)/;

/**
 * App bundle in an app container an executable or bundle URL lies in:
 * "file:///private/var/containers/Bundle/Application/X/Runner.app/PlugIns/W.appex/W" →
 * "/var/containers/Bundle/Application/X/Runner.app". Undefined for system apps and daemons (/Applications,
 * /System, /usr …).
 */
export function appContainerOf(url: string | undefined): string | undefined {
  return url ? APP_CONTAINER.exec(plainPath(url))?.[1] : undefined;
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
  let names: ReadonlyMap<number, string> = new Map();
  /** App bundles of the last listing that included all apps (Apple's too); undefined when it failed. */
  let listedBundles: ReadonlySet<string> | undefined;
  /** The Apple apps' bundles among them (Fitness, Health … live in app containers too). */
  let appleBundles: ReadonlySet<string> = new Set();
  let unlisted: ReadonlyMap<number, UnlistedAppProcess> = new Map();
  let system: ReadonlySet<string> = new Set();
  return {
    async listInstalled() {
      const developer = await devicectl(['device', 'info', 'apps', ...dev], 90_000);
      const all = await devicectl(['device', 'info', 'apps', ...dev, '--include-all-apps'], 90_000);
      if (!developer.ok && !all.ok) return null;
      const devApps = developer.ok ? parseDevicectlApps(developer.json) : null;
      const allApps = all.ok ? parseDevicectlApps(all.json) : null;
      // Without the all-apps list a process in an app container may well be an Apple app: no guessing.
      listedBundles = allApps
        ? new Set([...allApps, ...(devApps ?? [])].map((a) => appContainerOf(a.url)).filter((b): b is string => !!b))
        : undefined;
      appleBundles = new Set(
        (allApps ?? [])
          .filter((a) => !isThirdPartyBundle(a.bundleIdentifier))
          .map((a) => appContainerOf(a.url))
          .filter((b): b is string => !!b),
      );
      return classifyDevicectlApps(devApps, allApps);
    },
    async listRunning(apps) {
      const r = await devicectl(['device', 'info', 'processes', ...dev], 60_000);
      if (!r.ok) return null;
      const processes = parseDevicectlProcesses(r.json);
      // Without executable paths pids cannot be matched to apps (keep what the logs told us).
      if (!processes.some((p) => p.executable)) return null;
      const out = new Map<string, number[]>();
      const executables = new Map(processes.map((p) => [p.pid, p.executable]));
      const seen = new Map<number, string>();
      for (const a of apps) {
        if (!a.bundle) continue;
        const pids = pidsForApp(processes, a.bundle);
        if (pids.length) out.set(a.id, pids);
        for (const pid of pids) {
          const name = processNameFromUrl(executables.get(pid));
          if (name) seen.set(pid, name);
        }
      }
      names = seen;
      const fresh = new Map<number, UnlistedAppProcess>();
      if (listedBundles) {
        for (const p of processes) {
          const bundle = appContainerOf(p.executable);
          if (!bundle || listedBundles.has(bundle)) continue;
          const name = processNameFromUrl(p.executable);
          fresh.set(p.pid, { bundle, ...(name ? { name } : {}) });
        }
      }
      unlisted = fresh;
      const sys = new Set<string>();
      for (const p of processes) {
        const bundle = appContainerOf(p.executable);
        if (bundle && !appleBundles.has(bundle)) continue;
        const name = processNameFromUrl(p.executable);
        if (name) sys.add(name);
      }
      system = sys;
      return out;
    },
    runningNames: () => names,
    unlistedApps: () => unlisted,
    systemNames: () => system,
  };
}
