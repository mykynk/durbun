import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { messageKeys, setLanguage, type Lang } from './core';
import {
  LOCAL_CODES,
  SERVER_CODES,
  allServerCodes,
  deviceDisplayName,
  deviceStateText,
  driverStatusText,
  errorDetail,
  errorText,
  logStatusText,
  tCodeIn,
} from './codes';
import './foundation';

const LANGS: Lang[] = ['tr', 'en'];
const FALLBACK = '«server english»';

afterAll(() => setLanguage('en'));

/** Realistic params, as the real server sends them (captured from `durbun --demo` + the server source). */
const SYSTEM_SAMPLES: [code: string, params: Record<string, string | number>][] = [
  ['device.connected', { device: 'Pixel 8 · Demo', deviceId: 'demo:1', platform: 'android', kind: 'emulator', connection: 'local', osVersion: '15' }],
  ['device.connected', { device: 'Yusuf’un iPhone’u', deviceId: 'ios:00008120-001A', platform: 'ios', kind: 'physical', connection: 'usb', osVersion: '18.1' }],
  ['device.connected', { device: 'Galaxy S23', deviceId: 'android:192.168.1.40:5555', platform: 'android', kind: 'physical', connection: 'wifi', osVersion: '' }],
  ['device.connected', { device: 'Network device', deviceId: 'net:other-unknown-unknown', platform: 'other', kind: 'physical', connection: 'local', osVersion: '' }],
  ['device.disconnected', { device: 'iPhone 16 Pro', deviceId: 'ios-sim:5E1D', state: 'disconnected', detail: 'Simulator shut down' }],
  ['device.disconnected', { device: 'Galaxy S23', deviceId: 'android:R5CW', state: 'offline', detail: 'adb reports the device as offline — reconnect the cable or run "adb kill-server".' }],
  ['device.disconnected', { device: 'Pixel 7', deviceId: 'android:2A1', state: 'unauthorized', detail: 'Unlock the device and accept the "Allow USB debugging?" prompt (RSA key fingerprint).' }],
  ['device.disconnected', { device: 'Pixel 7', deviceId: 'android:2A1', state: 'disconnected', detail: '' }],
  ['device.disconnected', { device: 'Pixel 8 · Demo', deviceId: 'demo:1', state: 'disconnected', detail: 'Demo mode turned off' }],
  ['device.disconnected', { device: 'iPhone', deviceId: 'net:ios-iphone-iphone', state: 'disconnected', detail: 'No app is connected over the network' }],
  ['app.connected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'flutter', transport: 'adb-reverse', device: 'Pixel 7' }],
  ['app.connected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '', sdk: 'dart-vm', transport: 'vm-service', device: 'iPhone 16 Pro' }],
  ['app.connected', { app: 'Mahalle', bundleId: 'com.mykynk.mahalle', version: '5.12.0', sdk: 'android', transport: 'demo', device: 'Pixel 8 · Demo' }],
  ['app.connected', { app: 'Kasa', bundleId: 'com.example.kasa', version: '1.0.0', sdk: 'react-native', transport: 'websocket', device: 'Galaxy S23' }],
  ['app.reconnected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'ios', transport: 'usbmux', device: 'Yusuf’un iPhone’u' }],
  ['app.disconnected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'flutter', transport: 'demo', device: 'iPhone 16 Pro · Demo', failedRequests: 1 }],
  ['app.disconnected', { app: 'Mahalle', bundleId: 'com.mykynk.mahalle', version: '5.12.0', sdk: 'android', transport: 'demo', device: 'Pixel 8 · Demo', failedRequests: 0 }],
  ['app.disconnected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'flutter', transport: 'tcp', device: 'iPhone', failedRequests: 3 }],
  ['process.started', { process: 'com.mykynk.mahalle', pid: 6944 }],
  ['process.died', { process: 'Runner', pid: 48213 }],
  ['marker', { label: '', n: 3 }],
  ['marker', { label: 'Ödeme akışı testi', n: 4 }],
  ['logs.streamStarted', { via: 'logcat' }],
  ['logs.streamStopped', { via: 'idevicesyslog' }],
  ['logs.streamError', { via: 'simctl log stream', detail: 'log stream exited (exit code 1): boom — restarting' }],
  ['vm.attached', { app: 'Pati', url: 'ws://127.0.0.1:52345/Ab3x=/ws' }],
  ['vm.detached', { app: 'Pati', reason: 'the app stopped or the device was disconnected' }],
  ['vm.detached', { app: 'Pati', reason: 'detached by the user' }],
  ['vm.attachFailed', { url: 'http://127.0.0.1:50123/x=/', error: 'connect ECONNREFUSED 127.0.0.1:50123' }],
  ['vm.hotRestart', { app: 'Pati' }],
  ['vm.hotReload', { app: 'Pati' }],
];

const NOTICE_SAMPLES: [code: string, params: Record<string, string | number> | undefined][] = [
  [
    'settings.adjusted',
    { details: 'maxLogEntries 5000000 → 1000000 (allowed 1000–1000000); logcatTail -5 → 0 (allowed 0–100000); watchedApps normalized (trimmed, de-duplicated)' },
  ],
  ['settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 1 }],
  ['settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }],
  ['settings.lanOff', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }],
  ['settings.lanOff', { sdkPort: 9751, httpPort: 9750, restartRequired: 1 }],
  ['settings.sdkRebindFailed', { port: 9751, error: 'Port 9751 is already used by another program' }],
  ['config.writeFailed', { file: 'settings.json', error: 'EACCES: permission denied' }],
  ['replay.bodyTruncated', undefined],
  ['replay.bodyMissing', undefined],
  ['replay.bodyDropped', undefined],
  ['vm.attached', { app: 'Pati' }],
  ['vm.detached', { app: 'Pati', reason: 'the app restarted (new VM service URL)' }],
  ['vm.attachFailed', { url: 'http://127.0.0.1:50123/x=/', error: 'timeout' }],
];

/** English words that must not leak into Turkish system lines. */
const ENGLISH_LEFTOVERS = /\b(connected|disconnected|started|died|stopped|interrupted|restarting|attached|detached|pending|failed|shut down)\b/;

function expectClean(text: string, where: string): void {
  expect(text, where).not.toBe(FALLBACK);
  expect(text, where).not.toMatch(/\{\s*[\w.]+\s*(,\s*number\s*)?\}/);
  expect(text, where).not.toMatch(/ {2}/);
  expect(text, where).not.toMatch(/\bundefined\b|\bnull\b|\bNaN\b/);
  expect(text, where).not.toMatch(/\(\s*\)|\( | \)|· ·|·\s*$|^\s*·/);
  expect(text, where).toBe(text.trim());
  expect(text.length, where).toBeGreaterThan(1);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe('server codes → i18n', () => {
  it('every maintained code has Turkish and English text', () => {
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const codes = [...allServerCodes(), ...LOCAL_CODES];
    expect(codes.length).toBeGreaterThan(120);
    const missing = codes.filter((c) => !tr.has(`code.${c}`) || !en.has(`code.${c}`));
    expect(missing).toEqual([]);
  });

  it('the maintained list covers every code literal in the server source', () => {
    const root = existsSync(join(process.cwd(), 'packages/server/src')) ? join(process.cwd(), 'packages/server/src') : join(process.cwd(), '../server/src');
    if (!existsSync(root)) return; // UI package checked out alone
    const NOT_CODES = new Set([
      'app.action',
      'command.result',
      'demo.set',
      'device.action',
      'doctor.run',
      'marker.add',
      'metrics.watch',
      'mocks.json',
      'mocks.set',
      'net.error',
      'net.replay',
      'net.request',
      'net.response',
      'sdk.close',
      'settings.json',
      'settings.update',
      'upload.bin',
      'vm.attach',
      'vm.detach',
    ]);
    const literal =
      /'((?:device|app|logs|driver|demo|action|command|config|settings|replay|vm|server|sdk|metrics|net|params|screenshot|process|marker|import|upload|body|file|har|search|url|method|access|api|mocks|doctor|reader)\.[A-Za-z][A-Za-z.]*)'/g;
    const found = new Set<string>();
    for (const f of walk(root)) for (const m of readFileSync(f, 'utf8').matchAll(literal)) if (!NOT_CODES.has(m[1]!)) found.add(m[1]!);
    expect(found.size).toBeGreaterThan(100);
    const known = new Set(allServerCodes());
    expect([...found].filter((c) => !known.has(c)).sort()).toEqual([]);
  });

  it('every system line code has a realistic sample', () => {
    const sampled = new Set(SYSTEM_SAMPLES.map(([c]) => c));
    expect(SERVER_CODES.systemLines.filter((c) => !sampled.has(c))).toEqual([]);
  });

  it.each(LANGS)('renders every system line with real params cleanly (%s)', (lang) => {
    for (const [code, params] of SYSTEM_SAMPLES) {
      const text = tCodeIn(lang, code, params, FALLBACK);
      expectClean(text, `${lang} ${code} ${JSON.stringify(params)}`);
      if (lang === 'tr') expect(text, `${code}: ${text}`).not.toMatch(ENGLISH_LEFTOVERS);
    }
  });

  it.each(LANGS)('renders notices with real params cleanly (%s)', (lang) => {
    for (const [code, params] of NOTICE_SAMPLES) {
      const text = tCodeIn(lang, code, params, FALLBACK);
      expectClean(text, `${lang} ${code}`);
    }
  });

  it.each(LANGS)('renders every code without params (labels, states, errors) (%s)', (lang) => {
    for (const code of [...allServerCodes(), ...LOCAL_CODES]) {
      const text = tCodeIn(lang, code, undefined, FALLBACK);
      expectClean(text, `${lang} ${code}`);
    }
  });

  it('writes natural Turkish for the lifecycle lines', () => {
    const tr = (code: string, params: Record<string, string | number>) => tCodeIn('tr', code, params, FALLBACK);
    expect(tr('device.connected', SYSTEM_SAMPLES[0]![1])).toBe('Pixel 8 · Demo bağlandı (Android 15 · emülatör)');
    expect(tr('device.connected', SYSTEM_SAMPLES[1]![1])).toBe('Yusuf’un iPhone’u bağlandı (iOS 18.1 · USB)');
    expect(tr('device.connected', SYSTEM_SAMPLES[2]![1])).toBe('Galaxy S23 bağlandı (Wi-Fi)');
    expect(tr('device.disconnected', SYSTEM_SAMPLES[4]![1])).toBe('iPhone 16 Pro bağlantısı kesildi (simülatör kapatıldı)');
    expect(tr('device.disconnected', SYSTEM_SAMPLES[5]![1])).toBe('Galaxy S23 bağlantısı kesildi (çevrimdışı)');
    expect(tr('device.disconnected', SYSTEM_SAMPLES[7]![1])).toBe('Pixel 7 bağlantısı kesildi');
    expect(tr('app.connected', SYSTEM_SAMPLES[10]![1])).toBe('Pati 2.4.1 bağlandı (Flutter SDK · adb reverse)');
    expect(tr('app.connected', SYSTEM_SAMPLES[11]![1])).toBe('Pati bağlandı (Dart VM Service)');
    expect(tr('app.disconnected', SYSTEM_SAMPLES[15]![1])).toBe('Pati bağlantısı kesildi · yanıt bekleyen 1 istek başarısız sayıldı');
    expect(tr('app.disconnected', SYSTEM_SAMPLES[16]![1])).toBe('Mahalle bağlantısı kesildi');
    expect(tr('process.started', { process: 'com.mykynk.mahalle', pid: 6944 })).toBe('com.mykynk.mahalle başladı · pid 6944');
    expect(tr('process.died', { process: 'Runner', pid: 48213 })).toBe('Runner sonlandı · pid 48213');
    expect(tr('marker', { label: '', n: 3 })).toBe('İşaret 3');
    expect(tr('marker', { label: 'Ödeme akışı testi', n: 4 })).toBe('Ödeme akışı testi');
    expect(tr('logs.streamError', { via: 'logcat', detail: 'x' })).toBe('Cihaz log akışı kesildi (logcat); yeniden başlatılıyor');
    expect(tr('vm.detached', { app: 'Pati', reason: 'detached by the user' })).toBe('Pati için Dart VM Service bağlantısı kesildi (elle ayrıldı)');
    expect(tcodeEn('app.disconnected', { app: 'Pati', failedRequests: 3 })).toBe('Pati disconnected · 3 pending requests failed');
    // Older `{ name }` params still render.
    expect(tr('device.connected', { name: 'Pixel 8' })).toBe('Pixel 8 bağlandı');
  });

  it('localizes notices: adjusted values, LAN mode with and without restart', () => {
    const adjusted = tCodeIn('tr', 'settings.adjusted', NOTICE_SAMPLES[0]![1], FALLBACK);
    expect(adjusted).toContain('Bellekte tutulacak en fazla log: 5.000.000 yerine 1.000.000 kullanıldı (izin verilen 1.000–1.000.000)');
    expect(adjusted).toContain('İzlenen uygulamalar listesi düzenlendi');
    expect(tCodeIn('tr', 'settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 1 }, FALLBACK)).toContain('Dürbün yeniden başlatılana kadar');
    expect(tCodeIn('tr', 'settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }, FALLBACK)).not.toContain('yeniden başlatılana');
    expect(tCodeIn('en', 'settings.lanOff', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }, FALLBACK)).toBe(
      'Local network mode is off: the SDK port (9751) now accepts connections from this Mac only.',
    );
  });

  it('keeps the specific part of server errors and localizes the rest', () => {
    setLanguage('tr');
    expect(errorText({ code: 'action.installFailed', message: 'Install failed: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]' })).toBe(
      'Kurulum başarısız oldu: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
    );
    expect(errorText({ code: 'config.invalid', message: 'Invalid settings: maxLogEntries must be a number' })).toBe('Geçersiz ayar: maxLogEntries must be a number');
    expect(errorText({ code: 'replay.invalidMethod', message: 'Invalid HTTP method "G E T"' })).toBe('Geçersiz HTTP yöntemi: G E T');
    expect(errorText({ code: 'upload.tooLarge', message: 'File is too large (limit 2 GB)' })).toBe('Dosya çok büyük (en fazla 2 GB)');
    expect(errorText({ code: 'action.failed', message: 'The action failed' })).toBe('İşlem başarısız oldu');
    expect(errorText({ code: 'device.readOnly', message: 'Imported sessions are read-only recordings' })).toBe(
      'İçe aktarılan kayıtlar salt okunurdur; cihaz işlemleri kullanılamaz',
    );
    expect(
      errorText({
        code: 'command.failed',
        message: 'No Dart VM service URL found. Paste the URL printed by `flutter run` ("A Dart VM Service … is available at: http://127.0.0.1:…/…=/"), a DevTools link, or the whole output.',
      }),
    ).toMatch(/^Metinde Dart VM Service adresi bulunamadı/);
    expect(errorText({ code: 'command.timeout', message: 'No reply within 15 s' })).toBe('Sunucu zamanında yanıt vermedi');
    expect(errorText({ code: 'something.new', message: 'Brand new failure' })).toBe('Brand new failure');
    expect(errorText(new Error('plain'))).toBe('plain');
    expect(errorText('text')).toBe('text');
    expect(errorDetail('Could not launch com.x: Error: Activity class does not exist')).toBe('Error: Activity class does not exist');
    setLanguage('en');
  });

  it('localizes driver states, device states and the virtual desktop device', () => {
    setLanguage('tr');
    expect(driverStatusText({ id: 'android', detail: 'adb 1.0.41 (37.0.0-14910828) · 0 devices online' })).toBe('adb 1.0.41 (37.0.0-14910828) · 0 cihaz bağlı');
    expect(driverStatusText({ id: 'ios-sim', detail: '0 booted simulators' })).toBe('0 açık simülatör');
    expect(driverStatusText({ id: 'ios-device', detail: '2 devices' })).toBe('2 bağlı cihaz');
    expect(driverStatusText({ id: 'flutter-vm', detail: 'Waiting for Flutter debug apps (auto-attach on)' })).toBe(
      'Flutter debug uygulamaları bekleniyor (otomatik bağlanma açık)',
    );
    expect(driverStatusText({ id: 'demo', detail: 'Generating demo data for 2 virtual devices', code: 'demo.active' })).toBe('2 sanal cihazda demo verisi üretiliyor');
    expect(driverStatusText({ id: 'android', detail: 'something odd' })).toBe('something odd');
    expect(deviceDisplayName({ id: 'desktop', name: 'Desktop' })).toBe('Masaüstü · yeniden gönderilenler');
    expect(deviceDisplayName({ id: 'import:1', name: '📁 Pixel 8 · Demo' })).toBe('📁 Pixel 8 · Demo');
    expect(deviceStateText({ state: 'disconnected', stateCode: 'device.imported' })).toBe('İçe aktarılan kayıt · salt okunur');
    expect(deviceStateText({ state: 'unauthorized', stateCode: 'device.untrusted' })).toMatch(/Güven’e dokunun/);
    expect(logStatusText({ logs: { status: 'unavailable', code: 'logs.networkOnly' } })).toMatch(/^Yalnızca SDK verisi/);
    setLanguage('en');
    expect(deviceDisplayName({ id: 'desktop', name: 'Desktop' })).toBe('Desktop · replays');
    expect(driverStatusText({ id: 'ios-sim', detail: '1 booted simulator' })).toBe('1 booted simulator');
  });
});

function tcodeEn(code: string, params: Record<string, string | number>): string {
  return tCodeIn('en', code, params, FALLBACK);
}
