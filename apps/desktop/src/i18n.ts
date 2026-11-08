/** App menu / tray / dialog texts. Turkish when the system's first language is Turkish, else English. */
import os from 'node:os';

export type Lang = 'tr' | 'en';

export function pickLanguage(preferred: readonly string[]): Lang {
  const first = (preferred[0] ?? '').toLowerCase();
  return first === 'tr' || first.startsWith('tr-') || first.startsWith('tr_') ? 'tr' : 'en';
}

/** A notice parameter as text (numbers and strings only; anything else is left out). */
function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  return undefined;
}

/** " <value>" for a known parameter, "" otherwise. */
function spaced(value: unknown): string {
  const v = text(value);
  return v ? ` ${v}` : '';
}

/** Longest folder a tray line shows; the line around it stays within the tray's 120 characters. */
const MAX_SHOWN_PATH = 46;

/**
 * A folder short enough for one tray line, its end kept: the temp folder as $TMPDIR (macOS gives it as
 * /var/folders/<hash>/T, 50 characters before the folder name), the home folder as ~, and a path still
 * too long as "…" + its last characters.
 */
export function shortPath(p: string, roots: { tmp?: string; home?: string } = { tmp: os.tmpdir(), home: os.homedir() }): string {
  const strip = (r: string | undefined) => (r ?? '').replace(/\/+$/, '');
  const tmp = strip(roots.tmp);
  const home = strip(roots.home);
  const named: [string, string][] = [];
  if (tmp) named.push([tmp, '$TMPDIR'], [`/private${tmp}`, '$TMPDIR']);
  if (home) named.push([home, '~']);
  let shown = p;
  for (const [root, name] of named) {
    if (p === root || p.startsWith(`${root}/`)) {
      shown = name + p.slice(root.length);
      break;
    }
  }
  return shown.length > MAX_SHOWN_PATH ? '…' + shown.slice(-(MAX_SHOWN_PATH - 1)) : shown;
}

/** " <folder>" (shortPath) for a folder parameter, "" otherwise. */
function spacedPath(value: unknown): string {
  return typeof value === 'string' && value.trim() ? ` ${shortPath(value.trim())}` : '';
}

/** A setting name from settings.json for a tray line (a key the user typed: no control characters, ≤ 40). */
function keyName(raw: string): string {
  const k = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return k.length > 40 ? `${k.slice(0, 39)}…` : k;
}

/** Why a value was refused (the English reasons of packages/server/src/config.ts validateField). */
type SettingRule = 'number' | 'boolean' | 'oneOf' | 'list' | 'strings' | 'path' | 'badPath' | 'other';

/**
 * What a settings.json `config.invalid` notice reports, from its English `detail` (packages/server/src/
 * config.ts normalizeSettings and loadConfig): a refused value (its default is used), a value moved into its
 * allowed range, the cleaned-up watchedApps list, a key this version does not know, or a file that is not a
 * JSON object (all defaults). Undefined for anything else: the tray then shows the server's own line.
 */
export type SettingsIssue =
  | { kind: 'default'; key: string; rule: SettingRule; values?: string }
  | { kind: 'clamped'; key: string; from: string; to: string; min: string; max: string }
  | { kind: 'normalized'; key: string }
  | { kind: 'unknown'; key: string }
  | { kind: 'notObject' };

export function settingsIssue(detail: unknown): SettingsIssue | undefined {
  if (typeof detail !== 'string') return undefined;
  const d = detail.trim();
  if (/^expected an object\b/.test(d)) return { kind: 'notObject' };
  let m = /^unknown setting "(.+)" ignored$/s.exec(d);
  if (m) return { kind: 'unknown', key: keyName(m[1]!) };
  m = /^(\w+) (\S+) → (\S+) \(allowed (\S+)–(\S+)\)$/.exec(d);
  if (m) return { kind: 'clamped', key: m[1]!, from: m[2]!, to: m[3]!, min: m[4]!, max: m[5]! };
  m = /^(\w+) normalized\b/.exec(d);
  if (m) return { kind: 'normalized', key: m[1]! };
  m = /^(\w+) ((?:must|is not) .+?) — using the default$/.exec(d);
  if (!m) return undefined;
  const [, key, reason] = m as unknown as [string, string, string];
  if (reason === 'must be an object') return { kind: 'notObject' };
  const oneOf = /^must be one of (.+)$/.exec(reason);
  if (oneOf) return { kind: 'default', key, rule: 'oneOf', values: oneOf[1]!.slice(0, 40) };
  const rules: Record<string, SettingRule> = {
    'must be a number': 'number',
    'must be true or false': 'boolean',
    'must be a list of app ids': 'list',
    'must contain only strings': 'strings',
    'must be a file path': 'path',
    'is not a valid path': 'badPath',
  };
  return { kind: 'default', key, rule: rules[reason] ?? 'other' };
}

/** A settings.json notice in one language; another file or an unknown detail keeps the server's line. */
function settingsNotice(file: string | undefined, detail: unknown, line: (s: SettingsIssue) => string): string | undefined {
  const issue = file === 'settings.json' ? settingsIssue(detail) : undefined;
  return issue ? line(issue) : undefined;
}

function settingsLineTr(s: SettingsIssue): string {
  switch (s.kind) {
    case 'notObject':
      return 'settings.json bir JSON nesnesi değil; tüm ayarlar varsayılan değerinde.';
    case 'unknown':
      return `settings.json: tanınmayan «${s.key}» ayarı yok sayıldı.`;
    case 'clamped':
      return `settings.json: «${s.key}» için ${s.from} yerine ${s.to} kullanılıyor (izin verilen ${s.min}–${s.max}).`;
    case 'normalized':
      return `settings.json: «${s.key}» listesi düzenlendi (boşluklar ve tekrarlar temizlendi).`;
    case 'default': {
      const why = {
        number: 'bir sayı olmalı',
        boolean: 'true ya da false olmalı',
        oneOf: `şunlardan biri olmalı: ${s.values}`,
        list: 'uygulama kimliklerinden oluşan bir liste olmalı',
        strings: 'listesinde yalnızca metin olmalı',
        path: 'bir dosya yolu olmalı',
        badPath: 'geçerli bir dosya yolu değil',
        other: 'geçersiz',
      }[s.rule];
      return `settings.json: «${s.key}» ${why}; varsayılan değeri kullanılıyor.`;
    }
  }
}

function settingsLineEn(s: SettingsIssue): string {
  switch (s.kind) {
    case 'notObject':
      return 'settings.json is not a JSON object; all settings use their defaults.';
    case 'unknown':
      return `settings.json: unknown setting "${s.key}" ignored.`;
    case 'clamped':
      return `settings.json: "${s.key}" is ${s.to} instead of ${s.from} (allowed ${s.min}–${s.max}).`;
    case 'normalized':
      return `settings.json: the "${s.key}" list was cleaned up (trimmed, duplicates removed).`;
    case 'default': {
      const why = {
        number: 'must be a number',
        boolean: 'must be true or false',
        oneOf: `must be one of ${s.values}`,
        list: 'must be a list of app ids',
        strings: 'may contain only text',
        path: 'must be a file path',
        badPath: 'is not a valid file path',
        other: 'is invalid',
      }[s.rule];
      return `settings.json: "${s.key}" ${why}; its default value is used.`;
    }
  }
}

export interface Strings {
  appName: string;
  about: string;
  services: string;
  hide: string;
  hideOthers: string;
  showAll: string;
  quit: string;
  trayQuit: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  view: string;
  reload: string;
  forceReload: string;
  devTools: string;
  actualSize: string;
  zoomIn: string;
  zoomOut: string;
  fullScreen: string;
  window: string;
  minimize: string;
  zoom: string;
  close: string;
  front: string;
  help: string;
  openInBrowser: string;
  openDataDir: string;
  showLog: string;
  show: string;
  serverStarting: string;
  serverRunning(port: number): string;
  serverAttached(port: number): string;
  serverFailed: string;
  warnings(n: number): string;
  splash: string;
  startFailedTitle: string;
  startFailedMessage: string;
  missingBundle(paths: string): string;
  retry: string;
  portFallbackNotice(wanted: number, used: number): string;
  attachedVersionNotice(other: string, mine: string): string;
  attachedPlaceholderNotice(port: number): string;
  /** A server notice in this language (StartedServer.notices); undefined → the server's own message. */
  serverNotice(code: string, params: Readonly<Record<string, unknown>>): string | undefined;
  shellEnvNotice(shell: string, timeoutS?: number): string;
  uiCrashedTitle: string;
  uiCrashedMessage(reason: string): string;
  notificationsUnavailable: string;
  settings: string;
  docs: string;
  reportIssue: string;
  checkUpdates: string;
  licenses: string;
  updateAvailableTitle(version: string): string;
  updateAvailableMessage(current: string): string;
  download: string;
  later: string;
  upToDateTitle: string;
  upToDateMessage(version: string): string;
  noReleaseMessage: string;
  updateCheckFailedTitle: string;
  updateCheckFailedMessage(error: string): string;
  unresponsiveTitle: string;
  unresponsiveMessage: string;
  wait: string;
  uiLoadRetrying: string;
}

const tr: Strings = {
  appName: 'Dürbün',
  about: 'Dürbün Hakkında',
  services: 'Hizmetler',
  hide: "Dürbün'ü Gizle",
  hideOthers: 'Diğerlerini Gizle',
  showAll: 'Tümünü Göster',
  quit: "Dürbün'den Çık",
  trayQuit: 'Çık',
  edit: 'Düzen',
  undo: 'Geri Al',
  redo: 'Yinele',
  cut: 'Kes',
  copy: 'Kopyala',
  paste: 'Yapıştır',
  selectAll: 'Tümünü Seç',
  view: 'Görünüm',
  reload: 'Yeniden Yükle',
  forceReload: 'Zorla Yeniden Yükle',
  devTools: 'Geliştirici Araçları',
  actualSize: 'Gerçek Boyut',
  zoomIn: 'Yakınlaştır',
  zoomOut: 'Uzaklaştır',
  fullScreen: 'Tam Ekran',
  window: 'Pencere',
  minimize: 'Küçült',
  zoom: 'Büyüt/Küçült',
  close: 'Pencereyi Kapat',
  front: 'Tümünü Öne Getir',
  help: 'Yardım',
  openInBrowser: 'Tarayıcıda Aç',
  openDataDir: 'Veri Klasörünü Aç (~/.durbun)',
  showLog: 'Tanılama Günlüğünü Göster',
  show: "Dürbün'ü göster",
  serverStarting: 'Sunucu: başlatılıyor…',
  serverRunning: (port) => `Sunucu: çalışıyor · ${port}`,
  serverAttached: (port) => `Sunucu: başka bir Dürbün · ${port}`,
  serverFailed: 'Sunucu: başlatılamadı',
  warnings: (n) => `Uyarılar (${n})`,
  splash: 'Dürbün başlatılıyor…',
  startFailedTitle: 'Dürbün başlatılamadı',
  startFailedMessage: 'Sunucu başlatılamadı. Ayrıntılar aşağıda; tanılama günlüğü daha fazlasını gösterir.',
  missingBundle: (paths) => `Sunucu paketi bulunamadı:\n${paths}\n\nGeliştirme ortamında önce "npm run build" çalıştırın.`,
  retry: 'Tekrar Dene',
  portFallbackNotice: (wanted, used) => `${wanted} portu başka bir program tarafından kullanılıyor; Dürbün ${used} portunda çalışıyor.`,
  attachedVersionNotice: (other, mine) => `Pencerede başka bir Dürbün (sürüm ${other}) açık; bu uygulama ${mine}. O kapanınca uygulama kendi sunucusunu başlatır.`,
  attachedPlaceholderNotice: (port) => `Penceredeki Dürbün'ün (port ${port}) arayüzü derlenmemiş. O kapanınca uygulama kendi arayüzünü açar.`,
  serverNotice: (code, p) => {
    const file = text(p.file);
    const mocks = file === 'mocks.json';
    switch (code) {
      case 'sdk.portBusy':
        return `SDK portu${spaced(p.port)} kullanımda: simülatör ve Wi-Fi bağlantıları kurulamaz; USB'deki Android cihazlar etkilenmez.`;
      case 'sdk.listenFailed':
        return `SDK portu${spaced(p.port)} açılamadı: simülatör ve Wi-Fi bağlantıları kurulamaz; ayrıntı tanılama günlüğünde.`;
      case 'ui.missing':
        return 'Arayüz dosyaları bulunamadı, pencerede yalnızca bilgi sayfası var; uygulamayı yeniden kurun.';
      case 'ui.dirInvalid':
        return `Belirtilen arayüz klasöründe index.html yok; ${text(p.fallback) ? 'başka bir arayüz derlemesi kullanılıyor' : 'yalnızca bilgi sayfası gösteriliyor'}.`;
      case 'config.invalid':
        if (mocks) return 'mocks.json içinde geçersiz bir mock kuralı var; o kural atlandı (ayrıntı günlükte).';
        return settingsNotice(file, p.detail, settingsLineTr);
      case 'config.unreadable':
        return mocks
          ? `mocks.json okunamadı; Dürbün mock kuralları olmadan başladı${text(p.backup) ? ' (dosyanın bir kopyası saklandı)' : ''}.`
          : `${file ?? 'Ayar dosyası'} okunamadı; varsayılan ayarlar kullanılıyor${text(p.backup) ? ' (dosyanın bir kopyası saklandı)' : ''}.`;
      case 'config.dataDirFallback':
        return `Veri klasörüne yazılamıyor; Dürbün bu oturumda şu klasörü kullanıyor:${spacedPath(p.fallback)}`;
      case 'config.tempDirFallback':
        return `Geçici dosyalar için klasör oluşturulamadı; şu klasör kullanılıyor:${spacedPath(p.dir)}`;
      case 'sdk.unavailable':
        return 'Uygulama SDK bağlantıları kullanılamıyor; ayrıntı tanılama günlüğünde.';
      case 'drivers.unavailable':
        return 'Cihaz sürücüleri başlatılamadı, cihazlar görünmeyecek; ayrıntı tanılama günlüğünde.';
      case 'vm.unavailable':
        return 'Flutter VM Service üzerinden yakalama çalışmıyor; ayrıntı tanılama günlüğünde.';
      case 'demo.unavailable':
      case 'demo.startFailed':
        return 'Demo modu başlatılamadı; ayrıntı tanılama günlüğünde.';
      default:
        return undefined;
    }
  },
  shellEnvNotice: (shell, timeoutS) =>
    timeoutS
      ? `Giriş kabuğu (${shell}) ${timeoutS} saniyede yanıt vermedi; adb ve flutter gibi araçlar yalnızca bilinen klasörlerde aranıyor.`
      : `Giriş kabuğundan (${shell}) ortam bilgisi alınamadı; adb ve flutter gibi araçlar yalnızca bilinen klasörlerde aranıyor.`,
  uiCrashedTitle: 'Arayüz art arda kapandı',
  uiCrashedMessage: (reason) => `Pencerenin içeriği kısa sürede birkaç kez beklenmedik şekilde kapandı (${reason}). Sunucu çalışmaya ve yakalamaya devam ediyor.`,
  notificationsUnavailable: 'macOS bildirimleri bu (imzasız) sürümde gösterilemedi; bunun yerine Dock simgesi işaretlenir.',
  settings: 'Ayarlar…',
  docs: 'Dürbün Belgeleri',
  reportIssue: 'Sorun Bildir…',
  checkUpdates: 'Güncellemeleri Denetle…',
  licenses: 'Lisanslar',
  updateAvailableTitle: (version) => `Dürbün ${version} yayında`,
  updateAvailableMessage: (current) => `Kullandığınız sürüm ${current}. Yeni sürüm tarayıcıda açılan sayfadan indirilir.`,
  download: 'İndirme Sayfasını Aç',
  later: 'Sonra',
  upToDateTitle: 'Dürbün güncel',
  upToDateMessage: (version) => `${version} en son sürüm.`,
  noReleaseMessage: 'Henüz yayınlanmış bir sürüm yok.',
  updateCheckFailedTitle: 'Güncellemeler denetlenemedi',
  updateCheckFailedMessage: (error) => `GitHub'a ulaşılamadı (${error}). İnternet bağlantınızı kontrol edip yeniden deneyin.`,
  unresponsiveTitle: 'Dürbün penceresi yanıt vermiyor',
  unresponsiveMessage: 'Sunucu çalışmaya ve yakalamaya devam ediyor. Bekleyebilir ya da pencereyi yeniden yükleyebilirsiniz; yeniden yüklemede donmaya yol açmış olabilecek kayıtlı arama sıfırlanır.',
  wait: 'Bekle',
  uiLoadRetrying: 'Arayüz yüklenemedi, yeniden deneniyor…',
};

const en: Strings = {
  appName: 'Dürbün',
  about: 'About Dürbün',
  services: 'Services',
  hide: 'Hide Dürbün',
  hideOthers: 'Hide Others',
  showAll: 'Show All',
  quit: 'Quit Dürbün',
  trayQuit: 'Quit',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  view: 'View',
  reload: 'Reload',
  forceReload: 'Force Reload',
  devTools: 'Developer Tools',
  actualSize: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  fullScreen: 'Full Screen',
  window: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
  close: 'Close Window',
  front: 'Bring All to Front',
  help: 'Help',
  openInBrowser: 'Open in Browser',
  openDataDir: 'Open Data Folder (~/.durbun)',
  showLog: 'Show Diagnostic Log',
  show: 'Show Dürbün',
  serverStarting: 'Server: starting…',
  serverRunning: (port) => `Server: running · ${port}`,
  serverAttached: (port) => `Server: another Dürbün · ${port}`,
  serverFailed: 'Server: could not start',
  warnings: (n) => `Warnings (${n})`,
  splash: 'Starting Dürbün…',
  startFailedTitle: 'Dürbün could not start',
  startFailedMessage: 'The server could not start. Details below; the diagnostic log has more.',
  missingBundle: (paths) => `The server bundle was not found:\n${paths}\n\nIn a development checkout run "npm run build" first.`,
  retry: 'Try Again',
  portFallbackNotice: (wanted, used) => `Port ${wanted} is used by another program; Dürbün runs on port ${used}.`,
  attachedVersionNotice: (other, mine) => `The window shows another Dürbün (version ${other}); this app is ${mine}. When it stops, the app starts its own server.`,
  attachedPlaceholderNotice: (port) => `The Dürbün in the window (port ${port}) has no UI build. When it stops, the app opens its own UI.`,
  serverNotice: (code, p) => {
    const file = text(p.file);
    const mocks = file === 'mocks.json';
    switch (code) {
      case 'sdk.portBusy':
        return `SDK port${spaced(p.port)} is in use: simulator and Wi-Fi connections cannot be made; Android devices on USB are not affected.`;
      case 'sdk.listenFailed':
        return `SDK port${spaced(p.port)} could not be opened: simulator and Wi-Fi connections cannot be made; details in the diagnostic log.`;
      case 'ui.missing':
        return 'The UI files were not found, so the window shows an info page only; reinstall the app.';
      case 'ui.dirInvalid':
        return `The UI folder has no index.html; ${text(p.fallback) ? 'another UI build is used instead' : 'only an info page is shown'}.`;
      case 'config.invalid':
        if (mocks) return 'mocks.json has an invalid mock rule; that rule is skipped (details in the log).';
        return settingsNotice(file, p.detail, settingsLineEn);
      case 'config.unreadable':
        return mocks
          ? `mocks.json could not be read; Dürbün started without mock rules${text(p.backup) ? ' (a copy of the file was kept)' : ''}.`
          : `${file ?? 'The settings file'} could not be read; defaults are used${text(p.backup) ? ' (a copy of the file was kept)' : ''}.`;
      case 'config.dataDirFallback':
        return `The data folder is not writable; for this session Dürbün uses:${spacedPath(p.fallback)}`;
      case 'config.tempDirFallback':
        return `The folder for temporary files could not be created; using:${spacedPath(p.dir)}`;
      case 'sdk.unavailable':
        return 'App SDK connections are unavailable; details in the diagnostic log.';
      case 'drivers.unavailable':
        return 'The device drivers could not start, so no devices will show up; details in the diagnostic log.';
      case 'vm.unavailable':
        return 'Flutter VM Service capture is unavailable; details in the diagnostic log.';
      case 'demo.unavailable':
      case 'demo.startFailed':
        return 'Demo mode could not start; details in the diagnostic log.';
      default:
        return undefined;
    }
  },
  shellEnvNotice: (shell, timeoutS) =>
    timeoutS
      ? `Login shell (${shell}) did not answer within ${timeoutS} s; adb, flutter and other tools are searched in well-known folders only.`
      : `Login shell (${shell}) did not report its environment; adb, flutter and other tools are searched in well-known folders only.`,
  uiCrashedTitle: 'The window content keeps crashing',
  uiCrashedMessage: (reason) => `The window content closed unexpectedly several times in a short while (${reason}). The server keeps running and capturing.`,
  notificationsUnavailable: 'macOS notifications could not be shown by this (unsigned) build; the Dock icon is marked instead.',
  settings: 'Settings…',
  docs: 'Dürbün Documentation',
  reportIssue: 'Report an Issue…',
  checkUpdates: 'Check for Updates…',
  licenses: 'Licenses',
  updateAvailableTitle: (version) => `Dürbün ${version} is available`,
  updateAvailableMessage: (current) => `You are using ${current}. The new version downloads from the page that opens in your browser.`,
  download: 'Open Download Page',
  later: 'Later',
  upToDateTitle: 'Dürbün is up to date',
  upToDateMessage: (version) => `${version} is the latest version.`,
  noReleaseMessage: 'No version has been published yet.',
  updateCheckFailedTitle: 'Could not check for updates',
  updateCheckFailedMessage: (error) => `GitHub could not be reached (${error}). Check your internet connection and try again.`,
  unresponsiveTitle: 'The Dürbün window is not responding',
  unresponsiveMessage: 'The server keeps running and capturing. You can wait or reload the window; a reload resets the saved search that may have caused the hang.',
  wait: 'Wait',
  uiLoadRetrying: 'The UI could not be loaded; retrying…',
};

export const STRINGS: Record<Lang, Strings> = { tr, en };
