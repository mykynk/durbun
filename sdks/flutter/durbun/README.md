# Dürbün for Flutter (`durbun`)

Dürbün is a desktop tool that shows **all logs, errors and network traffic** of
an app in one live view while the device is plugged into your Mac (or the app
runs in a simulator or emulator). This package sends the data from inside the
app. It is a **Flutter plugin**: besides the Dart SDK it carries the native
Android (Kotlin) and iOS (Swift) layers, so a single install covers Flutter and
native code. You do not need a separate SDK per layer.

The Mac app and the SDKs for other platforms live in the
[Dürbün repository](https://github.com/mykynk/durbun#readme).

The package also ships an in-app inspector, so you can read everything on the
phone itself, with or without a Mac. The inspector UI is available in English
and Turkish and follows the app's (or the phone's) language.

- [Installation](#installation)
- [In-app inspector](#in-app-inspector-no-mac-needed)
- [Release, Firebase and store builds](#release-firebase-and-store-builds)
- [Where the data comes from](#where-the-data-comes-from)
- [Logs and events from code (Dart)](#logs-and-events-from-code-dart)
- [What the Dart side captures](#what-the-dart-side-captures)
- [USB or Wi-Fi](#usb-or-wi-fi)
- [Safety and security](#safety-and-security)
- [Options (`DurbunOptions`)](#options-durbunoptions)
- [Limitations](#limitations)
- [Pure Dart (without Flutter)](#pure-dart-without-flutter)
- [Development](#development)

## Installation

Two steps.

**1. Add the dependency**

```bash
flutter pub add durbun
```

or in `pubspec.yaml`:

```yaml
dependencies:
  durbun: ^0.1.0
```

To use the latest unreleased code, depend on the repository instead:

```yaml
dependencies:
  durbun:
    git:
      url: https://github.com/mykynk/durbun
      path: sdks/flutter/durbun
```

**2. Wrap `main` in `Durbun.run`**

```dart
import 'package:durbun/durbun.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized(); // call it inside the zone
    runApp(const MyApp());
  });
}
```

That is all. There is no native initialization code: when the Dart side runs, it
starts the Android and iOS layers itself, and when it is off, they stay off. A
native `Durbun.start()` call is not needed. If one is left in your code, it does
nothing in a Flutter app (it detects the plugin and leaves the work to the Dart
side). This way no separate native session is opened, and `DURBUN=false` keeps
the native layer off as well.

**Optional, one line on Android if your native code uses OkHttp:**

```kotlin
import dev.durbun.DurbunInterceptor

val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())   // <- this line
    .build()
```

While Dürbün is off (release builds), this interceptor passes requests through
untouched. On iOS, URLSession traffic (the shared session, your own sessions,
Alamofire, cupertino_http) is captured **automatically**; no extra line is
needed.

`Durbun.run` opens a zone, so it also captures `print` output and uncaught
errors. If you do not want a zone:

```dart
Future<void> main() async {
  await Durbun.init();
  runApp(const MyApp());
}
```

In that case only `debugPrint` is captured, and zone errors arrive through
`PlatformDispatcher.onError`. If you have your own `HttpOverrides.global`, assign
it **before** `Durbun.init()`: an override assigned later is chained within
about 2 seconds, and `HttpClient`s created in the meantime (for example the one
Dio caches on its first request) are not captured. Inside `Durbun.run` there is
no such gap: every `HttpClient` created in the zone asks the current global
override and is wrapped.

If `ensureInitialized()` was called **outside** the zone (for example before
`Durbun.run`, to run `await Firebase.initializeApp()`), `Durbun.run` does not
open a zone, to avoid Flutter's "Zone mismatch" error. It then behaves like
`init`: `print` is not captured (only `debugPrint`), and a note is printed to the
console once. To capture `print` as well, move everything, Firebase included,
into the body:

```dart
Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized();
    await Firebase.initializeApp();
    runApp(const MyApp());
  });
}
```

## In-app inspector (no Mac needed)

To see everything on the phone itself, add one line to `MaterialApp`. The same
line works for `MaterialApp.router` / go_router, `CupertinoApp` and
`WidgetsApp`:

```dart
MaterialApp(
  builder: DurbunInspector.builder,   // <- this line
  home: const HomePage(),
);
```

Nothing is drawn over your app. **Shake the phone** to open the panel (iOS
simulator: *Device → Shake*; Android emulator: *Extended controls → Virtual
sensors → Shake*). No Mac connection is required, so a tester can inspect the
app on their own phone. The panel carries the desktop's design (colors, level
and status colors, tag colors, light and dark theme) and its tabs:

- **Logs:** a live stream (newest at the bottom; it stops following when you
  scroll up and resumes with "↓ N new"), V D I W E level toggles, the quick
  filters *Errors only · Crashes · Network · Events · Flutter · Native*, the
  desktop's query language (`tag:auth -tag:frame level:warn is:crash`),
  consecutive identical lines merged into `×N`, and request rows inside the
  stream. The detail view shows the message, a collapsible data tree, a stack
  trace that highlights app frames, and "Only this tag" / hide-this-tag actions.
- **Network:** dart:io, `package:http`, Dio, OkHttp and URLSession in one table
  with status, method, path (query dimmed), start time (`HH:mm:ss`), host,
  source, size, duration (slow requests in yellow or red), GraphQL operation,
  mock and error labels (such as "could not resolve DNS"). It offers method and
  status toggles, the quick filters *Errors only · Slow ≥ 1 s · Mocked*, a host
  picker, queries such as `status:4xx method:post host:api is:slow`, and search
  inside bodies. The detail view has General / Request / Response / Timing
  tabs: a searchable JSON tree for bodies, Code and Hex views, image preview,
  headers, cookies and query parameters, DNS / connect / TLS / TTFB bars, and
  **Replay** and **Copy as** (cURL, fetch, Dart dio, Swift, Kotlin).
  **Share** turns a request into a report your team can read without Dürbün
  (URL, status, trace IDs, headers, bodies, cURL; secret values are masked as
  `••••` by default) and opens the system share sheet or copies the report. The
  desktop produces the same report. The **Sort** button (next to the search
  box) offers: newest on top (default), arrival order (newest at the bottom, the
  list follows new requests), slowest first, largest response first, and errors
  first. In a sorted list, rows you are reading stay in place while you scroll
  down; new requests wait on top behind "↑ N new".
- **Mocks:** the rules that come from the desktop and how many times each was
  applied. Rules last only as long as the connection, so on the phone the tab
  has content only while the desktop is connected.
- **Performance:** tiles for FPS, janky frames, build/raster time, memory, heap
  and CPU, plus charts for FPS, frame time and memory.
- **Device:** the app, the device, the captured layers (Dart / Kotlin / Swift),
  the desktop connection, and "What is captured?": whether each data source is
  on and, if not, why.
- **Statistics** (under Tools), in scrollable tabs: *Summary* (request count;
  successful, 4xx, 5xx, connection errors (timeouts included) and pending
  requests; methods), *Duration* (average, median (p50), p95, longest), *Data*
  (sizes of the bodies sent and received) and *Hosts* (the 10 hosts that
  received the most requests). Bodies are not decoded, and the page refreshes at
  most once a second. If the Network list is filtered, you can choose between
  *Listed* and *All*.
- **Export session** (under Tools): the requests in the Network list (with
  filters, search and sort order applied) or all of them, as a **Report (.md)**
  (a summary table plus every request in detail; for Slack, Jira, e-mail) or
  **HAR 1.2** (Chrome DevTools, Charles, Proxyman). Secret values are masked as
  `••••` with the same rules as Share; masking and bodies can each be turned
  off. The file is written in the background to the app's cache folder
  (`durbun-export`) and sent as a file through the system share sheet. Exports
  older than a day are deleted on the next export. If the share sheet cannot be
  opened, an export smaller than 512 KB is copied to the clipboard.
- **Previous run** (opt-in, off by default): with
  `DurbunInspector(keepPreviousRun: true, child: child!)`, requests (headers and
  the first 16 KB of each body) and logs are written, masked as in an export, to
  the app's cache folder (`durbun-run`) at most once a second; a crash is written
  immediately. On the next launch, Tools shows **Previous run**: the Network and
  Logs tabs of that run, read-only. If it crashed, this is stated at the top and
  the crash opens with one tap. Only the last run is kept (at most 2 × 4 MB).
  File errors never reach the app, startup is not delayed (the file is read when
  the page opens), and nothing is written on the web.

The panel shows the same messages the desktop receives. When the desktop is
connected, both work side by side. The app's own native logs (Android logcat,
iOS 15+ `os_log` / `Logger` / `NSLog`) appear in the panel even without a Mac
connection, and the host app needs no setup. The desktop reads these from the
device itself over USB, so lines are not delivered twice. The status bar at the
bottom shows the connection and the log, error and request counts.

Limits and settings:

- The phone keeps the last 2,000 log lines, 1,000 requests and 24 MB of bodies
  in total. When a limit is reached, the oldest entries are removed and the
  panel says so. If `defaultHosts` is set, requests to hosts hidden in the
  panel (and their bodies) are removed first. To change the limits:
  `DurbunInspector(maxRequests: 2000, maxLogs: 5000, maxBodyBytes: 48 << 20, child: child!)`.
- You can also open the panel from your own debug menu or a button with
  `Durbun.showInspector()`. Use `openOnShake: false` to turn shake detection
  off, or `showBubble: true` to show a small Dürbün button on screen.
- Shake detection works only while the app is in the foreground. On Android it
  reads the accelerometer (no permission needed); on iOS it uses the system's
  shake gesture (no permission needed).
- After updating the SDK, run `cd ios && pod install` once on iOS (CocoaPods
  must refresh the project when files are added to the plugin).
- To share an exported file on Android, the plugin's manifest adds a read-only
  `ContentProvider` named `${applicationId}.durbun.files`, which is not exported
  (androidx is not required). It serves only files in the `durbun-export`
  folder, through the one-time grant of the share intent.
- If you do not want anything stored on the phone, pass
  `DurbunOptions(inspector: false)`.
- To show only your own APIs in the panel, set default hosts:
  `DurbunInspector(defaultHosts: ['api.example.com', '*.example.com'], child: child!)`.
  Requests to other hosts (analytics, Firebase Storage, and so on) are still
  captured and still reach the desktop. In the panel they are hidden, the filter
  row says "N on other hosts", and they become visible once ticked under
  Network → Filters → Hosts. If the list is empty, all hosts are shown.
- **Find in body…** works in request and response bodies (preview and code),
  with a match count, previous/next buttons and scrolling to the match. When
  "Search bodies too" is on in the Network list, the search opens pre-filled
  after you enter a request.
- The panel opens as a single `/durbun` route on the app's navigator. Detail
  pages, sheets, menus and "Copied" toasts stay on the panel's own navigator and
  `ScaffoldMessenger`: the app's route observers (analytics, Sentry) see only
  `/durbun`, and the app's snack bars are left alone. The back button closes the
  page inside the panel first, then the panel. To use another navigator, pass
  `DurbunInspector(navigatorKey: ...)`.
- Filters, search, sort order and the last open tab are kept when the panel is
  closed and reopened. **Pause** on the Network list holds back new requests.
  In a list scrolled up, rows you are reading do not move even if old entries
  are evicted. *Clear captured data* asks for confirmation first. Shake
  detection is paused while the panel is open.
- In builds where Dürbün is off (`DURBUN=false`, or a release build without the
  define), the panel does not open and shaking is not listened to; the widget
  only draws the app.

## Release, Firebase and store builds

Each project decides whether a build runs Dürbün, store builds included. The SDK
does not look at where the app was installed from.

| Build | Dürbün |
|---|---|
| `flutter run` (debug), profile | **On**, automatically |
| Release | **Off.** No socket is opened, no hooks are installed, and the native layer is never started. The Dart code is almost entirely removed by the compiler's tree shaking |
| Release + `--dart-define=DURBUN=true` | **On**, wherever the build is installed from (Firebase, ad-hoc, TestFlight, Google Play, App Store, and so on) |
| `--dart-define=DURBUN=false` | Off in every mode (for example profile measurements) |
| `DurbunOptions(enabled: true/false)` | Overrides everything |

```bash
# Release with Dürbün on:
flutter build apk --release --dart-define=DURBUN=true
flutter build ipa --release --dart-define=DURBUN=true
# .ipa for Firebase App Distribution / ad-hoc distribution:
flutter build ipa --release --export-method ad-hoc --dart-define=DURBUN=true
# Release with Dürbün off (no define):
flutter build appbundle --release
flutter build ipa --release
```

- The same define works with `flutter build appbundle` and
  `flutter run --release`.
- iOS: Flutter writes defines to `ios/Flutter/Generated.xcconfig`, and an Xcode
  Archive uses that file. An Archive made in Xcode after a `flutter build` with
  `--dart-define=DURBUN=true` is built with `DURBUN=true` until the next
  `flutter build` without the define.
- If Firebase and the store receive the same binary, the define turns Dürbün on
  in every install of that binary. Even in a binary without the define, the
  desktop shows everything the device exposes (device logs, crash records,
  Android process and frame statistics) and explains why network traffic and
  mocks are not visible.
- To decide per flavor, add the define to that flavor's build command or write
  `DurbunOptions(enabled: appFlavor == 'qa')`.
- Android: with Dürbün on in release, the main manifest needs the `INTERNET`
  permission (every networked app already has it; the plugin does not add any
  permission itself).
- Size (Flutter 3.38 counter app that already includes another plugin, release
  build with DURBUN off): Android arm64 APK **+34 KB**; iOS `.app` **+868 KB**
  uncompressed / **+278 KB** zipped (`durbun.framework`; smaller once symbols
  are stripped for store distribution).

## Where the data comes from

Everything leaves the app over **one connection** and appears on the desktop as
a single app session (with an "SDK" badge). No proxy is involved, so SSL pinning
is left untouched.

| Source | What it sends | When |
|---|---|---|
| Dart SDK (this package) | Dart logs, `print`, Flutter errors, Dart crashes, dart:io HTTP (package:http, Dio's default adapter, `NetworkImage`), FPS/jank/memory, `flutter.*` tools | While Dürbün is on |
| Android native layer (in this plugin) | Kotlin/Java `Durbun.log`, uncaught Kotlin/Java crashes, OkHttp (with `DurbunInterceptor`), the app's own logcat (`Log.d` and so on; always in the panel, on the desktop only when adb is not available, for example over Wi-Fi), `android.dumpThreads` / `android.gc` tools | Once the Dart side starts it |
| iOS native layer (in this plugin) | URLSession traffic (automatic), Objective-C exceptions and Swift crashes, Swift `print`/stdout/stderr, `Durbun.log` (Swift), iOS 15+ `os_log` / `Logger` / `NSLog` (always in the panel, on the desktop only when it cannot read device logs, for example over Wi-Fi), `ios.*` tools | Once the Dart side starts it |
| No SDK (old builds, release builds with Dürbün off) | Device logs, system crash records, Android process and frame statistics; the desktop reads these from the device | Always |

Native crashes: on Android, a crash goes straight to the desktop at crash time;
if the desktop cannot be reached at that moment, it arrives on the next launch
as **"Previous launch crashed — …"**. On iOS, exceptions off the main thread
arrive immediately; main-thread exceptions and signal crashes (force unwrap,
EXC_BAD_ACCESS) arrive on the next launch as **"Crash in previous launch: …"**.

Logging from native code:

```kotlin
import dev.durbun.Durbun
Durbun.i("payment", "3DS completed", data = mapOf("orderId" to 42))
```

```swift
import durbun
Durbun.info("3DS completed", tag: "payment", data: ["orderId": 42])
```

## Logs and events from code (Dart)

```dart
Durbun.log('User signed in', tag: 'auth', data: {'userId': 42});
Durbun.d('Cache warmed up');            // v / d / i / w / e / f
Durbun.e('Payment failed', error: e, stackTrace: st);
Durbun.i({'cart': [1, 2, 3]});          // Map/List -> JSON (a tree on the desktop)
Durbun.event('purchase', {'amount': 49.9});
```

Connection state is available through `Durbun.isConnected`,
`Durbun.connectionState` and `Durbun.connection` (a stream). To add your own
button to the desktop, register an action (`DurbunAction.button`, `toggle` or
`select`):

```dart
Durbun.addAction(DurbunAction.button(
  id: 'app.clearCache',
  label: 'Clear cache',
  onPressed: (_) async => cache.clear(),
));
```

### If you already use a logging package

Packages that write with `print` are captured already. To keep levels and tags,
forward `package:logging` records directly:

```dart
Logger.root.level = Level.ALL;
Logger.root.onRecord.listen((r) => Durbun.log(
  r.message,
  tag: r.loggerName,
  error: r.error,
  stackTrace: r.stackTrace,
  level: r.level >= Level.SHOUT ? DurbunLogLevel.fatal
       : r.level >= Level.SEVERE ? DurbunLogLevel.error
       : r.level >= Level.WARNING ? DurbunLogLevel.warn
       : r.level >= Level.INFO ? DurbunLogLevel.info
       : r.level >= Level.FINE ? DurbunLogLevel.debug
       : DurbunLogLevel.verbose,
));
```

## What the Dart side captures

| Source | How | On the desktop |
|---|---|---|
| `Durbun.log/v/d/i/w/e/f` | Directly | Level, tag, `data` (JSON), error and stack trace |
| `print` / `debugPrint` | The zone (`run`) or a `debugPrint` hook (`init`) | An info log with the `flutter` tag, **only** when the desktop cannot see device logs (`capturePrint: auto`), so lines are not shown twice |
| `FlutterError.onError` | Chained, preserving the previous handler | `flutter-error`: the whole error box (`══╡ EXCEPTION CAUGHT BY …`) |
| Uncaught errors | Zone and `PlatformDispatcher.onError` | `crash` (fatal), with a stack trace; the error is also forwarded to the previous handler |
| HTTP (dart:io) | An `HttpOverrides.global` wrapper (a previous override is chained) | Request and response, headers, bodies (gzip decoded), timings, redirects (one entry per hop, as with URLSession), cancellations and errors. Includes `package:http`, Dio's default adapter, `NetworkImage` and WebSocket handshakes |
| Events | `Durbun.event` | An event line in the log stream |
| Metrics | `SchedulerBinding.addTimingsCallback`, `ProcessInfo.currentRss`, `getrusage` | FPS (while rendering), janky frames, average build/raster ms, memory MB, CPU %, threads (Android) |
| Commands | Desktop to app | `flutter.debugPaint`, `repaintRainbow`, `slowAnimations`, `performanceOverlay`, `invertOversizedImages`, `brightness`, `platform`, `dumpWidgetTree`, `dumpRenderTree`, plus your own `DurbunAction`s |

Mock rules (the **Mocks** tab on the desktop): `respond` returns a synthesized
response without touching the network (the response carries an `x-durbun-mock`
header); `delay` waits and then makes the real request; `fail` produces the
platform's natural error (`SocketException` "Connection refused" / "Failed host
lookup", `HandshakeException`, "timed out"; Dio recognizes the latter as
`connectionTimeout`).

## USB or Wi-Fi

- **Android (USB or emulator):** no setup. The desktop runs
  `adb reverse tcp:9751` and the SDK connects to `127.0.0.1:9751` (on emulators,
  `10.0.2.2` is the fallback).
- **iOS simulator:** no setup (the simulator uses the Mac's `127.0.0.1`).
- **iOS physical device (USB):** no setup. The SDK listens on one of the device's
  `127.0.0.1:9752–9755` ports, and the desktop connects through usbmux.
- **Wi-Fi:** provide the Mac's IP address with
  `DurbunOptions(host: '192.168.1.20')` or
  `flutter run --dart-define=DURBUN_HOST=192.168.1.20`.
  Turn on LAN access on the desktop (`durbun --lan`). On iOS 14+, add a local
  network usage description to `ios/Runner/Info.plist`:

  ```xml
  <key>NSLocalNetworkUsageDescription</key>
  <string>To connect to the Dürbün developer tool</string>
  ```

While there is no connection, the SDK buffers the last 5,000 messages, retries
with a backoff from 0.5 s to 3 s, and sends the buffered messages in order once
connected (a warning line reports how many overflowed). If no desktop has ever
connected, or none has been present for more than 30 seconds, the waiting
messages take up at most about 8 MB: past that, the oldest bodies are dropped
(request rows and logs stay, and the body is shown as truncated). The in-app
panel keeps its own copy and is not affected.

Without a desktop, requests do not wait. They wait for at most 0.8 s only when a
desktop has accepted the connection and the handshake is still in progress (mock
rules are on their way).

## Safety and security

- The defaults are in the table above. Dürbün is also off under `flutter test`
  (turn it on with `enabled: true`).
- The SDK never throws into the app; all internal errors are swallowed (the
  native layer included).
- JSON encoding, body base64/gzip work and socket I/O run in a background
  isolate. Queues are bounded (5,000 messages, about 48 MB; about 8 MB for bodies
  while no desktop is connected). Bodies are truncated at `maxBodyBytes`
  (default 1 MB, at most 10 MB), and gzip bodies also stop inflating at that
  limit. Messages from the native layer reach Dart in small batches through a
  bounded buffer.
- There is no native layer on the web or on desktop platforms; the Dart side
  still works.
- Hot restart: the native layer restarts with a new session.
- When a connection drops, the mock rules that connection sent are dropped at
  once in every layer (Dart, OkHttp, URLSession); the desktop sends them again
  when it reconnects. Requests made while there is no connection go to the real
  server.
- **Security note:** there is no pairing between the desktop and the SDK yet. A
  build with Dürbün on talks to whatever peer it meets on the device's loopback
  port (Android: it connects to `127.0.0.1:9751`; iOS device: it listens on
  `127.0.0.1:9752–9755`). That peer may be the desktop (through adb reverse or
  usbmux) or another app on the device. Logs and network traffic go to it, and
  the mock rules it sends apply for as long as it stays connected.

## Options (`DurbunOptions`)

| Option | Default | Description |
|---|---|---|
| `enabled` | `null` | `null`: on in debug/profile, in release only with `--dart-define=DURBUN=true`; `true`/`false` overrides everything |
| `host` / `port` | `null` / `9751` | Desktop address for Wi-Fi (`'ip'` or `'ip:port'`) |
| `captureNetwork` | `true` | dart:io HTTP capture and mocks (also turns URLSession capture on iOS and OkHttp capture on Android on or off) |
| `capturePrint` | `auto` | `auto` / `always` / `never` (`never` also turns off native stdout and logcat / `os_log` reading; they do not appear in the panel either) |
| `captureErrors` | `true` | Flutter errors and crashes (native crashes included) |
| `metrics` | `true` | FPS, jank, memory, CPU |
| `maxBufferedMessages` | `5000` | Number of messages kept while there is no connection |
| `redactHeaders` | `[]` | Headers whose values are hidden, for example `['authorization']`; applies to OkHttp and URLSession requests too, and the value shows as `••••` in every layer |
| `appId` / `appName` / `appVersion` | automatic | On Android the native layer now reads the version and build number; set these only to override |
| `waitForDesktop` | `0` | `run` waits this long before starting the app (so mocks apply to requests made at launch); when not set, requests do not wait for the desktop |
| `listenForUsb` | `true` | The usbmux listener on iOS devices |
| `useBackgroundIsolate` | `true` | Runs the transport layer in a background isolate |
| `inspector` | `true` | Keeps recent logs, requests and metrics on the phone for the in-app panel (`DurbunInspector`) |

## Limitations

- On Android, **cronet_http / Dio's `NativeAdapter`** use neither dart:io nor
  OkHttp. For Dio, add `DurbunDioInterceptor(dio: dio)` from the
  [`durbun_dio`](https://pub.dev/packages/durbun_dio) package as the **last** interceptor. On iOS these run on URLSession and are
  captured by the native layer (`DurbunDioInterceptor` does not report those
  requests a second time).
- **Not captured:** on Android, package:http's `CronetClient` and
  `package:ok_http` (it builds its own OkHttp client, so `DurbunInterceptor`
  cannot be added); on every platform, gRPC (`package:grpc` speaks HTTP/2 over
  its own sockets) and code that uses `Socket` directly. You can report these
  yourself with `DurbunNetwork.begin` (see the example below).
- For redirects that dart:io follows by itself, only the status code and the
  `location` header of the intermediate hops are known; mock rules do not apply
  to intermediate hops.
- Dart HTTP requests and logs in background isolates (`compute`,
  `Isolate.run`) are not captured (each isolate has its own `HttpOverrides`).
- `HttpClient`s created **before** `Durbun.run/init` are not wrapped.
- WebSocket: only the handshake (101) is visible, not the messages.
- `dart:developer` `log()` calls come not from the SDK but from the desktop's Dart
  VM Service connection (debug).
- FPS is reported only while frames are drawn (an idle app does not show "0 FPS").
- iOS `os_log` / `Logger` / `NSLog` lines are read from the app's own log store
  every few seconds (every second while the panel is open or the lines are going
  to the desktop). iOS does not keep `debug` entries in that store, so those
  lines do not appear in the panel; on iOS 13–14 this source does not exist.
  `com.apple.*` system lines are skipped.
- If a process has more than one Flutter engine, only the engine that starts the
  native layer first uses it.
- Native-only (non-Flutter) apps use the SDKs in `sdks/android` and `sdks/ios`.
  Do not add them to a Flutter app as well (the classes would clash).

### Reporting uncaptured clients manually

For package:http clients (for example `CronetClient`, `OkHttpClient`), a small
wrapper is enough. While Dürbün is off, `begin` returns null and nothing
happens. The wrapper reads the response body into memory once, so do not use it
for large downloads:

```dart
import 'package:durbun/durbun.dart';
import 'package:http/http.dart' as http;

class DurbunReportingClient extends http.BaseClient {
  DurbunReportingClient(this._inner, {this.source = 'cronet'});
  final http.Client _inner;
  final String source;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final call = DurbunNetwork.begin(
      method: request.method,
      url: request.url,
      headers: [for (final h in request.headers.entries) [h.key, h.value]],
      body: request is http.Request ? request.bodyBytes : null,
      contentType: request.headers['content-type'],
      source: source,
    );
    if (call == null) return _inner.send(request);
    try {
      final response = await _inner.send(request);
      final bytes = await response.stream.toBytes();
      call.response(
        status: response.statusCode,
        statusText: response.reasonPhrase,
        headers: [for (final h in response.headers.entries) [h.key, h.value]],
        body: bytes,
        contentType: response.headers['content-type'],
      );
      return http.StreamedResponse(
        http.ByteStream.fromBytes(bytes),
        response.statusCode,
        contentLength: bytes.length,
        request: response.request,
        headers: response.headers,
        isRedirect: response.isRedirect,
        persistentConnection: response.persistentConnection,
        reasonPhrase: response.reasonPhrase,
      );
    } catch (e) {
      call.error(e);
      rethrow;
    }
  }

  @override
  void close() => _inner.close();
}
```

For gRPC and other protocols, make the same `DurbunNetwork.begin` →
`call.response(...)` / `call.error(...)` calls in your own layer.

## Pure Dart (without Flutter)

`package:durbun/durbun_core.dart` (`DurbunClient.start(...)`) works as is in Dart
programs without Flutter; the plugin's native side is not involved for them.

## Development

```bash
flutter pub get --offline
flutter analyze
flutter test --concurrency=2
dart run tool/smoke.dart --dry-run      # end-to-end check without the desktop
dart run tool/smoke.dart                # against a running Dürbün desktop (127.0.0.1:9751)
dart run tool/smoke.dart --port 9751 --linger 60   # stays connected: try the smoke.* tools from the Device tab
dart run tool/sync_native.dart          # refreshes the copies after sdks/ios or sdks/android changed
```

During `--linger`, the smoke app sends metrics every second, and these tools
work from the desktop: `smoke.ping` (button), `smoke.verbose` (toggle),
`smoke.theme` (select) and `smoke.request` (makes one more request through the
SDK with `{path, method, body}`, for example to watch a rule in the Mocks tab
apply).

The native cores live in the package as exact copies, because pub.dev publishes
only this folder, and CocoaPods, Swift Package Manager and Gradle cannot build
files outside the plugin folder. The iOS core is in
`ios/durbun/Sources/durbun/Core`; the Android core is in `android/src/core`
(Kotlin + Java) and `android/core-rules.pro`. The originals are in
`sdks/ios/Sources/Durbun` and `sdks/android/durbun`; after changing them, run
`dart run tool/sync_native.dart`. `test/native_sync_test.dart` fails when a copy
is stale.

Example app: [`example/`](example/). (The example's iOS target is 15.0, because
Xcode 27 does not accept anything below iOS 15.)
