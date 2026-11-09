# Dürbün iOS SDK

Swift package `Durbun` for iOS 13+ (macOS 11+ for the tests). It streams your app's logs, `print` output,
crashes, URLSession network traffic and performance metrics live to the Dürbün desktop app.

> **Flutter app?** Do not add this package separately. The Flutter package
> [`package:durbun`](../flutter/durbun/README.md) already carries this iOS core (URLSession, crashes,
> stdout/stderr) and starts it from Dart, so no `Durbun.start()` call is needed (in a Flutter app it does
> nothing). To log from Swift code, use `import durbun`. This page is for native-only iOS apps. After changing
> the sources here, run `dart run tool/sync_native.dart` in `sdks/flutter/durbun` (the plugin carries an exact
> copy).

## What is captured

| What | How it shows up |
|---|---|
| `Durbun.log / debug / info / warning / error` | Structured log with level, tag, JSON `data`, error and call-site stack |
| `print`, `debugPrint`, `NSLog`, `printf`, stderr | Logs tagged `stdout` / `stderr`. Xcode's console **keeps working** (every byte is also written to the original output). Multi-line output (pretty JSON, `dump()`, stack traces) is grouped into one entry; levels are inferred from markers such as `[ERROR]`, `Warning:` and `❌`; NSLog's date/process prefix is stripped |
| Crashes | Uncaught Objective-C exceptions **immediately** (`kind: crash`). Swift runtime traps (force-unwrapping `nil`, index out of range, `fatalError`), EXC_BAD_ACCESS and other fatal signals **on the next launch**, with the last console lines ("Fatal error: …") and a backtrace |
| Network | `URLSession.shared` **and** your own sessions (Alamofire included): headers, bodies, redirects, timings (DNS/TCP/TLS/wait/receive), protocol (h2/h3), errors and cancellations |
| Mocks | Rules defined on the desktop: synthesized responses, latency, natural failures (timeout, connection, DNS, TLS) |
| Performance | CPU (%), memory (phys_footprint, the number Xcode shows), thread count, FPS and janky frames (CADisplayLink) |
| Events | `Durbun.event("purchase", ["amount": 49.9])` |
| App tools | From the desktop's Device panel: light/dark appearance, slow animations, view hierarchy dump, UserDefaults dump, plus your own buttons via `registerAction` |

## Installation

**Swift Package Manager:** in Xcode, choose **File → Add Package Dependencies…**, enter
`https://github.com/mykynk/durbun`, and add the **Durbun** product to your app target. In a `Package.swift`:

```swift
.package(url: "https://github.com/mykynk/durbun", from: "0.1.0"),
// in the target:
.product(name: "Durbun", package: "durbun"),
```

**CocoaPods:** the pod is not published to the CocoaPods trunk; point the Podfile at the repository tag:

```ruby
pod 'Durbun', :git => 'https://github.com/mykynk/durbun.git', :tag => 'v0.1.0'
# Optional: link it into the Debug configuration only, so Release builds contain no Dürbün code.
# In that case `import Durbun` and every call must be inside `#if DEBUG`, or the Release build does not compile.
# pod 'Durbun', :git => 'https://github.com/mykynk/durbun.git', :tag => 'v0.1.0', :configurations => ['Debug']
```

With SwiftPM the package is linked into every configuration; compiled without `DEBUG`, the SDK does nothing
by itself (see [Release safety](#release-safety)). The package ships a privacy manifest
(`PrivacyInfo.xcprivacy`, reason `CA92.1` for the UserDefaults dump).

**From a local path (developing the SDK):** in Xcode choose **Add Local…** and select the `sdks/ios` folder of
this repository. From another Swift package, use `.package(path: "../durbun/sdks/ios")` and
`.product(name: "Durbun", package: "ios")` (a local path dependency is identified by its folder name, `ios`).

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

Usage:

```swift
Durbun.log("Logged in", level: .info, tag: "auth", data: ["userId": 42])
Durbun.debug("Read from cache", tag: "cache")
Durbun.warning("Slow response", tag: "api", data: ["ms": 2300])
Durbun.error("Payment failed", error: error, tag: "payment")
Durbun.event("purchase", ["amount": 49.9, "currency": "USD"])

// Your own tool in the desktop's Device panel (runs on the main thread):
Durbun.registerAction(DurbunAction(id: "app.clearCache", label: "Clear image cache")) { _ in
    ImageCache.shared.removeAll()
    return nil
}
Durbun.registerAction(DurbunAction(id: "app.mockLogin", label: "Mock login", kind: .toggle(false))) { params in
    FeatureFlags.mockLogin = params["value"] as? Bool ?? false
    return nil
}
```

`data` can be a dictionary, an array, an `Encodable` or any other value (converted to JSON on a best-effort
basis).

## Connecting

| Setup | What to do |
|---|---|
| **Simulator** | Nothing. The SDK connects to `127.0.0.1:9751`; `SIMULATOR_UDID` lets the desktop match the right simulator. |
| **iPhone/iPad over USB** | Nothing. The SDK listens on the first free port in `127.0.0.1:9752…9755` on the device, and the desktop connects through usbmux. Only loopback is listened on, so nobody on the network can connect and no Local Network permission is needed. |
| **Wi-Fi** | Call `Durbun.start(options: .init(host: "192.168.1.20"))` or set `DURBUN_HOST=192.168.1.20` in the Xcode scheme. Add `NSLocalNetworkUsageDescription` to Info.plist (iOS asks for permission on the first connection) and start the desktop with `durbun --lan`. |

If the connection drops, the SDK retries forever with a 0.5 s to 3 s backoff. Meanwhile it keeps the last
5,000 messages in memory and sends them in order once connected (a single warning line is added if some had to
be dropped). Whichever path completes the `hello` → `welcome` handshake first is used; the others are closed.

## Options (`DurbunOptions`)

| Field | Default | Description |
|---|---|---|
| `host` | `nil` (`DURBUN_HOST`) | Desktop IP address for Wi-Fi |
| `port` | `9751` | Simulator / Wi-Fi port |
| `devicePorts` | `9752...9755` | USB listener ports on a physical device |
| `enabled` | `true` | If `false`, `start` does nothing |
| `captureStdout` | `true` | Capture `print` / stdout / stderr |
| `captureNetwork` | `true` | Capture URLSession traffic and apply mocks |
| `captureCrashes` | `true` | Exception and signal (crash) reports |
| `collectMetrics` | `true` | CPU / memory / FPS samples (only while connected) |
| `interceptUploadTasks` | `true` | Intercept upload tasks; with `false`, `didSendBodyData` progress callbacks are preserved |
| `ignoredHosts` | `[]` | Domains that are never captured (subdomains included) |
| `redactHeaders` | `[]` | Header names (case-insensitive) whose values show as `••••`, e.g. `["Authorization", "Cookie"]`; the real request is unchanged |
| `maxBufferedMessages` | `5000` | Messages kept while disconnected |
| `allowInReleaseBuilds` | `false` | Force the SDK to run in non-DEBUG builds |

## Mocks

Rules are defined on the desktop (the Mocks tab) and pushed to the SDK live. Matching is identical to
`mockRuleMatches` in the protocol package; the tests verify it with more than 2,700 cases generated from the
TypeScript reference. Mocked requests are marked `mocked` on the desktop.

| Action | What the app sees |
|---|---|
| `respond` | A synthesized response that never touches the network (status, headers, utf8/base64 body, optional delay). For a JSON body without `Content-Type`, `application/json` is added |
| `delay` | The real request, after waiting the given time |
| `fail` | `timeout` → `URLError.timedOut`, `connection` → `.cannotConnectToHost`, `dns` → `.cannotFindHost`, `tls` → `.secureConnectionFailed`, `custom` → `.unknown` (with your message) |

## Release safety

- With `Durbun.start()` inside `#if DEBUG`, release builds never start the SDK.
- The SDK itself does **nothing** when compiled without `DEBUG`, unless you force it with
  `allowInReleaseBuilds: true`. With that option it runs wherever the app was installed from (Xcode, ad-hoc,
  TestFlight, App Store). Each project decides which builds run Dürbün.
- When the connection drops, the mock rules that connection pushed are removed at once; the desktop sends them
  again when it reconnects.
- Security note: the link has no pairing yet. On a physical device, a build with Dürbün enabled listens on one
  of the ports `127.0.0.1:9752–9755` and talks to whatever connects there: the desktop (through usbmux) or
  another app on the device. Logs and network traffic go to that peer, and the mock rules it pushes apply while
  it stays connected.
- The `DURBUN_DISABLED=1` environment variable turns the SDK off completely; it is also off inside SwiftUI
  previews (Xcode Previews).
- All I/O runs on background queues with bounded buffers, and the SDK swallows its own errors and never
  crashes the app. Network requests are forwarded untouched (tee); timeouts and certificate validation
  (pinning) are still enforced by your own session.

## Known limitations

- **Background URLSessions** (`.background(withIdentifier:)`) run out of process and cannot be intercepted.
- URLProtocol cannot report **upload progress**: `didSendBodyData` is not called for intercepted upload tasks
  (use `interceptUploadTasks: false` if your UI depends on it).
- An intercepted request is performed with a copy of the configuration of the session that started it: the same
  `URLCache` (or none), cookie and credential storage, proxy, TLS limits, `waitsForConnectivity`,
  cellular / expensive / constrained network rules and connection limits. This holds for sessions created after
  `start()`; `URLSession.shared` uses the default configuration. In an app that creates more than 32 distinct
  session configurations, later ones are not captured (they behave as if Dürbün were absent).
- Stream (`httpBodyStream`) and file/data upload bodies are held in memory only up to the capture limit plus
  256 KB (at least 1.25 MB); larger ones are streamed through. A streamed body cannot be rewound: a 307/308
  redirect or an authentication retry that has to resend it fails for that request. Smaller bodies and
  `httpBody` are resent as usual.
- WKWebView and AVPlayer traffic does not go through URLSession protocols.
- The desktop reads `os_log` / `Logger` / `NSLog` messages from device logs (simulator, USB). When it cannot
  (Wi-Fi, no `idevicesyslog`), the SDK on iOS 15+ reads the app's own log store once a second and sends the
  entries; iOS does not keep `debug` entries, and `com.apple.*` lines are skipped. `captureStdout: false`
  turns this off.
- `regex` mock rules use NSRegularExpression (ICU). For typical URL patterns it behaves the same as
  JavaScript; only exotic JavaScript-specific syntax may differ.
- FPS / janky frames are iOS-only (there is no CADisplayLink on macOS).

## Development

```bash
cd sdks/ios
swift build -j 2
swift test -j 2
xcodebuild -scheme Durbun -destination 'generic/platform=iOS Simulator' -quiet build
node scripts/generate-mock-vectors.mjs   # regenerates the mock-matching test cases from the TypeScript reference
```
