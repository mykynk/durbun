## Unreleased

- In-app panel: **Tools → Mac connection** says why the app is not connected
  and what to do next (Mac app not open, USB debugging, wrong address, local
  network connections off on the Mac, iOS Local Network permission), with the
  addresses tried. A debug build prints the same once in the console.
- The Mac's Wi-Fi address can be typed in the panel at run time: tried at
  once, kept for the next launches, *Use the build's address* goes back. The
  USB link stays in use.
- **Tools → App tools**: your `DurbunAction`s and the built-in Flutter,
  Android and iOS tools work from the panel, without the Mac.
- When the SDK has not started or is off in the build,
  `Durbun.showInspector()` opens a page that says why and what to do instead
  of nothing; a debug build says it in the console too.
- A one-time "Shake the phone to open the Dürbün panel" hint on the first
  launch (`DurbunInspector(showHint: false)` turns it off).
- `DurbunNavigatorObserver`: each screen change is sent as a `navigation`
  event (`{from, to}`, route names only), the same event the other Dürbün SDKs
  send. App lifecycle changes arrive as log lines with the tag `lifecycle`
  (`DurbunOptions(captureLifecycle: false)` turns them off).
- New `DurbunOptions.maxBodyBytes` (body limit until a desktop connects, at
  most 10 MB) and `DurbunOptions.captureBodies` (`false`: never capture
  bodies, whatever the desktop asks). The panel shows the body setting in use
  without a Mac too.
- Fewer connection attempts while no desktop answers: after two minutes they
  slow down to about one every 30 seconds, and none are made while the app is
  in the background. Returning to the app or entering an address tries at once.
- In-app panel: large bodies (256 KB or more) are prepared in the background
  instead of freezing the app; the JSON tree opens one level deep and the Code
  view shows the first 200 KB until **Show all**.
- In-app panel: **Previous run** is listed under Tools even while it is off,
  with what it does and the line that turns it on. It stays off by default
  because it writes captured traffic to the phone's storage.
- In-app panel: the Device & SDK page lists what is not captured (background
  isolates, `dart:developer` `log()`, clients with their own network stack,
  WebView, WebSocket messages and more) and why.
- In-app panel: the performance charts follow the screen's refresh rate (for
  example 120 FPS and 8.3 ms), as the janky frame count already did.
- In-app panel: in apps in other languages the panel uses English and is laid
  out left to right, also in right-to-left apps.
- README: the panel's layout (two tabs and Tools), the web (nothing captured)
  and desktop platforms are described as they work.
- In-app panel, new look: one type scale, the selected tab, segment and filter
  chip filled in the accent colour, and every text readable in light and dark
  (at least 4.5:1 contrast). Buttons, chips and segments are 44 pt to tap.
- Request rows are two lines: the status, the method and path with the time
  on the right, then the host, one badge (error kind, mock, GraphQL operation
  or client) and the size. A pending request counts up its time. Requests in
  the log stream use the same row.
- Log rows name the level as a word ("Error", "Warning") instead of a letter;
  a crash shows its crash badge.
- Request detail: the body's find bar opens from a search button next to the
  view menu, so the page keeps two bars over the body; *Expand all* and
  *Collapse all* are in the view menu.
- Performance and Statistics lead with one large figure (FPS, request count,
  median time); a chart with one line no longer repeats its title as a legend.
- Tools uses plain icons and readable values; empty lists show the Dürbün mark
  with one line of text; the setup snippets have a copy button in their corner.
- Landscape and tablets: the panel stops at 720 pt wide, centred, and the
  floating button stays inside the safe area on every side.
- The first-launch hint is shorter and closes with *Got it*.

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
