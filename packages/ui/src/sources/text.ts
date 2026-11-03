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
      idevicesyslog: 'iPhone’un sistem logu. USB ile takıp iPhone’da “Güven”e dokunmanız yeterli.',
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
      'vm-service': 'Flutter debug oturumu: loglar, ağ ve kare süreleri Dart VM Service’ten geliyor; SDK gerekmiyor.',
      'device-only': 'Uygulamanın içinden veri gelmiyor: Dürbün yalnızca cihazın kendi kayıtlarını (log, çökme) okuyor. Ağ istekleri görünmez, mock’lar çalışmaz.',
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
      'store-or-testflight': 'Store/TF',
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
      'vm-service': ['{app} Flutter debug oturumuyla bağlı: veriler Dart VM Service’ten geliyor, SDK gerekmiyor.', 'Flutter debug oturumuyla bağlı: veriler Dart VM Service’ten geliyor, SDK gerekmiyor.'],
      'device-only': [
        '{app} Dürbün’e kendi verisini göndermiyor (SDK yok ya da bu derlemede kapalı); Dürbün yalnızca cihazın kendi kayıtlarını okuyor.',
        'Uygulama Dürbün’e kendi verisini göndermiyor (SDK yok ya da bu derlemede kapalı); Dürbün yalnızca cihazın kendi kayıtlarını okuyor.',
      ],
      /** Not running, no SDK / VM session seen yet: nothing is known about its SDK. */
      notSeenYet: [
        '{app} henüz Dürbün’e bağlanmadı: içinde Dürbün SDK’sı varsa açılınca kendiliğinden bağlanır, yoksa cihazın kendi kayıtları (log, çökme) görünür.',
        'Uygulama henüz Dürbün’e bağlanmadı: içinde Dürbün SDK’sı varsa açılınca kendiliğinden bağlanır, yoksa cihazın kendi kayıtları (log, çökme) görünür.',
      ],
      /** Probably not one of the team's apps: no build advice. */
      otherApp: ['{app} için yalnızca cihazın kendisinden okunanlar görünür: cihaz logu ve çökme kayıtları.', 'Yalnızca cihazın kendisinden okunanlar görünür: cihaz logu ve çökme kayıtları.'],
      demo: 'Demo verisi: gerçek bir cihaz ya da uygulama yok.',
      import: 'İçe aktarılan bir kayıt: yalnızca kaydedilenler görünür.',
    },
    reasons: {
      noSdk: ['{appv} bu cihazda Dürbün SDK’sıyla bağlanmadı.', 'Bu uygulama Dürbün SDK’sıyla bağlanmadı.'],
      releaseWithoutSdk: ['{appv} {built}; içinde Dürbün SDK’sı açık değil.', 'Bu {built}; içinde Dürbün SDK’sı açık değil.'],
      storeBuild: ['{appv} {built}; içinde Dürbün SDK’sı açık değil.', 'Bu {built}; içinde Dürbün SDK’sı açık değil.'],
      noOutsideNetwork: {
        android: 'Ağ trafiği uygulamanın dışından okunamaz: SSL pinning proxy’nin sertifikasını reddeder; Android 7’den beri uygulamalar kullanıcının eklediği sertifikalara da varsayılan olarak güvenmez.',
        ios: 'Ağ trafiği uygulamanın dışından okunamaz: SSL pinning proxy’nin sertifikasını reddeder.',
        other: 'Ağ trafiği uygulamanın dışından okunamaz: SSL pinning ve sistemin sertifika kuralları proxy yolunu kapatır.',
      },
      vmServiceNoMocks: 'Dart VM Service istekleri izler ama değiştiremez; mock’lar uygulamanın içindeki Dürbün SDK’sıyla çalışır.',
      sdkLacksCapability: 'Bağlı Dürbün SDK’sı bunu göndermiyor (eski bir sürüm ya da kapatılmış bir özellik).',
      iosNoDeviceMetrics: 'iPhone CPU, bellek ve FPS bilgisini dışarıya vermez (yalnızca Xcode Instruments görür); bu değerler yalnızca uygulamanın içinden (SDK ya da Flutter debug) okunabilir.',
      frameStatsApproximate: 'CPU ve bellek cihazın süreç listesinden okunur. FPS dışarıdan yaklaşık ölçülür ve her cihazda çalışmayabilir.',
      deviceLogsUnavailable: ['{device} için cihaz logu şu an gelmiyor: {logs}.', 'Cihaz logu şu an gelmiyor: {logs}.', 'Bu cihazın logu şu an gelmiyor.'],
      toolMissing: 'Gereken araç bu Mac’te bulunamadı; Sistem kontrolü nasıl kurulacağını gösterir.',
      releaseLogsDependOnApp: 'Release derlemelerinde cihaz loguna ne yazıldığı uygulamanın logger ayarına bağlı; debug logları çoğu zaman kapalıdır.',
      nativeNetworkNeedsInterceptor: {
        sdk: 'Native (Kotlin) katmanın kendi OkHttp istekleri, istemciye .addInterceptor(DurbunInterceptor()) eklendiyse görünür.',
        /** The native Android SDK: OkHttp is the app's own HTTP stack, not a "native layer". */
        sdkAndroid: 'OkHttp istekleri, istemciye .addInterceptor(DurbunInterceptor()) eklendiyse görünür.',
        'vm-service': 'Dart VM Service yalnızca Dart’ın isteklerini görür; native (Kotlin / Swift) katmanın istekleri için Dürbün SDK’sı gerekir.',
      },
      thirdPartyTraffic: 'Üçüncü taraf SDK’ların kendi HTTP istemcileriyle yaptığı istekler (ör. analytics, reklam) görünmeyebilir.',
      crashesUnsymbolicated: 'Cihazdan okunan çökme yığınları sembolsüzdür (adres + ofset); okunur hâle getirmek için bu derlemenin dSYM / split-debug-info dosyaları gerekir.',
      notRunning: ['{app} şu an açık değil; açtığınızda veriler kendiliğinden gelmeye başlar.', 'Uygulama şu an açık değil.'],
      notSeenYet: ['{appv} henüz Dürbün’e bağlanmadı; içinde Dürbün SDK’sı varsa açılınca kendiliğinden bağlanır.', 'Uygulama henüz Dürbün’e bağlanmadı; içinde Dürbün SDK’sı varsa açılınca kendiliğinden bağlanır.'],
      notOwnApp: ['Bu bilgi yalnızca uygulamanın içinden okunabilir; {app} sizin projelerinizden biri değilse Dürbün buna ulaşamaz.', 'Bu bilgi yalnızca uygulamanın içinden okunabilir; uygulama sizin projelerinizden biri değilse Dürbün buna ulaşamaz.'],
      readOnly: {
        device: ['{device} bağlı değil; bağlantı kesilmeden önce gelenler ekranda. Yeniden bağlanınca kaldığı yerden devam eder.', 'Cihaz bağlı değil; bağlantı kesilmeden önce gelenler ekranda. Yeniden bağlanınca kaldığı yerden devam eder.'],
        import: 'Bu bir içe aktarılan kayıt; canlı bir şey yapılamaz, yalnızca kaydedilenler görünür.',
      },
      fpsNeedsApp: 'Simülatörde CPU ve bellek Mac’in süreç listesinden gelir; FPS ve takılan kareler yalnızca uygulamanın içinden (SDK ya da Flutter debug) ölçülür.',
      networkOnly: 'Uygulama ağ üzerinden bağlı; cihaz USB ile takılı olmadığından cihaz logu gelmiyor, yalnızca SDK’nın gönderdikleri görünür.',
      deviceToolsAvailable: {
        default: 'Cihaz araçları (uygulamayı başlat / durdur, verisini temizle, ekran görüntüsü) SDK olmadan da çalışır.',
        /** A physical iPhone cannot clear an app's data from outside. */
        iosDevice: 'Cihaz araçları (uygulamayı başlat / durdur, ekran görüntüsü) SDK olmadan da çalışır.',
        /** …and devicectl stops developer (Xcode) apps only. */
        iosDeviceStore: 'Cihaz araçları (uygulamayı başlat, ekran görüntüsü) SDK olmadan da çalışır; App Store ve TestFlight uygulamalarını Dürbün dışarıdan durduramaz.',
      },
      /** Informational: the team turned the SDK on in a store-installed build. */
      sdkInStoreBuild: ['{appv} {built}; içinde Dürbün SDK’sı açık, veriler SDK’dan geliyor.', 'Bu {built}; içinde Dürbün SDK’sı açık, veriler SDK’dan geliyor.'],
      /** iOS cannot tell App Store from TestFlight / ad-hoc: the build may well be an internal one. */
      storeBuildIos: ['{appv} {built} (iOS hangisi olduğunu söylemez); bu derlemede Dürbün SDK’sı açık değil.', 'Bu {built} (iOS hangisi olduğunu söylemez); bu derlemede Dürbün SDK’sı açık değil.'],
      sdkInStoreBuildIos: [
        '{appv} {built} (iOS hangisi olduğunu söylemez); içinde Dürbün SDK’sı açık, veriler SDK’dan geliyor.',
        'Bu {built} (iOS hangisi olduğunu söylemez); içinde Dürbün SDK’sı açık, veriler SDK’dan geliyor.',
      ],
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
        noSdk: ['{appv} Dürbün SDK’sıyla bağlanmadı; ağ istekleri yalnızca uygulamanın içinden okunabilir.', 'Uygulama Dürbün SDK’sıyla bağlanmadı; ağ istekleri yalnızca uygulamanın içinden okunabilir.'],
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı ağ isteklerini göndermiyor (eski bir sürüm ya da kapatılmış bir özellik).',
        notSeenYet: ['{app} açılınca, içinde Dürbün SDK’sı varsa istekleri burada görünür.', 'Uygulama açılınca, içinde Dürbün SDK’sı varsa istekleri burada görünür.'],
        notOwnApp: ['{app} sizin projelerinizden biri değilse ağ isteklerine ulaşmanın bir yolu yok.', 'Uygulama sizin projelerinizden biri değilse ağ isteklerine ulaşmanın bir yolu yok.'],
      },
      mocks: {
        noSdk: ['Mock’ları uygulamanın içindeki Dürbün SDK’sı uygular; {app} SDK’yla bağlanmadı.', 'Mock’ları uygulamanın içindeki Dürbün SDK’sı uygular.'],
        notSeenYet: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; uygulama açıldığında içinde SDK varsa kurallar uygulanır.',
        notOwnApp: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; yalnızca kendi projelerinizde kullanılabilir.',
        readOnlyDevice: 'Mock’lar yalnızca bağlı bir uygulamada çalışır; cihaz şu an bağlı değil.',
        /** The device is plugged in but waits for "Trust" (iOS) / the USB debugging prompt (Android). */
        readOnlyUntrusted: 'Mock’lar bağlı bir uygulamada çalışır; önce iPhone’da “Güven”e dokunun.',
        readOnlyUntrustedAndroid: 'Mock’lar bağlı bir uygulamada çalışır; önce cihazdaki “USB hata ayıklamaya izin verilsin mi?” sorusunu onaylayın.',
        readOnlyImport: 'İçe aktarılan bir kayıtta mock’lar çalışmaz.',
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı mock’ları desteklemiyor (eski bir sürüm ya da kapatılmış bir özellik).',
        storeBuild: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; bu derlemede SDK açık değil.',
        storeBuildIos: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; bu derlemede SDK açık değil.',
        releaseWithoutSdk: 'Mock’lar uygulamanın içinde, Dürbün SDK’sıyla çalışır; bu sürümde SDK açık değil.',
      },
      tools: {
        noSdk: ['Uygulama içi araçlar Dürbün SDK’sı ya da Flutter debug oturumu ister; {app} ikisiyle de bağlı değil.', 'Uygulama içi araçlar Dürbün SDK’sı ya da Flutter debug oturumu ister.'],
        notSeenYet: 'Uygulama içi araçlar, uygulama açılıp Dürbün SDK’sı ya da Flutter debug oturumuyla bağlanınca gelir.',
        notOwnApp: 'Uygulama içi araçlar yalnızca Dürbün SDK’sı ya da Flutter debug ile bağlanan kendi projelerinizde çalışır.',
        readOnlyDevice: 'Uygulama ve cihaz araçları, cihaz yeniden bağlanınca kullanılabilir.',
        readOnlyUntrusted: 'Uygulama ve cihaz araçları, iPhone’da “Güven”e dokunduktan sonra kullanılabilir.',
        readOnlyUntrustedAndroid: 'Uygulama ve cihaz araçları, cihazdaki “USB hata ayıklamaya izin verilsin mi?” sorusunu onayladıktan sonra kullanılabilir.',
        readOnlyImport: 'İçe aktarılan bir kayıtta araçlar kullanılamaz.',
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı uygulama içi araç sunmuyor.',
        storeBuild: 'Uygulama içi araçlar da SDK ister; bu derlemede SDK açık değil.',
        storeBuildIos: 'Uygulama içi araçlar da SDK ister; bu derlemede SDK açık değil.',
        releaseWithoutSdk: 'Uygulama içi araçlar SDK ya da Flutter debug oturumu ister; bu sürümde SDK açık değil.',
      },
      metrics: {
        noSdk: ['{app} için uygulamanın içinden metrik gelmiyor: Dürbün SDK’sı ya da Flutter debug oturumu bağlı değil.', 'Uygulamanın içinden metrik gelmiyor: Dürbün SDK’sı ya da Flutter debug oturumu bağlı değil.'],
        sdkLacksCapability: 'Bağlı Dürbün SDK’sı metrik göndermiyor.',
      },
      logs: {
        readOnlyDevice: 'Bağlantı kesilmeden önce gelen loglar ekranda; cihaz yeniden bağlanınca akış kaldığı yerden devam eder.',
      },
      crashes: {
        readOnlyDevice: 'Bağlantı kesilmeden önce okunan çökme kayıtları ekranda; yenileri cihaz yeniden bağlanınca okunur.',
      },
    },
    action: {
      openSdkGuide: 'SDK kurulumu',
      openDoctor: 'Sistem kontrolü',
      attachVm: 'Dart VM Service’e bağlan',
      useDebugBuild: 'Debug derlemesiyle dene',
      buildWithDurbunFlag: 'Release derlemesinde nasıl açılır?',
      addInterceptor: 'Interceptor satırını göster',
      startProcessMetrics: 'Süreç metriklerini başlat',
      launchApp: 'Uygulamayı başlat',
    },
    /** Starting an app from the explanations (device action app-launch). */
    launch: {
      failed: '{app} başlatılamadı',
      started: '{app} başlatılıyor…',
    },
    tip: {
      useDebugBuild: 'Aynı sürümü (ör. git etiketinden) flutter run ile debug olarak çalıştırırsanız loglar, ağ istekleri ve araçlar SDK eklemeden de gelir.',
      buildWithDurbunFlag: 'Release derlemesini --dart-define=DURBUN=true ile alırsanız SDK o derlemede açılır; Firebase, ad-hoc ya da mağaza derlemesi fark etmez.',
    },
    notRunningShort: 'Açık değil',
    running: 'Çalışıyor',
    lastSeen: 'Son görülme {ago}',
    crashReports: { one: '{count} çökme/ANR kaydı', other: '{count} çökme/ANR kaydı' },
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
      previousLaunch: 'İzlemeden önce çöktü',
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
    /** A scoped app that is not running (its device is online). */
    idle: {
      title: '{app} şu an açık değil',
      body: {
        logs: 'Açtığınızda logları burada akmaya başlar.',
        network: 'Açtığınızda ağ istekleri burada görünür.',
        metrics: 'Açtığınızda performans verisi burada görünür.',
        crashes: 'Açtığınızda çökmeleri burada görünür; cihazın kendi çökme kayıtları uygulama kapalıyken de okunur.',
        mocks: 'Kurallar, uygulama açılıp Dürbün’e bağlanınca uygulanır.',
        tools: 'Araçlar, uygulama açılıp Dürbün’e bağlanınca gelir.',
      },
    },
    /** ServerSettings.iosDeviceLogScope = 'apps': the server leaves out the iPhone's system processes. */
    iosScope: {
      title: 'iPhone’daki sistem süreçlerinin satırları gizli',
      titleFor: '{device}: sistem süreçlerinin satırları gizli',
      body: 'Yalnızca uygulamaların satırları ve çökmeyle ilgili sistem satırları geliyor. Hepsini görmek için Ayarlar › Loglar › iPhone log kapsamı › Tümü (yoğun bir telefonda saniyede ~1000 satır).',
      open: 'Ayarları aç',
    },
    empty: {
      network: {
        title: ['{app} için ağ istekleri görünmüyor', 'Ağ istekleri görünmüyor'],
        deviceTitle: 'Bu cihazda ağ isteklerini gönderebilen bir uygulama yok',
        device: 'Bu cihazdaki uygulamaların hiçbiri Dürbün SDK’sıyla ya da Flutter debug oturumuyla bağlı değil.',
      },
      metrics: {
        title: ['{app} için performans yalnızca dışarıdan ölçülür', 'Performans yalnızca dışarıdan ölçülür'],
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
        title: 'Cihaz logları: USB yeterli',
        body: 'Telefonu USB ile takmanız yeterli: Android’de logcat, iPhone’da cihaz logu, simülatörde birleşik log. Uygulamaya bir şey eklemeniz gerekmez; eski, Firebase ve mağaza sürümleri dahil her sürümde çalışır.',
      },
      appData: {
        title: 'Uygulamanın kendi verisi: SDK ya da Flutter debug',
        body: 'Yapılandırılmış loglar, ağ istekleri, mock’lar ve uygulama içi araçlar uygulamanın içinden gelir. Bunun için ya Dürbün SDK’sı ya da flutter run ile başlatılmış bir debug oturumu (Dart VM Service) gerekir.',
      },
      crashes: {
        title: 'Çökme kayıtları: cihazın kendisinden',
        body: 'Android’in dropbox kayıtları ve iOS’un .ips raporları her sürümde okunur; Dürbün bağlanmadan önceki çökmeler de “İzlemeden önce çöktü” olarak görünür. iOS .ips yığınları sembolsüzdür; Android’de Java/Kotlin yığınları okunur, yalnızca native (tombstone) yığınlar sembolsüzdür.',
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
        title: 'Release ve mağaza derlemeleri',
        body: 'SDK’nın hangi derlemede açık olacağına ekip karar verir: release derlemelerinde --dart-define=DURBUN=true ile açılır; Firebase, ad-hoc ve mağaza derlemeleri için de aynısı geçerli. SDK’sız bir mağaza sürümünde de cihaz logları ve çökme kayıtları görünür.',
      },
      matrix: {
        title: 'Hangi sürümde ne görünür? (Android, Flutter uygulaması)',
        caption: 'Hücreler, uygulama satırındaki “Neler görünüyor?” panelinin kullandığı kurallardan üretilir.',
        capability: 'Özellik',
        debug: 'Debug (flutter run)',
        internal: 'Firebase / iç test (SDK açık)',
        store: 'Mağaza (SDK kapalı)',
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
      idevicesyslog: 'The iPhone’s system log. Plug it in over USB and tap “Trust” on the iPhone.',
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
      'device-only': 'Nothing comes from inside the app: Dürbün only reads what the device records itself (logs, crashes). Network requests do not show up and mocks do not work.',
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
      'store-or-testflight': 'Store/TF',
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
      'vm-service': ['{app} is connected through a Flutter debug session: data comes from the Dart VM Service, no SDK needed.', 'Connected through a Flutter debug session: data comes from the Dart VM Service, no SDK needed.'],
      'device-only': [
        '{app} isn’t sending its own data to Dürbün (no SDK, or it is off in this build); Dürbün only reads what the device records.',
        'The app isn’t sending its own data to Dürbün (no SDK, or it is off in this build); Dürbün only reads what the device records.',
      ],
      notSeenYet: [
        '{app} has not connected to Dürbün yet: if it has the Dürbün SDK it connects by itself once it opens; otherwise you see what the device records (logs, crashes).',
        'The app has not connected to Dürbün yet: if it has the Dürbün SDK it connects by itself once it opens; otherwise you see what the device records (logs, crashes).',
      ],
      otherApp: ['For {app} you see only what the device shows from outside: its device log and crash records.', 'You see only what the device shows from outside: the device log and crash records.'],
      demo: 'Demo data: no real device or app.',
      import: 'An imported recording: only what was recorded is there.',
    },
    reasons: {
      noSdk: ['{appv} has not connected through the Dürbün SDK on this device.', 'This app has not connected through the Dürbün SDK.'],
      releaseWithoutSdk: ['{appv} {built} without the Dürbün SDK turned on.', 'This app {built} without the Dürbün SDK turned on.'],
      storeBuild: ['{appv} {built} without the Dürbün SDK turned on.', 'This app {built} without the Dürbün SDK turned on.'],
      noOutsideNetwork: {
        android: 'Network traffic cannot be read from outside the app: SSL pinning rejects a proxy’s certificate, and since Android 7 apps do not trust user-added certificates by default either.',
        ios: 'Network traffic cannot be read from outside the app: SSL pinning rejects a proxy’s certificate.',
        other: 'Network traffic cannot be read from outside the app: SSL pinning and the system’s certificate rules close the proxy route.',
      },
      vmServiceNoMocks: 'The Dart VM Service can watch requests but not change them; mocks run in the Dürbün SDK inside the app.',
      sdkLacksCapability: 'The connected Dürbün SDK does not send this (an older version or a disabled feature).',
      iosNoDeviceMetrics: 'An iPhone does not expose CPU, memory or FPS to other tools (only Xcode Instruments sees them); they can only be read from inside the app (SDK or Flutter debug).',
      frameStatsApproximate: 'CPU and memory are read from the device’s process list. FPS is measured from outside, approximately, and may not work on every device.',
      deviceLogsUnavailable: ['The device log of {device} is not coming in: {logs}.', 'The device log is not coming in: {logs}.', 'This device’s log is not coming in right now.'],
      toolMissing: 'A required tool was not found on this Mac; the system check shows how to install it.',
      releaseLogsDependOnApp: 'What a release build writes to the device log depends on the app’s logger; debug logs are often turned off.',
      nativeNetworkNeedsInterceptor: {
        sdk: 'Requests of the native (Kotlin) layer’s own OkHttp clients show up once .addInterceptor(DurbunInterceptor()) is added to them.',
        sdkAndroid: 'OkHttp requests show up once .addInterceptor(DurbunInterceptor()) is added to the client.',
        'vm-service': 'The Dart VM Service only sees Dart’s requests; the native (Kotlin / Swift) layer’s requests need the Dürbün SDK.',
      },
      thirdPartyTraffic: 'Requests third-party SDKs make with their own HTTP clients (analytics, ads…) may not show up.',
      crashesUnsymbolicated: 'Crash stacks read from the device are unsymbolicated (address + offset); this build’s dSYM / split-debug-info files make them readable.',
      notRunning: ['{app} is not running; data starts coming in when you open it.', 'The app is not running.'],
      notSeenYet: ['{appv} has not connected to Dürbün yet; if it has the Dürbün SDK, it connects by itself once it opens.', 'The app has not connected to Dürbün yet; if it has the Dürbün SDK, it connects by itself once it opens.'],
      notOwnApp: ['This can only be read from inside the app; if {app} isn’t one of your projects, Dürbün cannot reach it.', 'This can only be read from inside the app; if it isn’t one of your projects, Dürbün cannot reach it.'],
      readOnly: {
        device: ['{device} is not connected; what arrived before it disconnected stays on screen. It picks up where it left off once it reconnects.', 'The device is not connected; what arrived before it disconnected stays on screen. It picks up where it left off once it reconnects.'],
        import: 'This is an imported recording; nothing live can be done, only what was recorded is there.',
      },
      fpsNeedsApp: 'In the simulator, CPU and memory come from the Mac’s process list; FPS and janky frames can only be measured inside the app (SDK or Flutter debug).',
      networkOnly: 'The app is connected over the network; the device is not plugged in over USB, so there is no device log — only what the SDK sends.',
      deviceToolsAvailable: {
        default: 'Device tools (launch / stop the app, clear its data, screenshot) work without the SDK too.',
        iosDevice: 'Device tools (launch / stop the app, screenshot) work without the SDK too.',
        iosDeviceStore: 'Device tools (launch the app, screenshot) work without the SDK too; Dürbün cannot stop App Store or TestFlight apps from outside.',
      },
      sdkInStoreBuild: ['{appv} {built} with the Dürbün SDK turned on; the data comes from the SDK.', 'This app {built} with the Dürbün SDK turned on; the data comes from the SDK.'],
      storeBuildIos: ['{appv} {built} (iOS does not say which); the Dürbün SDK is not turned on in this build.', 'This app {built} (iOS does not say which); the Dürbün SDK is not turned on in this build.'],
      sdkInStoreBuildIos: [
        '{appv} {built} (iOS does not say which) with the Dürbün SDK turned on; the data comes from the SDK.',
        'This app {built} (iOS does not say which) with the Dürbün SDK turned on; the data comes from the SDK.',
      ],
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
        noSdk: ['{appv} has not connected through the Dürbün SDK; network requests can only be read from inside the app.', 'The app has not connected through the Dürbün SDK; network requests can only be read from inside the app.'],
        sdkLacksCapability: 'The connected Dürbün SDK does not send network requests (an older version or a disabled feature).',
        notSeenYet: ['Once {app} opens, its requests show up here if it has the Dürbün SDK.', 'Once the app opens, its requests show up here if it has the Dürbün SDK.'],
        notOwnApp: ['If {app} isn’t one of your projects, there is no way to reach its network requests.', 'If the app isn’t one of your projects, there is no way to reach its network requests.'],
      },
      mocks: {
        noSdk: ['Mocks are applied inside the app by the Dürbün SDK; {app} is not connected through the SDK.', 'Mocks are applied inside the app by the Dürbün SDK.'],
        notSeenYet: 'Mocks run inside the app with the Dürbün SDK; once the app opens they apply if it has the SDK.',
        notOwnApp: 'Mocks run inside the app with the Dürbün SDK; they only work in your own projects.',
        readOnlyDevice: 'Mocks only work in a connected app; the device is not connected right now.',
        readOnlyUntrusted: 'Mocks run in a connected app; tap “Trust” on the iPhone first.',
        readOnlyUntrustedAndroid: 'Mocks run in a connected app; accept the “Allow USB debugging?” prompt on the device first.',
        readOnlyImport: 'Mocks do not work in an imported recording.',
        sdkLacksCapability: 'The connected Dürbün SDK does not support mocks (an older version or a disabled feature).',
        storeBuild: 'Mocks run inside the app with the Dürbün SDK; it is not turned on in this build.',
        storeBuildIos: 'Mocks run inside the app with the Dürbün SDK; it is not turned on in this build.',
        releaseWithoutSdk: 'Mocks run inside the app with the Dürbün SDK; it is not turned on in this build.',
      },
      tools: {
        noSdk: ['In-app tools need the Dürbün SDK or a Flutter debug session; {app} is connected through neither.', 'In-app tools need the Dürbün SDK or a Flutter debug session.'],
        notSeenYet: 'In-app tools show up once the app opens and connects through the Dürbün SDK or a Flutter debug session.',
        notOwnApp: 'In-app tools only work in your own projects, connected through the Dürbün SDK or Flutter debug.',
        readOnlyDevice: 'App and device tools work again once the device reconnects.',
        readOnlyUntrusted: 'App and device tools work once you tap “Trust” on the iPhone.',
        readOnlyUntrustedAndroid: 'App and device tools work once you accept the “Allow USB debugging?” prompt on the device.',
        readOnlyImport: 'Tools cannot be used in an imported recording.',
        sdkLacksCapability: 'The connected Dürbün SDK offers no in-app tools.',
        storeBuild: 'In-app tools need the SDK as well; it is not turned on in this build.',
        storeBuildIos: 'In-app tools need the SDK as well; it is not turned on in this build.',
        releaseWithoutSdk: 'In-app tools need the SDK or a Flutter debug session; the SDK is not turned on in this build.',
      },
      metrics: {
        noSdk: ['No metrics come from inside {app}: no Dürbün SDK or Flutter debug session is connected.', 'No metrics come from inside the app: no Dürbün SDK or Flutter debug session is connected.'],
        sdkLacksCapability: 'The connected Dürbün SDK does not send metrics.',
      },
      logs: {
        readOnlyDevice: 'Logs that arrived before the disconnect stay on screen; the stream picks up again once the device reconnects.',
      },
      crashes: {
        readOnlyDevice: 'Crash records read before the disconnect stay on screen; new ones are read once the device reconnects.',
      },
    },
    action: {
      openSdkGuide: 'Set up the SDK',
      openDoctor: 'System check',
      attachVm: 'Attach the Dart VM Service',
      useDebugBuild: 'Try a debug build',
      buildWithDurbunFlag: 'How to turn it on in a release build',
      addInterceptor: 'Show the interceptor line',
      startProcessMetrics: 'Start process metrics',
      launchApp: 'Launch app',
    },
    launch: {
      failed: '{app} could not be launched',
      started: 'Launching {app}…',
    },
    tip: {
      useDebugBuild: 'Run the same version (e.g. from its git tag) as a debug build with flutter run: logs, network requests and tools come in even without adding the SDK.',
      buildWithDurbunFlag: 'Build the release with --dart-define=DURBUN=true and the SDK is on in that build — Firebase, ad hoc or store alike.',
    },
    notRunningShort: 'Not running',
    running: 'Running',
    lastSeen: 'Last seen {ago}',
    crashReports: { one: '{count} crash/ANR record', other: '{count} crash/ANR records' },
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
      previousLaunch: 'Crashed before watching',
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
    idle: {
      title: '{app} is not running',
      body: {
        logs: 'Its logs show up here once you open it.',
        network: 'Its network requests show up here once you open it.',
        metrics: 'Its performance data shows up here once you open it.',
        crashes: 'Its crashes show up here once you open it; the device’s own crash records are read while the app is closed too.',
        mocks: 'Rules apply once the app opens and connects to Dürbün.',
        tools: 'Tools show up once the app opens and connects to Dürbün.',
      },
    },
    iosScope: {
      title: 'iPhone system process lines are hidden',
      titleFor: '{device}: system process lines are hidden',
      body: 'Only app lines and crash-related system lines come in. To see everything: Settings › Logs › iPhone log scope › Everything (about 1000 lines a second on a busy phone).',
      open: 'Open settings',
    },
    empty: {
      network: {
        title: ['No network requests for {app}', 'No network requests'],
        deviceTitle: 'No app on this device can send network requests',
        device: 'None of the apps on this device is connected with the Dürbün SDK or a Flutter debug session.',
      },
      metrics: {
        title: ['Performance of {app} is measured from outside only', 'Performance is measured from outside only'],
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
        title: 'Device logs: USB is enough',
        body: 'Plug the phone in over USB: logcat on Android, the device log on an iPhone, the unified log in the simulator. Nothing to add to the app; works for every build, including old, Firebase and store builds.',
      },
      appData: {
        title: 'The app’s own data: SDK or Flutter debug',
        body: 'Structured logs, network requests, mocks and in-app tools come from inside the app. That takes either the Dürbün SDK or a debug session started with flutter run (Dart VM Service).',
      },
      crashes: {
        title: 'Crash records: from the device itself',
        body: 'Android’s dropbox records and iOS’s .ips reports are readable for every build; crashes from before Dürbün connected show up as “Crashed before watching”. iOS .ips stacks are unsymbolicated; on Android, Java/Kotlin stacks are readable and only native (tombstone) stacks are unsymbolicated.',
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
        title: 'Release and store builds',
        body: 'Your team decides which builds have the SDK: in release builds it turns on with --dart-define=DURBUN=true, and that goes for Firebase, ad-hoc and store builds alike. A store build without the SDK still shows its device logs and crash records.',
      },
      matrix: {
        title: 'What shows up for which build? (Android, a Flutter app)',
        caption: 'The cells come from the same rules the “What can I see?” panel of an app row uses.',
        capability: 'Feature',
        debug: 'Debug (flutter run)',
        internal: 'Firebase / internal (SDK on)',
        store: 'Store (SDK off)',
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
 * `short`: the narrow sidebar form ("Store/TF"), when there is one.
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
    case 'nativeNetworkNeedsInterceptor': {
      const variant = ctx?.transport === 'vm-service' ? 'vm-service' : ctx?.sdkPlatform === 'android' ? 'sdkAndroid' : 'sdk';
      return t(`sources.reasons.nativeNetworkNeedsInterceptor.${variant}`, params);
    }
    case 'readOnly': {
      // Each row says what stays readable (or why it waits for a reconnect); the app-level note says it once.
      const kind = ctx?.transport === 'import' ? 'import' : 'device';
      // Plugged in but waiting for "Trust" / the USB debugging prompt: say what enables the row, not "not connected".
      if (capability && kind === 'device' && ctx?.deviceState === 'unauthorized') {
        const untrusted = `sources.reasonFor.${capability}.readOnlyUntrusted${ctx.platform === 'android' ? 'Android' : ''}`;
        if (hasMessage(untrusted)) return t(untrusted, params);
      }
      const own = capability ? `sources.reasonFor.${capability}.readOnly${kind === 'import' ? 'Import' : 'Device'}` : '';
      return own && hasMessage(own) ? t(own, params) : t(`sources.reasons.readOnly.${kind}`, params);
    }
    case 'storeBuild':
    case 'sdkInStoreBuild':
      return t(`sources.reasons.${reason}${ios}`, params);
    case 'crashReportsUnavailable':
      return readerText(ctx?.readers?.crashReports, reason);
    case 'frameStatsUnavailable':
      return readerText(ctx?.readers?.frameStats, reason);
    case 'deviceToolsAvailable': {
      // Physical iPhones: no "clear data", and devicectl stops developer (Xcode) builds only.
      const variant = ctx?.platform !== 'ios-device' ? 'default' : ctx.install === 'xcode' || ctx.build === 'xcode' ? 'iosDevice' : 'iosDeviceStore';
      return t(`sources.reasons.deviceToolsAvailable.${variant}`, params);
    }
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
  if (badge === 'device-only' && ctx) {
    // Not one of the team's apps: what the device shows from outside, no talk of SDKs.
    if (ctx.own === false) return t('sources.summary.otherApp', reasonParams(ctx));
    // Never ran while watched: whether it has the SDK is unknown (any build may have it, store builds included).
    if (ctx.unseen) return t('sources.summary.notSeenYet', reasonParams(ctx));
  }
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
