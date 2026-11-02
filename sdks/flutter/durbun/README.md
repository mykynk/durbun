# Dürbün — Flutter SDK (`durbun`)

> 🇹🇷 Türkçe aşağıda · 🇬🇧 [English below](#english)

Dürbün, cihaz Mac'e takılıyken (veya simülatör/emülatörde) uygulamanın **tüm
loglarını, hatalarını ve ağ trafiğini** tek bir canlı ekranda gösteren masaüstü
aracıdır. Bu paket uygulamanın içinden Dürbün'e veri gönderir: uygulama logları,
`print` çıktıları, Flutter hataları, çökmeler, özel event'ler, dart:io HTTP
istekleri (gövdeleriyle), FPS / jank / bellek / CPU ölçümleri. Masaüstündeki
mock kurallarını uygular ve masaüstünden gelen komutları (debug paint, yavaş
animasyon, widget ağacı dökümü…) çalıştırır.

## Kurulum

`pubspec.yaml` (path dependency — paket pub.dev'de yayınlanmadı):

```yaml
dependencies:
  durbun:
    path: ../durbun/sdks/flutter/durbun   # Dürbün reposunun bulunduğu yere göre
```

`main.dart`:

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

`Durbun.run` bir zone açar: `print` çıktılarını ve yakalanmamış hataları da alır.
Zone istemiyorsanız: `Durbun.init(); runApp(const MyApp());` (bu durumda yalnızca
`debugPrint` yakalanır, zone hataları `PlatformDispatcher.onError` üzerinden gelir).

Kod içinden log ve event:

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

## Neler yakalanır?

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

- Varsayılan: debug ve profile derlemelerinde **açık**, release derlemelerinde ve
  `flutter test` içinde **kapalı** (tüm çağrılar no-op). `enabled: true` her
  yerde zorla açar, `enabled: false` kapatır.
- SDK uygulamaya asla hata fırlatmaz; tüm iç hatalar yutulur.
- JSON kodlama, gövde base64/gzip işlemleri ve soket I/O arka plan isolate'ta
  çalışır; kuyruklar sınırlıdır (5 000 mesaj, ~48 MB), gövdeler `maxBodyBytes`
  (varsayılan 1 MB) ile kesilir.
- Web'de derlenir ama hiçbir şey yapmaz.
- Android: Flutter şablonu `INTERNET` iznini debug ve profile manifestlerine
  ekler; release'de SDK'yı `enabled: true` ile zorlarsanız izni ana manifeste
  de ekleyin.

## Seçenekler (`DurbunOptions`)

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `enabled` | `null` (debug/profile'da açık) | `true` = her yerde aç |
| `host` / `port` | `null` / `9751` | Wi-Fi için masaüstü adresi (`'ip'` veya `'ip:port'`) |
| `captureNetwork` | `true` | dart:io HTTP yakalama + mock'lar |
| `capturePrint` | `auto` | `auto` / `always` / `never` |
| `captureErrors` | `true` | Flutter hataları ve çökmeler |
| `metrics` | `true` | FPS, jank, bellek, CPU |
| `maxBufferedMessages` | `5000` | bağlantı yokken tutulan mesaj sayısı |
| `redactHeaders` | `[]` | değeri `••••` ile gizlenecek başlıklar, ör. `['authorization']` |
| `appId` / `appName` / `appVersion` | otomatik | Android'de sürüm otomatik okunamaz → `appVersion` verin |
| `waitForDesktop` | `0` | `run` uygulamayı başlatmadan önce bu kadar bekler (açılıştaki isteklere mock uygulansın diye) |
| `listenForUsb` | `true` | iOS cihazda usbmux dinleyicisi |
| `useBackgroundIsolate` | `true` | taşıma katmanı arka plan isolate'ta |

## Sınırlar

- **cupertino_http / cronet_http / Dio `NativeAdapter`** dart:io kullanmaz →
  yakalanmaz. Dio kullanıyorsanız `sdks/flutter/durbun_dio` paketindeki
  `DurbunDioInterceptor(dio: dio)` ekleyin; diğerleri yakalanmaz.
- Arka plan isolate'larındaki (`compute`, `Isolate.run`) HTTP istekleri ve
  loglar yakalanmaz (her isolate'ın kendi `HttpOverrides`'ı vardır).
- `Durbun.run/init`'ten **önce** oluşturulmuş `HttpClient`'lar sarılmaz (ör.
  çok erken oluşturulan statik istemciler).
- WebSocket: yalnızca el sıkışma (101) görünür, mesajlar görünmez.
- `dart:developer` `log()` çağrıları SDK'dan değil, masaüstünün Dart VM Service
  bağlantısından (debug) gelir.
- FPS yalnızca çizim yapılırken raporlanır (boşta bekleyen uygulama "0 FPS" görünmez).

## Geliştirme

```bash
flutter pub get --offline
flutter analyze
flutter test --concurrency=2
dart run tool/smoke.dart --dry-run      # masaüstü olmadan uçtan uca kontrol
dart run tool/smoke.dart                # çalışan Dürbün masaüstüne karşı (127.0.0.1:9751)
dart run tool/smoke.dart --port 9751 --linger 60   # bağlı kalır: Cihaz sekmesinden smoke.* araçlarını deneyin
```

`--linger` süresince smoke uygulaması her saniye metrik gönderir ve masaüstünden şu araçlar çalışır:
`smoke.ping` (buton), `smoke.verbose` (anahtar), `smoke.theme` (seçim) ve `smoke.request`
(`{path, method, body}` ile SDK üzerinden yeni bir istek — Mock'lar sekmesindeki kuralların uygulandığını
görmek için).

Örnek uygulama: [`example/`](example/).

---

<a id="english"></a>

# 🇬🇧 English

Dürbün is a desktop tool that shows **all logs, errors and network traffic** of
an app running on a device plugged into the Mac (or a simulator/emulator) in one
live view. This package sends data from inside the app: app logs, `print`
output, Flutter errors, crashes, custom events, dart:io HTTP traffic (with
bodies), FPS / jank / memory / CPU. It applies the desktop's mock rules and runs
desktop commands (debug paint, slow animations, widget tree dump…).

## Install

```yaml
dependencies:
  durbun:
    path: ../durbun/sdks/flutter/durbun
```

```dart
Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized();
    runApp(const MyApp());
  });
}
```

Without a zone: `Durbun.init(); runApp(const MyApp());` (then only `debugPrint`
is captured). API: `Durbun.log(message, tag:, data:, error:, stackTrace:)`,
`Durbun.v/d/i/w/e/f`, `Durbun.event(name, props)`, `Durbun.isConnected`,
`Durbun.connection` (stream), `Durbun.addAction(DurbunAction.button/toggle/select)`.
Using `package:logging`? Forward records with
`Logger.root.onRecord.listen((r) => Durbun.log(r.message, tag: r.loggerName, error: r.error, stackTrace: r.stackTrace, level: …))`
(see the Turkish section for the level mapping).

## What is captured

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

## Release safety

On in debug/profile, **off in release builds and in `flutter test`** unless
`enabled: true`. Never throws into the app. Encoding and socket I/O run on a
background isolate with bounded queues. Compiles to a no-op on the web.
Android: Flutter's template declares `INTERNET` in the debug and profile
manifests; if you force the SDK on in release, add it to the main manifest too.

## Limits

cupertino_http / cronet_http / Dio `NativeAdapter` bypass dart:io: use
`DurbunDioInterceptor` from `sdks/flutter/durbun_dio` for Dio, others are not
captured. Traffic in background isolates is not captured. `HttpClient`s created
before `Durbun.run/init` are not wrapped. WebSockets: handshake only.
`dart:developer` `log()` comes from the desktop's VM-service bridge (debug), not
from this SDK. Android app versions cannot be detected without plugins
(`appVersion` option).

## Development

`flutter test --concurrency=2`, `dart run tool/smoke.dart --dry-run` (no desktop
needed) or `dart run tool/smoke.dart` against a running desktop
(`--port 9751 --linger 60` keeps it connected: it sends metrics every second and
offers the actions `smoke.ping`, `smoke.verbose` (toggle), `smoke.theme` (select)
and `smoke.request` (`{path, method, body}` — makes one more request through the
SDK, e.g. to watch a mock rule apply).
