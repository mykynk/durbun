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

## Gereksinimler

| Ne için | Gereken |
|---|---|
| Dürbün'ün kendisi | Node.js 20 veya üstü |
| Android cihaz / emülatör | `adb` (Android SDK platform-tools) |
| iOS simülatör | Xcode (`xcrun simctl`) |
| iOS fiziksel cihaz | Xcode ve `idevicesyslog` (`brew install libimobiledevice`; Flutter kuruluysa onun önbelleğindeki kopya da kullanılır) |

Eksik bir araç varsa arayüzdeki **Sistem kontrolü** ekranı ne yapılacağını söyler.

## Kurulum ve çalıştırma

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

## Mac uygulaması

Terminal ve komut gerekmez: **Dürbün.app** sunucuyu kendi içinde başlatır ve arayüzü kendi penceresinde
açar. Çift tıklamak yeterli.

Bir kez derleyin (ilk seferde Electron'u indirir):

```bash
npm run app:dist
```

Çıktı `apps/desktop/release/` klasöründe: `Durbun-0.1.0-arm64.dmg` (Apple silicon) ve
`mac-arm64/Dürbün.app`. DMG'yi açıp Dürbün'ü Uygulamalar klasörüne sürükleyin. Ekip arkadaşlarınıza
DMG'yi göndermeniz yeterli.

**İlk açılış:** uygulama imzasız (Apple Developer sertifikası yok), bu yüzden macOS ilk seferde uyarır.
Finder'da Dürbün'e sağ tıklayın → **Aç** → **Aç**. macOS bu seçeneği göstermezse: Sistem Ayarları →
Gizlilik ve Güvenlik → en altta Dürbün için **Yine de Aç**. Bu yalnızca bir kez gerekir.

- Port 9750 / 9751. Bir Dürbün zaten çalışıyorsa (ör. `npm start`) uygulama onu açar. Port başka bir
  programdaysa yakındaki boş bir portu kullanır ve bunu menü çubuğundaki simgede söyler.
- `adb`, `flutter`, `idevicesyslog` gibi araçlar için PATH'i giriş kabuğunuzdan kendisi okur.
- Ayarlar ve mock kuralları komut satırıyla aynı yerde durur: `~/.durbun`.
- Pencereyi kapatmak yakalamayı durdurmaz, Dürbün menü çubuğunda çalışmaya devam eder. Tamamen kapatmak
  için ⌘Q veya menü çubuğu simgesi → **Çık** (sunucu düzgünce durdurulur).
- Bir şey ters giderse: Yardım → **Tanılama Günlüğünü Göster**.
- Geliştirirken `npm run app` uygulamayı depodaki `dist/` ile çalıştırır.

## Uygulamaya SDK ekleme

Cihaz logları SDK olmadan da gelir. Uygulamanın kendi logları, ağ istekleri, performans ölçümleri ve
mock'lar için SDK'yı ekleyin. Kurulum adımları arayüzdeki **SDK kurulumu** ekranında da var.

| Platform | Paket | Kılavuz |
|---|---|---|
| Flutter | `durbun` (+ isteğe bağlı `durbun_dio`) | [sdks/flutter/durbun/README.md](sdks/flutter/durbun/README.md) |
| Android (Kotlin / OkHttp) | Gradle modülü `:durbun` (release için `:durbun-noop`) | [sdks/android/README.md](sdks/android/README.md) |
| iOS (Swift / URLSession) | Swift paketi `Durbun` | [sdks/ios/README.md](sdks/ios/README.md) |
| React Native / JS | `@durbun/react-native` | [sdks/js/README.md](sdks/js/README.md) |

SDK'sı olmayan Flutter **debug** uygulamaları da görünür: VM Service adresi cihaz logunda göründüğünde
Dürbün uygulamaya kendiliğinden bağlanır ve logları ile `dart:io` isteklerini alır.

Bağlantı yolu kendiliğinden kurulur: Android'de `adb reverse`, iOS cihazda usbmux, simülatörde doğrudan
`127.0.0.1:9751`.

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

| Klasör | İçerik |
|---|---|
| `packages/protocol` | Sunucu, arayüz ve SDK'ların paylaştığı veri tipleri ve komutlar |
| `packages/server` | Cihaz sürücüleri (adb, simctl, idevicesyslog), SDK bağlantıları, Dart VM Service köprüsü, HTTP/WS API, demo, CLI |
| `packages/ui` | React arayüzü (Loglar, Ağ, Mock'lar, Performans, Cihaz). Yapı: [packages/ui/src/README-ui.md](packages/ui/src/README-ui.md) |
| `sdks/*` | Flutter, Android, iOS ve React Native SDK'ları |
| `SPEC.md` | Ürün ve mühendislik şartnamesi |

---

## English

Dürbün is a desktop live log + network inspector for mobile developers. Plug in an Android or iOS device
(or run a simulator/emulator) and see all device and app logs, every HTTP request, performance metrics and
device tools in one readable live UI.

Requirements: Node.js ≥ 20; `adb` for Android; Xcode for simulators; Xcode + `idevicesyslog`
(`brew install libimobiledevice`) for physical iOS devices. The in-app **System check** screen explains
anything missing.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

The UI opens at http://localhost:9750. `npm run demo` starts with demo data, `npm run dev` runs the
server from source and the UI with hot reload on http://localhost:5173. App logs, network, metrics and
mocks need the SDK for your platform (see the table above); Flutter debug apps without the SDK are
attached automatically through the Dart VM Service.
