# Dürbün — React Native / JavaScript SDK

`@durbun/react-native`: uygulamanızın **tüm loglarını** (console, kendi logları, hatalar/çökmeler), **tüm ağ
trafiğini** (fetch, axios, XMLHttpRequest) ve JS performans ölçümlerini canlı olarak Dürbün masaüstü
uygulamasına gönderir. Dürbün'deki mock kurallarını (sahte yanıt, gecikme, hata) uygulama içinde uygular.

- Çalışma zamanı bağımlılığı **yok**; React Native (Hermes/JSC), tarayıcı ve Node üzerinde çalışır.
- Release build'lerde **hiçbir şey yapmaz** (`enabled` varsayılanı `__DEV__`).
- Uygulamanın kendi davranışını değiştirmez: orijinal `console` çağrılır, istek/yanıt gövdeleri tüketilmez,
  RN kırmızı ekranı / LogBox aynen çalışır. SDK içindeki hiçbir hata uygulamaya sızmaz.

**English documentation is below ↓**

---

## Kurulum

Paket npm'de yayımlanmadı; Dürbün reposundan yerel olarak kurulur. **Klasörü değil, paketlenmiş `.tgz`
dosyasını** kurun (Metro, uygulama klasörü dışındaki sembolik bağlantılardan `react-native`'i çözemez):

```sh
# 1) Dürbün reposunda: paketi oluştur (prepack otomatik derler)
cd /yol/durbun/sdks/js
npm pack                      # → durbun-react-native-0.1.0.tgz

# 2) Uygulamanızda
npm install /yol/durbun/sdks/js/durbun-react-native-0.1.0.tgz
# veya: yarn add file:/yol/durbun/sdks/js/durbun-react-native-0.1.0.tgz
```

Native kod yoktur: `pod install` veya Gradle değişikliği gerekmez; bu yüzden Expo projelerinde (dev client /
Expo Go) de kullanılabilir.

## Başlatma (`index.js`)

```js
import { AppRegistry } from 'react-native';
import { Durbun } from '@durbun/react-native';
import App from './App';
import { name as appName } from './app.json';

Durbun.start(); // __DEV__ değilse hiçbir şey yapmaz

AppRegistry.registerComponent(appName, () => App);
```

> İpucu: `import`'lar `Durbun.start()`'tan önce çalışır. Modül yüklenirken istek atan kodlarınız varsa
> başlatmayı ayrı bir dosyaya alıp **ilk import** yapın: `durbun.js` → `Durbun.start();`, `index.js` →
> `import './durbun';`

## Cihaz bağlantısı

| Ortam | Yapılacak |
|---|---|
| **Android cihaz (USB)** | Hiçbir şey. Dürbün her bağlı cihaz için `adb reverse tcp:9750 tcp:9750` komutunu **otomatik** çalıştırır; `localhost:9750` cihazdan Mac'e ulaşır. (Elle: `adb reverse tcp:9750 tcp:9750`) |
| **Android emülatör** | Hiçbir şey (aynı `adb reverse`; ayrıca `10.0.2.2` otomatik denenir). |
| **iOS simülatör** | Hiçbir şey: simülatör Mac'in ağını paylaşır, `localhost` çalışır. |
| **iOS fiziksel cihaz** | Cihaz `localhost` ile Mac'e ulaşamaz. Dürbün'ü `durbun --lan` ile başlatın, cihaz ve Mac aynı Wi-Fi'da olsun, `Durbun.start({ host: '192.168.1.20' })` ile **Mac'in yerel IP adresini** verin (Sistem Ayarları → Ağ). `host` verilmezse SDK, Metro'nun çalıştığı adresi (genelde aynı Mac) de otomatik dener. İlk bağlantıda iOS "Yerel Ağ" iznini sorar. |
| Tarayıcı / Node | `Durbun.start()` yeterli. Node < 22 için: `Durbun.start({ WebSocket: require('ws') })`. |

Bağlantı yoksa SDK mesajları bellekte tutar (son 5 000 mesaj), 0,5 sn → 3 sn aralıklarla yeniden bağlanır
ve bağlanınca hepsini sırasıyla gönderir; taşan mesaj olduysa bunu bir uyarı satırıyla bildirir.

## Kullanım

```js
import { Durbun } from '@durbun/react-native';

Durbun.log('Kullanıcı giriş yaptı', { tag: 'auth', data: { userId: 42 } });
Durbun.debug('Önbellekten okundu', { data: cacheEntry });
Durbun.info('Sepet güncellendi');
Durbun.warn('Yanıt yavaş', { data: { ms: 3200 } });

try {
  await pay();
} catch (e) {
  Durbun.error('Ödeme başarısız', e);                    // kısa yol
  Durbun.error('Ödeme başarısız', { error: e, tag: 'payment', data: { orderId } });
}

Durbun.event('purchase', { amount: 49.9, currency: 'TRY' });

// Dürbün'ün Cihaz sekmesinde bu uygulama için buton / anahtar
Durbun.addAction({ id: 'app.clearCache', label: 'Önbelleği temizle' }, async () => {
  await cache.clear();
  return { ok: true };
});
Durbun.addAction({ id: 'app.mockLocation', label: 'Sahte konum', kind: 'toggle', value: false }, ({ value }) => setMockLocation(!!value));
```

- `data` istediğiniz nesne olabilir: döngüsel referanslar, BigInt, Date, Map/Set, Error güvenle kopyalanır;
  Dürbün'de açılır/kapanır JSON ağacı olarak görünür.
- `console.log('[Auth] token yenilendi')` gibi **`[Etiket]` önekli** satırlar `Auth` etiketiyle (renkli
  çip) gösterilir; nesneler mesajda tek satır JSON, detayda ağaç olarak görünür.

## Neler yakalanır?

| | |
|---|---|
| **console.\*** | `log/info/debug/warn/error/trace/assert/dir/table`; `%s %d %o %c` biçimlendirmesi, nesneler → JSON veri, Error → yığın izi. `captureConsole: 'auto'` (varsayılan): Dürbün cihazın kendi loglarını zaten alıyorsa (Android logcat, iOS simülatör) console satırları **tekrar gönderilmez**, satırlar çift görünmez. |
| **SDK logları** | `Durbun.log/debug/info/warn/error`, `Durbun.event` |
| **Ağ** | `XMLHttpRequest` üzerinden giden her şey: RN `fetch`, axios, diğerleri. Yöntem, URL, başlıklar, istek/yanıt gövdeleri (metin/JSON düz, ikili veri base64, FormData alan özeti, Blob), durum kodu, süre (bekleme / indirme), hatalar, zaman aşımları, iptaller. Tarayıcı/Node'da yerel `fetch` de ayrıca yakalanır; her istek **bir kez** raporlanır. Gövde sınırı Dürbün ayarlarından gelir (varsayılan 1 MB). Metro ve Dürbün'ün kendi trafiği yakalanmaz. |
| **Mock'lar** | Dürbün'ün Mock'lar sekmesindeki kurallar: *sahte yanıt* (ağa hiç çıkmadan), *gecikme* (sonra gerçek istek; uygulamanın kendi zaman aşımı geçerlidir), *hata* (platformun doğal hatası: RN'de `Network request failed`). |
| **Hatalar** | Yakalanmamış hatalar (`ErrorUtils`, önceki işleyici zinciri korunur): ölümcül olanlar **çökme** satırı olarak; React Native'de yakalanmamış promise reddi (RN'in geliştirme modunda bastığı uyarıdan, LogBox aynen gösterir); web'de `error` + `unhandledrejection`, Node'da `uncaughtExceptionMonitor`. |
| **Performans** | JS heap (Hermes), JS iş parçacığı FPS'i ve takılan kare sayısı (RN perf monitor'deki "JS FPS"). |
| **Eylemler** | Geliştirme modunda "Reload JS" ve "Open dev menu" butonları + `Durbun.addAction` ile sizinkiler. |

**JS SDK'nın göremedikleri:** RN `<Image>` indirmeleri ve native modüllerin (Firebase vb.) kendi istekleri JS
katmanından geçmez; bunlar yakalanmaz. `Durbun.start()`'tan önce açılmış (`open()` çağrılmış) istekler de
yakalanmaz. Uygulamanın stdout'u ve sistem logları ise SDK olmadan da Dürbün'ün cihaz loglarında görünür.

## Seçenekler

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `host` | `'localhost'` | Dürbün'ün çalıştığı bilgisayar. `'192.168.1.20'` veya `'192.168.1.20:9750'` olabilir. |
| `port` / `path` / `url` | `9750` / `'/sdk'` / – | `url` tam WebSocket adresidir (`ws://…/sdk`), diğerlerini geçersiz kılar. |
| `enabled` | `__DEV__` (RN), aksi halde `NODE_ENV !== 'production'` | Release'de zorlamak için `true`. |
| `captureConsole` | `'auto'` | `true` her zaman, `false` hiçbir zaman. |
| `captureNetwork` / `captureErrors` / `captureMetrics` | `true` | |
| `maxBufferedMessages` | `5000` | Bağlantı yokken tutulan mesaj sayısı. |
| `appId` / `appName` / `appVersion` | otomatik | Paket adı / görünen ad. RN'de Metro paket adresinden ve `AppRegistry`'den, Expo'da `expo-application`'dan okunur. Mock kuralları uygulama kimliğine göre filtrelenir. |
| `device` | otomatik | Örn. `{ name: "Yusuf'un iPhone'u" }` |
| `ignoreUrls` | `[]` | Hiç yakalanmayacak/mocklanmayacak URL'ler (metin parçası veya RegExp). |
| `redactHeaders` | `[]` | Değeri Dürbün'de `••••` olarak görünecek başlıklar (büyük/küçük harf duyarsız), ör. `['Authorization', 'Cookie']`. Sunucuya giden istek değişmez. |
| `WebSocket` | global | Global WebSocket olmayan ortamlar için uygulama. |
| `debug` | `false` | SDK tanılama mesajlarını konsola yazar. |

## Release güvenliği

`__DEV__` `false` iken `Durbun.start()` hiçbir yama kurmaz, bağlantı açmaz; diğer çağrılar boş işlemdir.
Release'de bilerek açacaksanız (`enabled: true`): Android'de `ws://` için cleartext izni, iOS'ta ATS
`NSAllowsLocalNetworking` gerekir (RN debug şablonlarında zaten açıktır).

## Sorun giderme

- **Bağlanmıyor**: Dürbün açık mı (`http://localhost:9750`)? Android'de `adb reverse --list` içinde
  `tcp:9750` var mı? `Durbun.start({ debug: true })` ile SDK'nın denediği adresleri görün.
- **Metro: `Unable to resolve module react-native`**: paket klasörden (symlink) kurulmuş. `.tgz` ile kurun ya da
  `metro.config.js`'te `watchFolders: ['/yol/durbun/sdks/js']` ve
  `resolver.nodeModulesPaths: [path.resolve(__dirname, 'node_modules')]` ekleyin.
- **Jest**: paket CommonJS çıktısı da içerir, `transformIgnorePatterns` değişikliği gerekmez. Testlerde
  `Durbun.start()` çağrılmadıkça SDK hiçbir şey yapmaz.

---

# English

`@durbun/react-native` streams **all logs** (console, your own logs, errors/crashes), **all network traffic**
(fetch, axios, XMLHttpRequest) and JS performance samples of your app to the Dürbün desktop app, live. It also
applies Dürbün's mock rules (fake responses, latency, failures) inside the app.

- **Zero runtime dependencies**; works in React Native (Hermes/JSC), browsers and Node.
- **No-op in release builds** (`enabled` defaults to `__DEV__`).
- Never changes app behavior: original `console` methods are called, request/response bodies are never
  consumed, the RN red box / LogBox keep working, and SDK failures never reach the app.

## Install

Not published to npm yet — install from the Dürbün repository. Install the **packed `.tgz`, not the folder**
(Metro cannot resolve `react-native` from a symlinked folder outside the app):

```sh
cd /path/to/durbun/sdks/js && npm pack          # → durbun-react-native-0.1.0.tgz (prepack builds it)
cd /path/to/your-app && npm install /path/to/durbun/sdks/js/durbun-react-native-0.1.0.tgz
```

No native code: no `pod install`, no Gradle changes — so it can also be used in Expo projects (dev client /
Expo Go).

## Start it in `index.js`

```js
import { AppRegistry } from 'react-native';
import { Durbun } from '@durbun/react-native';
import App from './App';
import { name as appName } from './app.json';

Durbun.start(); // does nothing unless __DEV__

AppRegistry.registerComponent(appName, () => App);
```

> Imports run before `Durbun.start()`. If modules make requests while loading, move the call into its own
> file and import it first (`import './durbun';`).

## Connecting a device

| Target | What to do |
|---|---|
| **Android device (USB)** | Nothing. Dürbün runs `adb reverse tcp:9750 tcp:9750` **automatically** for every connected device, so `localhost:9750` on the phone reaches the Mac (manual: `adb reverse tcp:9750 tcp:9750`). |
| **Android emulator** | Nothing (same `adb reverse`; `10.0.2.2` is also tried automatically). |
| **iOS simulator** | Nothing: the simulator shares the Mac's network, `localhost` works. |
| **iOS physical device** | The phone cannot reach the Mac via `localhost`. Start Dürbün with `durbun --lan`, keep phone and Mac on the same Wi-Fi and pass the **Mac's LAN IP**: `Durbun.start({ host: '192.168.1.20' })`. Without `host`, the SDK also tries the Metro dev-server host (usually the same Mac). iOS asks for the Local Network permission once. |
| Browser / Node | `Durbun.start()`. Node < 22: `Durbun.start({ WebSocket: require('ws') })`. |

While disconnected the SDK keeps the last 5 000 messages, reconnects with backoff (0.5 s → 3 s) and flushes them
in order once connected, adding a warning line if anything had to be dropped.

## API

```js
Durbun.log('Logged in', { tag: 'auth', data: { userId: 42 } });   // level via { level: 'debug' }, default info
Durbun.debug(msg, opts); Durbun.info(msg, opts); Durbun.warn(msg, opts);
Durbun.error('Payment failed', err);                                // or { error: err, tag, data }
Durbun.event('purchase', { amount: 49.9 });
Durbun.addAction({ id: 'app.clearCache', label: 'Clear cache' }, async (params) => ({ cleared: true }));
Durbun.stop();             // restores every patched API
Durbun.isStarted; Durbun.isConnected;
```

`data` may be any value (cycles, BigInt, Map/Set, Date and Errors are snapshotted safely) and shows up as a
collapsible JSON tree. A leading `[Tag]` in console messages (`console.log('[Auth] token refreshed')`) becomes
the row's tag chip.

## What is captured

| | |
|---|---|
| **console.\*** | `log/info/debug/warn/error/trace/assert/dir/table`, printf-style formatting, objects → JSON data, Errors → stack traces. `captureConsole: 'auto'` (default) skips console lines the desktop already receives from the device log stream (Android logcat, iOS simulator) so rows are not duplicated. |
| **SDK logs** | `Durbun.log/debug/info/warn/error`, `Durbun.event`. |
| **Network** | Everything on `XMLHttpRequest` — RN `fetch`, axios, …: method, URL, headers, request/response bodies (text/JSON as text, binary as base64, FormData field summary, Blobs), status, timings (wait / receive), errors, timeouts and cancellations. Native `fetch` in browsers/Node is captured too; each request is reported **once**. Body limits come from Dürbün's settings (default 1 MB). Metro's and Dürbün's own traffic is ignored. |
| **Mocks** | Rules from Dürbün's Mocks tab: *respond* (never hits the network), *delay* (then the real request; the app's own XHR timeout still applies), *fail* (the platform's natural error — `Network request failed` on RN). |
| **Errors** | Uncaught errors via `ErrorUtils` (previous handler kept) — fatal ones become **crash** rows; unhandled promise rejections in React Native (from the warning RN prints in dev; LogBox still shows it); `error` + `unhandledrejection` on the web; `uncaughtExceptionMonitor` in Node. |
| **Performance** | JS heap (Hermes), JS-thread FPS and janky frames (RN perf monitor's "JS FPS"). |
| **Actions** | "Reload JS" and "Open dev menu" in dev builds, plus your own via `Durbun.addAction`. |

**Not visible to a JS SDK:** RN `<Image>` downloads and requests made by native modules (Firebase, …) never pass
through JavaScript, so they are not captured; neither are requests opened before `Durbun.start()`. The app's
stdout and system logs still show up in Dürbün's device logs without any SDK.

## Options

| Option | Default | |
|---|---|---|
| `host` | `'localhost'` | Machine running Dürbün; `'192.168.1.20'` or `'192.168.1.20:9750'`. |
| `port` / `path` / `url` | `9750` / `'/sdk'` / – | `url` is a full WebSocket URL and overrides the others. |
| `enabled` | `__DEV__` (RN), else `NODE_ENV !== 'production'` | `true` forces it on in release builds. |
| `captureConsole` | `'auto'` | `true` always, `false` never. |
| `captureNetwork` / `captureErrors` / `captureMetrics` | `true` | |
| `maxBufferedMessages` | `5000` | Messages kept while disconnected. |
| `appId` / `appName` / `appVersion` | auto | RN: from Metro's bundle URL and `AppRegistry`; Expo: `expo-application`. Mock rules are scoped by app id. |
| `device` | auto | e.g. `{ name: "Yusuf's iPhone" }` |
| `ignoreUrls` | `[]` | Never captured or mocked (substring or RegExp). |
| `redactHeaders` | `[]` | Header names (case-insensitive) shown as `••••` in Dürbün, e.g. `['Authorization', 'Cookie']`. The request sent to the server is unchanged. |
| `WebSocket` | global | Implementation for runtimes without a global WebSocket. |
| `debug` | `false` | Print SDK diagnostics to the console. |

## Release safety

With `__DEV__ === false`, `Durbun.start()` installs nothing and opens no connection; every other call is a
no-op. If you force it on in release (`enabled: true`), Android needs cleartext permission for `ws://` and iOS
needs ATS `NSAllowsLocalNetworking` (already enabled in RN debug templates).

## Troubleshooting

- **No connection**: is Dürbün running (`http://localhost:9750`)? On Android, does `adb reverse --list` show
  `tcp:9750`? `Durbun.start({ debug: true })` prints the addresses the SDK tries.
- **Metro: `Unable to resolve module react-native`**: the package was installed from a folder (symlink). Install
  the `.tgz`, or add `watchFolders: ['/path/to/durbun/sdks/js']` and
  `resolver.nodeModulesPaths: [path.resolve(__dirname, 'node_modules')]` to `metro.config.js`.
- **Jest**: the package ships a CommonJS build, so no `transformIgnorePatterns` change is needed; the SDK does
  nothing unless `Durbun.start()` is called.

## Development

```sh
npm run build -w @durbun/react-native     # ESM → dist/, CommonJS → dist/cjs/, .d.ts
npm run smoke -w @durbun/react-native     # plain-Node check of the built package
cd sdks/js && npx vitest run              # unit + integration tests (fake desktop, local HTTP server)
npx tsc -p sdks/js/tsconfig.json          # typecheck sources and tests
```
