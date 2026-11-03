import { describe, expect, it } from 'vitest';
import type { AppSession, DeviceApp, DeviceInfo } from '@durbun/protocol';
import { buildBadgeOf, buildKindOf, explainContext, explainRow, explainSources, type ExplainCapability, type ExplainInput, type ExplainResult } from './explain';

/* ───────────── fixtures (shapes as the server sends them) ───────────── */

function device(id: string, p: Partial<DeviceInfo> = {}): DeviceInfo {
  const platform = id.startsWith('android:') || id.startsWith('demo:1') ? 'android' : id.startsWith('ios') || id.startsWith('demo:2') ? 'ios' : 'other';
  return {
    id,
    platform,
    kind: id.startsWith('ios-sim:') ? 'simulator' : id.startsWith('demo:') ? 'emulator' : 'physical',
    name: id,
    connection: 'usb',
    state: 'online',
    logs: { status: 'streaming', via: platform === 'android' ? 'logcat' : id.startsWith('ios-sim:') ? 'simctl log stream' : 'idevicesyslog' },
    actions: [],
    firstSeen: 1,
    lastSeen: 2,
    ...p,
  };
}

const PIXEL = device('android:R5CT20XK9QM', { name: 'Pixel 8', osVersion: '15', apiLevel: 35 });
const IPHONE = device('ios:00008120-001A2C3E0E43C01E', { name: 'Yusuf’un iPhone’u', osVersion: '18.2' });
const SIM = device('ios-sim:7C1F2B9E-4D7A-4C61-9E22-6B1A0F3D5C88', { name: 'iPhone 16 Pro', osVersion: '18.2' });

function deviceApp(dev: DeviceInfo, p: Partial<DeviceApp> & Pick<DeviceApp, 'buildType'> & { source: DeviceApp['install']['source']; installer?: string }): DeviceApp {
  const id = p.id ?? 'com.mykynk.kumbara';
  return {
    key: `${dev.id}|${id}`,
    deviceId: dev.id,
    id,
    name: p.name ?? 'Kumbara',
    version: p.version ?? '3.1.0',
    build: p.build ?? '412',
    buildType: p.buildType,
    install: { source: p.source, installer: p.installer },
    pids: p.pids ?? [12873],
    running: p.running ?? true,
    lastActivity: p.lastActivity ?? 1000,
    processName: p.processName,
    crashReports: p.crashReports,
  };
}

function session(dev: DeviceInfo, p: Partial<AppSession> & { platform?: AppSession['sdk']['platform'] } = {}): AppSession {
  const transport = p.transport ?? 'adb-reverse';
  return {
    id: p.id ?? 'app:1',
    sessionKey: 's1',
    deviceId: dev.id,
    sdk: { name: transport === 'vm-service' ? 'durbun-vm-service' : 'durbun-flutter', version: '0.3.0', platform: p.platform ?? (transport === 'vm-service' ? 'dart-vm' : 'flutter') },
    app: { name: 'Kumbara', id: 'com.mykynk.kumbara', version: '3.1.0', build: '412', pid: 12873, debug: true, ...(p.app ?? {}) },
    transport,
    connected: p.connected ?? true,
    connectedAt: p.connectedAt ?? 100,
    capabilities: p.capabilities ?? ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'],
    actions: p.actions ?? [{ id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', labelKey: 'flutter.debugPaint', group: 'flutter', value: false }],
    stats: { logs: 0, requests: 0, errors: 0 },
  };
}

const row = (r: ExplainResult, c: ExplainCapability) => explainRow(r, c)!;
const ex = (input: ExplainInput) => explainSources(input);

/* ───────────── the brief's examples ───────────── */

describe('explainSources — examples from the brief', () => {
  it('Android Play release without the SDK', () => {
    const r = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play', installer: 'com.android.vending' }), sessions: [] });
    expect(r.badge).toBe('device-only');
    expect(r.rows.map((x) => x.capability)).toEqual(['logs', 'network', 'metrics', 'crashes', 'mocks', 'tools']);
    expect(row(r, 'logs')).toEqual({ capability: 'logs', status: 'yes', sources: ['logcat'], reasons: ['releaseLogsDependOnApp'], actions: [] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['dropbox', 'logcat'], reasons: [] });
    expect(row(r, 'metrics')).toMatchObject({ status: 'partial', sources: ['proc-stats', 'frame-stats'], reasons: ['frameStatsApproximate'], actions: ['startProcessMetrics'] });
    expect(row(r, 'network')).toEqual({ capability: 'network', status: 'no', sources: [], reasons: ['storeBuild', 'noOutsideNetwork'], actions: ['useDebugBuild', 'buildWithDurbunFlag'] });
    expect(row(r, 'mocks')).toMatchObject({ status: 'no', reasons: ['storeBuild'] });
    expect(row(r, 'tools')).toMatchObject({ status: 'no', reasons: ['storeBuild', 'deviceToolsAvailable'] });
    expect(r.notes).toEqual([]);
    expect(r.context).toMatchObject({ platform: 'android', transport: 'none', build: 'store', install: 'play', appName: 'Kumbara', version: '3.1.0', running: true });
  });

  it('iOS physical store build: no device metrics, unsymbolicated crash reports', () => {
    const r = ex({ device: IPHONE, deviceApp: deviceApp(IPHONE, { buildType: 'release', source: 'store-or-testflight', processName: 'Runner' }), sessions: [] });
    expect(r.badge).toBe('device-only');
    expect(row(r, 'metrics')).toMatchObject({ status: 'no', sources: [], reasons: ['iosNoDeviceMetrics'], actions: ['useDebugBuild'] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['crash-report', 'idevicesyslog'], reasons: ['crashesUnsymbolicated'] });
    expect(row(r, 'logs')).toMatchObject({ status: 'yes', sources: ['idevicesyslog'], reasons: ['releaseLogsDependOnApp'] });
    expect(row(r, 'network').reasons).toEqual(['storeBuild', 'noOutsideNetwork']);
    expect(r.context?.build).toBe('store-or-testflight');
  });

  it('Flutter debug through the VM service (no SDK)', () => {
    const r = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'debug', source: 'adb' }), sessions: [session(PIXEL, { transport: 'vm-service', capabilities: ['logs', 'network', 'metrics'] })] });
    expect(r.badge).toBe('vm-service');
    expect(row(r, 'network')).toMatchObject({ status: 'yes', sources: ['vm-service'], reasons: ['nativeNetworkNeedsInterceptor'] });
    expect(row(r, 'mocks')).toEqual({ capability: 'mocks', status: 'no', sources: [], reasons: ['vmServiceNoMocks'], actions: ['openSdkGuide'] });
    expect(row(r, 'logs')).toMatchObject({ status: 'yes', sources: ['vm-service', 'logcat'] });
    expect(row(r, 'metrics')).toMatchObject({ status: 'yes', sources: ['vm-service'] });
    expect(row(r, 'tools')).toMatchObject({ status: 'yes', sources: ['vm-service'] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['vm-service', 'dropbox', 'logcat'] });
  });

  it('SDK connected: everything from the SDK, third-party traffic noted on network', () => {
    const r = ex({ device: IPHONE, deviceApp: deviceApp(IPHONE, { buildType: 'debug', source: 'xcode' }), sessions: [session(IPHONE)] });
    expect(r.badge).toBe('sdk');
    for (const c of ['logs', 'network', 'metrics', 'crashes', 'mocks', 'tools'] as const) {
      expect(row(r, c).status, c).toBe('yes');
      expect(row(r, c).sources[0], c).toBe('sdk');
    }
    expect(row(r, 'network').reasons).toEqual(['thirdPartyTraffic']);
    expect(row(r, 'logs').sources).toEqual(['sdk', 'idevicesyslog']);
    expect(r.notes).toEqual([]);
  });
});

/* ───────────── per platform ───────────── */

describe('explainSources — platforms', () => {
  it('Android SDK session: native OkHttp traffic needs the interceptor', () => {
    const r = ex({ device: PIXEL, sessions: [session(PIXEL)] });
    expect(row(r, 'network')).toMatchObject({ status: 'yes', reasons: ['nativeNetworkNeedsInterceptor', 'thirdPartyTraffic'], actions: ['addInterceptor'] });
  });

  it('native Android SDK (Kotlin) gets the same interceptor note', () => {
    const r = ex({ device: PIXEL, sessions: [session(PIXEL, { platform: 'android' })] });
    expect(row(r, 'network').reasons).toContain('nativeNetworkNeedsInterceptor');
    expect(r.context?.sdkPlatform).toBe('android');
  });

  it('React Native on Android has no OkHttp interceptor note', () => {
    const r = ex({ device: PIXEL, sessions: [session(PIXEL, { platform: 'react-native', transport: 'websocket' })] });
    expect(row(r, 'network').reasons).toEqual(['thirdPartyTraffic']);
  });

  it('iOS simulator without SDK: simulator log, crash reports, host process stats', () => {
    const r = ex({ device: SIM, deviceApp: deviceApp(SIM, { buildType: 'debug', source: 'simulator', processName: 'Runner' }), sessions: [] });
    expect(r.context?.platform).toBe('ios-simulator');
    expect(r.context?.build).toBe('debug');
    expect(row(r, 'logs')).toMatchObject({ status: 'yes', sources: ['simctl-log'], reasons: [] });
    expect(row(r, 'metrics')).toMatchObject({ status: 'partial', sources: ['host-ps'], reasons: ['fpsNeedsApp'], actions: ['startProcessMetrics'] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['crash-report', 'simctl-log'], reasons: ['crashesUnsymbolicated'] });
    expect(row(r, 'network')).toMatchObject({ status: 'no', reasons: ['noSdk', 'noOutsideNetwork'], actions: ['openSdkGuide', 'attachVm'] });
  });

  it('iOS device debug (Xcode) without SDK: guide + VM attach for metrics', () => {
    const r = ex({ device: IPHONE, deviceApp: deviceApp(IPHONE, { buildType: 'debug', source: 'xcode' }), sessions: [] });
    expect(r.context?.build).toBe('xcode');
    expect(row(r, 'metrics')).toMatchObject({ status: 'no', reasons: ['iosNoDeviceMetrics'], actions: ['openSdkGuide', 'attachVm'] });
    expect(row(r, 'logs').reasons).toEqual([]);
  });

  it('SDK without the metrics capability on iOS device: no metrics, says both why', () => {
    const r = ex({ device: IPHONE, sessions: [session(IPHONE, { capabilities: ['logs', 'network'] })] });
    expect(row(r, 'metrics')).toMatchObject({ status: 'no', reasons: ['sdkLacksCapability', 'iosNoDeviceMetrics'] });
    expect(row(r, 'mocks')).toMatchObject({ status: 'no', reasons: ['sdkLacksCapability'], actions: ['openSdkGuide'] });
  });

  it('SDK without the metrics capability on Android: outside metrics still partial', () => {
    const r = ex({ device: PIXEL, sessions: [session(PIXEL, { capabilities: ['logs'] })] });
    expect(row(r, 'metrics')).toMatchObject({ status: 'partial', sources: ['proc-stats', 'frame-stats'], reasons: ['sdkLacksCapability', 'frameStatsApproximate'] });
    expect(row(r, 'network')).toMatchObject({ status: 'no', reasons: ['sdkLacksCapability'] });
    expect(row(r, 'tools')).toMatchObject({ status: 'yes' }); // it still advertises actions
  });

  it('SDK with no commands and no actions: tools explain that device tools still work', () => {
    const r = ex({ device: PIXEL, sessions: [session(PIXEL, { capabilities: ['logs'], actions: [] })] });
    expect(row(r, 'tools')).toMatchObject({ status: 'no', reasons: ['sdkLacksCapability', 'deviceToolsAvailable'] });
  });
});

/* ───────────── per build ───────────── */

describe('explainSources — builds without the SDK', () => {
  const cases: [string, Partial<DeviceApp> & Pick<DeviceApp, 'buildType'> & { source: DeviceApp['install']['source']; installer?: string }, string, string, string[]][] = [
    ['adb debug', { buildType: 'debug', source: 'adb' }, 'debug', 'noSdk', ['openSdkGuide', 'attachVm']],
    ['adb release', { buildType: 'release', source: 'adb' }, 'release', 'releaseWithoutSdk', ['buildWithDurbunFlag', 'useDebugBuild']],
    ['Firebase', { buildType: 'release', source: 'firebase', installer: 'dev.firebase.appdistribution' }, 'firebase', 'releaseWithoutSdk', ['buildWithDurbunFlag', 'useDebugBuild']],
    ['Play', { buildType: 'release', source: 'play' }, 'store', 'storeBuild', ['useDebugBuild', 'buildWithDurbunFlag']],
    ['other store', { buildType: 'release', source: 'other-store', installer: 'com.sec.android.app.samsungapps' }, 'store', 'storeBuild', ['useDebugBuild', 'buildWithDurbunFlag']],
    ['APK installed by hand', { buildType: 'release', source: 'other-store', installer: 'com.google.android.packageinstaller' }, 'release', 'releaseWithoutSdk', ['buildWithDurbunFlag', 'useDebugBuild']],
    ['debug APK installed by hand', { buildType: 'debug', source: 'other-store', installer: 'com.android.packageinstaller' }, 'debug', 'noSdk', ['openSdkGuide', 'attachVm']],
    ['unknown', { buildType: 'unknown', source: 'unknown' }, 'unknown', 'noSdk', ['openSdkGuide']],
  ];
  for (const [label, da, build, reason, actions] of cases) {
    it(`${label} → ${build}: ${reason}`, () => {
      const r = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, da), sessions: [] });
      expect(r.context?.build).toBe(build);
      expect(row(r, 'network')).toEqual({ capability: 'network', status: 'no', sources: [], reasons: [reason, 'noOutsideNetwork'], actions });
      expect(row(r, 'mocks').reasons).toEqual([reason]);
      expect(row(r, 'logs').reasons).toEqual(build === 'debug' || build === 'unknown' ? [] : ['releaseLogsDependOnApp']);
    });
  }

  it('iOS store-or-testflight and Xcode builds', () => {
    expect(buildKindOf(deviceApp(IPHONE, { buildType: 'release', source: 'store-or-testflight' }), undefined)).toBe('store-or-testflight');
    expect(buildKindOf(deviceApp(IPHONE, { buildType: 'debug', source: 'xcode' }), undefined)).toBe('xcode');
    expect(buildKindOf(undefined, session(PIXEL, { app: { name: 'K', id: 'k', debug: false } }))).toBe('release');
    expect(buildKindOf(undefined, undefined)).toBe('unknown');
  });

  it('a Firebase build WITH the SDK (DURBUN=true) has everything, and no store warning', () => {
    const r = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'firebase' }), sessions: [session(PIXEL, { app: { name: 'Kumbara', id: 'com.mykynk.kumbara', debug: false } })] });
    expect(r.badge).toBe('sdk');
    expect(row(r, 'mocks').status).toBe('yes');
    expect(r.notes).toEqual([]);
  });

  it('the SDK inside a store build gets an informational note (the team may ship it there)', () => {
    const r = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play' }), sessions: [session(PIXEL)] });
    expect(r.notes).toEqual(['sdkInStoreBuild']);
  });
});

/* ───────────── device log status ───────────── */

describe('explainSources — device log status', () => {
  it('missing tool: logs not available, Doctor offered', () => {
    const dev = device('ios:00008110-000C2D1A3E91801E', { logs: { status: 'unavailable', code: 'logs.idevicesyslogMissing' } });
    const r = ex({ device: dev, deviceApp: deviceApp(dev, { buildType: 'release', source: 'store-or-testflight' }), sessions: [] });
    expect(row(r, 'logs')).toEqual({ capability: 'logs', status: 'no', sources: [], reasons: ['deviceLogsUnavailable', 'toolMissing'], actions: ['openDoctor'] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['crash-report'] }); // crash reports do not need syslog
    expect(r.context?.deviceLogs).toBe('unavailable');
  });

  it('untrusted iPhone: logs unavailable without "tool missing"', () => {
    const dev = device('ios:00008110-000C2D1A3E91801E', { logs: { status: 'unavailable', code: 'device.untrusted' } });
    const r = ex({ device: dev, sessions: [] });
    expect(row(r, 'logs').reasons).toEqual(['deviceLogsUnavailable']);
  });

  it('SDK connected while the device log is down: partial logs', () => {
    const dev = device('android:emulator-5554', { logs: { status: 'error', code: 'logs.processExited' } });
    const r = ex({ device: dev, sessions: [session(dev)] });
    expect(row(r, 'logs')).toMatchObject({ status: 'partial', sources: ['sdk'], reasons: ['deviceLogsUnavailable'], actions: ['openDoctor'] });
  });

  it('a starting stream counts as streaming', () => {
    const dev = device('android:emulator-5554', { logs: { status: 'starting' } });
    expect(explainContext({ device: dev, sessions: [] }).deviceLogs).toBe('ok');
  });

  it('net: devices only have SDK data', () => {
    const dev = device('net:192.168.1.44', { platform: 'ios', kind: 'physical', connection: 'wifi', logs: { status: 'unavailable', code: 'logs.networkOnly' } });
    const r = ex({ device: dev, sessions: [session(dev, { platform: 'react-native', transport: 'websocket' })] });
    expect(r.context?.deviceLogs).toBe('none');
    expect(row(r, 'logs')).toMatchObject({ status: 'yes', sources: ['sdk'], reasons: ['networkOnly'] });
    // Nothing is read from the phone itself over Wi-Fi: no crash reports.
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['sdk'] });
  });

  it('net: Android device: no dropbox records, no process polling (regression)', () => {
    const dev = device('net:android-pixel-8-pixel-8', { platform: 'android', kind: 'physical', connection: 'wifi', logs: { status: 'unavailable', code: 'logs.networkOnly' }, actions: [] });
    const r = ex({ device: dev, sessions: [session(dev, { capabilities: ['logs', 'network'], actions: [] })] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['sdk'] });
    expect(row(r, 'metrics')).toMatchObject({ status: 'no', sources: [], reasons: ['sdkLacksCapability'], actions: ['openSdkGuide'] });
    expect(row(r, 'tools')).toMatchObject({ status: 'no', reasons: ['sdkLacksCapability'] });
  });
});

/* ───────────── capabilities, lifecycle, recordings ───────────── */

describe('explainSources — lifecycle and recordings', () => {
  it('app not running: the matrix stays, a note says so', () => {
    const r = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play', running: false, pids: [] }), sessions: [] });
    expect(r.notes).toEqual(['notRunning']);
    expect(row(r, 'logs').status).toBe('yes');
  });

  it('a disconnected SDK session and the app not running: still described as an SDK app', () => {
    const r = ex({ device: PIXEL, sessions: [session(PIXEL, { connected: false })] });
    expect(r.badge).toBe('sdk');
    expect(r.notes).toEqual(['notRunning']);
  });

  it('old SDK session, but this run has no SDK (a store build relaunched): device-only', () => {
    const r = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play' }), sessions: [session(PIXEL, { connected: false })] });
    expect(r.badge).toBe('device-only');
    expect(row(r, 'network').status).toBe('no');
  });

  it('a connected SDK session wins over a VM-service one', () => {
    const r = ex({ device: PIXEL, sessions: [session(PIXEL, { id: 'app:2', transport: 'vm-service', connectedAt: 200 }), session(PIXEL, { id: 'app:1', connectedAt: 100 })] });
    expect(r.badge).toBe('sdk');
  });

  it('disconnected device: read-only, no tools or mocks', () => {
    const dev = { ...PIXEL, state: 'disconnected' as const };
    const r = ex({ device: dev, sessions: [session(dev, { connected: false })] });
    expect(r.notes).toEqual(['readOnly']);
    expect(row(r, 'tools')).toMatchObject({ status: 'no', reasons: ['readOnly'] });
    expect(row(r, 'mocks')).toMatchObject({ status: 'no', reasons: ['readOnly'] });
    // Nothing streams from the device now, but that is not a problem to fix: no Doctor, no 'partial'.
    expect(row(r, 'logs')).toMatchObject({ status: 'yes', sources: ['sdk'], reasons: [], actions: [] });
  });

  it('imported recording', () => {
    const dev = device('import:1', { name: '📁 kumbara-bug.durbun.json', state: 'disconnected', stateCode: 'device.imported', logs: { status: 'stopped' } });
    const r = ex({ device: dev, sessions: [session(dev, { transport: 'import', connected: false, capabilities: ['logs', 'network'] })] });
    expect(r.badge).toBe('import');
    expect(r.notes).toEqual(['readOnly']);
    expect(row(r, 'network')).toMatchObject({ status: 'yes', sources: ['import'] });
    expect(row(r, 'metrics')).toMatchObject({ status: 'no', reasons: ['sdkLacksCapability'] });
    expect(row(r, 'tools')).toMatchObject({ status: 'no', reasons: ['readOnly'] });
  });

  it('the demo is explained like the device and build it stands for, with a demo note', () => {
    const dev = device('demo:1', { name: 'Pixel 8 · Demo', logs: { status: 'streaming', via: 'demo' } });
    const r = ex({ device: dev, sessions: [session(dev, { transport: 'demo', platform: 'flutter', capabilities: ['logs', 'network', 'metrics'] })] });
    expect(r.badge).toBe('sdk');
    expect(r.notes).toEqual(['demoData']);
    expect(r.context?.demo).toBe(true);
    expect(row(r, 'network')).toMatchObject({ status: 'yes', sources: ['sdk'] });
    expect(row(r, 'logs')).toMatchObject({ status: 'yes', sources: ['sdk', 'logcat'] });
    expect(row(r, 'mocks')).toMatchObject({ status: 'no', reasons: ['sdkLacksCapability'] });
  });

  it('an SDK-less demo app never claims network or mocks (regression: every row was "yes · demo")', () => {
    const dev = device('demo:1', { name: 'Pixel 8 · Demo', logs: { status: 'streaming', via: 'demo' } });
    const kumbara = deviceApp(dev, { buildType: 'release', source: 'play', installer: 'com.android.vending' });
    const r = ex({ device: dev, deviceApp: kumbara, sessions: [] });
    expect(r.badge).toBe('device-only');
    expect(row(r, 'network')).toMatchObject({ status: 'no', reasons: ['storeBuild', 'noOutsideNetwork'] });
    expect(row(r, 'mocks').status).toBe('no');
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['dropbox', 'logcat'] });
    expect(buildBadgeOf({ device: dev, deviceApp: kumbara, sessions: [] })).toBe('play');
    // The USB iPhone of the demo: a TestFlight build.
    const iphone = device('demo:3', { platform: 'ios', kind: 'physical', name: 'iPhone 13 · Demo', logs: { status: 'streaming', via: 'demo' } });
    const ios = ex({ device: iphone, deviceApp: deviceApp(iphone, { buildType: 'release', source: 'store-or-testflight' }), sessions: [] });
    expect(ios.context?.platform).toBe('ios-device');
    expect(row(ios, 'metrics')).toMatchObject({ status: 'no', reasons: ['iosNoDeviceMetrics'] });
  });

  it('no device and no app: honest "no SDK" rows', () => {
    const r = ex({ sessions: [] });
    expect(r.badge).toBe('device-only');
    expect(row(r, 'logs')).toMatchObject({ status: 'no', reasons: ['noSdk'] });
    expect(row(r, 'tools').reasons).toEqual(['noSdk']);
  });

  it('is pure: same input → equal output, input untouched', () => {
    const input: ExplainInput = { device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play' }), sessions: [session(PIXEL)] };
    const before = JSON.stringify(input);
    expect(ex(input)).toEqual(ex(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});

/* ───────────── disconnected devices, apps that have not run, apps that are not the team's ───────────── */

describe('explainSources — a disconnected device', () => {
  it('logs and crashes stay readable and never blame the store build (regression: "mağaza sürümlerinde SDK açılmaz")', () => {
    const dev = { ...IPHONE, state: 'disconnected' as const, logs: { status: 'stopped' as const } };
    const r = ex({ device: dev, deviceApp: deviceApp(dev, { buildType: 'release', source: 'store-or-testflight', running: false, pids: [] }), sessions: [] });
    expect(r.notes).toEqual(['readOnly']);
    expect(row(r, 'logs')).toEqual({ capability: 'logs', status: 'partial', sources: ['idevicesyslog'], reasons: ['readOnly'], actions: [] });
    expect(row(r, 'crashes')).toEqual({ capability: 'crashes', status: 'partial', sources: ['crash-report', 'idevicesyslog'], reasons: ['readOnly'], actions: [] });
    expect(row(r, 'mocks')).toMatchObject({ status: 'no', reasons: ['readOnly'] });
    expect(row(r, 'tools')).toMatchObject({ status: 'no', reasons: ['readOnly'] });
    // Network really depends on the build: it keeps its reason.
    expect(row(r, 'network').reasons).toEqual(['storeBuild', 'noOutsideNetwork']);
    const android = { ...PIXEL, state: 'disconnected' as const };
    const play = ex({ device: android, deviceApp: deviceApp(android, { buildType: 'release', source: 'play', running: false, pids: [] }), sessions: [] });
    expect(row(play, 'logs')).toMatchObject({ status: 'partial', sources: ['logcat'], reasons: ['readOnly'] });
    expect(row(play, 'crashes')).toMatchObject({ status: 'partial', sources: ['dropbox', 'logcat'], reasons: ['readOnly'] });
    expect(row(play, 'mocks').reasons).toEqual(['readOnly']);
  });

  it('an iPhone waiting for "Trust" is attached, not gone: no read-only note, the rows say what to do', () => {
    const dev = { ...IPHONE, state: 'unauthorized' as const, stateCode: 'device.untrusted', logs: { status: 'unavailable' as const, code: 'device.untrusted' } };
    const r = ex({ device: dev, deviceApp: deviceApp(dev, { buildType: 'release', source: 'store-or-testflight', running: false, pids: [] }), sessions: [] });
    expect(r.notes).toEqual([]);
    expect(row(r, 'logs')).toMatchObject({ status: 'no', reasons: ['deviceLogsUnavailable'], actions: ['openDoctor'] });
  });
});

describe('explainSources — an app that is not running and has not connected yet', () => {
  const xcodePati = (p: Partial<DeviceApp> = {}) => deviceApp(IPHONE, { id: 'com.mykynk.pati', name: 'Pati', version: '2.4.1', build: '241', buildType: 'debug', source: 'xcode', running: false, pids: [], ...p });
  const launchable = { ...IPHONE, actions: ['app-launch', 'app-stop', 'screenshot'] as DeviceInfo['actions'] };

  it('claims nothing about its SDK (regression: «Pati içinde Dürbün SDK’sı yok») and offers to launch it', () => {
    const r = ex({ device: launchable, deviceApp: xcodePati(), sessions: [] });
    expect(r.context?.unseen).toBe(true);
    expect(r.notes).toEqual(['notRunning']);
    for (const c of ['network', 'mocks', 'tools'] as const) {
      expect(row(r, c).reasons, c).toContain('notSeenYet');
      expect(row(r, c).reasons, c).not.toContain('noSdk');
    }
    expect(row(r, 'network')).toEqual({ capability: 'network', status: 'no', sources: [], reasons: ['notSeenYet', 'noOutsideNetwork'], actions: ['launchApp', 'openSdkGuide', 'attachVm'] });
    // A device that cannot start apps: no launch button.
    expect(row(ex({ device: IPHONE, deviceApp: xcodePati(), sessions: [] }), 'network').actions).toEqual(['openSdkGuide', 'attachVm']);
  });

  it('a store build that has not run is not claimed to lack the SDK; a running app or a known session is not "unseen"', () => {
    // The team may ship the SDK in a store build too (no install-source guard since 2026-11-02).
    const play = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play', running: false, pids: [] }), sessions: [] });
    expect(play.context?.unseen).toBe(true);
    expect(row(play, 'network').reasons).toEqual(['notSeenYet', 'noOutsideNetwork']);
    expect(row(play, 'mocks').reasons).not.toContain('storeBuild');
    // Running without an SDK session: now it is known.
    const playRunning = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play' }), sessions: [] });
    expect(row(playRunning, 'network').reasons).toEqual(['storeBuild', 'noOutsideNetwork']);
    const running = ex({ device: launchable, deviceApp: xcodePati({ running: true, pids: [902] }), sessions: [] });
    expect(running.context?.unseen).toBeUndefined();
    expect(row(running, 'network').reasons).toEqual(['noSdk', 'noOutsideNetwork']);
    const old = ex({ device: PIXEL, deviceApp: deviceApp(PIXEL, { buildType: 'debug', source: 'adb', running: false, pids: [] }), sessions: [session(PIXEL, { connected: false })] });
    expect(old.context?.unseen).toBeUndefined();
    expect(old.badge).toBe('sdk');
  });
});

describe('explainSources — apps that are not the team’s (ExplainInput.own = false)', () => {
  it('what the device shows from outside, without build advice', () => {
    const whatsapp = deviceApp(IPHONE, { id: 'net.whatsapp.WhatsApp', name: 'WhatsApp', version: '25.31.74', buildType: 'release', source: 'store-or-testflight', processName: 'WhatsApp' });
    const r = ex({ device: IPHONE, deviceApp: whatsapp, sessions: [], own: false });
    expect(r.context?.own).toBe(false);
    expect(row(r, 'logs')).toMatchObject({ status: 'yes', sources: ['idevicesyslog'] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['crash-report', 'idevicesyslog'] });
    expect(row(r, 'network')).toEqual({ capability: 'network', status: 'no', sources: [], reasons: ['notOwnApp', 'noOutsideNetwork'], actions: [] });
    expect(row(r, 'metrics')).toEqual({ capability: 'metrics', status: 'no', sources: [], reasons: ['iosNoDeviceMetrics'], actions: [] });
    expect(row(r, 'mocks')).toEqual({ capability: 'mocks', status: 'no', sources: [], reasons: ['notOwnApp'], actions: [] });
    expect(row(r, 'tools')).toEqual({ capability: 'tools', status: 'no', sources: [], reasons: ['notOwnApp', 'deviceToolsAvailable'], actions: [] });
    const advice = new Set<string>(['useDebugBuild', 'buildWithDurbunFlag', 'openSdkGuide', 'attachVm', 'addInterceptor']);
    expect(r.rows.flatMap((x) => x.actions).filter((a) => advice.has(a))).toEqual([]);
    // Unknown ownership (callers that do not say) keeps the advice.
    expect(row(ex({ device: IPHONE, deviceApp: whatsapp, sessions: [] }), 'network').actions).toEqual(['useDebugBuild', 'buildWithDurbunFlag']);
  });
});

/* ───────────── SDK-less readers (DeviceInfo.readers) ───────────── */

describe('explainSources — device readers', () => {
  const refused = { crashReports: { status: 'unavailable' as const, code: 'reader.crashReports.dropboxRefused', detail: 'dumpsys dropbox: Permission Denial' } };

  it('Android crash records refused: never "yes" from dropbox, live crash lines only', () => {
    const dev = { ...PIXEL, readers: refused };
    const r = ex({ device: dev, deviceApp: deviceApp(dev, { buildType: 'release', source: 'play' }), sessions: [] });
    expect(row(r, 'crashes')).toEqual({ capability: 'crashes', status: 'partial', sources: ['logcat'], reasons: ['crashReportsUnavailable'], actions: [] });
    expect(r.context?.readers?.crashReports?.code).toBe('reader.crashReports.dropboxRefused');
  });

  it('iPhone without devicectl: crash reports unavailable, Doctor offered', () => {
    const dev = { ...IPHONE, readers: { crashReports: { status: 'unavailable' as const, code: 'reader.crashReports.devicectlMissing' } } };
    const r = ex({ device: dev, deviceApp: deviceApp(dev, { buildType: 'release', source: 'store-or-testflight' }), sessions: [] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'partial', sources: ['idevicesyslog'], reasons: ['crashReportsUnavailable'], actions: ['openDoctor'] });
  });

  it('no device log and no crash records: "no", with both reasons', () => {
    const dev = { ...IPHONE, logs: { status: 'unavailable' as const, code: 'device.untrusted' }, readers: { crashReports: { status: 'unavailable' as const, code: 'reader.crashReports.failed' } } };
    const r = ex({ device: dev, deviceApp: deviceApp(dev, { buildType: 'release', source: 'store-or-testflight' }), sessions: [] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'no', reasons: ['deviceLogsUnavailable', 'crashReportsUnavailable'] });
  });

  it('with the SDK the crashes row stays "yes" and carries the caveat', () => {
    const dev = { ...PIXEL, readers: refused };
    const r = ex({ device: dev, sessions: [session(dev)] });
    expect(row(r, 'crashes')).toMatchObject({ status: 'yes', sources: ['sdk', 'logcat'], reasons: ['crashReportsUnavailable'] });
  });

  it('a working reader (or none reported) changes nothing', () => {
    const ok = ex({ device: { ...PIXEL, readers: { crashReports: { status: 'ok', lastOk: 5 } } }, deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play' }), sessions: [] });
    expect(row(ok, 'crashes')).toMatchObject({ status: 'yes', sources: ['dropbox', 'logcat'], reasons: [] });
  });

  it('Android frame stats without data: CPU / memory only, said so', () => {
    const dev = { ...PIXEL, readers: { frameStats: { status: 'unavailable' as const, code: 'reader.frameStats.noData' } } };
    const r = ex({ device: dev, deviceApp: deviceApp(dev, { buildType: 'release', source: 'play' }), sessions: [] });
    expect(row(r, 'metrics')).toEqual({ capability: 'metrics', status: 'partial', sources: ['proc-stats'], reasons: ['frameStatsUnavailable'], actions: ['startProcessMetrics'] });
    const iosSim = ex({ device: { ...SIM, readers: { frameStats: { status: 'unsupported' as const, code: 'reader.frameStats.unsupported' } } }, deviceApp: deviceApp(SIM, { buildType: 'debug', source: 'simulator' }), sessions: [] });
    expect(row(iosSim, 'metrics')).toMatchObject({ status: 'partial', sources: ['host-ps'], reasons: ['fpsNeedsApp'] });
  });
});

/* ───────────── SDK layers (sdk.layers) ───────────── */

describe('explainSources — native layer of the Flutter plugin', () => {
  const withLayers = (dev: DeviceInfo, layers: ('dart' | 'android' | 'ios')[] | undefined): AppSession => {
    const s = session(dev);
    return { ...s, sdk: { ...s.sdk, ...(layers ? { layers } : {}) } };
  };

  it('Android: native logs and crashes covered, OkHttp still needs the interceptor', () => {
    const r = ex({ device: PIXEL, sessions: [withLayers(PIXEL, ['dart', 'android'])] });
    expect(r.notes).toEqual(['nativeLayerActive']);
    expect(row(r, 'logs').sources).toEqual(['sdk', 'native-layer', 'logcat']);
    expect(row(r, 'crashes').sources).toEqual(['sdk', 'native-layer', 'dropbox', 'logcat']);
    expect(row(r, 'network')).toMatchObject({ status: 'yes', sources: ['sdk'], reasons: ['nativeNetworkNeedsInterceptor', 'thirdPartyTraffic'], actions: ['addInterceptor'] });
  });

  it('iOS: URLSession is captured by the native layer, no interceptor caveat', () => {
    const r = ex({ device: IPHONE, sessions: [withLayers(IPHONE, ['dart', 'ios'])] });
    expect(r.notes).toEqual(['nativeLayerActive']);
    expect(row(r, 'network')).toMatchObject({ status: 'yes', sources: ['sdk', 'native-layer'], reasons: ['thirdPartyTraffic'], actions: [] });
  });

  it('only the Dart layer reported: a note says native data does not come through', () => {
    const r = ex({ device: IPHONE, sessions: [withLayers(IPHONE, ['dart'])] });
    expect(r.notes).toEqual(['nativeLayerMissing']);
    expect(row(r, 'logs').sources).toEqual(['sdk', 'idevicesyslog']);
  });

  it('layers not reported (older SDKs) or no native layer on the platform: no note', () => {
    expect(ex({ device: PIXEL, sessions: [withLayers(PIXEL, undefined)] }).notes).toEqual([]);
    expect(ex({ device: device('net:macos-desktop', { platform: 'other' }), sessions: [withLayers(device('net:macos-desktop', { platform: 'other' }), ['dart'])] }).notes).toEqual([]);
  });
});

describe('buildBadgeOf', () => {
  it('names the install source, else the build type', () => {
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'play' }), sessions: [] })).toBe('play');
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'firebase' }), sessions: [] })).toBe('firebase');
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'other-store' }), sessions: [] })).toBe('other-store');
    expect(buildBadgeOf({ deviceApp: deviceApp(IPHONE, { buildType: 'debug', source: 'xcode' }), sessions: [] })).toBe('xcode');
    expect(buildBadgeOf({ deviceApp: deviceApp(IPHONE, { buildType: 'release', source: 'store-or-testflight' }), sessions: [] })).toBe('store-or-testflight');
    expect(buildBadgeOf({ deviceApp: deviceApp(SIM, { buildType: 'debug', source: 'simulator' }), sessions: [] })).toBe('simulator');
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'debug', source: 'adb' }), sessions: [] })).toBe('debug');
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'adb' }), sessions: [] })).toBe('release');
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'unknown', source: 'unknown' }), sessions: [] })).toBeUndefined();
    expect(buildBadgeOf({ sessions: [session(PIXEL)] })).toBe('debug');
    expect(buildBadgeOf({ device: device('demo:1'), sessions: [session(PIXEL)] })).toBe('debug');
    expect(buildBadgeOf({ device: device('import:1'), sessions: [session(PIXEL)] })).toBeUndefined();
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'other-store', installer: 'com.google.android.packageinstaller' }), sessions: [] })).toBe('apk');
    expect(buildBadgeOf({ deviceApp: deviceApp(PIXEL, { buildType: 'release', source: 'other-store', installer: 'com.huawei.appmarket' }), sessions: [] })).toBe('other-store');
  });
});
