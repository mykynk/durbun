import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppSession, DeviceApp, DeviceInfo, LogEntry } from '@durbun/protocol';
import '../i18n';
import { messageKeys, setLanguage } from '../i18n/core';
import { explainSources, type ExplainCapability, type ExplainContext, type ExplainReason, type ExplainInput } from '../data/explain';
import { hubActions } from '../data/stores/hub';
import { setScope, useScopeStore } from '../data/stores/scope';
import { useUi } from '../data/stores/ui';
import { Sidebar } from '../shell/Sidebar';
import { entrySourceText, isDeviceCrashRecord, isUnsymbolicated, originLabel, reasonText, summaryText } from './text';
import { pickEmptyReason, explainGroup, type ExplainedApp } from './model';
import { ExplainEmpty, SourcesPanel, WhatCanISeeButton } from './components';
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
    expect(reasonText('storeBuild', play.context)).toBe('Kumbara 3.1.0 Play Store’dan kurulmuş bir sürüm; mağaza sürümlerinde Dürbün SDK’sı açılmaz.');
    expect(reasonText('noOutsideNetwork', play.context, 'network')).toContain('SSL pinning');
    expect(reasonText('noOutsideNetwork', play.context, 'network')).toContain('kullanıcı sertifikalarına');
    expect(summaryText(play.badge, play.context)).toBe('Kumbara içinde Dürbün SDK’sı yok; Dürbün yalnızca cihazın kendi kayıtlarını okuyor.');
  });

  it('English', () => {
    setLanguage('en');
    expect(reasonText('storeBuild', play.context)).toBe('Kumbara 3.1.0 was installed from the Play Store; the Dürbün SDK is never turned on in store builds.');
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
    expect(reasonText('noSdk', undefined, 'mocks')).toBe('Mock’lar uygulamanın içinde, Dürbün SDK’sı tarafından uygulanır.');
    expect(reasonText('storeBuild', { ...play.context!, appName: undefined, bundleId: undefined })).toBe('Bu Play Store’dan kurulmuş bir sürüm; mağaza sürümlerinde Dürbün SDK’sı açılmaz.');
  });

  it('every reason × capability × context renders in both languages without placeholders', () => {
    const reasons: ExplainReason[] = [
      'noSdk', 'releaseWithoutSdk', 'storeBuild', 'noOutsideNetwork', 'vmServiceNoMocks', 'sdkLacksCapability', 'iosNoDeviceMetrics', 'frameStatsApproximate',
      'deviceLogsUnavailable', 'toolMissing', 'releaseLogsDependOnApp', 'nativeNetworkNeedsInterceptor', 'thirdPartyTraffic', 'crashesUnsymbolicated', 'notRunning',
      'readOnly', 'fpsNeedsApp', 'networkOnly', 'deviceToolsAvailable', 'sdkInStoreBuild',
    ];
    const caps: (ExplainCapability | undefined)[] = ['logs', 'network', 'metrics', 'crashes', 'mocks', 'tools', undefined];
    const contexts: (ExplainContext | undefined)[] = [
      undefined,
      play.context,
      explainSources({ device: device(IPHONE_ID), deviceApp: deviceApp(IPHONE_ID, 'k', { name: undefined, version: undefined, install: { source: 'other-store' } }), sessions: [] }).context,
      explainSources({ device: device('import:1', { state: 'disconnected' }), sessions: [session('import:1', { transport: 'import' })] }).context,
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

  it('Turkish and English define the same sources.* keys', () => {
    const tr = new Set(messageKeys('tr').filter((k) => k.startsWith('sources.')));
    const en = new Set(messageKeys('en').filter((k) => k.startsWith('sources.')));
    expect(tr.size).toBeGreaterThan(150);
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
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

  it('renders the matrix in plain language, with reasons and de-duplicated actions', () => {
    const item = explained({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [] });
    const { container } = render(<SourcesPanel item={item} />);
    const text = container.textContent ?? '';
    for (const label of ['Loglar', 'Ağ istekleri', 'Performans', 'Çökmeler ve ANR’lar', 'Mock’lar', 'Uygulama içi araçlar']) expect(text).toContain(label);
    expect(text).toContain('Cihaz logu (logcat)');
    expect(text).toContain('Cihazın çökme kayıtları (dropbox)');
    expect(text).toContain('Kumbara 3.1.0 Play Store’dan kurulmuş bir sürüm; mağaza sürümlerinde Dürbün SDK’sı açılmaz.');
    expect(text).toContain('Yalnızca cihaz logu');
    expect(text).toContain('Play');
    expect(text).toContain('3.1.0 (412)');
    // network, mocks and tools all offer "İç test derlemesinde aç": shown once
    expect(screen.getAllByRole('button', { name: 'İç test derlemesinde aç' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Süreç metriklerini başlat' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'Görünmüyor' }).length).toBeGreaterThanOrEqual(3);
  });

  it('buttons navigate: the release switch opens the SDK guide at its section', () => {
    const item = explained({ device: device(PIXEL_ID), deviceApp: deviceApp(PIXEL_ID, 'com.mykynk.kumbara'), sessions: [] });
    render(<SourcesPanel item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'İç test derlemesinde aç' }));
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
});

describe('"Veriler nereden gelir?" explainer', () => {
  it('renders the cards and a matrix built from the same rules', () => {
    setLanguage('tr');
    const { container } = render(<DataSourcesExplainer />);
    const text = container.textContent ?? '';
    expect(text).toContain('Cihaz logları: yalnızca USB');
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
