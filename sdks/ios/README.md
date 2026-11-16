# Dürbün iOS SDK

> **Flutter app?** Do not add this package separately. The Flutter package
> [`package:durbun`](../flutter/durbun/README.md) already carries this iOS core (URLSession, crashes,
> stdout/stderr) and starts it from Dart, so no `Durbun.start()` call is needed (in a Flutter app it does
> nothing). To log from Swift code, use `import durbun`. This page is for native-only iOS apps.

[What you get](#what-you-get) · [Install](#install) · [Start](#start) · [Connect to the Mac](#connect-to-the-mac) ·
[What is captured](#what-is-captured) · [Mocks](#mocks) · [Tools](#tools) ·
[Release builds and safety](#release-builds-and-safety) · [Options](#options) ·
[Troubleshooting](#troubleshooting) · [Development](#development)

## What you get

Swift package `Durbun` for iOS 13+ (macOS 11+ for the tests). It streams your app's logs, `print` output,
crashes, URLSession network traffic and performance metrics live to the Dürbün Mac app.

| What | How it shows up |
|---|---|
| `Durbun.log / debug / info / warning / error` | Structured log with level, tag, JSON `data`, error and call-site stack |
| `print`, `debugPrint`, `NSLog`, `printf`, stderr | Logs tagged `stdout` / `stderr`. Xcode's console **keeps working** (every byte is also written to the original output). Multi-line output (pretty JSON, `dump()`, stack traces) is grouped into one entry; levels are inferred from markers such as `[ERROR]`, `Warning:` and `❌`; NSLog's date/process prefix is stripped |
| Crashes | Uncaught Objective-C exceptions **immediately** (`kind: crash`). Swift runtime traps (force-unwrapping `nil`, index out of range, `fatalError`), EXC_BAD_ACCESS and other fatal signals **on the next launch**, with the last console lines ("Fatal error: …") and a backtrace |
| Earlier launches (MetricKit) | What iOS reports later: watchdog kills (0x8badf00d), main-thread hangs, CPU and disk-write exceptions, slow launches (see [Earlier launches](#earlier-launches-metrickit)) |
| Network | `URLSession.shared` **and** your own sessions (Alamofire included): headers, bodies, redirects, timings (DNS/TCP/TLS/wait/receive), protocol (h2/h3), errors and cancellations; `URLSessionWebSocketTask` messages and Server-Sent Events (see [WebSockets and Server-Sent Events](#websockets-and-server-sent-events)) |
| Web views | `DurbunWebView.attach(to: configuration)`: the page's `fetch` / `XMLHttpRequest` calls and `console` lines (see [Web views](#web-views)) |
| Mocks | Rules defined in the Mac app: synthesized responses, latency, natural failures (timeout, connection, DNS, TLS) |
| Performance | CPU (%), memory (phys_footprint, the number Xcode shows), thread count, FPS and janky frames (CADisplayLink), launch time |
| Events | `Durbun.event("purchase", ["amount": 49.9])` |
| App tools | From the Mac app's Device tab: light/dark appearance, slow animations, view hierarchy dump, UserDefaults dump, plus your own tools via `registerAction` |

## Install

**Swift Package Manager:** in Xcode, choose **File → Add Package Dependencies…**, enter
`https://github.com/mykynk/durbun`, and add the **Durbun** product to your app target. In a `Package.swift`:

```swift
.package(url: "https://github.com/mykynk/durbun", from: "0.3.0"),
// in the target:
.product(name: "Durbun", package: "durbun"),
```

**CocoaPods:**

```ruby
pod 'Durbun', '~> 0.3.0'
# Optional: link it into the Debug configuration only, so Release builds contain no Dürbün code.
# In that case `import Durbun` and every call must be inside `#if DEBUG`, or the Release build does not compile.
# pod 'Durbun', '~> 0.3.0', :configurations => ['Debug']
```

The pod needs iOS 15 or macOS 12, the oldest targets Xcode 27 builds. For iOS 13 and 14, use Swift Package
Manager or point the Podfile at the repository tag:
`pod 'Durbun', :git => 'https://github.com/mykynk/durbun.git', :tag => 'v0.3.0'`.

With SwiftPM the package is linked into every configuration; in a build that is not a development build, the
SDK does nothing by itself (see [Which builds run Dürbün](#which-builds-run-dürbün)). The package ships a privacy
manifest (`PrivacyInfo.xcprivacy`, reason `CA92.1` for the UserDefaults dump).

Upgrading: [Versions and upgrades](../../docs/guides/versions.md). To try changes that are not released yet, see
[Unreleased changes from a clone](#unreleased-changes-from-a-clone).

## Start

Call it as early as possible; sessions created **after** `start()` are captured:

```swift
import Durbun

// SwiftUI
@main
struct MyApp: App {
    init() {
        #if DEBUG
        Durbun.start()                                        // simulator and USB: nothing to configure
        // Durbun.start(options: .init(host: "192.168.1.20"))  // Wi-Fi
        #endif
    }
    var body: some Scene { WindowGroup { ContentView() } }
}

// UIKit: the same lines go in application(_:didFinishLaunchingWithOptions:).
```

### Objective-C

The same SDK is available to Objective-C code as `DURDurbun`:

```objc
@import Durbun;

[DURDurbun start];                                   // or [DURDurbun startWithHost:@"192.168.1.20"]
[DURDurbun info:@"Logged in" tag:@"auth"];
[DURDurbun log:@"Cache miss" level:@"debug" tag:@"cache" data:@{@"key": key}];
[DURDurbun error:@"Payment failed" tag:@"payment" error:error];
[DURDurbun event:@"purchase" properties:@{@"amount": @49.9}];
[DURDurbun addButtonWithId:@"app.logout" label:@"Log out" handler:^{ [session logout]; }];
[DURDurbun addToggleWithId:@"app.staging" label:@"Staging API" initialValue:NO handler:^(BOOL on) { useStaging = on; }];
```

`isRunning`, `isConnected`, `connectionStatusDescription`, `setDesktopHost:`, `stop` and `removeActionWithId:`
are there too. Options other than the host are set from Swift (`DurbunOptions`).

## Connect to the Mac

| Setup | What to do |
|---|---|
| **iPhone/iPad over USB** | Nothing. The SDK listens on the first free port in `127.0.0.1:9752…9755` on the device, and the Mac app connects through usbmux. Only loopback is listened on, so nobody on the network can connect and no Local Network permission is needed. |
| **Simulator** | Nothing. The SDK connects to `127.0.0.1:9751`; `SIMULATOR_UDID` lets the Mac app match the right simulator. |
| **Wi-Fi** | Give the app the Mac's IP address in one of the [ways below](#giving-the-app-the-macs-address). Add `NSLocalNetworkUsageDescription` to Info.plist (iOS asks for permission on the first connection) and in the Mac app turn on Settings → Connection → "Allow local network (Wi-Fi) connections" (when you run the server from the repository instead, start it with `node dist/durbun.mjs --lan`). |

If the connection drops, the SDK retries forever with a 0.5 s to 3 s backoff. Meanwhile it keeps the last
5,000 messages in memory and sends them in order once connected (a single warning line is added if some had to
be dropped). Whichever path completes the `hello` → `welcome` handshake first is used; the others are closed.
If the app does not show up, see [Not connecting?](#not-connecting).

### Giving the app the Mac's address

The Mac's address changes with the network, so it does not have to be built into the app. From the first that
is set to the last:

| Way | Who uses it | Rebuild? |
|---|---|---|
| `Durbun.setDesktopHost("192.168.1.20")` | The app's own debug menu, or a link the app opens (TestFlight and ad hoc builds too) | No |
| Launch argument `-DurbunHost 192.168.1.20` | Xcode (Edit Scheme → Run → Arguments), `xcrun devicectl device process launch … -- -DurbunHost 192.168.1.20`, UI tests and test runners that pass launch arguments | No |
| `DurbunOptions(host: "192.168.1.20")` | Code | Yes |
| `DURBUN_HOST` environment variable | Xcode scheme (only when the app is started from Xcode) | No |
| `DurbunHost` key in Info.plist, e.g. `$(DURBUN_HOST)` | A build setting per configuration, or CI | Yes |

- The first two are **kept for the next launches** (in the app's UserDefaults, key `dev.durbun.desktopHost`), so
  the address survives opening the app from the home screen. `Durbun.setDesktopHost(nil)` (or an empty
  `-DurbunHost ""`) goes back to the address built into the app.
- A new address is tried at once; a connection through the old Wi-Fi address is closed, a USB connection stays.
- `host:port` is accepted (`192.168.1.20:9751`); `setDesktopHost` returns `false` for anything that is not a host
  name or IP address.
- In the app's debug menu, a text field is enough:

  ```swift
  if !Durbun.setDesktopHost(addressField.text) { showError("Not an IP address") }
  statusLabel.text = Durbun.connectionStatus.description
  ```

  An app that already handles links can pass a value on, for example in SwiftUI
  `.onOpenURL { url in if let host = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "durbunHost" })?.value { Durbun.setDesktopHost(host) } }`
  for `myapp://debug?durbunHost=192.168.1.20`.

## What is captured

### Network

`URLSession.shared` and every session created **after** `start()` are captured, Alamofire included. Network
requests are forwarded untouched (tee); timeouts and certificate validation (pinning) are still enforced by your
own session.

- **Background URLSessions** (`.background(withIdentifier:)`) run out of process and cannot be intercepted.
- URLProtocol cannot report **upload progress**: `didSendBodyData` is not called for intercepted upload tasks.
  So upload tasks (`uploadTask(with:from:)`, `uploadTask(with:fromFile:)`) are left alone by default: they work
  as without Dürbün but are not shown or mocked. `interceptUploadTasks: true` captures them too, when your UI does
  not depend on upload progress. Data tasks with a body (`httpBody`, `httpBodyStream`) are always captured.
- An intercepted request is performed with a copy of the configuration of the session that started it: the same
  `URLCache` (or none), cookie and credential storage, proxy, TLS limits, `waitsForConnectivity`,
  cellular / expensive / constrained network rules and connection limits. This holds for sessions created after
  `start()`; `URLSession.shared` uses the default configuration. Sessions that differ only in
  `httpAdditionalHeaders` (a new token after each login) share one binding. In an app that creates more than
  32 configurations that differ in other settings, later ones are not captured (they behave as if Dürbün were
  absent) and the Mac app shows one warning line saying so.
- Stream (`httpBodyStream`) and file/data upload bodies are held in memory only up to the capture limit plus
  256 KB (at least 1.25 MB); larger ones are streamed through. A streamed body cannot be rewound: a 307/308
  redirect or an authentication retry that has to resend it fails for that request. Smaller bodies and
  `httpBody` are resent as usual.
- WKWebView and AVPlayer traffic does not go through URLSession protocols. A web view page's own calls can be
  reported with [`DurbunWebView`](#web-views).
- `redactHeaders` masks header values as `••••`; `ignoredHosts` leaves hosts (and their subdomains) out.

#### WebSockets and Server-Sent Events

When the Mac app asks for them (it does by default), each `URLSessionWebSocketTask` and each
`text/event-stream` response is one entry in the Network tab with its messages, in the order the app saw them:

| Stack | Captured without code changes |
|---|---|
| `URLSessionWebSocketTask` (iOS 13+), completion handlers and `async` `send` / `receive` | Handshake (request headers, the 101 and its headers, the subprotocol), every text and binary message both ways, `sendPing` and its pong, the close frame from either side with code and reason, failures and `cancel()` |
| Server-Sent Events over URLSession: a delegate's `didReceive data`, `bytes(for:)` / `bytes(from:)`, libraries built on them | The response as soon as its first bytes arrive, then one row per event (`event`, `id`, `retry`, the `data` lines); the normal end, a broken stream and cancelling the reader |
| Starscream (its own engine), SocketRocket, Socket.IO, anything on raw sockets or Network.framework | Not captured: they do not use URLSession. Starscream with `useCustomEngine: false` runs on `URLSessionWebSocketTask` and is captured |

- The messages are a copy: nothing is consumed, reordered or delayed, and the app's blocks run on their usual
  threads. Payloads are cut at the Mac app's limit (64 KB by default; sizes are always exact); with
  `captureBodies: false` only sizes are sent.
- An event stream's data is never kept as a response body. Comments (`:` lines) are not shown.
- Only what URLSession shows is reported: pings the server sends and their automatic answers are not, and URLSession
  reads a pong only while a `receive` is pending. When the app closes a socket, the server's answering close frame
  is not shown separately.
- Sockets opened before the Mac app asked for messages appear when it does, with their real handshake times and the
  messages from then on; a stream that was shown is always ended.
- To find the task class it hooks, the SDK creates one WebSocket task at start and never resumes it.

#### Web views

A `WKWebView` loads pages outside URLSession, so the network capture above never sees them. `DurbunWebView`
adds a small script to the page instead: its `fetch` and `XMLHttpRequest` calls (method, URL, status, headers,
bodies, timings) appear in the Network tab as client `webview:fetch` / `webview:xhr`, and its `console.*` lines
and uncaught errors in the log stream with the tag `webview`.

```swift
let configuration = WKWebViewConfiguration()
DurbunWebView.attach(to: configuration)          // before the web view is created
let webView = WKWebView(frame: .zero, configuration: configuration)
```

- The script runs at document start in every frame, before the page's own scripts. For a web view that already
  exists, `DurbunWebView.attach(webView)` covers the pages it loads from then on.
- The page sees no difference: the originals run with the same arguments and return the same results, bodies
  are read from copies, and the script's own errors are swallowed. Bodies are cut at 64 KB in the page and
  then follow the SDK's capture settings; `ignoredHosts` and `redactHeaders` apply.
- The script reports through one script message handler, which the page can post to as well: an entry from a
  web view is whatever the page claims. Messages are limited in size and rate; when a page sends too many, the
  Mac app shows one line saying how many were dropped.
- Not captured: the page's WebSocket and EventSource connections, `navigator.sendBeacon`, and what the page
  loads itself (documents, images, scripts, styles).
- Call it on the main thread. Nothing happens while Dürbün is not running: `attach` returns false and the
  configuration is not touched.

### Logs and events

```swift
Durbun.log("Logged in", level: .info, tag: "auth", data: ["userId": 42])
Durbun.debug("Read from cache", tag: "cache")
Durbun.warning("Slow response", tag: "api", data: ["ms": 2300])
Durbun.error("Payment failed", error: error, tag: "payment")
Durbun.event("purchase", ["amount": 49.9, "currency": "USD"])
```

`data` can be a dictionary, an array, an `Encodable` or any other value (converted to JSON on a best-effort
basis).

The Mac app reads `os_log` / `Logger` / `NSLog` messages from device logs (simulator, USB). When it cannot
(Wi-Fi, no `idevicesyslog`), the SDK on iOS 15+ reads the app's own log store once a second and sends the
entries; iOS does not keep `debug` entries, and `com.apple.*` lines are skipped. `captureOSLog: false` (or
`captureStdout: false` without `captureOSLog`) turns this off.

### Crashes

Uncaught Objective-C exceptions arrive **immediately**. Swift runtime traps, EXC_BAD_ACCESS and other fatal
signals arrive **on the next launch**, with the last console lines and a backtrace. `captureCrashes: false`
turns this off.

#### Earlier launches (MetricKit)

Some endings leave the app no chance to report, and some problems are only measured by iOS. On iOS 14 and newer
the SDK subscribes to MetricKit's diagnostics and sends them once the Mac app is connected:

| Diagnostic | Line in the Mac app |
|---|---|
| Crash the SDK could not catch (watchdog 0x8badf00d, a launch failure) | Crash row with the termination reason and the (unsymbolicated) stack |
| Main-thread hang | Warning "The main thread hung for 3.2 s in an earlier launch" with the stack |
| CPU or disk-write exception | Warning with the CPU time or the written megabytes |
| Slow launch (iOS 16+) | Warning with the launch time |

- iOS decides when to deliver them: usually at the next launch on iOS 15 and newer, at most once a day on iOS 14,
  and never in the simulator. Each diagnostic is sent once.
- Crashes the SDK's own handlers already reported ("Crash in previous launch: …") are not sent again. Over USB
  the Mac app reads the device's crash logs itself, so crash diagnostics are left out there.
- Stacks are addresses and offsets per binary (MetricKit does not symbolicate); the full tree is in the line's
  data (`callStackTree`) for symbolication with the build's dSYM.
- Out of reach: memory (jetsam) kills and other terminations iOS only counts (MetricKit gives daily totals,
  not single events), and live hang reports while the app runs (a hang arrives on a later launch).
- `captureCrashes: false` turns this off too.

### Performance

CPU (%), memory (phys_footprint, the number Xcode shows), thread count, FPS and janky frames, sampled only while
connected, and the launch time. FPS / janky frames and the launch time are iOS-only (there is no CADisplayLink on
macOS). `collectMetrics: false` turns them off.

| Number | What it means |
|---|---|
| `cpu` / `threads` | CPU of all the app's threads, in percent of one core (can pass 100) / thread count |
| `memoryMB` | phys_footprint, the number Xcode's memory gauge shows |
| `fps` / `jankyFrames` | Display refreshes the main run loop kept up with (a `CADisplayLink`), and refreshes that came more than 1.5 intervals late. They show a blocked main thread, not what was drawn: an idle screen reads near the display's rate |
| Event `durbun.launch` | Cold start, once per process: `ms` from the process start (the kernel's start time) to the first display refresh after the app became active, with `kind: "cold"` and `screen` (the key window's root view controller) |

Limits of the launch time:

- iOS 15+ may prewarm an app: start its process ahead of the tap and finish the launch later. Then the process
  start says nothing about the wait, so the event has `kind: "prewarmed"` and no `ms` (iOS sets `ActivePrewarm=1`
  in such a process).
- Nothing is sent when the app was launched in the background (a push, a background fetch) or went to the
  background before its first frame, when Dürbün started more than 10 s after the process, or when the first frame
  took more than 30 s. Warm starts (back from the background) are not reported.
- The time includes the dynamic loader and static initializers before `main`. Debug builds launch slower than
  release builds and a debugger slows them more: compare launches of the same build with each other.

## Mocks

Rules are defined in the Mac app (the Mocks tab; see the [mock rules guide](../../docs/guides/mocks.md)) and
pushed to the SDK live. Matching is identical to
`mockRuleMatches` in the protocol package; the tests verify it with more than 2,700 cases generated from the
TypeScript reference. Mocked requests are marked `mocked` in the Mac app.

| Action | What the app sees |
|---|---|
| `respond` | A synthesized response that never touches the network (status, headers, utf8/base64 body, optional delay). For a JSON body without `Content-Type`, `application/json` is added |
| `delay` | The real request, after waiting the given time |
| `fail` | `timeout` → `URLError.timedOut`, `connection` → `.cannotConnectToHost`, `dns` → `.cannotFindHost`, `tls` → `.secureConnectionFailed`, `custom` → `.unknown` (with your message) |

- `regex` mock rules use NSRegularExpression (ICU). For typical URL patterns it behaves the same as
  JavaScript; only exotic JavaScript-specific syntax may differ.
- A rule can be limited to one GraphQL operation (name, and optionally query / mutation / subscription). The
  operation is read from a JSON body (`operationName`, else the first operation of `query`; batched arrays too),
  an `application/graphql` body, or the URL of a GET request; the shared test vectors of the protocol package
  check it. The body is the one the SDK already buffers for capture: a body too large to buffer (a long
  `httpBodyStream` or file upload), one over 192 KB, or one that is not UTF-8 cannot be read, and such a rule then
  does not match (the request goes to the network, or to the next rule). Upload tasks are not intercepted by
  default, so they are not mocked either (see `interceptUploadTasks`).
- When the connection drops, the mock rules that connection pushed are removed at once; the Mac app sends them
  again when it reconnects.

## Tools

Built in, under App tools in the Mac app's Device tab: light/dark appearance, slow animations, view hierarchy
dump and UserDefaults dump. Add your own:

```swift
// Your own tool in the Mac app's Device tab (runs on the main thread):
Durbun.registerAction(DurbunAction(id: "app.clearCache", label: "Clear image cache")) { _ in
    ImageCache.shared.removeAll()
    return nil
}
Durbun.registerAction(DurbunAction(id: "app.mockLogin", label: "Mock login", kind: .toggle(false))) { params in
    FeatureFlags.mockLogin = params["value"] as? Bool ?? false
    return nil
}
```

## Release builds and safety

### Which builds run Dürbün

- With `Durbun.start()` inside `#if DEBUG`, release builds never start the SDK.
- Without `#if DEBUG`, the SDK decides by itself and runs in **development builds** only: the package was
  compiled with `DEBUG`, or the app runs in the Simulator, under a debugger, or is signed for development
  (`get-task-allow` in its provisioning profile, which Xcode's Run and Profile builds have). So a custom
  configuration such as `Debug-Staging` works even when Xcode compiles the package without `DEBUG`. Ad hoc,
  enterprise, TestFlight and App Store builds are not development builds.
- The signing check reads the embedded provisioning profile off the main thread. In that one case (a device build
  without `DEBUG`, started from the home screen) the SDK starts a moment after `Durbun.start()`, from a
  background queue.
- Per build configuration, the `DurbunEnabled` Info.plist key decides instead: `YES` runs Dürbün in that build
  (whatever its signing), `NO` keeps it off (even with `DEBUG`). Feed it from a build setting, for example
  `<key>DurbunEnabled</key><string>$(DURBUN_ENABLED)</string>` with `DURBUN_ENABLED = YES` for Staging only; an
  empty or undefined setting is ignored.
- `allowInReleaseBuilds: true` in code runs it in every build. With it, or with `DurbunEnabled = YES`, it runs
  wherever the app was installed from (Xcode, ad-hoc, TestFlight, App Store). Each project decides which builds
  run Dürbün.
- The `DURBUN_DISABLED=1` environment variable turns the SDK off completely; it is also off inside SwiftUI
  previews (Xcode Previews).

### Test builds (TestFlight, ad hoc, Firebase App Distribution)

Builds for testers are usually archived with a Release-based configuration, where `DEBUG` is not set, so the
SDK stays off. To run Dürbün in such builds only:

1. In the project's **Info → Configurations**, duplicate Release as, for example, **Staging**.
2. In the app target's Build Settings, add `DURBUN` to **Active Compilation Conditions**
   (`SWIFT_ACTIVE_COMPILATION_CONDITIONS`) for Staging only.
3. Start the SDK under that condition and allow it outside `DEBUG` (or, instead of the option, set
   `DurbunEnabled = YES` in Info.plist for Staging, see [Which builds run Dürbün](#which-builds-run-dürbün)):

   ```swift
   #if DEBUG || DURBUN
   import Durbun
   #endif

   // at launch:
   #if DEBUG || DURBUN
   Durbun.start(options: DurbunOptions(allowInReleaseBuilds: true))
   #endif
   ```

4. Archive with a scheme whose **Archive** action uses Staging (Edit Scheme → Archive → Build Configuration),
   then distribute it through TestFlight, ad hoc or Firebase App Distribution as usual.

- `allowInReleaseBuilds` (or `DurbunEnabled`) is needed because an archived Staging build is neither compiled
  with `DEBUG` nor signed for development; the app target's own compilation conditions do not reach the package.
- With CocoaPods, link the pod only where it runs:
  `pod 'Durbun', :configurations => ['Debug', 'Staging']` (with a version requirement as in
  [Install](#install)). A custom configuration also needs a mapping at the top of the Podfile, for
  example `project 'MyApp', 'Staging' => :release`.
- Over USB nothing else is needed: the SDK listens on the device's loopback and the Mac connects through
  usbmux, whatever the app was installed from. Wi-Fi needs `host` and `NSLocalNetworkUsageDescription`, as in
  [Connect to the Mac](#connect-to-the-mac); the address can be
  [given without a rebuild](#giving-the-app-the-macs-address).
- When it stays off, the SDK writes `Dürbün is off in this build: …` with the reason and both switches to
  Xcode's console and the unified log (subsystem `dev.durbun.sdk`).

The [test builds guide](../../docs/guides/qa-builds.md) covers Flutter, Android and React Native as well.

### Safety and security

- All I/O runs on background queues with bounded buffers, and the SDK swallows its own errors and never
  crashes the app. Network requests are forwarded untouched (tee); timeouts and certificate validation
  (pinning) are still enforced by your own session.
- When the connection drops, the mock rules that connection pushed are removed at once; the Mac app sends them
  again when it reconnects.
- Security note: the link has no pairing yet. On a physical device, a build with Dürbün enabled listens on one
  of the ports `127.0.0.1:9752–9755` and talks to whatever connects there: the Mac app (through usbmux) or
  another app on the device. Logs and network traffic go to that peer, and the mock rules it pushes apply while
  it stays connected. See [Security](../../README.md#security).

## Options

`DurbunOptions`:

| Field | Default | Description |
|---|---|---|
| `host` | `nil` (`DURBUN_HOST`) | The Mac's IP address for Wi-Fi (see [Giving the app the Mac's address](#giving-the-app-the-macs-address)) |
| `port` | `9751` | Simulator / Wi-Fi port |
| `devicePorts` | `9752...9755` | USB listener ports on a physical device |
| `enabled` | `true` | If `false`, `start` does nothing |
| `captureStdout` | `true` | Capture `print` / stdout / stderr |
| `captureOSLog` | `nil` (same as `captureStdout`) | Forward the app's own `os_log` / `Logger` / `NSLog` lines when the Mac app cannot read device logs (Wi-Fi) |
| `captureNetwork` | `true` | Capture URLSession traffic and apply mocks |
| `captureCrashes` | `true` | Exception and signal (crash) reports, and MetricKit diagnostics of earlier launches |
| `collectMetrics` | `true` | CPU / memory / FPS samples (only while connected) and the launch time |
| `interceptUploadTasks` | `false` | Also intercept upload tasks (shown and mocked, but `didSendBodyData` progress callbacks stop); with `false` they run untouched |
| `ignoredHosts` | `[]` | Domains that are never captured (subdomains included) |
| `redactHeaders` | `[]` | Header names (case-insensitive) masked as `••••`, e.g. `["Authorization", "Cookie"]`; the real request is unchanged |
| `captureBodies` | `nil` | Overrides the Mac app's setting (`false` records sizes only) |
| `maxBodyBytes` | `nil` | Capture limit per body, at most 8 MB (the Mac app's default is 1 MB) |
| `appName` | `nil` | Name shown in the Mac app (default: the bundle's display name) |
| `maxBufferedMessages` | `5000` | Messages kept while disconnected |
| `allowInReleaseBuilds` | `false` | Run in every build, also those that are not development builds (see [Which builds run Dürbün](#which-builds-run-dürbün)) |

### Same option, other names

The SDKs share their options; where a name differs, this table maps it:

| What | Flutter | Android | iOS | React Native / JS |
|---|---|---|---|---|
| Run in release builds | `--dart-define=DURBUN=true` or `enabled: true` | `forceInRelease` | `allowInReleaseBuilds` (or the `DurbunEnabled` Info.plist key) | `enabled: true` |
| Performance metrics | `metrics` | `captureMetrics` | `collectMetrics` | `captureMetrics` |
| Crashes | `captureErrors` | `captureCrashes` | `captureCrashes` | `captureErrors` |
| `print` / stdout / console | `capturePrint` | none | `captureStdout` | `captureConsole` |
| The app's own logcat / `os_log` lines when the Mac app cannot read device logs | `capturePrint` (`never` turns them off) | `captureLogcat` | `captureOSLog` | none |
| Hosts never captured | none | `ignoredHosts` | `ignoredHosts` | `ignoreUrls` |
| Is the SDK running? | `Durbun.isEnabled` | `Durbun.isStarted` | `Durbun.isRunning` | `Durbun.isStarted` |
| Add your own tool | `Durbun.addAction(...)` | `Durbun.addAction(...)` | `Durbun.registerAction(...)` | `Durbun.addAction(...)` |
| Set the Mac's address without a rebuild | In-app panel: Tools → Mac connection | `Durbun.setDesktopHost(context, ...)` | `Durbun.setDesktopHost(...)` | none |
| Wait for mock rules at launch | `waitForDesktop` (a `Duration`) | none | none | `waitForDesktop` (milliseconds) |

## Troubleshooting

### Not connecting?

About 10 seconds after start, when the Mac app has not connected yet, the SDK writes **one** line to Xcode's
console (and Console.app, subsystem `dev.durbun.sdk`): what it tried, the likely reason and the next step. The
same is available in code:

```swift
let status = Durbun.connectionStatus   // isConnected, via, desktopHost, issue, hint, failedAttempts
NotificationCenter.default.addObserver(forName: Durbun.connectionStatusDidChangeNotification, object: nil, queue: .main) { _ in
    statusLabel.text = Durbun.connectionStatus.description
}
```

| `issue` | Likely reason | Next step |
|---|---|---|
| `iosUsbWaiting` | iPhone without a Wi-Fi address: the Mac has not connected over the cable yet | Open the Dürbün Mac app with the iPhone on the cable (and trusted), or set a Wi-Fi address |
| `desktopNotRunning` | Simulator: nothing listens on the Mac's port | Open the Dürbün Mac app (or check its SDK port) |
| `lanRefused` | The Mac does not accept Wi-Fi connections | Settings → Connection → "Allow local network (Wi-Fi) connections" |
| `lanTimeout` | No answer from the address | Check the address, the Wi-Fi network and the Mac's firewall |
| `lanUnreachable` | Another network, or Local Network access is off | Join the Mac's Wi-Fi; Settings → Privacy & Security → Local Network; `NSLocalNetworkUsageDescription` |
| `lanBadAddress` | The address cannot be resolved | Use the Mac's IP address |
| `permissionDenied` | iOS did not allow the connection (Local Network) | Allow Local Network access for the app |
| `notDurbun` | Another program answered on the port | Check the port and the Dürbün version |

The other Dürbün SDKs use the same table and words.

### More help

More symptoms and fixes, for every platform: [Troubleshooting](../../docs/guides/troubleshooting.md). Which SDK
version works with which Mac app: [Versions and upgrades](../../docs/guides/versions.md).

## Development

```bash
cd sdks/ios
swift build -j 2
swift test -j 2
xcodebuild -scheme Durbun -destination 'generic/platform=iOS Simulator' -quiet build
node scripts/generate-mock-vectors.mjs   # regenerates the mock-matching test cases from the TypeScript reference
```

The Flutter plugin carries an exact copy of these sources: after changing them, run
`dart run tool/sync_native.dart` in `sdks/flutter/durbun`.

The web view script is written once, in `sdks/js/webview/bridge.ts`, with its tests in `sdks/js`.
`DurbunWebView` embeds a generated copy (`Sources/Durbun/WebView/WebViewBridgeScript.swift`); after changing the
script, run `npm run webview:generate -w @durbun/react-native` from the repository root (`webview:check` fails
when a copy is out of date).

### API reference

The package has a DocC catalog (`Sources/Durbun/Durbun.docc`) with articles on setup, network capture,
WebSockets and event streams, logs, app tools, options, web views and what is not captured. In Xcode choose
**Product → Build Documentation**, or from the command line:

```bash
xcodebuild docbuild -scheme Durbun -destination 'generic/platform=iOS Simulator' -derivedDataPath .build/docs
```

### Example app

`Example/DurbunExample.xcodeproj` is a small SwiftUI app that shows each part of the SDK: URLSession calls
(success, 404, slow, failing), a WebSocket, a Server-Sent Events stream, a log line at each level, an event,
crashes, app tools and a web view page with `DurbunWebView`. It talks to a tiny server it runs itself on
127.0.0.1, so it needs no network, and it uses this folder's package by path. Open it in Xcode and run it on a
simulator; for a device, choose your own team under Signing. From the command line:

```bash
cd sdks/ios/Example
xcodebuild -project DurbunExample.xcodeproj -scheme DurbunExample -destination 'generic/platform=iOS Simulator' -quiet build
```

### Unreleased changes from a clone

In Xcode choose **Add Local…** and select the `sdks/ios` folder of this repository. From another Swift package,
use `.package(path: "../durbun/sdks/ios")` and `.product(name: "Durbun", package: "ios")` (a local path
dependency is identified by its folder name, `ios`).
