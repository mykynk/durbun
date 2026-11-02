import { readFileSync } from 'node:fs';
import type { AppSession, DeviceInfo, LogEntry } from '@durbun/protocol';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS_BY_ID,
  availableActions,
  buildActionDescriptors,
  FLUTTER_ACTIONS,
  nativeTargetPlatform,
  resolveRequestedValue,
  valueFromResponse,
  valueFromStateChange,
  writeParams,
} from '../../src/platform/flutterVm/actions';
import {
  appBundleDir,
  cleanProcessName,
  deriveAppInfo,
  deviceHintsFor,
  looksLikeBundleId,
  packageNameFromLibraryUri,
  sdkSessionForPid,
  simulatorUdidFromPath,
  uniqueOnlineDevice,
} from '../../src/platform/flutterVm/appInfo';
import {
  collectAnnouncements,
  isAutoAttachDevice,
  isFreshAnnouncement,
  needsPortForward,
  ProcessNameCache,
} from '../../src/platform/flutterVm/autoAttach';
import { routeLabel } from '../../src/platform/flutterVm/session';

const isolate = JSON.parse(readFileSync(new URL('./fixtures/isolate.json', import.meta.url), 'utf8')) as {
  extensionRPCs: string[];
  rootLib: { uri: string };
};
const spec = (id: string) => ACTIONS_BY_ID.get(id)!;
const ctx = { nativePlatform: 'android' };

describe('Flutter actions', () => {
  it('advertises exactly the SPEC §5.6 ids', () => {
    expect(FLUTTER_ACTIONS.map((a) => a.id)).toEqual([
      'flutter.debugPaint',
      'flutter.repaintRainbow',
      'flutter.slowAnimations',
      'flutter.performanceOverlay',
      'flutter.invertOversizedImages',
      'flutter.brightness',
      'flutter.platform',
      'flutter.dumpWidgetTree',
      'flutter.dumpRenderTree',
    ]);
  });

  it('only lists actions whose extension is registered (recorded isolate)', () => {
    const exts = new Set(isolate.extensionRPCs);
    expect(availableActions(exts).map((a) => a.id)).toEqual(['flutter.debugPaint', 'flutter.slowAnimations', 'flutter.dumpWidgetTree']);
    const descriptors = buildActionDescriptors(exts, new Map([['flutter.debugPaint', true]]));
    expect(descriptors[0]).toEqual({
      id: 'flutter.debugPaint',
      kind: 'toggle',
      label: 'Debug paint',
      labelKey: 'flutter.debugPaint',
      group: 'flutter',
      value: true,
    });
    expect(descriptors[1]).not.toHaveProperty('value');
  });

  it('a full debug build (Flutter 3.38 extension names) gets all actions', () => {
    const exts = new Set([
      'ext.flutter.debugPaint',
      'ext.flutter.repaintRainbow',
      'ext.flutter.timeDilation',
      'ext.flutter.showPerformanceOverlay',
      'ext.flutter.invertOversizedImages',
      'ext.flutter.brightnessOverride',
      'ext.flutter.platformOverride',
      'ext.flutter.debugDumpApp',
      'ext.flutter.debugDumpRenderTree',
    ]);
    const d = buildActionDescriptors(exts, new Map());
    expect(d).toHaveLength(9);
    expect(d.find((a) => a.id === 'flutter.brightness')!.options!.map((o) => o.value)).toEqual(['system', 'light', 'dark']);
    expect(d.find((a) => a.id === 'flutter.platform')!.options!.map((o) => o.value)).toEqual(['default', 'android', 'iOS', 'macOS']);
  });

  it('resolves requested values', () => {
    expect(resolveRequestedValue(spec('flutter.debugPaint'), { value: true }, false)).toEqual({ ok: true, value: true });
    expect(resolveRequestedValue(spec('flutter.debugPaint'), { enabled: 'false' }, true)).toEqual({ ok: true, value: false });
    expect(resolveRequestedValue(spec('flutter.debugPaint'), undefined, true)).toEqual({ ok: true, value: false });
    expect(resolveRequestedValue(spec('flutter.debugPaint'), {}, undefined)).toEqual({ ok: true, value: true });
    expect(resolveRequestedValue(spec('flutter.debugPaint'), { value: 'maybe' }, true).ok).toBe(false);
    expect(resolveRequestedValue(spec('flutter.brightness'), { value: 'Dark' }, undefined)).toEqual({ ok: true, value: 'dark' });
    expect(resolveRequestedValue(spec('flutter.brightness'), { value: 'Brightness.light' }, undefined)).toEqual({ ok: true, value: 'light' });
    expect(resolveRequestedValue(spec('flutter.brightness'), { option: 'default' }, undefined)).toEqual({ ok: true, value: 'system' });
    expect(resolveRequestedValue(spec('flutter.brightness'), { value: 'sepia' }, undefined).ok).toBe(false);
    expect(resolveRequestedValue(spec('flutter.platform'), { value: 'ios' }, undefined)).toEqual({ ok: true, value: 'iOS' });
    expect(resolveRequestedValue(spec('flutter.platform'), { value: 'Default' }, undefined)).toEqual({ ok: true, value: 'default' });
    expect(resolveRequestedValue(spec('flutter.platform'), {}, undefined).ok).toBe(false);
    expect(resolveRequestedValue(spec('flutter.dumpWidgetTree'), undefined, undefined)).toEqual({ ok: true });
  });

  it('writes extension parameters as strings, in the shape the framework parses', () => {
    expect(writeParams(spec('flutter.debugPaint'), true)).toEqual({ enabled: 'true' });
    expect(writeParams(spec('flutter.performanceOverlay'), false)).toEqual({ enabled: 'false' });
    expect(writeParams(spec('flutter.slowAnimations'), true)).toEqual({ timeDilation: '5.0' });
    expect(writeParams(spec('flutter.slowAnimations'), false)).toEqual({ timeDilation: '1.0' });
    expect(writeParams(spec('flutter.brightness'), 'dark')).toEqual({ value: 'Brightness.dark' });
    expect(writeParams(spec('flutter.brightness'), 'system')).toEqual({ value: 'default' });
    expect(writeParams(spec('flutter.platform'), 'iOS')).toEqual({ value: 'iOS' });
    expect(writeParams(spec('flutter.dumpRenderTree'), undefined)).toEqual({});
  });

  it('reads values from extension responses', () => {
    expect(valueFromResponse(spec('flutter.debugPaint'), { enabled: 'true', type: '_extensionType' }, ctx)).toBe(true);
    expect(valueFromResponse(spec('flutter.slowAnimations'), { timeDilation: '5.0' }, ctx)).toBe(true);
    expect(valueFromResponse(spec('flutter.slowAnimations'), { timeDilation: '1.0' }, ctx)).toBe(false);
    expect(valueFromResponse(spec('flutter.platform'), { value: 'android' }, ctx)).toBe('default');
    expect(valueFromResponse(spec('flutter.platform'), { value: 'iOS' }, ctx)).toBe('iOS');
    expect(valueFromResponse(spec('flutter.platform'), { value: 'android' }, ctx, 'android')).toBe('android');
    expect(valueFromResponse(spec('flutter.brightness'), { value: 'Brightness.light' }, ctx)).toBe('system');
    expect(valueFromResponse(spec('flutter.brightness'), { value: 'Brightness.dark' }, ctx, 'dark')).toBe('dark');
  });

  it('follows Flutter.ServiceExtensionStateChanged events from other tools', () => {
    expect(valueFromStateChange('ext.flutter.debugPaint', 'true', ctx)).toEqual({ id: 'flutter.debugPaint', value: true });
    expect(valueFromStateChange('ext.flutter.timeDilation', '1.0', ctx)).toEqual({ id: 'flutter.slowAnimations', value: false });
    expect(valueFromStateChange('ext.flutter.brightnessOverride', 'Brightness.dark', ctx)).toEqual({ id: 'flutter.brightness', value: 'dark' });
    expect(valueFromStateChange('ext.flutter.platformOverride', 'android', ctx)).toEqual({ id: 'flutter.platform', value: 'default' });
    expect(valueFromStateChange('ext.flutter.inspector.show', 'true', ctx)).toBeUndefined();
  });

  it('maps the VM operating system to TargetPlatform names', () => {
    expect(nativeTargetPlatform('android')).toBe('android');
    expect(nativeTargetPlatform('ios')).toBe('iOS');
    expect(nativeTargetPlatform('macos')).toBe('macOS');
    expect(nativeTargetPlatform('haiku')).toBeUndefined();
  });

  it('labels Flutter.Navigation routes', () => {
    expect(routeLabel({ description: 'MaterialPageRoute<void>(RouteSettings("/details", null))', settings: { name: '/details' } })).toBe('/details');
    expect(routeLabel({ description: 'MaterialPageRoute<dynamic>(RouteSettings(none, null), animation: …)', settings: { name: null } })).toBe(
      'MaterialPageRoute<dynamic>',
    );
    expect(routeLabel(null)).toBeUndefined();
  });
});

describe('app identity', () => {
  it('derives package names from root libraries', () => {
    expect(packageNameFromLibraryUri('package:pati/main.dart')).toBe('pati');
    expect(packageNameFromLibraryUri(isolate.rootLib.uri)).toBe('app');
    expect(packageNameFromLibraryUri('file:///C:/work/my%20app/bin/server.dart')).toBe('server');
    expect(packageNameFromLibraryUri(undefined)).toBeUndefined();
  });

  it('prefers SDK info, then the bundle, then a package-like process name, then the Dart package', () => {
    expect(deriveAppInfo({ packageName: 'pati', processName: 'com.mykynk.pati:remote', pid: 4242, debug: true })).toEqual({
      name: 'pati',
      id: 'com.mykynk.pati',
      pid: 4242,
      processName: 'com.mykynk.pati:remote',
      debug: true,
    });
    expect(deriveAppInfo({ packageName: 'pati', processName: 'Runner' })).toMatchObject({ id: 'pati', name: 'pati', processName: 'Runner' });
    expect(
      deriveAppInfo({
        packageName: 'pati',
        processName: 'Runner',
        bundle: { id: 'com.mykynk.pati', name: 'Pati', version: '1.4.0', build: '42', executable: 'Runner' },
      }),
    ).toMatchObject({ id: 'com.mykynk.pati', name: 'Pati', version: '1.4.0', build: '42' });
    expect(deriveAppInfo({ sdkApp: { id: 'com.x.y', name: 'Y', version: '2.0.0' }, packageName: 'y' })).toMatchObject({ id: 'com.x.y', name: 'Y' });
    expect(deriveAppInfo({})).toMatchObject({ id: 'dart-vm-app', name: 'Dart app' });
  });

  it('process/bundle helpers', () => {
    expect(looksLikeBundleId('com.example.app')).toBe(true);
    expect(looksLikeBundleId('Runner')).toBe(false);
    expect(cleanProcessName('com.example.app:push')).toBe('com.example.app');
    const exe =
      '/Users/u/Library/Developer/CoreSimulator/Devices/0E6A8C9F-1D2B-4C3D-9E8F-112233445566/data/Containers/Bundle/Application/AB/Runner.app/Runner';
    expect(simulatorUdidFromPath(exe)).toBe('0E6A8C9F-1D2B-4C3D-9E8F-112233445566');
    expect(appBundleDir(exe)).toMatch(/Runner\.app$/);
    expect(appBundleDir('/Applications/Pati.app/Contents/MacOS/Pati')).toBe('/Applications/Pati.app');
    expect(simulatorUdidFromPath('/usr/bin/dart')).toBeUndefined();
  });

  it('device hints and device choice', () => {
    expect(deviceHintsFor('android')).toEqual({ platform: 'android' });
    expect(deviceHintsFor('ios', { simulatorUdid: 'U' })).toEqual({ platform: 'ios', simulatorUdid: 'U', isPhysical: false });
    expect(deviceHintsFor('macos')).toMatchObject({ platform: 'other', name: 'macOS (Dart VM)' });
    const dev = (id: string, platform: 'android' | 'ios', state: DeviceInfo['state'] = 'online') =>
      ({ id, platform, state }) as DeviceInfo;
    expect(uniqueOnlineDevice([dev('android:a', 'android'), dev('ios:b', 'ios')], 'android')).toBe('android:a');
    expect(uniqueOnlineDevice([dev('android:a', 'android'), dev('android:b', 'android')], 'android')).toBeUndefined();
    expect(uniqueOnlineDevice([dev('android:a', 'android', 'offline')], 'android')).toBeUndefined();
  });

  it('finds an SDK session of the same process (never another VM session)', () => {
    const app = (over: Partial<AppSession>) =>
      ({
        id: 'app:1',
        deviceId: 'android:x',
        connected: true,
        transport: 'adb-reverse',
        capabilities: ['logs', 'network'],
        app: { id: 'com.a', name: 'A', pid: 100 },
        ...over,
      }) as AppSession;
    const apps = [app({}), app({ id: 'app:2', transport: 'vm-service', app: { id: 'com.a', name: 'A', pid: 200 } })];
    expect(sdkSessionForPid(apps, 'android:x', 100, 'network')?.id).toBe('app:1');
    expect(sdkSessionForPid(apps, 'android:x', 200, 'network')).toBeUndefined();
    expect(sdkSessionForPid(apps, 'android:y', 100)).toBeUndefined();
    expect(sdkSessionForPid([app({ capabilities: ['logs'] })], 'android:x', 100, 'network')).toBeUndefined();
    expect(sdkSessionForPid([app({ connected: false })], 'android:x', 100)).toBeUndefined();
  });
});

describe('auto-attach announcements', () => {
  const entry = (over: Partial<LogEntry>): LogEntry => ({
    id: 1,
    ts: Date.now(),
    deviceId: 'android:emulator-5554',
    source: 'device',
    level: 'info',
    tag: 'flutter',
    message: '',
    ...over,
  });

  it('finds announcements in logcat / simulator lines and keeps the last per process', () => {
    const cache = new ProcessNameCache();
    const found = collectAnnouncements(
      [
        entry({ pid: 4321, process: 'com.mykynk.pati', message: 'Initializing…' }),
        entry({ pid: 4321, message: 'The Dart VM service is listening on http://127.0.0.1:41935/Ab0-c_d1E2f=/' }),
        entry({ pid: 4321, message: 'The Dart VM service is listening on http://127.0.0.1:41999/Zz0-c_d1E2f=/' }),
        entry({
          deviceId: 'ios-sim:ABC',
          pid: 999,
          process: 'Runner',
          message: 'The Dart VM service is listening on http://127.0.0.1:61234/kKbQcJ1VYZ4=/',
        }),
        entry({ source: 'system', message: 'The Dart VM service is listening on http://127.0.0.1:1/x=/' }),
        entry({ message: 'I/flutter: unrelated' }),
      ],
      cache,
    );
    expect(found).toEqual([
      { deviceId: 'android:emulator-5554', url: 'http://127.0.0.1:41999/Zz0-c_d1E2f=/', pid: 4321, process: 'com.mykynk.pati', ts: expect.any(Number) },
      { deviceId: 'ios-sim:ABC', url: 'http://127.0.0.1:61234/kKbQcJ1VYZ4=/', pid: 999, process: 'Runner', ts: expect.any(Number) },
    ]);
    expect(cache.get('android:emulator-5554', 4321)).toBe('com.mykynk.pati');
  });

  it('decides reachability and freshness', () => {
    expect(isAutoAttachDevice('android:R5CT')).toBe(true);
    expect(isAutoAttachDevice('ios:00008110-001')).toBe(true);
    expect(isAutoAttachDevice('ios-sim:ABC')).toBe(true);
    for (const id of ['demo:1', 'import:1', 'net:android-x', 'desktop']) expect(isAutoAttachDevice(id)).toBe(false);
    expect(needsPortForward('android:R5CT', '127.0.0.1')).toBe(true);
    expect(needsPortForward('ios:00008110', 'localhost')).toBe(true);
    expect(needsPortForward('ios-sim:ABC', '127.0.0.1')).toBe(false);
    expect(needsPortForward('android:R5CT', '192.168.1.40')).toBe(false);
    expect(needsPortForward('android:R5CT', '0.0.0.0')).toBe(true);
    expect(needsPortForward('ios:00008110', '[::]')).toBe(true);
    expect(isFreshAnnouncement(1_000_000, 1_060_000)).toBe(true);
    expect(isFreshAnnouncement(1_000_000, 1_200_001)).toBe(false);
  });

  it('process cache stays bounded', () => {
    const cache = new ProcessNameCache(8);
    for (let pid = 1; pid <= 20; pid++) cache.set('android:x', pid, `p${pid}`);
    expect(cache.get('android:x', 20)).toBe('p20');
    expect(cache.get('android:x', 1)).toBeUndefined();
  });
});
