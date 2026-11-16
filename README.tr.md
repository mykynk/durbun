<p align="center">
  <img src="apps/desktop/build/icon.png" width="96" height="96" alt="">
</p>

<h1 align="center">Dürbün</h1>

<p align="center">
  Android ve iOS uygulamaları için Mac'te canlı log, ağ trafiği ve performans.
</p>

<p align="center">
  <a href="https://appnify.dev/durbun/?lang=tr">Web sitesi</a> · <a href="https://appnify.dev/durbun/?lang=tr#demo">Canlı demo</a>
</p>

<p align="center">
  <a href="https://pub.dev/packages/durbun"><img src="https://img.shields.io/pub/v/durbun?label=pub.dev" alt="pub.dev"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT lisansı"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · Türkçe · <a href="docs/README.md">Belgeler</a>
</p>

![Örnek verilerle Dürbün: üç cihazdan ve uygulamalarından canlı loglar, stack trace'iyle açılmış bir Android çökmesi](docs/images/logs.tr.webp)

Android veya iOS cihazı takın ya da simülatör/emülatör açın: Dürbün uygulamanın yaptığı her şeyi tek, okunaklı
ve canlı bir pencerede gösterir.

- **Loglar.** Android logcat, iOS cihaz ve simülatör logları, uygulamanın kendi logları, hatalar, çökmeler ve
  event'ler. Çok satırlı çıktılar, stack trace'ler ve JSON katlanır; aynı satırlar ×N olarak birleşir;
  çökmeler göze batar.
- **Ağ.** Her SDK'nın bağlandığı istemcilerden gelen HTTP(S) istekleri, başlıkları, gövdeleri ve
  zamanlamalarıyla (bkz. [Ne yakalanır](#ne-yakalanır)). cURL, fetch, Dio, Swift veya OkHttp olarak kopyalama,
  yeniden ya da düzenleyip gönderme, iki isteği karşılaştırma, HAR olarak dışa aktarma. Bir WebSocket
  bağlantısı ya da Server-Sent Events akışı tek satırdır; mesajları uygulamanın gördüğü sırayla altında durur.

  ![Dürbün'ün ağ ekranı: durumu, süresi ve cihazıyla yakalanan istekler ve seçili isteğin JSON yanıtı](docs/images/network.tr.webp)
- **Mock'lar.** Eşleşen isteklere hazır yanıt verme, gecikme ekleme veya hata simüle etme. Bir kural tek bir
  GraphQL işlemini hedefleyebilir. Kuralları SDK uygulamanın içinde uygular; proxy ya da sertifika gerekmez
  (bkz. [Mock kuralları](docs/guides/mocks.md)).
- **Performans.** CPU, bellek, heap, FPS ve takılmalar, saniyede istek ve saniyede log.

  ![Dürbün'ün bir uygulama için performans ekranı: son bir dakikadaki CPU, bellek, heap, FPS, takılmalar, istekler, loglar ve hatalar](docs/images/performance.tr.webp)
- **Akışlar.** Graf olarak çizdiğiniz testler: Mac'ten gönderilen istekler, kontroller, uygulamanın
  yaptıklarını bekleme, mock senaryoları ve cihaz işlemleri; birbirine zincirlenir, birbirini alt akış olarak
  çağırır (bkz. [Akışlar](#akışlar)). Elle, kayıtlı isteklerden ya da kendi yapay zekâ asistanınızla yazın.
- **Paylaşma.** Bir log satırı ya da istek, ekibinizin Dürbün olmadan okuyabileceği bir rapora dönüşür:
  kopyalayın, Markdown olarak kaydedin ya da tek tıkla ekibinizin Slack kanalına gönderin (Ayarlar → Slack).
  Kanalın webhook adresini almak da tek tık: [Slack'e ekle](https://appnify.dev/durbun/slack/?lang=tr).
  Flutter uygulama içi paneli de telefondan gönderebilir.
- **Oturum kayıtları.** Her oturum yakalanırken Mac'inize kaydedilir: Dürbün kapansa ya da çökse bile önceki
  oturumu canlı veriden ayrı olarak yeniden açarsınız. Hiçbir şey Mac'ten çıkmaz.
- **Yedekleme ve paylaşım.** Akışlarınız, mock kurallarınız, ortamlarınız ve ayarlarınız tek bir `.durbun`
  dosyasında: kurulumunuzu takımla paylaşın ya da yeni bir Mac için her şeyi yedekleyin; elle ya da iCloud
  Drive'a veya istediğiniz klasöre otomatik (bkz. [Paylaşım ve yedekleme](#paylaşım-ve-yedekleme)).
- **Cihaz araçları.** Ekran görüntüsü ve ekran kaydı, deep link, uygulama başlatma, durdurma, kurma ve
  kaldırma, koyu mod, yazı boyutu, konum, simülatöre push bildirimi, durum çubuğu ve uygulamanın kendi
  eklediği butonlar.

  ![Dürbün'ün bir Android telefon için cihaz ekranı: cihaz bilgileri, Dürbün'ün değiştirdiği ve tek tek geri alınabilen ayarlar, ekran görüntüsü, deep link ve uygulamanın kendi hata ayıklama araçları](docs/images/device.tr.webp)

Cihaz logları SDK olmadan da gelir. SDK'sı olmayan Flutter debug uygulamalarına Dürbün Dart VM Service
üzerinden kendiliğinden bağlanır. Uygulama logları, ağ yakalama, ölçümler ve mock'lar için SDK eklenir.

Arayüz İngilizce ve Türkçedir, sistem dilini izler.

## Kurulum

### Mac uygulaması

Mac'inize uygun DMG'yi [GitHub Releases](https://github.com/mykynk/durbun/releases/latest) sayfasından
indirin: Apple silicon için `Durbun-<sürüm>-arm64.dmg`, Intel için `Durbun-<sürüm>-x64.dmg`. Açıp Dürbün'ü
Uygulamalar klasörüne sürükleyin. macOS 13 Ventura veya üstü gerekir.

Yayın paketleri Developer ID ile imzalı ve Apple onaylıdır (notarized); her uygulama gibi açılır.

**Dürbün → Güncellemeleri Denetle…** yeni bir sürüm olup olmadığına bakar. Varsa Dürbün yenilikleri gösterir
ve indirmeden önce sorar; indirme bitince yeniden başlamadan önce yine sorar. Kendi yerine yenisini kuramayan
bir kopya (yerel bir derleme ya da disk görüntüsünden açılan kopya) bunun yerine Mac'inize uygun disk
görüntüsünü alır. İkinci açılıştan itibaren Dürbün, günde bir kez kendiliğinden denetleyip denetlemeyeceğini
bir kez sorar; bu seçimi istediğiniz zaman **Dürbün → Güncellemeleri Otomatik Denetle** ile
değiştirebilirsiniz.

### Gereksinimler

| Ne için | Gereken |
|---|---|
| Mac uygulaması | macOS 13 veya üstü (Node.js içinde gelir) |
| Komut satırı (`npm start`) | Node.js 20 veya üstü |
| Android cihaz ve emülatör | `adb` (Android SDK Platform-Tools) |
| iOS simülatör | Xcode (`xcrun simctl`) |
| iOS fiziksel cihaz | Xcode ve `idevicesyslog` (`brew install libimobiledevice`; Flutter önbelleğindeki kopya da olur) |

Uygulamadaki **Sistem kontrolü** ekranı eksik olanı ve nasıl tamamlanacağını söyler. Diğer sorunlar için
[Sorun giderme](docs/guides/troubleshooting.md) kılavuzuna bakın.

### Cihazsız denemek

```bash
git clone https://github.com/mykynk/durbun.git && cd durbun
npm install
npm run demo
```

Demo; sanal cihazlar, uygulamalar, loglar ve ağ trafiğiyle açılır.

## Uygulamaya SDK ekleme

Uygulamadaki **SDK kurulumu** ekranı aynı adımları kopyalanabilir haliyle gösterir.

| Platform | Kurulum | Kılavuz |
|---|---|---|
| Flutter | pub.dev'de [`durbun`](https://pub.dev/packages/durbun); Dio'nun native adaptörleri için [`durbun_dio`](https://pub.dev/packages/durbun_dio) | [sdks/flutter/durbun](sdks/flutter/durbun/README.md) |
| iOS (Swift, URLSession) | Swift Package Manager: `0.2.0` sürümünden itibaren `https://github.com/mykynk/durbun`; CocoaPods: `pod 'Durbun'` | [sdks/ios](sdks/ios/README.md) |
| Android (Kotlin, OkHttp) | Maven Central'da [`io.github.mykynk:durbun`](https://central.sonatype.com/artifact/io.github.mykynk/durbun); release derlemeleri için `durbun-noop` | [sdks/android](sdks/android/README.md) |
| React Native / JavaScript | npm'de [`@durbun/react-native`](https://www.npmjs.com/package/@durbun/react-native) | [sdks/js](sdks/js/README.md) |

SDK'lar release derlemelerinde siz açmadıkça kapalıdır; nasıl açılacağı her kılavuzda yazar.
[Test derlemelerinde Dürbün](docs/guides/qa-builds.md) Firebase App Distribution, TestFlight ve ad hoc
derlemeleri anlatır. Bağlantıyı kendileri kurar: Android'de `adb reverse`, simülatörde `127.0.0.1:9751`,
iPhone'da Flutter ve iOS SDK'ları için usbmux. iPhone'daki bir React Native uygulaması yalnızca Wi-Fi
üzerinden bağlanır: **Ayarlar → Bağlantı → Yerel ağ (Wi-Fi) bağlantılarına izin ver** seçeneğini açın ve
Mac'in IP adresini verin (`Durbun.start({ host: '192.168.1.20' })`). Yerel ağ bağlantılarına izin
verdiğinizde Wi-Fi her SDK ile çalışır.

## Kılavuzlar

Kılavuzlar şimdilik yalnızca İngilizce. Okura göre sıralanmış tüm kılavuzlar
[belge dizininde](docs/README.md) listelenir.

| Kılavuz | Kimin için, ne anlatır |
|---|---|
| [Test uzmanları için Dürbün](docs/guides/testers.md) | Test uzmanları: kurulum, Android'de USB hata ayıklama, iPhone'da "Bu bilgisayara güvenilsin mi?", uygulamanızı bulma, bulduğunuzu paylaşma |
| [Sorun giderme](docs/guides/troubleshooting.md) | Belirtiye göre: telefon görünmüyor, iPhone logu yok, istekler eksik, uygulama bağlanmıyor, portlar |
| [Mock kuralları](docs/guides/mocks.md) | Kural yazma, eşleşme ve sıra, uygulamanın içinde ne olduğu, hazır tarifler, sınırlar |
| [Test derlemelerinde Dürbün](docs/guides/qa-builds.md) | SDK'yı staging, Firebase, TestFlight ve ad hoc derlemelerde açma |
| [Sürümler ve yükseltme](docs/guides/versions.md) | Hangi SDK hangi Mac uygulamasıyla çalışır, nasıl yükseltilir |
| [Akış dosyaları](docs/flows/README.md) | Akış dosyası biçimi |

## Ne yakalanır

| Uygulamanız | Loglar | Ağ | Performans | Mock'lar |
|---|---|---|---|---|
| Herhangi bir uygulama, SDK yok | Cihaz logları (logcat, iOS cihaz ve simülatör logları) ve sistemin çökme kayıtları | Hayır | Android süreç ve kare istatistikleri | Hayır |
| Flutter debug veya profile derlemesi, SDK yok (Dart VM Service üzerinden) | Ek olarak `dart:developer` `log()` ve Flutter hataları | dart:io HTTP: `package:http`, Dio'nun varsayılan adaptörü | FPS, takılmalar, Dart heap | Hayır |
| `durbun` eklenmiş Flutter | Ek olarak `Durbun.log`, `debugPrint`, çökmeler ve native loglar | dart:io HTTP; iOS'ta URLSession, Android'de `DurbunInterceptor` eklenmiş OkHttp | FPS, takılmalar, bellek, CPU | Evet |
| `Durbun` eklenmiş iOS | Ek olarak `Durbun.log`, `print` ve stderr, çökmeler | `URLSession.shared` ve kendi oturumlarınız, Alamofire dahil | CPU, bellek, thread'ler, FPS, takılmalar | Evet |
| `durbun` eklenmiş Android | Ek olarak `Durbun.log` (Timber da) ve çökmeler | `DurbunInterceptor` eklenmiş `OkHttpClient`'lar: Retrofit, Coil, Ktor'un OkHttp motoru | CPU, bellek, Java heap, thread'ler, FPS, takılmalar | Evet |
| `@durbun/react-native` eklenmiş React Native | Ek olarak `console.*` ve JS hataları | `XMLHttpRequest`: `fetch`, axios | JS heap, JS thread FPS'i | Evet |

WebSocket mesajları ve Server-Sent Events için SDK gerekir: Flutter (dart:io WebSocket'leri ve olay
akışları), iOS (`URLSessionWebSocketTask` ve URLSession üzerinden olay akışları), Android (olay akışları
`DurbunInterceptor` ile; WebSocket'ler `DurbunWebSocketFactory` ile açılınca) ve React Native (global
`WebSocket`, `XMLHttpRequest` tabanlı kütüphanelerin olay akışları). SDK yoksa bağlantının yalnızca el
sıkışması görünür. Flutter uygulama içi paneli mesajları Mac olmadan telefonda da gösterir.

Yakalanmayanlar:

- **Flutter:** gRPC ve doğrudan socket kullanan kod, dart:io üzerinde çalışmayan WebSocket'ler (bunları
  `DurbunNetwork.webSocket` ile bildirebilirsiniz), arka plan isolate'lerindeki `print` çıktısı ve bu
  isolate'lerin `Durbun.attachIsolate()` çağrılana kadarki istekleri, Android'de package:http'nin
  `CronetClient`'ı ve `package:ok_http`. Dio'nun `NativeAdapter`'ı için
  [`durbun_dio`](https://pub.dev/packages/durbun_dio) gerekir.
- **iOS:** arka plan URLSession'ları, AVPlayer trafiği, URLSession kullanmayan WebSocket kütüphaneleri
  (Starscream'in kendi motoru, SocketRocket). Bir `WKWebView` sayfasının fetch/XHR çağrıları ve console
  satırları `DurbunWebView.attach(...)` sonrasında görünür; sayfa yüklemeleri ve görseller görünmez.
- **Android:** `HttpURLConnection` (Volley, Media3'ün varsayılan veri kaynağı, Ktor'un CIO motoru), Cronet ve
  native kod. Bir `WebView` sayfasının fetch/XHR çağrıları ve console satırları
  `DurbunWebView.attach(webView)` sonrasında görünür; sayfa yüklemeleri ve görseller görünmez. gRPC akışlarının
  yalnızca boyutu görünür; `client.newWebSocket` ile açılan bir
  WebSocket'in yalnızca el sıkışması görünür.
- **React Native:** `<Image>` indirmeleri, native modüllerin yaptığı istekler ve global `WebSocket` yerine bir
  paketten gelen WebSocket sınıfları.

Ayrıntılar ve diğer istemcileri kendiniz nasıl bildireceğiniz her SDK'nın kılavuzunda.

## Akışlar

**Akışlar** sekmesi elle test ettiklerinizi tekrar çalıştırılabilen bir grafa dönüştürür. Her adım bir
düğümdür; oklar sırada neyin çalışacağını belirler, bir hata oku çizdiyseniz başarısız adım oradan devam eder.

![Dürbün'ün akış editörü: hata dalı olan, graf olarak çizilmiş bir ödeme akışı ve sepet isteğinde 401 alıp başarısız olan son çalıştırması](docs/images/flows.tr.webp)

| Grup | Düğümler |
| --- | --- |
| Başlangıç | Elle çalıştırma (girdilerle) ya da bir şey olunca kendiliğinden başlama: çökme, eşleşen ya da başarısız istek, log satırı, uygulamanın ya da cihazın bağlanması |
| İstekler | Mac'ten HTTP isteği; başlıklar, gövde, zaman aşımları ve yanıttan alınan değerlerle |
| Mantık | Koşul, tekrar (sayı ya da liste), değişken atama, bekleme, başka akışı çağırma, bitiş |
| Kontroller | Herhangi bir değer üzerinde kurallar, loglarda hata olmaması |
| Uygulamayı bekleme | Uygulamadan bir istek, log satırı ya da event; süre sınırıyla |
| Mock'lar | Senaryo için mock kuralı ekleme, açıp kapama ya da kaldırma; akışın kendi kuralları çalışma bitince kalkar |
| Cihaz | Link açma, uygulamayı başlatma, durdurma ya da yeniden başlatma, verisini silme, kurma ya da kaldırma, ekran görüntüsü, ekran kaydı, koyu mod, yazı boyutu, konum, push bildirimi, metin ve tuşlar, durum çubuğu, animasyonlar |
| Rapor | Loglara işaret, çalışma raporuna not, Slack mesajı |

- Değerler şablonlarla akar: `{{login.body.token}}` `login` adımının yanıtını, `{{env.baseUrl}}` seçili
  ortamı, `{{input.email}}` bir çalışma girdisini okur. Editör yazarken tamamlar.
- **Ortamlar** (Staging, Production…) adresleri ve anahtarları tutar. Gizli değerler bu Mac'te kalır ve
  raporlarda maskelenir.
- Çalıştırmadan önce Dürbün akışın neye ihtiyacı olduğunu (cihaz, uygulama, SDK bağlantısı, araç) denetler ve
  eksik olanı söyler; cihazı kalıcı olarak değiştiren adımlar (veri silme, kaldırma) önce sorar.
- Çalıştırma paneli her adımı canlı olarak süresi, isteği ve yanıtı, ekran görüntüleri ve kayıtlarıyla
  gösterir. Son 200 çalıştırma saklanır.
- **Kayıtlı isteklerden:** Ağ'da istekleri seçin (ya da tek bir istekte **Bu istekten akış oluştur…**);
  Dürbün akışı kurar, adresi bir ortam değişkenine taşır ve bir yanıttaki değerleri sonraki isteğe bağlar.
- **Kendi yapay zekânızla:** Dürbün hiçbir yapay zekâya istek atmaz. **Yapay zekâyla yaz**, kullandığınız
  asistana yapıştırmanız için bir paket kopyalar (akış biçimi, tüm düğüm türleri, akışlarınız, ortam anahtarları
  ve uygulamanın son istekleri; başlıklar, gövdeler ve sorgu değerleri olmadan). Cevabını geri yapıştırın; Dürbün denetler, neyin yeni ya da değişmiş olduğunu gösterir
  ve içe aktarır. Biçim herkese açık: [Akış dosyaları](docs/flows/README.md) (İngilizce) ve
  [`durbun-flow.schema.json`](docs/flows/durbun-flow.schema.json).
- Akışlar `~/.durbun/flows` içinde, her akış için bir düz JSON dosyasıdır; bir repoya da koyabilirsiniz.

SDK gerektiren adımlar (uygulama event'lerini bekleme, mock kuralları) bunu çalıştırmadan önce söyler; cihaz
adımları SDK'sız çalışır.

## Paylaşım ve yedekleme

Dürbün'ün bulutu yok; yaptıklarınız bu Mac'te `~/.durbun` içinde durur. Bir `.durbun` paketi onları başka
yere taşır:

- **Kurulumu paylaş…** (İçe / dışa aktar menüsü ya da bir akışta **Takımla paylaş…**): seçtiğiniz akışlar ve
  çağırdıkları alt akışlar, mock kuralları, ortamlar, ayarlar, görünüm ve log kuralları, isterseniz
  çalıştırma geçmişi. Gizli ortam değerleri ve Slack bağlantısı asla girmez.
- **Her şeyi yedekle…**: yeni bir Mac için tek dosya. Gizli değerler ve Slack bağlantısı yalnızca parola
  verirseniz şifreli girer (AES-256-GCM, anahtar scrypt ile); parola yoksa dışarıda kalır.
- **Ayarlar → Yedekleme**, seçtiğiniz klasöre değişikliklerden sonra (en fazla saatte bir) ve belirlediğiniz
  aralıkta yedek yazar, en yenilerini tutar. iCloud Drive gibi eşitlenen bir klasör yedekleri diğer Mac'inize
  taşır; orada **Geri yükle…** birini açar. Otomatik yedeklerin parolası yalnızca bu Mac'te saklanır.
- Bir paketi açmak (**Dosya içe aktar…** ya da pencereye bırakmak) neyin yeni olduğunu, neyin zaten var
  olduğunu ve neyin farklı olduğunu gösterir; yerine koymayı, ikisini de tutmayı ya da atlamayı seçersiniz.
  Siz seçmeden hiçbir şeyin üzerine yazılmaz.

## Gizlilik

- Dürbün kendiliğinden Mac'in dışına hiçbir şey göndermez: analitik ve telemetri yoktur. Otomatik güncelleme
  denetimine izin verirseniz Dürbün günde bir kez GitHub Releases'ten tek bir sabit dosya okur; bu istek
  hiçbir kimlik bilgisi taşımaz. Çökme dökümleri Mac'te kalır.
- Mac'ten dışarı istek yalnızca siz istediğinizde çıkar: **Güncellemeleri Denetle** (GitHub Releases'ten tek
  bir sabit dosya; güncelleme yalnızca onayınızdan sonra iner), yakalanmış bir isteği yeniden göndermek (isteğin kendi adresine), **Slack'e gönder** (ayarladığınız
  webhook'a) ve akışlar (HTTP ve Slack adımları akışta yazan yere gider; bir olayda kendiliğinden başlayan akış
  yalnızca Dürbün açıkken çalışır). Yedekler seçtiğiniz klasöre yazılır; o klasörü eşitlemek klasörün
  servisine kalmıştır.
- Sunucu yalnızca `127.0.0.1`'i dinler. Aynı ağdaki cihazların SDK portuna bağlanması için Ayarlar'da
  **LAN**'ı açın (ya da `--lan` verin).
- SDK'lar başka hiçbir servise bağlanmaz: yakaladıkları yalnızca Dürbün bağlantısından gider (bkz.
  [Güvenlik](#güvenlik)). Tek istisna Flutter uygulama içi panelinin **Slack'e gönder**'idir: raporu,
  uygulamayı derlerken verdiğiniz webhook'a, yalnızca biri dokunduğunda gönderir.

## Güvenlik

Arayüz ve API'si yalnızca bu Mac'ten gelen bağlantılara ve yalnızca Dürbün'ün kendi sayfalarına yanıt verir;
tarayıcınızda açık siteler bunları okuyamaz. `adb reverse` yalnızca SDK bağlantısına hizmet eden ayrı bir
porta yönlenir; takılı telefondaki uygulamalar da bunları okuyamaz. LAN açıkken diğer cihazlar yalnızca SDK
bağlantısına ulaşır.

SDK bağlantısında henüz eşleşme ve şifreleme yok:

- SDK'sı açık bir uygulama, portunda kim yanıt verirse onunla konuşur: loglarını ve ağ trafiğini ona
  gönderir, bağlı kaldığı sürece onun mock kurallarını uygular. Android'de SDK cihazdaki `127.0.0.1:9751`'e
  bağlanır; `adb reverse` bunu Mac'e iletir. iOS cihazda `127.0.0.1:9752–9755`'te dinler (yalnızca loopback)
  ve Mac usbmux üzerinden bağlanır. İki durumda da aynı cihazdaki başka bir uygulama Mac'in yerini alabilir.
- Wi-Fi'de trafik yerel ağdan şifresiz geçer.
- SDK'lar release derlemelerinde siz açmadıkça kapalıdır. Açtığınız derlemeler, örneğin iç test derlemeleri,
  burada anlatıldığı gibi davranır.
- Yakalanan veride token'lar ve kişisel veriler olabilir. Oturum dışa aktarımları ve HAR dosyaları, maskesiz
  dışa aktarmayı siz seçmedikçe gizli değerleri (kimlik başlıkları, çerezler, token ve parola alanları)
  maskeler; log satırlarının içindeki metin maskelenmez. Bir değerin Mac'e hiç gelmemesi için onu her SDK'nın
  `redactHeaders` seçeneğiyle gizleyin.
- Slack incoming webhook adresine sahip olan herkes o kanala mesaj atabilir. Mac uygulaması adresi veri
  klasöründeki `slack.json` dosyasında (yalnızca sizin kullanıcınız okuyabilir) tutar ve bir daha göstermez.
  Flutter panelinin webhook'u derleme komutunuzdan gelir (`--dart-define=DURBUN_SLACK_WEBHOOK`) ve o derlemenin
  içine gömülür; derlemeye sahip olan onu bulabilir.
- Ortamların gizli değerleri ve yedek parolası veri klasöründe, yalnızca sizin kullanıcınızın okuyabileceği
  dosyalarda tutulur. Paylaşılan paketlerde asla bulunmaz; yedeklerde yalnızca parolanızla şifrelenmiş olarak
  bulunur. Bir akış içinde yazan istekleri ve cihaz işlemlerini çalıştırır; başkalarından gelen akışları
  güvendiğiniz kişilerden açın, yapay zekânın yazdığını çalıştırmadan önce okuyun. Mac'ten gönderilen istekler
  (akışlar ve yeniden gönderimler) Dürbün'ün kendi portlarına ulaşamaz.

SDK'larla Mac uygulaması arasında eşleşme planlanıyor.

## Mac uygulaması ayrıntıları

<details>
<summary>Portlar, pencere, kabuk ortamı, kapatma ve tanılama</summary>

- Dürbün sunucuyu uygulamanın içinde çalıştırır ve arayüzü kendi penceresinde açar; terminal gerekmez.
- Port 9750 (arayüz) ve 9751 (SDK'lar). Bir Dürbün zaten çalışıyorsa (ör. `npm start`) uygulama onu açar, o
  kapanınca kendi sunucusunu başlatır; sürümler farklıysa menü çubuğundaki simge söyler. Pencere yalnızca
  Dürbün olduğunu kanıtlayan bir sunucuya bağlanır (`/api/health` adı ve sürümü, `/` adresinde Dürbün
  arayüzü). Port başka bir programdaysa 9760, 9770 ve 9780'i dener ve kullandığı portu menü çubuğunda
  gösterir.
- Pencere sunucuyu `localhost` yerine `http://127.0.0.1:<port>` adresinden açar; `localhost` önce `::1`'i
  dener ve orada başka bir program olabilir.
- Menüler ve menü çubuğu uyarıları arayüzün dilini (ilk açılışta sistem dilini) izler. Sunucunun İngilizce
  metni tanılama günlüğüne yazılır.
- Sunucu ve arayüz `app.asar` içindedir; Electron'un bütünlük denetimi değiştirilmiş bir kopyayı
  çalıştırmaz.
- Dürbün `PATH`'i ve araç ayarlarını (`ANDROID_HOME`, `JAVA_HOME`, fvm, `DEVELOPER_DIR`) giriş kabuğunuzdan
  okur; `adb`, `flutter` ve `idevicesyslog` Terminal'deki gibi bulunur. Kabuk 3 saniyede yanıt vermezse
  menü çubuğundaki simge söyler.
- Pencereyi kapatmak yakalamayı durdurmaz; Dürbün menü çubuğunda çalışmaya devam eder. ⌘Q ya da menü
  çubuğu simgesi → **Çık** sunucuyu düzgünce durdurarak kapatır.
- Sunucu başlayamazsa pencere nedenini gösterir ve **Tekrar Dene**, **Tanılama Günlüğünü Göster** ve
  **Çık** seçeneklerini sunar. Yardım → **Sorun Bildir…** yeni bir GitHub issue'su açar; Yardım →
  **Lisanslar** üçüncü taraf lisanslarını listeler.

</details>

## Komut satırı

```bash
npm install
npm run build
npm start
```

Arayüz http://127.0.0.1:9750 adresinde açılır; Chrome, Brave, Edge, Arc veya Chromium kuruluysa adres
çubuğu olmayan bir uygulama penceresinde.

```
node dist/durbun.mjs [--port 9750] [--sdk-port 9751] [--demo] [--no-open] [--lan]
                     [--data-dir ~/.durbun] [--ui-dir YOL] [--verbose]
```

Ayarlar, mock kuralları, akışlar, ortamlar ve çalıştırma geçmişi `~/.durbun` içinde saklanır.

## Kaldırma

1. **Dürbün → Girişte Aç** seçeneğini açtıysanız önce kapatın (ya da sonradan Sistem Ayarları → Genel → Giriş
   Öğeleri'nden Dürbün'ü kaldırın).
2. Dürbün'ü kapatın (⌘Q) ve Uygulamalar klasöründen Çöp Sepeti'ne taşıyın. Normal kapanışta Dürbün, takılı
   Android telefonlarda kurduğu port yönlendirmelerini kaldırır. Dürbün normal kapanmadıysa bunları
   `adb reverse --remove-all` ile kaldırın (bu komut o telefonda başka araçların kurduğu yönlendirmeleri de
   kaldırır).
3. Verilerini de silmek için şunları silin:
   - `~/.durbun` (ya da `--data-dir` ile verdiğiniz klasör): ayarlar (`settings.json`), mock kuralları
     (`mocks.json`), akışlar (`flows/`), çalıştırma geçmişi (`flow-runs/`), ortamlar (`environments.json`),
     yedekleme ayarları (`backup.json`), Slack webhook adresi (`slack.json`) ve geçici dosyalar. Başka bir
     klasöre yazdığınız yedekler orada kalır.
   - `~/Library/Application Support/Dürbün`: pencere durumu, arayüz tercihleri, uygulamanın kendi ayarları
     (`desktop.json`), tanılama günlüğü (`logs/`) ve çökme dökümleri (`Crashpad/`).
   - `~/Library/Preferences/dev.durbun.desktop.plist`: macOS'in uygulama için tuttuğu tercihler.
   - `~/Library/Saved Application State/dev.durbun.desktop.savedState`: macOS'in kaydettiği pencere durumu
     (varsa).
4. Uygulamalarınıza eklediğiniz SDK paketlerini kaldırın.

## Katkıda bulunma

Kaynaktan derleme, Mac uygulamasının derlenmesi, geliştirme komutları ve depo yapısı
[CONTRIBUTING.md](CONTRIBUTING.md)'de (İngilizce). Güvenlik açığı bildirmek için [SECURITY.md](SECURITY.md)'ye bakın.

## Sürümleme

Dürbün [Semantic Versioning](https://semver.org) kullanır. Mac uygulaması, sunucu ve tüm SDK'lar aynı
sürümü taşır ve `main` üzerindeki bir `vX.Y.Z` etiketinden birlikte yayımlanır; değişiklikler
[CHANGELOG.md](CHANGELOG.md)'de. Sürüm `0.x` iken ara sürümler uyumsuz değişiklik içerebilir.

Parçaları birlikte yükseltmeniz gerekmez: 0.1.0'dan bu yana Mac uygulaması her SDK sürümüyle derlenmiş
uygulamaları kabul eder, SDK'lar da her Mac uygulamasını; iki taraf da bilmediğini yok sayar. Yeni bir özellik,
iki tarafta da olduğunda çalışır. Bkz. [Sürümler ve yükseltme](docs/guides/versions.md).

## Lisans

[MIT](LICENSE) © 2026 Muhammed Yusuf Kaynak
