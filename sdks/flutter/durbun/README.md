# Dürbün — Flutter SDK (`durbun`)

> 🇹🇷 Türkçe aşağıda · 🇬🇧 [English below](#english)

Dürbün, cihaz Mac'e takılıyken (veya simülatör/emülatörde) uygulamanın **tüm
loglarını, hatalarını ve ağ trafiğini** tek bir canlı ekranda gösteren masaüstü
aracıdır. Bu paket uygulamanın içinden Dürbün'e veri gönderir. Bir **Flutter
plugin'idir**: Dart tarafının yanında Android (Kotlin) ve iOS (Swift) native
katmanlarını da taşır. Tek kurulum hem Flutter hem native katmanı kapsar;
katman başına ayrı SDK kurmanız gerekmez.

## Kurulum: 2 adım

**1. `pubspec.yaml`**

```yaml
dependencies:
  durbun:
    path: ../durbun/sdks/flutter/durbun   # Dürbün reposunun bulunduğu yere göre
    # veya git ile:
    # git:
    #   url: <dürbün-repo-adresi>
    #   path: sdks/flutter/durbun
```

**2. `main.dart`**

```dart
import 'package:durbun/durbun.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized(); // zone içinde çağırın
    runApp(const MyApp());
  });
}
```

Bu kadar. Native tarafta başlatma kodu yok: Dart tarafı çalıştığında Android
ve iOS katmanlarını kendisi başlatır, kapalıyken onlar da kapalı kalır.
`Durbun.start()` gibi native bir çağrı gerekmez; kodunuzda kalmışsa Flutter
uygulamasında hiçbir şey yapmaz (plugin'i görür, işi Dart tarafına bırakır).
Böylece ayrı bir native oturum açılmaz ve `DURBUN=false` native katmanı da
kapalı tutar.

**İsteğe bağlı, Android'de OkHttp kullanan native kodunuz varsa tek satır:**

```kotlin
import dev.durbun.DurbunInterceptor

val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())   // ← bu satır
    .build()
```

Dürbün kapalıyken (release) bu interceptor isteği hiç dokunmadan geçirir.
iOS'ta URLSession trafiği (paylaşılan ve kendi oturumlarınız, Alamofire,
cupertino_http) **otomatik** yakalanır, ek satır gerekmez.

`Durbun.run` bir zone açar: `print` çıktılarını ve yakalanmamış hataları da alır.
Zone istemiyorsanız:

```dart
Future<void> main() async {
  await Durbun.init();
  runApp(const MyApp());
}
```

Bu durumda yalnızca `debugPrint` yakalanır, zone hataları `PlatformDispatcher.onError`
üzerinden gelir. Kendi `HttpOverrides.global`'ınız varsa onu `Durbun.init()`'ten
**önce** atayın: sonradan atanan override ~2 sn içinde zincirlenir, o arada
oluşturulan `HttpClient`'lar (ör. Dio'nun ilk istekte sakladığı istemci) yakalanmaz.
`Durbun.run` içinde bu sınırlama yoktur: zone içindeki her `HttpClient`, o anki
global override'ı sorup sarılır.

`ensureInitialized()` zone'un **dışında** çağrıldıysa (ör. `Durbun.run`'dan önce
`await Firebase.initializeApp()` için), `Durbun.run` zone açmaz — Flutter'ın
"Zone mismatch" hatası çıkmasın diye — ve `init` gibi çalışır: `print` yakalanmaz
(yalnızca `debugPrint`), konsola bir kez not düşülür. `print` de yakalansın
istiyorsanız Firebase dahil her şeyi gövdenin içine alın:

```dart
Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized();
    await Firebase.initializeApp();
    runApp(const MyApp());
  });
}
```

## Uygulama içi panel (Mac'siz)

Telefonun kendisinde de her şeyi görmek için `MaterialApp`'e tek satır ekleyin
(`MaterialApp.router` / go_router, `CupertinoApp` ve `WidgetsApp` için de aynı satır):

```dart
MaterialApp(
  builder: DurbunInspector.builder,   // ← bu satır
  home: const HomePage(),
);
```

Uygulamanın üstüne hiçbir şey çizilmez: **telefonu sallayınca** panel açılır
(iOS simülatörde *Device → Shake*, Android emülatörde *Extended controls →
Virtual sensors → Shake*). Mac'e bağlı olmak gerekmez, testçi telefonda kendi başına bakabilir. Panel
masaüstü Dürbün'ün tasarımını (aynı renkler, seviye ve durum renkleri, etiket
renkleri, açık/koyu tema) ve sekmelerini taşır:

- **Loglar:** canlı akış (en yenisi altta, yukarı kaydırınca durur, "↓ N yeni"
  ile döner), V D I W E seviye düğmeleri, *Sadece hatalar · Çökmeler · Ağ ·
  Olaylar · Flutter · Native* hızlı filtreleri, masaüstündeki sorgu dili
  (`tag:auth -tag:frame level:warn is:crash`), art arda aynı satırların `×N`
  olarak birleşmesi, akış içinde istek satırları. Ayrıntıda mesaj, açılıp
  kapanan veri ağacı, uygulama satırları öne çıkan yığın izi, "yalnızca bu
  etiket / bu etiketi gizle".
- **Ağ:** dart:io, `package:http`, Dio, OkHttp ve URLSession tek tabloda: durum,
  metot, yol (sorgu soluk), host, kaynak, boyut, süre (yavaşlar sarı/kırmızı),
  GraphQL işlemi, mock ve hata etiketi ("DNS çözümlenemedi" gibi). Metot ve
  durum düğmeleri, *Sadece hatalar · Yavaş ≥ 1 sn · Mock'lananlar*, host seçimi,
  `status:4xx method:post host:api is:slow` sorguları ve gövdelerde arama.
  Ayrıntıda Genel / İstek / Yanıt / Zamanlama sekmeleri; gövde için aranabilir
  JSON ağacı, Kod ve Hex görünümü, görsel önizleme; başlıklar, çerezler ve sorgu
  parametreleri; DNS, bağlantı, TLS, TTFB çubukları; **Tekrar gönder** ve
  **Farklı kopyala** (cURL, fetch, Dart dio, Swift, Kotlin). **Paylaş** isteği
  ekibin Dürbün olmadan okuyabileceği bir rapora çevirir (URL, durum, iz
  kimlikleri, başlıklar, gövdeler, cURL; gizli değerler varsayılan olarak
  `••••`) ve sistem paylaşım sayfasını açar ya da panoya kopyalar. Masaüstü
  aynı raporu üretir.
- **Mock'lar:** masaüstünden gelen kurallar ve kaç kez uygulandıkları.
- **Performans:** FPS, takılan kare, build/raster, bellek, heap, CPU kutucukları;
  FPS, kare süresi ve bellek grafikleri.
- **Cihaz:** uygulama, cihaz, yakalanan katmanlar (Dart / Kotlin / Swift),
  masaüstü bağlantısı ve "Neler görünüyor?": her veri kaynağının açık olup
  olmadığı ve değilse nedeni.

Panel, masaüstünün aldığı mesajların aynısını gösterir. Masaüstü bağlıyken
ikisi birlikte çalışır. Uygulamanın kendi native logları (Android logcat'i,
iOS 15+ `os_log` / `Logger` / `NSLog`) Mac'e bağlı olmasa da panelde görünür;
host uygulamada ayar gerekmez. Masaüstü bunları USB'de cihazdan kendisi okur,
satırlar iki kez gelmez. Alttaki durum çubuğu bağlantıyı ve log, hata, istek
sayılarını gösterir.

Sınırlar ve ayarlar:

- Telefonda son 2.000 log satırı, 1.000 istek ve toplam 24 MB gövde tutulur.
  Sınır dolunca en eskiler silinir ve panel bunu söyler. `defaultHosts`
  verildiyse önce panelde gizli hostlara giden istekler (ve gövdeleri) silinir.
  Sınırları değiştirmek için:
  `DurbunInspector(maxRequests: 2000, maxLogs: 5000, maxBodyBytes: 48 << 20, child: child!)`.
- Paneli kendi debug menünüzden ya da bir düğmeden de açabilirsiniz:
  `Durbun.showInspector()`. Sallamayı kapatmak için `openOnShake: false`,
  ekranda küçük bir Dürbün düğmesi istiyorsanız `showBubble: true` verin.
- Sallama algılama yalnızca uygulama öndeyken çalışır. Android'de ivme sensörü
  okunur (izin gerekmez), iOS'ta sistemin sallama hareketi kullanılır (izin
  gerekmez).
- SDK'yı güncelledikten sonra iOS'ta bir kez `cd ios && pod install` çalıştırın
  (plugin'e yeni dosya eklendiğinde CocoaPods projesi yenilenmeli).
- Telefonda hiçbir şey tutulmasın istiyorsanız `DurbunOptions(inspector: false)`
  verin.
- Panelde yalnızca kendi API'lerinizin görünmesi için varsayılan hostları verin:
  `DurbunInspector(defaultHosts: ['api.ornek.com', '*.ornek.com'], child: child!)`.
  Başka hostlara giden istekler (analitik, Firebase Storage …) yine yakalanır ve
  masaüstüne gider; panelde gizlenir, filtre satırında "N istek başka hostta"
  yazar ve Ağ → Filtreler → Hostlar'dan işaretlenince görünür. Liste boşsa
  bütün hostlar gösterilir.
- İstek ve yanıt gövdesinde (önizleme ve kod) **Gövdede bul**: eşleşme sayısı,
  önceki/sonraki ve eşleşmeye kaydırma. Ağ listesinde "Gövdelerde de ara"
  açıkken bir isteğe girince arama gövdede dolu açılır.
- Panel uygulamanın navigator'ında tek bir `/durbun` rotası olarak açılır.
  Ayrıntı sayfaları, alt sayfalar, menüler ve "Kopyalandı" bildirimleri panelin
  kendi navigator'ında ve `ScaffoldMessenger`'ında kalır: uygulamanın route
  observer'ları (analitik, Sentry) yalnızca `/durbun`'u görür, uygulamanın
  snack bar'larına dokunulmaz. Geri tuşu önce paneldeki sayfayı, sonra paneli
  kapatır. Başka bir navigator için `DurbunInspector(navigatorKey: …)` verin.
- Filtreler, arama ve son açılan sekme panel kapanıp açılınca korunur. Ağ
  listesinde **Duraklat** yeni istekleri bekletir; yukarı kaydırılmış listede
  okunan satırlar, eski kayıtlar silinse de yerinden oynamaz. *Kayıtları
  temizle* önce onay ister. Panel açıkken sallama dinlenmez.
- Dürbün'ün kapalı olduğu derlemelerde (`DURBUN=false`, ya da define verilmemiş
  bir release) panel açılmaz, sallama dinlenmez; widget yalnızca uygulamayı çizer.

## Release, Firebase ve mağaza derlemeleri

Bir derlemenin Dürbün'ü çalıştırıp çalıştırmayacağına proje karar verir; mağaza
derlemeleri de buna dahildir. SDK uygulamanın nereden kurulduğuna bakmaz.

| Derleme | Dürbün |
|---|---|
| `flutter run` (debug), profile | **Açık**, kendiliğinden |
| Release | **Kapalı.** Soket açılmaz, kanca kurulmaz, native katman başlatılmaz. Dart kodu derleyicinin ağaç sarsmasıyla (tree shaking) neredeyse tamamen düşer |
| Release + `--dart-define=DURBUN=true` | **Açık**, nereden kurulursa kurulsun (Firebase, ad-hoc, TestFlight, Google Play, App Store…) |
| `--dart-define=DURBUN=false` | Her modda kapalı (ör. profile ölçümü) |
| `DurbunOptions(enabled: true/false)` | Her şeyin önüne geçer |

```bash
# Dürbün açık release:
flutter build apk --release --dart-define=DURBUN=true
flutter build ipa --release --dart-define=DURBUN=true
# Firebase App Distribution / ad-hoc dağıtımı için .ipa:
flutter build ipa --release --export-method ad-hoc --dart-define=DURBUN=true
# Dürbün kapalı release (define yok):
flutter build appbundle --release
flutter build ipa --release
```

- Aynı define `flutter build appbundle` ve `flutter run --release` ile de verilir.
- iOS: Flutter define'ları `ios/Flutter/Generated.xcconfig` dosyasına yazar ve
  Xcode Archive bu dosyayı kullanır. `--dart-define=DURBUN=true` ile yapılan bir
  `flutter build`'den sonra Xcode'da alınan Archive, define'sız bir sonraki
  `flutter build`'e kadar `DURBUN=true` ile derlenir.
- Firebase ve mağaza aynı binary'yi alıyorsa define o binary'nin her kurulumunda
  Dürbün'ü açar. Define'sız bir binary'de de Dürbün masaüstü cihazın verdiği her
  şeyi gösterir (cihaz logları, çökme kayıtları, Android süreç/kare
  istatistikleri) ve ağ/mock'un neden görünmediğini açıklar.
- Flavor başına karar için define'ı ilgili flavor'ın derleme komutuna ekleyin ya da
  `DurbunOptions(enabled: appFlavor == 'qa')` yazın.
- Android: release'de Dürbün açıkken ana manifestte `INTERNET` izni gerekir (ağ
  kullanan her uygulamada zaten vardır; plugin kendisi izin eklemez).
- Boyut (Flutter 3.38, sayaç uygulaması, başka bir plugin'i zaten olan uygulamaya
  eklenince, DURBUN kapalı release): Android arm64 APK **+34 KB**; iOS `.app`
  **+868 KB** sıkıştırılmamış / **+278 KB** zip (`durbun.framework`; mağaza
  dağıtımında semboller ayıklanınca küçülür).

## Veriler nereden gelir?

Hepsi uygulamanın içinden ve **tek bağlantıdan** gider; masaüstünde tek bir
uygulama oturumu ("SDK" rozeti) olarak görünür. Araya proxy girmez, bu yüzden
SSL pinning'e dokunulmaz.

| Kaynak | Ne gönderir | Ne zaman |
|---|---|---|
| Dart SDK (bu paket) | Dart logları, `print`, Flutter hataları, Dart çökmeleri, dart:io HTTP (package:http, Dio varsayılan adaptörü, `NetworkImage`), FPS/jank/bellek, `flutter.*` araçları | Dürbün açıkken |
| Android native katmanı (bu plugin içinde) | Kotlin/Java `Durbun.log`, yakalanmamış Kotlin/Java çökmeleri, OkHttp (`DurbunInterceptor` ile), uygulamanın kendi logcat'i (`Log.d` vb.; panelde her zaman, masaüstüne yalnızca adb yokken, ör. Wi-Fi), `android.dumpThreads` / `android.gc` araçları | Dart tarafı başlatınca |
| iOS native katmanı (bu plugin içinde) | URLSession trafiği (otomatik), Objective-C istisnaları ve Swift çökmeleri, Swift `print`/stdout/stderr, `Durbun.log` (Swift), iOS 15+ `os_log` / `Logger` / `NSLog` (panelde her zaman, masaüstüne yalnızca cihaz loglarını okuyamıyorsa, ör. Wi-Fi), `ios.*` araçları | Dart tarafı başlatınca |
| SDK'sız (eski build, Dürbün kapalı release) | Cihaz logları, sistem çökme kayıtları, Android süreç/kare istatistikleri — masaüstü bunları cihazdan okur | Her zaman |

Native çökmeler: Android'de çökme anında doğrudan masaüstüne gider; masaüstüne
o an ulaşılamazsa bir sonraki açılışta **"Previous launch crashed — …"** olarak
gelir. iOS'ta ana thread dışındaki istisnalar anında, ana thread'deki istisnalar
ve sinyal çökmeleri (force-unwrap, EXC_BAD_ACCESS) bir sonraki açılışta
**"Crash in previous launch: …"** olarak gelir.

Native koddan log:

```kotlin
import dev.durbun.Durbun
Durbun.i("payment", "3DS tamamlandı", data = mapOf("orderId" to 42))
```

```swift
import durbun
Durbun.info("3DS tamamlandı", tag: "payment", data: ["orderId": 42])
```

## Kod içinden log ve event (Dart)

```dart
Durbun.log('Kullanıcı giriş yaptı', tag: 'auth', data: {'userId': 42});
Durbun.d('Önbellek ısındı');            // v / d / i / w / e / f
Durbun.e('Ödeme başarısız', error: e, stackTrace: st);
Durbun.i({'sepet': [1, 2, 3]});         // Map/List → JSON (masaüstünde ağaç)
Durbun.event('purchase', {'amount': 49.9});
```

Bağlantı durumu: `Durbun.isConnected`, `Durbun.connectionState`,
`Durbun.connection` (stream). Masaüstüne kendi butonunuzu ekleyin:

```dart
Durbun.addAction(DurbunAction.button(
  id: 'app.clearCache',
  label: 'Önbelleği temizle',
  onPressed: (_) async => cache.clear(),
));
```

### Mevcut log paketiniz varsa

`print` ile yazan paketler zaten yakalanır. Seviye ve tag'lerin korunması için
`package:logging` kayıtlarını doğrudan iletin:

```dart
Logger.root.level = Level.ALL;
Logger.root.onRecord.listen((r) => Durbun.log(
  r.message,
  tag: r.loggerName,
  error: r.error,
  stackTrace: r.stackTrace,
  level: r.level >= Level.SHOUT ? DurbunLogLevel.fatal
       : r.level >= Level.SEVERE ? DurbunLogLevel.error
       : r.level >= Level.WARNING ? DurbunLogLevel.warn
       : r.level >= Level.INFO ? DurbunLogLevel.info
       : r.level >= Level.FINE ? DurbunLogLevel.debug
       : DurbunLogLevel.verbose,
));
```

## Dart tarafında neler yakalanır?

| Kaynak | Nasıl | Masaüstünde |
|---|---|---|
| `Durbun.log/v/d/i/w/e/f` | doğrudan | seviye, tag, `data` (JSON), hata + stack trace |
| `print` / `debugPrint` | zone (`run`) veya `debugPrint` kancası (`init`) | `flutter` tag'li info log — **yalnızca** masaüstü cihaz loglarını göremiyorsa (`capturePrint: auto`), böylece satırlar iki kez görünmez |
| `FlutterError.onError` | önceki handler korunarak zincirlenir | `flutter-error`: hata kutusunun tamamı (`══╡ EXCEPTION CAUGHT BY …`) |
| Yakalanmamış hatalar | zone + `PlatformDispatcher.onError` | `crash` (fatal), stack trace ile; hata ayrıca eski yerine iletilir |
| HTTP (dart:io) | `HttpOverrides.global` sarmalayıcısı (önceki override zincirlenir) | istek/yanıt, başlıklar, gövdeler (gzip çözülmüş), süreler, redirect (her adım ayrı satır, URLSession'daki gibi), iptal, hata. `package:http`, Dio'nun varsayılan adaptörü, `NetworkImage`, WebSocket el sıkışması dahil |
| Event'ler | `Durbun.event` | log akışında event satırı |
| Metrikler | `SchedulerBinding.addTimingsCallback`, `ProcessInfo.currentRss`, `getrusage` | FPS (çizim sırasında), janky frame, ortalama build/raster ms, bellek MB, CPU %, thread (Android) |
| Komutlar | masaüstü → uygulama | `flutter.debugPaint`, `repaintRainbow`, `slowAnimations`, `performanceOverlay`, `invertOversizedImages`, `brightness`, `platform`, `dumpWidgetTree`, `dumpRenderTree` + sizin `DurbunAction`'larınız |

Mock kuralları (masaüstünde **Mock'lar** sekmesi): `respond` → ağa hiç çıkmadan
sahte yanıt (yanıtta `x-durbun-mock` başlığı), `delay` → bekleyip gerçek isteği
yapar, `fail` → platformun doğal hatası (`SocketException` "Connection refused" /
"Failed host lookup", `HandshakeException`, "timed out" — Dio bunu
`connectionTimeout` olarak tanır).

## USB mi, Wi-Fi mı?

- **Android (USB/emülatör):** hiçbir ayar gerekmez. Masaüstü `adb reverse tcp:9751`
  kurar, SDK `127.0.0.1:9751`'e bağlanır (emülatörde yedek olarak `10.0.2.2`).
- **iOS simülatör:** ayar gerekmez (simülatör Mac'in `127.0.0.1`'ini kullanır).
- **iOS fiziksel cihaz (USB):** ayar gerekmez. SDK cihazda `127.0.0.1:9752–9755`
  portlarından birini dinler, masaüstü usbmux üzerinden bağlanır.
- **Wi-Fi:** Mac'in IP adresini verin:
  `DurbunOptions(host: '192.168.1.20')` veya
  `flutter run --dart-define=DURBUN_HOST=192.168.1.20`.
  Masaüstünde LAN erişimini açın (`durbun --lan`). iOS 14+ için
  `ios/Runner/Info.plist` dosyasına yerel ağ izni metni ekleyin:

  ```xml
  <key>NSLocalNetworkUsageDescription</key>
  <string>Dürbün geliştirici aracına bağlanmak için</string>
  ```

Bağlantı yoksa SDK son 5 000 mesajı bekletir, 0,5 sn → 3 sn aralıklarla yeniden
dener, bağlanınca sırayla gönderir (taşan mesaj sayısını bir uyarı satırıyla bildirir).
Masaüstü hiç bağlanmadıysa ya da 30 sn'den uzun süredir yoksa bekleyen mesajlar
en fazla ~8 MB yer tutar: aşınca en eski gövdeler atılır (istek satırları ve
loglar kalır, gövde "kesildi" görünür). Uygulama içi panelin kendi kopyası
bundan etkilenmez.
Masaüstü yokken istekler beklemez; yalnızca bir masaüstü bağlantıyı kabul etmiş
ve el sıkışma sürerken (mock kuralları yoldayken) en fazla 0,8 sn bekler.

## Release güvenliği

- Varsayılanlar yukarıdaki tabloda. `flutter test` içinde de kapalıdır
  (`enabled: true` ile açılır).
- SDK uygulamaya asla hata fırlatmaz; tüm iç hatalar yutulur (native katman dahil).
- JSON kodlama, gövde base64/gzip işlemleri ve soket I/O arka plan isolate'ta
  çalışır; kuyruklar sınırlıdır (5 000 mesaj, ~48 MB; masaüstü yokken gövdeler için ~8 MB),
  gövdeler `maxBodyBytes` (varsayılan 1 MB, en fazla 10 MB) ile kesilir; gzip
  gövdeler de bu sınırda açılmayı bırakır. Native katmanın mesajları Dart'a küçük paketler
  hâlinde, sınırlı bir tamponla iletilir.
- Web'de ve masaüstü platformlarda native katman yoktur; Dart tarafı çalışır.
- Hot restart: native katman yeni oturumla yeniden başlar.
- Bağlantı koptuğunda o bağlantının gönderdiği mock kuralları her katmanda
  (Dart, OkHttp, URLSession) hemen silinir; masaüstü yeniden bağlanınca
  kurallarını tekrar gönderir. Bağlantı yokken yapılan istekler gerçek sunucuya
  gider.
- **Güvenlik notu:** masaüstü ile SDK arasında henüz eşleştirme (pairing) yok.
  Dürbün açık bir derleme, cihazın loopback portunda karşısına çıkan eşle konuşur
  (Android: `127.0.0.1:9751`'e bağlanır; iOS cihaz: `127.0.0.1:9752–9755`'i
  dinler). O eş, adb reverse / usbmux üzerinden masaüstü ya da cihazdaki başka bir
  uygulama olabilir; loglar ve ağ trafiği ona gider, bağlı kaldığı sürece
  gönderdiği mock kuralları uygulanır.

## Seçenekler (`DurbunOptions`)

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `enabled` | `null` | `null`: debug/profile açık, release yalnızca `--dart-define=DURBUN=true` ile; `true`/`false` her şeyi ezer |
| `host` / `port` | `null` / `9751` | Wi-Fi için masaüstü adresi (`'ip'` veya `'ip:port'`) |
| `captureNetwork` | `true` | dart:io HTTP yakalama + mock'lar (iOS'ta URLSession, Android'de OkHttp yakalamayı da açar/kapatır) |
| `capturePrint` | `auto` | `auto` / `always` / `never` (`never` native stdout'u ve logcat / `os_log` okumayı da kapatır; panelde de görünmezler) |
| `captureErrors` | `true` | Flutter hataları ve çökmeler (native çökmeler dahil) |
| `metrics` | `true` | FPS, jank, bellek, CPU |
| `maxBufferedMessages` | `5000` | bağlantı yokken tutulan mesaj sayısı |
| `redactHeaders` | `[]` | değeri gizlenecek başlıklar, ör. `['authorization']` — OkHttp ve URLSession istekleri dahil; değer her katmanda `••••` görünür |
| `appId` / `appName` / `appVersion` | otomatik | Android'de sürüm/derleme numarasını artık native katman okur; yalnızca ezmek için verin |
| `waitForDesktop` | `0` | `run` uygulamayı başlatmadan önce bu kadar bekler (açılıştaki isteklere mock uygulansın diye); verilmezse istekler masaüstünü beklemez |
| `listenForUsb` | `true` | iOS cihazda usbmux dinleyicisi |
| `useBackgroundIsolate` | `true` | taşıma katmanı arka plan isolate'ta |
| `inspector` | `true` | uygulama içi panel için son logları, istekleri ve ölçümleri telefonda tutar (`DurbunInspector`) |

## Sınırlar

- Android'de **cronet_http / Dio `NativeAdapter`** dart:io'yu ve OkHttp'yi
  kullanmaz → Dio için `durbun_dio` paketindeki
  `DurbunDioInterceptor(dio: dio)`'yu **en son** interceptor olarak ekleyin. iOS'ta
  bunlar URLSession üzerinden native katmanca yakalanır (`DurbunDioInterceptor`
  o istekleri ikinci kez bildirmez).
- **Yakalanmayanlar:** Android'de package:http'nin `CronetClient`'ı ve
  `package:ok_http` (kendi OkHttp istemcisini kurar, `DurbunInterceptor`
  eklenemez); her platformda gRPC (`package:grpc`, HTTP/2'yi kendi soketiyle
  konuşur) ve doğrudan `Socket` kullanan kod. Bunları `DurbunNetwork.begin` ile
  kendiniz raporlayabilirsiniz (aşağıdaki örnek).
- dart:io'nun kendiliğinden izlediği redirect'lerde ara adımların yalnızca durum
  kodu ve `location` başlığı bilinir; mock kuralları ara adımlara uygulanmaz.
- Arka plan isolate'larındaki (`compute`, `Isolate.run`) Dart HTTP istekleri ve
  loglar yakalanmaz (her isolate'ın kendi `HttpOverrides`'ı vardır).
- `Durbun.run/init`'ten **önce** oluşturulmuş `HttpClient`'lar sarılmaz.
- WebSocket: yalnızca el sıkışma (101) görünür, mesajlar görünmez.
- `dart:developer` `log()` çağrıları SDK'dan değil, masaüstünün Dart VM Service
  bağlantısından (debug) gelir.
- FPS yalnızca çizim yapılırken raporlanır (boşta bekleyen uygulama "0 FPS" görünmez).
- iOS `os_log` / `Logger` / `NSLog` satırları uygulamanın kendi log deposundan
  birkaç saniyede bir okunur (panel açıkken ya da masaüstüne giderken saniyede bir).
  iOS `debug` seviyesini depoda tutmaz, bu satırlar panelde görünmez; iOS 13–14'te
  bu kaynak yoktur. `com.apple.*` sistem satırları atlanır.
- Aynı süreçte birden fazla Flutter engine varsa native katmanı yalnızca ilk
  başlatan engine kullanır.
- Native-only (Flutter'sız) uygulamalar `sdks/android` ve `sdks/ios` SDK'larını
  kullanır; Flutter uygulamasına ikisini ayrıca eklemeyin (sınıflar çakışır).

### Yakalanmayan istemcileri elle raporlamak

package:http istemcileri (ör. `CronetClient`, `OkHttpClient`) için küçük bir
sarmalayıcı yeter (Dürbün kapalıyken `begin` null döner ve hiçbir şey yapmaz).
Yanıt gövdesini bir kez belleğe alır; büyük indirmelerde kullanmayın:

```dart
import 'package:durbun/durbun.dart';
import 'package:http/http.dart' as http;

class DurbunReportingClient extends http.BaseClient {
  DurbunReportingClient(this._inner, {this.source = 'cronet'});
  final http.Client _inner;
  final String source;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final call = DurbunNetwork.begin(
      method: request.method,
      url: request.url,
      headers: [for (final h in request.headers.entries) [h.key, h.value]],
      body: request is http.Request ? request.bodyBytes : null,
      contentType: request.headers['content-type'],
      source: source,
    );
    if (call == null) return _inner.send(request);
    try {
      final response = await _inner.send(request);
      final bytes = await response.stream.toBytes();
      call.response(
        status: response.statusCode,
        statusText: response.reasonPhrase,
        headers: [for (final h in response.headers.entries) [h.key, h.value]],
        body: bytes,
        contentType: response.headers['content-type'],
      );
      return http.StreamedResponse(
        http.ByteStream.fromBytes(bytes),
        response.statusCode,
        contentLength: bytes.length,
        request: response.request,
        headers: response.headers,
        isRedirect: response.isRedirect,
        persistentConnection: response.persistentConnection,
        reasonPhrase: response.reasonPhrase,
      );
    } catch (e) {
      call.error(e);
      rethrow;
    }
  }

  @override
  void close() => _inner.close();
}
```

gRPC ve diğer protokoller için aynı `DurbunNetwork.begin` → `call.response(...)`
/ `call.error(...)` çağrılarını kendi katmanınızda yapın.

## Saf Dart (Flutter'sız)

`package:durbun/durbun_core.dart` (`DurbunClient.start(...)`) Flutter'sız Dart
programlarında aynen çalışır; plugin'in native tarafı onlar için devreye girmez.

## Geliştirme

```bash
flutter pub get --offline
flutter analyze
flutter test --concurrency=2
dart run tool/smoke.dart --dry-run      # masaüstü olmadan uçtan uca kontrol
dart run tool/smoke.dart                # çalışan Dürbün masaüstüne karşı (127.0.0.1:9751)
dart run tool/smoke.dart --port 9751 --linger 60   # bağlı kalır: Cihaz sekmesinden smoke.* araçlarını deneyin
dart run tool/sync_native.dart          # sdks/ios veya sdks/android değiştiyse kopyaları tazeler
```

`--linger` süresince smoke uygulaması her saniye metrik gönderir ve masaüstünden şu araçlar çalışır:
`smoke.ping` (buton), `smoke.verbose` (anahtar), `smoke.theme` (seçim) ve `smoke.request`
(`{path, method, body}` ile SDK üzerinden yeni bir istek — Mock'lar sekmesindeki kuralların uygulandığını
görmek için).

Native çekirdekler pakette birebir kopya olarak durur, çünkü pub.dev yalnızca bu
klasörü yayınlar ve CocoaPods, Swift Package Manager ve Gradle plugin klasörü
dışındaki dosyaları derleyemez: iOS çekirdeği `ios/durbun/Sources/durbun/Core`'da,
Android çekirdeği `android/src/core` (Kotlin + Java) ve `android/core-rules.pro`'da.
Asılları `sdks/ios/Sources/Durbun` ve `sdks/android/durbun`'dadır; onları değiştirince
`dart run tool/sync_native.dart` çalıştırın. `test/native_sync_test.dart` bir kopya
eskidiğinde başarısız olur.

Örnek uygulama: [`example/`](example/). (Xcode 27 iOS 15 altını kabul etmediği
için örneğin iOS hedefi 15.0'dır.)

---

<a id="english"></a>

# 🇬🇧 English

Dürbün is a desktop tool that shows **all logs, errors and network traffic** of
an app running on a device plugged into the Mac (or a simulator/emulator) in one
live view. This package is a **Flutter plugin**: besides the Dart SDK it carries
the native Android (Kotlin) and iOS (Swift) layers, so one install covers both
Flutter and native code.

## Setup: 2 steps

```yaml
dependencies:
  durbun:
    path: ../durbun/sdks/flutter/durbun   # or a git: dependency with path: sdks/flutter/durbun
```

```dart
Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized();
    runApp(const MyApp());
  });
}
```

No native init call: the Dart side starts the Android/iOS layers when it runs
and leaves them off otherwise. A native `Durbun.start()` is not needed; if one
is left in your code it does nothing in a Flutter app (it sees the plugin and
leaves the work to Dart), so no separate native session opens and `DURBUN=false`
keeps the native layer off too. Optional on Android, if your native code uses OkHttp:
`.addInterceptor(DurbunInterceptor())` (`import dev.durbun.DurbunInterceptor`) —
a pass-through while Dürbün is off. iOS URLSession traffic (shared and custom
sessions, Alamofire, cupertino_http) is captured automatically.

Without a zone: `Future<void> main() async { await Durbun.init(); runApp(const MyApp()); }`
(then only `debugPrint` is captured). Set your own `HttpOverrides.global`, if
any, **before** `Durbun.init()`: one set later is chained within ~2 s, and
`HttpClient`s created in between (e.g. the one Dio's adapter caches on its
first request) are not captured. Inside `Durbun.run` there is no such gap:
every `HttpClient` created in the zone asks the current global overrides and
is wrapped. If `ensureInitialized()` already ran outside the zone (e.g. before
`await Firebase.initializeApp()`), `Durbun.run` opens no zone — that would
print Flutter's "Zone mismatch" error — and works like `init` (no `print`
capture, only `debugPrint`; one console note). Move `ensureInitialized()` and
`Firebase.initializeApp()` into the body to capture `print` too. API: `Durbun.log(message, tag:, data:, error:, stackTrace:)`,
`Durbun.v/d/i/w/e/f`, `Durbun.event(name, props)`, `Durbun.isConnected`,
`Durbun.connection` (stream), `Durbun.addAction(DurbunAction.button/toggle/select)`.
Native logs: Kotlin `Durbun.i("tag", "message", data = …)` (`dev.durbun.Durbun`),
Swift `Durbun.info("message", tag: "tag")` (`import durbun`).

## In-app inspector (no Mac needed)

One line in `MaterialApp` adds the panel (the same line for
`MaterialApp.router` / go_router, `CupertinoApp` and `WidgetsApp`); nothing is
drawn over the app.
**Shake the phone** to open it (simulator: Device → Shake; Android emulator:
Virtual sensors → Shake). It opens a panel with the desktop's design and tabs, on the phone, with or
without a Mac:

```dart
MaterialApp(builder: DurbunInspector.builder, home: const HomePage());
```

- **Logs:** live stream with pause, V D I W E level toggles, quick filters, the
  desktop query language, merged repeats, request rows, data tree, stack traces
  and tag actions.
- **Network:** dart:io, Dio, OkHttp and URLSession in one table with method and
  status chips, slow / mocked / failed filters, host picker, query and body
  search. Detail tabs General / Request / Response / Timing: searchable JSON
  tree, code and hex views, image preview, headers, cookies, query, phase bars,
  Replay and Copy as cURL / fetch / dio / Swift / Kotlin. **Share** turns a
  request into a report the team can read without Dürbün (URL, status, trace
  IDs, headers, bodies, cURL; secret values masked as `••••` by default) and
  opens the system share sheet or copies it. The desktop builds the same
  report.
- **Mocks** from the desktop, **Performance** tiles and charts, **Device** with
  the captured layers and what each data source needs.

The panel shows the same messages the desktop receives, plus the app's own
native logs (Android logcat, iOS 15+ `os_log` / `Logger` / `NSLog`) with or
without a Mac and with no setup in the host app (`capturePrint: never` turns
them off). On the phone it keeps the last 2,000 log lines, 1,000 requests and
24 MB of bodies, and says when the oldest entries were removed. With
`defaultHosts`, requests to hidden hosts (and their bodies) go first.
`DurbunInspector(maxRequests: …, maxLogs: …, maxBodyBytes: …)` changes the
limits.

Options:

- `Durbun.showInspector()` opens it from your own debug menu;
  `openOnShake: false` turns shaking off, `showBubble: true` adds a small
  Dürbün button. The accelerometer is read only while the app is in front.
- After updating the SDK run `cd ios && pod install` once.
- `DurbunInspector(defaultHosts: ['api.example.com', '*.example.com'], …)`
  lists only your own APIs. Requests to other hosts (analytics, Firebase
  Storage …) are still captured and still reach the desktop; on the phone
  they are hidden, counted ("N on other hosts") and listed once ticked under
  Network → Filters → Hosts. Empty: every host.
- Find in the request and response bodies (preview and code): a match count,
  previous / next, and the match scrolled into view.
- The panel is one `/durbun` route on the app's navigator. Its detail pages,
  sheets, menus and "Copied" toasts live on its own navigator and
  `ScaffoldMessenger`: the app's route observers (analytics, Sentry) see only
  `/durbun`, and the app's snack bars are left alone. Back closes the panel's
  page first, then the panel. `DurbunInspector(navigatorKey: …)` picks another
  navigator.
- Filters, search and the last tab are kept between opens. **Pause** holds new
  requests on Network; a list scrolled up keeps the rows in view still while
  old entries are evicted. *Clear captured data* asks first. Shaking is not
  listened to while the panel is open.
- `DurbunOptions(inspector: false)` keeps nothing on the device.
- In builds where Dürbün is off, only the app is drawn.

## Release, Firebase and store builds

- debug / profile: **on** automatically;
- release: **off** — no socket, no hooks, the native layer is never started, and
  the Dart code is almost entirely tree-shaken away;
- release + `--dart-define=DURBUN=true`: **on**, wherever the build is installed
  from (Firebase, ad-hoc, TestFlight, Google Play, App Store, …);
- `--dart-define=DURBUN=false`: off in every mode;
- `DurbunOptions(enabled: …)` overrides everything (e.g. `enabled: appFlavor == 'qa'`).

Each project decides per build whether it runs Dürbün, store builds included;
the SDK does not look at where the app was installed from.

```bash
# Release with Dürbün on:
flutter build apk --release --dart-define=DURBUN=true
flutter build ipa --release --dart-define=DURBUN=true
# .ipa for Firebase App Distribution / ad-hoc:
flutter build ipa --release --export-method ad-hoc --dart-define=DURBUN=true
# Release with Dürbün off (no define):
flutter build appbundle --release
flutter build ipa --release
```

The same define works with `flutter build appbundle` and `flutter run --release`.
iOS: Flutter writes the defines into `ios/Flutter/Generated.xcconfig`, which an
Xcode Archive uses, so an Archive made after a `flutter build` with
`--dart-define=DURBUN=true` keeps `DURBUN=true` until the next `flutter build`
without it. If Firebase and the store get the same binary, the define turns
Dürbün on in every install of it; without the define the desktop still shows
what the device exposes (device logs, crash records, Android process/frame
stats) and explains why network/mocks are missing.
Release builds with Dürbün on need `INTERNET` in the main Android manifest
(every networked app has it; the plugin adds no permission).
Size (Flutter 3.38 counter app that already has another plugin, release, DURBUN
off): Android arm64 APK **+34 KB**; iOS `.app` **+868 KB** uncompressed /
**+278 KB** zipped (`durbun.framework`, smaller once symbols are stripped for
distribution).

## Where the data comes from

Everything leaves the app over **one connection** and shows up as one app
session ("SDK" badge). No proxy is involved, so SSL pinning is untouched.

| Source | Sends | When |
|---|---|---|
| Dart SDK | Dart logs, `print`, Flutter errors, Dart crashes, dart:io HTTP, FPS/jank/memory, `flutter.*` tools | while Dürbün is on |
| Android layer (in this plugin) | Kotlin/Java `Durbun.log`, uncaught Kotlin/Java crashes, OkHttp (with `DurbunInterceptor`), the app's own logcat (`Log.d` …; always in the panel, to the desktop only without adb, e.g. Wi-Fi), `android.*` tools | once Dart starts it |
| iOS layer (in this plugin) | URLSession traffic (automatic), Objective-C exceptions and Swift crashes, Swift `print`/stdout/stderr, Swift `Durbun.log`, iOS 15+ `os_log` / `Logger` / `NSLog` (always in the panel, to the desktop only when it cannot read device logs, e.g. Wi-Fi), `ios.*` tools | once Dart starts it |
| No SDK (old builds, release builds with Dürbün off) | device logs, system crash records, Android process/frame stats, read by the desktop | always |

Native crashes: Android sends them to the desktop at crash time; if the desktop
cannot be reached they arrive on the next launch as **"Previous launch crashed —
…"**. iOS: exceptions off the main thread arrive live; main-thread exceptions
and signal crashes (force unwrap, EXC_BAD_ACCESS) arrive on the next launch as
**"Crash in previous launch: …"**.

## What the Dart side captures

App logs; `print`/`debugPrint` (only when the desktop cannot see device logs, so
lines are never duplicated — `capturePrint: auto`); `FlutterError.onError`
(`flutter-error`, full error box) and uncaught zone/platform errors (`crash`),
always chaining the previous handlers; every dart:io `HttpClient` request through
an `HttpOverrides.global` wrapper that chains previous overrides (package:http,
Dio's default adapter, `NetworkImage`, WebSocket handshakes) with headers, bodies
(gzip decoded, capped at `maxBodyBytes`), timings, redirects (one entry per hop,
like URLSession), cancellations and errors; events; metrics (FPS while rendering, janky frames, avg build/raster ms,
memory, CPU, threads); desktop commands `flutter.*` plus your own actions.
Mocks: `respond` (synthesized, never hits the network, `x-durbun-mock` header),
`delay`, `fail` (natural dart:io exceptions).

## USB vs Wi-Fi

Android USB/emulator: automatic (`adb reverse`; `10.0.2.2` fallback on
emulators). iOS simulator: automatic. iOS device over USB: automatic (the SDK
listens on device `127.0.0.1:9752–9755`, the desktop connects via usbmux).
Wi-Fi: `DurbunOptions(host: '192.168.1.20')` or
`--dart-define=DURBUN_HOST=192.168.1.20`, run the desktop with `--lan`, and on
iOS 14+ add `NSLocalNetworkUsageDescription` to `Info.plist`. While offline the
SDK keeps the last 5 000 messages and reconnects with 0.5 s → 3 s backoff.
Before the first connection, or once the desktop has been gone for 30 s, the
waiting messages hold at most ~8 MB: past it the oldest bodies are stripped
(requests and logs stay, bodies marked truncated; the in-app panel keeps its
own copy). Requests never
wait for a missing desktop: only while a desktop has accepted the connection
and its mock rules are on the way, for at most 0.8 s (`waitForDesktop` waits
longer on purpose).

## Limits

On Android, cronet_http / Dio `NativeAdapter` bypass both dart:io and OkHttp:
add `DurbunDioInterceptor(dio: dio)` from `durbun_dio` as Dio's **last**
interceptor. On iOS they run on URLSession and are captured by the native layer
(`DurbunDioInterceptor` does not report them twice). **Not captured:** on
Android package:http's `CronetClient` and `package:ok_http` (it builds its own
OkHttp client, so `DurbunInterceptor` cannot be added); on every platform gRPC
(`package:grpc` speaks HTTP/2 over its own sockets) and raw `Socket` code.
Report those yourself with `DurbunNetwork.begin(...)` → `call.response(...)` /
`call.error(...)`; for package:http clients a small `http.BaseClient` wrapper is
enough (the Turkish section above has a ready one, `DurbunReportingClient`).
Redirects dart:io follows by itself expose only each hop's status and
`location`; mock rules do not apply to those hops. Traffic in background isolates is not captured.
`HttpClient`s created before `Durbun.run/init` are not wrapped. WebSockets:
handshake only. `dart:developer` `log()` comes from the desktop's VM-service
bridge (debug). iOS `os_log` / `Logger` / `NSLog` lines are read from the app's
own log store every few seconds (every second while the panel is open or they
go to the desktop); iOS does not keep `debug` entries, iOS 13–14 has no such
store, and `com.apple.*` lines are skipped. With several Flutter engines in one process only the first one
that starts Dürbün gets the native layer. Native-only apps use `sdks/android` /
`sdks/ios`; do not add those to a Flutter app as well (duplicate classes).

## Security notes

- When the connection drops, the mock rules it pushed are dropped at once in
  every layer (Dart, OkHttp, URLSession); the desktop sends them again when it
  reconnects. Requests made in between go to the real server.
- **Connection:** the link between the desktop and the SDK has no pairing yet. A
  build with Dürbün on talks to whatever answers on its device loopback port
  (Android: it connects to `127.0.0.1:9751`; iOS device: it listens on
  `127.0.0.1:9752–9755`). That peer can be the desktop (through adb reverse /
  usbmux) or another app on the device; the logs and network traffic go to it,
  and the mock rules it pushes apply while it stays connected.
- Header values listed in `redactHeaders` show up as `••••` in every layer.
- A peer cannot raise the body limit past 10 MiB, and gzip bodies stop
  inflating at the limit.
  `captureNetwork: false` also keeps OkHttp (Android) and URLSession (iOS) out.

## Pure Dart

`package:durbun/durbun_core.dart` (`DurbunClient.start(...)`) keeps working in
Dart programs without Flutter; the plugin's native side is not involved.

## Development

`flutter test --concurrency=2`, `dart run tool/smoke.dart --dry-run` (no desktop
needed) or `dart run tool/smoke.dart` against a running desktop
(`--port 9751 --linger 60` keeps it connected: it sends metrics every second and
offers the actions `smoke.ping`, `smoke.verbose` (toggle), `smoke.theme` (select)
and `smoke.request` (`{path, method, body}` — makes one more request through the
SDK, e.g. to watch a mock rule apply).

The package carries exact copies of the native cores, because pub.dev publishes
only this folder and CocoaPods, Swift Package Manager and Gradle cannot build
files outside the plugin: the iOS core in `ios/durbun/Sources/durbun/Core`, the
Android core in `android/src/core` (Kotlin + Java) and `android/core-rules.pro`.
The originals are `sdks/ios/Sources/Durbun` and `sdks/android/durbun`; run
`dart run tool/sync_native.dart` after changing them — `test/native_sync_test.dart`
fails when a copy is stale.
