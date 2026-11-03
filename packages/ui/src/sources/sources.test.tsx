import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppSession, DeviceApp, DeviceInfo, LogEntry } from '@durbun/protocol';
import '../i18n';
import { messageKeys, setLanguage, translate } from '../i18n/core';
import { explainSources, type ExplainCapability, type ExplainContext, type ExplainReason, type ExplainInput } from '../data/explain';
import { hubActions, useHub } from '../data/stores/hub';
import { setScope, useScopeStore } from '../data/stores/scope';
import { useUi } from '../data/stores/ui';
import { Sidebar } from '../shell/Sidebar';
import { buildBadgeHint, buildBadgeLabel, entrySourceText, isDeviceCrashRecord, isUnsymbolicated, originLabel, reasonText, summaryText } from './text';
import { crashRecordsState, pickEmptyReason, explainGroup, explainScope, explainSignature, iosSystemLinesHidden, idleApp, type ExplainedApp } from './model';
import { CrashRecordsNote, ExplainEmpty, FrameStatsNote, IosLogScopeNote, NotRunningNote, SourcesPanel, WhatCanISeeButton } from './components';
import { setServerSettingsFromServer, useServerSettings } from '../data/stores/server';
import { DEFAULT_SETTINGS } from '@durbun/protocol';
import { DataSourcesExplainer } from './DataSourcesDialog';
import { groupApps } from '../data/stores/hub';

const PIXEL_ID = 'android:R5CT20XK9QM';
const IPHONE_ID = 'ios:00008120-001A2C3E0E43C01E';

function device(id: string, p: Partial<DeviceInfo> = {}): DeviceInfo {
  const ios = id.startsWith('ios');
  return {
    id,
    platform: ios ? 'ios' : 'android',
    kind: 'physical',
    name: ios ? 'Yusuf’un iPhone’u' : 'Pixel 8',
    connection: 'usb',
    state: 'online',
    logs: { status: 'streaming', via: ios ? 'idevicesyslog' : 'logcat' },
    actions: ['app-launch', 'app-stop', 'screenshot'],
    firstSeen: 1,
    lastSeen: 2,
    ...p,
  };
}

function deviceApp(deviceId: string, id: string, p: Partial<DeviceApp> = {}): DeviceApp {
  return {
    key: `${deviceId}|${id}`,
    deviceId,
    id,
    name: 'Kumbara',
    version: '3.1.0',
    build: '412',
    buildType: 'release',
    install: { source: 'play', installer: 'com.android.vending' },
    pids: [12873],
    running: true,
    lastActivity: Date.now(),
    ...p,
  };
}

function session(deviceId: string, p: Partial<AppSession> = {}): AppSession {
  return {
    id: 'app:2',
    sessionKey: 's2',
    deviceId,
    sdk: { name: 'durbun-flutter', version: '0.3.0', platform: 'flutter' },
    app: { name: 'Pati', id: 'com.mykynk.pati', version: '2.4.0', build: '88', pid: 15000, debug: true },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: 10,
    capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'],
    actions: [{ id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', labelKey: 'flutter.debugPaint', group: 'flutter' }],
    stats: { logs: 0, requests: 0, errors: 0 },
    ...p,
  };
}

function explained(input: ExplainInput): ExplainedApp {
  const groups = groupApps(input.sessions, input.deviceApp ? [input.deviceApp] : []);
  const g = [...groups.values()][0]![0]!;
  return explainGroup(g, input.device);
}

afterEach(() => {
  cleanup();
  setLanguage('en');
});

/* ───────────── sentences ───────────── */

describe('reason sentences', () => {
  const play = explainSources({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [] });

  it('name the app, version and install source (Turkish, the brief’s sentence)', () => {
    setLanguage('tr');
    expect(reasonText('storeBuild', play.context)).toBe('Kumbara 3.1.0 Play Store’dan kurulmuş bir sürüm; içinde Dürbün SDK’sı açık değil.');
    expect(reasonText('noOutsideNetwork', play.context, 'network')).toContain('SSL pinning');
    expect(reasonText('noOutsideNetwork', play.context, 'network')).toContain('Android 7’den beri uygulamalar kullanıcının eklediği sertifikalara');
    // No claim that the SDK is missing: it may be off in this build (audit-ux #12).
    expect(summaryText(play.badge, play.context)).toBe('Kumbara Dürbün’e kendi verisini göndermiyor (SDK yok ya da bu derlemede kapalı); Dürbün yalnızca cihazın kendi kayıtlarını okuyor.');
  });

  it('English', () => {
    setLanguage('en');
    expect(reasonText('storeBuild', play.context)).toBe('Kumbara 3.1.0 was installed from the Play Store without the Dürbün SDK turned on.');
    const fb = explainSources({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'x', { install: { source: 'firebase' } }), sessions: [] });
    expect(reasonText('releaseWithoutSdk', fb.context)).toBe('Kumbara 3.1.0 was installed from Firebase App Distribution without the Dürbün SDK turned on.');
  });

  it('pick platform / transport variants', () => {
    setLanguage('tr');
    const ios = explainSources({ device: device(IPHONE_ID), sessions: [] });
    expect(reasonText('noOutsideNetwork', ios.context)).not.toContain('Android');
    const vm = explainSources({ device: device(PIXEL_ID), sessions: [session(PIXEL_ID, { transport: 'vm-service', sdk: { name: 'durbun-vm-service', version: '1', platform: 'dart-vm' } })] });
    expect(reasonText('nativeNetworkNeedsInterceptor', vm.context)).toContain('Dart VM Service yalnızca');
    const sdk = explainSources({ device: device(PIXEL_ID), sessions: [session(PIXEL_ID)] });
    expect(reasonText('nativeNetworkNeedsInterceptor', sdk.context)).toContain('.addInterceptor(DurbunInterceptor())');
    expect(reasonText('deviceLogsUnavailable', ios.context, 'logs', { device: 'Yusuf’un iPhone’u', logs: 'iPhone bu bilgisayara güvenmiyor' })).toBe(
      'Yusuf’un iPhone’u için cihaz logu şu an gelmiyor: iPhone bu bilgisayara güvenmiyor.',
    );
    // Nothing known about the app: the name-less wording, never a dangling placeholder.
    expect(reasonText('noSdk', undefined, 'mocks')).toBe('Mock’ları uygulamanın içindeki Dürbün SDK’sı uygular.');
    expect(reasonText('storeBuild', { ...play.context!, appName: undefined, bundleId: undefined })).toBe('Bu Play Store’dan kurulmuş bir sürüm; içinde Dürbün SDK’sı açık değil.');
  });

  it('every reason × capability × context renders in both languages without placeholders', () => {
    const reasons: ExplainReason[] = [
      'noSdk', 'releaseWithoutSdk', 'storeBuild', 'noOutsideNetwork', 'vmServiceNoMocks', 'sdkLacksCapability', 'iosNoDeviceMetrics', 'frameStatsApproximate',
      'deviceLogsUnavailable', 'toolMissing', 'releaseLogsDependOnApp', 'nativeNetworkNeedsInterceptor', 'thirdPartyTraffic', 'crashesUnsymbolicated', 'notRunning',
      'readOnly', 'fpsNeedsApp', 'networkOnly', 'deviceToolsAvailable', 'sdkInStoreBuild', 'crashReportsUnavailable', 'frameStatsUnavailable',
      'nativeLayerActive', 'nativeLayerMissing', 'demoData', 'notSeenYet', 'notOwnApp',
    ];
    const caps: (ExplainCapability | undefined)[] = ['logs', 'network', 'metrics', 'crashes', 'mocks', 'tools', undefined];
    const contexts: (ExplainContext | undefined)[] = [
      undefined,
      play.context,
      explainSources({ device: device(IPHONE_ID), deviceApp: deviceApp(IPHONE_ID, 'k', { name: undefined, version: undefined, install: { source: 'other-store' } }), sessions: [] }).context,
      explainSources({ device: device('import:1', { state: 'disconnected' }), sessions: [session('import:1', { transport: 'import' })] }).context,
      // Readers with a known code, an unknown code with a detail, and a store-or-testflight iPhone build.
      explainSources({
        device: device(PIXEL_ID, { readers: { crashReports: { status: 'unavailable', code: 'reader.crashReports.dropboxRefused' }, frameStats: { status: 'unavailable', code: 'reader.frameStats.somethingNew', detail: 'SurfaceFlinger: no layers' } } }),
        deviceApp: deviceApp(PIXEL_ID, 'k', { install: { source: 'other-store', installer: 'com.google.android.packageinstaller' } }),
        sessions: [],
      }).context,
      explainSources({ device: device(IPHONE_ID, { readers: { crashReports: { status: 'unavailable' } } }), deviceApp: deviceApp(IPHONE_ID, 'k', { install: { source: 'store-or-testflight' } }), sessions: [] }).context,
      // Disconnected, not running and never connected, not the team's app.
      explainSources({ device: device(PIXEL_ID, { state: 'disconnected' }), deviceApp: deviceApp(PIXEL_ID, 'k', { running: false, pids: [] }), sessions: [] }).context,
      explainSources({ device: device(IPHONE_ID), deviceApp: deviceApp(IPHONE_ID, 'k', { buildType: 'debug', install: { source: 'xcode' }, running: false, pids: [] }), sessions: [] }).context,
      explainSources({ device: device(IPHONE_ID), deviceApp: deviceApp(IPHONE_ID, 'net.whatsapp.WhatsApp', { name: 'WhatsApp', install: { source: 'store-or-testflight' } }), sessions: [], own: false }).context,
    ];
    for (const lang of ['tr', 'en'] as const) {
      setLanguage(lang);
      for (const r of reasons)
        for (const c of caps)
          for (const ctx of contexts) {
            const text = reasonText(r, ctx, c);
            expect(text, `${lang} ${r} ${c}`).not.toMatch(/[{}]/);
            expect(text, `${lang} ${r} ${c}`).not.toMatch(/^sources\./);
            expect(text.includes('  '), `${lang} ${r} ${c}`).toBe(false);
          }
    }
  });

  it('word the reader problems from the server’s code, else from its detail', () => {
    const ctx = (readers: DeviceInfo['readers']) => explainSources({ device: device(PIXEL_ID, { readers }), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [] }).context;
    setLanguage('tr');
    expect(reasonText('crashReportsUnavailable', ctx({ crashReports: { status: 'unavailable', code: 'reader.crashReports.dropboxRefused' } }), 'crashes')).toBe(
      'Bu cihaz Android’in çökme kayıtlarının (dumpsys dropbox) okunmasına izin vermiyor; bazı üreticiler bunu kapatır. Canlı çökmeler cihaz logunda yine görünür, önceki açılışların kayıtları görünmez.',
    );
    expect(reasonText('crashReportsUnavailable', ctx({ crashReports: { status: 'unavailable', code: 'reader.crashReports.failed', detail: 'adb: device offline' } }), 'crashes')).toBe('Cihazın çökme kayıtları okunamadı: adb: device offline');
    // A code the UI does not know yet: the generic sentence with the server's English detail.
    expect(reasonText('crashReportsUnavailable', ctx({ crashReports: { status: 'unavailable', code: 'reader.crashReports.oemBlocked', detail: 'blocked by MIUI' } }), 'crashes')).toBe('Bu cihazın kendi çökme kayıtları okunamıyor: blocked by MIUI');
    expect(reasonText('frameStatsUnavailable', ctx({ frameStats: { status: 'unavailable' } }), 'metrics')).toBe('CPU ve bellek cihazın süreç listesinden okunur; FPS bu cihazda dışarıdan ölçülemiyor.');
    setLanguage('en');
    expect(reasonText('frameStatsUnavailable', ctx({ frameStats: { status: 'unavailable', code: 'reader.frameStats.noData' } }), 'metrics')).toContain('neither gfxinfo nor SurfaceFlinger');
  });

  it('word Android installers and the iOS store / TestFlight / ad-hoc case', () => {
    const fromInstaller = (installer: string, buildType: DeviceApp['buildType'] = 'release') =>
      explainSources({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara', { buildType, install: { source: 'other-store', installer } }), sessions: [] }).context;
    setLanguage('tr');
    expect(reasonText('releaseWithoutSdk', fromInstaller('com.google.android.packageinstaller'))).toBe('Kumbara 3.1.0 elle kurulmuş bir APK; içinde Dürbün SDK’sı açık değil.');
    expect(reasonText('storeBuild', fromInstaller('com.sec.android.app.samsungapps'))).toBe('Kumbara 3.1.0 Galaxy Store’dan kurulmuş bir sürüm; içinde Dürbün SDK’sı açık değil.');
    expect(reasonText('storeBuild', fromInstaller('com.huawei.appmarket'))).toBe('Kumbara 3.1.0 Huawei AppGallery’den kurulmuş bir sürüm; içinde Dürbün SDK’sı açık değil.');
    expect(reasonText('storeBuild', fromInstaller('com.xiaomi.mipicks'))).toContain('Xiaomi GetApps mağazasından');
    expect(reasonText('storeBuild', fromInstaller('com.amazon.venezia'))).toContain('Amazon Appstore’dan');
    expect(reasonText('storeBuild', fromInstaller('ru.vk.store'))).toBe('Kumbara 3.1.0 başka bir mağazadan (ru.vk.store) kurulmuş bir sürüm; içinde Dürbün SDK’sı açık değil.');
    expect(buildBadgeLabel('other-store', 'com.sec.android.app.samsungapps')).toBe('Galaxy Store');
    expect(buildBadgeLabel('other-store', 'ru.vk.store')).toBe('Diğer mağaza');
    expect(buildBadgeHint('other-store', 'ru.vk.store')).toBe('Başka bir mağazadan kurulmuş (ru.vk.store).');
    expect(buildBadgeLabel('apk')).toBe('APK');
    expect(buildBadgeHint('other-store', 'com.android.packageinstaller')).toContain('APK elle kuruldu');
    expect(buildBadgeHint('release')).toBe('adb, Android Studio ya da flutter run ile kurulmuş bir release derlemesi.');
    expect(buildBadgeLabel('store-or-testflight')).toBe('Store / TestFlight / ad-hoc');
    // Narrow sidebar row: fits next to «Cihaz logu» even with a scrollbar (regression: «Store/TestF…» on a crowded iPhone).
    expect(buildBadgeLabel('store-or-testflight', undefined, { short: true })).toBe('Store/TF');
    expect(buildBadgeLabel('play', undefined, { short: true })).toBe('Play');
    const tf = explainSources({ device: device(IPHONE_ID), deviceApp: deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' } }), sessions: [] }).context;
    expect(reasonText('storeBuild', tf)).toBe('Kumbara 3.1.0 App Store, TestFlight ya da ad-hoc ile kurulmuş bir sürüm (iOS hangisi olduğunu söylemez); bu derlemede Dürbün SDK’sı açık değil.');
    // The team may ship the SDK in any build: a plain note, no "should be off" (decision of 2026-11-02).
    expect(reasonText('sdkInStoreBuild', tf)).toBe('Kumbara 3.1.0 App Store, TestFlight ya da ad-hoc ile kurulmuş bir sürüm (iOS hangisi olduğunu söylemez); içinde Dürbün SDK’sı açık, veriler SDK’dan geliyor.');
    expect(reasonText('sdkInStoreBuild', play.context)).toBe('Kumbara 3.1.0 Play Store’dan kurulmuş bir sürüm; içinde Dürbün SDK’sı açık, veriler SDK’dan geliyor.');
    // A physical iPhone cannot clear an app's data, and only developer builds can be stopped; Android and the simulator can.
    expect(reasonText('deviceToolsAvailable', tf, 'tools')).toBe('Cihaz araçları (uygulamayı başlat, ekran görüntüsü) SDK olmadan da çalışır; App Store ve TestFlight uygulamalarını Dürbün dışarıdan durduramaz.');
    const xcode = explainSources({ device: device(IPHONE_ID), deviceApp: deviceApp(IPHONE_ID, 'com.mykynk.pati', { buildType: 'debug', install: { source: 'xcode' } }), sessions: [] }).context;
    expect(reasonText('deviceToolsAvailable', xcode, 'tools')).toBe('Cihaz araçları (uygulamayı başlat / durdur, ekran görüntüsü) SDK olmadan da çalışır.');
    expect(reasonText('deviceToolsAvailable', play.context, 'tools')).toBe('Cihaz araçları (uygulamayı başlat / durdur, verisini temizle, ekran görüntüsü) SDK olmadan da çalışır.');
    expect(reasonText('storeBuild', tf, 'mocks')).toBe('Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; bu derlemede SDK açık değil.');
    expect(reasonText('storeBuild', tf, 'tools')).not.toContain('mağaza sürümünde');
    setLanguage('en');
    expect(reasonText('releaseWithoutSdk', fromInstaller('com.google.android.packageinstaller'))).toBe('Kumbara 3.1.0 was installed manually as an APK without the Dürbün SDK turned on.');
    expect(buildBadgeLabel('store-or-testflight')).toBe('Store / TestFlight / ad-hoc');
  });

  // Regression: texts said the SDK «mağaza sürümlerinde açılmaz» / turns itself off on a store install. There is no
  // install-source guard: the team decides per build, Dürbün supports every way a team ships.
  it('no text claims the SDK is off, must be off or turns itself off in store builds', () => {
    const GUARD = /açılmaz|kendini kapat|kapalı olmalı|kapalı kalmalı|(^|\s)asla(\s|$)|ASLA|yüklemeyin|never turned on|turns itself off|should ship with it off|must stay off|NEVER|Do not upload|no SDK\)|SDK yok\)/;
    for (const lang of ['tr', 'en'] as const) {
      const keys = messageKeys(lang).filter((k) => k.startsWith('sources.') || k.startsWith('shell.sdk.flutter.') || k === 'shell.sdk.releaseBy.flutter');
      expect(keys.length).toBeGreaterThan(150);
      for (const k of keys) expect(translate(lang, k), `${lang} ${k}`).not.toMatch(GUARD);
    }
  });

  it('Turkish and English define the same sources.* keys', () => {
    const tr = new Set(messageKeys('tr').filter((k) => k.startsWith('sources.')));
    const en = new Set(messageKeys('en').filter((k) => k.startsWith('sources.')));
    expect(tr.size).toBeGreaterThan(150);
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
  });
});

describe('sentences for disconnected devices, apps that have not run, other apps', () => {
  beforeEach(() => setLanguage('tr'));

  it('a disconnected device: one note, and each row says what stays readable', () => {
    const r = explained({ device: device(IPHONE_ID, { state: 'disconnected' }), deviceApp: deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' }, running: false, pids: [] }), sessions: [] });
    const ctx = r.result.context;
    const opts = { device: 'Yusuf’un iPhone’u' };
    expect(reasonText('readOnly', ctx, undefined, opts)).toBe('Yusuf’un iPhone’u bağlı değil; bağlantı kesilmeden önce gelenler ekranda. Yeniden bağlanınca kaldığı yerden devam eder.');
    expect(reasonText('readOnly', ctx, 'logs')).toBe('Bağlantı kesilmeden önce gelen loglar ekranda; cihaz yeniden bağlanınca akış kaldığı yerden devam eder.');
    expect(reasonText('readOnly', ctx, 'crashes')).toBe('Bağlantı kesilmeden önce okunan çökme kayıtları ekranda; yenileri cihaz yeniden bağlanınca okunur.');
    const { container } = render(<SourcesPanel item={r} />);
    const rows = [...container.querySelectorAll('.src-row')].map((li) => li.textContent ?? '');
    const logsRow = rows.find((x) => x.startsWith('Loglar'))!;
    const crashRow = rows.find((x) => x.startsWith('Çökmeler'))!;
    // Regression: both rows said «…mağaza sürümlerinde Dürbün SDK’sı açılmaz».
    for (const x of [logsRow, crashRow]) {
      expect(x).toContain('Kısmen');
      expect(x).not.toMatch(/mağaza|SDK|TestFlight/);
    }
    expect(screen.queryByRole('button', { name: 'Debug derlemesiyle dene' })).toBeNull();
  });

  // Regression: a phone waiting for «Güven» got «cihaz şu an bağlı değil» on the mocks and tools rows while it was plugged in.
  it('a device waiting for Trust / USB debugging: mocks and tools say what enables them, not "not connected"', () => {
    const iphone = explainSources({
      device: device(IPHONE_ID, { state: 'unauthorized', stateCode: 'device.untrusted' }),
      deviceApp: deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' } }),
      sessions: [],
    });
    const rowReasons = (cap: ExplainCapability) => iphone.rows.find((r) => r.capability === cap)!.reasons;
    expect(rowReasons('mocks')).toEqual(['readOnly']);
    expect(rowReasons('tools')).toEqual(['readOnly']);
    expect(reasonText('readOnly', iphone.context, 'mocks')).toBe('Mock’lar bağlı bir uygulamada çalışır; önce iPhone’da “Güven”e dokunun.');
    expect(reasonText('readOnly', iphone.context, 'tools')).toBe('Uygulama ve cihaz araçları, iPhone’da “Güven”e dokunduktan sonra kullanılabilir.');
    const pixel = explainSources({ device: device(PIXEL_ID, { state: 'unauthorized', stateCode: 'device.unauthorized' }), sessions: [] }).context;
    expect(reasonText('readOnly', pixel, 'mocks')).toBe('Mock’lar bağlı bir uygulamada çalışır; önce cihazdaki “USB hata ayıklamaya izin verilsin mi?” sorusunu onaylayın.');
    expect(reasonText('readOnly', pixel, 'tools')).toBe('Uygulama ve cihaz araçları, cihazdaki “USB hata ayıklamaya izin verilsin mi?” sorusunu onayladıktan sonra kullanılabilir.');
    setLanguage('en');
    expect(reasonText('readOnly', iphone.context, 'mocks')).toBe('Mocks run in a connected app; tap “Trust” on the iPhone first.');
    expect(reasonText('readOnly', pixel, 'tools')).toBe('App and device tools work once you accept the “Allow USB debugging?” prompt on the device.');
    setLanguage('tr');
    // A device that is really gone keeps the reconnect sentence.
    const gone = explainSources({ device: device(IPHONE_ID, { state: 'disconnected' }), sessions: [] }).context;
    expect(reasonText('readOnly', gone, 'mocks')).toBe('Mock’lar yalnızca bağlı bir uygulamada çalışır; cihaz şu an bağlı değil.');
  });

  it('an app that has not run: no "SDK yok", the right reason, a launch button once', () => {
    const r = explained({
      device: device(IPHONE_ID, { actions: ['app-launch', 'app-stop'] }),
      deviceApp: deviceApp(IPHONE_ID, 'com.mykynk.pati', { name: 'Pati', version: '2.4.1', build: '241', buildType: 'debug', install: { source: 'xcode' }, running: false, pids: [] }),
      sessions: [],
    });
    hubActions.replaceAll({ devices: [r.input.device!], apps: [], drivers: [], processes: [], deviceApps: [r.group.deviceApp!] });
    expect(summaryText(r.result.badge, r.result.context)).toBe(
      'Pati henüz Dürbün’e bağlanmadı: içinde Dürbün SDK’sı varsa açılınca kendiliğinden bağlanır, yoksa cihazın kendi kayıtları (log, çökme) görünür.',
    );
    expect(reasonText('notSeenYet', r.result.context, 'network')).toBe('Pati açılınca, içinde Dürbün SDK’sı varsa istekleri burada görünür.');
    const { container } = render(<SourcesPanel item={r} />);
    expect(container.textContent).not.toContain('SDK’sı yok');
    expect(container.textContent).toContain('Pati şu an açık değil');
    expect(screen.getAllByRole('button', { name: 'Uygulamayı başlat' })).toHaveLength(1);
  });

  it('a running debug build without a session: "has not connected", not "has no SDK"', () => {
    const ctx = explainSources({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.eski', { name: 'Eski', buildType: 'debug', install: { source: 'adb' } }), sessions: [] }).context;
    expect(reasonText('noSdk', ctx)).toBe('Eski 3.1.0 bu cihazda Dürbün SDK’sıyla bağlanmadı.');
    setLanguage('en');
    expect(reasonText('noSdk', ctx)).toBe('Eski 3.1.0 has not connected through the Dürbün SDK on this device.');
  });

  it('OkHttp wording follows the SDK: the native Android SDK vs a Flutter app’s native layer', () => {
    const flutter = explainSources({ device: device(PIXEL_ID), sessions: [session(PIXEL_ID)] }).context;
    const kotlin = explainSources({ device: device(PIXEL_ID), sessions: [session(PIXEL_ID, { sdk: { name: 'durbun-android', version: '0.3.0', platform: 'android' }, app: { name: 'Mahalle', id: 'com.mykynk.mahalle' } })] }).context;
    expect(reasonText('nativeNetworkNeedsInterceptor', flutter, 'network')).toBe('Native (Kotlin) katmanın kendi OkHttp istekleri, istemciye .addInterceptor(DurbunInterceptor()) eklendiyse görünür.');
    // Regression: native-Kotlin Mahalle was told about "the Kotlin layer".
    expect(reasonText('nativeNetworkNeedsInterceptor', kotlin, 'network')).toBe('OkHttp istekleri, istemciye .addInterceptor(DurbunInterceptor()) eklendiyse görünür.');
  });

  it('apps that are not the team’s: plain "from outside" wording, no build advice (hub decides who is own)', () => {
    const pati = deviceApp(IPHONE_ID, 'com.mykynk.pati', { name: 'Pati', buildType: 'debug', install: { source: 'xcode' } });
    const kumbara = deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' } });
    const whatsapp = deviceApp(IPHONE_ID, 'net.whatsapp.WhatsApp', { name: '\u200eWhatsApp', version: '25.31.74', build: '641', install: { source: 'store-or-testflight' } });
    hubActions.replaceAll({ devices: [device(IPHONE_ID)], apps: [], drivers: [], processes: [], deviceApps: [pati, kumbara, whatsapp] });
    const hub = useHub.getState(); // normalized like the wire data (bidi marks stripped)
    const wa = explainScope({ kind: 'deviceApp', deviceId: IPHONE_ID, bundleId: 'net.whatsapp.WhatsApp' }, hub).items[0]!;
    const kb = explainScope({ kind: 'deviceApp', deviceId: IPHONE_ID, bundleId: 'com.mykynk.kumbara' }, hub).items[0]!;
    expect(wa.input.own).toBe(false);
    expect(kb.input.own).toBeUndefined(); // shares com.mykynk with the Xcode build
    expect(summaryText(wa.result.badge, wa.result.context)).toBe('WhatsApp için yalnızca cihazın kendisinden okunanlar görünür: cihaz logu ve çökme kayıtları.');
    const { container } = render(<SourcesPanel item={wa} />);
    expect(container.textContent).toContain('WhatsApp sizin projelerinizden biri değilse ağ isteklerine ulaşmanın bir yolu yok.');
    expect(container.textContent).not.toContain('\u200e');
    // Regression: «Aynı sürümü … flutter run ile …», «--dart-define=DURBUN=true» and the release button for WhatsApp.
    expect(container.textContent).not.toContain('flutter run');
    expect(container.textContent).not.toContain('DURBUN=true');
    expect(screen.queryByRole('button', { name: 'Release derlemesinde nasıl açılır?' })).toBeNull();
    cleanup();
    render(<SourcesPanel item={kb} />);
    expect(screen.getAllByRole('button', { name: 'Release derlemesinde nasıl açılır?' })).toHaveLength(1);
  });

  it('the explanation follows the device’s readers and actions (signature)', () => {
    const base = { apps: {}, deviceApps: { [`${PIXEL_ID}|com.mykynk.kumbara`]: deviceApp(PIXEL_ID, 'com.mykynk.kumbara') } };
    const key = `${PIXEL_ID}|com.mykynk.kumbara`;
    const a = explainSignature({ ...base, devices: { [PIXEL_ID]: device(PIXEL_ID) } }, [key]);
    const b = explainSignature({ ...base, devices: { [PIXEL_ID]: device(PIXEL_ID, { readers: { crashReports: { status: 'unavailable', code: 'reader.crashReports.dropboxRefused' } } }) } }, [key]);
    const c = explainSignature({ ...base, devices: { [PIXEL_ID]: device(PIXEL_ID, { actions: [] }) } }, [key]);
    // Regression: a reader going down did not refresh an open "Neler görünüyor?" panel.
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });
});

describe('scope empty states: a closed app', () => {
  beforeEach(() => {
    setLanguage('tr');
    hubActions.replaceAll({ devices: [device(PIXEL_ID)], apps: [], drivers: [], processes: [], deviceApps: [deviceApp(PIXEL_ID, 'com.mykynk.kumbara', { running: false, pids: [] })] });
  });
  afterEach(() => act(() => setScope({ kind: 'all' })));

  it('Logs: "{app} şu an açık değil" with a launch button instead of the generic SDK hint', () => {
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL_ID, bundleId: 'com.mykynk.kumbara' }));
    const { container } = render(<ExplainEmpty capability="logs" fallback={<p>generic</p>} />);
    expect(container.textContent).toContain('Kumbara şu an açık değil');
    expect(container.textContent).toContain('Açtığınızda logları burada akmaya başlar.');
    expect(container.textContent).not.toContain('generic');
    expect(screen.getByRole('button', { name: 'Uygulamayı başlat' })).toBeTruthy();
    cleanup();
    // The same for a list that only holds the device's own system rows (the Logs view decides where it goes).
    const note = render(<NotRunningNote capability="logs" />).container.textContent ?? '';
    expect(note).toContain('Kumbara şu an açık değil');
    expect(note).toContain('Uygulamayı başlat');
  });

  it('a capability the build can never have still says why first; running apps keep the view’s own text', () => {
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL_ID, bundleId: 'com.mykynk.kumbara' }));
    const network = render(<ExplainEmpty capability="network" fallback={<p>generic</p>} />).container.textContent ?? '';
    expect(network).toContain('Kumbara için ağ istekleri görünmüyor');
    expect(network).toContain('SSL pinning');
    cleanup();
    hubActions.upsertDeviceApps([deviceApp(PIXEL_ID, 'com.mykynk.kumbara', { running: true, pids: [12873], lastActivity: Date.now() + 60_000 })]);
    expect(render(<ExplainEmpty capability="logs" fallback={<p>generic</p>} />).container.textContent).toBe('generic');
    expect(idleApp({ kind: 'app', items: [] })).toBeUndefined();
  });
});

describe('iPhone system processes left out by the server (iosDeviceLogScope)', () => {
  const iphone = device(IPHONE_ID);
  const hub = { apps: {}, devices: { [IPHONE_ID]: iphone, 'demo:3': device('demo:3', { platform: 'ios', name: 'iPhone 13 · Demo' }), [PIXEL_ID]: device(PIXEL_ID) } };
  const reported = new Set(Object.keys({ ...DEFAULT_SETTINGS }));
  afterEach(() => useServerSettings.setState({ settings: DEFAULT_SETTINGS, loaded: false, reported: undefined }));

  it('says so for a live iPhone in scope when the scope is "apps", never for the demo or Android', () => {
    expect(iosSystemLinesHidden({ kind: 'all' }, hub, { iosDeviceLogScope: 'apps' }, reported).map((d) => d.id)).toEqual([IPHONE_ID]);
    expect(iosSystemLinesHidden({ kind: 'device', deviceId: IPHONE_ID }, hub, {}, reported)).toHaveLength(1); // absent = 'apps'
    expect(iosSystemLinesHidden({ kind: 'device', deviceId: PIXEL_ID }, hub, { iosDeviceLogScope: 'apps' }, reported)).toEqual([]);
    expect(iosSystemLinesHidden({ kind: 'device', deviceId: 'demo:3' }, hub, { iosDeviceLogScope: 'apps' }, reported)).toEqual([]);
    expect(iosSystemLinesHidden({ kind: 'all' }, hub, { iosDeviceLogScope: 'all' }, reported)).toEqual([]);
    // An older server that does not know the setting streams everything: no claim.
    expect(iosSystemLinesHidden({ kind: 'all' }, hub, { iosDeviceLogScope: 'apps' }, new Set(['maxLogEntries']))).toEqual([]);
  });

  // Regression: «sistem süreçlerinin satırları gizli» next to the server's own line saying every line is shown.
  it('no claim for an iPhone whose server could not apply the scope (logs.scopeNotApplied)', () => {
    const unscoped = device(IPHONE_ID, { logs: { status: 'streaming', via: 'idevicesyslog', code: 'logs.scopeNotApplied', detail: 'All log lines are shown: telling app lines from system lines needs Xcode 15 or newer (devicectl)' } });
    const h = { apps: {}, devices: { [IPHONE_ID]: unscoped } };
    expect(iosSystemLinesHidden({ kind: 'all' }, h, { iosDeviceLogScope: 'apps' }, reported)).toEqual([]);
    expect(iosSystemLinesHidden({ kind: 'device', deviceId: IPHONE_ID }, h, { iosDeviceLogScope: 'apps' }, reported)).toEqual([]);
  });

  it('the note points to the setting', () => {
    setLanguage('tr');
    hubActions.replaceAll({ devices: [iphone], apps: [], drivers: [], processes: [] });
    setServerSettingsFromServer({ ...DEFAULT_SETTINGS, iosDeviceLogScope: 'apps' });
    act(() => setScope({ kind: 'device', deviceId: IPHONE_ID }));
    const { container } = render(<IosLogScopeNote />);
    expect(container.textContent).toContain('Yusuf’un iPhone’u: sistem süreçlerinin satırları gizli');
    expect(container.textContent).toContain('Ayarlar › Loglar › iPhone log kapsamı › Tümü');
    fireEvent.click(screen.getByRole('button', { name: 'Ayarları aç' }));
    expect(useUi.getState().settings).toBe('logs');
    useUi.setState({ settings: null });
    act(() => setScope({ kind: 'all' }));
  });
});

/* ───────────── log origins ───────────── */

describe('log origin labels', () => {
  const e = (p: Partial<LogEntry>): Pick<LogEntry, 'source' | 'origin' | 'data'> => ({ source: 'device', ...p });

  it('Turkish', () => {
    setLanguage('tr');
    expect(entrySourceText(e({ origin: 'logcat' }))).toBe('Cihaz logu · logcat');
    expect(entrySourceText(e({ origin: 'idevicesyslog' }))).toBe('Cihaz logu · iOS cihaz logu (idevicesyslog)');
    expect(entrySourceText(e({ origin: 'simctl-log' }))).toBe('Cihaz logu · Simülatör logu');
    expect(entrySourceText(e({ source: 'app', origin: 'sdk' }))).toBe('Uygulama logu · Dürbün SDK');
    expect(entrySourceText(e({ source: 'app', origin: 'vm-service' }))).toBe('Uygulama logu · Dart VM Service');
    expect(entrySourceText(e({ origin: 'dropbox' }))).toBe('Cihazın çökme kaydı (dropbox)');
    expect(entrySourceText(e({ origin: 'crash-report' }))).toBe('Çökme raporu (.ips)');
    expect(entrySourceText(e({ source: 'system', origin: 'durbun' }))).toBe('Dürbün sistem satırı');
    expect(entrySourceText(e({}))).toBe('Cihaz logu'); // older servers: no origin
    expect(entrySourceText(e({ source: 'app' }))).toBe('Uygulama logu (SDK)');
    expect(originLabel('durbun')).toBe('Dürbün');
    expect(originLabel('something-new')).toBe('something-new');
  });

  it('English', () => {
    setLanguage('en');
    expect(entrySourceText(e({ origin: 'logcat' }))).toBe('Device log · logcat');
    expect(entrySourceText(e({ origin: 'dropbox' }))).toBe('Device crash record (dropbox)');
    expect(entrySourceText(e({ source: 'app', origin: 'demo' }))).toBe('App log · Demo');
  });

  it('crash records: origin from data, symbolication', () => {
    expect(isDeviceCrashRecord({ data: { origin: 'dropbox' } })).toBe(true);
    expect(isDeviceCrashRecord({ origin: 'crash-report' })).toBe(true);
    expect(isDeviceCrashRecord({ origin: 'logcat' })).toBe(false);
    expect(isUnsymbolicated({ origin: 'crash-report' })).toBe(true);
    expect(isUnsymbolicated({ origin: 'dropbox' })).toBe(false);
    expect(isUnsymbolicated({ origin: 'dropbox', data: { symbolicated: false } })).toBe(true);
    expect(isUnsymbolicated({ origin: 'crash-report', data: { symbolicated: true } })).toBe(false);
  });
});

/* ───────────── empty-state reason selection ───────────── */

describe('pickEmptyReason', () => {
  const store = explained({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [] });
  const sdk = explained({ device: device(PIXEL_ID), sessions: [session(PIXEL_ID)] });
  const iosStore = explained({ device: device(IPHONE_ID), deviceApp: deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' } }), sessions: [] });

  it('no app in scope → generic', () => {
    expect(pickEmptyReason('network', { items: [] }).structural).toBe(false);
  });

  it('an app that can send it → generic ("nothing yet")', () => {
    expect(pickEmptyReason('network', { items: [sdk] })).toMatchObject({ structural: false, single: sdk });
    expect(pickEmptyReason('network', { items: [store, sdk] }).structural).toBe(false);
  });

  it('structural: reasons and actions of the row', () => {
    const p = pickEmptyReason('network', { items: [store] });
    expect(p).toMatchObject({ structural: true, status: 'no', reasons: ['storeBuild', 'noOutsideNetwork'], actions: ['useDebugBuild', 'buildWithDurbunFlag'], single: store });
  });

  it('several SDK-less apps: union of their reasons', () => {
    const debug = explained({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.eski', { buildType: 'debug', install: { source: 'adb' } }), sessions: [] });
    const p = pickEmptyReason('mocks', { items: [store, debug] });
    expect(p.structural).toBe(true);
    expect(p.single).toBeUndefined();
    expect(p.reasons).toEqual(['storeBuild', 'noSdk']);
  });

  it('partial only counts when asked (Performance)', () => {
    expect(pickEmptyReason('metrics', { items: [store] }).structural).toBe(false);
    expect(pickEmptyReason('metrics', { items: [store] }, { includePartial: true })).toMatchObject({ structural: true, status: 'partial', reasons: ['frameStatsApproximate'], actions: ['startProcessMetrics'] });
    expect(pickEmptyReason('metrics', { items: [iosStore] })).toMatchObject({ structural: true, status: 'no', reasons: ['iosNoDeviceMetrics'] });
  });
});

/* ───────────── rendering (jsdom smoke tests) ───────────── */

describe('"Neler görünüyor?" panel', () => {
  beforeEach(() => setLanguage('tr'));

  // Regression: the note was a warning («mağazaya çıkan derlemelerde SDK kapalı olmalı»).
  it('the SDK in a store build is a plain info note', () => {
    const kumbara = session(PIXEL_ID, { app: { name: 'Kumbara', id: 'com.mykynk.kumbara', version: '3.1.0', build: '412', pid: 12873, debug: false } });
    const item = explained({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [kumbara] });
    expect(item.result.notes).toContain('sdkInStoreBuild');
    const { container } = render(<SourcesPanel item={item} />);
    const notes = [...container.querySelectorAll('.src-note')];
    expect(notes.map((n) => n.textContent)).toContain('Kumbara 3.1.0 Play Store’dan kurulmuş bir sürüm; içinde Dürbün SDK’sı açık, veriler SDK’dan geliyor.');
    expect(container.querySelector('.callout--warn')).toBeNull();
    expect(notes.every((n) => n.classList.contains('callout--info'))).toBe(true);
  });

  it('renders the matrix in plain language, with reasons and de-duplicated actions', () => {
    const item = explained({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [] });
    const { container } = render(<SourcesPanel item={item} />);
    const text = container.textContent ?? '';
    for (const label of ['Loglar', 'Ağ istekleri', 'Performans', 'Çökmeler ve ANR’lar', 'Mock’lar', 'Uygulama içi araçlar']) expect(text).toContain(label);
    expect(text).toContain('Cihaz logu (logcat)');
    expect(text).toContain('Cihazın çökme kayıtları (dropbox)');
    expect(text).toContain('Kumbara 3.1.0 Play Store’dan kurulmuş bir sürüm; içinde Dürbün SDK’sı açık değil.');
    expect(text).toContain('Yalnızca cihaz logu');
    expect(text).toContain('Play');
    expect(text).toContain('3.1.0 (412)');
    // network, mocks and tools all offer the release switch: shown once
    expect(screen.getAllByRole('button', { name: 'Release derlemesinde nasıl açılır?' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Süreç metriklerini başlat' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'Görünmüyor' }).length).toBeGreaterThanOrEqual(3);
  });

  it('buttons navigate: the release switch opens the SDK guide at its section', () => {
    const item = explained({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [] });
    render(<SourcesPanel item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release derlemesinde nasıl açılır?' }));
    expect(useUi.getState().sdkGuide).toBe('flutter');
    expect(useUi.getState().sdkGuideSection).toBe('release');
    fireEvent.click(screen.getByRole('button', { name: /Veriler nereden gelir/ }));
    expect(useUi.getState().dataSources).toBe(true);
    useUi.setState({ sdkGuide: null, sdkGuideSection: null, dataSources: false });
  });

  it('opens from the ⓘ button as a popover', () => {
    hubActions.replaceAll({ devices: [device(PIXEL_ID)], apps: [], drivers: [], processes: [], deviceApps: [deviceApp(PIXEL_ID, 'com.mykynk.kumbara')] });
    render(<WhatCanISeeButton groupKey={`${PIXEL_ID}|com.mykynk.kumbara`} />);
    fireEvent.click(screen.getByRole('button', { name: 'Neler görünüyor?' }));
    const dialog = screen.getByRole('dialog', { name: 'Neler görünüyor?' });
    expect(dialog.textContent).toContain('Kumbara');
    expect(dialog.textContent).toContain('Ağ trafiği uygulamanın dışından okunamaz');
  });
});

describe('scope-specific empty states', () => {
  beforeEach(() => {
    setLanguage('tr');
    hubActions.replaceAll({
      devices: [device(PIXEL_ID)],
      apps: [session(PIXEL_ID)],
      drivers: [],
      processes: [],
      deviceApps: [deviceApp(PIXEL_ID, 'com.mykynk.kumbara')],
    });
  });
  afterEach(() => act(() => setScope({ kind: 'all' })));

  it('an SDK-less store build says why there is no network', () => {
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL_ID, bundleId: 'com.mykynk.kumbara' }));
    const { container } = render(<ExplainEmpty capability="network" fallback={<p>generic</p>} />);
    expect(container.textContent).toContain('Kumbara için ağ istekleri görünmüyor');
    expect(container.textContent).toContain('Play Store’dan kurulmuş');
    expect(container.textContent).not.toContain('generic');
  });

  it('an SDK app that simply sent nothing yet keeps the generic text', () => {
    act(() => setScope({ kind: 'app', appId: 'app:2' }));
    const { container } = render(<ExplainEmpty capability="network" fallback={<p>generic</p>} />);
    expect(container.textContent).toBe('generic');
  });

  it('"all devices" keeps the generic text', () => {
    const { container } = render(<ExplainEmpty capability="mocks" fallback={<p>generic</p>} />);
    expect(container.textContent).toBe('generic');
  });

  // Regression: a whole iPhone waiting for «Güven» got «Bu cihazdaki uygulamaların hiçbirinde Dürbün SDK’sı yok».
  it('a device waiting for Trust: one sentence about the device, not "none of the apps has the SDK"', () => {
    const waiting = device(IPHONE_ID, { state: 'unauthorized', stateCode: 'device.untrusted', logs: { status: 'unavailable', code: 'device.untrusted' } });
    const apps = [
      deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' }, running: false, pids: [] }),
      deviceApp(IPHONE_ID, 'com.mykynk.pati', { name: 'Pati', install: { source: 'xcode' }, buildType: 'debug', running: false, pids: [] }),
    ];
    act(() => {
      hubActions.replaceAll({ devices: [waiting], apps: [], drivers: [], processes: [], deviceApps: apps });
      setScope({ kind: 'device', deviceId: IPHONE_ID });
    });
    for (const cap of ['mocks', 'tools'] as const) {
      const text = render(<ExplainEmpty capability={cap} fallback={<p>generic</p>} />).container.textContent ?? '';
      expect(text, cap).toContain('iPhone’da “Güven”e dokun');
      expect(text, cap).not.toMatch(/hiçbirinde|bağlı değil|SDK’sı ya da Flutter debug oturumu ister/);
      expect(text.split('Güven”e dokun').length - 1, cap).toBe(1);
      cleanup();
    }
    // Unplugged: the reconnect sentence, once.
    act(() => hubActions.replaceAll({ devices: [{ ...waiting, state: 'disconnected', stateCode: undefined }], apps: [], drivers: [], processes: [], deviceApps: apps }));
    const gone = render(<ExplainEmpty capability="mocks" fallback={<p>generic</p>} />).container.textContent ?? '';
    expect(gone).toContain('Mock’lar yalnızca bağlı bir uygulamada çalışır; cihaz şu an bağlı değil.');
    expect(gone).not.toContain('hiçbirinde');
  });
});

describe('crash empty states: "none yet" vs "cannot be read"', () => {
  const refused = { crashReports: { status: 'unavailable' as const, code: 'reader.crashReports.dropboxRefused', detail: 'Permission Denial' } };
  const load = (readers: DeviceInfo['readers']) =>
    hubActions.replaceAll({ devices: [device(PIXEL_ID, { name: 'Galaxy S23', readers })], apps: [], drivers: [], processes: [], deviceApps: [deviceApp(PIXEL_ID, 'com.mykynk.kumbara')] });
  beforeEach(() => setLanguage('tr'));
  afterEach(() => act(() => setScope({ kind: 'all' })));

  it('records that cannot be read: never "no crashes", says why', () => {
    load(refused);
    act(() => setScope({ kind: 'deviceApp', deviceId: PIXEL_ID, bundleId: 'com.mykynk.kumbara' }));
    const { container } = render(<CrashRecordsNote />);
    expect(container.textContent).toContain('Galaxy S23 için çökme kayıtları okunamıyor');
    expect(container.textContent).toContain('Burada çökme görünmemesi, hiç çökme olmadığı anlamına gelmeyebilir.');
    expect(container.textContent).toContain('dumpsys dropbox');
    expect(crashRecordsState({ kind: 'all' }, { apps: {}, devices: { [PIXEL_ID]: device(PIXEL_ID, { readers: refused }) } }).unreadable).toHaveLength(1);
  });

  it('records that are read: "none yet" (or nothing at all with onlyProblems)', () => {
    load({ crashReports: { status: 'ok', lastOk: 1 } });
    act(() => setScope({ kind: 'device', deviceId: PIXEL_ID }));
    expect(render(<CrashRecordsNote />).container.textContent).toContain('Henüz çökme kaydı yok.');
    cleanup();
    expect(render(<CrashRecordsNote onlyProblems />).container.textContent).toBe('');
  });

  it('a server that does not report readers: no claim either way', () => {
    load(undefined);
    act(() => setScope({ kind: 'device', deviceId: PIXEL_ID }));
    expect(render(<CrashRecordsNote />).container.textContent).toBe('');
  });

  it('a polled process on a device without frame stats: FPS is explained', () => {
    load({ frameStats: { status: 'unavailable', code: 'reader.frameStats.noData' } });
    const { container } = render(<FrameStatsNote deviceId={PIXEL_ID} />);
    expect(container.textContent).toContain('FPS bu cihazda dışarıdan ölçülemiyor');
    expect(container.textContent).toContain('ne gfxinfo ne SurfaceFlinger');
  });
});

describe('sidebar with device apps', () => {
  beforeEach(() => {
    setLanguage('tr');
    hubActions.replaceAll({
      devices: [device(PIXEL_ID)],
      apps: [session(PIXEL_ID)],
      drivers: [],
      processes: [],
      deviceApps: [
        deviceApp(PIXEL_ID, 'com.mykynk.kumbara'),
        deviceApp(PIXEL_ID, 'com.mykynk.pati', { name: undefined, buildType: 'debug', install: { source: 'adb' }, pids: [15000] }),
      ],
    });
  });
  afterEach(() => act(() => setScope({ kind: 'all' })));

  it('lists SDK-less apps with source and build badges; selecting one scopes to it', () => {
    const { container } = render(<Sidebar />);
    const text = container.textContent ?? '';
    expect(text).toContain('Kumbara');
    expect(text).toContain('3.1.0 (412)');
    // narrow rows show the short badge; its accessible name and tooltip carry the full "Yalnızca cihaz logu"
    expect(text).toContain('Cihaz logu');
    expect(screen.getAllByLabelText('Yalnızca cihaz logu')).toHaveLength(1);
    expect(text).toContain('Play');
    expect(text).toContain('Pati'); // joined: the SDK session + the device's report are one row
    expect(text).toContain('Debug');
    expect(screen.getAllByRole('treeitem', { name: /Pati/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('treeitem', { name: /Kumbara/ }));
    expect(useScopeStore.getState().scope).toEqual({ kind: 'deviceApp', deviceId: PIXEL_ID, bundleId: 'com.mykynk.kumbara' });
    expect(screen.getAllByRole('button', { name: 'Neler görünüyor?' }).length).toBe(2);
  });

  it('folds apps that are not running when a device has many', () => {
    hubActions.upsertDeviceApps(
      Array.from({ length: 6 }, (_, i) => deviceApp(PIXEL_ID, `com.example.app${i}`, { name: `Uygulama ${i}`, running: false, pids: [], lastActivity: i })),
    );
    const { container } = render(<Sidebar />);
    expect(container.textContent).toContain('6 uygulama daha');
    expect(container.textContent).not.toContain('Uygulama 3');
    fireEvent.click(screen.getByRole('button', { name: /6 uygulama daha/ }));
    expect(container.textContent).toContain('Uygulama 3');
  });

  it('a tester’s iPhone full of suspended store apps folds the quiet ones (regression: 20 "running" rows)', () => {
    const now = Date.now();
    hubActions.replaceAll({
      devices: [device(IPHONE_ID)],
      apps: [],
      drivers: [],
      processes: [],
      deviceApps: [
        // iOS reports suspended apps with a live process: "running", but nothing happened for an hour.
        ...Array.from({ length: 8 }, (_, i) =>
          deviceApp(IPHONE_ID, `com.vendor.app${i}`, { name: `Mağaza ${i}`, install: { source: 'store-or-testflight' }, running: true, pids: [900 + i], lastActivity: now - 3_600_000 }),
        ),
        deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' }, processName: 'Runner', running: true, pids: [811], lastActivity: now - 20_000 }),
        deviceApp(IPHONE_ID, 'com.mykynk.pati', { name: 'Pati', buildType: 'debug', install: { source: 'xcode' }, processName: 'Runner', running: true, pids: [902], lastActivity: now - 3_600_000 }),
      ],
    });
    const { container } = render(<Sidebar />);
    const text = container.textContent ?? '';
    expect(text).toContain('Kumbara'); // active a moment ago
    expect(text).toContain('Pati'); // a developer build
    expect(text).not.toContain('Mağaza 3');
    expect(text).toContain('8 uygulama daha');
  });
});

describe('sidebar: stable rows while a device flaps', () => {
  beforeEach(() => setLanguage('tr'));

  it('an iPhone that drops for a moment keeps its rows unfolded; names are never cut by the version', () => {
    const now = Date.now();
    const apps = (running: boolean) => [
      deviceApp(IPHONE_ID, 'com.mykynk.kumbara', { install: { source: 'store-or-testflight' }, processName: 'Runner', running, pids: running ? [811] : [], lastActivity: now - 20_000 }),
      deviceApp(IPHONE_ID, 'com.google.chrome.ios', { name: '\u200eChrome', version: '1.261030.19', build: '41161136480', install: { source: 'store-or-testflight' }, running, pids: running ? [900] : [], lastActivity: now - 10_000 }),
      ...Array.from({ length: 6 }, (_, i) => deviceApp(IPHONE_ID, `com.vendor.app${i}`, { name: `Mağaza ${i}`, install: { source: 'store-or-testflight' }, running, pids: running ? [950 + i] : [], lastActivity: now - 3_600_000 })),
    ];
    hubActions.replaceAll({ devices: [device(IPHONE_ID)], apps: [], drivers: [], processes: [], deviceApps: apps(true) });
    const { container } = render(<Sidebar />);
    expect(container.textContent).toContain('Kumbara');
    expect(container.textContent).toContain('6 uygulama daha');
    // The name has its own non-shrinking part; the version (build) truncates instead. Bidi marks are gone.
    const name = [...container.querySelectorAll('.sb-app__name')].find((n) => n.textContent === 'Chrome');
    expect(name).toBeTruthy();
    expect(name!.nextElementSibling?.className).toContain('sb-app__ver');
    expect(name!.nextElementSibling?.textContent).toBe('1.261030.19 (41161136480)');
    // Unplugged: the hub marks every app as not running at once.
    act(() => {
      hubActions.upsertDevices([device(IPHONE_ID, { state: 'disconnected' })]);
      hubActions.upsertDeviceApps(apps(false));
    });
    // Regression: the rows collapsed into «Son açılanlar · 8» and expanded again on every re-attach.
    expect(container.textContent).not.toContain('Son açılanlar');
    expect(container.textContent).toContain('Kumbara');
    expect(container.textContent).toContain('6 uygulama daha');
  });
});

describe('"Veriler nereden gelir?" explainer', () => {
  it('renders the cards and a matrix built from the same rules', () => {
    setLanguage('tr');
    const { container } = render(<DataSourcesExplainer />);
    const text = container.textContent ?? '';
    expect(text).toContain('Cihaz logları: USB yeterli');
    expect(text).toContain('Ağ neden dışarıdan görünmez?');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(6);
    // store column: network not available; debug column: network from the VM service
    const networkRow = [...container.querySelectorAll('tbody tr')].find((r) => r.textContent?.startsWith('Ağ istekleri'))!;
    const cells = networkRow.querySelectorAll('td');
    expect(cells[1]!.textContent).toContain('Dart VM Service');
    expect(cells[2]!.textContent).toContain('Dürbün SDK');
    expect(cells[3]!.textContent).toContain('Görünmüyor');
  });
});
