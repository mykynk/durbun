# Dürbün Android SDK

[Türkçe](#türkçe) · [English](#english)

---

## Türkçe

> **Flutter uygulaması mı?** Bu SDK'yı ayrıca eklemeyin. Flutter paketi
> [`package:durbun`](../flutter/durbun/README.md) bu Android çekirdeğini zaten içinde taşır ve Dart
> tarafı başlattığında çalıştırır (`Durbun.start` çağrısı gerekmez; Flutter uygulamasında çağrılırsa hiçbir şey
> yapmaz). Native kodunuzda OkHttp varsa tek
> satır yeter: `.addInterceptor(DurbunInterceptor())`. Bu sayfa yalnızca Flutter'sız (native-only)
> Android uygulamaları içindir.

Dürbün Android SDK'sı, uygulamanızın **loglarını, OkHttp ağ trafiğini (başlıklar, gövdeler, süreler),
çökmelerini, olaylarını ve performans ölçümlerini** (CPU, bellek, FPS, takılan kareler) Mac'teki Dürbün
masaüstü uygulamasına **canlı** gönderir. Masaüstünden mock tanımlayabilir (sahte yanıt, gecikme, zaman aşımı /
DNS / TLS / bağlantı hatası) ve uygulamanın içinde çalışan butonlar ekleyebilirsiniz.

**Hiçbir log kaybolmaz:**

| Kaynak | Nasıl gelir |
|---|---|
| Cihaz logları (logcat, tüm süreçler) | USB / kablosuz adb ile Dürbün masaüstü okur — SDK gerekmez |
| `Durbun.log(...)`, Timber | SDK, etiket + seviye + JSON verisi + tam stack trace ile yapılandırılmış olarak gönderir |
| Wi-Fi'de (adb yokken) uygulamanın kendi logcat'i | SDK kendi logcat'ini okuyup iletir (çok satırlı mesajlar birleştirilir) |
| Ağ (OkHttp) | `DurbunInterceptor` |
| Çökmeler | Yakalanmamış istisnalar; masaüstüne ulaşamayan çökme bir sonraki açılışta gönderilir |

Masaüstü her satırı okunaklı gösterir: seviye rengi, etiket rengi, katlanan stack trace'ler, JSON ağacı,
log akışının içinde `→ GET /api/users 200 · 123 ms` satırları.

### 1. Bağımlılığı ekleyin

Maven Central (`mavenCentral()` deposu tanımlı olmalı):

```kotlin
dependencies {
    debugImplementation("io.github.mykynk:durbun:0.1.0")        // gerçek SDK yalnızca debug'da
    releaseImplementation("io.github.mykynk:durbun-noop:0.1.0") // release'te aynı API, boş gövdeler
    // Flutter host uygulamalarında "profile" build type'ı da vardır:
    // "profileImplementation"("io.github.mykynk:durbun-noop:0.1.0")
}
```

Yayımlanan AAR'lar Kotlin 1.9 API/metadata ile derlenir ve `kotlin-stdlib` 1.9.24 ister; Kotlin 1.9 ve
üzerindeki uygulamalarda çalışır.

**Alternatif — yerel klasörden** (SDK'yı kaynaktan derlemek için). `settings.gradle.kts` (yol, Dürbün deposunun
klonlandığı yere göre):

```kotlin
include(":durbun", ":durbun-noop")
project(":durbun").projectDir = file("../durbun/sdks/android/durbun")
project(":durbun-noop").projectDir = file("../durbun/sdks/android/durbun-noop")
```

Groovy (`settings.gradle`):

```groovy
include ':durbun', ':durbun-noop'
project(':durbun').projectDir = new File(rootDir, '../durbun/sdks/android/durbun')
project(':durbun-noop').projectDir = new File(rootDir, '../durbun/sdks/android/durbun-noop')
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation(project(":durbun"))        // gerçek SDK yalnızca debug'da
    releaseImplementation(project(":durbun-noop")) // release'te aynı API, boş gövdeler
    // Flutter host uygulamalarında "profile" build type'ı da vardır:
    // "profileImplementation"(project(":durbun-noop"))
}
```

Gereksinimler: minSdk 21+. Yerel klasörden eklenen modüller `com.android.library` ve
`org.jetbrains.kotlin.android` eklentilerini **sürümsüz** uygular; yani projenizin kökünde Android Gradle Plugin ve Kotlin eklentisi tanımlı olmalı
(Android Studio projelerinde zaten öyledir). OkHttp isteğe bağlıdır ve sizin sürümünüz kullanılır (4.x ile test edildi, 3.14 ile ikili uyumluluğu
doğrulandı; 5.x aynı API'yi kullanır).
Ek bağımlılık yoktur (AndroidX bile yok).

### 2. Application içinde başlatın

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Durbun.start(this)   // USB ve emülatör için başka ayar gerekmez
    }
}
```

`start()` ana thread'i bloklamaz; tüm ağ ve disk işleri Dürbün'ün düşük öncelikli arka plan thread'lerinde
yapılır. SDK uygulamanızı asla çökertmez: iç hatalar yutulur, kuyruklar sınırlıdır.

### 3. OkHttp

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())   // Retrofit'e de bu client'ı verin
    .build()
```

- Kendi interceptor'larınızın eklediği başlıkları (ör. `Authorization`) görmek için `DurbunInterceptor`'ı
  **en son** application interceptor olarak ekleyin.
- Her yönlendirmeyi/yeniden denemeyi ayrı görmek isterseniz `addNetworkInterceptor(DurbunInterceptor())`
  kullanın (gzip/deflate gövdeler otomatik çözülür; uzak IP adresi de görünür). Bu konumda OkHttp
  istekleri kısa devre etmeye izin vermez: `respond` mock'ları atlanır (gecikme ve hata mock'ları çalışır).
- Gövdeler uygulamanın akışına dokunulmadan yakalanır: istek gövdesi OkHttp onu sunucuya yazarken kopyalanır
  (hiçbir gövde iki kez yazılmaz; `InputStream`/dosya akışları, ilerleme gösteren gövdeler, one-shot gövdeler güvenle
  çalışır), yanıt gövdesi uygulama okudukça kopyalanır (Dürbün önden okumaz, `execute()` başlıklar gelince döner).
  İstek önce boyutuyla, gövde yazılınca aynı kimlikle içeriğiyle bildirilir; yanıt gövde bitince, yakalama sınırı
  dolunca ya da uygulama gövdeyi kapatınca bildirilir. Hiç okunmadan kapatılan gövdenin yalnızca boyutu görünür;
  hiç kapatılmayan (sızan) yanıt masaüstünde bekliyor kalır. SSE (`text/event-stream`), NDJSON, WebSocket, gRPC
  ve ses/video akışlarının yalnızca boyutu bildirilir.
- Gövdeyi izlemek için interceptor, `FormBody` dışındaki istek gövdelerini ve yakalanan yanıt gövdelerini ince bir
  sarmalayıcıyla sonraki zincire verir (tip, uzunluk, one-shot/duplex bayrakları aynen iletilir). Kendi
  interceptor'larınız gövde sınıfına bakıyorsa (`body is MultipartBody` gibi) `DurbunInterceptor`'ı onlardan sonra
  ekleyin.
- Gizli başlıkları maskeleyin: `DurbunInterceptor(redactHeaders = setOf("Authorization", "Cookie"))` (değer `••••`
  görünür).
- Masaüstündeki mock kuralları burada uygulanır: `respond` ağa hiç çıkmadan yanıt üretir (istek gövdesi bu
  durumda bir kez yan tampona yazılır), `delay` gecikip gerçek isteği yapar, `fail` gerçek platform hatasını
  fırlatır (`SocketTimeoutException`, `UnknownHostException`, `ConnectException`, `SSLHandshakeException`).

**Neler yakalanmaz:** Yalnızca `DurbunInterceptor` eklenmiş `OkHttpClient`'lar görünür. Her client'a ayrı
eklenmeli: Retrofit, Coil, Glide'ın OkHttp entegrasyonu (`okhttp3-integration`), Ktor'un OkHttp motoru kendi
client'larını kullanıyorsa onlara da ekleyin. `HttpURLConnection` üzerinden giden trafik görünmez: Volley
(`HurlStack`), ExoPlayer/Media3 `DefaultHttpDataSource`, Glide'ın varsayılan yükleyicisi, Ktor CIO / Android
motoru, Cronet, WebView ve native (C/C++) kod.

### 4. Loglar ve olaylar

```kotlin
Durbun.i("auth", "Kullanıcı giriş yaptı", data = mapOf("userId" to 42, "plan" to "premium"))
Durbun.w("sync", "Senkronizasyon yavaş", data = mapOf("ms" to 2300))
Durbun.e("payment", "Ödeme başarısız", throwable = e)
Durbun.log(Level.DEBUG, "cache", "Önbellek temizlendi")
Durbun.event("purchase", mapOf("amount" to 49.9, "currency" to "TRY"))
```

`data` olarak Map, List, sayı, enum, `JSONObject`, Gson / kotlinx.serialization JSON nesneleri
verebilirsiniz; masaüstünde açılır kapanır JSON ağacı olarak görünür.

#### Timber

```kotlin
class DurbunTree : Timber.Tree() {
    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        Durbun.log(Level.fromPriority(priority), tag ?: "app", message, throwable = t)
    }
}

// Application.onCreate
Timber.plant(Timber.DebugTree(), DurbunTree())
```

Timber stack trace'i mesajın sonuna da ekler; SDK bu kopyayı ayıklar, böylece mesaj bir kez, stack trace bir
kez (katlanmış) görünür. `DebugTree` aynı satırı logcat'e de yazar; Wi-Fi'de SDK bu kopyayı ayıklar, USB'de
masaüstü aynı satırları tekilleştirir.

### 5. Masaüstüne uygulama butonları (isteğe bağlı)

```kotlin
Durbun.addAction(DurbunAction.button("app.logout", "Çıkış yap") { session.logout() })
Durbun.addAction(DurbunAction.toggle("app.staging", "Staging API", initial = false) { useStaging = it })
Durbun.addAction(
    DurbunAction.select(
        "app.locale", "Dil",
        listOf(DurbunAction.Option("tr", "Türkçe"), DurbunAction.Option("en", "English")),
        initial = "tr",
    ) { locale -> changeLocale(locale) },
)
```

Handler'lar ana thread'de çalışır. Hazır gelen butonlar: **Dump threads** (tüm thread'lerin stack'i log
olarak) ve **Run garbage collection**.

### Bağlantı nasıl kurulur?

- **USB (kablolu veya kablosuz adb):** Dürbün masaüstü cihaz bağlanınca otomatik olarak
  `adb reverse tcp:9751 …` kurar; SDK cihazda `127.0.0.1:9751`'e bağlanır. Sizin bir şey yapmanız gerekmez.
  Kontrol: `adb reverse --list`.
- **Emülatör:** Aynı şekilde adb reverse; ek olarak `10.0.2.2:9751` (Mac'in kendisi) yedek olarak denenir.
- **Yalnızca Wi-Fi (adb yok):** Masaüstünde LAN modunu açın (`durbun --lan` ya da Ayarlar → LAN) ve Mac'in
  IP adresini verin:

  ```kotlin
  Durbun.start(this, DurbunOptions(host = "192.168.1.20"))
  // veya: DurbunOptions(host = BuildConfig.DURBUN_HOST)
  ```

  Bu modda masaüstü cihaz loglarını göremediği için SDK uygulamanın **kendi logcat'ini** iletir.
- Bağlantı koparsa SDK 0,5 sn → 3 sn aralıklarla sonsuza kadar yeniden bağlanır; bu sırada son 5 000 mesaj
  bellekte tutulur ve bağlanınca gönderilir (taşan mesaj sayısı bir uyarı satırıyla bildirilir).
- Sorun giderme: logcat'te `Durbun` etiketine bakın
  (`Waiting for the Dürbün desktop on 127.0.0.1:9751 …`, `Connected to the Dürbün desktop via …`).

### İzinler, cleartext ve release güvenliği

- `durbun` modülünün manifesti `INTERNET` iznini ekler (yalnızca debug'a karışır).
- Dürbün **HTTP değil, düz TCP soketi** kullanır: `usesCleartextTraffic` veya network security config
  değişikliği **gerekmez**.
- `durbun-noop` ile derlenen yapıda Dürbün kodu, thread'i ve soketi yoktur. `durbun` ile derlenen ve debuggable
  olmayan bir yapıda `Durbun.start()` hiçbir şey yapmaz; `forceInRelease = true` ile çalışır, uygulama nereden
  kurulursa kurulsun (Firebase, Google Play, başka mağazalar, adb). Hangi derlemenin Dürbün'ü çalıştıracağına proje
  karar verir.
- Bağlantı koptuğunda o bağlantının gönderdiği mock kuralları hemen silinir; masaüstü yeniden bağlanınca tekrar
  gönderir.
- Güvenlik notu: bağlantıda henüz eşleştirme (pairing) yok. Dürbün açık bir derleme cihazda `127.0.0.1:9751`'e
  bağlanır ve orada yanıt veren eşle konuşur: adb reverse üzerinden masaüstü ya da o portu dinleyen başka bir
  uygulama. Loglar ve ağ trafiği o eşe gider; eş bağlı kaldığı sürece gönderdiği mock kuralları uygulanır.
- R8/ProGuard için ek kural gerekmez: OkHttp kullanmayan uygulamalar için modül, yalnızca SDK'nın başvurduğu
  OkHttp/Okio sınıfları için `-dontwarn` satırları getirir (uygulamanızın kendi eksik OkHttp sınıfları R8'de
  yine hata olarak görünür).

### Seçenekler (`DurbunOptions`)

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `host` | `null` | Wi-Fi için Mac'in IP'si (USB/emülatörde gerekmez) |
| `port` | `9751` | Masaüstü SDK portu |
| `enabled` | `true` | `false` → her çağrı no-op |
| `forceInRelease` | `false` | Debuggable olmayan build'de de çalış |
| `captureBodies` | `null` | Masaüstü ayarını ez (`false` → yalnızca boyutlar) |
| `maxBodyBytes` | `null` | Gövde başına yakalama sınırı (masaüstü varsayılanı 1 MB) |
| `maxBufferedMessages` | `5000` | Bağlantı yokken bellekte tutulan mesaj sayısı |
| `captureCrashes` | `true` | Yakalanmamış istisnaları raporla (önceki handler her zaman çalışır) |
| `captureMetrics` | `true` | CPU, PSS bellek, Java heap, thread sayısı, FPS, takılan kareler |
| `captureLogcat` | `true` | Masaüstü cihaz loglarını göremiyorsa uygulamanın logcat'ini ilet |
| `appName` | `null` | Masaüstünde görünen ad (varsayılan: uygulama etiketi) |
| `captureNetwork` | `true` | `DurbunInterceptor` ile OkHttp yakalama + mock'lar (`false` → interceptor isteğe dokunmaz) |

### Geliştirme

```bash
cd sdks/android
./gradlew --offline --no-daemon --max-workers=2 \
  :durbun:testDebugUnitTest :durbun:assembleDebug :durbun-noop:assembleRelease
pkill -f GradleDaemon; pkill -f KotlinCompileDaemon   # bitince
```

Gerçek bir Dürbün masaüstüne karşı uçtan uca test (masaüstü SDK portu 9751, HTTP portu varsayılan olarak
SDK portu − 1; farklıysa `DURBUN_E2E_HTTP_PORT`). `DURBUN_E2E_PORT` verilmezse test atlanır:

```bash
DURBUN_E2E_PORT=9751 ./gradlew --offline --no-daemon --max-workers=2 :durbun:testDebugUnitTest --tests '*E2E*'
```

Mock eşleştirme testi, protokoldeki referans `mockRuleMatches` fonksiyonundan üretilen
`durbun/src/test/resources/mock-parity.json` dosyasını kullanır. Yeniden üretmek için (depo kökünden):
`node --import tsx sdks/android/tools/gen-mock-parity.mjs`.

Derlemeden sonra `python3 -I tools/check-binary-compat.py`: `durbun` / `durbun-noop` API eşliği, OkHttp 3.14 +
Okio 1.x ile ikili uyum ve tüketici R8 kurallarının kapsamı.

Yayımlama (sürüm tek yerde: `durbun/src/main/kotlin/dev/durbun/Durbun.kt` içindeki `Durbun.VERSION`):

```bash
./gradlew --offline --no-daemon publishToMavenLocal                         # ~/.m2'ye
./gradlew --no-daemon publishReleasePublicationToStagingRepository          # build/staging-deploy
```

`build/staging-deploy` klasörü zip'lenip Maven Central Portal'a yüklenir. İmza yalnızca anahtar verildiğinde
yapılır: `signingInMemoryKey` (+ `signingInMemoryKeyPassword`, isteğe bağlı `signingInMemoryKeyId`) Gradle
özellikleri ya da `ORG_GRADLE_PROJECT_signingInMemoryKey` gibi ortam değişkenleri veya klasik `signing.keyId`
ayarları.

---

## English

> **Flutter app?** Do not add this SDK separately. The Flutter package
> [`package:durbun`](../flutter/durbun/README.md) already carries this Android core and starts it from
> Dart (no `Durbun.start` call; in a Flutter app it does nothing). If your native code uses OkHttp, one line is enough:
> `.addInterceptor(DurbunInterceptor())`. This page is for native-only Android apps.

The Dürbün Android SDK streams your app's **logs, OkHttp traffic (headers, bodies, timings), crashes, custom
events and performance metrics** (CPU, memory, FPS, janky frames) to the Dürbün desktop app on your Mac, live.
From the desktop you can mock requests (fake responses, latency, timeouts / DNS / TLS / connection failures)
and trigger buttons that run code inside the app.

**No log is left behind:**

| Source | How it arrives |
|---|---|
| Device logs (logcat, all processes) | Read by the desktop over USB / wireless adb — no SDK needed |
| `Durbun.log(...)`, Timber | Sent by the SDK as structured entries: tag, level, JSON data, full stack trace |
| The app's own logcat over Wi-Fi (no adb) | Forwarded by the SDK (multi-line messages merged back) |
| Network (OkHttp) | `DurbunInterceptor` |
| Crashes | Uncaught exceptions; a crash that cannot reach the desktop is sent on the next launch |

### 1. Add the dependency

From Maven Central (`mavenCentral()` in your repositories):

```kotlin
dependencies {
    debugImplementation("io.github.mykynk:durbun:0.1.0")
    releaseImplementation("io.github.mykynk:durbun-noop:0.1.0")
    // Flutter host apps also have a "profile" build type:
    // "profileImplementation"("io.github.mykynk:durbun-noop:0.1.0")
}
```

The published AARs are compiled with Kotlin 1.9 API/metadata and depend on `kotlin-stdlib` 1.9.24, so they work
in apps on Kotlin 1.9 and newer.

**Alternative — from a local path** (to build the SDK from source). `settings.gradle.kts` (adjust the path to
where the Dürbün repository is cloned):

```kotlin
include(":durbun", ":durbun-noop")
project(":durbun").projectDir = file("../durbun/sdks/android/durbun")
project(":durbun-noop").projectDir = file("../durbun/sdks/android/durbun-noop")
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation(project(":durbun"))
    releaseImplementation(project(":durbun-noop"))
    // Flutter host apps also have a "profile" build type:
    // "profileImplementation"(project(":durbun-noop"))
}
```

Requirements: minSdk 21+. Included from a local path, the modules apply `com.android.library` and
`org.jetbrains.kotlin.android` **without versions**, so your root build must declare the Android Gradle Plugin and the Kotlin plugin (standard
in Android Studio projects). OkHttp is optional and your own version is used (tested with 4.x, binary compatibility with 3.14
checked; 5.x keeps the same API). No other
dependencies (not even AndroidX).

### 2. Start it in your Application

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Durbun.start(this)   // nothing else needed for USB and emulators
    }
}
```

`start()` never blocks the main thread; networking and disk work happen on Dürbün's low-priority background
threads. The SDK never crashes your app: internal errors are swallowed and every queue is bounded.

### 3. OkHttp

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())   // hand the same client to Retrofit
    .build()
```

- Add it as the **last** application interceptor to see headers your own interceptors add (e.g. auth).
- Use `addNetworkInterceptor(DurbunInterceptor())` to see every redirect / retry separately (gzip and
  deflate bodies are decoded automatically, the remote IP is shown). OkHttp does not let network
  interceptors short-circuit, so `respond` mocks are skipped there (delay and failure mocks still work).
- Bodies are captured without touching the app's streams: a request body is copied while OkHttp writes it to
  the server (no body is ever written twice, so `InputStream` / file streams, progress-reporting and one-shot
  bodies are safe), a response body is copied as the app reads it (Dürbün never reads ahead; `execute()` returns
  as soon as the headers arrive). The request is reported first with its size, then again (same id) with its
  body once written; the response is reported at end of body, at the capture limit or when the app closes the
  body. A body closed unread shows its size only; a response that is never closed (leaked) stays pending on the
  desktop. SSE (`text/event-stream`), NDJSON, WebSocket, gRPC and audio/video streams are reported with their
  size only.
- To observe bodies, the interceptor hands request bodies (except `FormBody`) and captured response bodies down
  the chain in a thin wrapper (content type, length, one-shot / duplex flags are forwarded). If your own
  interceptors check body classes (`body is MultipartBody`), add `DurbunInterceptor` after them.
- Mask secrets: `DurbunInterceptor(redactHeaders = setOf("Authorization", "Cookie"))` (values show as `••••`).
- Desktop mock rules apply here: `respond` synthesizes the response without touching the network (the request
  body is then written once, to a side buffer), `delay` waits then performs the real call, `fail` throws the
  platform's real exception (`SocketTimeoutException`, `UnknownHostException`, `ConnectException`,
  `SSLHandshakeException`).

**Not captured:** only `OkHttpClient`s with `DurbunInterceptor` are seen, and every client needs it: Retrofit,
Coil, Glide's OkHttp integration (`okhttp3-integration`) and Ktor's OkHttp engine when they build their own
client. Traffic over `HttpURLConnection` is not seen: Volley (`HurlStack`), ExoPlayer / Media3
`DefaultHttpDataSource`, Glide's default loader, Ktor's CIO / Android engines, Cronet, WebView and native
(C/C++) code.

### 4. Logs and events

```kotlin
Durbun.i("auth", "Logged in", data = mapOf("userId" to 42))
Durbun.e("payment", "Payment failed", throwable = e)
Durbun.log(Level.INFO, "auth", "Logged in", data = mapOf("userId" to 42))
Durbun.event("purchase", mapOf("amount" to 49.9))
```

Timber:

```kotlin
class DurbunTree : Timber.Tree() {
    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        Durbun.log(Level.fromPriority(priority), tag ?: "app", message, throwable = t)
    }
}
Timber.plant(Timber.DebugTree(), DurbunTree())
```

Timber appends the stack trace to the message as well; the SDK removes that copy so the desktop shows the
message once and the (folded) stack trace once.

### 5. Desktop buttons for your app (optional)

```kotlin
Durbun.addAction(DurbunAction.button("app.logout", "Log out") { session.logout() })
Durbun.addAction(DurbunAction.toggle("app.staging", "Use staging API", initial = false) { useStaging = it })
```

Handlers run on the main thread. Built in: **Dump threads** and **Run garbage collection**.

### How the connection works

- **USB (cable or wireless adb):** the desktop runs `adb reverse tcp:9751 …` automatically when the device
  appears; the SDK connects to `127.0.0.1:9751` on the device. Nothing to configure (`adb reverse --list`).
- **Emulator:** the same, plus `10.0.2.2:9751` (the Mac itself) as a fallback.
- **Wi-Fi only (no adb):** enable LAN mode on the desktop (`durbun --lan` or Settings → LAN) and pass the
  Mac's IP: `Durbun.start(this, DurbunOptions(host = "192.168.1.20"))`. The SDK then also forwards the app's
  own logcat, because the desktop cannot read device logs.
- Reconnects forever with 0.5 s → 3 s backoff; the last 5 000 messages are buffered meanwhile and flushed on
  reconnect (a warning line reports how many were dropped, if any).
- Troubleshooting: filter logcat by the `Durbun` tag.

### Permissions, cleartext, release safety

- The `durbun` manifest adds `INTERNET` (merged into debug builds only).
- Dürbün uses a **plain TCP socket, not HTTP**: no `usesCleartextTraffic` / network security config changes.
- A build with `durbun-noop` has no Dürbün code, threads or sockets. In a non-debuggable build with `durbun`,
  `Durbun.start()` does nothing unless `forceInRelease = true`; with it the SDK runs wherever the app was installed
  from (Firebase, Google Play, other stores, adb). Each project decides which builds run Dürbün.
- When the connection drops, the mock rules it pushed are dropped at once; the desktop sends them again when it
  reconnects.
- Security note: the link has no pairing yet. A build with Dürbün on connects to `127.0.0.1:9751` on the device and
  talks to whatever answers there: the desktop (through adb reverse) or another app listening on that port. Logs and
  network traffic go to that peer, and the mock rules it pushes apply while it stays connected.
- No R8/ProGuard rules needed: for apps without OkHttp the modules ship `-dontwarn` lines for exactly the
  OkHttp/Okio classes the SDK references (missing OkHttp classes your own code needs are still reported by R8).

### Options (`DurbunOptions`)

`host` (Wi-Fi IP), `port` (9751), `enabled`, `forceInRelease`, `captureBodies` / `maxBodyBytes` (override the
desktop settings), `maxBufferedMessages` (5000), `captureCrashes`, `captureMetrics`, `captureLogcat`, `appName`,
`captureNetwork` (`false` makes `DurbunInterceptor` a pass-through: no capture, no mocks).

### Development

```bash
cd sdks/android
./gradlew --offline --no-daemon --max-workers=2 \
  :durbun:testDebugUnitTest :durbun:assembleDebug :durbun-noop:assembleRelease
pkill -f GradleDaemon; pkill -f KotlinCompileDaemon
```

End-to-end against a real Dürbün desktop (skipped unless `DURBUN_E2E_PORT` is set; the desktop's HTTP port
defaults to the SDK port − 1, override with `DURBUN_E2E_HTTP_PORT`):

```bash
DURBUN_E2E_PORT=9751 ./gradlew --offline --no-daemon --max-workers=2 :durbun:testDebugUnitTest --tests '*E2E*'
```

The mock-matching test uses `durbun/src/test/resources/mock-parity.json`, generated from the protocol's
reference `mockRuleMatches`; regenerate it from the repository root with
`node --import tsx sdks/android/tools/gen-mock-parity.mjs`.

After a build, `python3 -I tools/check-binary-compat.py` checks `durbun` / `durbun-noop` API parity, binary
compatibility with OkHttp 3.14 + Okio 1.x, and that the consumer R8 rules cover every referenced OkHttp/Okio class.

Publishing (the version lives in one place: `Durbun.VERSION` in `durbun/src/main/kotlin/dev/durbun/Durbun.kt`):

```bash
./gradlew --offline --no-daemon publishToMavenLocal                  # into ~/.m2
./gradlew --no-daemon publishReleasePublicationToStagingRepository   # into build/staging-deploy
```

Zip `build/staging-deploy` and upload it to the Maven Central Portal. Artifacts are signed only when a key is
configured: `signingInMemoryKey` (+ `signingInMemoryKeyPassword`, optional `signingInMemoryKeyId`) as Gradle
properties or `ORG_GRADLE_PROJECT_*` environment variables, or the classic `signing.keyId` set.
