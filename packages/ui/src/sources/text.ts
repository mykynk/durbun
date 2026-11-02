/**
 * Texts for "where does this come from / why can't I see it" (SPEC §10.5): capability and source names,
 * badges, reason sentences, actions, log origins. Everything is written from `ExplainContext`, so the
 * sentences name the concrete app, version and install source. Calm, specific, never blaming the developer:
 * one sentence why, one sentence how (the how is usually an action button).
 */
import type { DeviceInfo, DeviceReaderState, LogEntry, LogOrigin } from '@durbun/protocol';
import { registerMessages, t, hasMessage } from '../i18n';
import { tCode } from '../i18n/codes';
import { otherStoreKind } from '../data/explain';
import type {
  BuildBadge,
  ExplainAction,
  ExplainBadge,
  ExplainCapability,
  ExplainContext,
  ExplainReason,
  ExplainSource,
  ExplainStatus,
} from '../data/explain';

registerMessages('sources', {
  tr: {
    title: 'Neler görünüyor?',
    titleFor: '{app} için neler görünüyor?',
    open: 'Neler görünüyor? · veriler nereden geliyor',
    capability: {
      logs: 'Loglar',
      network: 'Ağ istekleri',
      metrics: 'Performans',
      crashes: 'Çökmeler ve ANR’lar',
      mocks: 'Mock’lar',
      tools: 'Uygulama içi araçlar',
    },
    capabilityHint: {
      logs: 'Uygulamanın ve cihazın log satırları',
      network: 'HTTP(S) istekleri ve yanıtları',
      metrics: 'CPU, bellek, FPS ve takılan kareler',
      crashes: 'Çökmeler, ANR’lar ve Flutter hata kutuları',
      mocks: 'Sahte yanıt, gecikme ve hata kuralları',
      tools: 'Debug paint, widget ağacı, thread dökümü…',
    },
    status: {
      yes: 'Görünüyor',
      partial: 'Kısmen',
      no: 'Görünmüyor',
    },
    source: {
      logcat: 'Cihaz logu (logcat)',
      idevicesyslog: 'iOS cihaz logu (idevicesyslog)',
      'simctl-log': 'Simülatör logu',
      sdk: 'Dürbün SDK',
      'vm-service': 'Dart VM Service',
      dropbox: 'Cihazın çökme kayıtları (dropbox)',
      'crash-report': 'Çökme raporları (.ips)',
      'proc-stats': 'Süreç istatistikleri (adb)',
      'host-ps': 'Mac’in süreç listesi',
      'frame-stats': 'Kare istatistikleri (gfxinfo)',
      demo: 'Demo verisi',
      import: 'İçe aktarılan kayıt',
      'native-layer': 'SDK’nın native katmanı',
    },
    sourceHint: {
      logcat: 'Android’in sistem logu. USB yeterli; uygulamaya bir şey eklemek gerekmez.',
      idevicesyslog: 'iPhone’un sistem logu. USB ve “Bu bilgisayara güven” yeterli.',
      'simctl-log': 'Simülatörün birleşik logu (simctl log stream).',
      sdk: 'Uygulamanın içindeki Dürbün SDK’sı: yapılandırılmış loglar, ağ, metrikler, mock’lar.',
      'vm-service': 'flutter run ile başlatılan debug uygulamanın Dart VM Service’i; SDK gerekmez.',
      dropbox: 'Android’in kendi tuttuğu çökme ve ANR kayıtları; her sürümde okunur.',
      'crash-report': 'iOS’un kaydettiği çökme raporları; her sürümde okunur, yığınlar sembolsüzdür.',
      'proc-stats': 'CPU ve bellek, cihazın süreç listesinden adb ile okunur.',
      'host-ps': 'Simülatördeki uygulama Mac’te bir süreçtir; CPU ve bellek oradan okunur.',
      'frame-stats': 'Android’in kare zamanlamaları (Flutter’da SurfaceFlinger); yaklaşık değerlerdir.',
      demo: 'Gerçek bir cihaz yok; Dürbün’ün ürettiği örnek veri.',
      import: 'Bir .durbun.json dosyasından içe aktarılan kayıt.',
      'native-layer': 'Flutter eklentisinin uygulama içindeki Kotlin / Swift çekirdeği: native loglar ve çökmeler; iOS’ta URLSession istekleri, Android’de DurbunInterceptor eklenmiş OkHttp istemcileri.',
    },
    badge: {
      sdk: 'SDK',
      'vm-service': 'VM Service',
      'device-only': 'Yalnızca cihaz logu',
      demo: 'Demo',
      import: 'Kayıt',
    },
    /** Sidebar rows are narrow: the short form, the tooltip carries the full sentence. */
    badgeShort: {
      sdk: 'SDK',
      'vm-service': 'VM Service',
      'device-only': 'Cihaz logu',
      demo: 'Demo',
      import: 'Kayıt',
    },
    badgeHint: {
      sdk: 'Dürbün SDK’sı bağlı: loglar, ağ, metrikler ve mock’lar uygulamanın içinden geliyor.',
      'vm-service': 'Flutter debug oturumu: loglar, ağ ve kare süreleri Dart VM Service’ten geliyor; SDK gerekmedi.',
      'device-only': 'SDK yok: Dürbün yalnızca cihazın kendi kayıtlarını (log, çökme) okuyor. Ağ istekleri ve mock’lar bu sürümde görünmez.',
      demo: 'Demo verisi.',
      import: 'İçe aktarılan bir kayıt; yalnızca kaydedilenler görünür.',
    },
    build: {
      debug: 'Debug',
      release: 'Release',
      firebase: 'Firebase',
      play: 'Play',
      'other-store': 'Diğer mağaza',
      xcode: 'Xcode',
      'store-or-testflight': 'Store / TestFlight / ad-hoc',
      simulator: 'Simülatör',
      apk: 'APK',
    },
    /** Narrow sidebar rows (the tooltip carries the full label). */
    buildShort: {
      'store-or-testflight': 'Store/TestFlight',
    },
    buildHint: {
      debug: 'Debug derlemesi (adb, Android Studio ya da flutter run ile kurulmuş).',
      release: 'adb, Android Studio ya da flutter run ile kurulmuş bir release derlemesi.',
      firebase: 'Firebase App Distribution’dan kurulmuş.',
      play: 'Play Store’dan kurulmuş.',
      'other-store': ['Başka bir mağazadan kurulmuş ({installer}).', 'Başka bir mağazadan kurulmuş.'],
      xcode: 'Xcode ya da flutter run ile kurulmuş geliştirici derlemesi.',
      'store-or-testflight': 'App Store, TestFlight ya da ad-hoc ile kurulmuş (iOS hangisi olduğunu söylemez).',
      simulator: 'Simülatör derlemesi.',
      apk: 'APK elle kuruldu (dosyadan, paket yükleyiciyle); bir mağazadan gelmedi.',
    },
    /** Android stores besides Play, by installer package: badge, tooltip, "{appv} {built}" predicate. */
    store: {
      'galaxy-store': { short: 'Galaxy Store', hint: 'Galaxy Store’dan kurulmuş.', built: 'Galaxy Store’dan kurulmuş bir sürüm' },
      appgallery: { short: 'AppGallery', hint: 'Huawei AppGallery’den kurulmuş.', built: 'Huawei AppGallery’den kurulmuş bir sürüm' },
      getapps: { short: 'GetApps', hint: 'Xiaomi GetApps mağazasından kurulmuş.', built: 'Xiaomi GetApps mağazasından kurulmuş bir sürüm' },
      amazon: { short: 'Amazon', hint: 'Amazon Appstore’dan kurulmuş.', built: 'Amazon Appstore’dan kurulmuş bir sürüm' },
    },
    /** "{appv} {built}; …" — how the build got onto the device, as a predicate. */
    built: {
      play: 'Play Store’dan kurulmuş bir sürüm',
      'other-store': ['başka bir mağazadan ({installer}) kurulmuş bir sürüm', 'başka bir mağazadan kurulmuş bir sürüm'],
      firebase: 'Firebase App Distribution’dan kurulmuş bir sürüm',
      'store-or-testflight': 'App Store, TestFlight ya da ad-hoc ile kurulmuş bir sürüm',
      release: 'bir release derlemesi',
      adbRelease: 'adb, Android Studio ya da flutter run ile kurulmuş bir release derlemesi',
      manualApk: 'elle kurulmuş bir APK',
      generic: 'bu cihazdaki sürüm',
    },
    summary: {
      sdk: ['{app} verilerini içindeki Dürbün SDK’sıyla gönderiyor.', 'Uygulama verilerini içindeki Dürbün SDK’sıyla gönderiyor.'],
      'vm-service': ['{app} bir Flutter debug oturumu: veriler Dart VM Service’ten geliyor, SDK gerekmedi.', 'Bu bir Flutter debug oturumu: veriler Dart VM Service’ten geliyor, SDK gerekmedi.'],
      'device-only': ['{app} içinde Dürbün SDK’sı yok; Dürbün yalnızca cihazın kendi kayıtlarını okuyor.', 'Bu uygulamada Dürbün SDK’sı yok; Dürbün yalnızca cihazın kendi kayıtlarını okuyor.'],
      demo: 'Demo verisi: gerçek bir cihaz ya da uygulama yok.',
      import: 'İçe aktarılan bir kayıt: yalnızca kaydedilenler görünür.',
    },
    reasons: {
      noSdk: ['{appv} içinde Dürbün SDK’sı yok.', 'Bu uygulamada Dürbün SDK’sı yok.'],
      releaseWithoutSdk: ['{appv} {built}; içinde Dürbün SDK’sı açık değil.', 'Bu {built}; içinde Dürbün SDK’sı açık değil.'],
      storeBuild: ['{appv} {built}; mağaza sürümlerinde Dürbün SDK’sı açılmaz.', 'Bu {built}; mağaza sürümlerinde Dürbün SDK’sı açılmaz.'],
      noOutsideNetwork: {
        android: 'Ağ trafiği uygulamanın dışından okunamaz: SSL pinning proxy’nin sertifikasını reddeder, Android de uygulamaların kullanıcı sertifikalarına güvenmesine izin vermez.',
        ios: 'Ağ trafiği uygulamanın dışından okunamaz: SSL pinning proxy’nin sertifikasını reddeder.',
        other: 'Ağ trafiği uygulamanın dışından okunamaz: SSL pinning ve sistemin sertifika kuralları proxy yolunu kapatır.',
      },
      vmServiceNoMocks: 'Dart VM Service istekleri izler ama değiştiremez; mock’lar uygulamanın içindeki Dürbün SDK’sıyla çalışır.',
      sdkLacksCapability: 'Bağlı Dürbün SDK’sı bunu göndermiyor (eski bir sürüm ya da kapatılmış bir özellik).',
      iosNoDeviceMetrics: 'iPhone CPU, bellek ve FPS bilgisini dışarıya vermez (yalnızca Xcode Instruments görür); bu değerler uygulamanın içinden gelir.',
      frameStatsApproximate: 'CPU ve bellek cihazın süreç listesinden okunur. FPS dışarıdan yaklaşık ölçülür ve her cihazda çalışmayabilir.',
      deviceLogsUnavailable: ['{device} için cihaz logu şu an gelmiyor: {logs}.', 'Cihaz logu şu an gelmiyor: {logs}.', 'Bu cihazın logu şu an gelmiyor.'],
      toolMissing: 'Gereken araç bu Mac’te bulunamadı; Sistem kontrolü nasıl kurulacağını gösterir.',
      releaseLogsDependOnApp: 'Release derlemelerinde cihaz loguna ne yazıldığı uygulamanın logger ayarına bağlı; debug logları çoğu zaman kapalıdır.',
      nativeNetworkNeedsInterceptor: {
        sdk: 'Kotlin katmanının kendi OkHttp istekleri, istemciye .addInterceptor(DurbunInterceptor()) eklendiyse görünür.',
        'vm-service': 'Dart VM Service yalnızca Dart’ın isteklerini görür; native (Kotlin / Swift) katmanın istekleri için Dürbün SDK’sı gerekir.',
      },
      thirdPartyTraffic: 'Üçüncü taraf SDK’ların kendi HTTP istemcileriyle yaptığı istekler (ör. analytics, reklam) görünmeyebilir.',
      crashesUnsymbolicated: 'Cihazdan okunan çökme yığınları sembolsüzdür (adres + ofset); okunur hâle getirmek için bu derlemenin dSYM / split-debug-info dosyaları gerekir.',
      notRunning: ['{app} şu an açık değil; açtığınızda veriler kendiliğinden gelmeye başlar.', 'Uygulama şu an açık değil.'],
      readOnly: {
        device: ['{device} bağlı değil; gördükleriniz bağlantı kesilmeden önce kaydedilenler.', 'Cihaz bağlı değil; gördükleriniz önceden kaydedilenler.'],
        import: 'Bu bir içe aktarılan kayıt; canlı bir şey yapılamaz, yalnızca kaydedilenler görünür.',
      },
      fpsNeedsApp: 'Simülatörde CPU ve bellek Mac’in süreç listesinden gelir; FPS ve takılan kareler yalnızca uygulamanın içinden (SDK ya da Flutter debug) ölçülür.',
      networkOnly: 'Uygulama ağ üzerinden bağlı; cihaz USB ile takılı olmadığından cihaz logu gelmiyor, yalnızca SDK’nın gönderdikleri görünür.',
      deviceToolsAvailable: {
        default: 'Cihaz araçları (uygulamayı başlat / durdur, verisini temizle, ekran görüntüsü) her sürümde çalışır.',
        /** A physical iPhone cannot clear an app's data from outside. */
        iosDevice: 'Cihaz araçları (uygulamayı başlat / durdur, ekran görüntüsü) her sürümde çalışır.',
      },
      sdkInStoreBuild: ['{appv} {built} ve içinde Dürbün SDK’sı açık; mağazaya çıkan derlemelerde SDK kapalı olmalı.', 'Bu {built} ve içinde Dürbün SDK’sı açık; mağazaya çıkan derlemelerde SDK kapalı olmalı.'],
      /** iOS cannot tell App Store from TestFlight / ad-hoc: the build may well be an internal one. */
      storeBuildIos: ['{appv} {built} (iOS hangisi olduğunu söylemez); bu derlemede Dürbün SDK’sı açık değil.', 'Bu {built} (iOS hangisi olduğunu söylemez); bu derlemede Dürbün SDK’sı açık değil.'],
      sdkInStoreBuildIos: ['{appv} {built} ve içinde Dürbün SDK’sı açık. TestFlight ya da ad-hoc ile dağıtılan bir iç test derlemesiyse sorun yok; App Store’a çıkan derlemede SDK kapalı olmalı.', 'Bu {built} ve içinde Dürbün SDK’sı açık. Bir iç test derlemesiyse sorun yok; App Store’a çıkan derlemede SDK kapalı olmalı.'],
      /** Fallbacks when the server's reader code is unknown (the English detail is shown as it is). */
      crashReportsUnavailable: ['Bu cihazın kendi çökme kayıtları okunamıyor: {detail}', 'Bu cihazın kendi çökme kayıtları şu an okunamıyor.'],
      frameStatsUnavailable: ['CPU ve bellek cihazın süreç listesinden okunur; kare istatistikleri okunamadı: {detail}', 'CPU ve bellek cihazın süreç listesinden okunur; FPS bu cihazda dışarıdan ölçülemiyor.'],
      nativeLayerActive: {
        android: 'Native katman da bağlı: Kotlin / Java logları ve native çökmeler de bu oturumdan geliyor. OkHttp istekleri, istemciye .addInterceptor(DurbunInterceptor()) eklendiyse görünür.',
        ios: 'Native katman da bağlı: Swift / Objective-C logları, native çökmeler ve URLSession istekleri de kendiliğinden geliyor.',
      },
      nativeLayerMissing: {
        android: 'Bu oturuma yalnızca Dart katmanı bağlı: Kotlin / Java logları, native çökmeler ve OkHttp istekleri bu oturumdan gelmez.',
        ios: 'Bu oturuma yalnızca Dart katmanı bağlı: Swift / Objective-C logları, native çökmeler ve URLSession istekleri bu oturumdan gelmez.',
      },
      demoData: 'Bu bir demo: cihaz ve uygulama Dürbün’ün ürettiği örnek veriler. Gerçek bir cihazda da aynı kaynaklar aynı şekilde çalışır.',
    },
    /** Capability-specific wording (falls back to `reasons.*`). */
    reasonFor: {
      network: {
        noSdk: ['{appv} içinde Dürbün SDK’sı yok; ağ istekleri yalnızca uygulamanın içinden okunabilir.', 'Bu uygulamada Dürbün SDK’sı yok; ağ istekleri yalnızca uygulamanın içinden okunabilir.'],
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı ağ isteklerini göndermiyor (eski bir sürüm ya da kapatılmış bir özellik).',
      },
      mocks: {
        noSdk: ['Mock’lar uygulamanın içinde, Dürbün SDK’sı tarafından uygulanır; {app} içinde SDK yok.', 'Mock’lar uygulamanın içinde, Dürbün SDK’sı tarafından uygulanır.'],
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı mock’ları desteklemiyor (eski bir sürüm ya da kapatılmış bir özellik).',
        storeBuild: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; mağaza sürümünde SDK yok.',
        storeBuildIos: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; bu derlemede SDK açık değil.',
        releaseWithoutSdk: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; bu sürümde SDK açık değil.',
      },
      tools: {
        noSdk: ['Uygulama içi araçlar Dürbün SDK’sı ya da Flutter debug oturumu ister; {app} için ikisi de yok.', 'Uygulama içi araçlar Dürbün SDK’sı ya da Flutter debug oturumu ister.'],
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı uygulama içi araç sunmuyor.',
        storeBuild: 'Uygulama içi araçlar da SDK ister; mağaza sürümünde SDK yok.',
        storeBuildIos: 'Uygulama içi araçlar da SDK ister; bu derlemede SDK açık değil.',
        releaseWithoutSdk: 'Uygulama içi araçlar SDK ya da Flutter debug oturumu ister; bu sürümde SDK açık değil.',
      },
      metrics: {
        noSdk: ['{app} için uygulamanın içinden metrik gelmiyor: Dürbün SDK’sı ya da Flutter debug oturumu yok.', 'Uygulamanın içinden metrik gelmiyor: Dürbün SDK’sı ya da Flutter debug oturumu yok.'],
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı metrik göndermiyor.',
      },
    },
    action: {
      openSdkGuide: 'SDK kurulumu',
      openDoctor: 'Sistem kontrolü',
      attachVm: 'Dart VM Service’e bağlan',
      useDebugBuild: 'Debug derlemesiyle dene',
      buildWithDurbunFlag: 'İç test derlemesinde aç',
      addInterceptor: 'Tek satırı göster',
      startProcessMetrics: 'Süreç metriklerini başlat',
    },
    tip: {
      useDebugBuild: 'Aynı sürümü (ör. git etiketinden) flutter run ile debug olarak çalıştırırsanız loglar, ağ istekleri ve araçlar kurulum yapmadan gelir.',
      buildWithDurbunFlag: 'Firebase / iç test derlemesi mağaza derlemesinden ayrıysa --dart-define=DURBUN=true ile SDK o derlemede açılır.',
    },
    notRunningShort: 'Açık değil',
    running: 'Çalışıyor',
    lastSeen: 'Son görülme {ago}',
    crashReports: { one: '{count} çökme kaydı', other: '{count} çökme kaydı' },
    general: 'Veriler nereden gelir?',
    doctor: 'Sistem kontrolü',
    device: 'Cihaz',
    bundle: 'Paket',
    installedFrom: 'Kurulum',
    deviceAppsMore: { one: '{count} uygulama daha', other: '{count} uygulama daha' },
    recent: 'Son açılanlar',
    origin: {
      logcat: 'logcat',
      idevicesyslog: 'iOS cihaz logu (idevicesyslog)',
      'simctl-log': 'Simülatör logu',
      sdk: 'Dürbün SDK',
      'vm-service': 'Dart VM Service',
      dropbox: 'Cihazın çökme kaydı (dropbox)',
      'crash-report': 'Çökme raporu (.ips)',
      durbun: 'Dürbün',
      demo: 'Demo',
      import: 'İçe aktarıldı',
    },
    originRow: {
      device: ['Cihaz logu · {origin}', 'Cihaz logu'],
      app: ['Uygulama logu · {origin}', 'Uygulama logu (SDK)'],
      system: 'Dürbün sistem satırı',
      crashRecord: '{origin}',
    },
    crash: {
      fromDevice: 'Cihazın çökme kaydından',
      previousLaunch: 'Önceki açılışta çöktü',
      unsymbolicated: 'sembolsüz',
      unsymbolicatedTip: 'Yığın adres + ofset olarak geldi; okunur hâle getirmek için bu derlemenin dSYM / split-debug-info dosyaları gerekir.',
      fromDeviceTip: 'Bu kaydı cihazın kendisi tuttu; uygulamada SDK olmasa da görünür.',
      previousLaunchTip: 'Bu çökme Dürbün izlemeye başlamadan önce oldu; kaydı cihazın kendisi tuttu. Gösterilen saat çökmenin gerçek zamanı.',
      recordLabel: 'Kayıt',
      download: 'İndir (.ips)',
      downloadTip: 'Cihazdan kopyalanan çökme raporunu (.ips) indirir.',
      symbolicateTitle: 'Yığın sembolsüz',
      symbolicate: 'Satırlar adres + ofset olarak geldi. Okunur hâle getirmek için .ips dosyasını, bu derlemenin dSYM dosyası bulunan bir Mac’te Xcode’la ya da Console’la açın.',
    },
    /** Crash empty states: "no crash yet" (records are read) vs "the device's records cannot be read". */
    crashEmpty: {
      noneTitle: 'Henüz çökme kaydı yok',
      none: ['{device} için cihazın kendi çökme kayıtları da okunuyor; Dürbün bağlanmadan önceki çökmeler de burada görünür.', 'Cihazın kendi çökme kayıtları da okunuyor; Dürbün bağlanmadan önceki çökmeler de burada görünür.'],
      unreadableTitle: ['{device} için çökme kayıtları okunamıyor', 'Bu cihazın çökme kayıtları okunamıyor'],
      unreadableMany: 'Bazı cihazların çökme kayıtları okunamıyor',
      unreadableLead: 'Burada çökme görünmemesi, hiç çökme olmadığı anlamına gelmeyebilir.',
      toastTitle: 'Bu kapsamda görünen bir çökme yok',
    },
    /** Performance of a process measured from outside, when the device gives no frame stats. */
    framesNote: { title: 'FPS bu cihazda dışarıdan ölçülemiyor' },
    empty: {
      network: {
        title: ['{app} için ağ istekleri görünmüyor', 'Ağ istekleri görünmüyor'],
        deviceTitle: 'Bu cihazda ağ isteklerini gönderebilen bir uygulama yok',
        device: 'Bu cihazdaki uygulamaların hiçbiri Dürbün SDK’sıyla ya da Flutter debug oturumuyla bağlı değil.',
      },
      metrics: {
        title: ['{app} için performans verisi', 'Performans verisi'],
        noTitle: ['{app} için performans verisi görünmüyor', 'Performans verisi görünmüyor'],
        deviceTitle: 'Bu cihazdan performans verisi gelmiyor',
        device: 'Bu cihazdaki uygulamaların hiçbiri metrik gönderemiyor.',
      },
      mocks: {
        title: ['Mock’lar {app} üzerinde çalışmaz', 'Mock’lar bu uygulamada çalışmaz'],
        deviceTitle: 'Mock’lar bu cihazdaki uygulamalarda çalışmaz',
        device: 'Bu cihazdaki uygulamaların hiçbirinde Dürbün SDK’sı yok; kurallar kaydedilir ama uygulanmaz.',
      },
      tools: {
        title: ['{app} için uygulama içi araç yok', 'Uygulama içi araç yok'],
        deviceTitle: 'Bu cihazda uygulama içi araç sunan bir uygulama yok',
        device: 'Uygulama içi araçlar Dürbün SDK’sı ya da Flutter debug oturumu ister.',
      },
      logs: {
        title: ['{app} için log görünmüyor', 'Log görünmüyor'],
        deviceTitle: 'Bu cihazdan log gelmiyor',
        device: 'Cihaz logu şu an gelmiyor.',
      },
      crashes: {
        title: ['{app} için çökme kaydı görünmüyor', 'Çökme kaydı görünmüyor'],
        deviceTitle: 'Bu cihazdan çökme kaydı gelmiyor',
        device: 'Cihaz bağlı değil.',
      },
    },
    explainer: {
      title: 'Veriler nereden gelir?',
      description: 'Dürbün her bilgiyi ulaşabildiği en yakın kaynaktan okur; hangisinin çalıştığı uygulamanın nasıl derlenip kurulduğuna bağlıdır.',
      deviceLogs: {
        title: 'Cihaz logları: yalnızca USB',
        body: 'Telefonu USB ile takmanız yeterli: Android’de logcat, iPhone’da cihaz logu, simülatörde birleşik log. Uygulamaya bir şey eklemeniz gerekmez; eski, Firebase ve mağaza sürümleri dahil her sürümde çalışır.',
      },
      appData: {
        title: 'Uygulamanın kendi verisi: SDK ya da Flutter debug',
        body: 'Yapılandırılmış loglar, ağ istekleri, mock’lar ve uygulama içi araçlar uygulamanın içinden gelir. Bunun için ya Dürbün SDK’sı ya da flutter run ile başlatılmış bir debug oturumu (Dart VM Service) gerekir.',
      },
      crashes: {
        title: 'Çökme kayıtları: cihazın kendisinden',
        body: 'Android’in dropbox kayıtları ve iOS’un .ips raporları her sürümde okunur; Dürbün bağlanmadan önceki çökmeler de “Önceki açılışta çöktü” olarak görünür. Bu yığınlar sembolsüzdür.',
      },
      metrics: {
        title: 'Performans',
        body: 'Android’de CPU ve bellek cihazın süreç listesinden, FPS dışarıdan yaklaşık olarak okunur. iPhone bu değerleri dışarıya vermez; orada SDK ya da Flutter debug gerekir.',
      },
      network: {
        title: 'Ağ neden dışarıdan görünmez?',
        body: 'İstekleri uygulamanın dışından okumanın tek yolu bir proxy’dir. SSL pinning proxy’nin sertifikasını reddeder; Android 7’den beri uygulamalar kullanıcının eklediği sertifikalara da güvenmez. Bu yüzden ağ için SDK’lı bir derleme ya da debug oturumu gerekir; bu bir kurulum hatası değil.',
      },
      store: {
        title: 'Mağaza sürümleri',
        body: 'Güvenlik için SDK mağaza derlemelerinde hiç açılmaz. Firebase / iç test derlemesi ayrı bir derlemeyse --dart-define=DURBUN=true ile o derlemede açılabilir.',
      },
      matrix: {
        title: 'Hangi sürümde ne görünür? (Android, Flutter uygulaması)',
        caption: 'Hücreler, uygulama satırındaki “Neler görünüyor?” panelinin kullandığı kurallardan üretilir.',
        capability: 'Özellik',
        debug: 'Debug (flutter run)',
        internal: 'Firebase / iç test (SDK açık)',
        store: 'Mağaza (SDK yok)',
      },
      perApp: 'Bir uygulama için ayrıntı: kenar çubuğunda uygulama satırındaki ⓘ düğmesi.',
    },
  },
  en: {
    title: 'What can I see?',
    titleFor: 'What can I see for {app}?',
    open: 'What can I see? · where the data comes from',
    capability: {
      logs: 'Logs',
      network: 'Network requests',
      metrics: 'Performance',
      crashes: 'Crashes and ANRs',
      mocks: 'Mocks',
      tools: 'In-app tools',
    },
    capabilityHint: {
      logs: 'Log lines of the app and the device',
      network: 'HTTP(S) requests and responses',
      metrics: 'CPU, memory, FPS and janky frames',
      crashes: 'Crashes, ANRs and Flutter error boxes',
      mocks: 'Fake response, delay and failure rules',
      tools: 'Debug paint, widget tree, thread dump…',
    },
    status: {
      yes: 'Available',
      partial: 'Partly',
      no: 'Not available',
    },
    source: {
      logcat: 'Device log (logcat)',
      idevicesyslog: 'iOS device log (idevicesyslog)',
      'simctl-log': 'Simulator log',
      sdk: 'Dürbün SDK',
      'vm-service': 'Dart VM Service',
      dropbox: 'Device crash records (dropbox)',
      'crash-report': 'Crash reports (.ips)',
      'proc-stats': 'Process stats (adb)',
      'host-ps': 'The Mac’s process list',
      'frame-stats': 'Frame stats (gfxinfo)',
      demo: 'Demo data',
      import: 'Imported recording',
      'native-layer': 'SDK native layer',
    },
    sourceHint: {
      logcat: 'Android’s system log. USB is enough; nothing to add to the app.',
      idevicesyslog: 'The iPhone’s system log. USB and “Trust This Computer” are enough.',
      'simctl-log': 'The simulator’s unified log (simctl log stream).',
      sdk: 'The Dürbün SDK inside the app: structured logs, network, metrics, mocks.',
      'vm-service': 'The Dart VM Service of a debug app started with flutter run; no SDK needed.',
      dropbox: 'Crash and ANR records Android keeps itself; readable for every build.',
      'crash-report': 'Crash reports iOS saves; readable for every build, stacks are unsymbolicated.',
      'proc-stats': 'CPU and memory read from the device’s process list over adb.',
      'host-ps': 'An app in the simulator is a process on the Mac; CPU and memory are read there.',
      'frame-stats': 'Android’s frame timings (SurfaceFlinger for Flutter); approximate.',
      demo: 'No real device; sample data made up by Dürbün.',
      import: 'A recording imported from a .durbun.json file.',
      'native-layer': 'The Flutter plugin’s Kotlin / Swift core inside the app: native logs and crashes; URLSession requests on iOS, OkHttp clients with DurbunInterceptor on Android.',
    },
    badge: {
      sdk: 'SDK',
      'vm-service': 'VM Service',
      'device-only': 'Device log only',
      demo: 'Demo',
      import: 'Recording',
    },
    badgeShort: {
      sdk: 'SDK',
      'vm-service': 'VM Service',
      'device-only': 'Device log',
      demo: 'Demo',
      import: 'Recording',
    },
    badgeHint: {
      sdk: 'The Dürbün SDK is connected: logs, network, metrics and mocks come from inside the app.',
      'vm-service': 'A Flutter debug session: logs, network and frame times come from the Dart VM Service; no SDK needed.',
      'device-only': 'No SDK: Dürbün only reads what the device records itself (logs, crashes). Network requests and mocks are not available for this build.',
      demo: 'Demo data.',
      import: 'An imported recording; only what was recorded is there.',
    },
    build: {
      debug: 'Debug',
      release: 'Release',
      firebase: 'Firebase',
      play: 'Play',
      'other-store': 'Other store',
      xcode: 'Xcode',
      'store-or-testflight': 'Store / TestFlight / ad-hoc',
      simulator: 'Simulator',
      apk: 'APK',
    },
    buildShort: {
      'store-or-testflight': 'Store/TestFlight',
    },
    buildHint: {
      debug: 'Debug build (installed with adb, Android Studio or flutter run).',
      release: 'A release build installed with adb, Android Studio or flutter run.',
      firebase: 'Installed from Firebase App Distribution.',
      play: 'Installed from the Play Store.',
      'other-store': ['Installed from another store ({installer}).', 'Installed from another store.'],
      xcode: 'Developer build installed with Xcode or flutter run.',
      'store-or-testflight': 'Installed from the App Store, TestFlight or ad hoc (iOS does not say which).',
      simulator: 'Simulator build.',
      apk: 'APK installed manually (from a file, with the package installer); it did not come from a store.',
    },
    store: {
      'galaxy-store': { short: 'Galaxy Store', hint: 'Installed from the Galaxy Store.', built: 'was installed from the Galaxy Store' },
      appgallery: { short: 'AppGallery', hint: 'Installed from Huawei AppGallery.', built: 'was installed from Huawei AppGallery' },
      getapps: { short: 'GetApps', hint: 'Installed from Xiaomi GetApps.', built: 'was installed from Xiaomi GetApps' },
      amazon: { short: 'Amazon', hint: 'Installed from the Amazon Appstore.', built: 'was installed from the Amazon Appstore' },
    },
    built: {
      play: 'was installed from the Play Store',
      'other-store': ['was installed from another store ({installer})', 'was installed from another store'],
      firebase: 'was installed from Firebase App Distribution',
      'store-or-testflight': 'was installed from the App Store, TestFlight or ad hoc',
      release: 'is a release build',
      adbRelease: 'is a release build installed with adb, Android Studio or flutter run',
      manualApk: 'was installed manually as an APK',
      generic: 'is the build on this device',
    },
    summary: {
      sdk: ['{app} sends its data with the Dürbün SDK inside it.', 'The app sends its data with the Dürbün SDK inside it.'],
      'vm-service': ['{app} is a Flutter debug session: data comes from the Dart VM Service, no SDK needed.', 'This is a Flutter debug session: data comes from the Dart VM Service, no SDK needed.'],
      'device-only': ['{app} has no Dürbün SDK; Dürbün only reads what the device records itself.', 'This app has no Dürbün SDK; Dürbün only reads what the device records itself.'],
      demo: 'Demo data: no real device or app.',
      import: 'An imported recording: only what was recorded is there.',
    },
    reasons: {
      noSdk: ['{appv} has no Dürbün SDK.', 'This app has no Dürbün SDK.'],
      releaseWithoutSdk: ['{appv} {built} without the Dürbün SDK turned on.', 'This app {built} without the Dürbün SDK turned on.'],
      storeBuild: ['{appv} {built}; the Dürbün SDK is never turned on in store builds.', 'This app {built}; the Dürbün SDK is never turned on in store builds.'],
      noOutsideNetwork: {
        android: 'Network traffic cannot be read from outside the app: SSL pinning rejects a proxy’s certificate, and Android does not let apps trust user certificates.',
        ios: 'Network traffic cannot be read from outside the app: SSL pinning rejects a proxy’s certificate.',
        other: 'Network traffic cannot be read from outside the app: SSL pinning and the system’s certificate rules close the proxy route.',
      },
      vmServiceNoMocks: 'The Dart VM Service can watch requests but not change them; mocks run in the Dürbün SDK inside the app.',
      sdkLacksCapability: 'The connected Dürbün SDK does not send this (an older version or a disabled feature).',
      iosNoDeviceMetrics: 'An iPhone does not expose CPU, memory or FPS to other tools (only Xcode Instruments sees them); these come from inside the app.',
      frameStatsApproximate: 'CPU and memory are read from the device’s process list. FPS is measured from outside, approximately, and may not work on every device.',
      deviceLogsUnavailable: ['The device log of {device} is not coming in: {logs}.', 'The device log is not coming in: {logs}.', 'This device’s log is not coming in right now.'],
      toolMissing: 'A required tool was not found on this Mac; the system check shows how to install it.',
      releaseLogsDependOnApp: 'What a release build writes to the device log depends on the app’s logger; debug logs are often turned off.',
      nativeNetworkNeedsInterceptor: {
        sdk: 'Requests of the Kotlin layer’s own OkHttp clients show up once .addInterceptor(DurbunInterceptor()) is added to them.',
        'vm-service': 'The Dart VM Service only sees Dart’s requests; the native (Kotlin / Swift) layer’s requests need the Dürbün SDK.',
      },
      thirdPartyTraffic: 'Requests third-party SDKs make with their own HTTP clients (analytics, ads…) may not show up.',
      crashesUnsymbolicated: 'Crash stacks read from the device are unsymbolicated (address + offset); this build’s dSYM / split-debug-info files make them readable.',
      notRunning: ['{app} is not running; data starts coming in when you open it.', 'The app is not running.'],
      readOnly: {
        device: ['{device} is not connected; you see what was recorded before it disconnected.', 'The device is not connected; you see what was recorded before.'],
        import: 'This is an imported recording; nothing live can be done, only what was recorded is there.',
      },
      fpsNeedsApp: 'In the simulator, CPU and memory come from the Mac’s process list; FPS and janky frames can only be measured inside the app (SDK or Flutter debug).',
      networkOnly: 'The app is connected over the network; the device is not plugged in over USB, so there is no device log — only what the SDK sends.',
      deviceToolsAvailable: {
        default: 'Device tools (launch / stop the app, clear its data, screenshot) work for every build.',
        iosDevice: 'Device tools (launch / stop the app, screenshot) work for every build.',
      },
      sdkInStoreBuild: ['{appv} {built} and has the Dürbün SDK turned on; builds that go to a store should ship with it off.', 'This app {built} and has the Dürbün SDK turned on; builds that go to a store should ship with it off.'],
      storeBuildIos: ['{appv} {built} (iOS does not say which); the Dürbün SDK is not turned on in this build.', 'This app {built} (iOS does not say which); the Dürbün SDK is not turned on in this build.'],
      sdkInStoreBuildIos: ['{appv} {built} and has the Dürbün SDK turned on. That is fine for an internal build shared over TestFlight or ad hoc; the build that goes to the App Store should ship with it off.', 'This app {built} and has the Dürbün SDK turned on. That is fine for an internal build; the build that goes to the App Store should ship with it off.'],
      crashReportsUnavailable: ['This device’s own crash records cannot be read: {detail}', 'This device’s own crash records cannot be read right now.'],
      frameStatsUnavailable: ['CPU and memory are read from the device’s process list; frame stats could not be read: {detail}', 'CPU and memory are read from the device’s process list; FPS cannot be measured from outside on this device.'],
      nativeLayerActive: {
        android: 'The native layer is connected too: Kotlin / Java logs and native crashes come through this session as well. OkHttp requests show up once .addInterceptor(DurbunInterceptor()) is added to the client.',
        ios: 'The native layer is connected too: Swift / Objective-C logs, native crashes and URLSession requests come in by themselves.',
      },
      nativeLayerMissing: {
        android: 'Only the Dart layer feeds this session: Kotlin / Java logs, native crashes and OkHttp requests do not come through it.',
        ios: 'Only the Dart layer feeds this session: Swift / Objective-C logs, native crashes and URLSession requests do not come through it.',
      },
      demoData: 'This is a demo: the device and the app are sample data made up by Dürbün. On a real device the same sources work the same way.',
    },
    reasonFor: {
      network: {
        noSdk: ['{appv} has no Dürbün SDK; network requests can only be read from inside the app.', 'This app has no Dürbün SDK; network requests can only be read from inside the app.'],
        sdkLacksCapability: 'The connected Dürbün SDK does not send network requests (an older version or a disabled feature).',
      },
      mocks: {
        noSdk: ['Mocks are applied inside the app by the Dürbün SDK; {app} has no SDK.', 'Mocks are applied inside the app by the Dürbün SDK.'],
        sdkLacksCapability: 'The connected Dürbün SDK does not support mocks (an older version or a disabled feature).',
        storeBuild: 'Mocks run inside the app with the Dürbün SDK; the store build has no SDK.',
        storeBuildIos: 'Mocks run inside the app with the Dürbün SDK; it is not turned on in this build.',
        releaseWithoutSdk: 'Mocks run inside the app with the Dürbün SDK; it is not turned on in this build.',
      },
      tools: {
        noSdk: ['In-app tools need the Dürbün SDK or a Flutter debug session; {app} has neither.', 'In-app tools need the Dürbün SDK or a Flutter debug session.'],
        sdkLacksCapability: 'The connected Dürbün SDK offers no in-app tools.',
        storeBuild: 'In-app tools need the SDK as well; the store build has none.',
        storeBuildIos: 'In-app tools need the SDK as well; it is not turned on in this build.',
        releaseWithoutSdk: 'In-app tools need the SDK or a Flutter debug session; the SDK is not turned on in this build.',
      },
      metrics: {
        noSdk: ['No metrics come from inside {app}: there is no Dürbün SDK or Flutter debug session.', 'No metrics come from inside the app: there is no Dürbün SDK or Flutter debug session.'],
        sdkLacksCapability: 'The connected Dürbün SDK does not send metrics.',
      },
    },
    action: {
      openSdkGuide: 'Set up the SDK',
      openDoctor: 'System check',
      attachVm: 'Attach the Dart VM Service',
      useDebugBuild: 'Try a debug build',
      buildWithDurbunFlag: 'Turn it on in an internal build',
      addInterceptor: 'Show the one line',
      startProcessMetrics: 'Start process metrics',
    },
    tip: {
      useDebugBuild: 'Run the same version (e.g. from its git tag) as a debug build with flutter run: logs, network requests and tools come in without any setup.',
      buildWithDurbunFlag: 'If the Firebase / internal build is separate from the store build, --dart-define=DURBUN=true turns the SDK on in that build.',
    },
    notRunningShort: 'Not running',
    running: 'Running',
    lastSeen: 'Last seen {ago}',
    crashReports: { one: '{count} crash record', other: '{count} crash records' },
    general: 'Where does the data come from?',
    doctor: 'System check',
    device: 'Device',
    bundle: 'Package',
    installedFrom: 'Installed',
    deviceAppsMore: { one: '{count} more app', other: '{count} more apps' },
    recent: 'Recently active',
    origin: {
      logcat: 'logcat',
      idevicesyslog: 'iOS device log (idevicesyslog)',
      'simctl-log': 'Simulator log',
      sdk: 'Dürbün SDK',
      'vm-service': 'Dart VM Service',
      dropbox: 'Device crash record (dropbox)',
      'crash-report': 'Crash report (.ips)',
      durbun: 'Dürbün',
      demo: 'Demo',
      import: 'Imported',
    },
    originRow: {
      device: ['Device log · {origin}', 'Device log'],
      app: ['App log · {origin}', 'App log (SDK)'],
      system: 'Dürbün system line',
      crashRecord: '{origin}',
    },
    crash: {
      fromDevice: 'From the device’s crash record',
      previousLaunch: 'Crashed in an earlier launch',
      unsymbolicated: 'unsymbolicated',
      unsymbolicatedTip: 'The stack came as address + offset; this build’s dSYM / split-debug-info files make it readable.',
      fromDeviceTip: 'The device kept this record itself; it shows up even without the SDK in the app.',
      previousLaunchTip: 'This crash happened before Dürbün started watching; the device kept the record itself. The time shown is when it actually crashed.',
      recordLabel: 'Record',
      download: 'Download .ips',
      downloadTip: 'Downloads the crash report (.ips) copied from the device.',
      symbolicateTitle: 'Unsymbolicated stack',
      symbolicate: 'The frames came as address + offset. To make them readable, open the .ips file in Xcode or Console on a Mac that has this build’s dSYM.',
    },
    crashEmpty: {
      noneTitle: 'No crash records yet',
      none: ['The device’s own crash records of {device} are read too; crashes from before Dürbün connected show up here as well.', 'The device’s own crash records are read too; crashes from before Dürbün connected show up here as well.'],
      unreadableTitle: ['Crash records of {device} cannot be read', 'This device’s crash records cannot be read'],
      unreadableMany: 'Some devices’ crash records cannot be read',
      unreadableLead: 'No crash here does not necessarily mean nothing crashed.',
      toastTitle: 'No crash visible in this scope',
    },
    framesNote: { title: 'FPS cannot be measured from outside on this device' },
    empty: {
      network: {
        title: ['No network requests for {app}', 'No network requests'],
        deviceTitle: 'No app on this device can send network requests',
        device: 'None of the apps on this device is connected with the Dürbün SDK or a Flutter debug session.',
      },
      metrics: {
        title: ['Performance data for {app}', 'Performance data'],
        noTitle: ['No performance data for {app}', 'No performance data'],
        deviceTitle: 'No performance data from this device',
        device: 'None of the apps on this device can send metrics.',
      },
      mocks: {
        title: ['Mocks do not work in {app}', 'Mocks do not work in this app'],
        deviceTitle: 'Mocks do not work in the apps on this device',
        device: 'None of the apps on this device has the Dürbün SDK; rules are saved but not applied.',
      },
      tools: {
        title: ['No in-app tools for {app}', 'No in-app tools'],
        deviceTitle: 'No app on this device offers in-app tools',
        device: 'In-app tools need the Dürbün SDK or a Flutter debug session.',
      },
      logs: {
        title: ['No logs for {app}', 'No logs'],
        deviceTitle: 'No logs from this device',
        device: 'The device log is not coming in right now.',
      },
      crashes: {
        title: ['No crash records for {app}', 'No crash records'],
        deviceTitle: 'No crash records from this device',
        device: 'The device is not connected.',
      },
    },
    explainer: {
      title: 'Where does the data come from?',
      description: 'Dürbün reads every piece of data from the closest source it can reach; which one works depends on how the app was built and installed.',
      deviceLogs: {
        title: 'Device logs: just USB',
        body: 'Plug the phone in over USB: logcat on Android, the device log on an iPhone, the unified log in the simulator. Nothing to add to the app; works for every build, including old, Firebase and store builds.',
      },
      appData: {
        title: 'The app’s own data: SDK or Flutter debug',
        body: 'Structured logs, network requests, mocks and in-app tools come from inside the app. That takes either the Dürbün SDK or a debug session started with flutter run (Dart VM Service).',
      },
      crashes: {
        title: 'Crash records: from the device itself',
        body: 'Android’s dropbox records and iOS’s .ips reports are readable for every build; crashes from before Dürbün connected show up as “Crashed in an earlier launch”. These stacks are unsymbolicated.',
      },
      metrics: {
        title: 'Performance',
        body: 'On Android, CPU and memory come from the device’s process list and FPS is read approximately from outside. An iPhone does not expose them; there it takes the SDK or Flutter debug.',
      },
      network: {
        title: 'Why can’t network be seen from outside?',
        body: 'The only way to read requests from outside an app is a proxy. SSL pinning rejects the proxy’s certificate, and since Android 7 apps do not trust user-added certificates either. So network needs a build with the SDK or a debug session — it is not a setup mistake.',
      },
      store: {
        title: 'Store builds',
        body: 'For security the SDK is never turned on in store builds. If the Firebase / internal build is a separate build, --dart-define=DURBUN=true turns it on there.',
      },
      matrix: {
        title: 'What shows up for which build? (Android, a Flutter app)',
        caption: 'The cells come from the same rules the “What can I see?” panel of an app row uses.',
        capability: 'Feature',
        debug: 'Debug (flutter run)',
        internal: 'Firebase / internal (SDK on)',
        store: 'Store (no SDK)',
      },
      perApp: 'Details for one app: the ⓘ button on its row in the sidebar.',
    },
  },
});

/* ───────────── helpers ───────────── */

export function capabilityLabel(c: ExplainCapability): string {
  return t(`sources.capability.${c}`);
}

export function statusLabel(s: ExplainStatus): string {
  return t(`sources.status.${s}`);
}

export function sourceLabel(s: ExplainSource): string {
  return t(`sources.source.${s}`);
}

export function sourceHint(s: ExplainSource): string {
  return t(`sources.sourceHint.${s}`);
}

export function badgeLabel(b: ExplainBadge, opts: { short?: boolean } = {}): string {
  return t(`sources.${opts.short ? 'badgeShort' : 'badge'}.${b}`);
}

export function badgeHint(b: ExplainBadge): string {
  return t(`sources.badgeHint.${b}`);
}

/** Tooltip of a badge: the full label (when the badge shows the short one) + what it means. */
export function badgeTooltip(b: ExplainBadge): string {
  return `${t(`sources.badge.${b}`)} · ${t(`sources.badgeHint.${b}`)}`;
}

/**
 * Badge text; 'other-store' names the store when the installer is a known one (Galaxy Store, AppGallery…).
 * `short`: the narrow sidebar form ("Store/TestFlight"), when there is one.
 */
export function buildBadgeLabel(b: BuildBadge, installer?: string, opts: { short?: boolean } = {}): string {
  const store = b === 'other-store' ? otherStoreKind(installer) : undefined;
  if (store && store !== 'manual') return t(`sources.store.${store}.short`);
  if (opts.short && hasMessage(`sources.buildShort.${b}`)) return t(`sources.buildShort.${b}`);
  return t(`sources.build.${b}`);
}

export function buildBadgeHint(b: BuildBadge, installer?: string): string {
  const store = b === 'other-store' ? otherStoreKind(installer) : undefined;
  if (store === 'manual') return t('sources.buildHint.apk');
  if (store) return t(`sources.store.${store}.hint`);
  return t(`sources.buildHint.${b}`, { installer });
}

/**
 * "Kumbara" / "Kumbara 3.1.0" (version only, the build number would make sentences heavy). Undefined when the app
 * is not known at all: the messages then fall back to their name-less candidate.
 */
function appNames(ctx: Pick<ExplainContext, 'appName' | 'bundleId' | 'version'> | undefined): { app?: string; appv?: string } {
  const app = ctx?.appName || ctx?.bundleId || undefined;
  return { app, appv: app && ctx?.version ? `${app} ${ctx.version}` : app };
}

/** How the build got onto the device, as a predicate ("Play Store’dan kurulmuş bir sürüm"). */
function builtPhrase(ctx: ExplainContext | undefined): string {
  if (!ctx) return t('sources.built.generic');
  switch (ctx.install) {
    case 'play':
    case 'firebase':
    case 'store-or-testflight':
      return t(`sources.built.${ctx.install}`);
    case 'other-store': {
      const store = otherStoreKind(ctx.installer);
      if (store === 'manual') return t('sources.built.manualApk');
      if (store) return t(`sources.store.${store}.built`);
      return t('sources.built.other-store', { installer: ctx.installer });
    }
    case 'adb':
      return t('sources.built.adbRelease');
    default:
      return ctx.build === 'release' ? t('sources.built.release') : t('sources.built.generic');
  }
}

export interface ReasonTextOptions {
  /** Localized device name (deviceLogsUnavailable, readOnly). */
  device?: string;
  /** Localized device-log status ("Cihaz güvenilir olarak işaretlenmedi"…). */
  logs?: string;
}

/** Params every reason sentence can use. */
export function reasonParams(ctx: ExplainContext | undefined, opts: ReasonTextOptions = {}): Record<string, string | undefined> {
  const { app, appv } = appNames(ctx);
  return { app, appv, built: builtPhrase(ctx), device: opts.device || undefined, logs: opts.logs || undefined, installer: ctx?.installer };
}

/** The sentence for one reason on one capability row (or an app-level note when `capability` is omitted). */
export function reasonText(reason: ExplainReason, ctx: ExplainContext | undefined, capability?: ExplainCapability, opts: ReasonTextOptions = {}): string {
  const params = reasonParams(ctx, opts);
  // iOS cannot tell App Store from TestFlight / ad-hoc: those sentences must not call the build a store build.
  const ios = ctx?.install === 'store-or-testflight' && (reason === 'storeBuild' || reason === 'sdkInStoreBuild') ? 'Ios' : '';
  if (capability && ios && hasMessage(`sources.reasonFor.${capability}.${reason}${ios}`)) return t(`sources.reasonFor.${capability}.${reason}${ios}`, params);
  if (capability && hasMessage(`sources.reasonFor.${capability}.${reason}`)) return t(`sources.reasonFor.${capability}.${reason}`, params);
  switch (reason) {
    case 'noOutsideNetwork': {
      const p = ctx?.platform;
      const variant = p === 'android' ? 'android' : p === 'ios-device' || p === 'ios-simulator' ? 'ios' : 'other';
      return t(`sources.reasons.noOutsideNetwork.${variant}`, params);
    }
    case 'nativeNetworkNeedsInterceptor':
      return t(`sources.reasons.nativeNetworkNeedsInterceptor.${ctx?.transport === 'vm-service' ? 'vm-service' : 'sdk'}`, params);
    case 'readOnly':
      return t(`sources.reasons.readOnly.${ctx?.transport === 'import' ? 'import' : 'device'}`, params);
    case 'storeBuild':
    case 'sdkInStoreBuild':
      return t(`sources.reasons.${reason}${ios}`, params);
    case 'crashReportsUnavailable':
      return readerText(ctx?.readers?.crashReports, reason);
    case 'frameStatsUnavailable':
      return readerText(ctx?.readers?.frameStats, reason);
    case 'deviceToolsAvailable':
      return t(`sources.reasons.deviceToolsAvailable.${ctx?.platform === 'ios-device' ? 'iosDevice' : 'default'}`, params);
    case 'nativeLayerActive':
    case 'nativeLayerMissing':
      return t(`sources.reasons.${reason}.${ctx?.platform === 'android' ? 'android' : 'ios'}`, params);
    default:
      return t(`sources.reasons.${reason}`, params);
  }
}

/** Why the frame stats of a device cannot be read (empty when they can, or when the server does not say). */
export function frameReaderText(device: Pick<DeviceInfo, 'readers'>): string {
  const st = device.readers?.frameStats;
  return st && st.status !== 'ok' ? readerText(st, 'frameStatsUnavailable') : '';
}

/** Why the crash records of a device cannot be read (empty when they can, or when the server does not say). */
export function crashReaderText(device: Pick<DeviceInfo, 'readers'>): string {
  const st = device.readers?.crashReports;
  return st && st.status !== 'ok' ? readerText(st, 'crashReportsUnavailable') : '';
}

/**
 * Why a reader of the device does not work: the text for the server's code (`reader.<id>.<reason>`), else the
 * generic sentence with the server's English detail, else the generic sentence alone.
 */
function readerText(state: DeviceReaderState | undefined, reason: 'crashReportsUnavailable' | 'frameStatsUnavailable'): string {
  const detail = state?.detail?.trim() || undefined;
  const generic = t(`sources.reasons.${reason}`, { detail });
  return state?.code ? tCode(state.code, { detail }, generic) : generic;
}

export function actionLabel(a: ExplainAction): string {
  return t(`sources.action.${a}`);
}

/** Actions that are advice rather than a button ("run the same version as a debug build"). */
export const TIP_ACTIONS: ReadonlySet<ExplainAction> = new Set<ExplainAction>(['useDebugBuild']);

export function tipText(a: ExplainAction): string | undefined {
  return hasMessage(`sources.tip.${a}`) ? t(`sources.tip.${a}`) : undefined;
}

export function summaryText(badge: ExplainBadge, ctx: ExplainContext | undefined): string {
  return t(`sources.summary.${badge}`, reasonParams(ctx));
}

/* ───────────── log origins ───────────── */

const ORIGINS: readonly LogOrigin[] = ['logcat', 'idevicesyslog', 'simctl-log', 'sdk', 'vm-service', 'dropbox', 'crash-report', 'durbun', 'demo', 'import'];

export function isKnownOrigin(o: unknown): o is LogOrigin {
  return typeof o === 'string' && (ORIGINS as readonly string[]).includes(o);
}

/** "logcat", "iOS cihaz logu (idevicesyslog)", "Dürbün SDK"… (unknown origins are shown as they are). */
export function originLabel(origin: string): string {
  return isKnownOrigin(origin) ? t(`sources.origin.${origin}`) : origin;
}

/** Exact origin of a log line: `origin`, else `data.origin` (crash records), else undefined. */
export function entryOrigin(e: Pick<LogEntry, 'origin' | 'data'>): string | undefined {
  if (typeof e.origin === 'string' && e.origin) return e.origin;
  const d = e.data as { origin?: unknown } | null | undefined;
  return d && typeof d === 'object' && typeof d.origin === 'string' && d.origin ? d.origin : undefined;
}

/** Crash / ANR record the device kept itself (Android dropbox, iOS .ips), not a live log line. */
export function isDeviceCrashRecord(e: Pick<LogEntry, 'origin' | 'data'>): boolean {
  const o = entryOrigin(e);
  return o === 'dropbox' || o === 'crash-report';
}

/** Tooltip / metadata text for a log row's source: "Cihaz logu · logcat", "Uygulama logu · Dart VM Service"… */
export function entrySourceText(e: Pick<LogEntry, 'source' | 'origin' | 'data'>): string {
  const origin = entryOrigin(e);
  if (origin === 'dropbox' || origin === 'crash-report') return t('sources.originRow.crashRecord', { origin: originLabel(origin) });
  if (e.source === 'system') return origin && origin !== 'durbun' ? `${t('sources.originRow.system')} · ${originLabel(origin)}` : t('sources.originRow.system');
  const kind = e.source === 'app' ? 'app' : 'device';
  return t(`sources.originRow.${kind}`, { origin: origin ? originLabel(origin) : undefined });
}

/** Device crash record whose stack is not symbolicated (.ips frames are image + offset; dropbox native tombstones). */
export function isUnsymbolicated(e: Pick<LogEntry, 'origin' | 'data'>): boolean {
  const d = e.data as { symbolicated?: unknown; unsymbolicated?: unknown } | null | undefined;
  if (d && typeof d === 'object') {
    if (d.symbolicated === false || d.unsymbolicated === true) return true;
    if (d.symbolicated === true || d.unsymbolicated === false) return false;
  }
  return entryOrigin(e) === 'crash-report';
}
