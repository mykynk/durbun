# durbun_dio

Dio adapter wrapper and interceptor for adapters that bypass `dart:io` (`NativeAdapter`, cronet_http). It reports
requests to
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
  durbun: ^0.2.0
  durbun_dio: ^0.2.0
```

## Usage

Wrap the adapter (recommended):

```dart
final dio = Dio()..httpClientAdapter = DurbunDioAdapter(NativeAdapter());
```

Start the SDK as usual (`Durbun.run` / `Durbun.init`, see `package:durbun`).
A complete example is in [`example/main.dart`](example/main.dart).

`DurbunDioAdapter` sits where the request leaves the app:

- Every request that reaches the network gets its own row, and every row ends: a retry after a token refresh
  shows the first `401` and the second request separately, whatever your interceptors do.
- Request headers are the final ones, after every interceptor.
- The response body is the bytes the adapter delivered, and its size is the number of those bytes. The time runs
  until the last byte, before Dio decodes the JSON.
- Mock rules are applied there too: `respond` answers without a network call and Dio treats the status as usual.

The interceptor from earlier versions still works:

```dart
final dio = Dio()..httpClientAdapter = NativeAdapter();
dio.interceptors.add(DurbunDioInterceptor(dio: dio)); // last
```

It only sees what reaches it. When an interceptor added before it answers an error itself (for example a token
refresh that calls `handler.resolve(await dio.fetch(err.requestOptions))`), the first row ends when the request
is sent again, with a note instead of the response; the body shown is Dio's decoded data encoded again. Keeping
the interceptor while you switch to the adapter is safe: it stays out of the way of a `DurbunDioAdapter`.

## Behavior

- Dio's default adapter (`IOHttpClientAdapter`) is already captured and mocked by `package:durbun`. Both the
  adapter wrapper and the interceptor (thanks to its required `dio:` argument) then stay out of the way: no
  duplicate entries, and `delay` mocks are not applied twice.
- On iOS, `NativeAdapter` and `CupertinoAdapter` run on URLSession, which the plugin's native layer already
  captures, so Dürbün's Dio layer does not report those requests again. In `--obfuscate` builds, class names are
  minified and this cannot be told apart, so these requests may show up twice on iOS.
- **Interceptor only: add it last.** A request is reported as the interceptors before it left it (headers,
  body). If you add it before the interceptor that sets your authorization header, for example, the report will
  not show that header.
- Bodies are kept only up to the body limit (`maxBodyBytes`); large JSON responses are not re-encoded in full.
- With `ResponseType.stream`, a row ends when your code reads the stream to the end or stops reading it.

## Development

Inside the Dürbün repository, `pubspec_overrides.yaml` points `durbun` at `../durbun`, so
`flutter pub get --offline`, `flutter analyze` and `flutter test --concurrency=2` work against the local SDK.
