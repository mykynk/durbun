# Getting started

Add the package, start the SDK, and open the Dürbün Mac app.

## Add the package

In Xcode, choose **File → Add Package Dependencies…**, enter `https://github.com/mykynk/durbun` and add the
**Durbun** product to your app target. In a `Package.swift`:

```swift
.package(url: "https://github.com/mykynk/durbun", from: "0.2.0"),
// in the target:
.product(name: "Durbun", package: "durbun"),
```

CocoaPods works too: `pod 'Durbun'`. The pod can be linked into the Debug configuration only
(`:configurations => ['Debug']`); then `import Durbun` and every call must be inside `#if DEBUG`.

## Start the SDK

Call ``Durbun/start(options:)`` as early as possible: sessions created after it are captured.

```swift
import Durbun

@main
struct MyApp: App {
    init() {
        #if DEBUG
        Durbun.start()                                        // Simulator and USB: nothing to configure
        // Durbun.start(options: .init(host: "192.168.1.20"))  // Wi-Fi
        #endif
    }
    var body: some Scene { WindowGroup { ContentView() } }
}
```

In a UIKit app the same lines go in `application(_:didFinishLaunchingWithOptions:)`.

``Durbun/start(options:)`` never blocks the calling thread on I/O. All work runs on background queues with
bounded buffers, and the SDK swallows its own errors.

## Connect to the Mac

| Setup | What to do |
|---|---|
| iPhone or iPad over USB | Nothing. The SDK listens on the first free port in `127.0.0.1:9752…9755` on the device and the Mac app connects through usbmux. |
| Simulator | Nothing. The SDK connects to `127.0.0.1:9751`. |
| Wi-Fi | Give the app the Mac's IP address, add `NSLocalNetworkUsageDescription` to Info.plist, and in the Mac app turn on Settings → Connection → "Allow local network (Wi-Fi) connections". |

The Mac's address can be set without a rebuild with ``Durbun/setDesktopHost(_:)`` (for example from the app's
own debug menu) or the launch argument `-DurbunHost 192.168.1.20`; both are kept for the next launches. In code,
``DurbunOptions/host`` sets it at build time.

If the connection drops, the SDK retries with a 0.5 s to 3 s backoff and keeps the last 5,000 messages in memory
meanwhile. ``Durbun/connectionStatus`` says why the app is not connected and what to do next, and
``Durbun/connectionStatusDidChangeNotification`` is posted when it changes.

## Which builds run Dürbün

- With ``Durbun/start(options:)`` inside `#if DEBUG`, release builds never start the SDK.
- Without `#if DEBUG`, the SDK runs in development builds only: the package was compiled with `DEBUG`, or the
  app runs in the Simulator, under a debugger, or is signed for development.
- The `DurbunEnabled` Info.plist key decides per build configuration instead (`YES` runs it, `NO` keeps it off),
  and ``DurbunOptions/allowInReleaseBuilds`` runs it in every build. Each project decides which builds run
  Dürbün.

## Try the example app

`sdks/ios/Example` in the repository is a small SwiftUI app that shows every part of the SDK on one screen,
against a demo server inside the app. Open `DurbunExample.xcodeproj` and run it in a Simulator with the Mac app
open.
