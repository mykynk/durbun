# durbun_dio

🇹🇷 Dio, dart:io kullanmayan bir adaptörle (`NativeAdapter`, cronet_http)
çalışıyorsa istekleri [Dürbün](https://github.com/mykynk/durbun)'e raporlayan ve
masaüstündeki mock kurallarını uygulayan interceptor.

- Dio'nun varsayılan adaptörü (`IOHttpClientAdapter`) zaten `package:durbun`
  tarafından yakalanır ve mock'lanır; `dio:` parametresi (zorunlu) sayesinde
  interceptor bu durumda kendini devre dışı bırakır: istekler iki kez görünmez,
  `delay` mock'ları iki kez beklemez.
- iOS'ta `NativeAdapter` / `CupertinoAdapter` URLSession kullanır; bu istekleri
  plugin'in native katmanı zaten yakalar, interceptor onları ikinci kez
  raporlamaz. `--obfuscate` ile derlenmiş sürümlerde sınıf adları gizlendiği
  için bu ayrım yapılamaz; iOS'ta bu istekler o sürümlerde iki kez görünebilir.
- **Interceptor'ı en sona ekleyin:** istek, kendisinden önceki interceptor'ların
  bıraktığı hâliyle (başlıklar, gövde) raporlanır. Örneğin yetki başlığını
  ekleyen interceptor'dan önce eklenirse o başlık raporda görünmez.
- Gövdeler masaüstünün gövde sınırına (`maxBodyBytes`) kadar kodlanır; daha
  büyük JSON yanıtları baştan sona yeniden kodlanmaz.

🇬🇧 Interceptor for Dio adapters that bypass dart:io (`NativeAdapter`,
cronet_http). It reports requests to [Dürbün](https://github.com/mykynk/durbun)
and applies the desktop's mock rules (`respond` → resolved without a network
call, `delay`, `fail` → `connectionTimeout` / `connectionError` /
`badCertificate` / unknown `DioException`).

- Dio's default adapter (`IOHttpClientAdapter`) is already captured and mocked
  by `package:durbun`; thanks to the required `dio:` argument the interceptor
  then stays out of the way (no duplicate entries, no doubled `delay` mocks).
- On iOS, `NativeAdapter` / `CupertinoAdapter` run on URLSession, which the
  plugin's native layer already captures, so the interceptor does not report
  them again. In `--obfuscate` builds class names are minified and this cannot
  be told apart: there these requests may show up twice on iOS.
- **Add the interceptor last:** the request is reported as the interceptors
  before it left it (headers, body). Added before the one that sets your auth
  header, for example, the report would not show that header.
- Bodies are encoded only up to the desktop's body limit (`maxBodyBytes`);
  large JSON responses are not re-encoded in full.

```yaml
dependencies:
  durbun: ^0.1.0
  durbun_dio: ^0.1.0
```

```dart
final dio = Dio()..httpClientAdapter = NativeAdapter();
dio.interceptors.add(DurbunDioInterceptor(dio: dio)); // last
```

Start the SDK as usual (`Durbun.run` / `Durbun.init`, see `package:durbun`).
A complete example is in [`example/main.dart`](example/main.dart).

## Development

Inside the Dürbün repo `pubspec_overrides.yaml` points `durbun` at
`../durbun`, so `flutter pub get --offline`, `flutter analyze` and
`flutter test --concurrency=2` work against the local SDK.
