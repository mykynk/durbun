## Unreleased (phase 3)

- `durbun` is now a Flutter plugin (Android `dev.durbun.flutter.DurbunFlutterPlugin`,
  iOS `DurbunFlutterPlugin`) that carries the native cores: Android compiles
  `sdks/android/durbun` through Gradle sourceSets, iOS carries an exact copy of
  `sdks/ios/Sources/Durbun` (`tool/sync_native.dart`, drift test).
- The Dart side starts the native layer over the `dev.durbun/native` method
  channel (no native init call). Native crashes, Kotlin/Swift logs, OkHttp
  (`DurbunInterceptor`) and iOS URLSession traffic go out over the Dart
  connection (one app session, merged capabilities/actions, native app
  version/build in `hello`).
- Enablement: debug/profile on; release only with `--dart-define=DURBUN=true`;
  `DURBUN=false` turns it off; `enabled:` still wins. The native layer follows.
  The SDK does not look at where the app was installed from: a `DURBUN=true`
  release runs from Firebase, ad-hoc, TestFlight, Google Play or the App Store
  alike, so each project decides which builds run Dürbün. README: release
  commands (`--export-method ad-hoc` for Firebase / ad-hoc), the
  `ios/Flutter/Generated.xcconfig` note for Xcode Archive, and a security note
  (the SDK talks to whatever answers on its device loopback port; no pairing
  yet).
- `DurbunNetwork.capturesUrlSession` (used by durbun_dio to avoid duplicates).
- `hello.sdk.layers`: `['dart']`, plus `'android'` / `'ios'` while the plugin's
  native core is attached, so the desktop can say which layers feed the session.
- iOS USB listener: binds only once the hello is ready. A desktop that connected
  in the first moments after start used to be accepted and dropped without a
  hello (now it is refused and connects on its next try).
- durbun_dio: the dart:io adapter is recognized by type instead of its class
  name, so `--obfuscate` builds no longer report those requests twice.
- Mock rules end with the connection that pushed them, in every layer (Dart,
  Kotlin, Swift, hosted and standalone): the peer is not authenticated yet.
- Android honours `captureNetwork: false`: no OkHttp capture or mocks, and
  network/mocks are no longer announced.
- The first hello waits up to 3 s (was 1.5 s) for the native layer, as long as
  the native start itself.
- OkHttp shows redacted header values as `••••`, like dart:io and URLSession.
- A native `Durbun.start()` does nothing in Flutter apps: the plugin starts the
  native layer from Dart, so no second session opens and `DURBUN=false` keeps
  it off.

## 0.1.0

- First version of the Dürbün Flutter SDK: `Durbun.run` / `Durbun.init`, app
  logs (`log`, `v/d/i/w/e/f`), events, print capture, Flutter errors and crashes,
  dart:io HTTP capture with bodies and mock rules, frame/memory/CPU metrics,
  `flutter.*` desktop commands and custom `DurbunAction`s.
- NDJSON transport on a background isolate: 127.0.0.1:9751 (adb reverse /
  simulators), optional Wi-Fi host, usbmux listener on iOS devices
  (127.0.0.1:9752–9755), reconnect with backoff and a 5 000-message buffer.
- Pure-Dart core (`package:durbun/durbun_core.dart`) and `tool/smoke.dart`.
