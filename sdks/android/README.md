# Dürbün Android SDK

> **Flutter app?** Do not add this SDK separately. The Flutter package
> [`package:durbun`](../flutter/durbun/README.md) already carries this Android core and starts it from Dart
> (there is no `Durbun.start` call; in a Flutter app it does nothing). If your native code uses OkHttp, one line
> is enough: `.addInterceptor(DurbunInterceptor())`. This page is for native-only Android apps.

[What you get](#what-you-get) · [Install](#install) · [Start](#start) · [Connect to the Mac](#connect-to-the-mac) ·
[What is captured](#what-is-captured) · [Mocks](#mocks) · [Tools](#tools) ·
[Release builds and safety](#release-builds-and-safety) · [Options](#options) ·
[Troubleshooting](#troubleshooting) · [Development](#development)

## What you get

The Dürbün Android SDK streams your app's **logs, OkHttp traffic (headers, bodies, timings), crashes, custom
events and performance metrics** (CPU, memory, FPS, janky frames) to the Dürbün Mac app, live. From the Mac app
you can define mock rules (fake responses, latency, timeouts, DNS / TLS / connection failures) and use tools that
run code inside the app.

**No log is left behind:**

| Source | How it arrives |
|---|---|
| Device logs (logcat, all processes) | Read by the Mac app over USB or wireless adb; no SDK needed |
| `Durbun.log(...)`, Timber | Sent by the SDK as structured entries: tag, level, JSON data and full stack trace |
| The app's own logcat over Wi-Fi (no adb) | Read and forwarded by the SDK (multi-line messages are merged back) |
| Network (OkHttp) | `DurbunInterceptor`; DNS / connect / TLS times with `DurbunEventListenerFactory` |
| Crashes | Uncaught exceptions; a crash that cannot reach the Mac app is sent on the next launch |
| How earlier launches ended | ANRs, native crashes and kills by the system, on the next launch (Android 11+, see [Earlier launches](#earlier-launches-anrs-native-crashes-system-kills)) |

The Mac app renders every line legibly: level colors, tag colors, collapsible stack traces, a JSON tree, and
`→ GET /api/users 200 · 123 ms` lines inside the log stream.

## Install

The SDK is on Maven Central as `io.github.mykynk:durbun` (the real SDK) and `io.github.mykynk:durbun-noop` (the
same API with empty bodies, for release builds). `mavenCentral()` is declared by default in Android projects.

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation("io.github.mykynk:durbun:0.2.0")        // the real SDK, debug builds only
    releaseImplementation("io.github.mykynk:durbun-noop:0.2.0") // same API with empty bodies in release
    // Flutter host apps also have a "profile" build type:
    // "profileImplementation"("io.github.mykynk:durbun-noop:0.2.0")
}
```

The published AARs are compiled with Kotlin 1.9 API and metadata and depend on `kotlin-stdlib` 1.9.24, so they
work in apps on Kotlin 1.9 and newer. Upgrading: raise `durbun` and `durbun-noop` together and keep both on the
same version ([Versions and upgrades](../../docs/guides/versions.md)).

To try changes that are not released yet, see [Unreleased changes from a clone](#unreleased-changes-from-a-clone).

### Requirements

- minSdk 21 or higher.
- OkHttp is optional and your own version is used (tested with 4.x, binary compatibility with 3.14 checked; 5.x
  keeps the same API).
- No other dependencies, not even AndroidX.

## Start

In your `Application`:

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Durbun.start(this)   // nothing else needed for USB and emulators
    }
}
```

`start()` never blocks the main thread; all networking and disk work happens on Dürbün's low-priority
background threads. The SDK never crashes your app: internal errors are swallowed and every queue is bounded.

### Start without code (optional)

An app that should not carry any Dürbün call (or has no `Application` class) can let the SDK start itself right
after `Application.onCreate`, with one line inside `<application>` in its `AndroidManifest.xml`:

```xml
<meta-data android:name="dev.durbun.autoStart" android:value="true" />
```

- Without the entry, or with `"false"`, nothing starts by itself.
- It starts with the default options; over Wi-Fi the Mac's address comes from the
  [`dev.durbun.host` manifest entry](#giving-the-app-the-macs-address) or `Durbun.setDesktopHost`.
- A `Durbun.start(...)` or `Durbun.stop()` in `Application.onCreate` still decides. A later `Durbun.start` with
  options (for example from the first `Activity`) restarts the session with them; one without options keeps it.
- The entry is read on Dürbün's own thread, like `dev.durbun.host`. It is part of `durbun` only: with
  `durbun-noop`, nothing starts. It runs in the app's main process; other processes (`android:process=":sync"`)
  start Dürbün only with `Durbun.start`.

## Connect to the Mac

- **USB (cable or wireless adb):** when a device appears, the Mac app runs `adb reverse tcp:9751 …`
  automatically, and the SDK connects to `127.0.0.1:9751` on the device. There is nothing to configure. To
  check, run `adb reverse --list`.
- **Emulator:** the same, plus `10.0.2.2:9751` (the Mac itself) is tried as a fallback.
- **Wi-Fi only (no adb):** in the Mac app, turn on Settings → Connection → "Allow local network (Wi-Fi)
  connections" (when you run the server from the repository instead, start it with `node dist/durbun.mjs --lan`),
  and give the app the Mac's IP address (Dürbün → Settings lists it) in one of the
  [ways below](#giving-the-app-the-macs-address). In this mode the Mac app cannot read device logs, so the SDK
  forwards the app's **own logcat**.
- If the connection drops, the SDK reconnects indefinitely with a 0.5 s → 3 s backoff. Meanwhile the last 5 000
  messages are kept in memory and sent on reconnect (a warning line reports how many were dropped, if any).

If the app does not show up, see [Not connecting?](#not-connecting).

### Giving the app the Mac's address

The Mac's address changes with the network, so it does not have to be built into the app. From the first that
is set to the last:

| Way | Who uses it | Rebuild? |
|---|---|---|
| `Durbun.setDesktopHost(context, "192.168.1.20")` | The app's own debug menu, or a link the app opens | No |
| Launch extra `durbun.host` (debuggable builds only) | `adb shell am start -n <app id>/<activity> --es durbun.host 192.168.1.20`, Android Studio's run configuration (Launch Flags), test runners that pass launch arguments | No |
| `DurbunOptions(host = "192.168.1.20")` | Code, for example `BuildConfig.DURBUN_HOST` | Yes |
| `<meta-data android:name="dev.durbun.host" android:value="${durbunHost}"/>` in the app's manifest | CI or a Gradle property through `manifestPlaceholders` | Yes |

- For the manifest entry, fill the placeholder in `app/build.gradle.kts`, for example
  `defaultConfig { manifestPlaceholders["durbunHost"] = providers.gradleProperty("durbunHost").getOrElse("") }`
  and build with `-PdurbunHost=192.168.1.20`; an empty value is ignored.
- The first two are **kept for the next launches** (in the app's no-backup files), so a tester sets the address
  once and then opens the app from the launcher as usual. `Durbun.setDesktopHost(context, null)` (or an empty
  `durbun.host` extra) goes back to the address built into the app.
- A new address is tried at once; a connection through the old Wi-Fi address is closed, a USB connection stays.
- `host:port` is accepted (`192.168.1.20:9751`); `setDesktopHost` returns `false` for anything that is not a host
  name or IP address. The launch extra is ignored when the activity was opened from a browser or a deep link.
- The launch extra is read in debuggable builds only, because another app on the phone can start the activity
  with extras. Tester builds without the debuggable flag (for example a `staging` build with `forceInRelease`)
  take the address from `Durbun.setDesktopHost` (a debug menu) or the manifest entry; there, the SDK logs one
  line when it ignores the extra.
- In the app's debug menu, a text field and two lines are enough:

  ```kotlin
  saveButton.setOnClickListener {
      if (!Durbun.setDesktopHost(context, addressField.text.toString())) addressField.error = "Not an IP address"
  }
  statusText.text = Durbun.connectionStatus.toString()
  ```

  An app that already handles links can pass a value on, for example
  `Durbun.setDesktopHost(context, uri.getQueryParameter("durbunHost"))` for `myapp://debug?durbunHost=192.168.1.20`.

## What is captured

### Network

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())                    // hand the same client to Retrofit
    .eventListenerFactory(DurbunEventListenerFactory())     // optional: DNS, connect, TLS, send and wait times
    .build()
```

- Without the listener factory, a call shows `connect` (everything before the request was sent), `wait` and
  `receive`. With it, the same phases as on iOS: `dns`, `connect`, `tls`, `send`, `wait`, `receive` of the last
  attempt (after a redirect or retry, its own phases; a reused connection has no DNS, connect or TLS time).
- OkHttp takes one listener factory per client. If the app has its own, pass it in:
  `DurbunEventListenerFactory(myFactory)` (or `DurbunEventListenerFactory(myListener)` for `eventListener(...)`).
  Your listener still gets every callback first, in the same order, on the same threads. Callbacks newer than
  OkHttp 4.12 are not passed on to it. In `durbun-noop` the factory returns your own listener untouched.
- Add it as the **last** application interceptor to see headers your own interceptors add (for example
  `Authorization`).
- Use `addNetworkInterceptor(DurbunInterceptor())` to see every redirect and retry separately (gzip and deflate
  bodies are decoded automatically, and the remote IP address is shown). OkHttp does not let network
  interceptors short-circuit a request, so `respond` mocks are skipped there (delay and failure mocks still
  work); the Mac app gets one warning line per skipped rule, with the call's id.
- Bodies are captured without touching the app's streams. A request body is copied while OkHttp writes it to
  the server (no body is ever written twice, so `InputStream` and file streams, progress-reporting bodies and
  one-shot bodies are safe). A response body is copied as the app reads it: Dürbün never reads ahead, and
  `execute()` returns as soon as the headers arrive.
- Reporting order: the request is reported first with its size, then again (same id) with its body once
  written. The response is reported at the end of the body, when the capture limit is reached, or when the app
  closes the body. A body closed unread shows its size only; a response that is never closed (leaked) stays
  pending in the Mac app. SSE (`text/event-stream`), NDJSON, WebSocket, gRPC and audio/video streams are
  reported with their size only.
- To observe bodies, the interceptor hands request bodies (except `FormBody`) and captured response bodies
  down the chain in a thin wrapper (content type, length, and one-shot / duplex flags are forwarded). If your
  own interceptors check body classes (for example `body is MultipartBody`), add `DurbunInterceptor` after
  them.
- Mask secrets for every client at once with `DurbunOptions(redactHeaders = setOf("Authorization", "Cookie"))`,
  or per client with `DurbunInterceptor(redactHeaders = setOf(...))`; values show as `••••` and the real request
  is unchanged. `DurbunOptions(ignoredHosts = listOf("analytics.example.com"))` leaves hosts (and their
  subdomains) out: their calls pass the interceptor untouched and mock rules do not apply to them.

**Not captured:** only `OkHttpClient`s that have `DurbunInterceptor` are seen, and every client needs it.
Add it to the clients that Retrofit, Coil, Glide's OkHttp integration (`okhttp3-integration`) and Ktor's
OkHttp engine build for themselves. Traffic over `HttpURLConnection` is not seen: Volley (`HurlStack`),
ExoPlayer / Media3 `DefaultHttpDataSource`, Glide's default loader, Ktor's CIO and Android engines, Cronet,
WebView and native (C/C++) code. When OkHttp is in the app but no `DurbunInterceptor` was created 30 seconds
after start, the Mac app shows one line saying so, so an empty network list has a reason.

### Logs and events

```kotlin
Durbun.i("auth", "User logged in", data = mapOf("userId" to 42, "plan" to "premium"))
Durbun.w("sync", "Sync is slow", data = mapOf("ms" to 2300))
Durbun.e("payment", "Payment failed", throwable = e)
Durbun.log(Level.DEBUG, "cache", "Cache cleared")
Durbun.event("purchase", mapOf("amount" to 49.9, "currency" to "USD"))
```

`data` can be a Map, List, number, enum, `JSONObject`, or a Gson / kotlinx.serialization JSON object; the
Mac app shows it as a collapsible JSON tree.

Over USB the Mac app reads device logs (logcat) itself. Over Wi-Fi it cannot, so the SDK forwards the app's own
logcat (`captureLogcat`).

#### Timber

```kotlin
class DurbunTree : Timber.Tree() {
    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        Durbun.log(Level.fromPriority(priority), tag ?: "app", message, throwable = t)
    }
}

// In Application.onCreate
Timber.plant(Timber.DebugTree(), DurbunTree())
```

Timber appends the stack trace to the message as well; the SDK removes that copy so the Mac app shows the
message once and the (folded) stack trace once. `DebugTree` also writes the same line to logcat: over Wi-Fi
the SDK removes that duplicate, and over USB the Mac app de-duplicates identical lines.

### Crashes

Uncaught exceptions are reported by the SDK's crash handler (the previous handler always runs). A crash that
cannot reach the Mac app is sent on the next launch. `captureCrashes = false` turns this off.

#### Earlier launches: ANRs, native crashes, system kills

Some endings leave the app no chance to report: an ANR, a crash in native (C/C++) code, or Android ending the
process to free memory. On Android 11 (API 30) and newer, the SDK reads how earlier launches ended
(`ApplicationExitInfo`) on its own background thread at start and sends them once the Mac app is connected:

| Ending | Line in the Mac app |
|---|---|
| ANR | Crash row "Previous launch ended: App Not Responding (ANR)" with the main thread's stack and the threads holding the locks it waited for |
| Native crash | Crash row with the signal (`SIGSEGV`, `SIGABRT` …) |
| Low memory kill | Info line (a warning when the app was in the foreground) with its memory use |
| Too many resources, killed by a signal, start-up failure, a revoked permission | One line each |

- Exits the app or the person caused (the app called `exit`, swiped away, force stop, an update) are not
  reported; uncaught Java/Kotlin exceptions come from the crash handler as before.
- Each exit is reported once. On the first launch with Dürbün, only the last 24 hours are read. When the Mac app
  does not connect during a launch, the next launch tries again.
- Over USB the Mac app already reads ANRs and native crashes from the device, so the SDK leaves those two out and
  sends only the others.
- `captureCrashes = false` turns this off too. Out of reach: anything before Android 11, an ANR that the person
  waited out (the app kept running), and the native backtrace itself (it stays in the device's tombstone, which
  the Mac app reads over USB).

### Performance

CPU, PSS memory, Java heap, thread count, FPS and janky frames. `captureMetrics = false` turns them off.

## Mocks

Mock rules are defined in the Mac app's Mocks tab ([how to write them](../../docs/guides/mocks.md)) and apply
to every `OkHttpClient` that has `DurbunInterceptor`:

| Action | What the app sees |
|---|---|
| `respond` | A synthesized response that never touches the network (the request body is then written once, to a side buffer) |
| `delay` | The real call, after waiting the given time |
| `fail` | The platform's real exception: `timeout` → `SocketTimeoutException`, `connection` → `ConnectException`, `dns` → `UnknownHostException`, `tls` → `SSLHandshakeException`; a custom message gives an `IOException` |

- With `addNetworkInterceptor`, `respond` rules are skipped (see [Network](#network)); delay and failure rules
  still work.
- Hosts in `ignoredHosts` are never mocked.
- When the connection drops, the mock rules that connection pushed are removed at once; the Mac app sends them
  again when it reconnects.

## Tools

Your own tools appear in the Mac app's Device tab, under App tools:

```kotlin
Durbun.addAction(DurbunAction.button("app.logout", "Log out") { session.logout() })
Durbun.addAction(DurbunAction.toggle("app.staging", "Staging API", initial = false) { useStaging = it })
Durbun.addAction(
    DurbunAction.select(
        "app.locale", "Language",
        listOf(DurbunAction.Option("en", "English"), DurbunAction.Option("de", "Deutsch")),
        initial = "en",
    ) { locale -> changeLocale(locale) },
)
```

Handlers run on the main thread. Built in:

| Tool | What it does |
|---|---|
| Dump threads | Every thread's stack, written as a log entry |
| Run garbage collection | Java heap before and after |
| Appearance | System / Light / Dark for this app (Android 12+; Android keeps the choice for the app until it is set back to System) |
| Dump view hierarchy | The view tree of the visible activities (class, frame, visibility, id, text), at most 5,000 views; dialogs and popups are separate windows and not included |
| Dump SharedPreferences | Every preferences file of the app with its keys and values (read off the main thread) |

## Release builds and safety

### Which builds run Dürbün

- A build with `durbun-noop` contains no Dürbün code, threads or sockets.
- In a non-debuggable build with `durbun`, `Durbun.start()` does nothing; with `forceInRelease = true` it runs,
  wherever the app was installed from (Firebase, Google Play, other stores, adb). Each project decides which
  builds run Dürbün.

### Test builds (staging, QA, Firebase App Distribution)

Testers often install a non-debuggable build, for example a `staging` build type shared through Firebase App
Distribution. To run Dürbün in such a build, give it the real SDK and turn `forceInRelease` on for it:

`app/build.gradle.kts`:

```kotlin
android {
    buildFeatures { buildConfig = true }
    defaultConfig { buildConfigField("boolean", "DURBUN", "false") }
    buildTypes {
        getByName("debug") { buildConfigField("boolean", "DURBUN", "true") }
        create("staging") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            buildConfigField("boolean", "DURBUN", "true")
        }
    }
}

dependencies {
    // debugImplementation and releaseImplementation as in "Install", plus the real SDK for
    // staging, with the same version:
    "stagingImplementation"("io.github.mykynk:durbun:<version>")
}
```

`Application.onCreate`:

```kotlin
Durbun.start(this, DurbunOptions(forceInRelease = BuildConfig.DURBUN))
```

- `durbun-noop` has the same API, so this line compiles in every build type; in `release` it does nothing.
- With product flavors instead of a build type, use variant configurations so that each variant gets exactly
  one of the two artifacts, for example `"qaReleaseImplementation"` for `durbun` and
  `"prodReleaseImplementation"` for `durbun-noop`, and set `DURBUN` per flavor.
- The `durbun` module adds the `INTERNET` permission to the builds it is part of. No R8 rules and no cleartext
  settings are needed.
- Without `forceInRelease`, a non-debuggable build with `durbun` stays off and logs
  `Dürbün is off: this build is not debuggable (set forceInRelease = true to override).` under the `Durbun`
  tag.
- A build with Dürbün on behaves as described in [Connect to the Mac](#connect-to-the-mac), wherever it is
  installed from: over USB the phone needs USB debugging, over Wi-Fi the app needs the Mac's address
  ([without a rebuild](#giving-the-app-the-macs-address) too).

The [test builds guide](../../docs/guides/qa-builds.md) covers Flutter, iOS and React Native as well.

### Safety and security

- The `durbun` module's manifest adds the `INTERNET` permission and a small start-up provider
  (`exported="false"`; it starts nothing unless `dev.durbun.autoStart` is `true`); with `debugImplementation`
  both are merged into debug builds only.
- Dürbün uses a **plain TCP socket, not HTTP**: no `usesCleartextTraffic` or network security config changes
  are needed.
- No R8/ProGuard rules are needed. For apps without OkHttp, the modules ship `-dontwarn` lines for exactly the
  OkHttp and Okio classes the SDK references (missing OkHttp classes that your own code needs are still
  reported by R8).
- When the connection drops, the mock rules that connection pushed are removed at once; the Mac app sends them
  again when it reconnects.
- Security note: the connection has no pairing yet. A build with Dürbün enabled connects to `127.0.0.1:9751` on
  the device and talks to whatever answers there: the Mac app (through adb reverse) or another app listening on
  that port. Logs and network traffic go to that peer, and the mock rules it pushes apply while it stays
  connected. See [Security](../../README.md#security).

## Options

`DurbunOptions`:

| Option | Default | Description |
|---|---|---|
| `host` | `null` | The Mac's IP address for Wi-Fi (not needed over USB or on an emulator; see [Giving the app the Mac's address](#giving-the-app-the-macs-address)) |
| `port` | `9751` | The Mac app's SDK port |
| `enabled` | `true` | `false` makes every call a no-op |
| `forceInRelease` | `false` | Also run in non-debuggable builds |
| `captureBodies` | `null` | Overrides the Mac app's setting (`false` records sizes only) |
| `maxBodyBytes` | `null` | Capture limit per body, at most 8 MB (the Mac app's default is 1 MB) |
| `maxBufferedMessages` | `5000` | Messages kept in memory while disconnected |
| `captureCrashes` | `true` | Report uncaught exceptions (the previous handler always runs) and how earlier launches ended |
| `captureMetrics` | `true` | CPU, PSS memory, Java heap, thread count, FPS, janky frames |
| `captureLogcat` | `true` | Forward the app's own logcat when the Mac app cannot read device logs |
| `appName` | `null` | Name shown in the Mac app (default: the app label) |
| `captureNetwork` | `true` | OkHttp capture and mocks through `DurbunInterceptor` (`false` makes the interceptor a pass-through: no capture, no mocks) |
| `redactHeaders` | `emptySet()` | Header names (case-insensitive) masked as `••••` in every client's captured calls; the real request is unchanged |
| `ignoredHosts` | `emptyList()` | Hosts never captured (subdomains included); mock rules do not apply to them |

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

About 10 seconds after start, when the Mac app has not connected yet, the SDK writes **one** warning under the
`Durbun` logcat tag: what it tried, the likely reason and the next step. The same is available in code:

```kotlin
val status = Durbun.connectionStatus      // isConnected, via, desktopHost, issue, hint, failedAttempts
Durbun.addConnectionListener { status -> Log.i("App", status.toString()) }   // on a background thread
```

| `issue` | Likely reason | Next step |
|---|---|---|
| `usbNotSetUp` | No `adb reverse` on the cable | Connect with USB debugging on and open the Dürbün Mac app, or set a Wi-Fi address |
| `usbDesktopClosed` | `adb reverse` is there, nothing answers on the Mac | Open the Dürbün Mac app |
| `desktopNotRunning` | Emulator: nothing listens on the Mac's port | Open the Dürbün Mac app (or check its SDK port) |
| `lanRefused` | The Mac does not accept Wi-Fi connections | Settings → Connection → "Allow local network (Wi-Fi) connections" |
| `lanTimeout` | No answer from the address | Check the address, the Wi-Fi network and the Mac's firewall |
| `lanUnreachable` | The phone is on another network | Join the Mac's Wi-Fi |
| `lanBadAddress` | The address cannot be resolved | Use the Mac's IP address |
| `permissionDenied` | No `INTERNET` permission, a firewall or data saver app | Add the permission / allow the app |
| `notDurbun` | Another program answered on the port | Check the port and the Dürbün version |

The other Dürbün SDKs use the same table and words.

### More help

More symptoms and fixes, for every platform: [Troubleshooting](../../docs/guides/troubleshooting.md). Which SDK
version works with which Mac app: [Versions and upgrades](../../docs/guides/versions.md).

## Development

```bash
cd sdks/android
./gradlew :durbun:testDebugUnitTest :durbun:assembleDebug :durbun-noop:assembleRelease
```

End-to-end test against a running Dürbün Mac app. Its SDK port is 9751 and its HTTP port defaults to the SDK
port minus 1 (override with `DURBUN_E2E_HTTP_PORT`). The test is skipped unless `DURBUN_E2E_PORT` is set:

```bash
DURBUN_E2E_PORT=9751 ./gradlew :durbun:testDebugUnitTest --tests '*E2E*'
```

The mock-matching test uses `durbun/src/test/resources/mock-parity.json`, generated from the protocol's
reference `mockRuleMatches` function. To regenerate it, run this from the repository root:
`node --import tsx sdks/android/tools/gen-mock-parity.mjs`.

After a build, run `python3 -I tools/check-binary-compat.py`. It checks `durbun` / `durbun-noop` API parity,
binary compatibility with OkHttp 3.14 + Okio 1.x, and that the consumer R8 rules cover every referenced
OkHttp/Okio class.

### Unreleased changes from a clone

To try changes that are not released yet, build the SDK from a clone of the Dürbün repository with one of the
two options below.

**Option A: from a local path.** Include the modules from a clone of the Dürbün repository.
`settings.gradle.kts` (adjust the path to where the repository is cloned):

```kotlin
include(":durbun", ":durbun-noop")
project(":durbun").projectDir = file("../durbun/sdks/android/durbun")
project(":durbun-noop").projectDir = file("../durbun/sdks/android/durbun-noop")
```

Groovy (`settings.gradle`):

```groovy
include ':durbun', ':durbun-noop'
project(':durbun').projectDir = new File(rootDir, '../durbun/sdks/android/durbun')
project(':durbun-noop').projectDir = new File(rootDir, '../durbun/sdks/android/durbun-noop')
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation(project(":durbun"))        // the real SDK, debug builds only
    releaseImplementation(project(":durbun-noop")) // same API with empty bodies in release
    // Flutter host apps also have a "profile" build type:
    // "profileImplementation"(project(":durbun-noop"))
}
```

Included from a local path, the modules apply `com.android.library` and `org.jetbrains.kotlin.android`
**without versions**, so your root build must declare the Android Gradle Plugin and the Kotlin plugin (standard
in Android Studio projects).

**Option B: from your local Maven repository.** Publish the artifacts from your clone:

```bash
cd sdks/android
./gradlew publishToMavenLocal   # into ~/.m2
```

Then add `mavenLocal()` to your repositories (before `mavenCentral()`) and use the same coordinates as in
[Install](#install).

### Publishing

The version lives in one place: `Durbun.VERSION` in `durbun/src/main/kotlin/dev/durbun/Durbun.kt`.

```bash
./gradlew publishToMavenLocal                         # into ~/.m2
./gradlew publishReleasePublicationToStagingRepository # into build/staging-deploy
```

Zip `build/staging-deploy` and upload it to the Maven Central Portal. Artifacts are signed only when a key is
configured: the `signingInMemoryKey` Gradle property (plus `signingInMemoryKeyPassword` and, optionally,
`signingInMemoryKeyId`), the same names as `ORG_GRADLE_PROJECT_*` environment variables, or the classic
`signing.keyId` settings.
