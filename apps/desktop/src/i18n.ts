/** App menu / tray / dialog texts. Turkish when the system's first language is Turkish, else English. */

export type Lang = 'tr' | 'en';

export function pickLanguage(preferred: readonly string[]): Lang {
  const first = (preferred[0] ?? '').toLowerCase();
  return first === 'tr' || first.startsWith('tr-') || first.startsWith('tr_') ? 'tr' : 'en';
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
  notificationsUnavailable: string;
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
  notificationsUnavailable: 'macOS bildirimleri bu (imzasız) sürümde gösterilemedi; bunun yerine Dock simgesi işaretlenir.',
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
  notificationsUnavailable: 'macOS notifications could not be shown by this (unsigned) build; the Dock icon is marked instead.',
};

export const STRINGS: Record<Lang, Strings> = { tr, en };
