import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortPath, STRINGS } from '../src/i18n';
import { trayMenuTemplate, type MenuHandlers } from '../src/menu';
import { attachNotices, bundledServerVersion, serverWarnings } from '../src/notices';

const sdkBusy = 'SDK port 9751: listen EADDRINUSE: address already in use 127.0.0.1:9751 — apps on simulators or Wi-Fi cannot connect over TCP (Android over USB still works).';
const noUi = 'The web UI is not built yet: run "npm run build" (the browser shows a placeholder page until then).';

describe('serverWarnings', () => {
  it('words the known notice codes in the app language (tr / en)', () => {
    const server = {
      warnings: [sdkBusy, noUi],
      notices: [
        { code: 'sdk.portBusy', params: { port: 9751 }, message: sdkBusy },
        { code: 'ui.missing', message: noUi },
      ],
    };
    expect(serverWarnings(STRINGS.tr, server)).toEqual([
      "SDK portu 9751 kullanımda: simülatör ve Wi-Fi bağlantıları kurulamaz; USB'deki Android cihazlar etkilenmez.",
      'Arayüz dosyaları bulunamadı, pencerede yalnızca bilgi sayfası var; uygulamayı yeniden kurun.',
    ]);
    expect(serverWarnings(STRINGS.en, server)[0]).toBe('SDK port 9751 is in use: simulator and Wi-Fi connections cannot be made; Android devices on USB are not affected.');
    // packages/server/src/config.ts: an invalid setting falls back to its default, an invalid mock rule is skipped
    expect(
      serverWarnings(STRINGS.tr, {
        notices: [
          { code: 'config.invalid', params: { file: 'settings.json', detail: 'iosSimLogScope must be one of apps, all — using the default' }, message: 'settings.json: iosSimLogScope must be one of apps, all — using the default' },
          { code: 'config.invalid', params: { file: 'mocks.json', detail: 'rule 3: bad regex — rule skipped' }, message: 'mocks.json: rule 3: bad regex — rule skipped' },
          { code: 'config.unreadable', params: { file: 'mocks.json', error: 'Unexpected token', backup: 'mocks.json.broken-1' }, message: 'mocks.json could not be read …' },
        ],
      }),
    ).toEqual([
      'settings.json: «iosSimLogScope» şunlardan biri olmalı: apps, all; varsayılan değeri kullanılıyor.',
      'mocks.json içinde geçersiz bir mock kuralı var; o kural atlandı (ayrıntı günlükte).',
      'mocks.json okunamadı; Dürbün mock kuralları olmadan başladı (dosyanın bir kopyası saklandı).',
    ]);
  });

  it('keeps the server\'s message for an unknown code, and warnings no notice stands for', () => {
    const server = {
      warnings: [sdkBusy, 'Device drivers are unavailable: boom'],
      notices: [
        { code: 'sdk.portBusy', params: { port: '9751' }, message: sdkBusy },
        { code: 'some.newCode', params: { x: 1 }, message: 'Something new happened' },
      ],
    };
    expect(serverWarnings(STRINGS.tr, server)).toEqual([
      "SDK portu 9751 kullanımda: simülatör ve Wi-Fi bağlantıları kurulamaz; USB'deki Android cihazlar etkilenmez.",
      'Something new happened',
      'Device drivers are unavailable: boom',
    ]);
  });

  it('falls back to the plain warnings of a bundle without notices, and ignores junk', () => {
    expect(serverWarnings(STRINGS.tr, { warnings: [sdkBusy] })).toEqual([sdkBusy]);
    expect(serverWarnings(STRINGS.tr, { warnings: [sdkBusy], notices: [] })).toEqual([sdkBusy]);
    expect(serverWarnings(STRINGS.tr, { warnings: [42, ''], notices: [null, 'x', { code: 'sdk.portBusy' }] as unknown[] })).toEqual([
      "SDK portu kullanımda: simülatör ve Wi-Fi bağlantıları kurulamaz; USB'deki Android cihazlar etkilenmez.",
    ]);
  });
});

describe('bundledServerVersion', () => {
  it('compares with the bundled server, else with the app', () => {
    expect(bundledServerVersion({ SERVER_VERSION: '0.2.0' }, '0.1.0')).toBe('0.2.0');
    expect(bundledServerVersion({}, '0.1.0')).toBe('0.1.0');
    expect(bundledServerVersion({ SERVER_VERSION: '' }, '0.1.0')).toBe('0.1.0');
  });
});

describe('attachNotices', () => {
  it('says when the attached Dürbün differs or has no UI build', () => {
    const t = STRINGS.tr;
    expect(attachNotices(t, { port: 9750, version: '0.1.0', page: 'ui' }, '0.1.0')).toEqual([]);
    expect(attachNotices(t, { port: 9750, version: '0.0.9', page: 'ui' }, '0.1.0')).toEqual([t.attachedVersionNotice('0.0.9', '0.1.0')]);
    expect(attachNotices(t, { port: 9750, version: '0.1.0', page: 'placeholder' }, '0.1.0')).toEqual([
      "Penceredeki Dürbün'ün (port 9750) arayüzü derlenmemiş. O kapanınca uygulama kendi arayüzünü açar.",
    ]);
  });
});

/** Every code packages/server/src/types.ts ServerNotice lists, with typical parameters. */
const SERVER_CODES: [string, Record<string, unknown>][] = [
  ['config.invalid', { file: 'settings.json', detail: 'maxLogEntries must be a number — using the default' }],
  ['config.invalid', { file: 'mocks.json', detail: 'x' }],
  ['config.unreadable', { file: 'settings.json', error: 'x', backup: 'settings.json.broken' }],
  ['config.unreadable', { file: 'mocks.json', error: 'x' }],
  ['config.dataDirFallback', { dir: '~/.durbun', fallback: path.join(os.tmpdir(), `durbun-${os.userInfo().username}`), error: 'EACCES' }],
  ['config.tempDirFallback', { dir: path.join(os.tmpdir(), 'durbun-tmp-Ab12Cd'), error: 'EACCES' }],
  ['ui.missing', {}],
  ['ui.dirInvalid', { dir: '/x/ui', fallback: '/y/ui' }],
  ['ui.dirInvalid', { dir: '/x/ui' }],
  ['sdk.portBusy', { port: 65_535 }],
  ['sdk.listenFailed', { port: 65_535, error: 'EACCES' }],
  ['sdk.unavailable', { reason: 'x' }],
  ['drivers.unavailable', { reason: 'x' }],
  ['vm.unavailable', { reason: 'x' }],
  ['demo.unavailable', { reason: 'x' }],
  ['demo.startFailed', { reason: 'x' }],
];

describe('notice wording', () => {
  it('has its own words for every server code, in both languages', () => {
    for (const t of [STRINGS.tr, STRINGS.en]) {
      for (const [code, params] of SERVER_CODES) expect(t.serverNotice(code, params), `${code}`).toBeTruthy();
      expect(t.serverNotice('some.futureCode', {})).toBeUndefined();
    }
  });
  it('every tray line fits without being cut (≤ 120 characters)', () => {
    for (const t of [STRINGS.tr, STRINGS.en]) {
      const lines = [t.attachedPlaceholderNotice(65_535), ...SERVER_CODES.map(([code, params]) => t.serverNotice(code, params)!)];
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(120);
    }
  });
});

/** A settings.json warning exactly as packages/server/src/config.ts loadConfig sends it. */
const settingsNotice = (detail: string) => ({ code: 'config.invalid', params: { file: 'settings.json', detail }, message: `settings.json: ${detail}` });
const handlers: MenuHandlers = { showWindow() {}, openInBrowser() {}, openDataDir() {}, showLog() {}, quit() {} };
/** The lines of the tray's Warnings submenu, as the user reads them. */
function trayLines(t: (typeof STRINGS)['tr'], notices: unknown[]): string[] {
  const items = trayMenuTemplate(t, { kind: 'running', port: 9750, warnings: serverWarnings(t, { notices }) }, handlers);
  const sub = items.find((i) => Array.isArray(i.submenu))?.submenu as { label?: string }[] | undefined;
  return (sub ?? []).map((i) => i.label ?? '');
}

describe('settings.json warnings', () => {
  // packages/server/src/config.ts normalizeSettings: a refused value keeps the default, a number outside its
  // range is moved into it, watchedApps is cleaned up, an unknown key is ignored; loadConfig: not an object.
  const details = [
    'maxLogEntries 5000000 → 1000000 (allowed 1000–1000000)',
    'watchedApps normalized (trimmed, de-duplicated)',
    'unknown setting "iosDeviceLogScope" ignored',
    'expected an object — using defaults',
    'captureBodies must be true or false — using the default',
  ];

  it('says what the server did with each value, not "its default is used" for all of them', () => {
    expect(trayLines(STRINGS.tr, details.map(settingsNotice))).toEqual([
      'settings.json: «maxLogEntries» için 5000000 yerine 1000000 kullanılıyor (izin verilen 1000–1000000).',
      'settings.json: «watchedApps» listesi düzenlendi (boşluklar ve tekrarlar temizlendi).',
      'settings.json: tanınmayan «iosDeviceLogScope» ayarı yok sayıldı.',
      'settings.json bir JSON nesnesi değil; tüm ayarlar varsayılan değerinde.',
      'settings.json: «captureBodies» true ya da false olmalı; varsayılan değeri kullanılıyor.',
    ]);
    expect(trayLines(STRINGS.en, details.map(settingsNotice))).toEqual([
      'settings.json: "maxLogEntries" is 1000000 instead of 5000000 (allowed 1000–1000000).',
      'settings.json: the "watchedApps" list was cleaned up (trimmed, duplicates removed).',
      'settings.json: unknown setting "iosDeviceLogScope" ignored.',
      'settings.json is not a JSON object; all settings use their defaults.',
      'settings.json: "captureBodies" must be true or false; its default value is used.',
    ]);
  });

  it('names the key and the reason of every refused value', () => {
    const t = STRINGS.tr;
    const line = (detail: string) => t.serverNotice('config.invalid', { file: 'settings.json', detail });
    expect(line('metricsIntervalMs must be a number — using the default')).toBe('settings.json: «metricsIntervalMs» bir sayı olmalı; varsayılan değeri kullanılıyor.');
    expect(line('watchedApps must be a list of app ids — using the default')).toBe(
      'settings.json: «watchedApps» uygulama kimliklerinden oluşan bir liste olmalı; varsayılan değeri kullanılıyor.',
    );
    expect(line('watchedApps must contain only strings — using the default')).toBe('settings.json: «watchedApps» listesinde yalnızca metin olmalı; varsayılan değeri kullanılıyor.');
    expect(line('adbPath must be a file path — using the default')).toBe('settings.json: «adbPath» bir dosya yolu olmalı; varsayılan değeri kullanılıyor.');
    expect(line('adbPath is not a valid path — using the default')).toBe('settings.json: «adbPath» geçerli bir dosya yolu değil; varsayılan değeri kullanılıyor.');
    expect(line('maxBodyBytes 1500.5 → 1501 (allowed 1024–10485760)')).toBe('settings.json: «maxBodyBytes» için 1500.5 yerine 1501 kullanılıyor (izin verilen 1024–10485760).');
    // a key the user typed is shown, but never as a whole paragraph or with control characters
    expect(line(`unknown setting "${'x'.repeat(300)}\n" ignored`)).toBe(`settings.json: tanınmayan «${'x'.repeat(39)}…» ayarı yok sayıldı.`);
  });

  it('keeps the server\'s line for a detail it does not know (no guessed wording)', () => {
    const odd = settingsNotice('something new happened');
    expect(serverWarnings(STRINGS.tr, { notices: [odd] })).toEqual(['settings.json: something new happened']);
    expect(serverWarnings(STRINGS.tr, { notices: [{ code: 'config.invalid', message: 'settings.json: x' }] })).toEqual(['settings.json: x']);
    expect(STRINGS.en.serverNotice('config.invalid', { file: 'other.json', detail: 'maxLogEntries must be a number — using the default' })).toBeUndefined();
  });

  it('every wording fits in one tray line', () => {
    const worst = [
      'maxBodyBytes 99999999999 → 10485760 (allowed 1024–10485760)',
      'metricsIntervalMs 1e+21 → 60000 (allowed 250–60000)',
      'iosDeviceLogScope must be one of apps, all — using the default',
      'idevicesyslogPath is not a valid path — using the default',
      `unknown setting "${'k'.repeat(60)}" ignored`,
      ...details,
    ];
    for (const t of [STRINGS.tr, STRINGS.en]) {
      for (const d of worst) {
        const line = t.serverNotice('config.invalid', { file: 'settings.json', detail: d })!;
        expect(line, d).toBeTruthy();
        expect(line.length, line).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe('fallback folders in the tray', () => {
  afterEach(() => vi.restoreAllMocks());
  // packages/server/src/config.ts loadConfig: path.join(os.tmpdir(), `durbun-${user}`) and
  // mkdtemp(path.join(os.tmpdir(), 'durbun-tmp-')).
  const fallbacks = (tmp: string, user: string) => [
    { code: 'config.dataDirFallback', params: { dir: '/Users/x/.durbun', fallback: path.join(tmp, `durbun-${user}`), error: 'EACCES' }, message: 'm1' },
    { code: 'config.tempDirFallback', params: { dir: path.join(tmp, 'durbun-tmp-Ab12Cd'), error: 'EACCES' }, message: 'm2' },
  ];

  it('shows the folder the data goes to, with this Mac\'s temp folder and user name', () => {
    const user = os.userInfo().username;
    for (const t of [STRINGS.tr, STRINGS.en]) {
      const [data, temp] = trayLines(t, fallbacks(os.tmpdir(), user));
      expect(data, data).toContain(`durbun-${user}`);
      expect(data!.endsWith('…'), data).toBe(false);
      expect(temp, temp).toContain('durbun-tmp-Ab12Cd');
    }
  });

  it('a macOS temp folder (/var/folders/<hash>/T) is shown as $TMPDIR, so the folder name is not cut', () => {
    const macTmp = '/var/folders/8k/xxhgc94s2q92fwgr5tygx0900000gp/T';
    vi.spyOn(os, 'tmpdir').mockReturnValue(macTmp);
    const user = 'alexandramontgomery';
    expect(trayLines(STRINGS.tr, fallbacks(macTmp, user))).toEqual([
      'Veri klasörüne yazılamıyor; Dürbün bu oturumda şu klasörü kullanıyor: $TMPDIR/durbun-alexandramontgomery',
      'Geçici dosyalar için klasör oluşturulamadı; şu klasör kullanılıyor: $TMPDIR/durbun-tmp-Ab12Cd',
    ]);
    expect(trayLines(STRINGS.en, fallbacks(macTmp, user))).toEqual([
      'The data folder is not writable; for this session Dürbün uses: $TMPDIR/durbun-alexandramontgomery',
      'The folder for temporary files could not be created; using: $TMPDIR/durbun-tmp-Ab12Cd',
    ]);
    // a long user name (macOS allows long ones) still fits, the folder's end kept
    for (const t of [STRINGS.tr, STRINGS.en]) {
      const [data] = trayLines(t, fallbacks(macTmp, 'u'.repeat(64)));
      expect(data!.length, data).toBeLessThanOrEqual(120);
      expect(data!.endsWith('u'.repeat(30)), data).toBe(true);
    }
  });

  it('shortPath names the temp and home folders and keeps the end of a long path', () => {
    const roots = { tmp: '/var/folders/8k/abc/T/', home: '/Users/yusuf' };
    expect(shortPath('/var/folders/8k/abc/T/durbun-yusuf', roots)).toBe('$TMPDIR/durbun-yusuf');
    expect(shortPath('/private/var/folders/8k/abc/T/durbun-tmp-1', roots)).toBe('$TMPDIR/durbun-tmp-1');
    expect(shortPath('/Users/yusuf/.durbun', roots)).toBe('~/.durbun');
    expect(shortPath('/Users/yusufk/.durbun', roots)).toBe('/Users/yusufk/.durbun');
    expect(shortPath('/tmp/durbun-501', roots)).toBe('/tmp/durbun-501');
    const long = shortPath(`/Volumes/External Disk/${'a'.repeat(80)}/durbun-yusuf`, roots);
    expect(long.length).toBe(46);
    expect(long).toMatch(/^….*\/durbun-yusuf$/);
  });
});
