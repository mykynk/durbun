# Dürbün iOS SDK

Swift paketi `Durbun` — iOS 13+ (testler için macOS 11+). Uygulamanızın loglarını, `print` çıktısını,
çökmelerini, URLSession ağ trafiğini ve performans metriklerini canlı olarak Dürbün masaüstü
uygulamasına gönderir.

*English version below.*

---

## Türkçe

> **Flutter uygulaması mı?** Bu paketi ayrıca eklemeyin. Flutter paketi
> [`package:durbun`](../flutter/durbun/README.md) bu iOS çekirdeğini zaten içinde taşır (URLSession,
> çökmeler, stdout/stderr) ve Dart tarafı başlattığında çalıştırır; `Durbun.start()` gerekmez (Flutter
> uygulamasında çağrılırsa hiçbir şey yapmaz). Swift
> kodundan log için `import durbun` yazın. Bu sayfa yalnızca Flutter'sız (native-only) iOS uygulamaları
> içindir. Bu klasördeki kaynakları değiştirirseniz `sdks/flutter/durbun` içinde
> `dart run tool/sync_native.dart` çalıştırın (plugin birebir kopyasını taşır).

### Neler yakalanır?

| Ne | Nasıl görünür |
|---|---|
| `Durbun.log / debug / info / warning / error` | Seviye, etiket (tag), JSON `data`, hata ve çağrı yığını ile yapılandırılmış log |
| `print`, `debugPrint`, `NSLog`, `printf`, stderr | `stdout` / `stderr` etiketli loglar. Xcode konsolu **aynen çalışmaya devam eder** (her bayt orijinal çıkışa da yazılır). Çok satırlı çıktılar (pretty JSON, `dump()`, yığın izleri) tek satırda toplanır; `[ERROR]`, `Warning:`, `❌` gibi işaretlerden seviye çıkarılır; NSLog'un tarih/işlem öneki temizlenir |
| Çökmeler | Yakalanmamış Objective-C istisnaları **anında** (`kind: crash`). Swift çalışma zamanı hataları (`nil` force-unwrap, dizi taşması, `fatalError`), EXC_BAD_ACCESS vb. sinyaller **bir sonraki açılışta** — konsoldaki son satırlar ("Fatal error: …") ve yığın iziyle |
| Ağ | `URLSession.shared` **ve** kendi oluşturduğunuz oturumlar (Alamofire dahil): başlıklar, gövdeler, yönlendirmeler, zamanlamalar (DNS/TCP/TLS/bekleme/indirme), protokol (h2/h3), hata ve iptaller |
| Mock'lar | Masaüstünde tanımlanan kurallar: sahte yanıt, gecikme, doğal hata (zaman aşımı, bağlantı, DNS, TLS) |
| Performans | CPU (%), bellek (phys_footprint, Xcode'daki değer), iş parçacığı sayısı, FPS ve takılan kareler (CADisplayLink) |
| Olaylar | `Durbun.event("purchase", ["amount": 49.9])` |
| Uygulama araçları | Masaüstündeki Cihaz panelinden: açık/koyu görünüm, yavaş animasyonlar, view hiyerarşisi dökümü, UserDefaults dökümü + `registerAction` ile kendi düğmeleriniz |

### Kurulum

**Swift Package Manager:** Xcode → **File → Add Package Dependencies…** → `https://github.com/mykynk/durbun`
→ uygulama hedefinize **Durbun** ürününü ekleyin. `Package.swift` içinden:

```swift
.package(url: "https://github.com/mykynk/durbun", from: "0.1.0"),
// hedefte:
.product(name: "Durbun", package: "durbun"),
```

**CocoaPods:**

```ruby
pod 'Durbun'
# İsteğe bağlı: yalnızca Debug yapılandırmasına bağlar; Release derlemesinde Dürbün kodu hiç bulunmaz.
# O durumda `import Durbun` ve çağrılar `#if DEBUG` içinde olmalıdır, aksi halde Release derlenmez.
# pod 'Durbun', :configurations => ['Debug']
```

SwiftPM'de paket tüm yapılandırmalara bağlanır; SDK DEBUG olmadan derlendiğinde kendiliğinden hiçbir şey yapmaz
(bkz. Release güvenliği). Paket bir gizlilik manifesti (`PrivacyInfo.xcprivacy`, UserDefaults dökümü için
`CA92.1`) içerir.

**Yerel klasörden (SDK geliştirirken):** Xcode → **Add Local…** → bu depodaki `sdks/ios` klasörü. Başka bir
Swift paketinden: `.package(path: "../durbun/sdks/ios")` ve `.product(name: "Durbun", package: "ios")` (yerel
yol bağımlılığında paket kimliği klasörün adıdır: `ios`).

### Başlatma

Mümkün olduğunca erken çağırın (oturumlar `start()`'tan **sonra** oluşturulursa yakalanır):

```swift
import Durbun

// SwiftUI
@main
struct PatiApp: App {
    init() {
        #if DEBUG
        Durbun.start()            // simülatör ve USB: hiçbir ayar gerekmez
        #endif
    }
    var body: some Scene { WindowGroup { ContentView() } }
}

// UIKit: application(_:didFinishLaunchingWithOptions:) içinde aynı satırlar.
```

Kullanım:

```swift
Durbun.log("Giriş yapıldı", level: .info, tag: "auth", data: ["userId": 42])
Durbun.debug("Önbellekten okundu", tag: "cache")
Durbun.warning("Yavaş yanıt", tag: "api", data: ["ms": 2300])
Durbun.error("Ödeme başarısız", error: error, tag: "payment")
Durbun.event("purchase", ["amount": 49.9, "currency": "TRY"])

// Masaüstündeki Cihaz panelinde kendi aracınız (ana iş parçacığında çalışır):
Durbun.registerAction(DurbunAction(id: "app.clearCache", label: "Görsel önbelleğini temizle")) { _ in
    ImageCache.shared.removeAll()
    return nil
}
Durbun.registerAction(DurbunAction(id: "app.mockLogin", label: "Sahte giriş", kind: .toggle(false))) { params in
    FeatureFlags.mockLogin = params["value"] as? Bool ?? false
    return nil
}
```

`data` sözlük, dizi, `Encodable` ya da herhangi bir değer olabilir (en iyi çabayla JSON'a çevrilir).

### Bağlantı

| Durum | Ne yapmalı? |
|---|---|
| **Simülatör** | Hiçbir şey. SDK `127.0.0.1:9751`'e bağlanır; `SIMULATOR_UDID` sayesinde masaüstü doğru simülatörü eşler. |
| **USB ile bağlı iPhone/iPad** | Hiçbir şey. SDK cihazda `127.0.0.1:9752…9755` aralığındaki ilk boş portu dinler; masaüstü usbmux üzerinden bağlanır. Yalnızca loopback dinlendiği için ağdan kimse bağlanamaz ve Yerel Ağ izni gerekmez. |
| **Wi-Fi** | `Durbun.start(options: .init(host: "192.168.1.20"))` veya Xcode scheme'inde `DURBUN_HOST=192.168.1.20` ortam değişkeni. Info.plist'e `NSLocalNetworkUsageDescription` ekleyin (iOS ilk bağlantıda izin sorar) ve masaüstünü `durbun --lan` ile başlatın. |

Bağlantı koparsa SDK 0,5 sn → 3 sn aralıklarla sonsuza kadar yeniden dener; bu sırada son 5 000 mesajı
bellekte tutar ve bağlanınca sırayla gönderir (sığmayanlar için tek bir uyarı satırı düşer). Hangi
yoldan önce el sıkışma (`hello` → `welcome`) tamamlanırsa o kullanılır, diğerleri kapatılır.

### Seçenekler (`DurbunOptions`)

| Alan | Varsayılan | Açıklama |
|---|---|---|
| `host` | `nil` (`DURBUN_HOST`) | Wi-Fi için masaüstü IP'si |
| `port` | `9751` | Simülatör / Wi-Fi portu |
| `devicePorts` | `9752...9755` | Fiziksel cihazdaki USB dinleyici portları |
| `enabled` | `true` | `false` ise `start` hiçbir şey yapmaz |
| `captureStdout` | `true` | `print` / stdout / stderr yakalama |
| `captureNetwork` | `true` | URLSession yakalama + mock'lar |
| `captureCrashes` | `true` | İstisna ve sinyal (çökme) raporları |
| `collectMetrics` | `true` | CPU / bellek / FPS örnekleri (yalnızca bağlıyken) |
| `interceptUploadTasks` | `true` | Upload görevleri; `false` → `didSendBodyData` ilerleme bildirimleri korunur |
| `ignoredHosts` | `[]` | Hiç yakalanmayacak alan adları (alt alan adları dahil) |
| `redactHeaders` | `[]` | Değeri `••••` gösterilecek başlıklar (büyük/küçük harf duyarsız), ör. `["Authorization", "Cookie"]`; gerçek istek değişmez |
| `maxBufferedMessages` | `5000` | Bağlantı yokken tutulan mesaj sayısı |
| `allowInReleaseBuilds` | `false` | DEBUG olmayan derlemelerde çalışmaya zorla |

### Mock'lar

Kurallar masaüstünde (Mock'lar sekmesi) tanımlanır, SDK'ya canlı iletilir; eşleştirme protokoldeki
`mockRuleMatches` ile birebir aynıdır (testler TypeScript referansından üretilen 2 700+ vaka ile
doğrular). Mock'lanan istekler masaüstünde `mocked` olarak işaretlenir.

| Eylem | Uygulamanın gördüğü |
|---|---|
| `respond` | Ağa hiç çıkmadan sentezlenen yanıt (durum, başlıklar, utf8/base64 gövde, isteğe bağlı gecikme). JSON gövdede `Content-Type` yoksa `application/json` eklenir |
| `delay` | Belirtilen süre bekledikten sonra gerçek istek |
| `fail` | `timeout` → `URLError.timedOut`, `connection` → `.cannotConnectToHost`, `dns` → `.cannotFindHost`, `tls` → `.secureConnectionFailed`, `custom` → `.unknown` (mesajınızla) |

### Release güvenliği

- `Durbun.start()` çağrısı `#if DEBUG` içindeyse release derlemesi SDK'yı hiç başlatmaz.
- SDK kendisi de DEBUG olmadan derlendiğinde **hiçbir şey yapmaz** (`allowInReleaseBuilds: true` ile zorlamadıkça).
  `allowInReleaseBuilds: true` ile uygulama nereden kurulursa kurulsun (Xcode, ad-hoc, TestFlight, App Store)
  çalışır. Hangi derlemenin Dürbün'ü çalıştıracağına proje karar verir.
- Bağlantı koptuğunda o bağlantının gönderdiği mock kuralları hemen silinir; masaüstü yeniden bağlanınca tekrar
  gönderir.
- Güvenlik notu: bağlantıda henüz eşleştirme (pairing) yok. Dürbün açık bir derleme fiziksel cihazda
  `127.0.0.1:9752–9755` portlarından birini dinler ve o porta bağlanan eşle konuşur: usbmux üzerinden masaüstü ya da
  cihazdaki başka bir uygulama. Loglar ve ağ trafiği o eşe gider; eş bağlı kaldığı sürece gönderdiği mock kuralları
  uygulanır.
- `DURBUN_DISABLED=1` ortam değişkeni SDK'yı tamamen kapatır; SwiftUI önizlemelerinde (Xcode Previews) SDK zaten devre dışıdır.
- Bütün G/Ç arka plan kuyruklarında yapılır, kuyruklar sınırlıdır, SDK kendi hatalarını yutar ve
  uygulamayı asla çökertmez. Ağ istekleri dokunulmadan iletilir (tee); zaman aşımları ve sertifika
  doğrulama (pinning) uygulamanın kendi oturumu tarafından yapılmaya devam eder.

### Bilinen sınırlamalar

- **Arka plan URLSession**'ları (`.background(withIdentifier:)`) süreç dışında çalıştığı için yakalanamaz.
- URLProtocol **yükleme ilerlemesini** bildiremez: upload görevlerinde `didSendBodyData` çağrılmaz
  (gerekirse `interceptUploadTasks: false`).
- Yakalanan istek, onu başlatan oturumun yapılandırmasının bir kopyasıyla iletilir: aynı `URLCache` (ya da
  önbelleksiz), çerez ve kimlik deposu, proxy, TLS sınırları, `waitsForConnectivity`, hücresel/pahalı/kısıtlı ağ
  kuralları ve bağlantı sınırları. Bu, `start()`'tan sonra oluşturulan oturumlar için geçerlidir; `URLSession.shared`
  varsayılan yapılandırmayı kullanır. 32'den fazla farklı oturum yapılandırması oluşturan uygulamalarda sonrakiler
  yakalanmaz (Dürbün yokmuş gibi çalışır).
- Akış (`httpBodyStream`) ya da dosya/veri upload gövdeleri en fazla yakalama sınırı + 256 KB (en az 1,25 MB) kadar
  bellekte tutulur; daha büyükleri akıtılarak iletilir. Akıtılan gövde geri sarılamaz: o istekte gövdeyi yeniden
  göndermesi gereken bir 307/308 yönlendirmesi ya da kimlik doğrulama yeniden denemesi başarısız olur. Daha küçük
  gövdeler ve `httpBody` normal şekilde yeniden gönderilir.
- WKWebView ve AVPlayer trafiği URLSession protokollerinden geçmez.
- `os_log` / `Logger` / `NSLog` mesajlarını masaüstü cihaz loglarından okur (simülatör, USB). Okuyamadığında
  (Wi-Fi, `idevicesyslog` yok) SDK iOS 15+'ta uygulamanın kendi log deposundan saniyede bir okuyup
  gönderir; iOS `debug` seviyesini tutmaz, `com.apple.*` satırları atlanır. `captureStdout: false` kapatır.
- `regex` mock kuralları NSRegularExpression (ICU) ile çalışır; tipik URL kalıplarında JavaScript ile
  aynıdır, yalnızca JS'e özgü egzotik sözdizimi farklı davranabilir.
- FPS / takılan kare yalnızca iOS'ta (macOS'ta CADisplayLink yok).

### Geliştirme

```bash
cd sdks/ios
swift build -j 2
swift test -j 2
xcodebuild -scheme Durbun -destination 'generic/platform=iOS Simulator' -quiet build
node scripts/generate-mock-vectors.mjs   # mock eşleştirme test vakalarını TypeScript referansından yeniden üretir
```

---

## English

> **Flutter app?** Do not add this package separately. The Flutter package
> [`package:durbun`](../flutter/durbun/README.md) already carries this iOS core (URLSession, crashes,
> stdout/stderr) and starts it from Dart; no `Durbun.start()` call (in a Flutter app it does nothing). Log from
> Swift with `import durbun`.
> This page is for native-only iOS apps. After changing the sources here, run
> `dart run tool/sync_native.dart` in `sdks/flutter/durbun` (the plugin carries an exact copy).

### What is captured

| What | How it shows up |
|---|---|
| `Durbun.log / debug / info / warning / error` | Structured log with level, tag, JSON `data`, error and call-site stack |
| `print`, `debugPrint`, `NSLog`, `printf`, stderr | Logs tagged `stdout` / `stderr`. Xcode's console **keeps working** (every byte is written through). Multi-line output (pretty JSON, `dump()`, stack traces) is grouped into one entry; levels are inferred from markers like `[ERROR]`, `Warning:`, `❌`; NSLog's date/process prefix is stripped |
| Crashes | Uncaught Objective-C exceptions **immediately** (`kind: crash`). Swift runtime traps (force-unwrapping `nil`, index out of range, `fatalError`), EXC_BAD_ACCESS and other fatal signals **on the next launch**, with the last console lines ("Fatal error: …") and a backtrace |
| Network | `URLSession.shared` **and** your own sessions (Alamofire included): headers, bodies, redirects, timings (DNS/TCP/TLS/wait/receive), protocol (h2/h3), errors and cancellations |
| Mocks | Rules defined on the desktop: synthesized responses, latency, natural failures (timeout, connection, DNS, TLS) |
| Performance | CPU (%), memory (phys_footprint, the number Xcode shows), thread count, FPS and janky frames (CADisplayLink) |
| Events | `Durbun.event("purchase", ["amount": 49.9])` |
| App tools | From the desktop's Device panel: light/dark appearance, slow animations, view hierarchy dump, UserDefaults dump + your own buttons via `registerAction` |

### Installation

**Swift Package Manager:** Xcode → **File → Add Package Dependencies…** → `https://github.com/mykynk/durbun`
→ add the **Durbun** product to your app target. In a `Package.swift`:

```swift
.package(url: "https://github.com/mykynk/durbun", from: "0.1.0"),
// in the target:
.product(name: "Durbun", package: "durbun"),
```

**CocoaPods:**

```ruby
pod 'Durbun'
# Optional: links it into the Debug configuration only, so Release builds contain no Dürbün code.
# Then `import Durbun` and every call must be inside `#if DEBUG`, or the Release build does not compile.
# pod 'Durbun', :configurations => ['Debug']
```

With SwiftPM the package is linked into every configuration; compiled without `DEBUG` the SDK does nothing by
itself (see Release safety). The package ships a privacy manifest (`PrivacyInfo.xcprivacy`, `CA92.1` for the
UserDefaults dump).

**From a local path (developing the SDK):** Xcode → **Add Local…** → `sdks/ios` in this repository. From another
Swift package: `.package(path: "../durbun/sdks/ios")` and `.product(name: "Durbun", package: "ios")` (a local path
dependency is identified by its folder name, `ios`).

### Start

Call it as early as possible (sessions created **after** `start()` are captured):

```swift
import Durbun

#if DEBUG
Durbun.start()                                        // simulator and USB: nothing to configure
// Durbun.start(options: .init(host: "192.168.1.20"))  // Wi-Fi
#endif

Durbun.log("Logged in", level: .info, tag: "auth", data: ["userId": 42])
Durbun.error("Payment failed", error: error, tag: "payment")
Durbun.event("purchase", ["amount": 49.9])
```

### Connecting

| Setup | What to do |
|---|---|
| **Simulator** | Nothing. The SDK connects to `127.0.0.1:9751`; `SIMULATOR_UDID` lets the desktop match the right simulator. |
| **iPhone/iPad over USB** | Nothing. The SDK listens on the first free port of `127.0.0.1:9752…9755` on the device and the desktop connects through usbmux. Loopback only: nobody on the network can connect and no Local Network permission is needed. |
| **Wi-Fi** | `Durbun.start(options: .init(host: "192.168.1.20"))` or `DURBUN_HOST=192.168.1.20` in the Xcode scheme. Add `NSLocalNetworkUsageDescription` to Info.plist (iOS asks on the first connection) and start the desktop with `durbun --lan`. |

The SDK reconnects forever with a 0.5 s → 3 s backoff, keeps the last 5,000 messages while
disconnected and flushes them in order (with one warning line if some had to be dropped). Whichever
path completes the `hello` → `welcome` handshake first wins; the others are closed.

### Options (`DurbunOptions`)

`host` (Wi-Fi IP, or `DURBUN_HOST`), `port` (9751), `devicePorts` (9752…9755), `enabled`, `captureStdout`,
`captureNetwork`, `captureCrashes`, `collectMetrics`, `interceptUploadTasks`, `ignoredHosts`,
`redactHeaders` (header names, case-insensitive, whose values show as `••••`, e.g.
`["Authorization", "Cookie"]`; the real request is unchanged), `maxBufferedMessages` (5000),
`allowInReleaseBuilds`.

### Release safety

- With `Durbun.start()` inside `#if DEBUG`, release builds never start the SDK.
- The SDK itself is inert when compiled without `DEBUG` unless `allowInReleaseBuilds: true`; with it the SDK runs
  wherever the app was installed from (Xcode, ad-hoc, TestFlight, App Store). Each project decides which builds run
  Dürbün.
- When the connection drops, the mock rules it pushed are dropped at once; the desktop sends them again when it
  reconnects.
- Security note: the link has no pairing yet. On a physical device a build with Dürbün on listens on one of
  `127.0.0.1:9752–9755` and talks to whatever connects there: the desktop (through usbmux) or another app on the
  device. Logs and network traffic go to that peer, and the mock rules it pushes apply while it stays connected.
- `DURBUN_DISABLED=1` turns it off completely; it also stays off inside SwiftUI previews (Xcode Previews).
- All I/O runs on background queues with bounded buffers; the SDK swallows its own errors and never
  crashes the app. Requests are forwarded untouched (tee); timeouts and certificate validation
  (pinning) are still enforced by your own session.

### Known limitations

- **Background URLSessions** run out of process and cannot be intercepted.
- URLProtocol cannot report **upload progress**: `didSendBodyData` is not called for intercepted
  upload tasks (use `interceptUploadTasks: false` if your UI depends on it).
- An intercepted request is performed with a copy of its own session's configuration: the same `URLCache`
  (or none), cookie and credential storage, proxy, TLS limits, `waitsForConnectivity`, cellular / expensive /
  constrained rules and connection limits. This holds for sessions created after `start()`; `URLSession.shared`
  uses the default configuration. In an app that creates more than 32 distinct session configurations, later
  ones are not captured (they run as without Dürbün).
- Stream (`httpBodyStream`) and file/data upload bodies are held in memory only up to the capture limit +
  256 KB (at least 1.25 MB); larger ones are streamed through. A streamed body cannot be rewound: a 307/308
  redirect or an authentication retry that has to resend it fails for that request. Smaller bodies and
  `httpBody` are resent as usual.
- WKWebView and AVPlayer traffic does not go through URLSession protocols.
- The desktop reads `os_log` / `Logger` / `NSLog` messages from device logs (simulator, USB). When it
  cannot (Wi-Fi, no `idevicesyslog`), the SDK reads the app's own log store once a second on iOS 15+ and
  sends them; iOS does not keep `debug` entries, `com.apple.*` lines are skipped. `captureStdout: false`
  turns it off.
- `regex` mock rules use NSRegularExpression (ICU): identical to JavaScript for typical URL patterns,
  only exotic JS-specific syntax may differ.
- FPS / janky frames are iOS-only (no CADisplayLink on macOS).

### Development

```bash
cd sdks/ios
swift build -j 2
swift test -j 2
xcodebuild -scheme Durbun -destination 'generic/platform=iOS Simulator' -quiet build
node scripts/generate-mock-vectors.mjs   # regenerates mock-matching vectors from the TypeScript reference
```
