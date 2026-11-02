# durbun_dio

🇹🇷 Dio, dart:io kullanmayan bir adaptörle (`NativeAdapter`, cupertino_http,
cronet_http) çalışıyorsa istekleri Dürbün'e raporlayan ve masaüstündeki mock
kurallarını uygulayan interceptor. Dio'nun varsayılan adaptörü zaten
`package:durbun` tarafından yakalanır; `dio:` parametresini verirseniz
interceptor bu durumda kendini devre dışı bırakır (çift kayıt olmaz).

🇬🇧 Interceptor for Dio adapters that bypass dart:io. It reports requests to
Dürbün and applies the desktop's mock rules (`respond` → resolved without a
network call, `delay`, `fail` → `connectionTimeout` / `connectionError` /
`badCertificate` / unknown `DioException`). With `dio:` given, requests that
still use the default dart:io adapter are left to `package:durbun`.

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
