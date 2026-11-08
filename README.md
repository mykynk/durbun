# Dürbün

> 🇹🇷 Türkçe · 🇬🇧 [English below](#english)

Mobil geliştiriciler için Mac'te çalışan canlı log ve ağ izleyici. Android veya iOS cihazı USB ile takın
(ya da simülatör/emülatör açın). Şunların hepsi tek ve okunaklı bir ekranda akar:

- **Tüm loglar:** Android logcat, iOS cihaz syslog'u, iOS simülatör logu, uygulamanın kendi logları,
  hatalar, çökmeler ve event'ler. Çok satırlı çıktılar, stack trace'ler ve JSON katlanır. Aynı satırlar
  ×N olarak birleşir. Çökmeler göze batar.
- **Ağ:** her HTTP(S) isteği başlıkları, gövdeleri ve zamanlamalarıyla gelir. cURL/fetch/dio/Swift/OkHttp
  olarak kopyalanabilir, yeniden gönderilebilir, iki istek karşılaştırılabilir, HAR olarak dışa aktarılabilir.
- **Mock'lar:** eşleşen isteklere sahte yanıt verilebilir, gecikme eklenebilir veya hata simüle edilebilir.
  Kurallar uygulamanın içinde, SDK tarafından uygulanır.
- **Performans:** CPU, bellek, heap, FPS ve takılmalar, istek/sn ve log/sn grafikleri.
- **Cihaz:** ekran görüntüsü ve kaydı, deep link açma, uygulama başlat/durdur/kur/kaldır, koyu mod, yazı
  boyutu, konum, simülatöre push gönderme, durum çubuğu, uygulamanın kendi debug araçları.

Arayüz Türkçe açılır (tarayıcı dili Türkçe değilse İngilizce) ve çalışırken dil değiştirilebilir.

## İndirme

[GitHub Releases](https://github.com/mykynk/durbun/releases/latest) sayfasından Mac'inize uygun DMG'yi
indirin: Apple silicon için `Durbun-<sürüm>-arm64.dmg`, Intel için `Durbun-<sürüm>-x64.dmg`. DMG'yi açıp
Dürbün'ü Uygulamalar klasörüne sürükleyin. macOS 13 Ventura veya üstü gerekir.

Dürbün kendiliğinden güncelleme aramaz. **Dürbün → Güncellemeleri Denetle…** yeni bir sürüm varsa
indirme sayfasını tarayıcıda açar.

## Gereksinimler

| Ne için | Gereken |
|---|---|
| Mac uygulaması | macOS 13 veya üstü (Node.js gerekmez) |
| Komut satırı (`npm start`) | Node.js 20 veya üstü |
| Android cihaz / emülatör | `adb` (Android SDK platform-tools) |
| iOS simülatör | Xcode (`xcrun simctl`) |
| iOS fiziksel cihaz | Xcode ve `idevicesyslog` (`brew install libimobiledevice`; Flutter kuruluysa onun önbelleğindeki kopya da kullanılır) |

Eksik bir araç varsa arayüzdeki **Sistem kontrolü** ekranı ne yapılacağını söyler.

## Mac uygulaması

Terminal ve komut gerekmez: **Dürbün.app** sunucuyu kendi içinde başlatır ve arayüzü kendi penceresinde
açar.

- Port 9750 / 9751. Bir Dürbün zaten çalışıyorsa (ör. `npm start`) uygulama onu açar; o kapanınca
  kendi sunucusunu başlatır. Sürümler farklıysa menü çubuğundaki simge bunu söyler. Pencere yalnızca
  kendini kanıtlayan bir Dürbün'e verilir: `/api/health` adı ve sürümü, `/` adresinde de Dürbün arayüzü
  (ya da arayüzü derlenmemiş Dürbün'ün bilgi sayfası). Yalnızca `/api/health`'e Dürbün gibi yanıt veren
  bir program başka bir program sayılır. Port başka bir programdaysa sırayla 9760, 9770, 9780'i dener ve
  hangi portu kullandığını menü çubuğundaki simgede söyler.
- Pencere sunucuyu `http://127.0.0.1:<port>` adresinden açar, sağlık denetimi de aynı adrese yapılır
  (`localhost` önce ::1'i dener, orada başka bir program olabilir). Önceki sürümün `localhost` adresinde
  sakladığı arayüz tercihleri (tema, dil, gürültü ve vurgu kuralları, panel boyutları) ve sayfa
  yakınlaştırması (Görünüm → Yakınlaştır / Uzaklaştır) ilk açılışta bir kez yeni adrese taşınır.
- Menüler ve menü çubuğundaki uyarılar arayüzün diliyle (ilk açılışta sistem diliyle) Türkçe ya da
  İngilizcedir; sunucunun İngilizce metni tanılama günlüğüne yazılır.
- Sunucu ve arayüz `app.asar` içindedir; Electron'un bütünlük denetimi değiştirilmiş bir sunucu ya da
  arayüz dosyasını çalıştırmaz.
- `adb`, `flutter`, `idevicesyslog` gibi araçlar için PATH'i ve araçların ayarlarını (`ANDROID_HOME`,
  `JAVA_HOME`, fvm, `DEVELOPER_DIR`) giriş kabuğunuzdan kendisi okur. Kabuk 3 saniyede yanıt vermezse
  menü çubuğundaki simge bunu da söyler.
- Pencereyi kapatmak yakalamayı durdurmaz, Dürbün menü çubuğunda çalışmaya devam eder. Tamamen kapatmak
  için ⌘Q veya menü çubuğu simgesi → **Çık** (sunucu düzgünce durdurulur).
- Sunucu başlatılamazsa pencere nedenini gösterir; **Tekrar Dene**, **Tanılama Günlüğünü Göster** ve
  **Çık** seçenekleri her zaman elinizin altındadır. Arayüz yanıt vermezse Dürbün beklemeyi ya da
  pencereyi yeniden yüklemeyi önerir. Tanılama günlüğü: Yardım → **Tanılama Günlüğünü Göster**.
- Sorun bildirmek için Yardım → **Sorun Bildir**; lisanslar Yardım → **Lisanslar** altında.

### İlk açılış ve imza

Developer ID ile imzalanmış ve Apple'ın noter onayından geçmiş bir sürüm çift tıklamayla açılır. İmzasız
bir derlemede (kendiniz derlediyseniz ya da sürüm imzasız yayımlandıysa) macOS ilk seferde uyarır:
Finder'da Dürbün'e sağ tıklayın → **Aç** → **Aç**. macOS bu seçeneği göstermezse: Sistem Ayarları →
Gizlilik ve Güvenlik → en altta Dürbün için **Yine de Aç**. Bu yalnızca bir kez gerekir.

### Kendiniz derlemek

```bash
npm install
```

```bash
npm run app:dist
```

Çıktı `apps/desktop/release/` klasöründe: `Durbun-<sürüm>-arm64.dmg` ve `mac-arm64/Dürbün.app` (yalnız
bu Mac için, ad-hoc imzalı). Yayın paketi (Apple silicon + Intel, DMG + ZIP) için:

```bash
npm run app:release
```

`CSC_NAME` (ya da `CSC_LINK` + `CSC_KEY_PASSWORD`) bir "Developer ID Application" sertifikasını
gösteriyorsa paket hardened runtime ile imzalanır. `APPLE_API_KEY` + `APPLE_API_KEY_ID` +
`APPLE_API_ISSUER` (ya da `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`) da varsa notere
gönderilir. Bunlar yoksa paket ad-hoc imzalanır.

Geliştirirken `npm run app` uygulamayı depodaki `dist/` ile çalıştırır. İkinci bir kopya ya da test için:
`DURBUN_PORT`, `DURBUN_SDK_PORT`, `DURBUN_DATA_DIR` (varsayılan `~/.durbun`), `DURBUN_USER_DATA_DIR`
(pencere durumu, tek kopya kilidi ve günlük), `DURBUN_DEMO=1`, `DURBUN_DEBUG=1`.

## Komut satırından çalıştırma

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Arayüz http://localhost:9750 adresinde açılır. macOS'ta Chrome, Brave, Edge, Arc veya Chromium kuruluysa
adres çubuğu olmayan ayrı bir uygulama penceresinde açılır.

Cihaz bağlamadan denemek için demo verisiyle başlatın (iki sanal cihaz, üç uygulama, gerçekçi log ve
ağ trafiği):

```bash
npm run demo
```

Komut satırı seçenekleri:

```
node dist/durbun.mjs [--port 9750] [--sdk-port 9751] [--demo] [--no-open] [--lan]
                     [--data-dir ~/.durbun] [--ui-dir YOL] [--verbose]
```

- `--lan`: aynı ağdaki cihazların (USB olmadan) bağlanmasına izin verir. Varsayılan olarak her şey
  yalnızca bu Mac'ten erişilebilir.
- Ayarlar ve mock kuralları `~/.durbun` içinde saklanır.

## Uygulamaya SDK ekleme

Cihaz logları SDK olmadan da gelir. Uygulamanın kendi logları, ağ istekleri, performans ölçümleri ve
mock'lar için SDK'yı ekleyin. Adımlar arayüzdeki **SDK kurulumu** ekranında, kopyalanabilir haliyle de var.

| Platform | Paket | Kılavuz |
|---|---|---|
| Flutter | pub.dev: `durbun` (+ dio için `durbun_dio`) | [sdks/flutter/durbun/README.md](sdks/flutter/durbun/README.md) |
| Android (Kotlin / OkHttp) | Maven Central: `io.github.mykynk:durbun` (release'te `durbun-noop`) | [sdks/android/README.md](sdks/android/README.md) |
| iOS (Swift / URLSession) | Swift Package Manager: `https://github.com/mykynk/durbun`, CocoaPods: `Durbun` | [sdks/ios/README.md](sdks/ios/README.md) |
| React Native / JS | npm: `@durbun/react-native` | [sdks/js/README.md](sdks/js/README.md) |

SDK'lar release derlemelerinde kendiliğinden kapalıdır; nasıl açılacağı her kılavuzda yazıyor. Paketleri
bu depodan (yerel klasörden) kurmak da mümkün: SDK kurulumu ekranında **Yerel klasör** seçin.

SDK'sı olmayan Flutter **debug** uygulamaları da görünür: VM Service adresi cihaz logunda göründüğünde
Dürbün uygulamaya kendiliğinden bağlanır ve logları ile `dart:io` isteklerini alır.

Bağlantı yolu kendiliğinden kurulur: Android'de `adb reverse`, iOS cihazda usbmux, simülatörde doğrudan
`127.0.0.1:9751`.

## Gizlilik

- Dürbün kendiliğinden hiçbir şeyi Mac'in dışına göndermez: analitik, telemetri ya da otomatik
  güncelleme denetimi yoktur. Çökme dökümleri yalnızca Mac'te kalır.
- Mac'ten dışarı istek yalnızca siz istediğinizde çıkar: **Güncellemeleri Denetle** (GitHub API'ye tek
  istek) ve bir isteği **yeniden gönder**mek (isteğin kendi adresine).
- Sunucu yalnızca bu Mac'ten erişilebilir (`127.0.0.1`). **LAN** ayarını (ya da `--lan`) açarsanız aynı
  ağdaki cihazlar SDK portuna bağlanabilir.
- SDK'lar yakaladıklarını yalnızca bu Mac'teki Dürbün'e gönderir (USB, simülatör ya da LAN açıksa yerel
  ağ üzerinden).

## Kaldırma

1. Dürbün'ü kapatın (⌘Q) ve Uygulamalar klasöründen Çöp Sepeti'ne taşıyın.
2. İsterseniz verilerini de silin:
   - `~/.durbun`: ayarlar (`settings.json`), mock kuralları (`mocks.json`), geçici dosyalar.
   - `~/Library/Application Support/Dürbün`: pencere durumu, arayüz tercihleri, tanılama günlüğü,
     çökme dökümleri.
3. Uygulamalarınıza eklediğiniz SDK paketlerini kaldırın.

## Geliştirme

```bash
npm run dev
```

Sunucuyu kaynaktan (her değişiklikte yeniden başlar), arayüzü Vite ile (anında yenilenir) birlikte
çalıştırır ve http://localhost:5173 adresini açar. `npm run dev -- --demo` demo verisiyle başlatır.

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run app:test
```

| Klasör | İçerik |
|---|---|
| `packages/protocol` | Sunucu, arayüz ve SDK'ların paylaştığı veri tipleri ve komutlar |
| `packages/server` | Cihaz sürücüleri (adb, simctl, idevicesyslog), SDK bağlantıları, Dart VM Service köprüsü, HTTP/WS API, demo, CLI |
| `packages/ui` | React arayüzü (Loglar, Ağ, Mock'lar, Performans, Cihaz). Yapı: [packages/ui/src/README-ui.md](packages/ui/src/README-ui.md) |
| `apps/desktop` | Mac uygulaması (Electron) |
| `sdks/*` | Flutter, Android, iOS ve React Native SDK'ları |
| `SPEC.md` | Ürün ve mühendislik şartnamesi |

## Lisans

[MIT](LICENSE) © 2026 Muhammed Yusuf Kaynak

---

## English

Dürbün is a Mac app that shows live logs, network traffic and performance for mobile apps. Plug in an
Android or iOS device (or run a simulator/emulator) and see device and app logs, every HTTP request with
headers, bodies and timings, mocks, performance charts and device tools in one readable live UI. The UI
speaks Turkish and English.

### Download

Get the DMG for your Mac from [GitHub Releases](https://github.com/mykynk/durbun/releases/latest):
`Durbun-<version>-arm64.dmg` for Apple silicon, `Durbun-<version>-x64.dmg` for Intel. macOS 13 Ventura
or later. Dürbün never checks for updates on its own; **Dürbün → Check for Updates…** opens the download
page when a newer release exists. An unsigned build asks once on first launch: right-click Dürbün in
Finder → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**).

Requirements: `adb` for Android; Xcode for simulators; Xcode + `idevicesyslog`
(`brew install libimobiledevice`) for physical iOS devices. The in-app **System check** screen explains
anything missing.

### Command line

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Needs Node.js 20 or later. The UI opens at http://localhost:9750. `npm run demo` starts with demo data,
`npm run dev` runs the server from source and the UI with hot reload on http://localhost:5173.
`npm run app:dist` builds the Mac app for this Mac; `npm run app:release` builds the Apple silicon and
Intel release, signed and notarized when the signing environment is set (see above).

### SDKs

Device logs need no SDK. App logs, network, metrics and mocks need the SDK for your platform: `durbun`
(+ `durbun_dio`) on pub.dev, `io.github.mykynk:durbun` on Maven Central, the Swift package
`https://github.com/mykynk/durbun` or the `Durbun` pod, `@durbun/react-native` on npm. The SDKs are off in
release builds unless you turn them on. Flutter debug apps without the SDK are attached automatically
through the Dart VM Service.

### Privacy

Dürbün sends nothing off your Mac on its own: no analytics, no telemetry, no automatic update check;
crash dumps stay local. Requests leave the Mac only when you ask: **Check for Updates** (one call to the
GitHub API) and **resending** a captured request (to that request's own host). The server listens on
`127.0.0.1` only, unless you turn on **LAN**. The SDKs send what they capture only to Dürbün on your Mac.

### Uninstall

Quit Dürbün (⌘Q) and move it to the Trash. To remove its data too, delete `~/.durbun` (settings, mock
rules, temporary files) and `~/Library/Application Support/Dürbün` (window state, UI preferences,
diagnostic log, crash dumps).

### License

[MIT](LICENSE) © 2026 Muhammed Yusuf Kaynak
