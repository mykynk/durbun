/**
 * "Is this one of the team's own apps?" Build advice — run a debug build, turn the SDK
 * on with the DURBUN flag, set up the SDK — only makes sense for apps whose source the team has. A tester's phone
 * is full of other apps (WhatsApp, Instagram, a bank…): those get the plain "what the device shows from outside"
 * explanation instead. Pure; the UI computes the index from the hub and passes `ExplainInput.own`.
 */
import type { AppSession, DeviceApp } from '@durbun/protocol';
import { otherStoreKind } from './explain';

/** What makes apps the team's own: bundle ids with direct evidence, and their reverse-domain prefixes. */
export interface OwnAppIndex {
  /** Apps that ever had an SDK / VM-service session, or a developer / internal install, on any device. */
  bundles: ReadonlySet<string>;
  /** First two labels of those bundle ids ("com.mykynk"). */
  prefixes: ReadonlySet<string>;
}

/**
 * Reverse-domain prefix of a bundle id / package: its first two labels, lower case ("com.mykynk.kumbara" →
 * "com.mykynk"). Undefined for ids without two labels ("Runner").
 */
export function bundlePrefix(id: string): string | undefined {
  const parts = id.split('.');
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  return `${parts[0]}.${parts[1]}`.toLowerCase();
}

/**
 * Installed the way only the team installs its own builds: Xcode / devicectl / flutter run, adb / Android Studio,
 * the simulator, Firebase App Distribution, an APK opened by hand. Store installs (Play, App Store / TestFlight /
 * ad-hoc, other stores) say nothing either way.
 */
export function isDeveloperInstall(d: Pick<DeviceApp, 'install'>): boolean {
  switch (d.install.source) {
    case 'xcode':
    case 'adb':
    case 'simulator':
    case 'firebase':
      return true;
    case 'other-store':
      return otherStoreKind(d.install.installer) === 'manual';
    default:
      return false;
  }
}

/** Index of the team's own apps from everything the hub knows (sessions of every device, every device app). */
export function ownAppIndex(sessions: Iterable<Pick<AppSession, 'app'>>, deviceApps: Iterable<Pick<DeviceApp, 'id' | 'install'>>): OwnAppIndex {
  const bundles = new Set<string>();
  for (const s of sessions) if (s.app.id) bundles.add(s.app.id);
  for (const d of deviceApps) if (isDeveloperInstall(d)) bundles.add(d.id);
  const prefixes = new Set<string>();
  for (const b of bundles) {
    const p = bundlePrefix(b);
    if (p) prefixes.add(p);
  }
  return { bundles, prefixes };
}

/**
 * The app is plausibly the team's: it had an SDK / VM session or a developer / internal install somewhere, or it
 * shares a reverse-domain prefix with such an app (a TestFlight build of com.mykynk.kumbara next to a debug
 * build of com.mykynk.pati).
 */
export function isOwnApp(bundleId: string, index: OwnAppIndex): boolean {
  if (index.bundles.has(bundleId)) return true;
  const p = bundlePrefix(bundleId);
  return p !== undefined && index.prefixes.has(p);
}
