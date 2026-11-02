import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceInfo, ToolCheck } from '@durbun/protocol';
import '../i18n';
import { setLanguage } from '../i18n/core';
import { hubActions } from '../data/stores/hub';
import { DOCTOR_DETAIL_KEYS, checkDetail, checkFix, checkLabel } from './doctorText';
import { messageKeys } from '../i18n/core';
import { checkGroup } from './DoctorDialog';
import * as S from './sdkSnippets';
import { sdkHostLines } from './sdkHosts';
import { noticeToastParts } from './notices';
import { Sidebar } from './Sidebar';

afterEach(() => {
  cleanup();
  setLanguage('en');
});

/** `GET /api/doctor` of the real server on the dev Mac (2026-11-02), plus failure variants from the server source. */
const REAL_CHECKS: ToolCheck[] = [
  { id: 'node', label: 'Node.js', status: 'ok', version: 'v22.23.4', path: '/usr/local/bin/node' },
  { id: 'data-dir', label: 'Data directory', status: 'ok', path: '/Users/x/.durbun' },
  { id: 'ui-build', label: 'UI build', status: 'ok', path: '/repo/dist/ui' },
  { id: 'port-http', label: 'HTTP port 9768', path: '127.0.0.1:9768', status: 'ok', detail: 'Listening on 127.0.0.1:9768' },
  { id: 'port-sdk', label: 'SDK port 9769', path: '127.0.0.1:9769', status: 'ok', detail: 'Listening on 127.0.0.1:9769' },
  { id: 'adb', label: 'Android Debug Bridge (adb)', status: 'ok', version: '1.0.41 (37.0.0-14910828)', path: '/Users/x/Library/Android/sdk/platform-tools/adb', detail: 'from ~/Library/Android/sdk' },
  { id: 'simctl', label: 'Xcode simctl (iOS simulators)', status: 'ok', version: 'Xcode 27.2', path: '/Applications/Xcode.app/Contents/Developer', detail: '0 booted simulator(s)' },
  { id: 'usbmuxd', label: 'usbmuxd (iOS USB connection)', status: 'ok', path: '/var/run/usbmuxd', detail: '0 device(s) attached' },
  {
    id: 'idevicesyslog',
    label: 'idevicesyslog (iOS device logs)',
    status: 'ok',
    version: '1.3.0-266-g0bf0f9e',
    path: '/Users/x/fvm/versions/3.38.5/bin/cache/artifacts/libimobiledevice/idevicesyslog',
    detail: 'from Flutter 3.38.5 cache (/Users/x/fvm/versions/3.38.5)',
  },
  { id: 'devicectl', label: 'Xcode devicectl (iOS device actions)', status: 'ok', version: '651.32', detail: 'screenshot: yes · screen recording: yes' },
  { id: 'idevicescreenshot', label: 'idevicescreenshot (iOS screenshots, fallback)', status: 'ok', path: '/x/idevicescreenshot', detail: 'from Flutter 3.38.5 cache (/x)' },
  { id: 'flutter-vm', label: 'Flutter / Dart VM service bridge', status: 'ok', detail: '0 attached · auto-attach on' },
];

const FAILING_CHECKS: ToolCheck[] = [
  { id: 'node', label: 'Node.js', status: 'error', version: 'v18.0.0', detail: 'Dürbün needs Node.js 20 or newer', fix: 'brew install node' },
  { id: 'ui-build', label: 'UI build', status: 'warn', detail: 'No built UI found (dist/ui). The server works, but the browser shows a placeholder page.', fix: 'npm run build' },
  { id: 'port-sdk', label: 'SDK port 9751', path: '127.0.0.1:9751', status: 'error', detail: 'Port 9751 is already used by another program', fix: 'lsof -nP -iTCP:9751 -sTCP:LISTEN' },
  { id: 'data-dir', label: 'Data directory', status: 'error', path: '/x', detail: 'Not writable: EACCES: permission denied', fix: 'durbun --data-dir <writable folder>' },
  {
    id: 'adb',
    label: 'Android Debug Bridge (adb)',
    status: 'missing',
    detail: 'adb not found (settings.adbPath, $ANDROID_HOME, ~/Library/Android/sdk/platform-tools, PATH)',
    fix: 'brew install --cask android-platform-tools',
  },
  {
    id: 'simctl',
    label: 'Xcode simctl (iOS simulators)',
    status: 'missing',
    detail: 'Only the Command Line Tools are selected; simctl/devicectl need Xcode',
    fix: 'Install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app',
  },
  { id: 'usbmuxd', label: 'usbmuxd (iOS USB connection)', status: 'missing', path: '/var/run/usbmuxd', detail: 'connect ENOENT /var/run/usbmuxd', fix: 'Install and start usbmuxd' },
  {
    id: 'idevicesyslog',
    label: 'idevicesyslog (iOS device logs)',
    status: 'missing',
    detail: 'idevicesyslog was not found — install libimobiledevice (brew install libimobiledevice) or Flutter',
    fix: 'brew install libimobiledevice',
  },
  { id: 'devicectl', label: 'Xcode devicectl (iOS device actions)', status: 'warn', detail: 'Install Xcode 15 or newer to launch/stop/install apps on iOS devices', fix: 'Install Xcode from the App Store' },
  { id: 'flutter-vm', label: 'Flutter / Dart VM service bridge', status: 'ok', detail: '2 attached (Pati, Mahalle) · auto-attach off — paste the "A Dart VM Service … is available at" URL to attach manually' },
  { id: 'driver-ios-device-checks', label: 'iOS device', status: 'error', detail: 'Checks failed: iOS device checks timed out after 20 s' },
  { id: 'driver-android', label: 'android', status: 'error', detail: 'The android driver failed to initialize: spawn EPERM' },
];

describe('Doctor text', () => {
  it('localizes every check the real server returns on this Mac (Turkish)', () => {
    setLanguage('tr');
    const rows = REAL_CHECKS.map((c) => [checkLabel(c), checkDetail(c) ?? '']);
    expect(rows).toEqual([
      ['Node.js', ''],
      ['Veri klasörü', ''],
      ['Arayüz derlemesi', ''],
      ['HTTP portu (9768)', '127.0.0.1:9768 adresinde dinliyor'],
      ['SDK portu (9769)', '127.0.0.1:9769 adresinde dinliyor'],
      ['Android Debug Bridge (adb)', '~/Library/Android/sdk içinden'],
      ['iOS simülatör aracı (simctl)', '0 açık simülatör'],
      ['iOS USB bağlantısı (usbmuxd)', '0 cihaz bağlı'],
      ['iOS cihaz logları (idevicesyslog)', 'Flutter 3.38.5 önbelleğinden'],
      ['iOS cihaz aracı (devicectl)', 'ekran görüntüsü: var · ekran kaydı: var'],
      ['iOS ekran görüntüsü (idevicescreenshot, yedek)', 'Flutter 3.38.5 önbelleğinden'],
      ['Flutter / Dart VM Service köprüsü', '0 uygulama bağlı · otomatik bağlanma açık'],
    ]);
    expect(REAL_CHECKS.map((c) => checkGroup(c.id))).toEqual(['durbun', 'durbun', 'durbun', 'durbun', 'durbun', 'android', 'ios', 'ios', 'ios', 'ios', 'ios', 'flutter']);
  });

  it('turns failures into localized text plus a copyable command', () => {
    setLanguage('tr');
    const byId = (id: string) => FAILING_CHECKS.find((c) => c.id === id)!;
    expect(checkDetail(byId('node'))).toBe('Dürbün için Node.js 20 ya da daha yenisi gerekir');
    expect(checkFix(byId('node'))).toEqual({ command: 'brew install node', text: undefined });
    expect(checkFix(byId('ui-build'))).toEqual({ text: 'Arayüzü derlemek için Dürbün klasöründe:', command: 'npm run build' });
    expect(checkDetail(byId('port-sdk'))).toBe('9751 portunu başka bir program kullanıyor');
    expect(checkFix(byId('port-sdk'))?.command).toBe('lsof -nP -iTCP:9751 -sTCP:LISTEN');
    expect(checkDetail(byId('data-dir'))).toBe('Yazılamıyor: EACCES: permission denied');
    expect(checkFix(byId('simctl'))).toEqual({ text: 'Xcode’u App Store’dan kurun, ardından:', command: 'sudo xcode-select -s /Applications/Xcode.app' });
    expect(checkDetail(byId('simctl'))).toBe('Yalnızca Command Line Tools seçili; simctl ve devicectl için Xcode gerekir');
    expect(checkFix(byId('usbmuxd'))).toEqual({ text: 'usbmuxd’yi kurup başlatın' });
    expect(checkFix(byId('devicectl'))).toEqual({ text: 'Xcode’u App Store’dan kurun' });
    expect(checkDetail(byId('flutter-vm'))).toBe('2 uygulama bağlı (Pati, Mahalle) · otomatik bağlanma kapalı (elle bağlanmak için: SDK kurulumu → Flutter)');
    expect(checkLabel(byId('driver-ios-device-checks'))).toBe('iOS cihaz kontrolleri');
    expect(checkDetail(byId('driver-ios-device-checks'))).toBe('Kontroller çalıştırılamadı: iOS device checks timed out after 20 s');
    expect(checkLabel(byId('driver-android'))).toBe('Android (adb) sürücüsü');
    expect(checkDetail(byId('driver-android'))).toBe('Başlatılamadı: spawn EPERM');
    // Unknown ids / details fall back to the server's English text.
    expect(checkLabel({ id: 'something-new', label: 'Something new', status: 'ok' })).toBe('Something new');
    expect(checkDetail({ detail: 'A brand new detail' })).toBe('A brand new detail');
  });

  it('has Turkish and English text for every recognized detail', () => {
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const missing = DOCTOR_DETAIL_KEYS.map((k) => `shell.doctor.detail.${k}`).filter((k) => !tr.has(k) || !en.has(k));
    expect(missing).toEqual([]);
  });

  it('leaves no placeholder behind in either language', () => {
    for (const lang of ['tr', 'en'] as const) {
      setLanguage(lang);
      for (const c of [...REAL_CHECKS, ...FAILING_CHECKS]) {
        const fix = checkFix(c);
        for (const text of [checkLabel(c), checkDetail(c) ?? '', fix?.text ?? '', fix?.command ?? '']) expect(text, `${lang} ${c.id}: ${text}`).not.toMatch(/\{\s*\w+/);
      }
    }
  });
});

/* ───────────── SDK snippets vs. the real SDKs ───────────── */

function repoRoot(): string | undefined {
  for (const candidate of [process.cwd(), join(process.cwd(), '..'), join(process.cwd(), '../..')]) {
    if (existsSync(join(candidate, 'sdks')) && existsSync(join(candidate, 'packages/ui'))) return candidate;
  }
  return undefined;
}

function readTree(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.build' || name === 'build' || name === '.gradle' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) readTree(p, exts, out);
    else if (exts.test(name)) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}

describe('SDK guide snippets', () => {
  const root = repoRoot();
  const sources = (rel: string, exts: RegExp) => (root ? readTree(join(root, rel), exts).join('\n') : '');

  it('only uses APIs that exist in the real SDKs', () => {
    if (!root) return;
    const flutter = sources('sdks/flutter', /\.(dart|md|yaml)$/);
    const android = sources('sdks/android', /\.(kt|kts|md)$/);
    const ios = sources('sdks/ios', /\.(swift|md)$/);
    const js = sources('sdks/js', /\.(ts|md|json)$/);
    const expectIn = (haystack: string, needles: string[], where: string) => {
      for (const n of needles) expect(haystack.includes(n), `${where}: ${n}`).toBe(true);
    };
    expectIn(flutter, ["import 'package:durbun/durbun.dart';", 'Durbun.run(() async {', 'WidgetsFlutterBinding.ensureInitialized();', 'DurbunDioInterceptor(dio: dio)', "import 'package:durbun_dio/durbun_dio.dart';", 'name: durbun_dio', '--dart-define=DURBUN_HOST=', '--dart-define=DURBUN=true', 'static void event(', 'static void d(', 'Object? data,', 'StackTrace? stackTrace,'], 'flutter');
    expectIn(android, ['include(":durbun", ":durbun-noop")', 'debugImplementation(project(":durbun"))', 'releaseImplementation(project(":durbun-noop"))', '"profileImplementation"(project(":durbun-noop"))', 'Durbun.start(this)', '.addInterceptor(DurbunInterceptor())', 'fun log(level: Level, tag: String?, message: String, data: Any? = null, throwable: Throwable? = null)', 'fun e(tag: String?, message: String', 'DurbunOptions(host = "', 'package dev.durbun', 'class DurbunInterceptor'], 'android');
    expectIn(ios, ['name: "Durbun"', '.library(name: "Durbun"', 'public static func start(options: DurbunOptions = DurbunOptions())', 'level: DurbunLogLevel = .info', 'public static func warning(', 'public static func event(_ name: String, _ props: [String: Any]? = nil)', 'NSLocalNetworkUsageDescription', 'host: String? = nil', 'port: UInt16 = 9751'], 'ios');
    expectIn(js, ['"name": "@durbun/react-native"', "import { Durbun } from '@durbun/react-native';", 'Durbun.start();', 'npm pack', 'error(message: string, error: unknown): void;'], 'js');
    // The iOS snippet must use the local package's identity (the folder name), not the declared name.
    expect(S.iosPackage('/r', 'en')).toContain('.product(name: "Durbun", package: "ios")');
    // npm pack file name follows the SDK's package.json version.
    const version = (JSON.parse(readFileSync(join(root, 'sdks/js/package.json'), 'utf8')) as { version: string }).version;
    expect(S.RN_TGZ).toBe(`durbun-react-native-${version}.tgz`);
  });

  it('quotes repository paths with spaces and spells non-default ports for Wi-Fi', () => {
    const repo = '/Users/yusuf/Library/Application Support/durbun';
    expect(S.flutterPubspec(repo)).toContain(`path: "${repo}/sdks/flutter/durbun"`);
    expect(S.androidSettings(repo)).toContain(`file("${repo}/sdks/android/durbun")`);
    expect(S.rnPack(repo, 'tr')).toContain(`cd "${repo}/sdks/js" && npm pack`);
    expect(sdkHostLines('192.168.1.20').map((l) => l.code)).toEqual([
      'flutter run --dart-define=DURBUN_HOST=192.168.1.20',
      'Durbun.start(this, DurbunOptions(host = "192.168.1.20"))',
      'Durbun.start(options: .init(host: "192.168.1.20"))',
      "Durbun.start({ host: '192.168.1.20' });",
    ]);
    expect(sdkHostLines('10.0.0.5', { http: 9768, sdk: 9769 }).map((l) => l.code)).toEqual([
      'flutter run --dart-define=DURBUN_HOST=10.0.0.5:9769',
      'Durbun.start(this, DurbunOptions(host = "10.0.0.5", port = 9769))',
      'Durbun.start(options: .init(host: "10.0.0.5", port: 9769))',
      "Durbun.start({ host: '10.0.0.5:9768' });",
    ]);
    expect(S.flutterMain('tr')).toContain('// zone içinde çağırın');
    expect(S.flutterMain('en')).toContain('// call it inside the zone');
  });
});

/* ───────────── Notices ───────────── */

describe('notice toasts', () => {
  it('split into a short title and a description', () => {
    setLanguage('tr');
    expect(noticeToastParts({ code: 'settings.lanOff', params: { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }, message: 'x' })).toEqual({
      title: 'Yerel ağ modu kapandı',
      description: 'SDK portu (9751) artık yalnızca bu Mac’ten bağlantı kabul ediyor.',
    });
    expect(noticeToastParts({ code: 'replay.bodyDropped', message: 'GET requests cannot carry a body; it was dropped' })).toEqual({
      title: 'GET ve HEAD istekleri gövde taşıyamaz; gövde çıkarıldı',
    });
    expect(noticeToastParts({ code: 'settings.adjusted', params: { details: 'watchedApps normalized (trimmed, de-duplicated)' }, message: 'x' })).toEqual({
      title: 'Bazı değerler düzeltildi',
      description: 'İzlenen uygulamalar listesi düzenlendi (boşluklar ve tekrarlar temizlendi)',
    });
  });
});

/* ───────────── Sidebar: virtual devices and device-state hints ───────────── */

function device(id: string, p: Partial<DeviceInfo>): DeviceInfo {
  return { id, platform: 'android', kind: 'physical', name: id, connection: 'usb', state: 'online', logs: { status: 'streaming', via: 'logcat' }, actions: [], firstSeen: 1, lastSeen: 1, ...p };
}

describe('Sidebar', () => {
  beforeEach(() => {
    hubActions.replaceAll({
      devices: [
        device('android:R5CT', { name: 'Galaxy S23', state: 'unauthorized', stateCode: 'device.unauthorized', logs: { status: 'unavailable', code: 'device.unauthorized' } }),
        device('ios:00008120', { platform: 'ios', name: 'Yusuf’un iPhone’u', state: 'unauthorized', stateCode: 'device.untrusted', logs: { status: 'unavailable', code: 'device.untrusted' } }),
        device('net:ios-iphone15-2-test', { platform: 'ios', name: 'Test iPhone', connection: 'wifi', osVersion: '18.1', logs: { status: 'unavailable', code: 'logs.networkOnly' } }),
        device('import:1', { name: '📁 Pixel 8 · Demo', osVersion: '15', apiLevel: 35, state: 'disconnected', stateCode: 'device.imported', stateDetail: 'Imported from pati-odeme', logs: { status: 'stopped' } }),
        device('desktop', { platform: 'other', kind: 'virtual', name: 'Desktop', connection: 'local', logs: { status: 'unavailable', detail: 'Requests replayed from Dürbün' } }),
      ],
      apps: [],
      drivers: [],
      processes: [],
    });
  });

  it('shows localized hints and treats desktop / imported / network-only devices as such (Turkish)', () => {
    setLanguage('tr');
    const { container } = render(<Sidebar />);
    const text = container.textContent ?? '';
    expect(text).toContain('Cihazdaki “USB hata ayıklamaya izin verilsin mi?” sorusunu onaylayın');
    expect(text).toContain('Cihazın kilidini açın ve “Bu bilgisayara güvenilsin mi?” sorusunda Güven’e dokunun');
    expect(text).toContain('iOS 18.1 · yalnızca SDK verisi');
    expect(text).toContain('Masaüstü · yeniden gönderilenler');
    expect(text).not.toContain('Desktop');
    expect(text).toContain('📁 Pixel 8 · Demo');
    expect(text).toContain('İçe aktarıldı');
    expect(text).toContain('Android 15 · API 35');
    // An imported recording is not shown as an unplugged device.
    const imported = [...container.querySelectorAll('.sb-node')].find((n) => n.textContent?.includes('📁'))!;
    expect(imported.textContent).not.toContain('Bağlantı kesildi');
    expect(imported.querySelector('.sb-row.is-dim')).toBeNull();
    expect(container.querySelector('.sb-conn')?.textContent).toBeTruthy();
  });

  it('uses English texts when the UI is in English', () => {
    setLanguage('en');
    const { container } = render(<Sidebar />);
    const text = container.textContent ?? '';
    expect(text).toContain('Desktop · replays');
    expect(text).toContain('SDK data only');
    expect(text).toContain('Imported');
    expect(text).toContain('Unlock the device and tap Trust on “Trust This Computer?”');
  });
});
