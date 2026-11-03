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
üzerinden gelir. Release derlemesinde `init()` mağaza kontrolünün yanıtını bekler;
`await` etmeden `runApp` çağırırsanız o arada oluşturulan HttpClient'lar yakalanmaz.
İlk isteğini o arada gönderen bir Dio da aynı istemciyi kullanmaya devam ettiği için
oturum boyunca görünmez. Masaüstü bu durumda nedenini söyleyen bir uyarı gösterir.

## Release, Firebase ve mağaza derlemeleri

| Derleme | Dürbün |
|---|---|
| `flutter run` (debug), profile | **Açık**, kendiliğinden |
| Release (mağaza) | **Kapalı.** Soket açılmaz, kanca kurulmaz, native katman başlatılmaz. Dart kodu derleyicinin ağaç sarsmasıyla (tree shaking) neredeyse tamamen düşer |
| Release + `--dart-define=DURBUN=true` | **Açık** — örneğin yalnızca Firebase App Distribution'a giden test derlemesi. Google Play'den veya App Store'dan kurulursa kendini kapatır |
| `--dart-define=DURBUN=false` | Her modda kapalı (ör. profile ölçümü) |
| `DurbunOptions(enabled: true/false)` | Her şeyin önüne geçer |

```bash
# Firebase / iç test derlemesi — mağazaya giden derlemede ASLA
flutter build apk --release --dart-define=DURBUN=true
flutter build ipa --release --export-method ad-hoc --dart-define=DURBUN=true
# Bu .ipa’yı App Store Connect’e / TestFlight’a yüklemeyin: TestFlight derlemesi mağazaya giden derlemenin kendisidir.
# Mağaza derlemesinden önce define’sız yeniden derleyin; Xcode Archive son flutter build’in define’larını (ios/Flutter/Generated.xcconfig) kullanır:
flutter build appbundle --release
flutter build ipa --release
```

- **Yanlışlıkla mağazaya giderse:** Dürbün çalışmadan önce uygulamanın nereden
  kurulduğuna bakar. Google Play'den (iç test dahil her kanal) veya App
  Store'dan kurulmuşsa hiçbir şey başlatmaz ve cihaz loguna tek satır yazar:
  «Dürbün kendini kapattı: uygulama mağazadan kurulmuş (Dürbün mağaza
  sürümlerinde çalışmaz).» (Cihaz dili Türkçe değilse İngilizcesi.) Firebase, ad-hoc,
  TestFlight ve `flutter run` kurulumlarında çalışmaya devam eder. Bu bir
  emniyet kemeridir, dağıtım yolu değil: `DURBUN=true` derlemeyi mağaza
  kanallarına (Play iç test, TestFlight) hiç yüklemeyin. Android'de yalnızca
  Google Play tanınır: Huawei AppGallery, Galaxy Store veya Amazon'dan kurulan
  bir `DURBUN=true` derlemesi çalışır, bu yüzden onu oralara da yüklemeyin.
- Release derlemesi bu kontrolü native tarafa sorarak yapar (açılışta tek bir
  kanal çağrısı). Plugin yanıt vermezse Dürbün yine kapalı kalır ve bunu da
  cihaz loguna yazar.
- Firebase ve mağaza aynı binary ise (bazı projelerde öyle) **define kullanmayın**:
  o binary mağazaya da gider. Dürbün masaüstü bu durumda yine cihazın verdiği
  her şeyi gösterir (cihaz logları, çökme kayıtları, Android süreç/kare
  istatistikleri) ve ağ/mock'un neden görünmediğini açıklar.
- Flavor kullanıyorsanız define'ı yalnızca test flavor'ının derleme komutuna
  ekleyin ya da `DurbunOptions(enabled: appFlavor == 'qa')` yazın.
- Android: release'de açacaksanız ana manifestte `INTERNET` izni olmalı (ağ
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
| Android native katmanı (bu plugin içinde) | Kotlin/Java `Durbun.log`, yakalanmamış Kotlin/Java çökmeleri, OkHttp (`DurbunInterceptor` ile), Wi-Fi'de (adb yokken) uygulamanın kendi logcat'i, `android.dumpThreads` / `android.gc` araçları | Dart tarafı başlatınca |
| iOS native katmanı (bu plugin içinde) | URLSession trafiği (otomatik), Objective-C istisnaları ve Swift çökmeleri, Swift `print`/stdout/stderr, `Durbun.log` (Swift), `ios.*` araçları | Dart tarafı başlatınca |
| SDK'sız (eski build, mağaza build'i) | Cihaz logları, sistem çökme kayıtları, Android süreç/kare istatistikleri — masaüstü bunları cihazdan okur | Her zaman |

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
| HTTP (dart:io) | `HttpOverrides.global` sarmalayıcısı (önceki override zincirlenir) | istek/yanıt, başlıklar, gövdeler (gzip çözülmüş), süreler, redirect, iptal, hata. `package:http`, Dio'nun varsayılan adaptörü, `NetworkImage`, WebSocket el sıkışması dahil |
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

## Release güvenliği

- Varsayılanlar yukarıdaki tabloda. `flutter test` içinde de kapalıdır
  (`enabled: true` ile açılır).
- SDK uygulamaya asla hata fırlatmaz; tüm iç hatalar yutulur (native katman dahil).
- JSON kodlama, gövde base64/gzip işlemleri ve soket I/O arka plan isolate'ta
  çalışır; kuyruklar sınırlıdır (5 000 mesaj, ~48 MB), gövdeler `maxBodyBytes`
  (varsayılan 1 MB) ile kesilir. Native katmanın mesajları Dart'a küçük paketler
  hâlinde, sınırlı bir tamponla iletilir.
- Web'de ve masaüstü platformlarda native katman yoktur; Dart tarafı çalışır.
- Hot restart: native katman yeni oturumla yeniden başlar.
- Bağlantı koptuğunda o bağlantının gönderdiği mock kuralları her katmanda
  (Dart, OkHttp, URLSession) hemen silinir; masaüstü yeniden bağlanınca
  kurallarını tekrar gönderir. Bağlantı yokken yapılan istekler gerçek sunucuya
  gider.
- **Bilinen risk:** masaüstü ile SDK arasındaki bağlantıda henüz kimlik doğrulama
  yok. `DURBUN=true` ile derlenen sürüm, telefondaki başka bir uygulama kendini
  masaüstü gibi tanıtırsa loglarını ve ağ trafiğini ona da gönderebilir; o
  uygulama bağlı kaldığı sürece onun mock kurallarını da uygular. Bu derlemeyi yalnızca test
  cihazlarına dağıtın. Eşleştirme anahtarı (pairing token) ileride eklenecek.

## Seçenekler (`DurbunOptions`)

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `enabled` | `null` | `null`: debug/profile açık, release yalnızca `--dart-define=DURBUN=true` ile; `true`/`false` her şeyi ezer |
| `host` / `port` | `null` / `9751` | Wi-Fi için masaüstü adresi (`'ip'` veya `'ip:port'`) |
| `captureNetwork` | `true` | dart:io HTTP yakalama + mock'lar (iOS'ta URLSession, Android'de OkHttp yakalamayı da açar/kapatır) |
| `capturePrint` | `auto` | `auto` / `always` / `never` (`never` native stdout/logcat iletimini de kapatır) |
| `captureErrors` | `true` | Flutter hataları ve çökmeler (native çökmeler dahil) |
| `metrics` | `true` | FPS, jank, bellek, CPU |
| `maxBufferedMessages` | `5000` | bağlantı yokken tutulan mesaj sayısı |
| `redactHeaders` | `[]` | değeri gizlenecek başlıklar, ör. `['authorization']` — OkHttp ve URLSession istekleri dahil; değer her katmanda `••••` görünür |
| `appId` / `appName` / `appVersion` | otomatik | Android'de sürüm/derleme numarasını artık native katman okur; yalnızca ezmek için verin |
| `waitForDesktop` | `0` | `run` uygulamayı başlatmadan önce bu kadar bekler (açılıştaki isteklere mock uygulansın diye) |
| `listenForUsb` | `true` | iOS cihazda usbmux dinleyicisi |
| `useBackgroundIsolate` | `true` | taşıma katmanı arka plan isolate'ta |

## Sınırlar

- Android'de **cronet_http / Dio `NativeAdapter`** dart:io'yu ve OkHttp'yi
  kullanmaz → Dio için `sdks/flutter/durbun_dio` paketindeki
  `DurbunDioInterceptor(dio: dio)` ekleyin. iOS'ta bunlar URLSession üzerinden
  native katmanca yakalanır (`DurbunDioInterceptor` o istekleri ikinci kez
  bildirmez).
- Arka plan isolate'larındaki (`compute`, `Isolate.run`) Dart HTTP istekleri ve
  loglar yakalanmaz (her isolate'ın kendi `HttpOverrides`'ı vardır).
- `Durbun.run/init`'ten **önce** oluşturulmuş `HttpClient`'lar sarılmaz.
- WebSocket: yalnızca el sıkışma (101) görünür, mesajlar görünmez.
- `dart:developer` `log()` çağrıları SDK'dan değil, masaüstünün Dart VM Service
  bağlantısından (debug) gelir.
- FPS yalnızca çizim yapılırken raporlanır (boşta bekleyen uygulama "0 FPS" görünmez).
- Aynı süreçte birden fazla Flutter engine varsa native katmanı yalnızca ilk
  başlatan engine kullanır.
- Native-only (Flutter'sız) uygulamalar `sdks/android` ve `sdks/ios` SDK'larını
  kullanır; Flutter uygulamasına ikisini ayrıca eklemeyin (sınıflar çakışır).

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
dart run tool/sync_native.dart          # sdks/ios değiştiyse iOS kopyasını tazeler
```

`--linger` süresince smoke uygulaması her saniye metrik gönderir ve masaüstünden şu araçlar çalışır:
`smoke.ping` (buton), `smoke.verbose` (anahtar), `smoke.theme` (seçim) ve `smoke.request`
(`{path, method, body}` ile SDK üzerinden yeni bir istek — Mock'lar sekmesindeki kuralların uygulandığını
görmek için).

Native çekirdekler kopyalanmadan taşınır: Android derlemesi
`sdks/android/durbun/src/main`'i Gradle `sourceSets` ile doğrudan derler
(`android/build.gradle`). CocoaPods ve Swift Package Manager plugin klasörü
dışındaki dosyaları derleyemediği için iOS çekirdeği
`ios/durbun/Sources/durbun/Core`'da birebir kopya olarak durur;
`sdks/ios/Sources/Durbun` değişince `dart run tool/sync_native.dart` çalıştırın.
`test/native_sync_test.dart` kopya eskidiğinde başarısız olur.

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
(then only `debugPrint` is captured). In release builds `init()` completes once
the store check has answered; await it before `runApp`, otherwise HttpClients
created in the meantime are never captured (nor a Dio that sent its first
request then: it keeps that client), and the desktop shows a warning saying so. API: `Durbun.log(message, tag:, data:, error:, stackTrace:)`,
`Durbun.v/d/i/w/e/f`, `Durbun.event(name, props)`, `Durbun.isConnected`,
`Durbun.connection` (stream), `Durbun.addAction(DurbunAction.button/toggle/select)`.
Native logs: Kotlin `Durbun.i("tag", "message", data = …)` (`dev.durbun.Durbun`),
Swift `Durbun.info("message", tag: "tag")` (`import durbun`).

## Release, Firebase and store builds

- debug / profile: **on** automatically;
- release: **off** — no socket, no hooks, the native layer is never started, and
  the Dart code is almost entirely tree-shaken away;
- release + `--dart-define=DURBUN=true`: **on** (e.g. only the Firebase App
  Distribution build for testers — never for store builds; it turns itself off
  when installed from Google Play or the App Store);
- `--dart-define=DURBUN=false`: off in every mode;
- `DurbunOptions(enabled: …)` overrides everything (e.g. `enabled: appFlavor == 'qa'`).

```bash
# Firebase / internal build — NEVER the build that goes to the store
flutter build apk --release --dart-define=DURBUN=true
flutter build ipa --release --export-method ad-hoc --dart-define=DURBUN=true
# Do not upload this .ipa to App Store Connect / TestFlight: a TestFlight build is the store build itself.
# Rebuild without the define before the store build; Xcode Archive reuses the last flutter build’s defines (ios/Flutter/Generated.xcconfig):
flutter build appbundle --release
flutter build ipa --release
```

If such a build reaches a store by mistake, Dürbün checks where the app was
installed from before it starts anything: installed from Google Play (any
track, internal testing too) or the App Store, it starts nothing and writes one
line to the device log: «Dürbün turned itself off: this app was installed from
the store (Dürbün never runs in store builds).» (in Turkish on Turkish devices).
Firebase, ad-hoc, TestFlight and `flutter run` installs keep working. This is a
safety net, not a distribution path: never upload a `DURBUN=true` build to a
store channel (Play internal testing, TestFlight). On Android only Google Play
is recognised: a `DURBUN=true` build installed from Huawei AppGallery, Galaxy
Store or Amazon runs, so keep it off those stores too. A release build asks the
plugin's native side (one channel call at launch); if the plugin does not
answer, Dürbün stays off and logs that too.

If a project ships the same binary to Firebase and the store, do not use the
define; the desktop still shows what the device exposes (device logs, crash
records, Android process/frame stats) and explains why network/mocks are missing.
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
| Android layer (in this plugin) | Kotlin/Java `Durbun.log`, uncaught Kotlin/Java crashes, OkHttp (with `DurbunInterceptor`), the app's own logcat over Wi-Fi (no adb), `android.*` tools | once Dart starts it |
| iOS layer (in this plugin) | URLSession traffic (automatic), Objective-C exceptions and Swift crashes, Swift `print`/stdout/stderr, Swift `Durbun.log`, `ios.*` tools | once Dart starts it |
| No SDK (old / store builds) | device logs, system crash records, Android process/frame stats, read by the desktop | always |

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
(gzip decoded, capped at `maxBodyBytes`), timings, redirects, cancellations and
errors; events; metrics (FPS while rendering, janky frames, avg build/raster ms,
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

## Limits

On Android, cronet_http / Dio `NativeAdapter` bypass both dart:io and OkHttp:
use `DurbunDioInterceptor` from `sdks/flutter/durbun_dio` for Dio. On iOS they run
on URLSession and are captured by the native layer (`DurbunDioInterceptor` does
not report them twice). Traffic in background isolates is not captured.
`HttpClient`s created before `Durbun.run/init` are not wrapped. WebSockets:
handshake only. `dart:developer` `log()` comes from the desktop's VM-service
bridge (debug). With several Flutter engines in one process only the first one
that starts Dürbün gets the native layer. Native-only apps use `sdks/android` /
`sdks/ios`; do not add those to a Flutter app as well (duplicate classes).

## Security notes

- When the connection drops, the mock rules it pushed are dropped at once in
  every layer (Dart, OkHttp, URLSession); the desktop sends them again when it
  reconnects. Requests made in between go to the real server.
- **Known risk:** the link between the desktop and the SDK is not authenticated
  yet. A build made with `DURBUN=true` can send its logs and network traffic to
  another app on the phone that pretends to be the desktop, and applies that
  app's mock rules while it stays connected. Hand such builds to test devices
  only. A pairing token is planned.
- Header values listed in `redactHeaders` show up as `••••` in every layer.
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

The native cores are not copied by hand: Android compiles
`sdks/android/durbun/src/main` directly through Gradle `sourceSets`
(`android/build.gradle`). CocoaPods and Swift Package Manager cannot compile
files outside the plugin folder, so the iOS core is an exact copy in
`ios/durbun/Sources/durbun/Core`; run `dart run tool/sync_native.dart` after
changing `sdks/ios/Sources/Durbun` — `test/native_sync_test.dart` fails when the
copy is stale.
