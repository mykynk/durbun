import type { DeviceInfo, DriverStatus, I18nParams, LogEntry, UiNotice } from '@durbun/protocol';
import { getLanguage, hasMessage, registerMessages, t, translateOr, type Lang, type TParams } from './core';

/**
 * Localization of server-generated i18n codes: system log lines, device / log-stream / driver states,
 * notices, command replies and REST errors. Keys live under the `code.` namespace: code
 * "device.connected" → message "code.device.connected". A message may list candidates from most to
 * least specific; the first whose params are all present (empty string = missing) wins, and an
 * unknown code falls back to the server's English text.
 *
 * Params the server really sends (SPEC §9.2 / §9.3):
 *   device.connected                        { device, deviceId, platform, kind, connection, osVersion }
 *   device.disconnected                     { device, deviceId, state, detail }
 *   app.connected / app.reconnected         { app, bundleId, version, sdk, transport, device }
 *   app.disconnected                        same + { failedRequests }
 *   process.started / process.died          { process, pid }
 *   marker                                  { label ('' when none), n }
 *   logs.streamStarted|Stopped|Error        { via, detail? }
 *   logs.streamStalled                      { via, seconds, detail }   (an attached iPhone's stream went silent; restarted)
 *   logs.scopeNotApplied / scopeApplied     { via, reason: 'devicectlMissing' | 'appListFailed', device } / { via, device }
 *   logs.connectionLost                     { via, connection: 'usb' | 'wifi', graceSeconds, detail }
 *   logs.connectionRestored                 { via, connection, seconds, detail }
 *   vm.attached / vm.detached               { app, url } / { app, reason }
 *   vm.attachFailed                         { url, error }
 *   vm.hotRestart / vm.hotReload            { app }
 *   settings.adjusted                       { details }   (English "<key> <from> → <to> (allowed <min>–<max>)"; …)
 *   settings.lanOn / settings.lanOff        { sdkPort, httpPort, restartRequired: 0 | 1 }
 *   settings.sdkRebindFailed                { port, error }
 *   config.writeFailed                      { file, error }
 *   action.screenshot.saved (reply data)    { url, file, width, height }
 * Derived params (computed here, never sent): `details` (device.connected), `reason`
 * (device.disconnected, vm.detached), `why` (logs.scopeNotApplied), `link` / `gap` (logs.connectionLost|Restored), `via` / `failed` (app.*), `size` (screenshot), `detail` / `limit`
 * (errors: the specific part of the server's English message).
 * Older `{ name }` params are still accepted as a fallback.
 */

/** Every i18n code the server emits, grouped by where it shows up. Each one must have TR + EN text. */
export const SERVER_CODES = {
  /** `LogEntry.code` of `source: 'system'` lines. */
  systemLines: [
    'device.connected',
    'device.disconnected',
    'app.connected',
    'app.reconnected',
    'app.disconnected',
    'process.started',
    'process.died',
    'marker',
    'logs.streamStarted',
    'logs.streamStopped',
    'logs.streamError',
    'logs.streamStalled',
    'logs.scopeNotApplied',
    'logs.scopeApplied',
    'logs.connectionLost',
    'logs.connectionRestored',
    'vm.attached',
    'vm.detached',
    'vm.attachFailed',
    'vm.hotRestart',
    'vm.hotReload',
    'sdk.routeElsewhere',
  ],
  /** `DeviceInfo.stateCode`. */
  deviceStates: [
    'device.unauthorized',
    'device.authorizing',
    'device.noPermissions',
    'device.notBooted',
    'device.offline',
    'device.untrusted',
    'device.simulatorShutdown',
    'device.driverStopped',
    'device.imported',
    'device.networkIdle',
    'demo.stopped',
  ],
  /** `DeviceInfo.logs.code`. */
  logStatuses: [
    'logs.adbMissing',
    'logs.deviceOffline',
    'device.unauthorized',
    'device.untrusted',
    'logs.processExited',
    'logs.idevicesyslogMissing',
    'logs.usbmuxdUnavailable',
    'logs.simctlMissing',
    'logs.networkOnly',
    'logs.streamStalled',
    'logs.scopeNotApplied',
  ],
  /** `DriverStatus.code`. */
  drivers: [
    'logs.adbMissing',
    'driver.adbError',
    'logs.simctlMissing',
    'driver.simctlError',
    'logs.usbmuxdUnavailable',
    'logs.idevicesyslogMissing',
    'driver.initFailed',
    'driver.statusFailed',
    'demo.active',
    'demo.inactive',
  ],
  /** `notice` messages. */
  notices: [
    'settings.adjusted',
    'settings.lanOn',
    'settings.lanOff',
    'settings.sdkRebindFailed',
    'config.writeFailed',
    'config.unreadable',
    'config.dataDirFallback',
    'config.tempDirFallback',
    'sdk.portBusy',
    'sdk.listenFailed',
    'demo.startFailed',
    'replay.bodyTruncated',
    'replay.bodyMissing',
    'replay.bodyDropped',
    'vm.attached',
    'vm.detached',
    'vm.attachFailed',
  ],
  /** `reply.code` of failed commands (`CommandError.code`). */
  commandErrors: [
    'command.invalid',
    'command.unknown',
    'command.failed',
    'device.unknown',
    'device.readOnly',
    'device.noActions',
    'device.networkOnly',
    'device.untrusted',
    'action.failed',
    'action.timeout',
    'action.invalidResult',
    'app.unknown',
    'app.disconnected',
    'app.timeout',
    'app.notConnected',
    'app.commandTimeout',
    'app.commandsUnsupported',
    'server.shutdown',
    'config.invalid',
    'vm.unavailable',
    'vm.timeout',
    'vm.noServiceUrl',
    'metrics.unsupported',
    'net.unknown',
    'replay.invalidMethod',
    'replay.invalidUrl',
    'replay.unsupportedUrl',
    'demo.unavailable',
    'demo.timeout',
    'demo.inactive',
    'demo.unsupportedAction',
    'demo.actionFailed',
    'params.invalid',
    'app.notInstalled',
    'screenshot.writeFailed',
    'sdk.unavailable',
    'driver.initFailed',
    'logs.idevicesyslogMissing',
  ],
  /** `reply.code` of successful `device.action` replies (`DeviceActionResult.code`). */
  actionResults: ['action.done', 'action.listApps', 'action.screenshot.saved', 'action.recording.saved'],
  /** `DeviceActionResult.code` of failed device actions. */
  actionErrors: [
    'action.failed',
    'action.invalidParams',
    'action.unsupported',
    'action.deviceOffline',
    'action.deviceNotFound',
    'action.toolMissing',
    'action.screenshotRefused',
    'action.appNotFound',
    'action.fileNotFound',
    'action.unsupportedFile',
    'action.inputTextAscii',
    'action.installFailed',
    'action.launchFailed',
    'action.uninstallFailed',
    'action.openUrlFailed',
  ],
  /** `DeviceInfo.readers.<id>.code`: why an SDK-less reader (crash records, frame stats) does not work. */
  readers: [
    'reader.crashReports.dropboxRefused',
    'reader.crashReports.devicectlMissing',
    'reader.crashReports.developerModeOff',
    'reader.crashReports.failed',
    'reader.frameStats.noData',
    'reader.frameStats.unsupported',
  ],
  /** `ToolCheck.code`: Doctor rows worded specially (params in `ToolCheck.params`). */
  doctor: ['doctor.node.embedded'],
  /** REST `{ error, code }` bodies (`ApiError.code`). */
  rest: [
    'access.denied',
    'api.notFound',
    'body.aborted',
    'body.evicted',
    'body.invalidJson',
    'body.none',
    'body.tooLarge',
    'file.unknown',
    'har.invalid',
    'import.failed',
    'import.invalid',
    'import.version',
    'method.notAllowed',
    'net.unknown',
    'search.invalid',
    'upload.aborted',
    'upload.failed',
    'upload.tooLarge',
    'url.invalid',
  ],
} as const satisfies Record<string, readonly string[]>;

/** Codes produced by the UI itself (CommandError / ApiError). */
export const LOCAL_CODES = ['command.timeout', 'command.disconnected', 'command.aborted', 'network'] as const;

/** Flat, de-duplicated list of every server code. */
export function allServerCodes(): string[] {
  return [...new Set(Object.values(SERVER_CODES).flat())];
}

registerMessages('code', {
  tr: {
    /* ── system lines ── */
    'device.connected': ['{device} bağlandı ({details})', '{device} bağlandı', '{name} bağlandı', 'Cihaz bağlandı'],
    'device.disconnected': ['{device} bağlantısı kesildi ({reason})', '{device} bağlantısı kesildi', '{name} bağlantısı kesildi', 'Cihazın bağlantısı kesildi'],
    'app.connected': ['{app} {version} bağlandı ({via})', '{app} bağlandı ({via})', '{app} {version} bağlandı', '{app} bağlandı', '{name} {version} bağlandı', '{name} bağlandı', 'Uygulama bağlandı'],
    'app.reconnected': ['{app} yeniden bağlandı ({via})', '{app} yeniden bağlandı', '{name} yeniden bağlandı', 'Uygulama yeniden bağlandı'],
    'app.disconnected': ['{app} bağlantısı kesildi · {failed}', '{app} bağlantısı kesildi', '{name} bağlantısı kesildi', 'Uygulamanın bağlantısı kesildi'],
    'process.started': ['{process} başladı · pid {pid}', '{process} başladı', '{name} başladı · pid {pid}', '{name} başladı', 'Süreç başladı'],
    'process.died': ['{process} sonlandı · pid {pid}', '{process} sonlandı', '{name} sonlandı · pid {pid}', '{name} sonlandı', 'Süreç sonlandı'],
    marker: ['{label}', 'İşaret {n}', 'İşaret'],
    'logs.streamStarted': ['Cihaz log akışı başladı ({via})', 'Cihaz log akışı başladı'],
    'logs.streamStopped': ['Cihaz log akışı durdu ({via})', 'Cihaz log akışı durdu'],
    'logs.streamError': ['Cihaz log akışı kesildi ({via}); yeniden başlatılıyor', 'Cihaz log akışı kesildi; yeniden başlatılıyor'],
    'logs.streamStalled': ['iPhone bağlı ama log akışı {seconds, number} sn’dir sessiz; yeniden başlatılıyor', 'iPhone bağlı ama log akışı sessiz; yeniden başlatılıyor'],
    'logs.scopeNotApplied': [
      '{device}: sistem süreçlerinin satırları da gösteriliyor; {why}',
      '{device}: sistem süreçlerinin satırları da gösteriliyor',
      'iPhone’daki sistem süreçlerinin satırları da gösteriliyor; {why}',
      'iPhone’daki sistem süreçlerinin satırları da gösteriliyor',
    ],
    'logs.scopeApplied': [
      '{device}: kurulu uygulamalar okundu; sistem süreçlerinin satırları artık gizleniyor',
      'Kurulu uygulamalar okundu; iPhone’daki sistem süreçlerinin satırları artık gizleniyor',
    ],
    'logs.connectionLost': [
      'Cihazın {link} bağlantısı koptu; {gap}. {graceSeconds, number} sn içinde dönmezse cihaz bağlı değil olarak görünür',
      'Cihazın {link} bağlantısı koptu; {graceSeconds, number} sn içinde dönmezse cihaz bağlı değil olarak görünür',
      'Cihazın {link} bağlantısı koptu',
      'Cihazın bağlantısı koptu',
    ],
    'logs.connectionRestored': [
      'Cihazın {link} bağlantısı {seconds, number} sn sonra geri geldi; {gap}',
      'Cihazın {link} bağlantısı {seconds, number} sn sonra geri geldi',
      'Cihazın bağlantısı geri geldi',
    ],
    'vm.attached': ['{app}, Dart VM Service üzerinden bağlandı', '{name}, Dart VM Service üzerinden bağlandı', 'Dart VM Service bağlandı'],
    'vm.detached': ['{app} için Dart VM Service bağlantısı kesildi ({reason})', '{app} için Dart VM Service bağlantısı kesildi', 'Dart VM Service bağlantısı kesildi'],
    'vm.attachFailed': ['Dart VM Service’e bağlanılamadı: {error}', 'Dart VM Service’e bağlanılamadı'],
    'vm.hotRestart': ['{app} yeniden başlatıldı (hot restart)', 'Uygulama yeniden başlatıldı (hot restart)'],
    'vm.hotReload': ['{app} güncellendi (hot reload)', 'Kod güncellendi (hot reload)'],
    'sdk.routeElsewhere': [
      'Bu cihazın SDK bağlantıları bu bilgisayarda çalışan başka bir Dürbün’e gidiyor (localhost:{port}). SDK’lı uygulamalar orada görünür; cihaz logları burada da gelir.',
      'Bu cihazın SDK bağlantıları bu bilgisayarda çalışan başka bir Dürbün’e gidiyor. SDK’lı uygulamalar orada görünür; cihaz logları burada da gelir.',
    ],

    /* ── device states ── */
    'device.unauthorized': 'Cihazdaki “USB hata ayıklamaya izin verilsin mi?” sorusunu onaylayın',
    'device.authorizing': 'Cihazın bu bilgisayarı yetkilendirmesi bekleniyor…',
    'device.noPermissions': 'adb bu USB cihazına erişemiyor (izin yok)',
    'device.notBooted': 'Cihaz kurtarma ya da bootloader modunda',
    'device.offline': 'Cihaz çevrimdışı — kabloyu çıkarıp yeniden takın',
    'device.untrusted': 'Cihazın kilidini açın ve “Bu bilgisayara güvenilsin mi?” sorusunda Güven’e dokunun',
    'device.simulatorShutdown': 'Simülatör kapatıldı',
    'device.driverStopped': 'Dürbün bu cihazı izlemeyi bıraktı',
    'device.imported': 'İçe aktarılan kayıt · salt okunur',
    'device.networkIdle': 'Ağ üzerinden bağlı uygulama kalmadı',
    'demo.stopped': 'Demo modu kapatıldı',
    'device.booting': 'Cihaz açılıyor…',

    /* ── log stream states ── */
    'logs.streamRestarting': 'Log akışı yeniden başlatılıyor…',
    'logs.unavailable': 'Bu cihazın logları alınamıyor',
    'logs.adbMissing': 'adb bulunamadı — Android SDK Platform-Tools’u kurun',
    'logs.deviceOffline': 'Cihaz çevrimdışı; loglar alınamıyor',
    'logs.processExited': 'Log aracı kapandı; yeniden başlatılıyor',
    'logs.idevicesyslogMissing': 'idevicesyslog bulunamadı — libimobiledevice’ı kurun',
    'logs.usbmuxdUnavailable': 'usbmuxd’ye ulaşılamıyor; USB ile bağlı iOS cihazları görünmez',
    'logs.simctlMissing': 'Xcode (simctl) bulunamadı; iOS simülatörleri görünmez',
    'logs.networkOnly': 'Yalnızca SDK verisi: uygulama ağ üzerinden bağlı, cihaz logları alınamıyor',

    /* ── drivers ── */
    'driver.adbError': 'adb hata verdi',
    'driver.simctlError': 'simctl hata verdi',
    'driver.initFailed': 'Sürücü başlatılamadı',
    'driver.statusFailed': 'Sürücü durumu okunamadı',
    'demo.active': 'Demo cihazlarında örnek veri üretiliyor',
    'demo.inactive': 'Demo modu kapalı',

    /* ── notices ── */
    'settings.adjusted': ['Bazı değerler düzeltildi: {details}', 'Bazı değerler izin verilen aralığa çekildi'],
    'settings.lanOn': ['Yerel ağ modu açık: uygulamalar ağ üzerinden SDK portuna ({sdkPort}) bağlanabilir.', 'Yerel ağ modu açık.'],
    'settings.lanOnRestart': [
      'Yerel ağ modu açık: uygulamalar ağ üzerinden SDK portuna ({sdkPort}) bağlanabilir. React Native’in kullandığı HTTP portu ({httpPort}) ise Dürbün yeniden başlatılana kadar yalnızca bu Mac’ten erişilebilir.',
      'Yerel ağ modu açık. HTTP portu Dürbün yeniden başlatılana kadar yalnızca bu Mac’ten erişilebilir.',
    ],
    'settings.lanOff': ['Yerel ağ modu kapandı: SDK portu ({sdkPort}) artık yalnızca bu Mac’ten bağlantı kabul ediyor.', 'Yerel ağ modu kapandı.'],
    'settings.lanOffRestart': [
      'Yerel ağ modu kapandı: SDK portu ({sdkPort}) artık yalnızca bu Mac’ten bağlantı kabul ediyor. HTTP portu ({httpPort}) Dürbün yeniden başlatılana kadar ağa açık kalır.',
      'Yerel ağ modu kapandı. HTTP portu Dürbün yeniden başlatılana kadar ağa açık kalır.',
    ],
    'settings.sdkRebindFailed': ['SDK portu ({port}) yeniden açılamadı: {error}', 'SDK portu yeniden açılamadı'],
    'config.writeFailed': ['{file} kaydedilemedi: {error}', 'Ayar dosyası kaydedilemedi'],
    'config.unreadable': [
      '{file} okunamadı ({error}); Dürbün bu dosya olmadan başladı. Bozuk dosyanın kopyası: {backup}',
      '{file} okunamadı ({error}); Dürbün bu dosya olmadan başladı.',
      'Bir ayar dosyası okunamadı; Dürbün onsuz başladı.',
    ],
    'config.dataDirFallback': ['{dir} klasörüne yazılamıyor ({error}); Dürbün şimdilik {fallback} klasörünü kullanıyor.', 'Veri klasörüne yazılamıyor; Dürbün şimdilik geçici bir klasör kullanıyor.'],
    'config.tempDirFallback': ['Geçici klasör oluşturulamadı ({error}); {dir} kullanılıyor.', 'Geçici klasör oluşturulamadı; sistemin geçici klasörü kullanılıyor.'],
    'sdk.portBusy': [
      'SDK portunu ({port}) başka bir program kullanıyor: simülatördeki ve Wi-Fi üzerinden bağlanan uygulamalar Dürbün’e ulaşamaz (Android’de USB bağlantısı yine çalışır).',
      'SDK portunu başka bir program kullanıyor: simülatördeki ve Wi-Fi üzerinden bağlanan uygulamalar Dürbün’e ulaşamaz (Android’de USB bağlantısı yine çalışır).',
    ],
    'sdk.listenFailed': [
      'SDK portu ({port}) açılamadı: {error}. Simülatördeki ve Wi-Fi üzerinden bağlanan uygulamalar Dürbün’e ulaşamaz (Android’de USB bağlantısı yine çalışır).',
      'SDK portu açılamadı. Simülatördeki ve Wi-Fi üzerinden bağlanan uygulamalar Dürbün’e ulaşamaz (Android’de USB bağlantısı yine çalışır).',
    ],
    'demo.startFailed': ['Demo modu başlatılamadı: {reason}', 'Demo modu başlatılamadı'],
    'replay.bodyTruncated': 'Yakalanan istek gövdesi kırpılmıştı; istek kırpılmış gövdeyle gönderildi',
    'replay.bodyMissing': 'İstek gövdesi yakalanmamış ya da bellekten atılmış; istek gövdesiz gönderildi',
    'replay.bodyDropped': 'GET ve HEAD istekleri gövde taşıyamaz; gövde çıkarıldı',

    /* ── command errors ── */
    'command.invalid': ['Geçersiz komut: {detail}', 'Geçersiz komut'],
    'command.unknown': 'Sunucu bu komutu tanımıyor; arayüz ile sunucu sürümleri farklı olabilir',
    'command.failed': ['İşlem başarısız oldu: {detail}', 'İşlem başarısız oldu'],
    'command.timeout': 'Sunucu zamanında yanıt vermedi',
    'command.disconnected': 'Sunucu bağlantısı koptu',
    'command.aborted': 'İşlem iptal edildi',
    'device.unknown': 'Cihaz bulunamadı; bağlantısı kesilmiş olabilir',
    'device.readOnly': 'İçe aktarılan kayıtlar salt okunurdur; cihaz işlemleri kullanılamaz',
    'device.noActions': 'Masaüstü kaydında cihaz işlemi yok',
    'device.networkOnly': 'Bu cihaz yalnızca ağ üzerinden SDK ile bağlı; cihaz işlemleri için USB ya da simülatör gerekir',
    'action.failed': ['İşlem başarısız oldu: {detail}', 'İşlem başarısız oldu'],
    'action.timeout': 'İşlem zamanında bitmedi',
    'action.invalidResult': 'Cihazdan geçersiz bir yanıt geldi',
    'app.unknown': 'Uygulama oturumu bulunamadı',
    'app.timeout': 'Uygulama zamanında yanıt vermedi',
    'app.notConnected': 'Uygulama bağlı değil',
    'app.commandTimeout': 'Uygulama komuta zamanında yanıt vermedi',
    'app.commandsUnsupported': 'Bu uygulamanın SDK’sı komutları desteklemiyor',
    'server.shutdown': 'Dürbün kapanıyor',
    'config.invalid': ['Geçersiz ayar: {detail}', 'Geçersiz ayar'],
    'vm.unavailable': 'Flutter VM Service modülü kullanılamıyor',
    'vm.timeout': 'Dart VM Service’e bağlanmak çok uzun sürdü',
    'vm.noServiceUrl':
      'Metinde Dart VM Service adresi bulunamadı. flutter run çıktısındaki “A Dart VM Service … is available at: http://127.0.0.1:…/…=/” adresini, bir DevTools bağlantısını ya da çıktının tamamını yapıştırın.',
    'metrics.unsupported': 'Bu cihazda CPU ve bellek ölçümü yapılamıyor',
    'net.unknown': 'Bu istek artık bellekte değil',
    'replay.invalidMethod': ['Geçersiz HTTP yöntemi: {detail}', 'Geçersiz HTTP yöntemi'],
    'replay.invalidUrl': 'Geçersiz URL',
    'replay.unsupportedUrl': 'Yalnızca http ve https istekleri yeniden gönderilebilir',
    'demo.unavailable': 'Bu sürümde demo modu yok',
    'demo.timeout': 'Demo modu zamanında açılıp kapanmadı',
    'demo.unsupportedAction': 'Demo cihazları bu işlemi desteklemiyor',
    'demo.actionFailed': ['Demo işlemi başarısız oldu: {detail}', 'Demo işlemi başarısız oldu'],
    'params.invalid': ['Geçersiz parametre: {detail}', 'Geçersiz parametre'],
    'app.notInstalled': 'Uygulama bu cihazda yüklü değil',
    'screenshot.writeFailed': ['Ekran görüntüsü kaydedilemedi: {detail}', 'Ekran görüntüsü kaydedilemedi'],
    'sdk.unavailable': 'SDK katmanı kullanılamıyor',

    /* ── device action results ── */
    'action.done': 'Tamamlandı',
    'action.listApps': 'Uygulama listesi alındı',
    'action.screenshot.saved': ['Ekran görüntüsü kaydedildi ({size})', 'Ekran görüntüsü kaydedildi'],
    'action.recording.saved': 'Ekran kaydı kaydedildi',
    'action.invalidParams': ['Geçersiz parametre: {detail}', 'Geçersiz parametre'],
    'action.unsupported': 'Bu cihaz bu işlemi desteklemiyor',
    'action.deviceOffline': 'Cihaz çevrimdışı ya da kapalı',
    'action.deviceNotFound': 'Cihaz bulunamadı',
    'action.toolMissing': ['Gerekli araç eksik: {detail}', 'Gerekli araç eksik'],
    'action.screenshotRefused': 'Cihaz ekran görüntüsünü reddetti; Geliştirici Modu ya da geliştirici disk görüntüsü gerekebilir',
    'action.appNotFound': 'Uygulama bu cihazda yüklü değil',
    'action.fileNotFound': 'Dosya bulunamadı',
    'action.unsupportedFile': 'Bu dosya kurulamaz: Android’de .apk, iOS’ta .app ya da .ipa gerekir (simülatörde .zip de olur)',
    'action.inputTextAscii': 'Android “input text” yalnızca ASCII karakterleri yazabilir (ç, ğ, ı, ö, ş, ü desteklenmez)',
    'action.installFailed': ['Kurulum başarısız oldu: {detail}', 'Kurulum başarısız oldu'],
    'action.launchFailed': ['Uygulama başlatılamadı: {detail}', 'Uygulama başlatılamadı'],
    'action.uninstallFailed': ['Uygulama kaldırılamadı: {detail}', 'Uygulama kaldırılamadı'],
    'action.openUrlFailed': ['Bağlantı açılamadı: {detail}', 'Bağlantı açılamadı'],

    /* ── REST ── */
    'access.denied': 'Erişim reddedildi: Dürbün’e yalnızca bu Mac’ten erişilebilir',
    'api.notFound': 'İstenen kaynak bulunamadı',
    'body.aborted': 'İstek yarıda kesildi',
    'body.evicted': 'Gövde, bellek sınırı nedeniyle bellekten atıldı',
    'body.invalidJson': ['Geçersiz JSON: {detail}', 'Geçersiz JSON'],
    'body.none': 'Bu isteğin gövdesi yok',
    'body.tooLarge': ['İstek gövdesi çok büyük (en fazla {limit})', 'İstek gövdesi çok büyük'],
    'file.unknown': 'Dosya bulunamadı',
    'har.invalid': 'Geçersiz HAR isteği',
    'import.failed': ['İçe aktarılamadı: {detail}', 'İçe aktarılamadı'],
    'import.invalid': 'Bu dosya bir Dürbün oturumu değil',
    'import.version': 'Bu oturum dosyası daha yeni bir Dürbün sürümüyle kaydedilmiş',
    'import.done': [{ one: '{count} cihaz içe aktarıldı', other: '{count} cihaz içe aktarıldı' }, 'Oturum içe aktarıldı'],
    'method.notAllowed': 'Bu işleme izin verilmiyor',
    'search.invalid': 'Geçersiz arama isteği',
    'upload.aborted': 'Yükleme yarıda kesildi',
    'upload.failed': ['Yüklenen dosya kaydedilemedi: {detail}', 'Yüklenen dosya kaydedilemedi'],
    'upload.tooLarge': ['Dosya çok büyük (en fazla {limit})', 'Dosya çok büyük'],
    'url.invalid': 'Geçersiz adres',
    network: 'Dürbün sunucusuna ulaşılamadı',

    /* ── SDK-less readers (DeviceInfo.readers, `{ detail }` = the server's English detail) ── */
    'reader.crashReports.dropboxRefused':
      'Bu cihaz Android’in çökme kayıtlarının (dumpsys dropbox) okunmasına izin vermiyor; bazı üreticiler bunu kapatır. Canlı çökmeler cihaz logunda yine görünür, önceki açılışların kayıtları görünmez.',
    'reader.crashReports.devicectlMissing':
      'iPhone’un çökme raporlarını (.ips) okumak için Xcode’un devicectl aracı gerekir; bu Mac’te bulunamadı. Xcode 15 ya da daha yenisi kurulunca raporlar kendiliğinden gelir.',
    'reader.crashReports.developerModeOff':
      'iPhone’da Geliştirici Modu kapalı olduğu için çökme raporları (.ips) okunamıyor. Ayarlar → Gizlilik ve Güvenlik → Geliştirici Modu açılıp telefon yeniden başlatılınca raporlar gelir.',
    'reader.crashReports.failed': ['Cihazın çökme kayıtları okunamadı: {detail}', 'Cihazın çökme kayıtları şu an okunamıyor.'],
    'reader.frameStats.noData':
      'CPU ve bellek cihazın süreç listesinden okunur. FPS ise bu cihazda dışarıdan ölçülemiyor: ne gfxinfo ne SurfaceFlinger bu uygulama için kare verdi; FPS için SDK ya da Flutter debug oturumu gerekir.',
    'reader.frameStats.unsupported': 'Bu cihaz kare istatistiklerini dışarıya vermiyor; FPS ve takılan kareler yalnızca uygulamanın içinden (SDK ya da Flutter debug) ölçülür.',

    /* ── Doctor rows (ToolCheck.code) ── */
    'doctor.node.embedded': ['Dürbün.app içinde gömülü (Electron {electron}, Node {node})', 'Dürbün.app içinde gömülü (Node {node})', 'Dürbün.app içinde gömülü'],

    /* ── UI-side messages kept under code.* (used by the shell) ── */
    'demo.enabled': 'Demo verisi açıldı',
    'demo.disabled': 'Demo verisi kapatıldı',
    'settings.saved': 'Ayarlar kaydedildi',
    'mocks.saved': 'Mock kuralları kaydedildi',

    /* ── generic labels (deviceStateText / logStatusText fallbacks) ── */
    state: {
      online: 'Bağlı',
      offline: 'Çevrimdışı',
      unauthorized: 'İzin bekleniyor',
      disconnected: 'Bağlantı kesildi',
    },
    logStatus: {
      starting: 'Log akışı başlıyor',
      streaming: 'Loglar akıyor',
      unavailable: 'Loglar alınamıyor',
      stopped: 'Log akışı durdu',
      error: 'Log akışında hata',
    },

    /* ── pieces of derived params ── */
    part: {
      kind: { emulator: 'emülatör', simulator: 'simülatör' },
      connection: { usb: 'USB', wifi: 'Wi-Fi' },
      deviceState: { offline: 'çevrimdışı', unauthorized: 'izin bekleniyor' },
      /** logs.scopeNotApplied `reason`: why app lines cannot be told from system lines. */
      scopeWhy: {
        devicectlMissing: 'uygulama satırlarını ayırmak için Xcode 15 ya da daha yenisi (devicectl) gerekir',
        appListFailed: 'kurulu uygulamalar devicectl ile okunamadığı için uygulama satırları ayrılamıyor',
      },
      /** logs.connectionLost / connectionRestored while the log stream was cut. */
      gap: { lost: 'dönene kadar log satırı gelmez', restored: 'aradaki log satırları eksik' },
      sdk: {
        flutter: 'Flutter SDK',
        android: 'Android SDK',
        ios: 'iOS SDK',
        'react-native': 'React Native SDK',
        js: 'JS SDK',
        'dart-vm': 'Dart VM Service',
        demo: 'demo',
      },
      transport: {
        'adb-reverse': 'adb reverse',
        usbmux: 'usbmux',
        tcp: 'TCP',
        websocket: 'WebSocket',
        'vm-service': 'VM Service',
        demo: 'demo',
        import: 'içe aktarma',
      },
      failedRequests: { one: 'yanıt bekleyen {count, number} istek başarısız sayıldı', other: 'yanıt bekleyen {count, number} istek başarısız sayıldı' },
      reason: {
        simulatorShutdown: 'simülatör kapatıldı',
        demoStopped: 'demo modu kapatıldı',
        networkIdle: 'ağ üzerinden bağlı uygulama kalmadı',
        driverStopped: 'Dürbün izlemeyi bıraktı',
        vmDurbunStopped: 'Dürbün kapatıldı',
        vmByUser: 'elle ayrıldı',
        vmAppRestarted: 'uygulama yeniden başlatıldı',
        vmAppStopped: 'uygulama durdu ya da cihazın bağlantısı kesildi',
        vmSessionClosed: 'sunucu uygulama oturumunu kapattı',
      },
      adjustedRange: '{name}: {from} yerine {to} kullanıldı (izin verilen {min}–{max})',
      adjustedWatchedApps: 'İzlenen uygulamalar listesi düzenlendi (boşluklar ve tekrarlar temizlendi)',
      desktopDevice: 'Masaüstü · yeniden gönderilenler',
      driver: {
        androidOnline: '{adb} · {count, number} cihaz bağlı',
        simulators: '{count, number} açık simülatör',
        iosDevices: '{count, number} bağlı cihaz',
        vmNotStarted: 'Başlatılmadı',
        vmAttached: '{count, number} uygulama Dart VM Service ile bağlı',
        vmWaiting: 'Flutter debug uygulamaları bekleniyor (otomatik bağlanma açık)',
        vmIdle: 'Bağlı uygulama yok (otomatik bağlanma kapalı)',
      },
    },
  },
  en: {
    /* ── system lines ── */
    'device.connected': ['{device} connected ({details})', '{device} connected', '{name} connected', 'Device connected'],
    'device.disconnected': ['{device} disconnected ({reason})', '{device} disconnected', '{name} disconnected', 'Device disconnected'],
    'app.connected': ['{app} {version} connected ({via})', '{app} connected ({via})', '{app} {version} connected', '{app} connected', '{name} {version} connected', '{name} connected', 'App connected'],
    'app.reconnected': ['{app} reconnected ({via})', '{app} reconnected', '{name} reconnected', 'App reconnected'],
    'app.disconnected': ['{app} disconnected · {failed}', '{app} disconnected', '{name} disconnected', 'App disconnected'],
    'process.started': ['{process} started · pid {pid}', '{process} started', '{name} started · pid {pid}', '{name} started', 'Process started'],
    'process.died': ['{process} died · pid {pid}', '{process} died', '{name} died · pid {pid}', '{name} died', 'Process died'],
    marker: ['{label}', 'Marker {n}', 'Marker'],
    'logs.streamStarted': ['Device log stream started ({via})', 'Device log stream started'],
    'logs.streamStopped': ['Device log stream stopped ({via})', 'Device log stream stopped'],
    'logs.streamError': ['Device log stream interrupted ({via}); restarting', 'Device log stream interrupted; restarting'],
    'logs.streamStalled': ['The iPhone is connected, but its log stream has been silent for {seconds, number} s; restarting it', 'The iPhone is connected, but its log stream went silent; restarting it'],
    'logs.scopeNotApplied': [
      '{device}: system process lines are shown too; {why}',
      '{device}: system process lines are shown too',
      'The iPhone’s system process lines are shown too; {why}',
      'The iPhone’s system process lines are shown too',
    ],
    'logs.scopeApplied': [
      '{device}: the installed apps could be read; system process lines are left out from now on',
      'The installed apps could be read; the iPhone’s system process lines are left out from now on',
    ],
    'logs.connectionLost': [
      'The device’s {link} connection dropped; {gap}. If it is not back within {graceSeconds, number} s, the device shows as disconnected',
      'The device’s {link} connection dropped; if it is not back within {graceSeconds, number} s, the device shows as disconnected',
      'The device’s {link} connection dropped',
      'The device’s connection dropped',
    ],
    'logs.connectionRestored': [
      'The device’s {link} connection is back after {seconds, number} s; {gap}',
      'The device’s {link} connection is back after {seconds, number} s',
      'The device’s connection is back',
    ],
    'vm.attached': ['Attached to {app} through the Dart VM Service', 'Attached to {name} through the Dart VM Service', 'Attached to the Dart VM Service'],
    'vm.detached': ['Detached from {app} ({reason})', 'Detached from {app}', 'Detached from the Dart VM Service'],
    'vm.attachFailed': ['Could not attach to the Dart VM Service: {error}', 'Could not attach to the Dart VM Service'],
    'vm.hotRestart': ['Hot restart · {app}', 'Hot restart'],
    'vm.hotReload': ['Hot reload · {app}', 'Hot reload'],
    'sdk.routeElsewhere': [
      'This device’s SDK connections go to another Dürbün running on this computer (localhost:{port}). Apps with the SDK show up there; device logs still appear here.',
      'This device’s SDK connections go to another Dürbün running on this computer. Apps with the SDK show up there; device logs still appear here.',
    ],

    /* ── device states ── */
    'device.unauthorized': 'Accept the “Allow USB debugging?” prompt on the device',
    'device.authorizing': 'Waiting for the device to authorize this computer…',
    'device.noPermissions': 'adb has no permission to access this USB device',
    'device.notBooted': 'The device is in recovery or bootloader mode',
    'device.offline': 'The device is offline — unplug and reconnect the cable',
    'device.untrusted': 'Unlock the device and tap Trust on “Trust This Computer?”',
    'device.simulatorShutdown': 'Simulator shut down',
    'device.driverStopped': 'Dürbün stopped watching this device',
    'device.imported': 'Imported recording · read-only',
    'device.networkIdle': 'No app is connected over the network',
    'demo.stopped': 'Demo mode turned off',
    'device.booting': 'Device is booting…',

    /* ── log stream states ── */
    'logs.streamRestarting': 'Restarting the log stream…',
    'logs.unavailable': 'Logs are not available for this device',
    'logs.adbMissing': 'adb not found — install Android SDK Platform-Tools',
    'logs.deviceOffline': 'The device is offline; no logs',
    'logs.processExited': 'The log tool exited; restarting',
    'logs.idevicesyslogMissing': 'idevicesyslog not found — install libimobiledevice',
    'logs.usbmuxdUnavailable': 'usbmuxd is unreachable; USB-connected iOS devices cannot be seen',
    'logs.simctlMissing': 'Xcode (simctl) not found; iOS simulators cannot be seen',
    'logs.networkOnly': 'SDK data only: the app is connected over the network, device logs are not available',

    /* ── drivers ── */
    'driver.adbError': 'adb reported an error',
    'driver.simctlError': 'simctl reported an error',
    'driver.initFailed': 'The driver failed to start',
    'driver.statusFailed': 'Could not read the driver status',
    'demo.active': 'Generating sample data on the demo devices',
    'demo.inactive': 'Demo mode is off',

    /* ── notices ── */
    'settings.adjusted': ['Some values were adjusted: {details}', 'Some values were moved into their allowed range'],
    'settings.lanOn': ['Local network mode is on: apps can reach the SDK port ({sdkPort}) over the network.', 'Local network mode is on.'],
    'settings.lanOnRestart': [
      'Local network mode is on: apps can reach the SDK port ({sdkPort}) over the network. The HTTP port ({httpPort}) used by React Native stays reachable from this Mac only until Dürbün restarts.',
      'Local network mode is on. The HTTP port stays reachable from this Mac only until Dürbün restarts.',
    ],
    'settings.lanOff': ['Local network mode is off: the SDK port ({sdkPort}) now accepts connections from this Mac only.', 'Local network mode is off.'],
    'settings.lanOffRestart': [
      'Local network mode is off: the SDK port ({sdkPort}) now accepts connections from this Mac only. The HTTP port ({httpPort}) stays open to the network until Dürbün restarts.',
      'Local network mode is off. The HTTP port stays open to the network until Dürbün restarts.',
    ],
    'settings.sdkRebindFailed': ['Could not reopen the SDK port ({port}): {error}', 'Could not reopen the SDK port'],
    'config.writeFailed': ['Could not save {file}: {error}', 'Could not save the settings file'],
    'config.unreadable': [
      '{file} could not be read ({error}); Dürbün started without it. A copy of the broken file: {backup}',
      '{file} could not be read ({error}); Dürbün started without it.',
      'A settings file could not be read; Dürbün started without it.',
    ],
    'config.dataDirFallback': ['Cannot write to {dir} ({error}); using {fallback} for this run.', 'Cannot write to the data folder; using a temporary folder for this run.'],
    'config.tempDirFallback': ['The temp folder could not be created ({error}); using {dir}.', 'The temp folder could not be created; using the system temp folder.'],
    'sdk.portBusy': [
      'Another program is using the SDK port ({port}): apps on simulators or Wi-Fi cannot connect (Android over USB still works).',
      'Another program is using the SDK port: apps on simulators or Wi-Fi cannot connect (Android over USB still works).',
    ],
    'sdk.listenFailed': [
      'The SDK port ({port}) could not be opened: {error}. Apps on simulators or Wi-Fi cannot connect (Android over USB still works).',
      'The SDK port could not be opened. Apps on simulators or Wi-Fi cannot connect (Android over USB still works).',
    ],
    'demo.startFailed': ['Demo mode could not start: {reason}', 'Demo mode could not start'],
    'replay.bodyTruncated': 'The captured request body was truncated; the request was sent with the truncated body',
    'replay.bodyMissing': 'The request body was not captured or was evicted; the request was sent without a body',
    'replay.bodyDropped': 'GET and HEAD requests cannot carry a body; it was dropped',

    /* ── command errors ── */
    'command.invalid': ['Invalid command: {detail}', 'Invalid command'],
    'command.unknown': 'The server does not know this command; the UI and server versions may differ',
    'command.failed': ['The action failed: {detail}', 'The action failed'],
    'command.timeout': 'The server did not reply in time',
    'command.disconnected': 'Lost the connection to the server',
    'command.aborted': 'Cancelled',
    'device.unknown': 'Device not found; it may have been disconnected',
    'device.readOnly': 'Imported recordings are read-only; device actions are not available',
    'device.noActions': 'The desktop entry has no device actions',
    'device.networkOnly': 'This device is only connected through the app SDK over the network; device actions need USB or a simulator',
    'action.failed': ['The action failed: {detail}', 'The action failed'],
    'action.timeout': 'The action did not finish in time',
    'action.invalidResult': 'The device returned an invalid result',
    'app.unknown': 'App session not found',
    'app.timeout': 'The app did not answer in time',
    'app.notConnected': 'The app is not connected',
    'app.commandTimeout': 'The app did not answer the command in time',
    'app.commandsUnsupported': 'This app’s SDK does not support commands',
    'server.shutdown': 'Dürbün is shutting down',
    'config.invalid': ['Invalid setting: {detail}', 'Invalid setting'],
    'vm.unavailable': 'The Flutter VM Service module is not available',
    'vm.timeout': 'Attaching to the Dart VM Service took too long',
    'vm.noServiceUrl':
      'No Dart VM Service URL found. Paste the URL printed by flutter run (“A Dart VM Service … is available at: http://127.0.0.1:…/…=/”), a DevTools link, or the whole output.',
    'metrics.unsupported': 'CPU and memory polling is not available for this device',
    'net.unknown': 'This request is no longer available',
    'replay.invalidMethod': ['Invalid HTTP method: {detail}', 'Invalid HTTP method'],
    'replay.invalidUrl': 'Invalid URL',
    'replay.unsupportedUrl': 'Only http and https requests can be replayed',
    'demo.unavailable': 'Demo mode is not available in this build',
    'demo.timeout': 'Demo mode did not start or stop in time',
    'demo.unsupportedAction': 'Demo devices do not support this action',
    'demo.actionFailed': ['The demo action failed: {detail}', 'The demo action failed'],
    'params.invalid': ['Invalid parameter: {detail}', 'Invalid parameter'],
    'app.notInstalled': 'The app is not installed on this device',
    'screenshot.writeFailed': ['Could not save the screenshot: {detail}', 'Could not save the screenshot'],
    'sdk.unavailable': 'The SDK layer is unavailable',

    /* ── device action results ── */
    'action.done': 'Done',
    'action.listApps': 'App list loaded',
    'action.screenshot.saved': ['Screenshot saved ({size})', 'Screenshot saved'],
    'action.recording.saved': 'Screen recording saved',
    'action.invalidParams': ['Invalid parameter: {detail}', 'Invalid parameter'],
    'action.unsupported': 'This device does not support this action',
    'action.deviceOffline': 'The device is offline or not booted',
    'action.deviceNotFound': 'Device not found',
    'action.toolMissing': ['A required tool is missing: {detail}', 'A required tool is missing'],
    'action.screenshotRefused': 'The device refused the screenshot; Developer Mode or the developer disk image may be required',
    'action.appNotFound': 'The app is not installed on this device',
    'action.fileNotFound': 'File not found',
    'action.unsupportedFile': 'This file cannot be installed: Android needs an .apk, iOS an .app or .ipa (a .zip also works on simulators)',
    'action.inputTextAscii': 'Android “input text” only supports printable ASCII characters',
    'action.installFailed': ['Install failed: {detail}', 'Install failed'],
    'action.launchFailed': ['Could not launch the app: {detail}', 'Could not launch the app'],
    'action.uninstallFailed': ['Could not uninstall the app: {detail}', 'Could not uninstall the app'],
    'action.openUrlFailed': ['Could not open the link: {detail}', 'Could not open the link'],

    /* ── REST ── */
    'access.denied': 'Access denied: Dürbün only accepts requests from this Mac',
    'api.notFound': 'Not found',
    'body.aborted': 'The request was aborted',
    'body.evicted': 'The body was evicted from memory (body budget)',
    'body.invalidJson': ['Invalid JSON: {detail}', 'Invalid JSON'],
    'body.none': 'This request has no body',
    'body.tooLarge': ['The request body is too large (limit {limit})', 'The request body is too large'],
    'file.unknown': 'File not found',
    'har.invalid': 'Invalid HAR request',
    'import.failed': ['Import failed: {detail}', 'Import failed'],
    'import.invalid': 'This file is not a Dürbün session',
    'import.version': 'This session file was saved by a newer Dürbün version',
    'import.done': [{ one: 'Imported {count} device', other: 'Imported {count} devices' }, 'Session imported'],
    'method.notAllowed': 'Method not allowed',
    'search.invalid': 'Invalid search request',
    'upload.aborted': 'Upload aborted',
    'upload.failed': ['Could not save the upload: {detail}', 'Could not save the upload'],
    'upload.tooLarge': ['The file is too large (limit {limit})', 'The file is too large'],
    'url.invalid': 'Malformed URL',
    network: 'Could not reach the Dürbün server',

    'reader.crashReports.dropboxRefused':
      'This device does not allow reading Android’s crash records (dumpsys dropbox); some manufacturers block it. Live crashes still show up in the device log; records of earlier launches do not.',
    'reader.crashReports.devicectlMissing':
      'Reading the iPhone’s crash reports (.ips) takes Xcode’s devicectl tool, which was not found on this Mac. Once Xcode 15 or newer is installed, the reports come in by themselves.',
    'reader.crashReports.developerModeOff':
      'Crash reports (.ips) cannot be read while Developer Mode is off on the iPhone. Once it is turned on in Settings → Privacy & Security → Developer Mode and the phone has restarted, the reports come in.',
    'reader.crashReports.failed': ['The device’s crash records could not be read: {detail}', 'The device’s crash records cannot be read right now.'],
    'reader.frameStats.noData':
      'CPU and memory are read from the device’s process list. FPS cannot be measured from outside on this device: neither gfxinfo nor SurfaceFlinger gave frames for this app; FPS needs the SDK or a Flutter debug session.',
    'reader.frameStats.unsupported': 'This device does not expose frame stats; FPS and janky frames can only be measured inside the app (SDK or Flutter debug).',

    'doctor.node.embedded': ['Embedded in Dürbün.app (Electron {electron}, Node {node})', 'Embedded in Dürbün.app (Node {node})', 'Embedded in Dürbün.app'],

    /* ── UI-side messages kept under code.* (used by the shell) ── */
    'demo.enabled': 'Demo data enabled',
    'demo.disabled': 'Demo data disabled',
    'settings.saved': 'Settings saved',
    'mocks.saved': 'Mock rules saved',

    state: {
      online: 'Connected',
      offline: 'Offline',
      unauthorized: 'Waiting for permission',
      disconnected: 'Disconnected',
    },
    logStatus: {
      starting: 'Log stream starting',
      streaming: 'Logs streaming',
      unavailable: 'Logs unavailable',
      stopped: 'Log stream stopped',
      error: 'Log stream error',
    },

    part: {
      kind: { emulator: 'emulator', simulator: 'simulator' },
      connection: { usb: 'USB', wifi: 'Wi-Fi' },
      deviceState: { offline: 'offline', unauthorized: 'waiting for permission' },
      scopeWhy: {
        devicectlMissing: 'telling app lines apart needs Xcode 15 or newer (devicectl)',
        appListFailed: 'the installed apps could not be read with devicectl, so app lines cannot be told apart',
      },
      gap: { lost: 'no log lines until it is back', restored: 'log lines from the gap are missing' },
      sdk: {
        flutter: 'Flutter SDK',
        android: 'Android SDK',
        ios: 'iOS SDK',
        'react-native': 'React Native SDK',
        js: 'JS SDK',
        'dart-vm': 'Dart VM Service',
        demo: 'demo',
      },
      transport: {
        'adb-reverse': 'adb reverse',
        usbmux: 'usbmux',
        tcp: 'TCP',
        websocket: 'WebSocket',
        'vm-service': 'VM Service',
        demo: 'demo',
        import: 'import',
      },
      failedRequests: { one: '{count, number} pending request failed', other: '{count, number} pending requests failed' },
      reason: {
        simulatorShutdown: 'simulator shut down',
        demoStopped: 'demo mode turned off',
        networkIdle: 'no app is connected over the network',
        driverStopped: 'Dürbün stopped watching it',
        vmDurbunStopped: 'Dürbün stopped',
        vmByUser: 'detached by you',
        vmAppRestarted: 'the app restarted',
        vmAppStopped: 'the app stopped or the device was disconnected',
        vmSessionClosed: 'the server closed the app session',
      },
      adjustedRange: '{name}: {to} instead of {from} (allowed {min}–{max})',
      adjustedWatchedApps: 'The watched apps list was cleaned up (trimmed, duplicates removed)',
      desktopDevice: 'Desktop · replays',
      driver: {
        androidOnline: { one: '{adb} · {count, number} device online', other: '{adb} · {count, number} devices online' },
        simulators: { one: '{count, number} booted simulator', other: '{count, number} booted simulators' },
        iosDevices: { one: '{count, number} device attached', other: '{count, number} devices attached' },
        vmNotStarted: 'Not started',
        vmAttached: { one: '{count, number} app attached through the Dart VM Service', other: '{count, number} apps attached through the Dart VM Service' },
        vmWaiting: 'Waiting for Flutter debug apps (auto-attach on)',
        vmIdle: 'No app attached (auto-attach off)',
      },
    },
  },
});

/* ────────────────────────────── derived params ────────────────────────────── */

type Params = Record<string, string | number | boolean | null | undefined>;

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function part(lang: Lang, key: string, params?: TParams): string {
  return translateOr(lang, `code.part.${key}`, params, '');
}

/** device.disconnected `detail` texts the server sends (English) → localized reason. */
const DISCONNECT_REASONS: Record<string, string> = {
  'Simulator shut down': 'simulatorShutdown',
  'Demo mode turned off': 'demoStopped',
  'No app is connected over the network': 'networkIdle',
  'Dürbün stopped watching Android devices': 'driverStopped',
  'Dürbün stopped watching iOS devices': 'driverStopped',
  'Dürbün stopped watching simulators': 'driverStopped',
};

/** vm.detached `reason` texts the server sends (English) → localized reason. */
const VM_DETACH_REASONS: Record<string, string> = {
  'Dürbün stopped': 'vmDurbunStopped',
  'detached by the user': 'vmByUser',
  'the app restarted (new VM service URL)': 'vmAppRestarted',
  'the app stopped or the device was disconnected': 'vmAppStopped',
  'the server closed the app session': 'vmSessionClosed',
};

/** settings.adjusted detail "<key> <from> → <to> (allowed <min>–<max>)". */
const ADJUSTED_RANGE = /^(\w+) (-?[\d.]+(?:e[+-]?\d+)?) → (-?[\d.]+) \(allowed (-?[\d.]+)–(-?[\d.]+)\)$/;

/** Setting key → its label in the Settings dialog. */
const SETTING_LABEL_KEYS: Record<string, string> = {
  maxLogEntries: 'shell.settings.maxLogEntries',
  maxNetworkEntries: 'shell.settings.maxNetworkEntries',
  maxBodyBytes: 'shell.settings.maxBodyBytes',
  maxBodyStoreMB: 'shell.settings.maxBodyStoreMB',
  logcatTail: 'shell.settings.logcatTail',
  metricsIntervalMs: 'shell.settings.metricsInterval',
};

function formatNum(n: number, lang: Lang): string {
  try {
    return new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 2 }).format(n);
  } catch {
    return String(n);
  }
}

/** Localize the English `details` of a settings.adjusted notice ("; "-separated). */
export function localizeAdjustedDetails(details: string, lang: Lang = getLanguage()): string {
  return details
    .split(/;\s*/)
    .filter(Boolean)
    .map((d) => {
      const m = ADJUSTED_RANGE.exec(d.trim());
      if (m) {
        const labelKey = SETTING_LABEL_KEYS[m[1]!];
        const name = labelKey ? translateOr(lang, labelKey, undefined, m[1]!) : m[1]!;
        return part(lang, 'adjustedRange', {
          name,
          from: formatNum(Number(m[2]), lang),
          to: formatNum(Number(m[3]), lang),
          min: formatNum(Number(m[4]), lang),
          max: formatNum(Number(m[5]), lang),
        });
      }
      if (/^watchedApps normalized/.test(d)) return part(lang, 'adjustedWatchedApps');
      return d;
    })
    .join('; ');
}

function appVia(p: Params, lang: Lang): string {
  const sdk = str(p.sdk);
  const transport = str(p.transport);
  const sdkLabel = sdk ? translateOr(lang, `code.part.sdk.${sdk}`, undefined, sdk) : '';
  const redundant = (sdk === 'dart-vm' && transport === 'vm-service') || (sdk === 'demo' && transport === 'demo');
  const transportLabel = transport && !redundant ? translateOr(lang, `code.part.transport.${transport}`, undefined, transport) : '';
  return [sdkLabel, transportLabel].filter(Boolean).join(' · ');
}

/**
 * logs.connectionLost / connectionRestored: `link` = USB / Wi-Fi; `gap` when the server's English detail says the
 * log stream was cut too (the params carry no flag for it).
 */
function connectionGap(p: Params, lang: Lang, which: 'lost' | 'restored', cut: RegExp): Partial<Prepared> {
  const connection = str(p.connection);
  const link = connection === 'usb' || connection === 'wifi' ? part(lang, `connection.${connection}`) : '';
  return { params: { ...p, link, gap: cut.test(str(p.detail)) ? part(lang, `gap.${which}`) : '' } };
}

type Prepared = { key: string; params: Params };
type Preparer = (p: Params, lang: Lang) => Partial<Prepared> | void;

const PREPARE: Record<string, Preparer> = {
  'device.connected': (p, lang) => {
    const bits: string[] = [];
    const os = str(p.osVersion);
    const platform = str(p.platform);
    if (os) bits.push(platform === 'android' ? `Android ${os}` : platform === 'ios' ? `iOS ${os}` : os);
    const kind = str(p.kind);
    const connection = str(p.connection);
    if (kind === 'emulator' || kind === 'simulator') bits.push(part(lang, `kind.${kind}`));
    else if (connection === 'usb' || connection === 'wifi') bits.push(part(lang, `connection.${connection}`));
    return { params: { ...p, details: bits.filter(Boolean).join(' · ') } };
  },
  'device.disconnected': (p, lang) => {
    const state = str(p.state);
    let reason = '';
    if (state === 'offline' || state === 'unauthorized') reason = part(lang, `deviceState.${state}`);
    else {
      const detail = str(p.detail);
      const known = DISCONNECT_REASONS[detail];
      reason = known ? part(lang, `reason.${known}`) : detail;
    }
    return { params: { ...p, reason } };
  },
  'app.connected': (p, lang) => ({ params: { ...p, via: appVia(p, lang) } }),
  'app.reconnected': (p, lang) => ({ params: { ...p, via: appVia(p, lang) } }),
  'app.disconnected': (p, lang) => {
    const n = num(p.failedRequests) ?? 0;
    return { params: { ...p, failed: n > 0 ? part(lang, 'failedRequests', { count: n }) : '' } };
  },
  'logs.connectionLost': (p, lang) => connectionGap(p, lang, 'lost', /log lines are missing/),
  'logs.connectionRestored': (p, lang) => connectionGap(p, lang, 'restored', /log lines from that moment are missing/),
  'logs.scopeNotApplied': (p, lang) => {
    const reason = str(p.reason);
    return { params: { ...p, why: reason === 'devicectlMissing' || reason === 'appListFailed' ? part(lang, `scopeWhy.${reason}`) : '' } };
  },
  'vm.detached': (p, lang) => {
    const reason = str(p.reason);
    const known = VM_DETACH_REASONS[reason];
    return { params: { ...p, reason: known ? part(lang, `reason.${known}`) : reason } };
  },
  'settings.adjusted': (p, lang) => ({ params: { ...p, details: localizeAdjustedDetails(str(p.details), lang) } }),
  'settings.lanOn': (p) => (num(p.restartRequired) ? { key: 'settings.lanOnRestart' } : undefined),
  'settings.lanOff': (p) => (num(p.restartRequired) ? { key: 'settings.lanOffRestart' } : undefined),
  'action.screenshot.saved': (p) => {
    const w = num(p.width);
    const h = num(p.height);
    return { params: { ...p, size: w && h ? `${w}×${h}` : '' } };
  },
};

function prepare(code: string, params: Params | undefined, lang: Lang): Prepared {
  const p: Params = params ?? {};
  const out = PREPARE[code]?.(p, lang);
  return { key: out?.key ?? code, params: out?.params ?? p };
}

/* ────────────────────────────── public helpers ────────────────────────────── */

/** Localize a server code in a given language; `fallback` (the server's English text) when unknown. */
export function tCodeIn(lang: Lang, code: string | undefined, params: I18nParams | TParams | undefined, fallback: string): string {
  if (!code) return fallback;
  const prepared = prepare(code, params as Params | undefined, lang);
  return translateOr(lang, `code.${prepared.key}`, prepared.params, fallback);
}

/** Localize a server code; `fallback` (the server's English text) when unknown or params are missing. */
export function tCode(code: string | undefined, params: I18nParams | TParams | undefined, fallback: string): string {
  return tCodeIn(getLanguage(), code, params, fallback);
}

/** True when the UI has its own text for this code. */
export function hasCode(code: string | undefined): boolean {
  return Boolean(code) && hasMessage(`code.${code}`, 'en');
}

/** Display text of a system log line (`source: 'system'`). */
export function systemLineText(e: Pick<LogEntry, 'code' | 'params' | 'message'>): string {
  return tCode(e.code, e.params, e.message);
}

/** Display text of a server notice. */
export function noticeText(n: Pick<UiNotice, 'code' | 'params' | 'message'>): string {
  return tCode(n.code, n.params, n.message);
}

/**
 * Localized explanation of a device's state (from `stateCode` when known, else a generic state label).
 * The server's English `stateDetail` is best shown separately (tooltip) as extra detail.
 */
export function deviceStateText(d: Pick<DeviceInfo, 'state' | 'stateCode'>): string {
  const generic = t(`code.state.${d.state}`);
  return d.stateCode ? tCode(d.stateCode, undefined, generic) : generic;
}

/** Localized log stream status (from `logs.code` when known, else the generic status label). */
export function logStatusText(d: Pick<DeviceInfo, 'logs'>): string {
  const generic = t(`code.logStatus.${d.logs.status}`);
  return d.logs.code ? tCode(d.logs.code, undefined, generic) : generic;
}

/**
 * Name to show for a device: the virtual `desktop` device (requests replayed from Dürbün) gets a
 * localized name; every other device keeps its own (imported ones start with "📁 ").
 */
export function deviceDisplayName(d: Pick<DeviceInfo, 'id' | 'name'> | undefined, fallbackId?: string): string {
  const id = d?.id ?? fallbackId;
  if (id === 'desktop') return t('code.part.desktopDevice');
  return d?.name ?? fallbackId ?? '';
}

/** Localized `DriverStatus` text (code when present, else the server's English detail, localized when recognized). */
export function driverStatusText(d: Pick<DriverStatus, 'id' | 'code' | 'detail'>): string {
  const detail = d.detail ?? '';
  if (d.code && hasCode(d.code)) return tCode(d.code, undefined, detail);
  const lang = getLanguage();
  let m: RegExpExecArray | null;
  if ((m = /^(adb\b.*?) · (\d+) devices? online$/.exec(detail))) return part(lang, 'driver.androidOnline', { adb: m[1]!, count: Number(m[2]) });
  if ((m = /^(\d+) booted simulators?$/.exec(detail))) return part(lang, 'driver.simulators', { count: Number(m[1]) });
  if ((m = /^(\d+) devices?$/.exec(detail))) return part(lang, 'driver.iosDevices', { count: Number(m[1]) });
  if ((m = /^(\d+) apps? attached through the Dart VM service$/.exec(detail))) return part(lang, 'driver.vmAttached', { count: Number(m[1]) });
  if (detail === 'Not started') return part(lang, 'driver.vmNotStarted');
  if (detail === 'Waiting for Flutter debug apps (auto-attach on)') return part(lang, 'driver.vmWaiting');
  if (detail === 'No app attached (auto-attach off)') return part(lang, 'driver.vmIdle');
  return detail;
}

/** Generic English lead-ins that carry no information of their own. */
const GENERIC_MESSAGES = new Set(['the action failed', 'command failed', 'failed', 'error']);

/**
 * Specific part of a server error message ("Install failed: INSTALL_FAILED_…" → "INSTALL_FAILED_…").
 * Used as `{detail}` by the localized error templates.
 */
export function errorDetail(message: string): string {
  const msg = message.trim();
  if (!msg || GENERIC_MESSAGES.has(msg.toLowerCase())) return '';
  const at = msg.indexOf(': ');
  if (at > 0 && at <= 80) {
    const rest = msg.slice(at + 2).trim();
    return GENERIC_MESSAGES.has(rest.toLowerCase()) ? '' : rest;
  }
  // 'Invalid HTTP method "G E T"' → 'G E T'
  const quoted = /^[^"]{1,80}"([^"]+)"$/.exec(msg);
  if (quoted) return quoted[1]!;
  return msg;
}

/** Codes whose English message identifies a more specific, localizable case. */
function refineErrorCode(code: string, message: string): string {
  if ((code === 'command.failed' || code === 'vm.attachFailed') && /^No Dart VM service URL found/i.test(message)) return 'vm.noServiceUrl';
  return code;
}

/**
 * Human message for a caught error: localized when it carries a known i18n `code` (CommandError,
 * ApiError) — keeping the specific part of the server's message (`{detail}`) where the template has
 * room for it — otherwise its message.
 */
export function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    const message = typeof e.message === 'string' ? e.message : String(err);
    if (typeof e.code === 'string' && e.code) {
      const code = refineErrorCode(e.code, message);
      const limit = /\(limit ([^)]+)\)/.exec(message)?.[1] ?? '';
      return tCode(code, { detail: errorDetail(message), limit }, message);
    }
    return message;
  }
  return String(err);
}
