/**
 * Localization of the server codes the Device and Performance views meet (SPEC §9.3): command/action
 * errors, device state codes and log-stream codes, plus fix hints. The foundation's `code.*` dictionary wins
 * when it knows a code (`tCode`); this file fills the gaps under `device.codes.*`.
 */
import type { DeviceInfo, I18nParams } from '@durbun/protocol';
import { errorDetail, errorText, hasCode, hasMessage, registerMessages, t, tCode, tOr } from '../../i18n';

registerMessages('device', {
  tr: {
    common: { unknownError: 'Bilinmeyen bir hata oluştu' },
    codes: {
      network: 'Dürbün sunucusuna ulaşılamadı',
      command: {
        invalid: 'Komut geçersiz',
        unknown: 'Sunucu bu komutu tanımıyor (sürüm uyuşmazlığı olabilir)',
        failed: 'Komut çalıştırılamadı',
        timeout: 'Sunucu zamanında yanıt vermedi',
        disconnected: 'Sunucu bağlantısı koptu',
        aborted: 'İşlem iptal edildi',
      },
      device: {
        unknown: 'Cihaz bulunamadı — bağlantısı kesilmiş olabilir',
        readOnly: 'İçe aktarılmış oturumlar salt okunurdur',
        noActions: 'Bu kayıt için cihaz işlemi yok',
        networkOnly: 'Bu cihaz yalnızca Wi-Fi üzerinden SDK ile bağlı; cihaz işlemleri için USB ya da simülatör gerekir',
        authorizing: 'Cihaz yetkilendiriliyor…',
        notBooted: 'Simülatör açık değil',
        untrusted: 'iPhone bu bilgisayara henüz güvenmiyor',
        simulatorShutdown: 'Simülatör kapatıldı',
        driverStopped: 'Cihaz sürücüsü durdu',
        imported: 'İçe aktarılmış oturum (salt okunur)',
        networkIdle: 'Uygulama ağ üzerinden bağlıydı; oturum kapandı',
        unauthorized: 'USB hata ayıklama izni bekleniyor',
        offline: 'Cihaz çevrimdışı',
        noPermissions: 'Cihaza erişim izni yok',
      },
      action: {
        failed: 'İşlem başarısız oldu',
        timeout: 'Cihaz zamanında yanıt vermedi',
        invalidResult: 'Cihaz geçersiz bir sonuç döndürdü',
        invalidParams: 'Geçersiz değer',
        unsupported: 'Bu cihaz bu işlemi desteklemiyor',
        deviceOffline: 'Cihaz çevrimdışı',
        deviceNotFound: 'Cihaz bulunamadı',
        toolMissing: 'Gerekli araç kurulu değil (Sistem kontrolüne bakın)',
        screenshotRefused: 'Cihaz ekran görüntüsüne izin vermedi',
        unsupportedFile: 'Bu dosya türü bu cihaza kurulamaz',
        launchFailed: 'Uygulama başlatılamadı',
        uninstallFailed: 'Uygulama kaldırılamadı',
        openUrlFailed: 'Adres açılamadı — bu şemayı karşılayan uygulama olmayabilir',
        installFailed: 'Kurulum başarısız oldu',
        fileNotFound: 'Dosya sunucuda bulunamadı',
        appNotFound: 'Uygulama bu cihazda bulunamadı',
        inputTextAscii: 'adb yalnızca ASCII karakterleri yazabilir (ç, ğ, ı, ö, ş, ü gönderilemez)',
      },
      app: {
        unknown: 'Uygulama oturumu bulunamadı',
        disconnected: 'Uygulama bağlı değil',
        notConnected: 'Uygulama bağlı değil',
        timeout: 'Uygulama zamanında yanıt vermedi',
        commandTimeout: 'Uygulama zamanında yanıt vermedi',
        commandsUnsupported: 'Bu SDK sürümü komut desteklemiyor',
        notInstalled: 'Uygulama bu cihazda yüklü değil',
      },
      server: { shutdown: 'Sunucu kapanıyor' },
      config: { invalid: 'Ayar değeri geçersiz' },
      vm: {
        unavailable: 'Dart VM Service modülü kullanılamıyor',
        timeout: 'Dart VM Service yanıt vermedi',
        noServiceUrl: 'Metinde VM Service adresi bulunamadı',
        attachFailed: 'Dart VM Service bağlantısı kurulamadı',
      },
      metrics: { unsupported: 'Bu cihazda süreç ölçümü (CPU/bellek) yapılamıyor' },
      demo: {
        unavailable: 'Demo kullanılamıyor',
        timeout: 'Demo zamanında yanıt vermedi',
        inactive: 'Demo kapalı',
        unsupportedAction: 'Demo cihazı bu işlemi desteklemiyor',
        actionFailed: 'Demo işlemi başarısız oldu',
        stopped: 'Demo kapatıldı',
      },
      params: { invalid: 'Geçersiz değer' },
      screenshot: { writeFailed: 'Ekran görüntüsü kaydedilemedi' },
      sdk: { unavailable: 'SDK bağlantısı kullanılamıyor' },
      logs: {
        adbMissing: 'adb bulunamadı',
        deviceOffline: 'Cihaz çevrimdışı; loglar okunamıyor',
        processExited: 'Log aracı beklenmedik şekilde kapandı',
        idevicesyslogMissing: 'idevicesyslog bulunamadı',
        usbmuxdUnavailable: 'usbmuxd hizmetine ulaşılamıyor',
        simctlMissing: 'xcrun simctl bulunamadı (Xcode gerekli)',
        networkOnly: 'Yalnızca SDK verisi; bu cihazın logları okunmuyor',
      },
    },
    fix: {
      device: {
        unauthorized: 'Cihazın kilidini açın ve “USB hata ayıklamaya izin verilsin mi?” istemini onaylayın. “Bu bilgisayara her zaman izin ver” seçeneğini işaretlerseniz bir daha sorulmaz.',
        untrusted: 'iPhone’un kilidini açın ve “Bu bilgisayara güvenilsin mi?” sorusunda “Güven”e dokunun, ardından cihaz parolanızı girin.',
        notBooted: 'Simülatörü Xcode’dan ya da “xcrun simctl boot <udid>” ile başlatın.',
        offline: 'Kabloyu çıkarıp yeniden takın. Sorun sürerse “adb kill-server && adb start-server” çalıştırın.',
        noPermissions: 'adb bu cihaza erişemiyor. Kabloyu yeniden takın ve cihazda USB modunu “Dosya aktarımı” yapın.',
        authorizing: 'Birkaç saniye bekleyin; cihaz bağlantıyı onaylıyor.',
        simulatorShutdown: 'Simülatör kapatıldı. Yeniden başlattığınızda Dürbün kendiliğinden bağlanır.',
        driverStopped: 'Sürücü durdu. Sistem kontrolünden araçların durumuna bakın.',
        networkIdle: 'Uygulama yeniden bağlandığında bu cihaz tekrar canlanır.',
        imported: 'Bu bir kayıt; yalnızca bilgiler ve geçmiş veriler gösterilir.',
      },
      demo: { stopped: 'Demo verisini kenar çubuğundan yeniden açabilirsiniz.' },
      logs: {
        adbMissing: 'Android SDK Platform-Tools’u kurun (brew install --cask android-platform-tools).',
        idevicesyslogMissing: 'libimobiledevice’ı kurun: brew install libimobiledevice',
        usbmuxdUnavailable: 'iPhone’u yeniden takın; sorun sürerse Mac’i yeniden başlatın.',
        simctlMissing: 'Xcode’u ve komut satırı araçlarını kurun (xcode-select --install).',
        deviceOffline: 'Cihaz yeniden bağlandığında log akışı kendiliğinden başlar.',
        processExited: 'Log akışını yeniden başlatmayı deneyin.',
      },
    },
  },
  en: {
    common: { unknownError: 'An unknown error occurred' },
    codes: {
      network: 'Could not reach the Dürbün server',
      command: {
        invalid: 'Invalid command',
        unknown: 'The server does not know this command (version mismatch?)',
        failed: 'The command failed',
        timeout: 'The server did not reply in time',
        disconnected: 'Lost the connection to the server',
        aborted: 'Cancelled',
      },
      device: {
        unknown: 'Device not found — it may have been disconnected',
        readOnly: 'Imported sessions are read-only',
        noActions: 'This entry has no device actions',
        networkOnly: 'This device is connected only through the SDK over Wi-Fi; device actions need USB or a simulator',
        authorizing: 'Authorizing the device…',
        notBooted: 'The simulator is not booted',
        untrusted: 'The iPhone does not trust this computer yet',
        simulatorShutdown: 'The simulator was shut down',
        driverStopped: 'The device driver stopped',
        imported: 'Imported session (read-only)',
        networkIdle: 'The app was connected over the network; the session closed',
        unauthorized: 'Waiting for USB debugging permission',
        offline: 'The device is offline',
        noPermissions: 'No permission to access the device',
      },
      action: {
        failed: 'The action failed',
        timeout: 'The device did not reply in time',
        invalidResult: 'The device returned an invalid result',
        invalidParams: 'Invalid value',
        unsupported: 'This device does not support this action',
        deviceOffline: 'The device is offline',
        deviceNotFound: 'Device not found',
        toolMissing: 'A required tool is not installed (see System check)',
        screenshotRefused: 'The device refused the screenshot',
        unsupportedFile: 'This file type cannot be installed on this device',
        launchFailed: 'Could not launch the app',
        uninstallFailed: 'Could not uninstall the app',
        openUrlFailed: 'Could not open the address — no app may handle this scheme',
        installFailed: 'The installation failed',
        fileNotFound: 'The file was not found on the server',
        appNotFound: 'The app was not found on this device',
        inputTextAscii: 'adb can only type ASCII characters',
      },
      app: {
        unknown: 'App session not found',
        disconnected: 'The app is not connected',
        notConnected: 'The app is not connected',
        timeout: 'The app did not reply in time',
        commandTimeout: 'The app did not reply in time',
        commandsUnsupported: 'This SDK version does not support commands',
        notInstalled: 'The app is not installed on this device',
      },
      server: { shutdown: 'The server is shutting down' },
      config: { invalid: 'Invalid setting value' },
      vm: {
        unavailable: 'The Dart VM Service module is not available',
        timeout: 'The Dart VM Service did not reply',
        noServiceUrl: 'No VM Service address found in the text',
        attachFailed: 'Could not attach to the Dart VM Service',
      },
      metrics: { unsupported: 'Process polling (CPU/memory) is not available for this device' },
      demo: {
        unavailable: 'The demo is not available',
        timeout: 'The demo did not reply in time',
        inactive: 'The demo is off',
        unsupportedAction: 'The demo device does not support this action',
        actionFailed: 'The demo action failed',
        stopped: 'The demo was turned off',
      },
      params: { invalid: 'Invalid value' },
      screenshot: { writeFailed: 'Could not save the screenshot' },
      sdk: { unavailable: 'The SDK connection is not available' },
      logs: {
        adbMissing: 'adb not found',
        deviceOffline: 'The device is offline; logs cannot be read',
        processExited: 'The log tool exited unexpectedly',
        idevicesyslogMissing: 'idevicesyslog not found',
        usbmuxdUnavailable: 'Cannot reach the usbmuxd service',
        simctlMissing: 'xcrun simctl not found (Xcode required)',
        networkOnly: 'SDK data only; this device’s logs are not read',
      },
    },
    fix: {
      device: {
        unauthorized: 'Unlock the device and accept the “Allow USB debugging?” prompt. Tick “Always allow from this computer” so it is not asked again.',
        untrusted: 'Unlock the iPhone, tap “Trust” when it asks “Trust This Computer?” and enter the device passcode.',
        notBooted: 'Boot the simulator from Xcode or with “xcrun simctl boot <udid>”.',
        offline: 'Unplug and reconnect the cable. If it persists run “adb kill-server && adb start-server”.',
        noPermissions: 'adb cannot access this device. Reconnect the cable and set the USB mode to “File transfer”.',
        authorizing: 'Wait a few seconds while the device confirms the connection.',
        simulatorShutdown: 'The simulator was shut down. Dürbün reconnects by itself when you boot it again.',
        driverStopped: 'The driver stopped. Check the tools in System check.',
        networkIdle: 'This device comes back to life when the app reconnects.',
        imported: 'This is a recording; only details and past data are shown.',
      },
      demo: { stopped: 'You can turn the demo data back on from the sidebar.' },
      logs: {
        adbMissing: 'Install Android SDK Platform-Tools (brew install --cask android-platform-tools).',
        idevicesyslogMissing: 'Install libimobiledevice: brew install libimobiledevice',
        usbmuxdUnavailable: 'Reconnect the iPhone; if it persists, restart the Mac.',
        simctlMissing: 'Install Xcode and its command line tools (xcode-select --install).',
        deviceOffline: 'The log stream restarts by itself when the device reconnects.',
        processExited: 'Try restarting the log stream.',
      },
    },
  },
});

/**
 * Localized text for a server code, or undefined when neither dictionary knows it. `preferOwn` picks this
 * view's short wording first (state headlines, where the fix hint is shown separately).
 */
export function codeText(code: string | undefined, params?: I18nParams, preferOwn = false): string | undefined {
  if (!code) return undefined;
  const own = () => (hasMessage(`device.codes.${code}`) ? tOr(`device.codes.${code}`, params, '') || undefined : undefined);
  const foundation = () => (hasMessage(`code.${code}`) ? tCode(code, params, '') || undefined : undefined);
  return preferOwn ? (own() ?? foundation()) : (foundation() ?? own());
}

/** Fix hint for a device state / log code (undefined when none). */
export function fixHint(code: string | undefined): string | undefined {
  if (!code || !hasMessage(`device.fix.${code}`)) return undefined;
  return t(`device.fix.${code}`);
}

/** Codes whose server message is more specific than any generic translation. */
const GENERIC = new Set(['action.failed', 'command.failed', 'demo.actionFailed', 'sdk.unavailable']);

export interface ErrorDescription {
  /** Main, localized text. */
  text: string;
  /** The server's (English) detail when it adds information. */
  detail?: string;
  code?: string;
}

/**
 * Localized description of a caught `CommandError` / `ApiError` / Error. Codes the foundation knows go through
 * `errorText` (app-wide wording, with the specific part of the server message folded in); the raw server
 * message is kept as `detail` only when the text does not already contain it.
 */
export function describeError(err: unknown): ErrorDescription {
  const e = (err && typeof err === 'object' ? err : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message.trim() : err === undefined || err === null ? '' : String(err);
  if (code && hasCode(code)) {
    const text = errorText({ code, message });
    if (text) {
      const specific = errorDetail(message);
      const detail = message && text !== message && !(specific && text.includes(specific)) ? message : undefined;
      return { text, detail, code };
    }
  }
  const localized = code && !GENERIC.has(code) ? codeText(code) : undefined;
  if (localized) return { text: localized, detail: message && message !== localized ? message : undefined, code };
  if (message) return { text: message, code };
  return { text: (code && codeText(code)) || t('device.common.unknownError'), code };
}

/** Localized device state headline (stateCode when known, else the generic state). */
export function stateText(d: Pick<DeviceInfo, 'state' | 'stateCode'>): string {
  return codeText(d.stateCode, undefined, true) ?? t(`code.state.${d.state}`);
}

/** Localized log stream status (logs.code when known, else the generic status). */
export function logStreamText(d: Pick<DeviceInfo, 'logs'>): string {
  return codeText(d.logs.code, undefined, true) ?? t(`code.logStatus.${d.logs.status}`);
}
