import { describe, expect, it } from 'vitest';
import type { AppSession, DeviceApp, DeviceInfo } from '@durbun/protocol';
import { groupApps, type AppGroup } from '../data/stores/hub';
import { HOLD_MS, compareApps, createHoldMemory, layoutDeviceApps, orderDevices } from './sidebarModel';

const IPHONE = 'ios:00008130-000A1B2C3D4E5F60';
const PIXEL = 'android:R5CT20XK9QM';
const ALL = { kind: 'all' as const };

function da(id: string, p: Partial<DeviceApp> = {}): DeviceApp {
  return {
    key: `${p.deviceId ?? IPHONE}|${id}`,
    deviceId: IPHONE,
    id,
    buildType: 'release',
    install: { source: 'store-or-testflight' },
    pids: [],
    running: true,
    lastActivity: 0,
    ...p,
  };
}

function session(id: string, bundle: string, p: Partial<AppSession> = {}): AppSession {
  return {
    id,
    sessionKey: id,
    deviceId: PIXEL,
    sdk: { name: 'durbun-flutter', version: '0.3.0', platform: 'flutter' },
    app: { name: bundle.split('.').pop()!, id: bundle },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: 1,
    capabilities: ['logs'],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
    ...p,
  };
}

function device(id: string, firstSeen: number, state: DeviceInfo['state'] = 'online'): DeviceInfo {
  return { id, platform: 'ios', kind: 'physical', name: id, connection: 'usb', state, logs: { status: 'streaming' }, actions: [], firstSeen, lastSeen: firstSeen };
}

const names = (list: AppGroup[]) => list.map((g) => g.deviceApp?.name ?? g.bundleId);

/** The user's iPhone: 8 apps, two of them busy (active a moment ago), the rest suspended for an hour. */
function iphoneApps(now: number, running = true): AppGroup[] {
  const apps = [
    da('com.mykynk.kumbara', { name: 'Kumbara', running, lastActivity: now - 5_000 }),
    da('com.example.tasarruf', { name: 'Tasarruf Mobil', running, lastActivity: now - 20_000 }),
    ...['WhatsApp', 'Instagram', 'Slack', 'YouTube', 'Telegram', 'Chrome'].map((n, i) => da(`com.vendor.${n.toLowerCase()}`, { name: n, running, lastActivity: now - 3_600_000 - i })),
  ];
  return groupApps([], apps).get(IPHONE)!;
}

describe('sidebar layout: stable order', () => {
  it('orders by name, whatever is running or connected (an SDK reconnect never moves a row)', () => {
    const groups = groupApps(
      [session('app:1', 'com.mykynk.mahalle', { connected: false })],
      [
        da('com.mykynk.pati', { deviceId: PIXEL, key: `${PIXEL}|com.mykynk.pati`, name: 'Pati', running: true, lastActivity: 10 }),
        da('com.mykynk.kumbara', { deviceId: PIXEL, key: `${PIXEL}|com.mykynk.kumbara`, name: 'Kumbara', running: true, lastActivity: 99 }),
        da('com.mykynk.mahalle', { deviceId: PIXEL, key: `${PIXEL}|com.mykynk.mahalle`, name: 'Mahalle', running: false, lastActivity: 500 }),
      ],
    ).get(PIXEL)!;
    const layout = layoutDeviceApps(groups, ALL, 1_000_000, createHoldMemory());
    // groupApps puts running apps first; the sidebar does not.
    expect(groups.map((g) => g.bundleId)[2]).toBe('com.mykynk.mahalle');
    expect(layout.shown.map((g) => g.bundleId)).toEqual(['com.mykynk.kumbara', 'com.mykynk.mahalle', 'com.mykynk.pati']);
    expect([...groups].sort(compareApps).map((g) => g.bundleId)).toEqual(layout.shown.map((g) => g.bundleId));
  });
});

describe('sidebar layout: a flapping USB connection does not fold, unfold or reorder', () => {
  it('apps of an iPhone that just went away stay unfolded for a moment, then fold', () => {
    const memory = createHoldMemory();
    const t0 = 1_800_000_000_000;
    const before = layoutDeviceApps(iphoneApps(t0), ALL, t0, memory);
    expect(names(before.shown)).toEqual(['Kumbara', 'Tasarruf Mobil']);
    expect(before.folded).toHaveLength(6);
    // Unplugged: the hub marks every app "not running" at once.
    const off = layoutDeviceApps(iphoneApps(t0 + 1_000, false), ALL, t0 + 1_000, memory);
    expect(names(off.shown)).toEqual(['Kumbara', 'Tasarruf Mobil']); // regression: everything folded into "Son açılanlar"
    expect(off.wakeAt).toBe(t0 + 1_000 + HOLD_MS);
    // Plugged back in within the hold: nothing moved.
    const back = layoutDeviceApps(iphoneApps(t0 + 6_000), ALL, t0 + 6_000, memory);
    expect(names(back.shown)).toEqual(['Kumbara', 'Tasarruf Mobil']);
    expect(back.wakeAt).toBeUndefined();
    // Gone for good: after the hold the quiet rows fold.
    layoutDeviceApps(iphoneApps(t0 + 10_000, false), ALL, t0 + 10_000, memory);
    const later = layoutDeviceApps(iphoneApps(t0 + 10_000 + HOLD_MS, false), ALL, t0 + 10_000 + HOLD_MS, memory);
    expect(later.shown).toEqual([]);
    expect(later.folded).toHaveLength(8);
  });

  it('a re-attach that stamps every suspended app "just started" does not unfold them all (regression: 21 rows for 3 minutes)', () => {
    const t0 = 1_800_000_000_000;
    const attach = t0 - 2_000; // the iOS tracker pushes every running app with the same `now`
    const apps = [
      da('com.mykynk.kumbara', { name: 'Kumbara', lastActivity: t0 - 1_000 }), // a real log line after the attach
      da('com.fortfall.game', { name: 'FORTFALL', install: { source: 'xcode' }, buildType: 'debug', lastActivity: attach }),
      ...['WhatsApp', 'Instagram', 'Slack', 'YouTube', 'Telegram', 'Chrome'].map((n) => da(`com.vendor.${n.toLowerCase()}`, { name: n, lastActivity: attach })),
    ];
    const layout = layoutDeviceApps(groupApps([], apps).get(IPHONE)!, ALL, t0, createHoldMemory());
    expect(names(layout.shown)).toEqual(['FORTFALL', 'Kumbara']);
    expect(layout.folded).toHaveLength(6);
  });

  // Regression: the hub stamps every app of one ~50 ms log batch with the same time (DeviceAppStore.noteLogs), and
  // three apps sharing a millisecond were taken for a re-attach and folded while they were logging.
  it('apps that log in the same batch stay unfolded', () => {
    const t0 = 1_800_000_000_000;
    const batch = t0 - 1_000;
    const apps = [
      ...['WhatsApp', 'X', 'Instagram'].map((n) => da(`com.vendor.${n.toLowerCase()}`, { name: n, lastActivity: batch })),
      ...['Slack', 'YouTube', 'Telegram'].map((n, i) => da(`com.vendor.${n.toLowerCase()}`, { name: n, lastActivity: t0 - 3_600_000 - i })),
    ];
    const layout = layoutDeviceApps(groupApps([], apps).get(IPHONE)!, ALL, t0, createHoldMemory());
    expect(names(layout.shown)).toEqual(['Instagram', 'WhatsApp', 'X']);
    expect(names(layout.folded)).toEqual(['Slack', 'Telegram', 'YouTube']);
  });

  // Regression: with the shared-time rule limited to crowded phones (≥ 5 apps and half of the running ones), the
  // three suspended apps an iPhone re-listed right after it came back stayed unfolded for 3 minutes.
  it('a few apps stamped together right after the device came back online fold; the same batch later does not', () => {
    const memory = createHoldMemory();
    const t0 = 1_800_000_000_000;
    const iphone = device(IPHONE, 1);
    orderDevices([iphone], t0, memory);
    orderDevices([{ ...iphone, state: 'disconnected' }], t0 + 5_000, memory);
    const back = t0 + 60_000;
    orderDevices([iphone], back, memory);
    const listing = back + 1_500; // the tracker's first process listing after the attach
    const apps = (stamps: Record<string, number>) =>
      groupApps(
        [],
        ['Kumbara', 'WhatsApp', 'Instagram', 'Slack', 'YouTube', 'Telegram', 'Chrome', 'X'].map((n, i) =>
          da(`com.vendor.${n.toLowerCase()}`, { name: n, lastActivity: stamps[n] ?? back - 3_600_000 - i }),
        ),
      ).get(IPHONE)!;
    const attached = layoutDeviceApps(apps({ WhatsApp: listing, Instagram: listing, Slack: listing, Kumbara: back + 3_000 }), ALL, back + 4_000, memory);
    expect(names(attached.shown)).toEqual(['Kumbara']);
    expect(attached.folded).toHaveLength(7);
    // A minute later the same three log in one batch: real activity, far from the attach.
    const batch = back + 60_000;
    const later = layoutDeviceApps(apps({ WhatsApp: batch, Instagram: batch, Slack: batch, Kumbara: batch - 500 }), ALL, batch + 500, memory);
    expect(names(later.shown)).toEqual(['Instagram', 'Kumbara', 'Slack', 'WhatsApp']);
    // A device that has been online all along (first seen long ago) has no attach window at all.
    const steady = createHoldMemory();
    orderDevices([iphone], back, steady);
    expect(names(layoutDeviceApps(apps({ WhatsApp: listing, Instagram: listing, Slack: listing, Kumbara: back + 3_000 }), ALL, back + 4_000, steady).shown)).toEqual([
      'Instagram',
      'Kumbara',
      'Slack',
      'WhatsApp',
    ]);
  });

  it('after a re-attach, apps that log get unfolded and the rest stay folded (the attach time is remembered)', () => {
    const memory = createHoldMemory();
    const t0 = 1_800_000_000_000;
    const attach = t0;
    const vendors = Array.from({ length: 18 }, (_, i) => `App ${String(i + 1).padStart(2, '0')}`);
    const appsAt = (logged: Record<string, number>) =>
      groupApps([], vendors.map((n) => da(`com.vendor.app${n.slice(4)}`, { name: n, lastActivity: logged[n] ?? attach }))).get(IPHONE)!;
    // The attach stamps all 18 running apps with one time: they fold.
    const first = layoutDeviceApps(appsAt({}), ALL, attach + 1_000, memory);
    expect(first.shown).toEqual([]);
    expect(first.folded).toHaveLength(18);
    // A minute later three of them log in one batch.
    const batch = attach + 60_000;
    const later = layoutDeviceApps(appsAt({ 'App 02': batch, 'App 07': batch, 'App 11': batch }), ALL, batch + 1_000, memory);
    expect(names(later.shown)).toEqual(['App 02', 'App 07', 'App 11']);
    expect(later.folded).toHaveLength(15);
    // Even when most of them have logged since, the ones still carrying the attach time stay folded.
    const logged = Object.fromEntries(vendors.slice(0, 12).map((n, i) => [n, batch + 1_000 + i]));
    const most = layoutDeviceApps(appsAt(logged), ALL, batch + 20_000, memory);
    expect(most.shown).toHaveLength(12);
    expect(names(most.folded)).toEqual(vendors.slice(12));
  });

  it('a device that just disconnected keeps its place among the devices', () => {
    const memory = createHoldMemory();
    const t0 = 1_800_000_000_000;
    const a = device('ios:aaaa', 1);
    const b = device('android:bbbb', 2);
    expect(orderDevices([b, a], t0, memory).devices.map((d) => d.id)).toEqual(['ios:aaaa', 'android:bbbb']);
    const gone = orderDevices([b, { ...a, state: 'disconnected' }], t0 + 500, memory);
    expect(gone.devices.map((d) => d.id)).toEqual(['ios:aaaa', 'android:bbbb']); // regression: jumped below
    expect(gone.wakeAt).toBe(t0 + 500 + HOLD_MS);
    const settled = orderDevices([b, { ...a, state: 'disconnected' }], t0 + 500 + HOLD_MS, memory);
    expect(settled.devices.map((d) => d.id)).toEqual(['android:bbbb', 'ios:aaaa']);
    // A device that was never seen connected goes straight to its place.
    expect(orderDevices([device('ios:cccc', 0, 'disconnected'), b], t0, createHoldMemory()).devices.map((d) => d.id)).toEqual(['android:bbbb', 'ios:cccc']);
  });
});
