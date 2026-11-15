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
  newWindow: string;
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
  checkUpdatesAuto: string;
  checkingUpdates: string;
  updateDownloadingMenu(version: string): string;
  updateReadyMenu: string;
  updateAvailableTitle(version: string): string;
  updateInstallMessage(current: string, size?: string): string;
  updateManualMessage(current: string, reason: string, arch: string): string;
  updateManualReason(reason: 'development' | 'unsigned' | 'location'): string;
  whatsNew: string;
  downloadAndInstall: string;
  downloadDiskImage: string;
  readWhatsNew: string;
  skipVersion: string;
  later: string;
  ok: string;
  cancel: string;
  closeDialog: string;
  openReleases: string;
  upToDateTitle: string;
  upToDateMessage(version: string): string;
  updateNoFeedMessage: string;
  updateCheckFailedTitle: string;
  updateCheckFailedMessage(error: string): string;
  updateDownloadingTitle(version: string): string;
  updateDownloadingMessage: string;
  updateReadyTitle(version: string): string;
  updateReadyMessage: string;
  restartNow: string;
  updateFailedTitle: string;
  updateFailedMessage(error: string, arch: string): string;
  autoCheckTitle: string;
  autoCheckMessage: string;
  autoCheckYes: string;
  autoCheckNo: string;
  file: string;
  openFile: string;
  openFileMessage: string;
  openFailedTitle: string;
  openFailedMessage(name: string, problem: 'tooLarge' | 'unreadable' | 'unsupported'): string;
  copyDiagnostics: string;
  diagnosticsCopiedTitle: string;
  diagnosticsCopiedMessage: string;
  reportIssueTitle: string;
  reportIssueMessage: string;
  openForm: string;
  aboutCredits(versions: string): string;
  closeNoteTitle: string;
  closeNoteMessage(lan: boolean): string;
  openAtLogin: string;
  loginApprovalTitle: string;
  loginApprovalMessage: string;
  moveTitle: string;
  moveMessage(where: string): string;
  moveWhere(kind: 'diskImage' | 'translocated' | 'folder', folder?: string): string;
  moveNow: string;
  notNow: string;
  doNotAskAgain: string;
  moveReplaceTitle: string;
  moveReplaceMessage: string;
  replace: string;
  moveFailedTitle: string;
  moveFailedMessage(error: string): string;
  verboseLog: string;
  verboseRestartTitle(on: boolean): string;
  verboseRestartMessage: string;
  summaryLine(devices: number, apps: number): string;
  /** The start failed: another Dürbün holds the data folder (port: it listens there but did not answer). */
  dataDirInUse(dir: string, port?: number): string;
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
  newWindow: 'Yeni Pencere',
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
  docs: 'Dürbün Kılavuzları',
  reportIssue: 'Sorun Bildir…',
  checkUpdates: 'Güncellemeleri Denetle…',
  licenses: 'Lisanslar',
  checkUpdatesAuto: 'Güncellemeleri Otomatik Denetle',
  checkingUpdates: 'Güncellemeler Denetleniyor…',
  updateDownloadingMenu: (version) => `Dürbün ${version} İndiriliyor…`,
  updateReadyMenu: 'Güncellemeyi Kurmak İçin Yeniden Başlat…',
  updateAvailableTitle: (version) => `Dürbün ${version} yayında`,
  updateInstallMessage: (current, size) =>
    `Kullandığınız sürüm ${current}. Yeni sürüm şimdi indirilip kurulsun mu? Dürbün onu${size ? ` (${size})` : ''} arka planda indirir ve yeniden başlamadan önce size sorar.`,
  updateManualMessage: (current, reason, arch) =>
    `Kullandığınız sürüm ${current}. ${reason} Bu Mac için disk görüntüsü (${arch}) tarayıcınızda iner: açın, Dürbün'den çıkın ve yeni Dürbün'ü Uygulamalar klasörüne sürükleyin.`,
  updateManualReason: (reason) =>
    ({
      development: 'Bu bir geliştirme derlemesi; kendini güncelleyemez.',
      unsigned: 'Bu kopya Developer ID ile imzalı değil (yerel bir derleme); kendi yerine yenisini kuramaz.',
      location: 'Bu kopya disk görüntüsünden ya da yazamadığı bir klasörden çalışıyor; kendi yerine yenisini kuramaz.',
    })[reason],
  whatsNew: 'Yenilikler:',
  downloadAndInstall: 'İndir ve Kur',
  downloadDiskImage: 'Disk Görüntüsünü İndir',
  readWhatsNew: 'Yenilikleri Oku',
  skipVersion: 'Bu Sürümü Atla',
  later: 'Sonra',
  ok: 'Tamam',
  cancel: 'Vazgeç',
  closeDialog: 'Kapat',
  openReleases: 'Sürümler Sayfasını Aç',
  upToDateTitle: 'Dürbün güncel',
  upToDateMessage: (version) => `${version} en son sürüm.`,
  updateNoFeedMessage: 'Son sürümde bu Mac için güncelleme bilgisi yok. Tüm indirmeler sürümler sayfasında.',
  updateCheckFailedTitle: 'Güncellemeler denetlenemedi',
  updateCheckFailedMessage: (error) => `GitHub'daki güncelleme bilgisi okunamadı (${error}). İnternet bağlantınızı kontrol edip yeniden deneyin ya da sürümler sayfasına bakın.`,
  updateDownloadingTitle: (version) => `Dürbün ${version} indiriliyor`,
  updateDownloadingMessage: 'Bu sırada Dürbün çalışmaya devam eder; indirme bitince yeniden başlamadan önce size sorar.',
  updateReadyTitle: (version) => `Dürbün ${version} kurulmaya hazır`,
  updateReadyMessage:
    'Bitirmek için şimdi yeniden başlatılsın mı? Dürbün yeniden başlarken yakalama birkaç saniye durur; bağlı uygulamalar kendiliğinden yeniden bağlanır. Sonra derseniz yeni sürüm Dürbün bir sonraki açılışında kurulur.',
  restartNow: 'Şimdi Yeniden Başlat',
  updateFailedTitle: 'Güncelleme kurulamadı',
  updateFailedMessage: (error, arch) =>
    `Dürbün şu anki sürümle çalışmaya devam ediyor. Bunun yerine bu Mac için disk görüntüsünü (${arch}) indirip yeni Dürbün'ü Uygulamalar klasörüne sürükleyebilirsiniz.\n\nAyrıntı: ${error}`,
  autoCheckTitle: 'Güncellemeler otomatik denetlensin mi?',
  autoCheckMessage:
    "Dürbün günde bir kez GitHub'daki sürümler sayfasından tek bir dosya (son sürümün numarası ve notları) okuyarak yeni sürüm olup olmadığına bakabilir. Bu istek hiçbir kimlik bilgisi taşımaz; sizinle, Mac'inizle ya da uygulamalarınızla ilgili hiçbir şey gönderilmez. Yeni sürümü indirmek ve kurmak her zaman onayınızı bekler.\n\nBu seçimi istediğiniz zaman Dürbün → Güncellemeleri Otomatik Denetle menüsünden değiştirebilirsiniz.",
  autoCheckYes: 'Otomatik Denetle',
  autoCheckNo: 'Denetleme',
  file: 'Dosya',
  openFile: 'Aç…',
  openFileMessage: 'Bir Dürbün paketi, yedeği, oturum kaydı ya da HAR dosyası seçin',
  openFailedTitle: 'Dosya açılamadı',
  openFailedMessage: (name, problem) =>
    ({
      tooLarge: `${name} 500 MB'tan büyük; Dürbün en fazla 500 MB içe aktarır.`,
      unreadable: `${name} okunamadı. Dosyanın yerinde olduğunu ve Dürbün'ün okuyabildiğini kontrol edin.`,
      unsupported: `${name} bir Dürbün dosyası değil. Dürbün .durbun paketlerini ve yedeklerini, .durbun.json oturum kayıtlarını ve .har dosyalarını açar.`,
    })[problem],
  copyDiagnostics: 'Tanılama Bilgisini Kopyala',
  diagnosticsCopiedTitle: 'Tanılama bilgisi kopyalandı',
  diagnosticsCopiedMessage:
    'Sürümler, macOS, portlar, araç denetimi ve son 200 günlük satırı panoda; token, çerez ve URL sorgu değerleri maskelendi. Raporunuza yapıştırın ve göndermeden önce gözden geçirin.',
  reportIssueTitle: 'Hata bildirim formu tarayıcınızda açılacak',
  reportIssueMessage:
    'Sürüm ve ortam bilgisi formda hazır. Tanılama bilgisi (araç denetimi ve son 200 günlük satırı; gizli değerler maskelendi) panoda: formdaki Logs alanına yapıştırın ve göndermeden önce gözden geçirin.',
  openForm: 'Formu Aç',
  aboutCredits: (versions) => `Android ve iOS için canlı log, ağ ve performans izleyici\n${versions}`,
  closeNoteTitle: 'Dürbün menü çubuğunda çalışmaya devam ediyor',
  closeNoteMessage: (lan) =>
    `Pencereyi kapatmak yakalamayı durdurmaz: cihazlar ve uygulamalar bağlı kalır.${lan ? ' LAN açık olduğu için SDK portuna yerel ağınızdan erişilebilir.' : ''} Pencereyi menü çubuğundaki dürbün simgesinden ya da Dock'tan yeniden açabilirsiniz. Dürbün'ü durdurmak için Dürbün'den Çık'ı (⌘Q) seçin.`,
  openAtLogin: 'Girişte Aç',
  loginApprovalTitle: "Dürbün'ün girişte açılmasına izin verin",
  loginApprovalMessage: 'macOS bunun için Sistem Ayarları → Genel → Giriş Öğeleri bölümünde onayınızı istiyor.',
  moveTitle: 'Dürbün, Uygulamalar klasörüne taşınsın mı?',
  moveMessage: (where) =>
    `Dürbün şu anda ${where} çalışıyor. Uygulamalar klasöründe disk görüntüsü çıkarıldıktan sonra da çalışır, girişte açılabilir ve kendini güncelleyebilir. Taşındıktan sonra Dürbün yeniden başlar.`,
  moveWhere: (kind, folder) =>
    kind === 'diskImage' ? 'disk görüntüsünden' : kind === 'translocated' ? "macOS'in oluşturduğu geçici bir kopyadan (App Translocation)" : `${folder ?? 'başka bir'} klasöründen`,
  moveNow: 'Uygulamalar Klasörüne Taşı',
  notNow: 'Şimdi Değil',
  doNotAskAgain: 'Bir daha sorma',
  moveReplaceTitle: 'Uygulamalar klasöründe başka bir Dürbün var',
  moveReplaceMessage: "Bu kopyayla değiştirilsin mi? Diğer kopya Çöp Sepeti'ne taşınır.",
  replace: 'Değiştir',
  moveFailedTitle: 'Dürbün taşınamadı',
  moveFailedMessage: (error) => `${error}\n\nDürbün'ü Uygulamalar klasörüne kendiniz sürükleyebilirsiniz.`,
  verboseLog: 'Ayrıntılı Tanılama Günlüğü',
  verboseRestartTitle: (on) => (on ? 'Ayrıntılı günlük, Dürbün yeniden başlayınca açılır' : 'Ayrıntılı günlük, Dürbün yeniden başlayınca kapanır'),
  verboseRestartMessage: 'Dürbün şimdi yeniden başlatılsın mı? Yakalama birkaç saniye durur; bağlı uygulamalar kendiliğinden yeniden bağlanır.',
  summaryLine: (devices, apps) => `${devices} cihaz · ${apps} uygulama`,
  dataDirInUse: (dir, port) =>
    `${port ? `Başka bir Dürbün (port ${port}) ${dir} veri klasörünü kullanıyor, ama yanıt vermediği için penceresi açılamadı.` : `Başka bir Dürbün ${dir} veri klasörüyle başlatılıyor.`} Diğer Dürbün'den çıkın (durbun çalıştıran bir terminal ya da uygulamanın başka bir kopyası), sonra Tekrar Dene'yi seçin. İkisini birlikte çalıştırmak için birine kendi veri klasörünü verin (DURBUN_DATA_DIR).`,
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
  newWindow: 'New Window',
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
  docs: 'Dürbün Guides',
  reportIssue: 'Report an Issue…',
  checkUpdates: 'Check for Updates…',
  licenses: 'Licenses',
  checkUpdatesAuto: 'Check for Updates Automatically',
  checkingUpdates: 'Checking for Updates…',
  updateDownloadingMenu: (version) => `Downloading Dürbün ${version}…`,
  updateReadyMenu: 'Restart to Install the Update…',
  updateAvailableTitle: (version) => `Dürbün ${version} is available`,
  updateInstallMessage: (current, size) =>
    `You are using ${current}. Download and install the new version now? Dürbün downloads it${size ? ` (${size})` : ''} in the background and asks before it restarts.`,
  updateManualMessage: (current, reason, arch) =>
    `You are using ${current}. ${reason} The disk image for this Mac (${arch}) downloads in your browser: open it, quit Dürbün and drag the new Dürbün to Applications.`,
  updateManualReason: (reason) =>
    ({
      development: 'This is a development build, so it cannot update itself.',
      unsigned: 'This copy has no Developer ID signature (a local build), so it cannot replace itself.',
      location: 'This copy runs from the disk image or from a folder it cannot write to, so it cannot replace itself.',
    })[reason],
  whatsNew: "What's new:",
  downloadAndInstall: 'Download and Install',
  downloadDiskImage: 'Download Disk Image',
  readWhatsNew: "Read What's New",
  skipVersion: 'Skip This Version',
  later: 'Later',
  ok: 'OK',
  cancel: 'Cancel',
  closeDialog: 'Close',
  openReleases: 'Open Releases Page',
  upToDateTitle: 'Dürbün is up to date',
  upToDateMessage: (version) => `${version} is the latest version.`,
  updateNoFeedMessage: 'The latest release has no update information for this Mac. The releases page lists every download.',
  updateCheckFailedTitle: 'Could not check for updates',
  updateCheckFailedMessage: (error) => `The update information on GitHub could not be read (${error}). Check your internet connection and try again, or look at the releases page.`,
  updateDownloadingTitle: (version) => `Dürbün ${version} is downloading`,
  updateDownloadingMessage: 'Dürbün keeps working meanwhile and asks before it restarts once the download is done.',
  updateReadyTitle: (version) => `Dürbün ${version} is ready to install`,
  updateReadyMessage:
    'Restart now to finish? Capture stops for a few seconds while Dürbün restarts; connected apps reconnect on their own. If you choose Later, the new version is installed the next time Dürbün starts.',
  restartNow: 'Restart Now',
  updateFailedTitle: 'The update could not be installed',
  updateFailedMessage: (error, arch) =>
    `Dürbün keeps running the current version. You can download the disk image for this Mac (${arch}) instead and drag the new Dürbün to Applications.\n\nDetails: ${error}`,
  autoCheckTitle: 'Check for updates automatically?',
  autoCheckMessage:
    "Once a day Dürbün can read one file from the project's GitHub releases page (the latest version number and its notes) to see whether a new version is out. The request carries no identifier, and nothing about you, your Mac or your apps is sent. Downloading and installing a new version always waits for your yes.\n\nYou can change this any time with Dürbün → Check for Updates Automatically.",
  autoCheckYes: 'Check Automatically',
  autoCheckNo: "Don't Check",
  file: 'File',
  openFile: 'Open…',
  openFileMessage: 'Choose a Dürbün package, backup, session recording or HAR file',
  openFailedTitle: 'The file could not be opened',
  openFailedMessage: (name, problem) =>
    ({
      tooLarge: `${name} is larger than 500 MB, the most Dürbün imports.`,
      unreadable: `${name} could not be read. Check that the file is still there and that Dürbün may read it.`,
      unsupported: `${name} is not a Dürbün file. Dürbün opens .durbun packages and backups, .durbun.json session recordings and .har files.`,
    })[problem],
  copyDiagnostics: 'Copy Diagnostic Info',
  diagnosticsCopiedTitle: 'Diagnostic info copied',
  diagnosticsCopiedMessage:
    'Versions, macOS, ports, the tool check and the last 200 log lines are on the clipboard; tokens, cookies and URL query values are masked. Paste it into your report and look it over before you send it.',
  reportIssueTitle: 'The bug report form opens in your browser',
  reportIssueMessage:
    'The version and environment are filled in. Diagnostic info (the tool check and the last 200 log lines, secrets masked) is on the clipboard: paste it into the Logs field and look it over before you submit.',
  openForm: 'Open Form',
  aboutCredits: (versions) => `Live logs, network and performance inspector for Android and iOS\n${versions}`,
  closeNoteTitle: 'Dürbün keeps running in the menu bar',
  closeNoteMessage: (lan) =>
    `Closing the window does not stop capture: devices and apps stay connected.${lan ? ' LAN is on, so the SDK port stays reachable from your local network.' : ''} Open the window again from the binoculars icon in the menu bar or from the Dock. To stop Dürbün, choose Quit Dürbün (⌘Q).`,
  openAtLogin: 'Open at Login',
  loginApprovalTitle: 'Allow Dürbün to open at login',
  loginApprovalMessage: 'macOS asks you to approve it in System Settings → General → Login Items.',
  moveTitle: 'Move Dürbün to the Applications folder?',
  moveMessage: (where) =>
    `Dürbün is running ${where}. In Applications it keeps working after the disk image is ejected, can open at login and can update itself. Dürbün restarts after the move.`,
  moveWhere: (kind, folder) =>
    kind === 'diskImage' ? 'from the disk image' : kind === 'translocated' ? 'from a temporary copy macOS made (App Translocation)' : `from ${folder ?? 'another folder'}`,
  moveNow: 'Move to Applications',
  notNow: 'Not Now',
  doNotAskAgain: "Don't ask again",
  moveReplaceTitle: 'Another Dürbün is in Applications',
  moveReplaceMessage: 'Replace it with this copy? The other copy goes to the Trash.',
  replace: 'Replace',
  moveFailedTitle: 'Dürbün could not be moved',
  moveFailedMessage: (error) => `${error}\n\nYou can drag Dürbün to the Applications folder yourself.`,
  verboseLog: 'Verbose Diagnostic Log',
  verboseRestartTitle: (on) => (on ? 'Verbose logging starts when Dürbün restarts' : 'Verbose logging stops when Dürbün restarts'),
  verboseRestartMessage: 'Restart Dürbün now? Capture stops for a few seconds; connected apps reconnect on their own.',
  summaryLine: (devices, apps) => `${devices} ${devices === 1 ? 'device' : 'devices'} · ${apps} ${apps === 1 ? 'app' : 'apps'}`,
  dataDirInUse: (dir, port) =>
    `${port ? `Another Dürbün (port ${port}) uses the data folder ${dir}, but it did not answer, so its window could not be opened.` : `Another Dürbün is starting with the data folder ${dir}.`} Quit the other Dürbün (a terminal running durbun, or another copy of the app), then choose Try Again. To run both at once, give one of them its own data folder (DURBUN_DATA_DIR).`,
  unresponsiveTitle: 'The Dürbün window is not responding',
  unresponsiveMessage: 'The server keeps running and capturing. You can wait or reload the window; a reload resets the saved search that may have caused the hang.',
  wait: 'Wait',
  uiLoadRetrying: 'The UI could not be loaded; retrying…',
};

export const STRINGS: Record<Lang, Strings> = { tr, en };
