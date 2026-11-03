## Unreleased (phase 3)

- In-app panel: compare two requests, as on the desktop. "Compare…" on a
  request's detail lists the same method and path first; General, Headers,
  Response body and Request body tabs, with the desktop's line diff (LCS with
  patience anchors), only-changes folding and sorted JSON keys, in one column.
  Replay now sends captured headers once (no second `Accept-Encoding`, no
  added `User-Agent`).

- In-app panel fixes from a device run: `print` / `debugPrint` lines reach
  the panel locally (they were dropped when the desktop read logcat, or held
  while no desktop connected); logger PrettyPrinter boxes are one entry with
  the level from the emoji and the tag from `[Tag]`; filters and search apply
  while the list is frozen (scrolled up or paused); search ignores case,
  Turkish letters and %-encoding and marks every word; a logged HTML page on
  one line no longer freezes the panel (messages kept up to 64 KB on the
  phone, rows show a preview). Toolbars: Filters sheet, removable active
  chips first, minimum-level menu, clear button, tappable query help, "Clear
  filters" on empty results.

- The in-app panel opens by shaking the phone and draws nothing over the app by
  default (`showBubble: false`, `openOnShake: true`). Android reads the
  accelerometer (Seismic-like detection, 13 m/s², 0.5 s window) and iOS uses the
  system shake gesture (UIWindow `motionEnded`), both through the
  `dev.durbun/shake` channel and only while the app is in the foreground.

- In-app inspector redesigned after the desktop UI: the same tokens (colors,
  level / method / status / JSON colors, FNV-1a tag hues), logo, top bar and
  status bar. Logs: live stream with pause, level toggles, quick filters, query
  language, merged repeats, request rows, tag actions. Network: table rows,
  method / status / slow / mocked chips, host picker, query and body search,
  General / Request / Response / Timing detail with a searchable JSON tree,
  code / hex views, cookies and query, phase bars, Replay and Copy as cURL /
  fetch / dio / Swift / Kotlin (ported from the desktop). Mocks, Performance
  (tiles and charts) and Device ("what is captured") tabs. Tested at 320 px,
  landscape, tablet and 2× text.

- In-app inspector: `MaterialApp(builder: DurbunInspector.builder)` adds a
  draggable bubble and a panel on the phone. The panel has network (dart:io,
  Dio, OkHttp, URLSession, with cURL, pretty JSON and image preview), logs,
  errors, performance and info tabs, and works without the desktop. It is fed
  by every outgoing SDK message (`DurbunClient.outgoingTap`), native-encoded
  lines included. The store is bounded (2,000 logs, 300 requests, 24 MB of
  bodies). Pending bodies are decoded only when viewed.
  `DurbunOptions.inspector` (default `true`) and `Durbun.showInspector()`.

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
