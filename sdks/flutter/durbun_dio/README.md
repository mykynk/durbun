# durbun_dio

🇹🇷 Dio, dart:io kullanmayan bir adaptörle (`NativeAdapter`, cupertino_http,
cronet_http) çalışıyorsa istekleri Dürbün'e raporlayan ve masaüstündeki mock
kurallarını uygulayan interceptor. Dio'nun varsayılan adaptörü zaten
`package:durbun` tarafından yakalanır; `dio:` parametresini verirseniz
interceptor bu durumda kendini devre dışı bırakır (çift kayıt olmaz). iOS'ta
`NativeAdapter` URLSession kullanır ve bu istekleri plugin'in native katmanı
zaten yakalar, interceptor onları ikinci kez raporlamaz. `--obfuscate` ile
derlenmiş sürümlerde sınıf adları gizlendiği için bu ayrım yapılamaz; iOS'ta
`NativeAdapter` istekleri o sürümlerde iki kez görünebilir.

🇬🇧 Interceptor for Dio adapters that bypass dart:io. It reports requests to
Dürbün and applies the desktop's mock rules (`respond` → resolved without a
network call, `delay`, `fail` → `connectionTimeout` / `connectionError` /
`badCertificate` / unknown `DioException`). With `dio:` given, requests that
still use the default dart:io adapter are left to `package:durbun`. On iOS,
`NativeAdapter` runs on URLSession, which the plugin's native layer already
captures, so the interceptor does not report those requests again. In
`--obfuscate` builds class names are minified and this cannot be told apart:
there `NativeAdapter` requests on iOS may show up twice.

```yaml
dependencies:
  durbun:
    path: ../durbun/sdks/flutter/durbun
  durbun_dio:
    path: ../durbun/sdks/flutter/durbun_dio
```

```dart
final dio = Dio()..httpClientAdapter = NativeAdapter();
dio.interceptors.add(DurbunDioInterceptor(dio: dio));
```

Start the SDK as usual (`Durbun.run` / `Durbun.init`).
