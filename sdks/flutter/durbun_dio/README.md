# durbun_dio

Dio interceptor for adapters that bypass `dart:io` (`NativeAdapter`, cronet_http). It reports requests to
[Dürbün](https://github.com/mykynk/durbun) and applies the desktop's mock rules: `respond` (resolved without a
network call), `delay`, and `fail` (`connectionTimeout`, `connectionError`, `badCertificate` or an unknown
`DioException`).

## Install

```sh
flutter pub add durbun_dio
```

`durbun_dio` depends on `durbun`, so both end up in your `pubspec.yaml`:

```yaml
dependencies:
  durbun: ^0.1.0
  durbun_dio: ^0.1.0
```

## Usage

```dart
final dio = Dio()..httpClientAdapter = NativeAdapter();
dio.interceptors.add(DurbunDioInterceptor(dio: dio)); // last
```

Start the SDK as usual (`Durbun.run` / `Durbun.init`, see `package:durbun`).
A complete example is in [`example/main.dart`](example/main.dart).

## Behavior

- Dio's default adapter (`IOHttpClientAdapter`) is already captured and mocked by `package:durbun`. Thanks to the
  required `dio:` argument, the interceptor then stays out of the way: no duplicate entries, and `delay` mocks
  are not applied twice.
- On iOS, `NativeAdapter` and `CupertinoAdapter` run on URLSession, which the plugin's native layer already
  captures, so the interceptor does not report those requests again. In `--obfuscate` builds, class names are
  minified and this cannot be told apart, so these requests may show up twice on iOS.
- **Add the interceptor last.** A request is reported as the interceptors before it left it (headers, body).
  If you add it before the interceptor that sets your authorization header, for example, the report will not
  show that header.
- Bodies are encoded only up to the desktop's body limit (`maxBodyBytes`); large JSON responses are not
  re-encoded in full.

## Development

Inside the Dürbün repository, `pubspec_overrides.yaml` points `durbun` at `../durbun`, so
`flutter pub get --offline`, `flutter analyze` and `flutter test --concurrency=2` work against the local SDK.
