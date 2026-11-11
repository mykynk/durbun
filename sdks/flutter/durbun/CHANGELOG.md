## 0.2.0

- In-app panel: **Send to Slack** on the request and log Share sheets posts
  to your team's channel from the phone itself, without the desktop. The
  webhook comes from `DurbunOptions.slackWebhook` or
  `--dart-define=DURBUN_SLACK_WEBHOOK=…`; without one there is no Slack
  button. Keep the URL out of the repository: it is compiled into the build.
- Log lines can be shared through the system share sheet too.
- Works with Dürbün 0.2.0 on the Mac (Flows, shared packages, backups).

## 0.1.0

First public release.

- A Flutter plugin with native Android (Kotlin) and iOS (Swift) layers: one
  dependency covers Dart, Android and iOS code. Requires Flutter 3.27 /
  Dart 3.6 or newer.
- `Durbun.run` / `Durbun.init`; logs (`log`, `v`/`d`/`i`/`w`/`e`/`f`) with
  tags and structured data, events, `print` / `debugPrint` capture, Flutter
  errors and uncaught errors, native Android and iOS logs.
- HTTP capture for dart:io (`HttpClient`, `package:http`'s `IOClient`, Dio's
  default adapter, `Image.network`) with headers, bodies and timings, plus
  URLSession and OkHttp through the native layers. Dio's native adapters are
  covered by [`durbun_dio`](https://pub.dev/packages/durbun_dio).
- Mock rules from the Dürbün desktop app (`respond`, `delay`, `fail`),
  applied inside the app.
- Frame, memory and CPU metrics; desktop device commands and custom
  `DurbunAction` buttons.
- In-app inspector (`DurbunInspector`) that works without a Mac: network list
  and request details, logs, mocks, performance and device tabs, request
  comparison, find in bodies, session export and shareable reports. Opens by
  shaking the phone; English and Turkish.
- Transport on a background isolate: `127.0.0.1:9751` (adb reverse,
  simulators), a usbmux listener on iOS devices (`127.0.0.1:9752`–`9755`), an
  optional Wi-Fi host, reconnects with backoff and a bounded buffer.
- On in debug and profile builds; in release builds only with
  `--dart-define=DURBUN=true`. `DurbunOptions.enabled` overrides both.
- Pure-Dart core for non-Flutter programs: `package:durbun/durbun_core.dart`.
