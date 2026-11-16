# Logs, events and crashes

Structured logs, console output, events and crash reports.

## Logs

```swift
Durbun.log("Logged in", level: .info, tag: "auth", data: ["userId": 42])
Durbun.debug("Read from cache", tag: "cache")
Durbun.warning("Slow response", tag: "api", data: ["ms": 2300])
Durbun.error("Payment failed", error: error, tag: "payment")
```

`data` can be a dictionary, an array, an `Encodable` or any other value (converted to JSON on a best-effort
basis); the Mac app shows it as a JSON tree. Every call is thread-safe and a cheap no-op while the SDK is not
running.

`print`, `debugPrint`, `NSLog`, `printf` and stderr arrive tagged `stdout` / `stderr`, and Xcode's console keeps
working (every byte is also written to the original output). Multi-line output is grouped into one entry.
``DurbunOptions/captureStdout`` turns this off.

The Mac app reads `os_log` / `Logger` lines from the device logs. When it cannot (Wi-Fi), the SDK on iOS 15 and
later reads the app's own log store and sends the entries (``DurbunOptions/captureOSLog``).

## Events

```swift
Durbun.event("purchase", ["amount": 49.9, "currency": "USD"])
```

## Crashes

Uncaught Objective-C exceptions arrive at once. Swift runtime traps (force-unwrapping `nil`, index out of range,
`fatalError`), `EXC_BAD_ACCESS` and other fatal signals arrive on the next launch, with the last console lines and
a backtrace. On iOS 14 and later, MetricKit diagnostics of earlier launches (watchdog kills, main-thread hangs,
CPU and disk-write exceptions, slow launches) are sent once the Mac app is connected.
``DurbunOptions/captureCrashes`` turns all of this off.

## Performance

CPU, memory (`phys_footprint`, the number Xcode shows), thread count, FPS and janky frames are sampled while the
Mac app is connected, and the cold launch time is sent once as the `durbun.launch` event.
``DurbunOptions/collectMetrics`` turns them off.
