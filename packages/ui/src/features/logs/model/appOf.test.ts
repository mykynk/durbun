import { describe, expect, it } from 'vitest';
import type { AppSession, DeviceApp, LogEntry } from '@durbun/protocol';
import '../../../i18n';
import { buildBadgeLabel } from '../../../sources/text';
import { shareAppLabel, shareInstallLabel } from '../../network/share';
import { deviceAppForEntry, entryAppName, entryPackage, sessionForEntry } from './appOf';

const PIXEL = 'android:R5CT20XK9QM';
const IPHONE = 'ios:00008130-0001A2B3C4D5E6F7';
let nextId = 1;
const line = (p: Partial<LogEntry> & { message: string }): LogEntry => ({ id: nextId++, ts: 1, deviceId: PIXEL, source: 'device', level: 'fatal', tag: 't', ...p });
const deviceApp = (deviceId: string, id: string, p: Partial<DeviceApp> = {}): DeviceApp => ({
  key: `${deviceId}|${id}`,
  deviceId,
  id,
  buildType: 'release',
  install: { source: 'play' },
  pids: [],
  running: true,
  lastActivity: 1,
  ...p,
});
const session = (p: Partial<AppSession['app']> = {}): AppSession => ({
  id: 'app:1',
  sessionKey: 's1',
  deviceId: PIXEL,
  sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter' },
  app: { name: 'Kumbara', id: 'com.mykynk.kumbara', ...p },
  transport: 'adb-reverse',
  connected: true,
  connectedAt: 1,
  capabilities: ['logs'],
  actions: [],
  stats: { logs: 0, requests: 0, errors: 0 },
});

describe('which app a device line belongs to (SDK-less builds)', () => {
  const store = deviceApp(PIXEL, 'com.mykynk.pati', { name: 'Pati', version: '2.4.0', build: '87' });
  const runner = deviceApp(IPHONE, 'com.mykynk.kumbara', { name: 'Kumbara', processName: 'Runner', pids: [412], install: { source: 'store-or-testflight' } });
  const apps = { [store.key]: store, [runner.key]: runner };

  it('reads the package from an ANR headline, a crash record or the process', () => {
    expect(entryPackage(line({ kind: 'anr', message: 'ANR in com.mykynk.pati (com.mykynk.pati/.MainActivity)' }))).toBe('com.mykynk.pati');
    expect(entryPackage(line({ kind: 'crash', message: 'x', data: { package: 'com.mykynk.pati' } }))).toBe('com.mykynk.pati');
    expect(entryPackage(line({ kind: 'crash', message: 'x', data: { bundleID: 'com.mykynk.kumbara' } }))).toBe('com.mykynk.kumbara');
    expect(entryPackage(line({ message: 'x', process: 'com.mykynk.pati:sync' }))).toBe('com.mykynk.pati:sync');
  });

  it('finds the reported app by package (a ":service" process too) or by executable + live pid', () => {
    expect(deviceAppForEntry(line({ kind: 'crash', message: 'x', process: 'com.mykynk.pati:sync' }), apps)).toBe(store);
    expect(deviceAppForEntry(line({ deviceId: IPHONE, kind: 'crash', message: 'x', process: 'Runner', pid: 412 }), apps)).toBe(runner);
    // Another app's "Runner" (another pid) is not this one.
    expect(deviceAppForEntry(line({ deviceId: IPHONE, kind: 'crash', message: 'x', process: 'Runner', pid: 9 }), apps)).toBeUndefined();
    expect(entryAppName(line({ kind: 'anr', message: 'ANR in com.mykynk.pati' }), {}, apps)).toBe('Pati');
  });

  it('an SDK session wins for the name; its own device app is found by bundle id', () => {
    const s = session();
    const own = deviceApp(PIXEL, 'com.mykynk.kumbara', { install: { source: 'firebase' } });
    const crash = line({ kind: 'crash', message: 'x', process: 'com.mykynk.kumbara' });
    expect(sessionForEntry(crash, { [s.id]: s })).toBe(s);
    expect(deviceAppForEntry(crash, { [own.key]: own }, s)).toBe(own);
  });
});

describe('the share report app line', () => {
  it('an SDK-less store build: name, version (build), bundle id and install source from the device', () => {
    const da = deviceApp(PIXEL, 'com.mykynk.pati', { name: 'Pati', version: '2.4.0', build: '87' });
    const install = shareInstallLabel(da, undefined, undefined);
    expect(install).toBe(buildBadgeLabel('play'));
    expect(shareAppLabel(undefined, da, install)).toBe(`Pati 2.4.0 (87) · com.mykynk.pati · ${install}`);
  });

  it('an SDK session fills in what the device does not report; the bundle id is not repeated as the name', () => {
    expect(shareAppLabel(session({ version: '1.2.0', build: '12' }))).toBe('Kumbara 1.2.0 (12) · com.mykynk.kumbara');
    expect(shareAppLabel(undefined, deviceApp(PIXEL, 'com.mykynk.pati'))).toBe('com.mykynk.pati');
    expect(shareAppLabel(undefined, undefined)).toBeUndefined();
  });
});
