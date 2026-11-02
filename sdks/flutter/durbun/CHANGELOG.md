## 0.1.0

- First version of the Dürbün Flutter SDK: `Durbun.run` / `Durbun.init`, app
  logs (`log`, `v/d/i/w/e/f`), events, print capture, Flutter errors and crashes,
  dart:io HTTP capture with bodies and mock rules, frame/memory/CPU metrics,
  `flutter.*` desktop commands and custom `DurbunAction`s.
- NDJSON transport on a background isolate: 127.0.0.1:9751 (adb reverse /
  simulators), optional Wi-Fi host, usbmux listener on iOS devices
  (127.0.0.1:9752–9755), reconnect with backoff and a 5 000-message buffer.
- Pure-Dart core (`package:durbun/durbun_core.dart`) and `tool/smoke.dart`.
