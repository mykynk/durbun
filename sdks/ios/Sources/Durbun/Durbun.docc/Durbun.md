# ``Durbun``

Stream an iOS app's logs, network traffic, crashes and performance to the Dürbün Mac app, live.

## Overview

Dürbün is a log, network and performance inspector that runs on your Mac. This package is its iOS SDK: once
``Durbun/start(options:)`` runs, the Mac app shows

- structured logs (``Durbun/log(_:level:tag:data:error:)``), `print` / `NSLog` / stderr output and events,
- every `URLSession` request (the shared session and your own, Alamofire included) with headers, bodies and
  timings, `URLSessionWebSocketTask` messages and Server-Sent Events,
- crashes: uncaught Objective-C exceptions at once, Swift runtime traps and fatal signals on the next launch,
  and what MetricKit reports about earlier launches,
- CPU, memory, thread count, FPS and janky frames, and the launch time,
- the page traffic and console of web views you attach with ``DurbunWebView``.

From the Mac app you can define mock rules (fake responses, latency, natural failures) and run tools inside the
app, including your own (``Durbun/registerAction(_:handler:)``).

The SDK supports iOS 13 and later. In the Simulator and on an iPhone connected over USB it needs no
configuration; over Wi-Fi it needs the Mac's address.

```swift
import Durbun

@main
struct MyApp: App {
    init() {
        #if DEBUG
        Durbun.start()
        #endif
    }
    var body: some Scene { WindowGroup { ContentView() } }
}
```

## Topics

### Essentials

- <doc:GettingStarted>
- ``Durbun``
- ``DurbunOptions``
- <doc:Options>

### What is captured

- <doc:NetworkCapture>
- <doc:WebSocketsAndEventStreams>
- <doc:LogsEventsAndCrashes>
- <doc:WebViews>
- <doc:WhatIsNotCaptured>

### Logging

- ``DurbunLogLevel``

### Tools in the Mac app

- <doc:AppTools>
- ``DurbunAction``
- ``DurbunActionError``

### Web views

- ``DurbunWebView``

### Connection

- ``DurbunConnectionStatus``

### Objective-C

- ``DurbunObjC``
