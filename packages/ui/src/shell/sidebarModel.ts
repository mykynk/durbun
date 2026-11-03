/**
 * Sidebar layout rules (pure): which app rows stay unfolded on a crowded device, in which order, and how rows keep
 * their place while a device or an app flickers (a loose USB cable, an app restarting after a crash). Rows must not
 * jump under the pointer while the user is watching the stream.
 */
import type { DeviceInfo } from '@durbun/protocol';
import { appGroupName, sortDevices, type AppGroup } from '../data/stores/hub';
import type { Scope } from '../data/stores/scope';

/** Above this many apps on one device, the quiet ones fold into "N uygulama daha" / "Son açılanlar". */
export const FOLD_ABOVE = 5;

/** A third-party app counts as active this long after its last log line / process event. */
export const ACTIVE_MS = 3 * 60_000;

/**
 * How long a row keeps its place after it stops being prominent (an app) or connected (a device). Covers a USB
 * re-attach (usbmuxd re-lists the apps a few seconds after the device comes back) and an app's crash-restart.
 */
export const HOLD_MS = 15_000;

/**
 * What the sidebar remembers between renders (one per mounted sidebar): rows that were prominent / connected at
 * the last layout, and until when a row that stopped being so keeps its place.
 */
export interface HoldMemory {
  was: Set<string>;
  until: Map<string, number>;
  /** deviceId → activity times found to be bulk stamps (`bulkStamps`), remembered while they could still count as activity. */
  bulk: Map<string, Set<number>>;
  /** deviceId → whether it was online at the last layout (`orderDevices`). */
  online: Map<string, boolean>;
  /**
   * deviceId → when it last turned online: the layout that saw the change, or `firstSeen` for a device that was
   * already online when the sidebar first saw it.
   */
  onlineAt: Map<string, number>;
}

export function createHoldMemory(): HoldMemory {
  return { was: new Set(), until: new Map(), bulk: new Map(), online: new Map(), onlineAt: new Map() };
}

/**
 * Whether a row keeps its "on" place: on now, or it was on at the last layout (its hold starts now), or its hold
 * has not run out. Records the transition in `memory`; `wake` collects when a hold runs out.
 */
function held(memory: HoldMemory, key: string, on: boolean, now: number, wake: { at?: number }): boolean {
  if (on) {
    memory.was.add(key);
    memory.until.delete(key);
    return true;
  }
  if (memory.was.delete(key)) memory.until.set(key, now + HOLD_MS);
  const until = memory.until.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    memory.until.delete(key);
    return false;
  }
  wake.at = Math.min(wake.at ?? Infinity, until);
  return true;
}

export function isGroupSelected(g: AppGroup, scope: Scope): boolean {
  if (scope.kind === 'deviceApp') return scope.deviceId === g.deviceId && scope.bundleId === g.bundleId;
  return scope.kind === 'app' && g.sessions.some((s) => s.id === scope.appId);
}

/** A bulk stamp covers at least this many apps of one device, and at least half of its running apps. */
const BULK_STAMP_MIN = 5;

/** Right after the device came online, a time shared by this many running apps is the driver's attach stamp. */
const ATTACH_STAMP_MIN = 3;

/**
 * How long after the device turned online its driver's first app listing lands (the iOS tracker runs two devicectl
 * calls before it stamps the running apps), and how early it may look from here (the sidebar notices the state a
 * render later). Apps that really log in this window fold for a moment at most: their next batch is outside it.
 */
const ATTACH_AFTER_MS = 5_000;
const ATTACH_BEFORE_MS = 2_000;

/**
 * Activity times the driver stamped on many of a device's apps at once: an iPhone attaching or re-attaching reports
 * every suspended app as just started (a tester's phone: 20+ apps). Equal milliseconds alone prove nothing: the hub
 * stamps every app of one log batch (~50 ms) with the same time, so three apps logging together share one. So a
 * shared time counts when it falls right after the device's last transition to online (`onlineAt`), or when it
 * covers most running apps of a crowded phone (a log batch practically never does: suspended / cached apps do not
 * log).
 */
export function bulkStamps(groups: readonly AppGroup[], onlineAt?: number): Set<number> {
  const seen = new Map<number, number>();
  let running = 0;
  for (const g of groups) {
    if (!g.running) continue;
    running++;
    if (g.lastActivity > 0) seen.set(g.lastActivity, (seen.get(g.lastActivity) ?? 0) + 1);
  }
  const attach = (ts: number) => onlineAt !== undefined && ts >= onlineAt - ATTACH_BEFORE_MS && ts <= onlineAt + ATTACH_AFTER_MS;
  return new Set([...seen].filter(([ts, n]) => (n >= BULK_STAMP_MIN && n * 2 >= running) || (n >= ATTACH_STAMP_MIN && attach(ts))).map(([ts]) => ts));
}

/**
 * `bulkStamps` of this device plus the ones found earlier: once some of the stamped apps log again (and get their
 * own time), the rest still carry the attach time but no longer make up a bulk on their own.
 */
function rememberBulk(memory: HoldMemory, deviceId: string, groups: readonly AppGroup[], now: number): Set<number> {
  const found = bulkStamps(groups, memory.onlineAt.get(deviceId));
  const known = memory.bulk.get(deviceId);
  if (known) {
    for (const ts of known) if (now - ts < ACTIVE_MS) found.add(ts);
  }
  if (found.size > 0) memory.bulk.set(deviceId, found);
  else memory.bulk.delete(deviceId);
  return found;
}

/**
 * Rows a crowded device keeps unfolded: apps connected to Dürbün, the selected one, running developer builds and
 * apps active in the last minutes. "Running" alone is not enough: iOS keeps suspended apps as processes and
 * Android keeps cached ones, so a tester's phone reports dozens of store apps as running. Activity the driver
 * stamped on most apps at once (`bulk`, a USB re-attach) does not count.
 */
export function isProminentApp(g: AppGroup, scope: Scope, now: number, bulk?: ReadonlySet<number>): boolean {
  if (g.connected || isGroupSelected(g, scope)) return true;
  if (!g.running) return false;
  const da = g.deviceApp;
  if (da && (da.buildType === 'debug' || da.install.source === 'xcode' || da.install.source === 'simulator')) return true;
  return now - g.lastActivity < ACTIVE_MS && !bulk?.has(g.lastActivity);
}

/**
 * Stable order of a device's apps: by name, then bundle id. Running state and activity only show in the row (the
 * dot, dimming), so a log line, an SDK reconnect or a crash never moves a row.
 */
export function compareApps(a: AppGroup, b: AppGroup): number {
  return appGroupName(a).localeCompare(appGroupName(b)) || a.bundleId.localeCompare(b.bundleId);
}

export interface DeviceAppsLayout {
  /** Rows shown (all of them when the device has few apps), in stable order. */
  shown: AppGroup[];
  /** Rows folded under "N uygulama daha", in stable order. */
  folded: AppGroup[];
  /** When a held row's hold runs out (render again then), epoch ms. */
  wakeAt?: number;
}

/** Shown / folded rows of one device. A row that stops being prominent stays shown for `HOLD_MS`. */
export function layoutDeviceApps(groups: readonly AppGroup[], scope: Scope, now: number, memory: HoldMemory): DeviceAppsLayout {
  const sorted = [...groups].sort(compareApps);
  const wake: { at?: number } = {};
  const on = new Set<AppGroup>();
  const bulk = sorted.length > 0 ? rememberBulk(memory, sorted[0]!.deviceId, sorted, now) : new Set<number>();
  for (const g of sorted) if (held(memory, `a:${g.key}`, isProminentApp(g, scope, now, bulk), now, wake)) on.add(g);
  if (sorted.length <= FOLD_ABOVE) return { shown: sorted, folded: [], wakeAt: wake.at };
  return { shown: sorted.filter((g) => on.has(g)), folded: sorted.filter((g) => !on.has(g)), wakeAt: wake.at };
}

/**
 * Devices in sidebar order (`sortDevices`: live → demo → imported → other, connected first, then first seen). A
 * device that disconnected less than `HOLD_MS` ago keeps its place, so a flapping USB connection does not move it.
 */
export function orderDevices(devices: Iterable<DeviceInfo>, now: number, memory: HoldMemory): { devices: DeviceInfo[]; wakeAt?: number } {
  const list = [...devices];
  const wake: { at?: number } = {};
  const stays = new Set<string>();
  for (const d of list) {
    noteOnline(memory, d, now);
    if (held(memory, `d:${d.id}`, d.state !== 'disconnected', now, wake)) stays.add(d.id);
  }
  if (memory.online.size > list.length) {
    const ids = new Set(list.map((d) => d.id));
    for (const id of [...memory.online.keys()]) {
      if (ids.has(id)) continue;
      memory.online.delete(id);
      memory.onlineAt.delete(id);
    }
  }
  return { devices: sortDevices(list, { gone: (d) => !stays.has(d.id) }), wakeAt: wake.at };
}

/** Records when a device turns online (plugged back in, "Trust" accepted): its driver stamps the apps it lists then. */
function noteOnline(memory: HoldMemory, d: DeviceInfo, now: number): void {
  const on = d.state === 'online';
  const was = memory.online.get(d.id);
  if (on && was === false) memory.onlineAt.set(d.id, now);
  // Online already when first seen: since `firstSeen` if it just appeared, else long enough to make no difference.
  else if (on && was === undefined && Number.isFinite(d.firstSeen)) memory.onlineAt.set(d.id, Math.min(d.firstSeen, now));
  memory.online.set(d.id, on);
}
